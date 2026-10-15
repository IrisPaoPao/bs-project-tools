import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServiceLogWriter, listServiceLogs, removeServiceLogs } from '../../src/lib/service-logs.js';
import { launchLoggedProcess } from '../../src/lib/logged-process.js';
import { readIncrementalLog, startJavaService } from '../../src/lib/process-manager.js';
import { stopSingleService } from '../../src/commands/stop.js';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-java-retention-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, logFile: path.join(dir, 'app.log') };
}

async function until(predicate) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail('等待日志生命周期变化超时');
}

test('running logs expire after two hours, including idle periods and multiline output', t => {
  const { dir, logFile } = fixture(t);
  let now = Date.UTC(2026, 9, 15, 8);
  const writer = createServiceLogWriter(logFile, { now: () => now });
  t.after(() => writer.close());
  writer.write(Buffer.from('过期日志\n  堆栈信息\n'));
  now += 60 * 1000;
  writer.write(Buffer.from('窗口边界日志\n'));
  now += 119 * 60 * 1000;
  writer.write(Buffer.from('最新日志\n'));
  const retained = listServiceLogs(logFile).map(file => fs.readFileSync(file, 'utf8')).join('');
  assert.doesNotMatch(retained, /过期日志|堆栈/);
  assert.match(retained, /窗口边界日志/);
  assert.match(retained, /最新日志/);
  assert.equal(fs.statSync(logFile).mode & 0o777, 0o600);
  now += 2 * 60 * 60 * 1000;
  writer.tick();
  assert.equal(listServiceLogs(logFile).map(file => fs.readFileSync(file, 'utf8')).join(''), '');
  fs.writeFileSync(path.join(dir, 'other.log'), 'other');
  fs.writeFileSync(path.join(dir, 'app.123.build.log'), 'build');
  writer.close();
  removeServiceLogs(logFile);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['app.123.build.log', 'other.log']);
});

test('startup cursor follows minute rotation without losing startup messages or rereading old data', t => {
  const { logFile } = fixture(t);
  let now = Date.UTC(2026, 9, 15, 8);
  const writer = createServiceLogWriter(logFile, { now: () => now });
  t.after(() => writer.close());
  writer.write(Buffer.from('启动中\n'));
  const first = readIncrementalLog(logFile, { inode: 0, offset: 0 });
  assert.equal(first.incrementalText, '启动中\n');
  writer.write(Buffer.from('Started App in 2 seconds\n'));
  now += 60 * 1000;
  writer.write(Buffer.from('运行中\n'));
  const next = readIncrementalLog(logFile, first.cursor);
  assert.equal(next.incrementalText, 'Started App in 2 seconds\n运行中\n');
  assert.equal(readIncrementalLog(logFile, next.cursor).incrementalText, '');
});

test('incremental reads stay bounded across rotated files', t => {
  const { logFile } = fixture(t);
  let now = Date.UTC(2026, 9, 15, 8);
  const writer = createServiceLogWriter(logFile, { now: () => now });
  t.after(() => writer.close());
  writer.write(Buffer.alloc(2 * 1024 * 1024, 'a'));
  now += 60 * 1000;
  writer.write(Buffer.from('tail'));
  const first = readIncrementalLog(logFile, { inode: 0, offset: 0 });
  const second = readIncrementalLog(logFile, first.cursor);
  const third = readIncrementalLog(logFile, second.cursor);
  assert.equal(first.incrementalText.length, 1024 * 1024);
  assert.equal(second.incrementalText.length, 1024 * 1024);
  assert.equal(third.incrementalText, 'tail');
});

