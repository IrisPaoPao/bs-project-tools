import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { createInterface } from 'node:readline/promises';
import { parseAllDocuments } from 'yaml';

import { loadConfig, resolveConfigDirectory } from '../lib/config.js';
import { checkPort, findServerModule, resolveWar } from '../lib/process-manager.js';
import { selectServices } from '../lib/service-selector.js';
import { error } from '../lib/logger.js';
import { start } from './start.js';
import { stop } from './stop.js';

const WORKSPACE_DIR_NAME = '.bs-java-run';
const MANIFEST_NAME = 'workspace-manifest.json';
const MANAGED_CONFIG_NAME = 'JAVARUN.md';
const LOCAL_CONFIG_NAME = 'JAVARUN.local.md';
const CLI_ENTRY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../bin/bs-java-run.js');

/** 将聚合目录映射为固定的工作区配置、清单和快捷脚本路径。 */
function workspacePaths(directory) {
  const root = path.resolve(directory);
  const configDir = path.join(root, WORKSPACE_DIR_NAME);
  return {
    root,
    configDir,
    configFile: path.join(configDir, MANAGED_CONFIG_NAME),
    localFile: path.join(configDir, LOCAL_CONFIG_NAME),
    manifestFile: path.join(configDir, MANIFEST_NAME),
    wrapperFile: path.join(root, 'javarun'),
  };
}

function escapeCell(value) {
  return String(value ?? '').replace(/\\/g, '\\\\').replace(/\|/g, '\\|').trim();
}

function table(headers, rows) {
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map(row => `| ${row.map(escapeCell).join(' | ')} |`),
  ].join('\n');
}

function isConfiguredHomePath(value) {
  return value.startsWith('/') || value === '~' || value.startsWith('~/') || value === '$HOME' || value.startsWith('$HOME/');
}

/** 读取必填交互项，避免生成一个无法连接 Nacos 或登录的空环境。 */
async function askQuestion(prompt, { required = false, defaultValue = '' } = {}, readline) {
  while (true) {
    const suffix = defaultValue ? ` [${defaultValue}]` : '';
    const answer = (await readline.question(`${prompt}${suffix}: `)).trim();
    const value = answer || defaultValue;
    if (value || !required) return value;
    console.log('此项不能为空，请重新输入。');
  }
}

/** 密码只通过 TTY 无回显读取，避免打印到终端或普通日志。 */
async function askSecret(prompt) {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
    throw new Error('初始化需要交互式终端，以便安全录入可用用户的密码');
  }
  process.stdout.write(`${prompt}: `);
  return new Promise((resolve, reject) => {
    let value = '';
    const input = process.stdin;
    const restore = () => {
      input.removeListener('data', onData);
      input.setRawMode(false);
      // 外层 readline 仍需继续读取后续问题，不能在密码录入后暂停标准输入。
    };
    const onData = data => {
      for (const char of data.toString('utf8')) {
        if (char === '\r' || char === '\n') {
          restore();
          process.stdout.write('\n');
          resolve(value);
          return;
        }
        if (char === '\u0003') {
          restore();
          reject(new Error('用户取消了密码输入'));
          return;
        }
        if (char === '\u007f' || char === '\b') {
          value = value.slice(0, -1);
          continue;
        }
        value += char;
      }
    };
    input.setRawMode(true);
    input.resume();
    input.on('data', onData);
  });
}

function validateSetup(setup) {
  const environments = Array.isArray(setup?.environments) ? setup.environments : [];
  const accounts = Array.isArray(setup?.accounts) ? setup.accounts : [];
  if (environments.length === 0) throw new Error('至少需要配置一个运行环境');
  const environmentNames = new Set();
  for (const environment of environments) {
    for (const field of ['name', 'nacosHost', 'loginUrl', 'loginApi']) {
      if (!String(environment[field] || '').trim()) {
        throw new Error(`运行环境缺少必填项: ${field}`);
      }
    }
    if (environmentNames.has(environment.name)) throw new Error(`运行环境重复: ${environment.name}`);
    environmentNames.add(environment.name);
  }
  const accountNames = new Set();
  for (const account of accounts) {
    for (const field of ['name', 'env', 'username', 'password']) {
      if (!String(account[field] || '').trim()) throw new Error(`可用用户缺少必填项: ${field}`);
    }
    if (!environmentNames.has(account.env)) throw new Error(`可用用户引用了未知环境: ${account.env}`);
    if (accountNames.has(account.name)) throw new Error(`可用用户别名重复: ${account.name}`);
    accountNames.add(account.name);
  }
  const javaHome = String(setup.javaHome || '').trim();
  if (javaHome && !isConfiguredHomePath(javaHome)) {
    throw new Error(`JDK 根目录必须是绝对路径、~ 路径或 $HOME 路径: ${javaHome}`);
  }
  return {
    javaHome,
    environments: environments.map(environment => ({ ...environment })),
    accounts: accounts.map(account => ({ ...account })),
  };
}

function cloneSetup(setup) {
  return {
    javaHome: setup.javaHome,
    environments: setup.environments.map(environment => ({ ...environment })),
    accounts: setup.accounts.map(account => ({ ...account })),
  };
}

function printExistingEnvironments(config) {
  const names = config.environments.map(environment => environment.name);
  console.log(`当前已有环境: ${names.length ? names.join('、') : '无'}`);
}

