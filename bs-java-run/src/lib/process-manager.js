import { execSync, spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { getConfig, parseJvmOptionKey, resolveServiceRuntimeConfig } from './config.js';
import { info, success, error } from './logger.js';

const MAX_INCREMENTAL_LOG_BYTES = 1024 * 1024;
const MAX_MAVEN_CAPTURE_BYTES = 8 * 1024 * 1024;
const MAX_STARTUP_LINE_CHARS = 8192;

export function getLogDir() {
  return getConfig().logDir;
}

export function ensureLogDir() {
  const logDir = getLogDir();
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }
  return logDir;
}

export function getPidFile(name) {
  return path.join(getLogDir(), `${name}.pid`);
}

export function getLogFile(name) {
  return path.join(getLogDir(), `${name}.log`);
}

export function getBuildLogFile(name, runId = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`) {
  return path.join(getLogDir(), `${name}.${runId}.build.log`);
}

export function writePidInfo(name, infoObj) {
  const pidFile = getPidFile(name);
  const content = JSON.stringify(infoObj, null, 2);
  const temporaryFile = `${pidFile}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporaryFile, content, { encoding: 'utf8', mode: 0o600 });
    fs.chmodSync(temporaryFile, 0o600);
    fs.renameSync(temporaryFile, pidFile);
    fs.chmodSync(pidFile, 0o600);
  } finally {
    try {
      if (fs.existsSync(temporaryFile)) fs.unlinkSync(temporaryFile);
    } catch {
      // 清理临时文件失败不覆盖原始写入异常。
    }
  }
}

export function readPidInfo(name) {
  const pidFile = getPidFile(name);
  if (!fs.existsSync(pidFile)) return null;
  try {
    const content = fs.readFileSync(pidFile, 'utf8').trim();
    if (!content) return null;
    if (content.startsWith('{')) {
      return JSON.parse(content);
    }
    const pid = parseInt(content, 10);
    return pid ? { pid, serviceName: name } : null;
  } catch {
    return null;
  }
}

export function readPidFile(name) {
  const infoObj = readPidInfo(name);
  return infoObj ? infoObj.pid : null;
}

export function removePidFile(name) {
  const pidFile = getPidFile(name);
  if (fs.existsSync(pidFile)) {
    fs.unlinkSync(pidFile);
  }
}

/**
 * 为服务启动参数生成稳定摘要。完整 JVM 参数只参与哈希，不写入摘要，避免把可能的敏感值落入 PID 元数据或状态输出。
 */
function redactFingerprintValue(value) {
  return String(value || '')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1***:***@')
    .replace(/([?&](?:token|password|passwd|secret|authorization)=)[^&\s]*/gi, '$1***');
}

export function createServiceFingerprint({
  servicePath,
  port,
  environment = '',
  nacosHost = '',
  nacosNamespace = '',
  javaOpts = [],
} = {}) {
  let realServicePath = path.resolve(String(servicePath || ''));
  try {
    realServicePath = fs.realpathSync(realServicePath);
  } catch {
    // 启动前目录可能尚未创建；使用规范化绝对路径仍能阻止不同路径别名复用。
  }
  const normalizedJavaOpts = (Array.isArray(javaOpts) ? javaOpts : [javaOpts])
    .map(option => String(option || '').trim())
    .filter(Boolean);
  const payload = {
    version: 1,
    servicePath: realServicePath,
    port: Number(port),
    environment: String(environment || ''),
    nacosHost: String(nacosHost || ''),
    nacosNamespace: String(nacosNamespace || ''),
    javaOpts: normalizedJavaOpts,
  };
  const digest = crypto.createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex');
  return {
    fingerprint: `sha256:${digest}`,
    fingerprintVersion: payload.version,
    fingerprintSummary: {
      servicePath: realServicePath,
      port: payload.port,
      environment: payload.environment || null,
      nacosHost: redactFingerprintValue(payload.nacosHost) || null,
      nacosNamespace: redactFingerprintValue(payload.nacosNamespace) || null,
      javaOptKeys: normalizedJavaOpts.map(option => parseJvmOptionKey(option)).filter(Boolean),
    },
  };
}

