import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { createServiceLogWriter, removeServiceLogs } from './service-logs.js';

// 独立进程接管 Java 输出，CLI 退出后仍执行两小时保留和退出清理。
let child;
let writer;
let timer;
let logFile;
let ownerFile;
let instanceUuid;
let finishing = false;

function notify(message) {
  if (process.connected) process.send(message, () => {});
}

function ownsLogs() {
  try { return fs.readFileSync(ownerFile, 'utf8') === instanceUuid; } catch { return false; }
}

function finish(code = 0) {
  if (finishing) return;
  finishing = true;
  clearInterval(timer);
  try {
    writer?.close();
    if (ownsLogs()) {
      removeServiceLogs(logFile);
      fs.rmSync(ownerFile, { force: true });
    }
  } catch {
    code = 1;
  }
  process.exit(code);
}

function fail(error) {
  notify({ error: error.message });
  // 日志写入失败时停止服务，避免服务持续运行却失去日志管理。
  if (child?.pid) {
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 5000).unref();
  } else finish(1);
}

process.on('message', message => {
  if (message.type === 'stop') {
    child?.kill('SIGTERM');
    return;
  }
  if (message.type !== 'start' || child) return;
  try {
    ({ logFile, instanceUuid } = message);
    ownerFile = `${logFile}.owner`;
    removeServiceLogs(logFile);
    fs.writeFileSync(ownerFile, instanceUuid, { mode: 0o600 });
    writer = createServiceLogWriter(logFile);
    child = spawn(message.command, message.args, {
      cwd: message.cwd,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const write = chunk => {
      try { writer.write(chunk); } catch (error) { fail(error); }
    };
    child.stdout.on('data', write);
    child.stderr.on('data', write);
    child.once('error', fail);
    child.once('close', () => finish());
    child.once('spawn', () => notify({ pid: child.pid }));
    timer = setInterval(() => {
      try { writer.tick(); } catch (error) { fail(error); }
    }, 1000);
  } catch (error) { fail(error); }
});

process.on('SIGTERM', () => child ? child.kill('SIGTERM') : finish());
process.on('SIGINT', () => child ? child.kill('SIGTERM') : finish());
process.on('disconnect', () => { if (!child) finish(); });