async function promptEnvironment(defaults, readline) {
  const name = defaults?.name || await askQuestion('运行环境名', { required: true }, readline);
  const nacosHost = await askQuestion('Nacos 主机（host:port）', { required: true, defaultValue: defaults?.nacosHost }, readline);
  const nacosNamespace = await askQuestion('Nacos 命名空间', { defaultValue: defaults?.nacosNamespace }, readline);
  const loginUrl = await askQuestion('登录页面地址', { required: true, defaultValue: defaults?.loginUrl }, readline);
  const loginApi = await askQuestion('登录接口（例如 POST /saas/login）', { required: true, defaultValue: defaults?.loginApi }, readline);
  const industryGateway = await askQuestion('行业网关地址', { defaultValue: defaults?.industryGateway }, readline);
  const feignContextPath = await askQuestion('Feign 上下文（可留空）', { defaultValue: defaults?.feignContextPath }, readline);
  const serverContextPath = await askQuestion('服务端上下文（可留空）', { defaultValue: defaults?.serverContextPath }, readline);
  return {
    name,
    nacosHost,
    nacosNamespace,
    loginUrl,
    loginApi: loginApi.replace(/^[A-Z]+\s+/, ''),
    industryGateway,
    feignContextPath,
    serverContextPath,
  };
}

async function promptAccountsForEnvironment(environmentName, accounts, readline) {
  const configureAccount = /^(y|yes|是)$/i.test(await askQuestion(
    '账户配置：添加账户？（输入 y 添加，直接回车跳过账户配置）',
    { defaultValue: 'n' },
    readline,
  ));
  if (!configureAccount) return;

  let addAccount = true;
  while (addAccount) {
    const accountName = await askQuestion('可用用户别名', { required: true, defaultValue: `${environmentName}-account` }, readline);
    const mainAccount = await askQuestion('主账号（可留空）', {}, readline);
    const username = await askQuestion('用户名', { required: true }, readline);
    const password = await askSecret('密码（无回显）');
    if (!password) {
      console.log('密码不能为空，请重新录入该用户。');
      continue;
    }
    const index = accounts.findIndex(account => account.name === accountName);
    const account = { name: accountName, env: environmentName, mainAccount, username, password };
    if (index >= 0) accounts[index] = account;
    else accounts.push(account);
    addAccount = /^(y|yes|是)$/i.test(await askQuestion('继续添加该环境的用户？(Y/n)', { defaultValue: 'n' }, readline));
  }
}

/**
 * 配置工作区时仅收集用户本次操作的环境；默认合并由调用方完成，避免录入一个新环境时丢失其它环境。
 * replaceAll 模式以当前配置为草稿，用户可显式删除不再保留的环境和关联账户。
 */
async function promptWorkspaceSetup(defaultJavaHome, currentConfig = null, { replaceAll = false } = {}) {
  if (!process.stdin.isTTY) {
    throw new Error('工作区配置需要交互式终端录入运行环境、Nacos 和可用用户；请在终端中执行');
  }
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    if (currentConfig) printExistingEnvironments(currentConfig);
    console.log('\n请选择：新增环境、编辑已有环境、删除环境、完成。账户可在每次环境录入后跳过，登录时再补充。');
    const javaHome = await askQuestion('JDK 根目录', { defaultValue: defaultJavaHome }, readline);
    const draft = replaceAll && currentConfig
      ? cloneSetup({ javaHome, environments: currentConfig.environments, accounts: currentConfig.accounts })
      : { javaHome, environments: [], accounts: [] };
    while (true) {
      const action = await askQuestion('操作（新增/编辑/删除/完成）', { required: true, defaultValue: '完成' }, readline);
      if (action === '完成') break;
      if (action === '新增') {
        const environment = await promptEnvironment(null, readline);
        if (draft.environments.some(item => item.name === environment.name)) {
          console.log(`环境已存在，请使用“编辑”：${environment.name}`);
          continue;
        }
        draft.environments.push(environment);
        await promptAccountsForEnvironment(environment.name, draft.accounts, readline);
        continue;
      }
      if (action === '编辑') {
        const name = await askQuestion('要编辑的环境名', { required: true }, readline);
        const existing = (replaceAll ? draft.environments : currentConfig?.environments || []).find(item => item.name === name);
        if (!existing) {
          console.log(`未找到环境: ${name}`);
          continue;
        }
        const environment = await promptEnvironment(existing, readline);
        const index = draft.environments.findIndex(item => item.name === name);
        if (index >= 0) draft.environments[index] = environment;
        else draft.environments.push(environment);
        await promptAccountsForEnvironment(environment.name, draft.accounts, readline);
        continue;
      }
      if (action === '删除') {
        if (!replaceAll) {
          console.log('默认合并更新不会删除环境；如需删除请使用 --replace-all。');
          continue;
        }
        const name = await askQuestion('要删除的环境名', { required: true }, readline);
        const before = draft.environments.length;
        draft.environments = draft.environments.filter(environment => environment.name !== name);
        if (draft.environments.length === before) {
          console.log(`未找到环境: ${name}`);
          continue;
        }
        draft.accounts = draft.accounts.filter(account => account.env !== name);
        console.log(`已标记删除环境及其账户: ${name}`);
        continue;
      }
      console.log('请输入：新增、编辑、删除 或 完成。');
    }
    return validateSetup(draft);
  } finally {
    readline.close();
  }
}

