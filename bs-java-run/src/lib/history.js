import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const SCHEMA_VERSION = 1;
const RUN_FILE_PREFIX = 'run-';
const ACTIVE_FILE_PREFIX = '.active-';
const LOCK_FILE = '.history.lock';
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
const DEFAULT_RETENTION_DAYS = 30;
// 并发进程的轮转和 fsync 都发生在锁内；100ms 在繁忙磁盘上会把正常竞争误判为失败。
const DEFAULT_LOCK_TIMEOUT_MS = 2000;
const MAX_RECORD_BYTES = 256 * 1024;
const MAX_STAGES = 200;
const MAX_FEEDBACK_ITEMS = 10;
const ALLOWED_COMMANDS = new Set([
  'build', 'start', 'up', 'restart', 'stop', 'login', 'token', 'smoke',
  'workspace-init', 'workspace-update', 'unknown',
]);
const OUTCOMES = new Set(['success', 'failed', 'incomplete', 'skipped']);
const FINAL_OUTCOMES = new Set(['success', 'failed', 'incomplete']);
const ERROR_CATEGORIES = new Set([
  'configuration', 'selection', 'build', 'dependency-resolution', 'process',
  'timeout', 'readiness-timeout', 'network', 'authentication', 'permission',
  'cancelled', 'unknown', 'bean-conflict', 'bean-missing', 'port-conflict',
  'login-form', 'token-missing',
]);
const FEEDBACK_CONFIDENCE = new Set(['confirmed', 'suspected']);
const SLEEP_CELL = new Int32Array(new SharedArrayBuffer(4));

function toIso(now) {
  try {
    const raw = now();
    const date = raw instanceof Date ? raw : new Date(raw);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  } catch {
    // 时钟注入仅用于测试；异常时退回系统时钟，不能影响 CLI 操作。
  }
  return new Date().toISOString();
}

function safeText(value, maxLength = 128) {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (!cleaned || cleaned.length > maxLength) return null;
  if (/\b(?:password|passwd|token|authorization|cookie|secret|api[_-]?key)\s*[:=]/i.test(cleaned)) return null;
  if (/\bbearer\s+\S+/i.test(cleaned)) return null;
  return cleaned;
}

function safeErrorCategory(value) {
  return ERROR_CATEGORIES.has(value) ? value : 'unknown';
}

function safeOutcome(value, fallback = 'incomplete') {
  if (value === 'succeeded') return 'success';
  return OUTCOMES.has(value) ? value : fallback;
}

