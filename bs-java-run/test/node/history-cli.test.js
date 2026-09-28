import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHistoryStore } from '../../src/lib/history.js';

const ROOT = path.resolve(new URL('../..', import.meta.url).pathname);
const CLI = path.join(ROOT, 'bin', 'bs-java-run.js');

function makeWorkspace(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-java-run-history-cli-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function runCli(args, options = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    input: options.input,
    env: { ...process.env, ...(options.env || {}) },
  });
}

test('history CLI 默认返回 20 条并支持 JSON、service、failed 和 runId 过滤', t => {
  const workspace = makeWorkspace(t);
  const store = createHistoryStore({ workspaceDir: workspace });
  let failedRunId;
  for (let index = 0; index < 21; index += 1) {
    const run = store.beginRun({
      command: index === 20 ? 'start' : 'build',
      serviceNames: [index === 20 ? 'api' : 'billing'],
    });
    run.finish({ outcome: index === 20 ? 'failed' : 'success', errorCategory: index === 20 ? 'process' : undefined });
    if (index === 20) failedRunId = run.runId;
  }

  const listed = runCli(['--workspace', workspace, 'history', '--json']);
  assert.equal(listed.status, 0, listed.stderr);
  assert.equal(listed.stderr, '');
  const payload = JSON.parse(listed.stdout);
  assert.equal(payload.records.length, 20);
  assert.equal(payload.truncated, true);

  const filtered = runCli(['--workspace', workspace, 'history', '--failed', '--service', 'api', '--run-id', failedRunId, '--json']);
  assert.equal(filtered.status, 0, filtered.stderr);
  assert.deepEqual(JSON.parse(filtered.stdout).records.map(record => record.runId), [failedRunId]);
});

test('feedback CLI 只从 stdin 读取固定 JSON 并写回指定 run', t => {
  const workspace = makeWorkspace(t);
  const store = createHistoryStore({ workspaceDir: workspace });
  const run = store.beginRun({ command: 'login' });
  run.finish({ outcome: 'failed', errorCategory: 'authentication' });
  const input = JSON.stringify({
    phenomenon: '登录失败',
    steps: ['确认登录地址', '重试请求'],
    verification: '仍然失败',
    confidence: 'confirmed',
  });
  const result = runCli(['--workspace', workspace, 'feedback', '--json', run.runId], { input });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), { runId: run.runId, saved: true, storageWarning: null });
  assert.equal(createHistoryStore({ workspaceDir: workspace }).list({ runId: run.runId }).records[0].feedback.length, 1);
});

test('runtime 顶层命令抛出异常时仍结束一条 failed history', t => {
  const workspace = makeWorkspace(t);
  const result = runCli(['--workspace', workspace, 'build', '--yes']);
  assert.notEqual(result.status, 0);
  const listed = JSON.parse(execFileSync(process.execPath, [CLI, '--workspace', workspace, 'history', '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
  }));
  assert.equal(listed.records.length, 1);
  assert.equal(listed.records[0].command, 'build');
  assert.equal(listed.records[0].outcome, 'failed');
});

test('dry-run runtime 命令不创建历史目录或记录', t => {
  for (const command of ['start', 'up', 'restart', 'stop']) {
    const workspace = makeWorkspace(t);
    const result = runCli(['--workspace', workspace, command, '--dry-run', '--json']);
    assert.notEqual(result.status, 0, `${command} should fail without a configured workspace`);
    assert.equal(
      fs.existsSync(path.join(workspace, '.bs-java-run')),
      false,
      `${command} dry-run must not create .bs-java-run history state`,
    );
  }
});
