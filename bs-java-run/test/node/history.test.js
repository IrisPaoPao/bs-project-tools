import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import {
  createHistoryStore,
  historyFeedbackSchema,
  parseHistoryFeedback,
} from '../../src/lib/history.js';

const HISTORY_URL = new URL('../../src/lib/history.js', import.meta.url).href;
const DAY_MS = 24 * 60 * 60 * 1000;

function makeWorkspace(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-java-run-history-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function recordPath(store, runId) {
  return path.join(store.directory, `run-${runId}.json`);
}

function filesIn(store) {
  return fs.readdirSync(store.directory).filter(name => name.startsWith('run-') || name.startsWith('.active-'));
}

function directoryBytes(store) {
  return fs.readdirSync(store.directory).reduce((size, name) => size + fs.statSync(path.join(store.directory, name)).size, 0);
}

function runChild(source) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const closed = once(child, 'close').then(([code, signal]) => ({ code, signal, stdout, stderr }));
  return { child, closed };
}

function workerSource(workspaceDir, count, maxBytes = 20 * 1024 * 1024) {
  return `
    import { createHistoryStore } from ${JSON.stringify(HISTORY_URL)};
    const store = createHistoryStore({ workspaceDir: ${JSON.stringify(workspaceDir)}, maxBytes: ${maxBytes} });
    let failedWrites = 0;
    for (let index = 0; index < ${count}; index += 1) {
      const run = store.beginRun({ command: 'build', serviceNames: ['worker-' + index], envAlias: 'test', toolVersion: '2.0.0' });
      if (!run.finish({ outcome: 'success' })) failedWrites += 1;
    }
    process.stdout.write(JSON.stringify({ failedWrites }));
  `;
}

test('begin 先持久化 incomplete，阶段记录耗时，成功结束后可按 runId 查询', t => {
  const workspaceDir = makeWorkspace(t);
  let time = Date.UTC(2026, 8, 28, 1, 0, 0);
  const store = createHistoryStore({ workspaceDir, now: () => time });
  const run = store.beginRun({
    command: 'build',
    serviceNames: ['billing'],
    envAlias: 'dev',
    toolVersion: '2.0.0',
    commandLine: 'mvn -Dtoken=should-not-save',
  });

  const started = JSON.parse(fs.readFileSync(recordPath(store, run.runId), 'utf8'));
  assert.equal(started.outcome, 'incomplete');
  assert.equal(started.endedAt, null);
  assert.equal(started.commandLine, undefined);

  run.setPhase('building', { serviceName: 'billing' });
  time += 1250;
  run.setPhase('building', { serviceName: 'billing', outcome: 'success' });
  time += 250;
  assert.equal(run.finish({ outcome: 'success' }), true);

  const result = store.list({ runId: run.runId });
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].outcome, 'success');
  assert.equal(result.records[0].stages[0].durationMs, 1250);
  assert.equal(result.records[0].stages[0].outcome, 'success');
});

test('失败时保留明确分类；显式 deferred init 不提前创建目录且保留 startedAt', t => {
  const workspaceDir = makeWorkspace(t);
  let time = Date.UTC(2026, 8, 28, 2, 0, 0);
  const store = createHistoryStore({ workspaceDir, now: () => time });
  const run = store.beginRun({ command: 'workspace-init', toolVersion: '2.0.0' }, { deferPersistence: true });
  const startedAt = run.record.startedAt;
  assert.equal(fs.existsSync(path.join(workspaceDir, '.bs-java-run')), false);

  run.setPhase('validating', { serviceName: 'billing' });
  time += 400;
  assert.equal(run.activate(), true);
  const incomplete = JSON.parse(fs.readFileSync(recordPath(store, run.runId), 'utf8'));
  assert.equal(incomplete.startedAt, startedAt);
  assert.equal(incomplete.outcome, 'incomplete');

  time += 100;
  run.setPhase('starting', { serviceName: 'billing', outcome: 'failed', errorCategory: 'bean-missing' });
  assert.equal(run.finish({ outcome: 'failed' }), true);
  const failure = store.list({ runId: run.runId, failed: true }).records[0];
  assert.equal(failure.errorCategory, 'bean-missing');
  assert.equal(failure.stages.at(-1).errorCategory, 'bean-missing');
});