function safeRunId(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function fileRunId(fileName) {
  const match = /^run-([0-9a-f-]{36})\.json$/i.exec(fileName);
  return match?.[1] || null;
}

function pidIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function sanitizeFeedbackText(value, fieldName, maxLength) {
  if (typeof value !== 'string') throw new Error(`feedback.${fieldName} 必须是字符串`);
  let text = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ');
  text = text
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(/((?:"|')?(?:password|passwd|pwd|token|access[_-]?token|refresh[_-]?token|authorization|cookie|secret|api[_-]?key|username|account|login|user|密码|口令|令牌|访问令牌|刷新令牌|用户名|账号|账户|授权|认证)(?:"|')?\s*[:=：]\s*)(?:"[^"]*"|'[^']*'|[^\s,;，。；、}&]+)/gi, '$1[REDACTED]')
    .replace(/((?:password|passwd|pwd|token|access[_-]?token|refresh[_-]?token|authorization|cookie|secret|api[_-]?key|username|account|login|user|密码|口令|令牌|访问令牌|刷新令牌|用户名|账号|账户|授权|认证)\s*(?:是|为)\s*)[^\s,;，。]+/gi, '$1[REDACTED]')
    .replace(/((?:https?|ftp):\/\/)[^\/@\s:]+:[^\/@\s]+@/gi, '$1[REDACTED]@')
    .replace(/\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED_JWT]')
    .replace(/(https?:\/\/[^\s?#]+)[?#][^\s]+/gi, '$1?[REDACTED]')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) throw new Error(`feedback.${fieldName} 不能为空`);
  if (text.length > maxLength) throw new Error(`feedback.${fieldName} 最长 ${maxLength} 个字符`);
  return text;
}

/**
 * feedback 固定为 JSON：{ phenomenon, steps: string[], verification, confidence }。
 * 未知字段拒绝写入；常见凭据格式再做一次防御性遮盖。
 */
export function parseHistoryFeedback(input) {
  let value = input;
  if (typeof input === 'string') {
    if (Buffer.byteLength(input, 'utf8') > 64 * 1024) throw new Error('feedback JSON 不能超过 64 KiB');
    try {
      value = JSON.parse(input);
    } catch {
      throw new Error('feedback 必须是有效 JSON');
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('feedback 必须是 JSON 对象');
  }
  const keys = Object.keys(value).sort();
  const expected = ['confidence', 'phenomenon', 'steps', 'verification'];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error('feedback 只允许 phenomenon、steps、verification、confidence 四个字段');
  }
  if (!FEEDBACK_CONFIDENCE.has(value.confidence)) {
    throw new Error('feedback.confidence 必须是 confirmed 或 suspected');
  }
  if (!Array.isArray(value.steps) || value.steps.length < 1 || value.steps.length > 20) {
    throw new Error('feedback.steps 必须包含 1 到 20 个步骤');
  }
  return {
    phenomenon: sanitizeFeedbackText(value.phenomenon, 'phenomenon', 1000),
    steps: value.steps.map((step, index) => sanitizeFeedbackText(step, `steps[${index}]`, 1000)),
    verification: sanitizeFeedbackText(value.verification, 'verification', 1000),
    confidence: value.confidence,
  };
}

function safeLogLocation(value, workspaceRoot) {
  if (typeof value !== 'string' || !workspaceRoot) return null;
  try {
    const absolute = path.resolve(workspaceRoot, value);
    const relative = path.relative(workspaceRoot, absolute);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
    const normalized = relative.split(path.sep).join('/');
    return normalized.length <= 1024 ? normalized : null;
  } catch {
    return null;
  }
}

function safeStoredLogLocation(value) {
  if (typeof value !== 'string' || !value || value.length > 1024 || value.startsWith('/')) return null;
  const parts = value.replace(/\\/g, '/').split('/');
  if (parts.some(part => part === '..' || part === '')) return null;
  return parts.join('/');
}

function mergeFeedback(...lists) {
  const values = new Map();
  for (const list of lists) {
    for (const item of list || []) {
      const key = JSON.stringify([item.createdAt, item.phenomenon, item.steps, item.verification, item.confidence]);
      values.set(key, item);
    }
  }
  return [...values.values()]
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
    .slice(-MAX_FEEDBACK_ITEMS);
}

function normalizeStage(stage) {
  if (!stage || typeof stage !== 'object') return null;
  const name = safeText(stage.name, 80);
  if (!name || !validTimestamp(stage.startedAt)) return null;
  const outcome = safeOutcome(stage.outcome);
  const duration = Number(stage.durationMs);
  return {
    name,
    serviceName: safeText(stage.serviceName),
    startedAt: stage.startedAt,
    endedAt: validTimestamp(stage.endedAt) ? stage.endedAt : null,
    durationMs: Number.isFinite(duration) && duration >= 0 ? Math.floor(duration) : null,
    outcome,
    errorCategory: stage.errorCategory ? safeErrorCategory(stage.errorCategory) : null,
    logLocation: safeStoredLogLocation(stage.logLocation),
    logOffset: Number.isSafeInteger(stage.logOffset) && stage.logOffset >= 0 ? stage.logOffset : null,
  };
}

function validTimestamp(value) {
  return typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));
}

function normalizeRecord(value, expectedRunId = null) {
  if (!value || typeof value !== 'object' || value.schemaVersion !== SCHEMA_VERSION) return null;
  if (!safeRunId(value.runId) || (expectedRunId && value.runId !== expectedRunId)) return null;
  if (!ALLOWED_COMMANDS.has(value.command) || !validTimestamp(value.startedAt)) return null;
  const serviceNames = Array.isArray(value.serviceNames)
    ? [...new Set(value.serviceNames.map(item => safeText(item)).filter(Boolean))].slice(0, 100)
    : [];
  const feedback = Array.isArray(value.feedback) ? value.feedback.slice(-MAX_FEEDBACK_ITEMS).map(item => {
    try {
      const normalized = parseHistoryFeedback({
        phenomenon: item.phenomenon,
        steps: item.steps,
        verification: item.verification,
        confidence: item.confidence,
      });
      return { createdAt: typeof item.createdAt === 'string' ? item.createdAt : value.startedAt, ...normalized };
    } catch {
      return null;
    }
  }).filter(Boolean) : [];
  return {
    schemaVersion: SCHEMA_VERSION,
    runId: value.runId,
    startedAt: value.startedAt,
    endedAt: validTimestamp(value.endedAt) ? value.endedAt : null,
    updatedAt: validTimestamp(value.updatedAt) ? value.updatedAt : value.startedAt,
    command: value.command,
    serviceNames,
    envAlias: safeText(value.envAlias),
    toolVersion: safeText(value.toolVersion, 64),
    stages: Array.isArray(value.stages) ? value.stages.slice(-MAX_STAGES).map(normalizeStage).filter(Boolean) : [],
    outcome: safeOutcome(value.outcome),
    errorCategory: value.errorCategory ? safeErrorCategory(value.errorCategory) : null,
    feedback,
  };
}

function ensureDirectory(root, historyDir) {
  const rootStat = fs.statSync(root);
  if (!rootStat.isDirectory()) throw new Error('workspace-root-invalid');
  const ensureChild = (directory, mode) => {
    let stat;
    try { stat = fs.lstatSync(directory); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!stat) {
      try { fs.mkdirSync(directory, { mode }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      stat = fs.lstatSync(directory);
    }
    return stat;
  };
  const configDir = path.join(root, '.bs-java-run');
  const configStat = ensureChild(configDir, 0o700);
  if (configStat.isSymbolicLink() || !configStat.isDirectory()) throw new Error('history-parent-invalid');
  const historyStat = ensureChild(historyDir, 0o700);
  if (historyStat?.isSymbolicLink() || (historyStat && !historyStat.isDirectory())) throw new Error('history-directory-invalid');
  fs.chmodSync(historyDir, 0o700);
}

function readMarkerPid(filePath) {
  try {
    const marker = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return Number.isInteger(marker.pid) ? marker.pid : null;
  } catch {
    return null;
  }
}

/** 本地 run 记录；所有持久化错误都被收敛为 storageWarning，不向业务命令抛出。 */
export function createHistoryStore({
  workspaceDir,
  now = () => Date.now(),
  maxBytes = DEFAULT_MAX_BYTES,
  retentionDays = DEFAULT_RETENTION_DAYS,
  lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
} = {}) {
  const root = typeof workspaceDir === 'string' && workspaceDir.trim() ? path.resolve(workspaceDir) : null;
  const historyDir = root ? path.join(root, '.bs-java-run', 'history') : null;
  const cache = new Map();
  const volatileRuns = new Set();
  const capacity = Number.isFinite(maxBytes) && maxBytes >= 256 ? Math.floor(maxBytes) : DEFAULT_MAX_BYTES;
  const retentionMs = Math.max(0, Number.isFinite(retentionDays) ? retentionDays : DEFAULT_RETENTION_DAYS) * 24 * 60 * 60 * 1000;
  let storageWarning = root ? null : '未指定工作区，历史只能保留在当前进程内。';

  function setWarning(message) {
    storageWarning = message;
  }

  function rootAvailable() {
    if (!root) return false;
    try {
      return fs.statSync(root).isDirectory();
    } catch {
      return false;
    }
  }

  function historyDirectoryAvailable() {
    if (!rootAvailable()) return false;
    try {
      const configStat = fs.lstatSync(path.join(root, '.bs-java-run'));
      const historyStat = fs.lstatSync(historyDir);
      return configStat.isDirectory() && !configStat.isSymbolicLink()
        && historyStat.isDirectory() && !historyStat.isSymbolicLink();
    } catch {
      return false;
    }
  }

  function runFile(runId) {
    return path.join(historyDir, `${RUN_FILE_PREFIX}${runId}.json`);
  }

  function activeFile(runId) {
    return path.join(historyDir, `${ACTIVE_FILE_PREFIX}${runId}`);
  }

  function waitBriefly() {
    Atomics.wait(SLEEP_CELL, 0, 0, 2);
  }

  function breakStaleLock(lockPath) {
    let before;
    let content;
    try {
      before = fs.statSync(lockPath);
      content = fs.readFileSync(lockPath, 'utf8');
    } catch {
      return;
    }
    let pid = null;
    let nonce = null;
    try {
      const parsed = JSON.parse(content);
      pid = parsed.pid;
      nonce = parsed.nonce;
    } catch {
      if (Date.now() - before.mtimeMs < 1000) return;
    }
    if (pid && pidIsAlive(pid)) return;
    try {
      const latest = fs.statSync(lockPath);
      const latestContent = fs.readFileSync(lockPath, 'utf8');
      if (latest.ino !== before.ino || latestContent !== content || (nonce && !latestContent.includes(nonce))) return;
      const stale = `${lockPath}.stale-${crypto.randomUUID()}`;
      fs.renameSync(lockPath, stale);
      fs.unlinkSync(stale);
    } catch {
      // 另一个写入者可能已释放或接管锁。
    }
  }

  function withLock(action) {
    if (!rootAvailable()) throw new Error('workspace-root-unavailable');
    ensureDirectory(root, historyDir);
    const lockPath = path.join(historyDir, LOCK_FILE);
    const deadline = Date.now() + lockTimeoutMs;
    let fd;
    let lockInode = null;
    const nonce = crypto.randomUUID();
    while (Date.now() <= deadline) {
      try {
        fd = fs.openSync(lockPath, 'wx', 0o600);
        lockInode = fs.fstatSync(fd).ino;
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, nonce }));
        fs.fsyncSync(fd);
        break;
      } catch (error) {
        if (fd !== undefined) {
          try { fs.closeSync(fd); } catch { /* ignore */ }
          fd = undefined;
          try {
            if (fs.statSync(lockPath).ino === lockInode) fs.unlinkSync(lockPath);
          } catch { /* already released */ }
        }
        if (error.code !== 'EEXIST') throw error;
        breakStaleLock(lockPath);
        // 锁释放后立即重试，持续竞争时逐步让出一点 CPU；显式短超时仍按调用方要求结束。
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        waitBriefly();
      }
    }
    if (fd === undefined) throw new Error('history-lock-timeout');
    try {
      return action();
    } finally {
      try { fs.closeSync(fd); } catch { /* ignore */ }
      try {
        const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
        if (lock.nonce === nonce) fs.unlinkSync(lockPath);
      } catch {
        // 锁释放失败会在下次写入时按进程存活状态回收。
      }
    }
  }

  function writeAtomic(filePath, content) {
    const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    let fd;
    try {
      fd = fs.openSync(tempPath, 'wx', 0o600);
      fs.writeFileSync(fd, content, 'utf8');
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      fs.renameSync(tempPath, filePath);
      fs.chmodSync(filePath, 0o600);
    } finally {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch { /* ignore */ }
      }
      try { fs.unlinkSync(tempPath); } catch { /* already renamed or absent */ }
    }
  }

  function readDiskRecord(filePath, expectedRunId) {
    try {
      if (fs.statSync(filePath).size > MAX_RECORD_BYTES) return null;
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      return normalizeRecord(raw, expectedRunId);
    } catch {
      return null;
    }
  }

  function readDiskRecords() {
    const records = [];
    let unreadable = false;
    if (!historyDirectoryAvailable()) {
      try {
        fs.lstatSync(historyDir);
        unreadable = true;
      } catch {
        // 尚未创建历史目录表示还没有本地记录。
      }
      return { records, unreadable };
    }
    try {
      const entries = fs.readdirSync(historyDir, { withFileTypes: true });
      for (const entry of entries) {
        const runId = fileRunId(entry.name);
        if (!entry.name.startsWith(RUN_FILE_PREFIX)) continue;
        if (!runId || !entry.isFile()) {
          unreadable = true;
          continue;
        }
        const record = readDiskRecord(path.join(historyDir, entry.name), runId);
        if (record) records.push(record);
        else unreadable = true;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') unreadable = true;
    }
    return { records, unreadable };
  }

  function liveRunIds() {
    const live = new Set();
    let entries;
    try {
      entries = fs.readdirSync(historyDir, { withFileTypes: true });
    } catch {
      return live;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.startsWith(ACTIVE_FILE_PREFIX)) continue;
      const runId = entry.name.slice(ACTIVE_FILE_PREFIX.length);
      const markerPath = path.join(historyDir, entry.name);
      const pid = readMarkerPid(markerPath);
      if (pidIsAlive(pid)) live.add(runId);
      else {
        try { fs.unlinkSync(markerPath); } catch { /* best effort */ }
      }
    }
    return live;
  }

  function fileSizes() {
    try {
      return fs.readdirSync(historyDir, { withFileTypes: true })
        .filter(entry => entry.isFile() && entry.name !== LOCK_FILE)
        .map(entry => {
          const filePath = path.join(historyDir, entry.name);
          try { return { name: entry.name, path: filePath, size: fs.statSync(filePath).size }; }
          catch { return null; }
        })
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  function cleanupTemps() {
    for (const item of fileSizes()) {
      if (item.name.endsWith('.tmp')) {
        try { fs.unlinkSync(item.path); } catch { /* best effort */ }
      }
    }
  }

  function pruneFor(projectedRecord, protectedRunId, { reserveActiveMarker = false, rotateExpired = false } = {}) {
    const currentPath = projectedRecord ? runFile(projectedRecord.runId) : null;
    const currentSize = currentPath && fs.existsSync(currentPath) ? fs.statSync(currentPath).size : 0;
    const projectedBytes = projectedRecord ? Buffer.byteLength(JSON.stringify(projectedRecord), 'utf8') : 0;
    if (projectedBytes > MAX_RECORD_BYTES) throw new Error('history-record-too-large');
    const markerPath = projectedRecord ? activeFile(projectedRecord.runId) : null;
    const markerBytes = markerPath && fs.existsSync(markerPath)
      ? 0
      : (projectedRecord && !projectedRecord.endedAt && reserveActiveMarker ? 96 : 0);
    let sizes = fileSizes();
    let used = sizes.reduce((sum, item) => sum + item.size, 0);
    let needed = used - currentSize + projectedBytes + markerBytes;
    if (!rotateExpired && needed <= capacity) return;

    cleanupTemps();
    const live = liveRunIds();
    const records = [];
    for (const file of fileSizes()) {
      const runId = fileRunId(file.name);
      if (!runId) continue;
      const record = readDiskRecord(file.path, runId);
      const at = Date.parse(record?.endedAt || record?.startedAt || '');
      records.push({ ...file, runId, record, at: Number.isFinite(at) ? at : 0 });
    }
    const cutoff = Date.parse(toIso(now)) - retentionMs;
    for (const item of records) {
      if (item.runId === protectedRunId || live.has(item.runId)) continue;
      if (item.at && item.at < cutoff) {
        try { fs.unlinkSync(item.path); } catch { /* best effort */ }
      }
    }

    sizes = fileSizes();
    used = sizes.reduce((sum, item) => sum + item.size, 0);
    needed = used - currentSize + projectedBytes + markerBytes;
    const candidates = records
      .filter(item => item.runId !== protectedRunId && !live.has(item.runId) && fs.existsSync(item.path))
      .sort((a, b) => a.at - b.at);
    while (needed > capacity && candidates.length) {
      const oldest = candidates.shift();
      try { fs.unlinkSync(oldest.path); } catch { continue; }
      used -= oldest.size;
      needed -= oldest.size;
    }
    sizes = fileSizes();
    used = sizes.reduce((sum, item) => sum + item.size, 0);
    needed = used - currentSize + projectedBytes + markerBytes;
    if (needed > capacity) throw new Error('history-capacity-exceeded');
  }

  function createActiveMarker(runId) {
    const markerPath = activeFile(runId);
    if (fs.existsSync(markerPath)) return false;
    const marker = JSON.stringify({ pid: process.pid, nonce: crypto.randomUUID() });
    const fd = fs.openSync(markerPath, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, marker, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.chmodSync(markerPath, 0o600);
    return true;
  }

  function removeActiveMarker(runId) {
    try { fs.unlinkSync(activeFile(runId)); } catch { /* no marker or best-effort cleanup */ }
  }

  function persistRecord(record, { initialSnapshot = false, rotateExpired = false } = {}) {
    if (!root || !rootAvailable()) {
      setWarning(root ? '工作区目录不可用，历史记录仅在当前进程中可见。' : '未指定工作区，历史记录仅在当前进程中可见。');
      return false;
    }
    let createdMarker = false;
    let hadRecord = false;
    const recordPath = runFile(record.runId);
    try {
      withLock(() => {
        hadRecord = fs.existsSync(recordPath);
        const diskRecord = hadRecord ? readDiskRecord(recordPath, record.runId) : null;
        if (diskRecord) record.feedback = mergeFeedback(diskRecord.feedback, record.feedback);
        if (!record.endedAt) {
          pruneFor(record, record.runId, { reserveActiveMarker: true, rotateExpired });
          createdMarker = createActiveMarker(record.runId);
        } else if (rotateExpired) {
          pruneFor(record, record.runId, { rotateExpired: true });
        }
        if (initialSnapshot && !hadRecord) {
          const initial = clone(record);
          initial.endedAt = null;
          initial.updatedAt = initial.startedAt;
          initial.outcome = 'incomplete';
          initial.errorCategory = null;
          initial.feedback = [];
          pruneFor(initial, initial.runId);
          writeAtomic(recordPath, JSON.stringify(initial));
        }
        pruneFor(record, record.runId);
        writeAtomic(recordPath, JSON.stringify(record));
        if (record.endedAt) removeActiveMarker(record.runId);
      });
      cache.set(record.runId, record);
      volatileRuns.delete(record.runId);
      setWarning(null);
      return true;
    } catch (error) {
      if (createdMarker && !hadRecord && !fs.existsSync(recordPath)) removeActiveMarker(record.runId);
      volatileRuns.add(record.runId);
      setWarning('历史记录写入失败或存储达到容量上限；本次进程中可查看已保留的内存记录，磁盘记录可能不完整。');
      return false;
    }
  }

  function beginRun(meta = {}, { deferPersistence = false } = {}) {
    const runId = crypto.randomUUID();
    const startedAt = toIso(now);
    const requestedCommand = safeText(meta.command, 64);
    const serviceNames = Array.isArray(meta.serviceNames)
      ? [...new Set(meta.serviceNames.map(item => safeText(item)).filter(Boolean))].slice(0, 100)
      : [];
    const record = {
      schemaVersion: SCHEMA_VERSION,
      runId,
      startedAt,
      endedAt: null,
      updatedAt: startedAt,
      command: ALLOWED_COMMANDS.has(requestedCommand) ? requestedCommand : 'unknown',
      serviceNames,
      envAlias: safeText(meta.envAlias),
      toolVersion: safeText(meta.toolVersion, 64),
      stages: [],
      outcome: 'incomplete',
      errorCategory: null,
      feedback: [],
    };
    cache.set(runId, record);
    let activeStage = null;
    let activated = false;
    let initialPersisted = false;
    let finished = false;

    const context = {
      runId,
      get storageWarning() { return volatileRuns.has(runId) ? storageWarning : null; },
      get record() { return clone(record); },
      activate() {
        if (activated) return !volatileRuns.has(runId);
        if (!rootAvailable()) {
          setWarning('工作区目录不可用；未创建目标目录，历史记录仅在当前进程中可见。');
          volatileRuns.add(runId);
          return false;
        }
        activated = true;
        const ok = persistRecord(record, { rotateExpired: true });
        initialPersisted = ok;
        return ok;
      },
      setPhase(phase, detail = {}) {
        if (finished) return;
        const phaseName = safeText(phase, 80);
        if (!phaseName) return;
        const serviceName = safeText(detail.serviceName);
        const sameStage = activeStage && activeStage.name === phaseName && activeStage.serviceName === serviceName;
        const requestedOutcome = OUTCOMES.has(detail.outcome) ? detail.outcome : null;
        const category = detail.errorCategory ? safeErrorCategory(detail.errorCategory) : null;
        const logLocation = safeLogLocation(detail.logPath, root);
        const logOffset = Number.isSafeInteger(detail.logOffset) && detail.logOffset >= 0 ? detail.logOffset : null;
        const timestamp = toIso(now);
        const closeStage = (stage, outcome = 'success') => {
          if (!stage || stage.endedAt) return;
          const endedAt = timestamp;
          const durationMs = Math.max(0, Date.parse(endedAt) - Date.parse(stage.startedAt));
          stage.endedAt = endedAt;
          stage.durationMs = Number.isFinite(durationMs) ? durationMs : 0;
          stage.outcome = outcome;
          if (category && outcome === 'failed') stage.errorCategory = category;
        };

        if (sameStage) {
          if (requestedOutcome) {
            closeStage(activeStage, requestedOutcome);
            if (category) activeStage.errorCategory = category;
            if (logLocation) activeStage.logLocation = logLocation;
            if (logOffset !== null) activeStage.logOffset = logOffset;
            activeStage = null;
          } else {
            if (category) activeStage.errorCategory = category;
            if (logLocation) activeStage.logLocation = logLocation;
            if (logOffset !== null) activeStage.logOffset = logOffset;
          }
        } else {
          if (activeStage && !activeStage.endedAt) closeStage(activeStage, 'success');
          activeStage = null;
          if (!requestedOutcome || requestedOutcome === 'incomplete') {
            activeStage = {
              name: phaseName,
              serviceName,
              startedAt: timestamp,
              endedAt: null,
              durationMs: null,
              outcome: 'incomplete',
              errorCategory: category,
              logLocation,
              logOffset,
            };
            if (record.stages.length < MAX_STAGES) record.stages.push(activeStage);
            else activeStage = null;
          } else {
            const completed = {
              name: phaseName,
              serviceName,
              startedAt: timestamp,
              endedAt: timestamp,
              durationMs: 0,
              outcome: requestedOutcome,
              errorCategory: category,
              logLocation,
              logOffset,
            };
            if (record.stages.length < MAX_STAGES) record.stages.push(completed);
          }
        }
        if (serviceName && !record.serviceNames.includes(serviceName) && record.serviceNames.length < 100) {
          record.serviceNames.push(serviceName);
        }
        record.updatedAt = timestamp;
        cache.set(runId, record);
        if (activated || !deferPersistence) {
          activated = true;
          const ok = persistRecord(record, { initialSnapshot: !initialPersisted });
          if (ok) initialPersisted = true;
        }
      },
      recordStartedInstance(instance = {}) {
        const serviceName = safeText(instance.serviceName);
        if (!serviceName || record.serviceNames.includes(serviceName) || record.serviceNames.length >= 100) return;
        record.serviceNames.push(serviceName);
        record.updatedAt = toIso(now);
        cache.set(runId, record);
        if (activated || !deferPersistence) {
          activated = true;
          const ok = persistRecord(record, { initialSnapshot: !initialPersisted });
          if (ok) initialPersisted = true;
        }
      },
      finish({ outcome = 'success', errorCategory, persistDeferred = false } = {}) {
        if (finished) return !volatileRuns.has(runId);
        if (deferPersistence && !activated && persistDeferred) context.activate();
        const timestamp = toIso(now);
        const previousFailure = [...record.stages].reverse().find(stage => stage.outcome === 'failed' && stage.errorCategory);
        const finalCategory = errorCategory
          ? safeErrorCategory(errorCategory)
          : (activeStage?.errorCategory || previousFailure?.errorCategory || 'unknown');
        if (activeStage && !activeStage.endedAt) {
          activeStage.endedAt = timestamp;
          const durationMs = Math.max(0, Date.parse(timestamp) - Date.parse(activeStage.startedAt));
          activeStage.durationMs = Number.isFinite(durationMs) ? durationMs : 0;
          activeStage.outcome = safeOutcome(outcome, 'failed');
          if (activeStage.outcome === 'failed' && !activeStage.errorCategory) activeStage.errorCategory = finalCategory;
          activeStage = null;
        }
        record.endedAt = timestamp;
        record.updatedAt = timestamp;
        record.outcome = FINAL_OUTCOMES.has(outcome) ? outcome : 'success';
        record.errorCategory = record.outcome === 'failed' ? finalCategory : null;
        cache.set(runId, record);
        finished = true;
        if (activated) {
          const ok = persistRecord(record, { initialSnapshot: !initialPersisted });
          if (ok) initialPersisted = true;
          return ok;
        }
        if (deferPersistence) {
          volatileRuns.add(runId);
          setWarning('延迟历史记录尚未激活，结果只在当前进程中可见；磁盘记录可能不完整。');
          return false;
        }
        return true;
      },
    };

    if (!deferPersistence) {
      activated = true;
      initialPersisted = persistRecord(record, { rotateExpired: true });
    }
    return context;
  }

  function addFeedback(runId, input) {
    if (!safeRunId(runId)) throw new Error('runId 格式无效');
    const feedback = parseHistoryFeedback(input);
    const cached = cache.get(runId);
    const diskBeforeLock = historyDirectoryAvailable() ? readDiskRecord(runFile(runId), runId) : null;
    if (!cached && !diskBeforeLock) throw new Error('未找到该 runId 的历史记录');
    const feedbackEntry = { createdAt: toIso(now), ...feedback };
    let updated = clone(cached || diskBeforeLock);
    updated.feedback = mergeFeedback(diskBeforeLock?.feedback, cached?.feedback, [feedbackEntry]);
    updated.updatedAt = feedbackEntry.createdAt;
    cache.set(runId, updated);
    if (!root || !rootAvailable()) {
      volatileRuns.add(runId);
      setWarning('工作区目录不可用，反馈只在当前进程中可见。');
      return { saved: false, storageWarning };
    }
    try {
      withLock(() => {
        const latestDisk = readDiskRecord(runFile(runId), runId);
        const latestCache = cache.get(runId);
        if (!latestDisk && !latestCache) throw new Error('history-run-disappeared');
        const latest = latestCache && (!latestDisk || Date.parse(latestCache.updatedAt) > Date.parse(latestDisk.updatedAt))
          ? clone(latestCache)
          : clone(latestDisk);
        latest.feedback = mergeFeedback(latestDisk?.feedback, latestCache?.feedback, [feedbackEntry]);
        latest.updatedAt = feedbackEntry.createdAt;
        pruneFor(latest, runId);
        writeAtomic(runFile(runId), JSON.stringify(latest));
        updated = latest;
        cache.set(runId, latest);
      });
      volatileRuns.delete(runId);
      setWarning(null);
      return { saved: true, storageWarning: null };
    } catch {
      volatileRuns.add(runId);
      setWarning('历史反馈写入失败或存储达到容量上限；本次进程中可查看内存记录，磁盘记录可能不完整。');
      return { saved: false, storageWarning };
    }
  }

  function list({ service, failed = false, runId, limit = 20 } = {}) {
    const disk = readDiskRecords();
    const recordsById = new Map(disk.records.map(record => [record.runId, record]));
    for (const [id, record] of cache) recordsById.set(id, normalizeRecord(record, id) || clone(record));
    const serviceFilter = safeText(service);
    const validFilterId = safeRunId(runId) ? runId : null;
    const invalidFilter = (runId !== undefined && !validFilterId)
      || (service !== undefined && !serviceFilter);
    const parsedLimit = Number.isInteger(limit) ? Math.max(1, Math.min(100, limit)) : 20;
    const all = (invalidFilter ? [] : [...recordsById.values()])
      .filter(record => !validFilterId || record.runId === validFilterId)
      .filter(record => !serviceFilter || record.serviceNames.includes(serviceFilter))
      .filter(record => !failed || record.outcome === 'failed')
      .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
    const warnings = [];
    if (disk.unreadable) warnings.push('部分磁盘历史文件不可读取或损坏，结果可能不完整。');
    if ([...volatileRuns].some(id => recordsById.has(id))) warnings.push(storageWarning || '部分历史记录未写入磁盘，结果可能不完整。');
    return {
      records: all.slice(0, parsedLimit),
      truncated: all.length > parsedLimit,
      queryError: invalidFilter ? 'runId 或 service 过滤值格式无效。' : null,
      storageWarning: warnings.length ? [...new Set(warnings)].join(' ') : null,
    };
  }

  return {
    get directory() { return historyDir; },
    get storageWarning() { return storageWarning; },
    beginRun,
    list,
    addFeedback,
  };
}

export const historyDefaults = Object.freeze({
  schemaVersion: SCHEMA_VERSION,
  maxBytes: DEFAULT_MAX_BYTES,
  retentionDays: DEFAULT_RETENTION_DAYS,
});

export const historyFeedbackSchema = Object.freeze({
  requiredFields: Object.freeze(['phenomenon', 'steps', 'verification', 'confidence']),
  fields: Object.freeze({
    phenomenon: 'string，1 到 1000 字符',
    steps: 'string 数组，1 到 20 项，每项最多 1000 字符',
    verification: 'string，1 到 1000 字符',
    confidence: 'confirmed 或 suspected',
  }),
});
