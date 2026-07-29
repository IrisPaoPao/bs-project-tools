import { execSync, spawn, spawnSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { getConfig, resolveServiceRuntimeConfig } from './config.js';
import { info, success, error } from './logger.js';

const MAX_INCREMENTAL_LOG_BYTES = 1024 * 1024;

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

export function writePidInfo(name, infoObj) {
  const pidFile = getPidFile(name);
  fs.writeFileSync(pidFile, JSON.stringify(infoObj, null, 2), 'utf8');
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

export async function killProcess(pid, signal = 'SIGTERM') {
  try {
    process.kill(pid, signal);
  } catch {
    // ignore
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

export function buildService(root) {
  info(`打包 (mvn clean package -DskipTests) ...`);
  const command = 'mvn -q -DskipTests clean package';
  const result = spawnSync('mvn', ['-q', '-DskipTests', 'clean', 'package'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 100 * 1024 * 1024,
  });

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
    const failure = classifyMavenFailure(output);
    if (failure.type === 'dependency-resolution') {
      throw new DependencyResolutionError({
        command,
        root,
        status: result.status,
        failure,
      });
    }
    throw new Error(`Maven 构建失败 (exit ${result.status}): ${command}`);
  }

  success('打包完成');
}

export class DependencyResolutionError extends Error {
  constructor({ command, root, status, failure }) {
    super(formatDependencyResolutionMessage({ command, root, status, failure }));
    this.name = 'DependencyResolutionError';
    this.command = command;
    this.root = root;
    this.status = status;
    this.failure = failure;
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

function formatDependencyResolutionMessage({ command, root, status, failure }) {
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

  lines.push('不要自行修改 pom.xml、替换 jar、执行临时依赖修复或反复换参数重试。');
  return lines.join('\n');
}

export function startJavaService(name, port, root, options = {}) {
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

  let javaBin = 'java';
  if (options.javaHome || config.javaHome) {
    const javaPath = path.join(options.javaHome || config.javaHome, 'bin', 'java');
    if (fs.existsSync(javaPath)) {
      javaBin = javaPath;
    }
  }

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

  const child = spawn(javaBin, args, {
    cwd: targetDir,
    detached: true,
    stdio: ['ignore', outFd, outFd],
  });

  child.unref();
  fs.closeSync(outFd);

  const pidInfo = {
    pid: child.pid,
    uuid: instanceUuid,
    serviceName: name,
    serverModule,
    warName,
    startTime: new Date().toISOString(),
  };

  writePidInfo(name, pidInfo);
  info(`  PID: ${child.pid}, UUID: ${instanceUuid}, 日志: ${logFile}`);

  return { pid: child.pid, uuid: instanceUuid, logCursor };
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

export async function waitServiceReady(name, port, logCursor, maxWait = 180) {
  const logFile = getLogFile(name);
  const stableAfterReady = 5;
  const fatalPattern = /Application run failed|APPLICATION FAILED TO START|UnsatisfiedDependencyException|Exception encountered during context initialization|BeanCreationException/;

  let readyAt = -1;
  let elapsed = 0;
  let cursor = logCursor || { inode: 0, offset: 0 };
  let pendingLine = '';
  let startedSeen = false;
  let fatalMatch = null;

  info(`等待 ${name} 就绪（端口监听 + Spring 容器就绪 + 稳定 ${stableAfterReady}s）...`);

  while (elapsed < maxWait) {
    const pidInfo = readPidInfo(name);
    if (pidInfo && pidInfo.pid && !isProcessAlive(pidInfo.pid)) {
      error(`${name} 进程已退出 (PID ${pidInfo.pid})，最近日志:`);
      if (fs.existsSync(logFile)) {
        const lines = fs.readFileSync(logFile, 'utf8').split('\n');
        const recent = lines.slice(-30).join('\n');
        console.log(recent.split('\n').map(l => '    ' + l).join('\n'));
      }
      return false;
    }

    const { incrementalText, cursor: newCursor } = readIncrementalLog(logFile, cursor);
    cursor = newCursor;
    if (incrementalText) {
      const lines = `${pendingLine}${incrementalText}`.split('\n');
      pendingLine = lines.pop() || '';
      for (const line of lines) {
        if (fatalPattern.test(line)) fatalMatch = line;
        if (/Started .* in [0-9.]* seconds/.test(line)) startedSeen = true;
      }
    }

    if (fatalMatch) {
      error(`${name} 启动失败（日志中检测到致命错误）:`);
      console.log(`    ${fatalMatch}`);
      return false;
    }

    const portOk = checkPort(port);
    const startedOk = startedSeen;

    if (portOk && startedOk) {
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
  return false;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