function isWithin(root, candidate) {
  const relative = path.relative(root, path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

/** 仅保留拥有可识别 server 模块的直接 Maven 子项目，避免把 SDK/前端当成可启动服务。 */
function findProjectCandidates(root) {
  return fs.readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
    .map(entry => path.join(root, entry.name))
    .filter(projectRoot => fs.existsSync(path.join(projectRoot, 'pom.xml')))
    .filter(projectRoot => {
      const name = path.basename(projectRoot);
      if (name.endsWith('-sdk') || name.includes('frontend')) return false;
      return findServerModule(projectRoot, name) !== null;
    });
}

function readDeclaredPort(projectRoot) {
  const candidates = [];
  const serverModule = findServerModule(projectRoot, path.basename(projectRoot));
  if (!serverModule) return null;
  const resourcesRoot = path.join(projectRoot, serverModule, 'src', 'main', 'resources');
  if (!fs.existsSync(resourcesRoot)) return null;
  const visit = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === 'target' || entry.name === '.git') continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        visit(full);
      } else if (/^(?:application|bootstrap)[^/]*\.(yml|yaml|properties)$/i.test(entry.name)) {
        candidates.push(full);
      }
    }
  };
  visit(resourcesRoot);
  candidates.sort();
  const declared = [];
  for (const file of candidates) {
    const content = fs.readFileSync(file, 'utf8');
    const source = `配置文件:${path.relative(projectRoot, file)}`;
    if (/\.properties$/i.test(file)) {
      for (const line of content.split(/\r?\n/)) {
        if (/^\s*[#!]/.test(line)) continue;
        const match = line.match(/^\s*server\.port\s*[=:]\s*(.*?)\s*$/);
        if (match) declared.push({ value: match[1].replace(/\s+[#!].*$/, '').trim().replace(/^['"]|['"]$/g, ''), source });
      }
      continue;
    }
    const documents = parseAllDocuments(content, { prettyErrors: false });
    const parseError = documents.flatMap(document => document.errors)[0];
    if (parseError) {
      const line = parseError.linePos?.[0]?.line;
      throw new Error(`服务 ${path.basename(projectRoot)} 的 YAML 配置无效: ${path.relative(projectRoot, file)}${line ? ` 第 ${line} 行` : ''}`);
    }
    for (const document of documents) {
      const config = document.toJS();
      if (!config || typeof config !== 'object' || Array.isArray(config)) continue;
      const server = config.server;
      if (server && typeof server === 'object' && Object.hasOwn(server, 'port')) {
        declared.push({ value: server.port, source });
      }
      if (Object.hasOwn(config, 'server.port')) {
        declared.push({ value: config['server.port'], source });
      }
    }
  }
  if (declared.length === 0) return null;
  for (const item of declared) {
    const port = typeof item.value === 'number'
      ? item.value
      : /^\d+$/.test(String(item.value ?? '').trim()) ? Number(item.value) : NaN;
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new Error(`服务 ${path.basename(projectRoot)} 的 server.port 无效: ${item.source}`);
    }
    item.port = port;
  }
  const ports = [...new Set(declared.map(item => item.port))];
  if (ports.length > 1) {
    const details = declared.map(item => `${item.port} (${item.source})`).join('、');
    throw new Error(`服务 ${path.basename(projectRoot)} 的 server.port 配置存在冲突: ${details}`);
  }
  return { port: ports[0], source: [...new Set(declared.map(item => item.source))].join('、') };
}

function inferDependencies(projectRoot, services) {
  const pom = fs.readFileSync(path.join(projectRoot, 'pom.xml'), 'utf8');
  return services
    .filter(service => service.path !== projectRoot)
    .filter(service => new RegExp(`<artifactId>${service.name}(?:-api)?</artifactId>`).test(pom))
    .map(service => service.name);
}

function nextFreePort(usedPorts) {
  let port = 18080;
  while (usedPorts.has(port)) port++;
  usedPorts.add(port);
  return port;
}

/**
 * 现有服务配置优先于静态推断，避免 API 依赖被误判为双向进程依赖。
 */
function discoverWorkspace(root, existingConfig) {
  const projectRoots = findProjectCandidates(root);
  if (!Array.isArray(existingConfig?.services)) {
    throw new Error('工作区配置无效：服务定义必须是数组');
  }
  const existingByPath = new Map(
    existingConfig.services
      .filter(service => service.path && isWithin(root, service.path))
      .map(service => [path.resolve(service.path), service]),
  );
  const usedPorts = new Set(existingConfig.services.map(service => service.port).filter(Number.isInteger));
  const plans = projectRoots.map(projectRoot => {
    const configured = existingByPath.get(path.resolve(projectRoot));
    const name = configured?.name || path.basename(projectRoot);
    const portInfo = Number.isInteger(configured?.port)
      ? { port: configured.port, source: '现有 bs-java-run 配置' }
      : readDeclaredPort(projectRoot);
    return { projectRoot, configured, name, portInfo };
  });
  for (const plan of plans) {
    if (!plan.portInfo || Number.isInteger(plan.configured?.port)) continue;
    if (usedPorts.has(plan.portInfo.port)) {
      throw new Error(`服务 ${plan.name} 推断出的端口 ${plan.portInfo.port} 已被其它服务占用`);
    }
    usedPorts.add(plan.portInfo.port);
  }
  const services = [];
  const sources = {};

  for (const { projectRoot, configured, name, portInfo } of plans) {
    const port = portInfo?.port || nextFreePort(usedPorts);
    const source = portInfo?.source || '自动分配:18080+';
    const service = {
      name,
      path: projectRoot,
      port,
      dependsOn: configured?.dependsOn || [],
      configured: Boolean(configured),
    };
    services.push(service);
    sources[name] = {
      project: configured ? '现有 bs-java-run 配置' : 'Maven server 模块',
      port: source,
      dependencies: configured ? '现有 bs-java-run 配置' : 'Maven pom 依赖推断',
    };
  }

  for (const service of services) {
    if (!service.configured) {
      service.dependsOn = inferDependencies(service.path, services);
    }
  }

  return {
    services: services.map(({ configured, ...service }) => service),
    sources,
  };
}

function selectWorkspaceEnvironmentData(config, services) {
  for (const key of ['environmentServices', 'environments']) {
    if (!Array.isArray(config?.[key])) throw new Error(`工作区配置无效：${key} 必须是数组`);
  }
  if (!(config.jvmOptionGroups instanceof Map)) throw new Error('工作区配置无效：JVM 参数组必须是映射表');
  const names = new Set(services.map(service => service.name));
  const envServiceRows = config.environmentServices.filter(row => names.has(row.serviceName));
  // 每个运行环境都必须在共享配置中保留，即使刚新增、尚未设置专属 JVM 参数。
  const activeEnvNames = new Set(config.environments.map(environment => environment.name));
  const environments = config.environments.filter(environment => activeEnvNames.has(environment.name));
  const groups = environments.map(environment => [
    environment.name,
    [...(config.jvmOptionGroups.get(environment.name) || [])],
  ]);

  // 自动推断出的服务需在可迁移的每个环境中可启动。
  for (const environment of environments) {
    for (const service of services) {
      if (!envServiceRows.some(row => row.envName === environment.name && row.serviceName === service.name)) {
        envServiceRows.push({ envName: environment.name, serviceName: service.name, jvmOptsStr: '' });
      }
    }
  }
  return { environments, envServiceRows, groups };
}

/** 输出可由 update 安全整体替换的公共运行配置。 */
function renderManagedConfig(config, discovery) {
  const { services } = discovery;
  const { environments, envServiceRows, groups } = selectWorkspaceEnvironmentData(config, services);
  const envRows = environments.map(env => [
    env.name, env.nacosHost, env.nacosNamespace, env.loginUrl,
    env.loginApi ? `POST ${env.loginApi}` : '', env.industryGateway,
    env.feignContextPath, env.serverContextPath,
  ]);
  const serviceRows = services.map(service => [
    service.name, service.path, service.port, service.dependsOn.join(', '),
  ]);
  const envServiceTableRows = envServiceRows.map(row => [row.envName, row.serviceName, row.jvmOptsStr]);
  const groupText = groups.map(([name, options]) => `### ${name}\n\n\`\`\`jvm-env-opts\n${options.join('\n')}\n\`\`\``).join('\n\n');

  return `# 工作区 JavaRun 配置\n\n> 本文件由 \`javarun update\` 管理。服务路径、端口、环境与 JVM 参数在此维护；本机 Java 和账户信息请写入 \`JAVARUN.local.md\`。\n\n## 运行环境\n\n${table(['环境名', 'Nacos 主机', 'Nacos 命名空间', '登录地址', '登录接口', '行业网关', 'Feign 上下文', '服务端上下文'], envRows)}\n\n## 服务定义\n\n${table(['服务名', '路径', '端口', '依赖服务'], serviceRows)}\n\n## 环境服务\n\n${table(['环境名', '服务名', '专属 JVM 参数'], envServiceTableRows)}\n\n## JVM 参数组\n\n${groupText}\n`;
}

function renderLocalTemplate(javaHome, accounts) {
  const accountRows = accounts.map(account => [
    account.name, account.env, account.mainAccount, account.username, account.password,
  ]);
  return `# 本机私有 JavaRun 配置\n\n> 此文件由首次初始化创建，后续 update 不会覆盖。请勿提交密码或 Token。\n\n## java 环境地址\n\n${javaHome || '<请填写 JDK 根目录>'}\n\n## 账户定义\n\n${table(['账户别名', '环境', '主账号', '用户名', '密码'], accountRows)}\n`;
}

function renderWrapper() {
  return `#!/usr/bin/env bash\nset -euo pipefail\nROOT_DIR=\"$(cd \"$(dirname \"$0\")\" && pwd)\"\nCLI_ENTRY=${JSON.stringify(CLI_ENTRY)}\nif [[ ! -f \"$CLI_ENTRY\" ]]; then\n  echo \"JavaRun 转发目标不存在: $CLI_ENTRY\" >&2\n  echo \"请在可用的 bs-java-run 中重新执行 workspace init 或 update。\" >&2\n  exit 1\nfi\ncase \"\${1:-}\" in\n  update|doctor)\n    action=\"$1\"; shift\n    exec node \"$CLI_ENTRY\" workspace \"$action\" \"$ROOT_DIR\" \"$@\"\n    ;;\n  smoke)\n    shift\n    exec node \"$CLI_ENTRY\" workspace smoke \"$ROOT_DIR\" \"$@\"\n    ;;\n  *)\n    exec node \"$CLI_ENTRY\" --workspace \"$ROOT_DIR\" \"$@\"\n    ;;\nesac\n`;
}

function hash(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function lineDiff(current, next) {
  const currentLines = current.split(/\r?\n/);
  const nextLines = next.split(/\r?\n/);
  const output = ['--- JAVARUN.md (current)', '+++ JAVARUN.md (generated)'];
  const max = Math.max(currentLines.length, nextLines.length);
  for (let index = 0; index < max; index++) {
    if (currentLines[index] === nextLines[index]) continue;
    if (currentLines[index] !== undefined) output.push(`- ${currentLines[index]}`);
    if (nextLines[index] !== undefined) output.push(`+ ${nextLines[index]}`);
  }
  return `${output.join('\n')}\n`;
}

function assertWorkspaceDirectory(directory) {
  const paths = workspacePaths(directory);
  if (!fs.existsSync(paths.root) || !fs.statSync(paths.root).isDirectory()) {
    throw new Error(`工作区目录不存在: ${paths.root}`);
  }
  return paths;
}

function buildOutput(directory, config, discoveryConfig = config) {
  const paths = assertWorkspaceDirectory(directory);
  const discovery = discoverWorkspace(paths.root, discoveryConfig);
  if (discovery.services.length === 0) {
    throw new Error(`未在 ${paths.root} 发现可启动的 Maven server 项目`);
  }
  const managedConfig = renderManagedConfig(config, discovery);
  return { paths, config, discovery, managedConfig };
}

function createRuntimeConfig(setup) {
  return {
    javaHome: setup.javaHome,
    environments: setup.environments,
    accounts: setup.accounts,
    services: [],
    environmentServices: [],
    jvmOptionGroups: new Map(),
  };
}

function mergeByName(current, incoming) {
  const merged = new Map(current.map(item => [item.name, { ...item }]));
  for (const item of incoming) merged.set(item.name, { ...item });
  return [...merged.values()];
}

/**
 * 默认只用同名记录覆盖连接或账户，未录入的环境及账户始终保留；replaceAll 才以本次录入作为完整集合。
 * 环境服务和 JVM 参数组按环境名保留，新增环境由渲染阶段自动获得服务行和空参数组。
 */
function mergeRuntimeConfig(currentConfig, setup, replaceAll) {
  const environments = replaceAll
    ? setup.environments.map(environment => ({ ...environment }))
    : mergeByName(currentConfig.environments, setup.environments);
  const environmentNames = new Set(environments.map(environment => environment.name));
  const accounts = (replaceAll
    ? setup.accounts
    : mergeByName(currentConfig.accounts, setup.accounts))
    .filter(account => environmentNames.has(account.env));
  const jvmOptionGroups = new Map();
  for (const [name, options] of currentConfig.jvmOptionGroups) {
    if (environmentNames.has(name)) jvmOptionGroups.set(name, [...options]);
  }
  for (const environment of environments) {
    if (!jvmOptionGroups.has(environment.name)) jvmOptionGroups.set(environment.name, []);
  }
  return {
    javaHome: setup.javaHome || currentConfig.javaHome,
    environments,
    accounts,
    environmentServices: currentConfig.environmentServices
      .filter(item => environmentNames.has(item.envName))
      .map(item => ({ ...item })),
    jvmOptionGroups,
  };
}

function changeSummary(current, next, keys) {
  const currentByName = new Map(current.map(item => [item.name, item]));
  const nextByName = new Map(next.map(item => [item.name, item]));
  const added = [];
  const modified = [];
  const deleted = [];
  for (const [name, item] of nextByName) {
    const before = currentByName.get(name);
    if (!before) added.push(name);
    else if (keys.some(key => before[key] !== item[key])) modified.push(name);
  }
  for (const name of currentByName.keys()) {
    if (!nextByName.has(name)) deleted.push(name);
  }
  return { added, modified, deleted };
}

function formatChangeItems(items) {
  return items.length ? items.join('、') : '无';
}

/** 只显示环境名和账户别名，连接内容、密码、Token 等敏感值均不进入控制台。 */
function printConfigurationDiff(currentConfig, nextConfig) {
  const environments = changeSummary(currentConfig.environments, nextConfig.environments, [
    'nacosHost', 'nacosNamespace', 'loginUrl', 'loginApi', 'industryGateway', 'feignContextPath', 'serverContextPath',
  ]);
  const accounts = changeSummary(currentConfig.accounts, nextConfig.accounts, [
    'env', 'mainAccount', 'username', 'password',
  ]);
  console.log('配置差异摘要（已脱敏）：');
  console.log(`环境 - 新增: ${formatChangeItems(environments.added)}；修改: ${formatChangeItems(environments.modified)}；删除: ${formatChangeItems(environments.deleted)}`);
  console.log(`账户别名 - 新增: ${formatChangeItems(accounts.added)}；修改: ${formatChangeItems(accounts.modified)}；删除: ${formatChangeItems(accounts.deleted)}`);
  return { environments, accounts };
}

async function confirmReplaceAll(options) {
  if (typeof options.confirmReplaceAll === 'function') {
    return Boolean(await options.confirmReplaceAll());
  }
  // 仅供内部调用测试注入；CLI 不会传入该选项，真实命令始终要求交互确认。
  if (options.confirmReplaceAll === true) return true;
  if (!process.stdin.isTTY) {
    throw new Error('--replace-all 需要交互式终端二次确认');
  }
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const first = await askQuestion('确认按上述差异全量覆盖？(y/N)', { defaultValue: 'n' }, readline);
    if (!/^(y|yes|是)$/i.test(first)) return false;
    const second = await askQuestion('再次确认：未重新录入的环境和账户将被删除，继续？(y/N)', { defaultValue: 'n' }, readline);
    return /^(y|yes|是)$/i.test(second);
  } finally {
    readline.close();
  }
}

function renderManifest(output) {
  const manifest = {
    version: 1,
    generatedAt: new Date().toISOString(),
    managedConfigHash: hash(output.managedConfig),
    runnerEntry: CLI_ENTRY,
    services: output.discovery.services,
    inference: output.discovery.sources,
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function workspaceGitignoreContent(paths) {
  const ignoreFile = path.join(paths.configDir, '.gitignore');
  const existing = fs.existsSync(ignoreFile) ? fs.readFileSync(ignoreFile, 'utf8') : '';
  const required = [
    `/${LOCAL_CONFIG_NAME}`,
    `/${LOCAL_CONFIG_NAME}.bak-*`,
    `/.${LOCAL_CONFIG_NAME}.*.tmp`,
    `/${LOCAL_CONFIG_NAME}.*.tmp`,
    `/${LOCAL_CONFIG_NAME}.*.rollback`,
    '/history/',
    'logs/',
    '*.pid',
  ];
  const existingRules = new Set(existing.split(/\r?\n/).map(line => line.trim()));
  const missing = required.filter(rule => !existingRules.has(rule));
  const prefix = existing.endsWith('\n') || !existing ? existing : `${existing}\n`;
  return `${prefix}${missing.length ? `${missing.join('\n')}\n` : ''}`;
}

function generatedFileEntries(output, { writeLocal }) {
  const { paths } = output;
  const entries = [
    { file: paths.configFile, content: output.managedConfig },
    { file: path.join(paths.configDir, '.gitignore'), content: workspaceGitignoreContent(paths) },
    { file: paths.wrapperFile, content: renderWrapper(), mode: 0o755 },
  ];
  if (writeLocal) entries.push({ file: paths.localFile, content: output.localTemplate, mode: 0o600 });
  entries.push({ file: paths.manifestFile, content: renderManifest(output) });
  return entries;
}

function writeGeneratedFiles(output, { writeLocal }) {
  const { paths } = output;
  fs.mkdirSync(paths.configDir, { recursive: true });
  fs.mkdirSync(path.join(paths.configDir, 'logs'), { recursive: true });
  writeFilesAtomically(generatedFileEntries(output, { writeLocal }));
  tightenPrivatePermissions(paths.configDir);
}

function nextBackupFile(file, timestamp) {
  const base = `${file}.bak-${timestamp}`;
  if (!fs.existsSync(base)) return base;
  let sequence = 1;
  while (fs.existsSync(`${base}-${sequence}`)) sequence++;
  return `${base}-${sequence}`;
}

/** 每次配置前都创建共享与私有配置的同时间戳备份，私有文件缺失时保留空白备份以便审计。 */
function backupConfigurationFiles(paths, managedContent, localContent) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  writePrivateFile(nextBackupFile(paths.configFile, timestamp), managedContent);
  writePrivateFile(nextBackupFile(paths.localFile, timestamp), localContent);
}

function stageAtomicFiles(entries) {
  const staged = [];
  try {
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index];
      const nonce = crypto.randomBytes(6).toString('hex');
      const tempFile = path.join(path.dirname(entry.file), `.${path.basename(entry.file)}.${process.pid}.${nonce}.${index}.tmp`);
      const stagedEntry = { ...entry, tempFile };
      staged.push(stagedEntry);
      fs.writeFileSync(tempFile, entry.content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      fs.chmodSync(tempFile, 0o600);
    }
  } catch (error) {
    const cleanupFailures = [];
    for (const entry of staged) {
      try {
        if (fs.existsSync(entry.tempFile)) fs.unlinkSync(entry.tempFile);
      } catch (cleanupError) {
        cleanupFailures.push(`${entry.tempFile}: ${cleanupError.message}`);
      }
    }
    if (cleanupFailures.length) {
      throw new Error(`${error.message}；临时文件清理失败 (${cleanupFailures.join('；')})`);
    }
    throw error;
  }
  return staged;
}

function writePrivateFile(file, content) {
  const descriptor = fs.openSync(file, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, content, 'utf8');
    fs.fchmodSync(descriptor, 0o600);
  } catch (error) {
    fs.closeSync(descriptor);
    fs.rmSync(file, { force: true });
    throw error;
  }
  fs.closeSync(descriptor);
}

function finalFileMode(entry, original) {
  if (entry.mode !== undefined) return entry.mode;
  return original?.exists ? original.mode & 0o7777 : 0o644;
}

function tightenHistoryPermissions(directory) {
  fs.chmodSync(directory, 0o700);
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isFile()) fs.chmodSync(file, 0o600);
    else if (entry.isDirectory()) tightenHistoryPermissions(file);
  }
}

function tightenPrivatePermissions(directory) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isFile() && (
      entry.name === LOCAL_CONFIG_NAME
      || entry.name.startsWith(`${LOCAL_CONFIG_NAME}.bak-`)
      || entry.name.startsWith(`.${LOCAL_CONFIG_NAME}.`)
    )) {
      fs.chmodSync(file, 0o600);
    } else if (entry.name === 'history' && entry.isDirectory()) {
      tightenHistoryPermissions(file);
    }
  }
}

