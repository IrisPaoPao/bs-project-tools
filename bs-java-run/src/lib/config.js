import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const SCRIPT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const JAVARUN_MD = path.resolve(SCRIPT_DIR, '..', '..', 'JAVARUN.md');
const JAVARUN_LOCAL_MD = path.resolve(SCRIPT_DIR, '..', '..', 'JAVARUN.local.md');
const DEFAULT_STARTUP_TIMEOUT_SECONDS = 420;

const RESERVED_JVM_KEYS = new Set([
  'server.port',
  'loader.path',
  'file.encoding',
  'bs.javarun.instance',
]);

function expandPath(p) {
  if (!p) return '';
  if (p.startsWith('~')) {
    return path.join(os.homedir(), p.slice(1));
  }
  if (p.startsWith('$HOME')) {
    return path.join(os.homedir(), p.slice(5));
  }
  return p;
}

function stripMarkdownValue(value) {
  return String(value || '').trim().replace(/^`|`$/g, '');
}

function readConfigFile(filePath, required = true) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (!required && error.code === 'ENOENT') {
      return '';
    }
    throw new Error(`无法读取配置文件: ${filePath} (${error.message})`);
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

/**
 * 按 Markdown 二级标题 + 首列单元格精确解析 GFM 表格
 */
function parseMultiColumnTable(content, sectionHeading, headerFirstCell) {
  const rows = [];
  const lines = String(content || '').split(/\r?\n/);
  let inSection = !sectionHeading;
  let inTable = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (sectionHeading && trimmed.startsWith('## ')) {
      if (trimmed.toLowerCase().includes(sectionHeading.toLowerCase())) {
        inSection = true;
        inTable = false;
        continue;
      } else if (inSection) {
        // 遇到下一个二级标题，结束当前 Section 的查找
        break;
      }
    }

    if (!inSection) continue;

    if (!trimmed.startsWith('|')) {
      inTable = false;
      continue;
    }
    const cells = trimmed.split('|').slice(1, -1).map(stripMarkdownValue);
    if (!inTable) {
      if (cells[0] === headerFirstCell) inTable = true;
      continue;
    }
    if (/^[\s-]+$/.test(cells.join(''))) continue;
    rows.push(cells);
  }
  return rows;
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

export function parseJvmOptionKey(option) {
  const str = String(option || '').trim();
  if (!str) return null;

  if (str.startsWith('-D')) {
    const eqIdx = str.indexOf('=');
    return eqIdx > 2 ? str.substring(2, eqIdx) : str.substring(2);
  }
  if (str.startsWith('-Xmx')) return '-Xmx';
  if (str.startsWith('-Xms')) return '-Xms';
  if (str.startsWith('-XX:')) {
    const rest = str.substring(4);
    const eqIdx = rest.indexOf('=');
    if (eqIdx > 0) return `-XX:${rest.substring(0, eqIdx)}`;
    const cleanFlag = rest.replace(/^[+-]/, '');
    return `-XX:${cleanFlag}`;
  }

  return null;
}

export function mergeJvmOptions(...layers) {
  const keyMap = new Map();
  const unkeyed = [];

  for (const layer of layers) {
    if (!Array.isArray(layer)) continue;
    for (const rawOpt of layer) {
      const opt = String(rawOpt || '').trim();
      if (!opt) continue;

      const key = parseJvmOptionKey(opt);
      if (key) {
        if (RESERVED_JVM_KEYS.has(key)) continue;
        keyMap.set(key, opt);
      } else {
        unkeyed.push(opt);
      }
    }
  }

  return [...keyMap.values(), ...unkeyed];
}

function mergeByName(globalList, localList, idKey = 'name') {
  const map = new Map();
  for (const item of globalList) {
    if (item[idKey]) map.set(item[idKey], { ...item });
  }
  for (const item of localList) {
    const id = item[idKey];
    if (!id) continue;
    if (map.has(id)) {
      const merged = { ...map.get(id) };
      for (const [k, v] of Object.entries(item)) {
        if (v !== '' && v !== null && v !== undefined) {
          merged[k] = v;
        }
      }
      map.set(id, merged);
    } else {
      map.set(id, { ...item });
    }
  }
  return [...map.values()];
}

