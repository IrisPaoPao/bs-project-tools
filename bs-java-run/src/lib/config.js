import fs from 'fs';
import path from 'path';
import os from 'os';

const SCRIPT_DIR = path.resolve(path.dirname(import.meta.url).replace('file://', ''));
const JAVARUN_MD = path.resolve(SCRIPT_DIR, '..', '..', 'JAVARUN.md');

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

function parseLoginConfig(content) {
  return {
    loginUrl: readTableValue(content, '登录地址'),
    mainAccount: readTableValue(content, '主账号'),
    username: readTableValue(content, '用户名'),
    password: readTableValue(content, '密码'),
    loginApi: readTableValue(content, '登录接口').replace(/^[A-Z]+\s+/, ''),
    authorizationFormat: readTableValue(content, 'Authorization 格式'),
    tokenField: 'response.token',
  };
}

export function loadConfig(env = process.env) {
  let content;
  try {
    content = fs.readFileSync(JAVARUN_MD, 'utf8');
  } catch (error) {
    throw new Error(`无法读取 JAVARUN.md: ${JAVARUN_MD} (${error.message})`);
  }

  const lines = content.split(/\r?\n/);
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

  return {
    services: parseServices(content),
    javaHome: env.BS_JAVA_HOME || javaHome,
    nacosHost: env.NACOS_HOST || nacosHost,
    nacosNamespace: env.NACOS_NAMESPACE || nacosNamespace,
    login: parseLoginConfig(content),
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

export { JAVARUN_MD };
