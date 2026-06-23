import { execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { getConfig } from './config.js';
import { info, success, error } from './logger.js';

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

export function writePidFile(name, pid) {
  const pidFile = getPidFile(name);
  fs.writeFileSync(pidFile, String(pid));
}

export function readPidFile(name) {
  const pidFile = getPidFile(name);
  if (!fs.existsSync(pidFile)) return null;
  const pid = fs.readFileSync(pidFile, 'utf8').trim();
  return pid ? parseInt(pid, 10) : null;
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

export function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function killProcess(pid, signal = 'SIGTERM') {
  try {
    process.kill(pid, signal);
  } catch (e) {
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
  // 兜底：找第一个 *-server 目录
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
  execSync('mvn -q -DskipTests clean package', { cwd: root, stdio: 'inherit' });
  success('打包完成');
}

export function startJavaService(name, port, root, options = {}) {
  const { nacosHost, nacosNamespace, javaHome } = options;
  const config = getConfig();

  const serverModule = findServerModule(root, name);
  if (!serverModule) {
    throw new Error(`未找到 server 模块目录: ${root}`);
  }

  const { warName, explodedDir, targetDir } = resolveWar(root, serverModule);

  if (!fs.existsSync(explodedDir)) {
    throw new Error(`exploded 目录不存在: ${explodedDir}`);
  }

  let javaBin = 'java';
  if (javaHome || config.javaHome) {
    const javaPath = path.join(javaHome || config.javaHome, 'bin', 'java');
    if (fs.existsSync(javaPath)) {
      javaBin = javaPath;
    }
  }

  const logFile = getLogFile(name);
  const pidFile = getPidFile(name);

  const commonJvmArgs = '-Dsaas.feign.context-path=';
  const nacosHostArg = nacosHost || config.nacosHost ? `-DNACOS_HOST=${nacosHost || config.nacosHost}` : '';
  const nacosNsArg = nacosNamespace || config.nacosNamespace ? `-DNACOS_NAMESPACE=${nacosNamespace || config.nacosNamespace}` : '';

  const loaderPath = `${path.basename(explodedDir)}/WEB-INF/classes/,${path.basename(explodedDir)}/WEB-INF/lib/`;
  const args = [
    '-cp', warName,
    `-Dloader.path=${loaderPath}`,
    `-Dserver.port=${port}`,
    '-Dfile.encoding=UTF-8',
  ];
  if (nacosHostArg) args.push(nacosHostArg);
  if (nacosNsArg) args.push(nacosNsArg);
  args.push(commonJvmArgs);
  args.push('org.springframework.boot.loader.PropertiesLauncher');

  info(`启动 ${name} (端口 ${port}, Java: ${javaBin}) ...`);

  const out = fs.openSync(logFile, 'a');
  const err = fs.openSync(logFile, 'a');

  const child = spawn(javaBin, args, {
    cwd: targetDir,
    detached: true,
    stdio: ['ignore', out, err],
  });

  child.unref();
  fs.closeSync(out);
  fs.closeSync(err);

  writePidFile(name, child.pid);
  info(`  PID: ${child.pid}, 日志: ${logFile}`);

  return child.pid;
}

export async function waitServiceReady(name, port, maxWait = 180) {
  const logFile = getLogFile(name);
  const pidFile = getPidFile(name);
  const stableAfterReady = 5;
  const fatalPattern = /Application run failed|APPLICATION FAILED TO START|UnsatisfiedDependencyException|Exception encountered during context initialization|BeanCreationException/;

  let readyAt = -1;
  let elapsed = 0;

  info(`等待 ${name} 就绪（端口监听 + Spring 容器就绪 + 稳定 ${stableAfterReady}s）...`);

  while (elapsed < maxWait) {
    const pid = readPidFile(name);
    if (pid && !isProcessAlive(pid)) {
      error(`${name} 进程已退出 (PID ${pid})，最近日志:`);
      if (fs.existsSync(logFile)) {
        const lines = fs.readFileSync(logFile, 'utf8').split('\n');
        const recent = lines.slice(-30).join('\n');
        console.log(recent.split('\n').map(l => '    ' + l).join('\n'));
      }
      return false;
    }

    // 检查致命错误
    if (fs.existsSync(logFile)) {
      const recentLogs = tailLog(name, 400);
      const lines = recentLogs.split('\n');
      const fatal = lines.find(line => fatalPattern.test(line));
      if (fatal) {
        error(`${name} 启动失败（日志中检测到致命错误）:`);
        console.log(`    ${fatal}`);
        return false;
      }
    }

    const portOk = checkPort(port);
    let startedOk = false;
    if (fs.existsSync(logFile)) {
      const recentLogs = tailLog(name, 400);
      const lines = recentLogs.split('\n');
      startedOk = lines.some(line => /Started .* in [0-9.]* seconds/.test(line));
    }

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

export function tailLog(name, lines = 20) {
  const logFile = getLogFile(name);
  if (!fs.existsSync(logFile)) return '';
  const content = fs.readFileSync(logFile, 'utf8');
  const allLines = content.split('\n');
  return allLines.slice(-lines).join('\n');
}