test('detached logger survives CLI exit, captures both streams and removes logs on service exit', async t => {
  const { dir, logFile } = fixture(t);
  const launcher = path.join(dir, 'launch.mjs');
  const moduleUrl = new URL('../../src/lib/logged-process.js', import.meta.url).href;
  fs.writeFileSync(launcher, `
    import { launchLoggedProcess } from ${JSON.stringify(moduleUrl)};
    const child = await launchLoggedProcess(process.execPath, ['-e',
      'console.log("stdout-ready"); console.error("stderr-ready"); setInterval(() => console.log("alive"), 30);'
    ], { cwd: ${JSON.stringify(dir)}, logFile: ${JSON.stringify(logFile)}, instanceUuid: 'test-logger' });
    console.log(JSON.stringify({ pid: child.pid, logPid: child.logPid }));
    child.release();
  `);
  const result = spawnSync(process.execPath, [launcher], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  const { pid, logPid } = JSON.parse(result.stdout);
  t.after(() => {
    for (const target of [pid, logPid]) {
      try { process.kill(target, 'SIGKILL'); } catch { /* 已退出 */ }
    }
  });
  await until(() => fs.existsSync(logFile) && fs.readFileSync(logFile, 'utf8').includes('stderr-ready'));
  const size = fs.statSync(logFile).size;
  await until(() => fs.statSync(logFile).size > size);
  assert.match(fs.readFileSync(logFile, 'utf8'), /stdout-ready/);
  process.kill(pid, 'SIGTERM');
  await until(() => !fs.existsSync(logFile) && !fs.existsSync(`${logFile}.owner`));
});

test('spawn failures reject and clean up the logger', async t => {
  const { dir, logFile } = fixture(t);
  await assert.rejects(launchLoggedProcess(path.join(dir, 'missing-java'), [], {
    cwd: dir, logFile, instanceUuid: 'missing-java-test',
  }), /ENOENT/);
  await until(() => !fs.existsSync(logFile) && !fs.existsSync(`${logFile}.owner`));
});

test('Java process metadata records the real service PID and stop removes all its log segments', async t => {
  const { dir, logFile } = fixture(t);
  const previous = globalThis._bsJavaRunConfig;
  const target = path.join(dir, 'app-server', 'target');
  fs.mkdirSync(path.join(target, 'app'), { recursive: true });
  fs.writeFileSync(path.join(target, 'app.war'), 'fixture');
  const java = path.join(dir, 'fake-java');
  fs.writeFileSync(java, `#!${process.execPath}\nconsole.log('Started App in 1 seconds'); setInterval(() => console.log('alive'), 30);\n`, { mode: 0o700 });
  globalThis._bsJavaRunConfig = { logDir: dir, activeEnvName: 'test' };
  t.after(() => {
    if (previous === undefined) delete globalThis._bsJavaRunConfig;
    else globalThis._bsJavaRunConfig = previous;
  });
  let saved;
  const instance = await startJavaService('app', 18999, dir, {
    javaBin: java,
    runtimeConfig: { javaOpts: [], nacosHost: '', nacosNamespace: '' },
    writePidInfo: (_name, info) => { saved = info; },
  });
  const started = saved;
  t.after(() => {
    for (const pid of [started.pid, started.logPid]) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* 已退出 */ }
    }
  });
  assert.equal(instance.pid, saved.pid);
  assert.notEqual(saved.pid, saved.logPid);
  await until(() => fs.existsSync(logFile) && fs.readFileSync(logFile, 'utf8').includes('Started'));
  assert.match(readIncrementalLog(logFile, instance.logCursor).incrementalText, /Started/);
  fs.writeFileSync(`${logFile}.123`, 'old');
  assert.equal(await stopSingleService({ name: 'app', port: 18999 }, {}, {
    readPidInfo: () => saved,
    removePidFile: () => { saved = null; },
    getLogFile: () => logFile,
    findPidsByPort: () => [],
    verifyProcessBelongsToService: () => true,
  }), true);
  assert.deepEqual(listServiceLogs(logFile), []);
  assert.equal(saved, null);
});

test('failed stops and changed instances preserve logs', async t => {
  const { logFile } = fixture(t);
  fs.writeFileSync(logFile, 'preserve me');
  const old = { pid: 123, uuid: 'old' };
  const dependencies = {
    getLogFile: () => logFile,
    readPidInfo: () => old,
    isProcessAlive: () => true,
    verifyProcessBelongsToService: () => true,
    killProcess: async () => false,
    findPidsByPort: () => [],
  };
  assert.equal(await stopSingleService({ name: 'app', port: 18999 }, {}, dependencies), false);
  let reads = 0;
  assert.equal(await stopSingleService({ name: 'app', port: 18999 }, {}, {
    ...dependencies,
    isProcessAlive: () => false,
    readPidInfo: () => ++reads === 1 ? old : { pid: 456, uuid: 'new' },
  }), false);
  assert.equal(fs.readFileSync(logFile, 'utf8'), 'preserve me');
});
