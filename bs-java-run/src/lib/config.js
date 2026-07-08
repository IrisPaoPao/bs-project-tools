import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const SCRIPT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const JAVARUN_MD = path.resolve(SCRIPT_DIR, '..', '..', 'JAVARUN.md');
const JAVARUN_LOCAL_MD = path.resolve(SCRIPT_DIR, '..', '..', 'JAVARUN.local.md');
const DEFAULT_STARTUP_TIMEOUT_SECONDS = 420;

// 展开 $HOME
function expandPath(p) {
  if (p.startsWith('~')) {
    return path.join(os.homedir(), p.slice(1));
  }
  if (p.startsWith('$HOME')) {
    return path.join(os.homedir(), p.slice(5));
  }
  return p;
}

function stripMarkdownValue(value) {
  return value.trim().replace(/^`|`$/g, '');
}

function readTableValue(content, key) {
  for (const line of content.split(/\r?\n/)) {
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').slice(1, -1).map(stripMarkdownValue);
    if (cells[0] === key) return cells[1] || '';
  }
  return '';
}

function readMergedTableValue(primaryContent, fallbackContent, key) {
  return readTableValue(primaryContent, key) || readTableValue(fallbackContent, key);
}

function readConfigFile(filePath, required = true) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (!required && error.code === 'ENOENT') {
      return '';
    }
    throw new Error(`无法读取 JAVARUN.md: ${filePath} (${error.message})`);
  }
}

export function resolveStartupTimeoutSeconds(value, fallback = DEFAULT_STARTUP_TIMEOUT_SECONDS) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`启动等待超时时间必须是正整数秒: ${value}`);
  }
  return parsed;
}

function parseServices(content) {
  const services = [];
  const lines = content.split(/\r?\n/);
  let inTable = false;

  for (const line of lines) {
    if (line.trim().startsWith('| 服务名')) {
      inTable = true;
      continue;
    }
    if (inTable && line.trim().startsWith('|')) {
      const separator = line.match(/^\|[\-\s]+\|/);
      if (separator) continue;

      const cells = line.split('|').slice(1, -1).map(c => stripMarkdownValue(c));
      const name = cells[0];
      const rawPath = cells[1];
      const port = cells[2];

      if (!name) continue;

      const servicePath = rawPath ? expandPath(rawPath) : '';
      if (!servicePath) continue;

      services.push({ name, path: servicePath, port: port ? parseInt(port, 10) : null });
    } else if (inTable && line.trim() === '') {
      inTable = false;
    }
  }

  return services.filter(s => s.port);
}

function parseJvmOptsBlock(content) {
  const opts = [];
  let inBlock = false;
  for (const line of String(content || '').split(/\r?\n/)) {
    const t = line.trim();
    if (/^```jvm-opts\s*$/.test(t)) { inBlock = true; continue; }
    if (inBlock) {
      if (/^```/.test(t)) { inBlock = false; continue; }
      if (t) opts.push(t);
    }
  }
  return opts;
}

function parseLoginConfig(content, localContent = '') {
  return {
    loginUrl: readMergedTableValue(localContent, content, '登录地址'),
    mainAccount: readMergedTableValue(localContent, content, '主账号'),
    username: readMergedTableValue(localContent, content, '用户名'),
    password: readMergedTableValue(localContent, content, '密码'),
    loginApi: readMergedTableValue(localContent, content, '登录接口').replace(/^[A-Z]+\s+/, ''),
    authorizationFormat: readMergedTableValue(localContent, content, 'Authorization 格式'),
    tokenField: 'response.token',
  };
}

export function loadConfig(env = process.env, options = {}) {
  const configFile = options.configFile || JAVARUN_MD;
  const localConfigFile = options.localConfigFile || path.join(path.dirname(configFile), 'JAVARUN.local.md');
  const content = readConfigFile(configFile);
  const localContent = readConfigFile(localConfigFile, false);

  const lines = content.split(/\r?\n/);
  const localLines = localContent.split(/\r?\n/);
  let javaHome = '';
  let nacosHost = '';
  let nacosNamespace = '';
  let nextIsJava = false;

  for (const line of lines) {
    if (nextIsJava) {
      const jp = line.trim();
      if (jp) {
        javaHome = expandPath(jp);
        nextIsJava = false;
      }
      continue;
    }
    if (/java.*环境地址/.test(line)) {
      nextIsJava = true;
      continue;
    }
    const trimmed = line.trim();
    if (trimmed.startsWith('NACOS_HOST=')) {
      nacosHost = trimmed.slice('NACOS_HOST='.length);
    } else if (trimmed.startsWith('NACOS_NAMESPACE=')) {
      nacosNamespace = trimmed.slice('NACOS_NAMESPACE='.length);
    }
  }

  for (const line of localLines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('NACOS_HOST=')) {
      nacosHost = trimmed.slice('NACOS_HOST='.length);
    } else if (trimmed.startsWith('NACOS_NAMESPACE=')) {
      nacosNamespace = trimmed.slice('NACOS_NAMESPACE='.length);
    }
  }

  const globalJvmOpts = parseJvmOptsBlock(content);
  const localJvmOpts = parseJvmOptsBlock(localContent);

  return {
    services: parseServices(localContent).length > 0 ? parseServices(localContent) : parseServices(content),
    javaHome: env.BS_JAVA_HOME || javaHome,
    nacosHost: env.NACOS_HOST || nacosHost,
    nacosNamespace: env.NACOS_NAMESPACE || nacosNamespace,
    javaOpts: env.JAVA_OPTS ? env.JAVA_OPTS.split(/\s+/).filter(Boolean) : (localJvmOpts.length > 0 ? localJvmOpts : globalJvmOpts),
    startupTimeoutSeconds: resolveStartupTimeoutSeconds(env.BS_STARTUP_TIMEOUT),
    login: parseLoginConfig(content, localContent),
    logDir: env.LOG_DIR || path.resolve(SCRIPT_DIR, '..', '..', 'logs'),
  };
}

export function getConfig() {
  if (!globalThis._bsJavaRunConfig) {
    globalThis._bsJavaRunConfig = loadConfig();
  }
  return globalThis._bsJavaRunConfig;
}

export function findService(name) {
  const config = getConfig();
  return config.services.find(s => s.name === name);
}

export function requireService(name) {
  const service = findService(name);
  if (!service) {
    const available = getConfig().services.map(s => s.name).join(', ');
    throw new Error(`未知服务: ${name}\n可用服务: ${available}`);
  }
  return service;
}

export { JAVARUN_MD, JAVARUN_LOCAL_MD, DEFAULT_STARTUP_TIMEOUT_SECONDS };