/**
 * 多文件写入先全部落盘到同目录临时文件，再逐个原子替换；任何替换失败即回滚已替换目标。
 * 这避免配置、账户、清单之间出现持久化的半写入状态。
 */
function writeFilesAtomically(entries) {
  const originals = new Map(entries.map(entry => [entry.file, fs.existsSync(entry.file)
    ? { exists: true, content: fs.readFileSync(entry.file, 'utf8'), mode: fs.statSync(entry.file).mode & 0o7777 }
    : { exists: false }]));
  let staged = [];
  const replaced = [];
  const rollbackFailures = [];
  const rollbackArtifacts = [];
  let writeError = null;
  let cleanupFailures = [];
  try {
    staged = stageAtomicFiles(entries);
    for (const entry of staged) {
      fs.renameSync(entry.tempFile, entry.file);
      replaced.push(entry.file);
      fs.chmodSync(entry.file, finalFileMode(entry, originals.get(entry.file)));
    }
  } catch (error) {
    for (const file of replaced.reverse()) {
      const original = originals.get(file);
      let rollback = null;
      try {
        if (original.exists) {
          rollback = `${file}.${process.pid}.${Date.now()}.rollback`;
          fs.writeFileSync(rollback, original.content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
          fs.chmodSync(rollback, 0o600);
          fs.renameSync(rollback, file);
          fs.chmodSync(file, finalFileMode(entries.find(entry => entry.file === file), original));
        } else if (fs.existsSync(file)) {
          fs.unlinkSync(file);
        }
      } catch (rollbackError) {
        rollbackFailures.push(`${file}: ${rollbackError.message}`);
        if (rollback && fs.existsSync(rollback)) rollbackArtifacts.push(rollback);
      }
    }
    writeError = error;
  } finally {
    for (const entry of staged) {
      try {
        if (fs.existsSync(entry.tempFile)) fs.unlinkSync(entry.tempFile);
      } catch (error) {
        cleanupFailures.push(`${entry.tempFile}: ${error.message}`);
      }
    }
  }
  if (!writeError) return;
  const details = rollbackFailures.length
    ? `回滚未完全成功 (${rollbackFailures.join('；')})${rollbackArtifacts.length ? `；保留恢复文件: ${rollbackArtifacts.join('、')}` : ''}`
    : replaced.length ? '原文件已回滚' : '原文件未发生变化';
  const cleanup = cleanupFailures.length ? `；临时文件清理失败 (${cleanupFailures.join('；')})` : '';
  throw new Error(`配置写入失败，${details}: ${writeError.message}${cleanup}`);
}

/** 首次初始化只创建新工作区，防止意外覆盖已有聚合目录配置。 */
export async function initWorkspace(directory, options = {}) {
  const paths = assertWorkspaceDirectory(directory);
  if (fs.existsSync(paths.configFile) || fs.existsSync(paths.wrapperFile)) {
    throw new Error(`工作区已初始化: ${paths.root}；如需刷新请执行 workspace update`);
  }
  const setup = options.setup ? validateSetup(options.setup) : await promptWorkspaceSetup('');
  const output = buildOutput(directory, createRuntimeConfig(setup));
  output.localTemplate = renderLocalTemplate(setup.javaHome, setup.accounts);
  writeGeneratedFiles(output, { writeLocal: true });
  console.log(`已初始化工作区: ${output.paths.root}`);
  console.log(`发现服务: ${output.discovery.services.map(service => service.name).join(', ')}`);
  console.log(`下一步: cd ${output.paths.root} && ./javarun doctor`);
  return 0;
}

/** 更新前以清单哈希保护受托管配置，保留用户本机私有配置。 */
export async function updateWorkspace(directory) {
  const paths = assertWorkspaceDirectory(directory);
  if (!fs.existsSync(paths.manifestFile) || !fs.existsSync(paths.configFile)) {
    throw new Error(`工作区尚未初始化: ${paths.root}；请先执行 workspace init`);
  }
  tightenPrivatePermissions(paths.configDir);
  const workspaceEnv = { ...process.env, BS_JAVARUN_WORKSPACE: paths.root };
  const output = buildOutput(directory, loadConfig(workspaceEnv));
  const manifest = JSON.parse(fs.readFileSync(output.paths.manifestFile, 'utf8'));
  const current = fs.readFileSync(output.paths.configFile, 'utf8');
  if (hash(current) !== manifest.managedConfigHash) {
    const nextFile = path.join(output.paths.configDir, 'JAVARUN.md.generated.next');
    const diffFile = path.join(output.paths.configDir, 'JAVARUN.md.update.diff');
    writeFilesAtomically([
      { file: nextFile, content: output.managedConfig },
      { file: diffFile, content: lineDiff(current, output.managedConfig) },
    ]);
    throw new Error(`检测到 ${MANAGED_CONFIG_NAME} 的手工修改，未覆盖。候选文件: ${nextFile}；差异报告: ${diffFile}`);
  }
  writeGeneratedFiles(output, { writeLocal: false });
  console.log(`已更新工作区启动组件: ${output.paths.root}`);
  return 0;
}

/**
 * 用户显式要求重新录入连接配置时，默认按环境名合并；只有 replaceAll 才允许删除未录入环境和账户。
 * 写入前始终输出脱敏摘要、备份共享和私有配置，并通过多文件原子替换避免半写入。
 */
export async function reconfigureWorkspace(directory, options = {}) {
  const paths = assertWorkspaceDirectory(directory);
  if (!fs.existsSync(paths.manifestFile) || !fs.existsSync(paths.configFile)) {
    throw new Error(`工作区尚未初始化: ${paths.root}；请先执行 workspace init`);
  }
  const manifest = JSON.parse(fs.readFileSync(paths.manifestFile, 'utf8'));
  const current = fs.readFileSync(paths.configFile, 'utf8');
  if (hash(current) !== manifest.managedConfigHash) {
    throw new Error(`检测到 ${MANAGED_CONFIG_NAME} 的手工修改，无法安全重新配置；请先处理该文件的差异`);
  }

  const workspaceEnv = { ...process.env, BS_JAVARUN_WORKSPACE: paths.root };
  const currentConfig = loadConfig(workspaceEnv);
  tightenPrivatePermissions(paths.configDir);
  const replaceAll = Boolean(options.replaceAll);
  const setup = options.setup
    ? validateSetup(options.setup)
    : await promptWorkspaceSetup(currentConfig.javaHome, currentConfig, { replaceAll });
  const nextConfig = mergeRuntimeConfig(currentConfig, setup, replaceAll);
  const output = buildOutput(directory, nextConfig, currentConfig);
  output.localTemplate = renderLocalTemplate(nextConfig.javaHome, nextConfig.accounts);
  printConfigurationDiff(currentConfig, nextConfig);

  if (replaceAll && !await confirmReplaceAll(options)) {
    console.log('已取消全量覆盖，工作区配置未修改。');
    return 0;
  }

  const managedContent = fs.readFileSync(paths.configFile, 'utf8');
  const localContent = fs.existsSync(paths.localFile) ? fs.readFileSync(paths.localFile, 'utf8') : '';
  backupConfigurationFiles(paths, managedContent, localContent);
  fs.mkdirSync(paths.configDir, { recursive: true });
  fs.mkdirSync(path.join(paths.configDir, 'logs'), { recursive: true });
  writeFilesAtomically(generatedFileEntries(output, { writeLocal: true }));
  console.log(`已${replaceAll ? '全量覆盖' : '合并更新'}工作区连接配置: ${paths.root}`);
  return 0;
}

function loadWorkspaceConfig(directory, env = process.env) {
  const paths = workspacePaths(directory);
  const workspaceEnv = { ...env, BS_JAVARUN_WORKSPACE: paths.root };
  return { paths, config: loadConfig(workspaceEnv) };
}

/** 执行无副作用的启动前检查；缺少构建产物只告警，便于首次初始化后再构建。 */
export async function doctorWorkspace(directory) {
  const { paths, config } = loadWorkspaceConfig(directory);
  const errors = [];
  const warnings = [];
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (!Number.isInteger(nodeMajor) || nodeMajor < 18) {
    errors.push(`Node.js 版本过低: ${process.versions.node}，需要 >= 18`);
  }
  if (!fs.existsSync(paths.wrapperFile)) errors.push('缺少根目录 javarun 转发脚本');
  if (!fs.existsSync(CLI_ENTRY)) errors.push(`转发目标不存在: ${CLI_ENTRY}`);
  if (!fs.existsSync(paths.localFile)) warnings.push(`缺少本机配置: ${paths.localFile}`);
  if (config.javaHome && !fs.existsSync(path.join(config.javaHome, 'bin', 'java'))) {
    errors.push(`Java 路径不可用: ${config.javaHome}`);
  }
  const maven = spawnSync('mvn', ['--version'], { encoding: 'utf8' });
  if (maven.error || maven.status !== 0) errors.push('Maven 不可用: 请确认 mvn 已安装并在 PATH 中');
  for (const service of config.services) {
    if (!fs.existsSync(service.path)) {
      errors.push(`${service.name} 的项目目录不存在: ${service.path}`);
      continue;
    }
    if (!fs.existsSync(path.join(service.path, 'pom.xml'))) {
      errors.push(`${service.name} 不是 Maven 项目: ${service.path}`);
    }
    try {
      const module = findServerModule(service.path, service.name);
      if (!module) errors.push(`${service.name} 未发现 server 模块`);
      else resolveWar(service.path, module);
    } catch (error) {
      warnings.push(`${service.name} 尚无可启动构建产物: ${error.message}`);
    }
    if (checkPort(service.port)) warnings.push(`${service.name} 的端口 ${service.port} 已在监听`);
  }
  console.log(`工作区: ${paths.root}`);
  console.log(`配置目录: ${resolveConfigDirectory({ BS_JAVARUN_WORKSPACE: paths.root })}`);
  console.log(`Node.js: ${process.versions.node}`);
  for (const warning of warnings) console.log(`WARN: ${warning}`);
  for (const error of errors) console.error(`ERROR: ${error}`);
  if (errors.length > 0) return 1;
  console.log(`doctor 通过：${config.services.length} 个服务配置有效。`);
  return 0;
}

/**
 * 冒烟仅回收本次选择闭包内的工具进程，端口已有监听时仍由 start 的安全检查阻止继续执行。
 */
export async function smokeWorkspace(directory, serviceArg, options, dependencies = {}) {
  const doctor = dependencies.doctorWorkspace || doctorWorkspace;
  const select = dependencies.selectServices || selectServices;
  const startServices = dependencies.start || start;
  const stopServices = dependencies.stop || stop;
  const paths = workspacePaths(directory);
  process.env.BS_JAVARUN_WORKSPACE = paths.root;
  delete globalThis._bsJavaRunConfig;
  const doctorCode = await doctor(directory);
  if (doctorCode !== 0) return doctorCode;
  const selection = await select(serviceArg, { ...options, yes: true }, '启动冒烟', { environmentScoped: true });
  if (selection.cancelled || selection.empty) return selection.empty ? 1 : 0;
  const startedInstances = [];
  let startCode = 1;
  let stopCode = 0;

  try {
    try {
      startCode = await startServices(serviceArg, {
        ...options,
        yes: true,
        build: Boolean(options.build),
        startedInstances,
      });
    } catch (startError) {
      error(`冒烟启动失败: ${startError.message}`);
      startCode = 1;
    }
  } finally {
    if (!options.keepRunning) {
      try {
        stopCode = await stopServices('all', {
          yes: true,
          skipPid: false,
          cascade: false,
          force: false,
          startedInstances,
          runContext: options.runContext,
        });
      } catch (stopError) {
        error(`冒烟清理失败: ${stopError.message}`);
        stopCode = 1;
      }
    }
  }

  if (options.keepRunning) return startCode;
  return startCode || stopCode ? 1 : 0;
}