function parseLoginEnvironments(content) {
  const newRows = parseMultiColumnTable(content, '运行环境', '环境别名')
    .map(cells => ({
      name: cells[0],
      nacosHost: cells[1] || '',
      nacosNamespace: cells[2] || '',
      loginUrl: cells[3] || '',
      loginApi: (cells[4] || '').replace(/^[A-Z]+\s+/, ''),
      industryGateway: cells[5] || '',
      feignContextPath: cells[6] || '',
      serverContextPath: cells[7] || '',
      jvmOptsStr: cells[8] || '',
    }))
    .filter(e => e.name);

  // 兼容旧版“运行环境”表：| 运行环境 | Nacos 主机 | Nacos 命名空间 | Feign 上下文 | 服务端上下文 | 行业网关 |
  const legacyRuntimeRows = parseMultiColumnTable(content, '运行环境', '运行环境')
    .map(cells => ({
      name: cells[0],
      nacosHost: cells[1] || '',
      nacosNamespace: cells[2] || '',
      loginUrl: '',
      loginApi: '',
      industryGateway: cells[5] || '',
      feignContextPath: cells[3] || '',
      serverContextPath: cells[4] || '',
      jvmOptsStr: '',
    }))
    .filter(e => e.name);
  const legacyLoginRows = parseMultiColumnTable(content, '登录环境', '别名')
    .map(cells => ({
      name: cells[0],
      nacosHost: '',
      nacosNamespace: '',
      loginUrl: cells[1] || '',
      loginApi: (cells[2] || '').replace(/^[A-Z]+\s+/, ''),
      industryGateway: '',
      feignContextPath: '',
      serverContextPath: '',
      jvmOptsStr: '',
    }))
    .filter(e => e.name);

  return mergeByName(mergeByName(legacyRuntimeRows, legacyLoginRows), newRows);
}

function parseLoginAccounts(content) {
  const newRows = parseMultiColumnTable(content, '账户定义', '账户别名')
    .map(cells => ({
      name: cells[0],
      env: cells[1] || '',
      mainAccount: cells[2] || '',
      username: cells[3] || '',
      password: cells[4] || '',
    }))
    .filter(a => a.name);

  const legacyRows = parseMultiColumnTable(content, '登录账户', '账户名')
    .map(cells => ({
      name: cells[0],
      env: cells[1] || '',
      mainAccount: cells[2] || '',
      username: cells[3] || '',
      password: cells[4] || '',
    }))
    .filter(a => a.name);

  return mergeByName(legacyRows, newRows);
}

function parseServices(content) {
  return parseMultiColumnTable(content, '服务定义', '服务名')
    .map(cells => {
      const name = cells[0];
      const rawPath = cells[1];
      const portStr = cells[2];
      const dependsOnStr = cells[3] || '';
      const nacosHost = cells[4] || '';
      const nacosNamespace = cells[5] || '';
      const jvmOptsStr = cells[6] || '';

      // undefined 表示本地表未填写，应在按名称合并时继承共享配置；[] 才表示最终没有依赖。
      const dependsOn = dependsOnStr ? dependsOnStr.split(',').map(s => s.trim()).filter(Boolean) : undefined;
      const servicePath = rawPath ? expandPath(rawPath) : '';
      const port = portStr ? Number(portStr) : null;

      return {
        name,
        path: servicePath,
        port,
        dependsOn,
        nacosHost,
        nacosNamespace,
        jvmOptsStr,
      };
    })
    .filter(s => s.name);
}

function parseEnvServiceOverrides(content) {
  return parseMultiColumnTable(content, '环境 x 服务 专属覆盖', '环境别名')
    .filter(cells => cells[1] && cells[0] !== '环境别名')
    .map(cells => ({
      envName: cells[0],
      serviceName: cells[1],
      nacosHost: cells[2] || '',
      nacosNamespace: cells[3] || '',
      jvmOptsStr: cells[4] || '',
    }));
}

