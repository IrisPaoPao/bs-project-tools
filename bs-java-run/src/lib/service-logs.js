import fs from 'node:fs';
import path from 'node:path';

const RETENTION_MS = 2 * 60 * 60 * 1000;
const SEGMENT_MS = 60 * 1000;

/** 只匹配本服务的运行日志分片，避免清理构建日志或其他服务文件。 */
export function listServiceLogs(logFile) {
  const dir = path.dirname(logFile);
  const prefix = `${path.basename(logFile)}.`;
  if (!fs.existsSync(dir)) return [];
  const archives = fs.readdirSync(dir)
    .filter(name => name.startsWith(prefix) && /^\d+$/.test(name.slice(prefix.length)))
    .sort((a, b) => Number(a.slice(prefix.length)) - Number(b.slice(prefix.length)))
    .map(name => path.join(dir, name));
  if (fs.existsSync(logFile)) archives.push(logFile);
  return archives;
}

export function removeServiceLogs(logFile) {
  for (const file of listServiceLogs(logFile)) fs.rmSync(file, { force: true });
  fs.rmSync(`${logFile}.owner`, { force: true });
}

/** 按接收时间分分钟滚动；淘汰整个过期分钟，保留窗口最多提前一分钟。 */
export function createServiceLogWriter(logFile, { now = Date.now } = {}) {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  let segmentStart = Math.floor(now() / SEGMENT_MS) * SEGMENT_MS;
  let fd = fs.openSync(logFile, 'w', 0o600);
  let closed = false;

  function prune() {
    const cutoff = now() - RETENTION_MS;
    const prefix = `${path.basename(logFile)}.`;
    for (const file of listServiceLogs(logFile)) {
      if (file !== logFile && Number(path.basename(file).slice(prefix.length)) <= cutoff) {
        fs.rmSync(file, { force: true });
      }
    }
  }

  function tick() {
    if (closed) return;
    const next = Math.floor(now() / SEGMENT_MS) * SEGMENT_MS;
    if (next <= segmentStart) return;
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(logFile, `${logFile}.${segmentStart}`);
    fd = fs.openSync(logFile, 'w', 0o600);
    segmentStart = next;
    prune();
  }

  return {
    tick,
    write(chunk) {
      tick();
      // 同步分块落盘提供背压，避免高频 SQL 日志在日志进程中无界排队。
      let offset = 0;
      while (offset < chunk.length) offset += fs.writeSync(fd, chunk, offset, chunk.length - offset);
    },
    close() {
      if (closed) return;
      closed = true;
      if (fd !== null) fs.closeSync(fd);
    },
  };
}