/** 将启动完成状态写回同一 PID/UUID 的元数据，拒绝覆盖新实例记录。 */
export function markPidReady(name, instance, ready = true) {
  const current = readPidInfo(name);
  if (!current || !instance || current.pid !== instance.pid || (instance.uuid && current.uuid !== instance.uuid)) {
    return false;
  }
  current.ready = Boolean(ready);
  current.readyAt = current.ready ? new Date().toISOString() : null;
  writePidInfo(name, current);
  return true;
}

export function checkPort(port) {
  try {
    execSync(`lsof -i :${port} -sTCP:LISTEN`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function findPidsByPort(port) {
  try {
    const output = execSync(`lsof -i :${port} -sTCP:LISTEN -t`, { encoding: 'utf8' });
    return output.trim().split('\n').filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

export function getProcessCommand(pid) {
  try {
    const output = execSync(`ps -ww -p ${pid} -o command=`, { encoding: 'utf8' });
    return output.trim();
  } catch {
    return '';
  }
}

export function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function verifyProcessBelongsToService(pid, pidInfo) {
  if (!pid || !isProcessAlive(pid)) return false;
  const cmd = getProcessCommand(pid);
  if (!cmd) return false;

  if (pidInfo && pidInfo.uuid) {
    const hasUuid = cmd.includes(`-Dbs.javarun.instance=${pidInfo.uuid}`);
    const hasModuleOrWar = (pidInfo.warName && cmd.includes(pidInfo.warName))
      || (pidInfo.serverModule && cmd.includes(pidInfo.serverModule))
      || (pidInfo.serviceName && cmd.includes(pidInfo.serviceName));

    return hasUuid && Boolean(hasModuleOrWar);
  }

  return false;
}

export function inspectServiceProcess(service, { expectedFingerprint = null, expectedEnvironment = null } = {}) {
  const pidInfo = readPidInfo(service.name);
  const pidAlive = Boolean(pidInfo?.pid && isProcessAlive(pidInfo.pid));
  const portPids = findPidsByPort(service.port);
  const processIdentityMatches = pidAlive && verifyProcessBelongsToService(pidInfo.pid, pidInfo);
  const hasUnknownPortOwner = portPids.some(pid => !processIdentityMatches || pid !== pidInfo.pid);
  const running = pidAlive || portPids.length > 0;
  const environmentKnown = !running || (
    processIdentityMatches
    && Boolean(pidInfo.environment)
    && !hasUnknownPortOwner
  );
  const fingerprintMatch = expectedFingerprint
    ? Boolean(pidInfo?.fingerprint && pidInfo.fingerprint === expectedFingerprint)
    : null;
  const environmentMatch = expectedEnvironment
    ? Boolean(pidInfo?.environment && pidInfo.environment === expectedEnvironment)
    : null;
  const ready = Boolean(pidInfo?.ready);
  const reusable = Boolean(
    running
    && pidAlive
    && processIdentityMatches
    && environmentKnown
    && environmentMatch !== false
    && ready
    && portPids.includes(pidInfo.pid)
    && fingerprintMatch === true,
  );

  return {
    running,
    pidInfo,
    pidAlive,
    portPids,
    environment: environmentKnown && pidInfo ? pidInfo.environment || null : null,
    environmentKnown,
    ready,
    fingerprint: pidInfo?.fingerprint || null,
    fingerprintMatch,
    environmentMatch,
    reusable,
  };
}

export async function killProcess(pid, signal = 'SIGTERM') {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

export async function waitPortFree(port, maxWait = 30) {
  let elapsed = 0;
  while (elapsed < maxWait) {
    if (!checkPort(port)) {
      if (elapsed > 0) {
        success(`端口 ${port} 已释放 (${elapsed}s)`);
      }
      return true;
    }
    if (elapsed === 0) {
      info(`等待端口 ${port} 释放 ...`);
    }
    await sleep(1000);
    elapsed++;
  }
  error(`端口 ${port} 在 ${maxWait}s 内未释放`);
  return false;
}

export async function waitProcessExit(pid, maxWait = 30) {
  let elapsed = 0;
  while (elapsed < maxWait) {
    if (!isProcessAlive(pid)) {
      return true;
    }
    await sleep(1000);
    elapsed++;
  }
  return false;
}

export function findServerModule(root, name) {
  const defaultModule = path.join(root, `${name}-server`);
  if (fs.existsSync(defaultModule)) {
    return path.basename(defaultModule);
  }
  const entries = fs.readdirSync(root);
  const serverModule = entries.find(e => e.endsWith('-server') && fs.statSync(path.join(root, e)).isDirectory());
  return serverModule || null;
}

export function resolveWar(root, serverModule) {
  const targetDir = path.join(root, serverModule, 'target');
  if (!fs.existsSync(targetDir)) {
    throw new Error(`target 目录不存在: ${targetDir}`);
  }
  const wars = fs.readdirSync(targetDir).filter(f => f.endsWith('.war'));
  if (wars.length === 0) {
    throw new Error(`未找到 WAR 文件: ${targetDir}/*.war`);
  }
  if (wars.length > 1) {
    throw new Error(`找到多个 WAR 文件: ${wars.join(', ')}`);
  }
  const warName = wars[0];
  const warPath = path.join(targetDir, warName);
  const explodedDir = path.join(targetDir, warName.replace('.war', ''));
  return { warPath, warName, explodedDir, targetDir };
}

export async function buildService(root, { serviceName = path.basename(root), spawnProcess = spawn } = {}) {
  info('打包 (mvn clean package -DskipTests) ...');
  const command = 'mvn -q -DskipTests clean package';
  ensureLogDir();
  const logFile = getBuildLogFile(serviceName);
  const logFd = fs.openSync(logFile, 'w');
  let capturedOutput = Buffer.alloc(0);
  let logWriteError = null;
  let child;

  const writeOutput = (stream, chunk) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    try {
      process[stream].write(buffer);
    } catch {
      // stdout/stderr 写入异常不能从异步 data 事件向外抛出。
    }
    if (!logWriteError) {
      try {
        fs.writeSync(logFd, buffer, 0, buffer.length);
      } catch (writeError) {
        logWriteError = writeError;
        try {
          child?.kill('SIGTERM');
        } catch {
          // 继续等待子进程退出，再返回明确的日志错误。
        }
      }
    }
    if (buffer.length >= MAX_MAVEN_CAPTURE_BYTES) {
      capturedOutput = buffer.subarray(buffer.length - MAX_MAVEN_CAPTURE_BYTES);
    } else if (capturedOutput.length + buffer.length > MAX_MAVEN_CAPTURE_BYTES) {
      const keep = MAX_MAVEN_CAPTURE_BYTES - buffer.length;
      capturedOutput = Buffer.concat([capturedOutput.subarray(capturedOutput.length - keep), buffer]);
    } else {
      capturedOutput = Buffer.concat([capturedOutput, buffer]);
    }
  };

  try {
    child = spawnProcess('mvn', ['-q', '-DskipTests', 'clean', 'package'], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (spawnError) {
    fs.closeSync(logFd);
    try {
      fs.appendFileSync(logFile, `${spawnError.message}\n`, 'utf8');
    } catch {
      // 保留原始启动错误，避免日志不可写覆盖根因。
    }
    const failure = new Error(`无法启动 Maven 构建: ${spawnError.message}\n日志: ${logFile}`);
    failure.logFile = logFile;
    throw failure;
  }

  child.stdout?.on('data', chunk => writeOutput('stdout', chunk));
  child.stderr?.on('data', chunk => writeOutput('stderr', chunk));

  let closeResult;
  try {
    closeResult = await new Promise(resolve => {
      let spawnError = null;
      child.once('error', error => { spawnError = error; });
      child.once('close', (status, signal) => resolve({ status, signal, error: spawnError }));
    });
  } finally {
    fs.closeSync(logFd);
  }

  if (closeResult.error) {
    try {
      fs.appendFileSync(logFile, `${closeResult.error.message}\n`, 'utf8');
    } catch {
      // 保留子进程错误，日志不可写时也不让异常逃出事件回调。
    }
    const failure = new Error(`无法启动 Maven 构建: ${closeResult.error.message}\n日志: ${logFile}`);
    failure.logFile = logFile;
    throw failure;
  }

  if (logWriteError) {
    const failure = new Error(`Maven 构建日志写入失败: ${logWriteError.message}\n日志: ${logFile}`);
    failure.logFile = logFile;
    throw failure;
  }

  if (closeResult.status !== 0) {
    const output = capturedOutput.toString('utf8');
    const failure = classifyMavenFailure(output);
    if (failure.type === 'dependency-resolution') {
      throw new DependencyResolutionError({
        command,
        root,
        status: closeResult.status,
        failure,
        logFile,
      });
    }
    const failureError = new Error(`Maven 构建失败 (exit ${closeResult.status}${closeResult.signal ? `, signal ${closeResult.signal}` : ''}): ${command}\n日志: ${logFile}`);
    failureError.logFile = logFile;
    throw failureError;
  }

  success(`打包完成，构建日志: ${logFile}`);
  return logFile;
}

export class DependencyResolutionError extends Error {
  constructor({ command, root, status, failure, logFile }) {
    super(formatDependencyResolutionMessage({ command, root, status, failure, logFile }));
    this.name = 'DependencyResolutionError';
    this.command = command;
    this.root = root;
    this.status = status;
    this.failure = failure;
    this.logFile = logFile;
  }
}

export function classifyMavenFailure(output = '') {
  const text = String(output || '');
  const dependencyPatterns = [
    /Could not resolve dependencies/i,
    /Could not find artifact/i,
    /Could not transfer artifact/i,
    /Failed to collect dependencies/i,
    /Failed to read artifact descriptor/i,
    /Failure to find .* was cached/i,
    /Non-resolvable parent POM/i,
    /Plugin .* could not be resolved/i,
    /Could not resolve artifact/i,
    /The following artifacts could not be resolved/i,
    /The POM for .* is missing/i,
  ];

  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const summary = findSummaryLine(lines, dependencyPatterns);
  const type = dependencyPatterns.some(pattern => pattern.test(text)) ? 'dependency-resolution' : 'generic';

  return {
    type,
    summary,
    artifacts: type === 'dependency-resolution' ? extractArtifactCoordinates(lines) : [],
    repositories: type === 'dependency-resolution' ? extractRepositoryUrls(text) : [],
  };
}

function findSummaryLine(lines, patterns) {
  return lines.find(line => patterns.some(pattern => pattern.test(line)))
    || lines.find(line => line.includes('[ERROR]'))
    || lines[0]
    || 'Maven build failed';
}

function extractArtifactCoordinates(lines) {
  const coordinates = [];
  const coordinatePattern = /\b[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+(?::[A-Za-z0-9_.-]+){1,4}\b/g;

  for (const line of lines) {
    const lower = line.toLowerCase();
    const artifactLine = lower.includes('artifact')
      || lower.includes('artifacts')
      || lower.includes('failure to find')
      || lower.includes('pom for')
      || lower.includes('non-resolvable parent pom')
      || lower.includes('plugin');

    if (!artifactLine) continue;

    for (const match of line.matchAll(coordinatePattern)) {
      const value = match[0].replace(/[),.;:]+$/, '');
      if (!coordinates.includes(value)) {
        coordinates.push(value);
      }
    }
  }

  return coordinates;
}

function extractRepositoryUrls(text) {
  const urls = [];
  const urlPattern = /https?:\/\/[^\s)]+/g;

  for (const match of String(text || '').matchAll(urlPattern)) {
    const value = match[0].replace(/[),.;]+$/, '');
    if (!urls.includes(value)) {
      urls.push(value);
    }
  }

  return urls;
}

function formatDependencyResolutionMessage({ command, root, status, failure, logFile }) {
  const lines = [
    'Maven 依赖解析失败，已停止当前任务，请人工排查依赖发布、仓库访问或版本坐标问题。',
    `命令: ${command}`,
    `项目: ${root}`,
    `退出码: ${status}`,
    `摘要: ${failure.summary}`,
  ];

  if (failure.artifacts.length > 0) {
    lines.push(`缺失/异常依赖: ${failure.artifacts.join(', ')}`);
  }
  if (failure.repositories.length > 0) {
    lines.push(`仓库线索: ${failure.repositories.join(', ')}`);
  }

  if (logFile) {
    lines.push(`构建日志: ${logFile}`);
  }

  lines.push('不要自行修改 pom.xml、替换 jar、执行临时依赖修复或反复换参数重试。');
  return lines.join('\n');
}

export function resolveJavaExecutable(javaHome) {
  if (!javaHome) return 'java';

  const javaPath = path.join(javaHome, 'bin', 'java');
  try {
    if (!fs.statSync(javaPath).isFile()) throw new Error('不是普通文件');
    fs.accessSync(javaPath, fs.constants.X_OK);
  } catch (cause) {
    throw new Error(`配置的 Java 路径无效或不可执行: ${javaPath} (${cause.message})`);
  }
  return javaPath;
}

export async function startJavaService(name, port, root, options = {}) {
  const config = getConfig();
  const serviceRuntimeConfig = options.runtimeConfig || resolveServiceRuntimeConfig(config, name, options);

  const serverModule = findServerModule(root, name);
  if (!serverModule) {
    throw new Error(`未找到 server 模块目录: ${root}`);
  }

  const { warName, explodedDir, targetDir } = resolveWar(root, serverModule);

  if (!fs.existsSync(explodedDir)) {
    throw new Error(`exploded 目录不存在: ${explodedDir}`);
  }

  const javaBin = options.javaBin || resolveJavaExecutable(options.javaHome || config.javaHome);

  ensureLogDir();
  const logFile = getLogFile(name);

  const outFd = fs.openSync(logFile, 'a+');
  const statBefore = fs.fstatSync(outFd);
  const logCursor = {
    inode: statBefore.ino,
    offset: statBefore.size,
  };

  const instanceUuid = crypto.randomUUID();

  const nacosHost = serviceRuntimeConfig.nacosHost;
  const nacosNamespace = serviceRuntimeConfig.nacosNamespace;
  const fingerprintInfo = createServiceFingerprint({
    servicePath: root,
    port,
    environment: config.activeEnvName,
    nacosHost,
    nacosNamespace,
    javaOpts: serviceRuntimeConfig.javaOpts,
  });

  const nacosHostArg = nacosHost ? `-DNACOS_HOST=${nacosHost}` : '';
  const nacosNsArg = nacosNamespace ? `-DNACOS_NAMESPACE=${nacosNamespace}` : '';

  const loaderPath = `${path.basename(explodedDir)}/WEB-INF/classes/,${path.basename(explodedDir)}/WEB-INF/lib/`;
  const args = [
    '-cp', warName,
    `-Dloader.path=${loaderPath}`,
    `-Dserver.port=${port}`,
    '-Dfile.encoding=UTF-8',
    `-Dbs.javarun.instance=${instanceUuid}`,
  ];
  if (nacosHostArg) args.push(nacosHostArg);
  if (nacosNsArg) args.push(nacosNsArg);

  args.push(...(serviceRuntimeConfig.javaOpts || []));
  args.push('org.springframework.boot.loader.PropertiesLauncher');

  info(`启动 ${name} (端口 ${port}, Java: ${javaBin}) ...`);

  let child;
  try {
    child = (options.spawnProcess || spawn)(javaBin, args, {
      cwd: targetDir,
      detached: true,
      stdio: ['ignore', outFd, outFd],
    });
  } catch (spawnError) {
    fs.closeSync(outFd);
    throw new Error(`启动 Java 进程失败 (${javaBin}): ${spawnError.message}`);
  }

  return new Promise((resolve, reject) => {
    let fdClosed = false;
    const closeOutput = () => {
      if (fdClosed) return;
      fdClosed = true;
      fs.closeSync(outFd);
    };

    child.once('error', spawnError => {
      closeOutput();
      reject(new Error(`启动 Java 进程失败 (${javaBin}): ${spawnError.message}`));
    });

    child.once('spawn', () => {
      if (!child.pid) {
        closeOutput();
        reject(new Error(`Java 进程启动后未返回 PID: ${javaBin}`));
        return;
      }

      const pidInfo = {
        pid: child.pid,
        uuid: instanceUuid,
        serviceName: name,
        servicePath: fingerprintInfo.fingerprintSummary.servicePath,
        port,
        serverModule,
        warName,
        environment: config.activeEnvName || null,
        ready: false,
        fingerprint: fingerprintInfo.fingerprint,
        fingerprintVersion: fingerprintInfo.fingerprintVersion,
        fingerprintSummary: fingerprintInfo.fingerprintSummary,
        startTime: new Date().toISOString(),
      };

      try {
        options.onInstanceStarted?.({
          serviceName: name,
          pid: child.pid,
          uuid: instanceUuid,
          environment: pidInfo.environment,
          serverModule,
          warName,
        });
      } catch {
        // 运行记录回调不应影响已启动进程的管理。
      }

      const persistPidInfo = options.writePidInfo || writePidInfo;
      try {
        persistPidInfo(name, pidInfo);
      } catch (writeError) {
        try {
          child.kill('SIGTERM');
        } catch {
          // PID 元数据无法写入时尽力回收刚创建的实例，避免留下不可追踪的进程。
        }
        closeOutput();
        reject(new Error(`无法保存 ${name} 的 PID 信息，已请求停止新进程: ${writeError.message}`));
        return;
      }

      child.unref();
      closeOutput();
      info(`  PID: ${child.pid}, UUID: ${instanceUuid}, 日志: ${logFile}`);
      resolve({
        pid: child.pid,
        uuid: instanceUuid,
        logCursor,
        fingerprint: fingerprintInfo.fingerprint,
        pidInfo,
      });
    });
  });
}

export function readIncrementalLog(logFile, cursor) {
  if (!fs.existsSync(logFile)) {
    return { incrementalText: '', cursor };
  }

  const stat = fs.statSync(logFile);
  let currentOffset = cursor.offset;
  let currentInode = cursor.inode;

  if (stat.ino !== currentInode || stat.size < currentOffset) {
    currentOffset = 0;
    currentInode = stat.ino;
  }

  if (stat.size <= currentOffset) {
    return { incrementalText: '', cursor: { inode: currentInode, offset: currentOffset } };
  }

  // 单次最多读取 1 MiB，避免高频日志在一次轮询中造成大内存分配。
  const bytesToRead = Math.min(stat.size - currentOffset, MAX_INCREMENTAL_LOG_BYTES);
  const buffer = Buffer.alloc(bytesToRead);
  const fd = fs.openSync(logFile, 'r');
  try {
    fs.readSync(fd, buffer, 0, bytesToRead, currentOffset);
  } finally {
    fs.closeSync(fd);
  }

  const newOffset = currentOffset + bytesToRead;
  const incrementalText = buffer.toString('utf8');

  return {
    incrementalText,
    cursor: { inode: currentInode, offset: newOffset },
  };
}

export function classifyStartupException(text = '') {
  const output = String(text || '').slice(-64 * 1024);
  const conflictPatterns = [
    /(?:ConflictingBeanDefinitionException|BeanDefinitionOverrideException)[^\n]*['"`]([^'"`]+)['"`]/i,
    /NoUniqueBeanDefinitionException[^\n]*type\s*['"`]([^'"`]+)['"`]/i,
    /expected single matching bean but found\s+\d+\s*:\s*([^\n]+)/i,
    /Cannot register bean definition\s*['"`]([^'"`]+)['"`]/i,
    /(?:bean name|bean with name|bean named)\s*['"`]([^'"`]+)['"`]/i,
  ];
  const missingPatterns = [
    /No qualifying bean of type\s*['"`]([^'"`]+)['"`]/i,
    /NoSuchBeanDefinitionException[^\n]*type\s*['"`]([^'"`]+)['"`]/i,
    /UnsatisfiedDependencyException[^\n]*(?:field|parameter|constructor)[^'"`]*['"`]([^'"`]+)['"`]/i,
  ];
  const conflict = /ConflictingBeanDefinitionException|BeanDefinitionOverrideException|NoUniqueBeanDefinitionException|expected single matching bean but found|Cannot register bean definition|Overriding bean definition/i.test(output);
  const missing = !conflict && /NoSuchBeanDefinitionException|No qualifying bean of type|UnsatisfiedDependencyException/i.test(output);
  const category = conflict ? 'bean-conflict' : missing ? 'bean-missing' : null;
  if (!category) return null;

  const patterns = category === 'bean-conflict' ? conflictPatterns : missingPatterns;
  const identifiers = [];
  for (const pattern of patterns) {
    for (const match of output.matchAll(new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`))) {
      const identifier = match[1].trim().slice(0, 120);
      if (identifier && !identifiers.includes(identifier)) identifiers.push(identifier);
      if (identifiers.length >= 8) break;
    }
    if (identifiers.length >= 8) break;
  }

  return { category, identifiers };
}

function reportStartupException(name, text) {
  const diagnostic = classifyStartupException(text);
  if (!diagnostic) return null;
  const label = diagnostic.category === 'bean-conflict' ? 'Bean 定义冲突' : '缺少 Bean';
  const identifiers = diagnostic.identifiers.length > 0
    ? `；标识: ${diagnostic.identifiers.join(', ')}`
    : '';
  error(`${name} 启动异常类别: ${label}${identifiers}`);
  return diagnostic;
}

export async function waitServiceReady(name, port, logCursor, maxWait = 180, diagnostics = {}) {
  const logFile = getLogFile(name);
  const stableAfterReady = 5;
  const fatalPattern = /Application run failed|APPLICATION FAILED TO START|UnsatisfiedDependencyException|Exception encountered during context initialization|BeanCreationException|BeanDefinitionOverrideException|ConflictingBeanDefinitionException|NoSuchBeanDefinitionException|NoUniqueBeanDefinitionException/;
  const expectedPid = Number.isInteger(Number(diagnostics.expectedPid)) ? Number(diagnostics.expectedPid) : null;
  const expectedUuid = diagnostics.expectedUuid ? String(diagnostics.expectedUuid) : null;

  let readyAt = -1;
  let elapsed = 0;
  let cursor = logCursor || { inode: 0, offset: 0 };
  let pendingLine = '';
  let startedSeen = false;
  let fatalMatch = null;
  let recentLines = [];
  let recentChars = 0;

  const recordLine = line => {
    const boundedLine = String(line || '').slice(-MAX_STARTUP_LINE_CHARS);
    recentLines.push(boundedLine);
    recentChars += boundedLine.length;
    while (recentLines.length > 200 || recentChars > 64 * 1024) {
      recentChars -= recentLines.shift().length;
    }
    if (fatalPattern.test(boundedLine)) fatalMatch = boundedLine;
    if (/Started .* in [0-9.]* seconds/.test(boundedLine)) startedSeen = true;
  };

  info(`等待 ${name} 就绪（端口监听 + Spring 容器就绪 + 稳定 ${stableAfterReady}s）...`);

  while (elapsed < maxWait) {
    const pidInfo = readPidInfo(name);
    const { incrementalText, cursor: newCursor } = readIncrementalLog(logFile, cursor);
    cursor = newCursor;
    if (incrementalText) {
      const lines = `${pendingLine}${incrementalText}`.split('\n');
      pendingLine = lines.pop() || '';
      if (pendingLine.length > MAX_STARTUP_LINE_CHARS) {
        pendingLine = pendingLine.slice(-MAX_STARTUP_LINE_CHARS);
      }
      for (const line of lines) recordLine(line);
      // 某些日志写入器在进程退出前不补换行，当前实例仍应能提供 Started 证据。
      if (pendingLine) recordLine(pendingLine);
    }

    if (fatalMatch) {
      error(`${name} 启动失败（日志中检测到致命错误），日志: ${logFile}`);
      const startupDiagnostic = reportStartupException(name, recentLines.join('\n'));
      try {
        diagnostics.onDiagnostic?.({
          type: startupDiagnostic?.category || 'fatal-startup',
          errorCategory: startupDiagnostic?.category || 'process',
          identifiers: startupDiagnostic?.identifiers || [],
          logFile,
        });
      } catch {
        // 诊断回调不应影响服务状态判断。
      }
      return false;
    }

    const instancePidInfo = readPidInfo(name);
    const currentPid = expectedPid || instancePidInfo?.pid;
    const instanceMatches = Boolean(
      instancePidInfo
      && (!expectedPid || instancePidInfo.pid === expectedPid)
      && (!expectedUuid || instancePidInfo.uuid === expectedUuid),
    );
    const pidAlive = Boolean(currentPid && isProcessAlive(currentPid));
    if (expectedPid && !instanceMatches) {
      error(`${name} 就绪检查发现 PID 元数据已被其它实例替换，拒绝复用。`);
      try {
        diagnostics.onDiagnostic?.({ type: 'instance-mismatch', errorCategory: 'process', logFile });
      } catch {
        // 诊断回调不应影响服务状态判断。
      }
      return false;
    }

    if (currentPid && !pidAlive) {
      // 进程退出后继续读取本次增量，避免异常栈因日志分块而漏检。
      if (incrementalText) continue;
      error(`${name} 进程已退出 (PID ${currentPid})，日志: ${logFile}`);
      try {
        diagnostics.onDiagnostic?.({ type: 'process-exited', errorCategory: 'process', logFile });
      } catch {
        // 诊断回调不应影响服务状态判断。
      }
      return false;
    }

    const portOk = checkPort(port);
    const portPids = expectedPid ? findPidsByPort(port) : [];
    const portOwnerOk = !expectedPid || portPids.includes(expectedPid);
    const startedOk = startedSeen;

    if (portOk && portOwnerOk && startedOk && (!expectedPid || (instanceMatches && pidAlive))) {
      if (readyAt < 0) {
        readyAt = elapsed;
        info(`  ${elapsed}s: 端口+Spring 容器就绪，观察 ${stableAfterReady}s 稳定性 ...`);
      } else if (elapsed - readyAt >= stableAfterReady) {
        success(`${name} 已就绪 (端口 ${port}, 总耗时 ${elapsed}s)`);
        return true;
      }
    } else {
      readyAt = -1;
    }

    await sleep(2000);
    elapsed += 2;
    if (elapsed % 10 === 0) {
      info(`  已等待 ${elapsed}s ... (port=${portOk} started=${startedOk})`);
    }
  }

  error(`${name} 启动超时 (${maxWait}s)，请查看日志: ${logFile}`);
  try {
    diagnostics.onDiagnostic?.({ type: 'timeout', errorCategory: 'timeout', logFile });
  } catch {
    // 诊断回调不应影响服务状态判断。
  }
  return false;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