function validateServicesConfig(services) {
  const nameSet = new Set();
  const portSet = new Set();

  for (const s of services) {
    if (nameSet.has(s.name)) {
      throw new Error(`服务定义中存在重复的服务名: ${s.name}`);
    }
    nameSet.add(s.name);

    if (s.port !== null && s.port !== undefined) {
      if (!Number.isInteger(s.port) || s.port <= 0 || s.port > 65535) {
        throw new Error(`服务 ${s.name} 的端口不合法: ${s.port}`);
      }
      if (portSet.has(s.port)) {
        throw new Error(`端口冲突: 服务 ${s.name} 与其它服务使用了相同的端口 ${s.port}`);
      }
      portSet.add(s.port);
    }
  }

  for (const s of services) {
    for (const dep of s.dependsOn || []) {
      if (dep === s.name) {
        throw new Error(`服务 ${s.name} 存在自依赖`);
      }
      if (!nameSet.has(dep)) {
        throw new Error(`服务 ${s.name} 依赖的服务未在服务定义中找到: ${dep}`);
      }
    }
  }

  const visited = new Map();
  function dfs(name, pathStr) {
    visited.set(name, 1);
    const service = services.find(s => s.name === name);
    if (service) {
      for (const dep of service.dependsOn || []) {
        const state = visited.get(dep) || 0;
        if (state === 1) {
          throw new Error(`服务依赖关系中存在循环依赖 (拓扑环): ${pathStr} -> ${dep}`);
        }
        if (state === 0) {
          dfs(dep, `${pathStr} -> ${dep}`);
        }
      }
    }
    visited.set(name, 2);
  }

  for (const s of services) {
    if ((visited.get(s.name) || 0) === 0) {
      dfs(s.name, s.name);
    }
  }
}

function mergeEnvServiceOverrides(globalList, localList) {
  const map = new Map();
  for (const item of globalList) {
    map.set(`${item.envName}\u0000${item.serviceName}`, { ...item });
  }
  for (const item of localList) {
    const key = `${item.envName}\u0000${item.serviceName}`;
    const base = map.get(key) || {};
    const merged = { ...base };
    for (const [name, value] of Object.entries(item)) {
      if (value !== '' && value !== null && value !== undefined) {
        merged[name] = value;
      }
    }
    map.set(key, merged);
  }
  return [...map.values()];
}

function findJavaHome(content) {
  for (const line of String(content || '').split(/\r?\n/)) {
    const candidate = line.trim();
    if (candidate.startsWith('/') && candidate.includes('Java')) {
      return candidate;
    }
  }
  return '';
}