test('未结束进程被强制中断后留下 incomplete，轮转会回收失效 PID marker', async t => {
  const workspaceDir = makeWorkspace(t);
  const source = `
    import { createHistoryStore } from ${JSON.stringify(HISTORY_URL)};
    const store = createHistoryStore({ workspaceDir: ${JSON.stringify(workspaceDir)} });
    const run = store.beginRun({ command: 'start', serviceNames: ['billing'] });
    run.setPhase('starting', { serviceName: 'billing' });
    process.stdout.write(run.runId + '\\n');
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
  const runId = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('child did not report runId')), 5000);
    child.stdout.on('data', () => {
      const line = output.split(/\r?\n/)[0];
      if (line) {
        clearTimeout(timeout);
        resolve(line);
      }
    });
    child.once('error', reject);
  });
  assert.match(runId, /^[0-9a-f-]{36}$/i);
  const exit = once(child, 'close');
  child.kill('SIGKILL');
  await exit;

  const store = createHistoryStore({ workspaceDir, maxBytes: 4096 });
  const interrupted = store.list({ runId }).records[0];
  assert.equal(interrupted.outcome, 'incomplete');
  assert.equal(interrupted.endedAt, null);
  assert.equal(fs.existsSync(path.join(store.directory, `.active-${runId}`)), true);

  const trigger = store.beginRun({ command: 'build', serviceNames: ['other'] });
  assert.equal(fs.existsSync(path.join(store.directory, `.active-${runId}`)), false);
  trigger.finish({ outcome: 'success' });
});

test('run 与阶段仅保存 allowlist 字段，日志路径相对化且凭据和实例标识不落入记录', t => {
  const workspaceDir = makeWorkspace(t);
  let time = Date.UTC(2026, 8, 28, 3, 0, 0);
  const store = createHistoryStore({ workspaceDir, now: () => time });
  const run = store.beginRun({
    command: 'login',
    serviceNames: ['billing', 'token=raw-secret'],
    envAlias: 'dev',
    toolVersion: '2.0.0',
    password: 'must-not-save',
    rawRequest: 'secret request',
  });
  run.setPhase('login-form', {
    serviceName: 'billing',
    logPath: path.join(workspaceDir, '.bs-java-run', 'logs', 'login.log'),
    logOffset: 1234,
    errorMessage: 'raw-secret-error',
    pid: 12345,
    uuid: 'private-uuid',
  });
  time += 10;
  run.recordStartedInstance({ serviceName: 'billing', pid: 456, uuid: 'another-private-uuid' });
  run.finish({ outcome: 'failed', errorCategory: 'token-missing', token: 'do-not-save' });

  const fileText = fs.readFileSync(recordPath(store, run.runId), 'utf8');
  const record = JSON.parse(fileText);
  assert.deepEqual(Object.keys(record).sort(), [
    'command', 'endedAt', 'envAlias', 'errorCategory', 'feedback', 'outcome', 'runId',
    'schemaVersion', 'serviceNames', 'stages', 'startedAt', 'toolVersion', 'updatedAt',
  ].sort());
  assert.equal(record.serviceNames.includes('token=raw-secret'), false);
  assert.equal(record.stages[0].logLocation, '.bs-java-run/logs/login.log');
  assert.equal(record.stages[0].logOffset, 1234);
  assert.equal(record.stages[0].errorMessage, undefined);
  for (const secret of ['must-not-save', 'secret request', 'raw-secret-error', 'private-uuid', 'another-private-uuid']) {
    assert.equal(fileText.includes(secret), false);
  }

  const outside = store.beginRun({ command: 'start' });
  outside.setPhase('starting', { logPath: path.join(os.tmpdir(), 'outside.log') });
  outside.finish({ outcome: 'success' });
  assert.equal(store.list({ runId: outside.runId }).records[0].stages[0].logLocation, null);
});

test('feedback 固定结构、限长并遮盖 JSON 凭据、URL 账号和中文凭据标签', t => {
  const workspaceDir = makeWorkspace(t);
  const store = createHistoryStore({ workspaceDir });
  const run = store.beginRun({ command: 'login' });
  run.finish({ outcome: 'failed', errorCategory: 'authentication' });
  const rawFeedback = JSON.stringify({
    phenomenon: '登录失败，"password":"json-pass"，地址 https://alice:url-pass@host/path?token=query-pass',
    steps: ['用户名=zhang; Authorization: Bearer abc.def.ghi', '从日志复制认证：session-pass'],
    verification: '密码：plain-pass，访问令牌为 access-pass',
    confidence: 'suspected',
  });
  const parsed = parseHistoryFeedback(rawFeedback);
  const saved = store.addFeedback(run.runId, rawFeedback);
  assert.equal(saved.saved, true);
  assert.equal(parsed.confidence, 'suspected');
  const recordText = fs.readFileSync(recordPath(store, run.runId), 'utf8');
  for (const secret of ['json-pass', 'url-pass', 'query-pass', 'zhang', 'abc.def.ghi', 'session-pass', 'plain-pass', 'access-pass']) {
    assert.equal(recordText.includes(secret), false, `feedback should redact ${secret}`);
  }
  assert.deepEqual(historyFeedbackSchema.requiredFields, ['phenomenon', 'steps', 'verification', 'confidence']);
  assert.throws(() => parseHistoryFeedback({ phenomenon: 'x', steps: ['y'], verification: 'z', confidence: 'confirmed', token: 'extra' }), /只允许/);
  assert.throws(() => parseHistoryFeedback('x'.repeat(64 * 1024 + 1)), /64 KiB/);
  assert.throws(() => parseHistoryFeedback({ phenomenon: 'x', steps: [], verification: 'z', confidence: 'confirmed' }), /1 到 20/);
});

test('历史目录与记录文件权限分别为 0700 和 0600', t => {
  const workspaceDir = makeWorkspace(t);
  const store = createHistoryStore({ workspaceDir });
  const run = store.beginRun({ command: 'stop' });
  run.finish({ outcome: 'success' });
  const historyMode = fs.statSync(store.directory).mode & 0o777;
  const fileMode = fs.statSync(recordPath(store, run.runId)).mode & 0o777;
  assert.equal(historyMode, 0o700);
  assert.equal(fileMode, 0o600);
});

test('多进程并发写入保留每条完整记录', async t => {
  const workspaceDir = makeWorkspace(t);
  const children = Array.from({ length: 4 }, () => runChild(workerSource(workspaceDir, 6)));
  const results = await Promise.all(children.map(item => item.closed));
  for (const result of results) {
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), { failedWrites: 0 });
  }
  const result = createHistoryStore({ workspaceDir }).list({ limit: 100 });
  assert.equal(result.records.length, 24);
  assert.equal(result.records.every(record => record.outcome === 'success'), true);
  assert.equal(new Set(result.records.map(record => record.runId)).size, 24);
});

test('容量轮转保护仍活动的 run，容量不足不遗留新 active marker', async t => {
  const workspaceDir = makeWorkspace(t);
  const maxBytes = 2600;
  const store = createHistoryStore({ workspaceDir, maxBytes });
  const active = store.beginRun({ command: 'smoke', serviceNames: ['long-running'] });
  active.setPhase('starting', { serviceName: 'long-running' });

  const child = runChild(workerSource(workspaceDir, 24, maxBytes));
  const childResult = await child.closed;
  assert.equal(childResult.code, 0, childResult.stderr);
  assert.equal(JSON.parse(fs.readFileSync(recordPath(store, active.runId), 'utf8')).outcome, 'incomplete');
  assert.ok(directoryBytes(store) <= maxBytes);

  active.finish({ outcome: 'success' });
  assert.ok(directoryBytes(store) <= maxBytes);

  const tooSmallWorkspace = makeWorkspace(t);
  const constrained = createHistoryStore({ workspaceDir: tooSmallWorkspace, maxBytes: 256 });
  for (let index = 0; index < 3; index += 1) {
    const run = constrained.beginRun({ command: 'build' });
    run.finish({ outcome: 'success' });
  }
  assert.equal(filesIn(constrained).some(name => name.startsWith('.active-')), false);
  assert.ok(directoryBytes(constrained) <= 256);
  assert.match(constrained.list().storageWarning, /写入失败|容量/);
});

test('30 天轮转清理过期完成记录，且无效 workspace 不会被历史创建', t => {
  const workspaceDir = makeWorkspace(t);
  let time = Date.UTC(2026, 7, 1);
  const store = createHistoryStore({ workspaceDir, now: () => time, retentionDays: 30 });
  const old = store.beginRun({ command: 'build' });
  old.finish({ outcome: 'success' });
  const oldFile = recordPath(store, old.runId);
  assert.equal(fs.existsSync(oldFile), true);

  time += 31 * DAY_MS;
  const recent = store.beginRun({ command: 'build' });
  assert.equal(fs.existsSync(oldFile), false);
  recent.finish({ outcome: 'success' });

  const missingWorkspace = path.join(workspaceDir, 'not-created');
  const deferred = createHistoryStore({ workspaceDir: missingWorkspace });
  const failedInit = deferred.beginRun({ command: 'workspace-init' }, { deferPersistence: true });
  assert.equal(failedInit.finish({ outcome: 'failed', errorCategory: 'configuration', persistDeferred: true }), false);
  assert.equal(fs.existsSync(missingWorkspace), false);
  assert.equal(deferred.list({ runId: failedInit.runId }).records[0].outcome, 'failed');
  assert.match(deferred.list({ runId: failedInit.runId }).storageWarning, /不完整|不可用/);
});

test('写入故障不抛错、不改业务返回值，也不向 stdout/stderr 输出', async t => {
  const workspaceDir = makeWorkspace(t);
  fs.mkdirSync(path.join(workspaceDir, '.bs-java-run'), { mode: 0o700 });
  fs.writeFileSync(path.join(workspaceDir, '.bs-java-run', 'history'), 'blocks-directory');
  const source = `
    import { createHistoryStore } from ${JSON.stringify(HISTORY_URL)};
    const store = createHistoryStore({ workspaceDir: ${JSON.stringify(workspaceDir)} });
    const run = store.beginRun({ command: 'build' });
    run.setPhase('building', { serviceName: 'billing' });
    const businessExit = 17;
    run.finish({ outcome: 'failed', errorCategory: 'build' });
    if (businessExit !== 17) process.exitCode = 1;
    else process.exitCode = businessExit;
  `;
  const result = await runChild(source).closed;
  assert.equal(result.code, 17);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
  const inProcess = createHistoryStore({ workspaceDir });
  const run = inProcess.beginRun({ command: 'build' });
  run.finish({ outcome: 'failed', errorCategory: 'build' });
  assert.equal(inProcess.list({ runId: run.runId }).records[0].outcome, 'failed');
  assert.match(inProcess.list({ runId: run.runId }).storageWarning, /写入失败/);
});

test('锁超时 fail-soft，不把无效 runId 扩成全量查询', t => {
  const workspaceDir = makeWorkspace(t);
  const store = createHistoryStore({ workspaceDir, lockTimeoutMs: 10 });
  const run = store.beginRun({ command: 'build' });
  run.finish({ outcome: 'success' });
  const lockPath = path.join(store.directory, '.history.lock');
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, nonce: 'live-lock' }), { mode: 0o600 });
  const next = store.beginRun({ command: 'start' });
  assert.match(next.storageWarning, /写入失败/);
  fs.unlinkSync(lockPath);
  next.finish({ outcome: 'success' });
  assert.equal(store.list({ runId: 'not-a-run-id' }).records.length, 0);
  assert.match(store.list({ runId: 'not-a-run-id' }).queryError, /格式无效/);
});
