import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const SCRIPT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const JAVARUN_MD = path.resolve(SCRIPT_DIR, '..', '..', 'JAVARUN.md');
const JAVARUN_LOCAL_MD = path.resolve(SCRIPT_DIR, '..', '..', 'JAVARUN.local.md');
const DEFAULT_STARTUP_TIMEOUT_SECONDS = 420;

/**
 * 工作区配置与运行时本体隔离：传入聚合目录时，配置、日志和 PID 都落在该目录的 .bs-java-run 中。
 */
export function resolveConfigDirectory(env = process.env) {
  const workspace = String(env.BS_JAVARUN_WORKSPACE || '').trim();
  return workspace
    ? path.resolve(workspace, '.bs-java-run')
    : path.dirname(JAVARUN_MD);
}

const RESERVED_JVM_KEYS = new Set([
  'server.port',
  'loader.path',
  'file.encoding',
  'bs.javarun.instance',
]);
const ENV_MANAGED_JVM_KEYS = new Set([
  ...RESERVED_JVM_KEYS,
  'saas.feign.context-path',
  'server.servlet.context-path',
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

/**
 * 解析“JVM 参数组”中的多行参数。每个参数组都必须属于一个明确的运行环境，避免出现无归属的全局参数。
 */
function parseJvmOptionGroups(content) {
  const groups = new Map();
  let inSection = false;
  let currentGroup = '';
  let inBlock = false;

  for (const line of String(content || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('## ')) {
      if (trimmed === '## JVM 参数组') {
        inSection = true;
        currentGroup = '';
        continue;
      }
      if (inSection) break;
    }
    if (!inSection) continue;

    if (trimmed.startsWith('### ')) {
      if (inBlock) {
        throw new Error('JVM 参数组代码块未闭合');
      }
      currentGroup = trimmed.substring(4).trim();
      if (!currentGroup) {
        throw new Error('JVM 参数组名称不能为空');
      }
      if (groups.has(currentGroup)) {
        throw new Error(`JVM 参数组重复: ${currentGroup}`);
      }
      groups.set(currentGroup, []);
      continue;
    }

    if (/^```jvm-env-opts\s*$/.test(trimmed)) {
      if (!currentGroup) {
        throw new Error('JVM 参数组代码块必须位于三级标题之后');
      }
      inBlock = true;
      continue;
    }
    if (inBlock && /^```/.test(trimmed)) {
      inBlock = false;
      continue;
    }
    if (inBlock && trimmed) {
      groups.get(currentGroup).push(trimmed);
    }
  }

  if (inBlock) {
    throw new Error('JVM 参数组代码块未闭合');
  }
  return groups;
}

function assertNoLegacyConfiguration(content) {
  for (const line of String(content || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (/^```jvm-opts\s*$/.test(trimmed) || trimmed === '## JVM 参数') {
      throw new Error('不再支持全局 JVM 参数，请迁移到 ## JVM 参数组');
    }
    if (trimmed === '## 环境 x 服务 专属覆盖') {
      throw new Error('不再支持“环境 x 服务 专属覆盖”，请迁移到 ## 环境服务');
    }
    if (trimmed === '## 登录环境' || trimmed === '## 登录账户' || trimmed.startsWith('| 环境别名 |')) {
      throw new Error('不再支持旧环境配置，请使用 ## 运行环境 中的“环境名”表');
    }
  }
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
  return parseMultiColumnTable(content, '运行环境', '环境名')
    .map(cells => ({
      name: cells[0],
      nacosHost: cells[1] || '',
      nacosNamespace: cells[2] || '',
      loginUrl: cells[3] || '',
      loginApi: (cells[4] || '').replace(/^[A-Z]+\s+/, ''),
      industryGateway: cells[5] || '',
      feignContextPath: cells[6] || '',
      serverContextPath: cells[7] || '',
    }))
    .filter(e => e.name);
}

function parseLoginAccounts(content) {
  return parseMultiColumnTable(content, '账户定义', '账户别名')
    .map(cells => ({
      name: cells[0],
      env: cells[1] || '',
      mainAccount: cells[2] || '',
      username: cells[3] || '',
      password: cells[4] || '',
    }))
    .filter(a => a.name);
}

function parseServices(content) {
  return parseMultiColumnTable(content, '服务定义', '服务名')
    .map(cells => {
      const name = cells[0];
      const rawPath = cells[1];
      const portStr = cells[2];
      const dependsOnStr = cells[3] || '';
      if (cells.length > 4) {
        throw new Error('服务定义只支持“服务名、路径、端口、依赖服务”，请将 Nacos/JVM 参数迁移到环境配置');
      }

      // undefined 表示本地表未填写，应在按名称合并时继承共享配置；[] 才表示最终没有依赖。
      const dependsOn = dependsOnStr ? dependsOnStr.split(',').map(s => s.trim()).filter(Boolean) : undefined;
      const servicePath = rawPath ? expandPath(rawPath) : '';
      const port = portStr ? Number(portStr) : null;

      return {
        name,
        path: servicePath,
        port,
        dependsOn,
      };
    })
    .filter(s => s.name);
}

function parseEnvironmentServices(content) {
  return parseMultiColumnTable(content, '环境服务', '环境名')
    .filter(cells => cells[1] && cells[0] !== '环境名')
    .map(cells => ({
      envName: cells[0],
      serviceName: cells[1],
      jvmOptsStr: cells[2] || '',
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

function mergeEnvironmentServices(globalList, localList) {
  const map = new Map();
  for (const item of globalList) {
    map.set(`${item.envName}\u0000${item.serviceName}`, { ...item });
  }
  for (const item of localList) {
    const key = `${item.envName}\u0000${item.serviceName}`;
    const base = map.get(key) || { jvmOptsStr: '' };
    const merged = {
      ...base,
      envName: item.envName,
      serviceName: item.serviceName,
    };
    // 空字符串是环境服务未设置专属参数的合法状态，不能在合并时丢失该字段。
    if (item.jvmOptsStr !== '' || !Object.hasOwn(merged, 'jvmOptsStr')) {
      merged.jvmOptsStr = item.jvmOptsStr;
    }
    map.set(key, merged);
  }
  return [...map.values()];
}

function mergeJvmOptionGroups(globalGroups, localGroups) {
  const groups = new Map();
  for (const [name, options] of globalGroups) {
    groups.set(name, [...options]);
  }
  for (const [name, options] of localGroups) {
    groups.set(name, [...(groups.get(name) || []), ...options]);
  }
  return groups;
}

function validatePersistentJvmOptions(options, scope) {
  const keys = new Set();
  for (const option of options) {
    const key = parseJvmOptionKey(option);
    if (!key) continue;
    if (ENV_MANAGED_JVM_KEYS.has(key)) {
      throw new Error(`${scope} 不允许配置 ${key}，该参数由运行环境或工具统一管理`);
    }
    if (keys.has(key)) {
      throw new Error(`${scope} 中存在重复 JVM 参数: ${key}`);
    }
    keys.add(key);
  }
}

function validateEnvironmentConfiguration(environments, accounts, services, environmentServices, jvmOptionGroups) {
  const environmentNames = new Set(environments.map(environment => environment.name));
  const serviceNames = new Set(services.map(service => service.name));
  const environmentServiceNames = new Set();
  const enabledServicesByEnvironment = new Map();

  for (const account of accounts) {
    if (account.env && !environmentNames.has(account.env)) {
      throw new Error(`账户 ${account.name} 引用了未配置环境: ${account.env}`);
    }
  }

  for (const [name, options] of jvmOptionGroups) {
    if (!environmentNames.has(name)) {
      throw new Error(`JVM 参数组 ${name} 未对应已配置的运行环境`);
    }
    validatePersistentJvmOptions(options, `JVM 参数组 ${name}`);
  }

  for (const environmentService of environmentServices) {
    const key = `${environmentService.envName}\u0000${environmentService.serviceName}`;
    if (environmentServiceNames.has(key)) {
      throw new Error(`环境服务配置重复: ${environmentService.envName} / ${environmentService.serviceName}`);
    }
    environmentServiceNames.add(key);
    if (!environmentNames.has(environmentService.envName)) {
      throw new Error(`环境服务引用了未配置环境: ${environmentService.envName}`);
    }
    if (!serviceNames.has(environmentService.serviceName)) {
      throw new Error(`环境服务引用了未配置服务: ${environmentService.serviceName}`);
    }
    const enabledServices = enabledServicesByEnvironment.get(environmentService.envName) || new Set();
    enabledServices.add(environmentService.serviceName);
    enabledServicesByEnvironment.set(environmentService.envName, enabledServices);
    const options = environmentService.jvmOptsStr.split(/\s+/).filter(Boolean);
    validatePersistentJvmOptions(options, `环境服务 ${environmentService.envName} / ${environmentService.serviceName}`);
  }

  for (const [environmentName, enabledServices] of enabledServicesByEnvironment) {
    for (const serviceName of enabledServices) {
      const service = services.find(item => item.name === serviceName);
      for (const dependency of service.dependsOn || []) {
        if (!enabledServices.has(dependency)) {
          throw new Error(`环境 ${environmentName} 启用了 ${serviceName}，但未启用其依赖服务 ${dependency}`);
        }
      }
    }
  }
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
  const configDirectory = options.configDirectory || resolveConfigDirectory(env);
  const configFile = options.configFile || path.join(configDirectory, 'JAVARUN.md');
  const localConfigFile = options.localConfigFile || path.join(path.dirname(configFile), 'JAVARUN.local.md');
  const content = readConfigFile(configFile);
  const localContent = readConfigFile(localConfigFile, false);
  assertNoLegacyConfiguration(content);
  assertNoLegacyConfiguration(localContent);

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

  const environmentServices = mergeEnvironmentServices(
    parseEnvironmentServices(content),
    parseEnvironmentServices(localContent),
  );
  const jvmOptionGroups = mergeJvmOptionGroups(
    parseJvmOptionGroups(content),
    parseJvmOptionGroups(localContent),
  );
  validateEnvironmentConfiguration(environments, accounts, services, environmentServices, jvmOptionGroups);

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
    environmentServices,
    activeEnvName: selectedEnvName,
    activeEnv: activeEnvObj,
    javaHome: expandPath(javaHome),
    jvmOptionGroups,
    osJavaOpts,
    cliJavaOpts,
    startupTimeoutSeconds: resolveStartupTimeoutSeconds(env.BS_STARTUP_TIMEOUT),
    logDir: env.LOG_DIR || path.join(path.dirname(configFile), 'logs'),
    configDirectory: path.dirname(configFile),
  };
}

export function resolveServiceRuntimeConfig(config, serviceName, runtimeOptions = {}) {
  const service = config.services.find(s => s.name === serviceName);
  if (!service) {
    throw new Error(`未找到服务配置: ${serviceName}`);
  }

  const activeEnv = config.activeEnv || {};
  const environmentService = config.environmentServices.find(
    o => o.envName === config.activeEnvName && o.serviceName === serviceName
  ) || {};

  const finalNacosHost = runtimeOptions.nacosHost || activeEnv.nacosHost || '';
  const finalNacosNamespace = runtimeOptions.nacosNamespace || activeEnv.nacosNamespace || '';

  const environmentJvmOpts = config.jvmOptionGroups.get(activeEnv.name) || [];
  const contextJvmOpts = [];
  if (activeEnv.feignContextPath) {
    contextJvmOpts.push(`-Dsaas.feign.context-path=${activeEnv.feignContextPath}`);
  }
  if (activeEnv.serverContextPath) {
    contextJvmOpts.push(`-Dserver.servlet.context-path=${activeEnv.serverContextPath}`);
  }

  const environmentServiceJvmOpts = environmentService.jvmOptsStr ? environmentService.jvmOptsStr.split(/\s+/).filter(Boolean) : [];

  const finalJavaOpts = mergeJvmOptions(
    environmentJvmOpts,
    contextJvmOpts,
    environmentServiceJvmOpts,
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

export function getActiveEnvironmentServices(config) {
  if (!config.activeEnvName || !config.activeEnv) {
    throw new Error('启动、重启和 up 命令必须通过 --env 或 BS_ENV 指定运行环境');
  }
  const enabledNames = new Set(
    config.environmentServices
      .filter(item => item.envName === config.activeEnvName)
      .map(item => item.serviceName),
  );
  return config.services.filter(service => enabledNames.has(service.name));
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