export function loadConfig(env = process.env, options = {}) {
  const configFile = options.configFile || JAVARUN_MD;
  const localConfigFile = options.localConfigFile || path.join(path.dirname(configFile), 'JAVARUN.local.md');
  const content = readConfigFile(configFile);
  const localContent = readConfigFile(localConfigFile, false);

  const globalRawServices = parseServices(content);
  const localRawServices = parseServices(localContent);

  // 先检查各来源自身的名称/端口重复；依赖关系在合并后再检查，允许本地新增服务依赖共享服务。
  validateServicesConfig(globalRawServices.map(service => ({ ...service, dependsOn: [] })));
  validateServicesConfig(localRawServices.map(service => ({ ...service, dependsOn: [] })));

  const environments = mergeByName(
    parseLoginEnvironments(content),
    parseLoginEnvironments(localContent),
  );
  const accounts = mergeByName(
    parseLoginAccounts(content),
    parseLoginAccounts(localContent),
  );
  const services = mergeByName(
    globalRawServices,
    localRawServices,
  ).map(service => ({ ...service, dependsOn: service.dependsOn || [] }));
  validateServicesConfig(services);

  const envServiceOverrides = mergeEnvServiceOverrides(
    parseEnvServiceOverrides(content),
    parseEnvServiceOverrides(localContent),
  );

  const globalJvmOpts = [
    ...parseJvmOptsBlock(content),
    ...parseJvmOptsBlock(localContent),
  ];

  const envFlag = options.env || env.BS_ENV || '';
  const profileFlag = options.profile || env.BS_JAVARUN_PROFILE || '';

  if (options.env && options.profile && options.env !== options.profile) {
    throw new Error(`参数冲突: --env (${options.env}) 与 --profile (${options.profile}) 指定了不同的值`);
  }
  const selectedEnvName = envFlag || profileFlag || '';

  const activeEnvObj = selectedEnvName
    ? environments.find(e => e.name === selectedEnvName)
    : null;

  if (selectedEnvName && !activeEnvObj) {
    const available = environments.map(e => e.name).join(', ');
    throw new Error(`未知环境: ${selectedEnvName}${available ? `，可用环境: ${available}` : ''}`);
  }

  const javaHome = env.BS_JAVA_HOME || findJavaHome(localContent) || findJavaHome(content);

  const cliJavaOpts = Array.isArray(options.javaOpt)
    ? options.javaOpt
    : options.javaOpt ? [options.javaOpt] : [];

  const osJavaOpts = env.JAVA_OPTS ? env.JAVA_OPTS.split(/\s+/).filter(Boolean) : [];

  return {
    environments,
    accounts,
    services,
    envServiceOverrides,
    activeEnvName: selectedEnvName,
    activeEnv: activeEnvObj,
    javaHome: expandPath(javaHome),
    globalJvmOpts,
    osJavaOpts,
    cliJavaOpts,
    startupTimeoutSeconds: resolveStartupTimeoutSeconds(env.BS_STARTUP_TIMEOUT),
    logDir: env.LOG_DIR || path.resolve(SCRIPT_DIR, '..', '..', 'logs'),
  };
}

export function resolveServiceRuntimeConfig(config, serviceName, runtimeOptions = {}) {
  const service = config.services.find(s => s.name === serviceName);
  if (!service) {
    throw new Error(`未找到服务配置: ${serviceName}`);
  }

  const activeEnv = config.activeEnv || {};
  const override = config.envServiceOverrides.find(
    o => o.envName === config.activeEnvName && o.serviceName === serviceName
  ) || {};

  const finalNacosHost = runtimeOptions.nacosHost || override.nacosHost || service.nacosHost || activeEnv.nacosHost || '';
  const finalNacosNamespace = runtimeOptions.nacosNamespace || override.nacosNamespace || service.nacosNamespace || activeEnv.nacosNamespace || '';

  const envJvmOpts = activeEnv.jvmOptsStr ? activeEnv.jvmOptsStr.split(/\s+/).filter(Boolean) : [];
  if (activeEnv.feignContextPath) {
    envJvmOpts.push(`-Dsaas.feign.context-path=${activeEnv.feignContextPath}`);
  }
  if (activeEnv.serverContextPath) {
    envJvmOpts.push(`-Dserver.servlet.context-path=${activeEnv.serverContextPath}`);
  }

  const serviceJvmOpts = service.jvmOptsStr ? service.jvmOptsStr.split(/\s+/).filter(Boolean) : [];
  const envServiceJvmOpts = override.jvmOptsStr ? override.jvmOptsStr.split(/\s+/).filter(Boolean) : [];

  const finalJavaOpts = mergeJvmOptions(
    config.globalJvmOpts,
    envJvmOpts,
    serviceJvmOpts,
    envServiceJvmOpts,
    config.osJavaOpts,
    Array.isArray(runtimeOptions.javaOpt)
      ? runtimeOptions.javaOpt
      : runtimeOptions.javaOpt ? [runtimeOptions.javaOpt] : config.cliJavaOpts,
  );

  return {
    service,
    nacosHost: finalNacosHost,
    nacosNamespace: finalNacosNamespace,
    javaOpts: finalJavaOpts,
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
