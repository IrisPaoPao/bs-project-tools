#!/usr/bin/env node
/**
 * SAAS Industry 登录脚本
 * 供 Agent 调用，自动完成登录并返回 Authorization Token
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const SCRIPT_DIR = __dirname;
const JAVARUN_MD = path.resolve(SCRIPT_DIR, 'JAVARUN.md');
const JAVARUN_LOCAL_MD = path.resolve(SCRIPT_DIR, 'JAVARUN.local.md');

function stripMarkdownValue(value) {
  return String(value || '').trim().replace(/^`|`$/g, '');
}

function parseMultiColumnTable(content, sectionHeading, headerFirstCell) {
  const rows = [];
  const lines = String(content || '').split(/\r?\n/);
  let inSection = false;
  let inTable = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('## ')) {
      if (trimmed === `## ${sectionHeading}`) {
        inSection = true;
        inTable = false;
        continue;
      }
      if (inSection) break;
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

function parseLoginEnvironments(content) {
  return parseMultiColumnTable(content, '运行环境', '环境名')
    .map(cells => ({
      name: cells[0],
      loginUrl: cells[3] || '',
      loginApi: (cells[4] || '').replace(/^[A-Z]+\s+/, ''),
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

function mergeByName(globalList, localList) {
  const map = new Map();
  for (const item of globalList) if (item.name) map.set(item.name, { ...item });
  for (const item of localList) {
    if (!item.name) continue;
    if (map.has(item.name)) {
      const merged = { ...map.get(item.name) };
      for (const [k, v] of Object.entries(item)) {
        if (v !== '' && v !== null && v !== undefined) merged[k] = v;
      }
      map.set(item.name, merged);
    } else {
      map.set(item.name, { ...item });
    }
  }
  return [...map.values()];
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

function loadConfig(env = process.env, options = {}) {
  const configFile = options.configFile || JAVARUN_MD;
  const localConfigFile = options.localConfigFile || path.join(path.dirname(configFile), 'JAVARUN.local.md');
  const content = readConfigFile(configFile);
  const localContent = readConfigFile(localConfigFile, false);

  const timeout = Number(env.BS_LOGIN_TIMEOUT || 30000);
  if (!Number.isInteger(timeout) || timeout <= 0) {
    throw new Error(`BS_LOGIN_TIMEOUT 必须是正整数毫秒值: ${env.BS_LOGIN_TIMEOUT}`);
  }

  return {
    environments: mergeByName(parseLoginEnvironments(content), parseLoginEnvironments(localContent)),
    accounts: mergeByName(parseLoginAccounts(content), parseLoginAccounts(localContent)),
    timeout,
  };
}

function resolveAccount(config, accountName) {
  if (config.accounts.length === 0) {
    throw new Error('未配置任何登录账户，请在 JAVARUN.md / JAVARUN.local.md 的 ## 账户定义 表中添加');
  }
  const account = accountName
    ? config.accounts.find(a => a.name === accountName)
    : config.accounts[0];
  if (!account) {
    const available = config.accounts.map(a => a.name).join(', ');
    throw new Error(`未找到登录账户: ${accountName}\n可用账户: ${available}`);
  }
  const env = config.environments.find(e => e.name === account.env);
  if (!env) {
    throw new Error(`账户 "${account.name}" 引用的环境 "${account.env}" 不存在，请在 ## 运行环境 表中定义`);
  }
  if (!env.loginUrl) throw new Error(`环境 "${env.name}" 缺少登录地址`);
  if (!env.loginApi) throw new Error(`环境 "${env.name}" 缺少登录接口`);
  if (!account.mainAccount) throw new Error(`账户 "${account.name}" 缺少主账号`);
  if (!account.username) throw new Error(`账户 "${account.name}" 缺少用户名`);
  if (!account.password) throw new Error(`账户 "${account.name}" 缺少密码`);

  return {
    accountName: account.name,
    envName: env.name,
    loginUrl: env.loginUrl,
    loginApiPath: env.loginApi,
    mainAccount: account.mainAccount,
    username: account.username,
    password: account.password,
    timeout: config.timeout,
  };
}

function extractLoginToken(response, headers = {}) {
  const headerToken = Object.entries(headers)
    .find(([name]) => /^(authorization|x-authorization|token|x-token)$/i.test(name))?.[1] || null;
  if (!response || typeof response !== 'object') return headerToken;

  const tokenKeys = new Set(['authorization', 'token', 'access_token', 'accesstoken']);
  const pending = [{ value: response, depth: 0 }];
  while (pending.length > 0) {
    const { value, depth } = pending.shift();
    if (!value || typeof value !== 'object' || depth > 4) continue;
    for (const [key, child] of Object.entries(value)) {
      if (tokenKeys.has(key.toLowerCase()) && typeof child === 'string' && child.trim()) {
        return child.trim();
      }
      if (child && typeof child === 'object') {
        pending.push({ value: child, depth: depth + 1 });
      }
    }
  }
  return headerToken;
}

function extractTokenFromCookies(cookies = []) {
  const tokenCookie = cookies.find(cookie => /^(authorization|x-authorization|token|x-token|access_?token)$/i.test(cookie.name || ''));
  return tokenCookie?.value || null;
}

function safeUrlPath(url) {
  try {
    return new URL(url, 'http://localhost').pathname || '/';
  } catch (error) {
    return '[invalid-url]';
  }
}

function summarizePayload(value, depth = 0) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[array:${value.length}]`;
  if (typeof value !== 'object') return typeof value;
  if (depth >= 2) return 'object';
  return Object.fromEntries(Object.entries(value)
    .slice(0, 12)
    .map(([key, child]) => [key, summarizePayload(child, depth + 1)]));
}

function createLoginEvidence(resolved) {
  return {
    configuredPath: safeUrlPath(resolved.loginApiPath),
    matchedRequests: [],
    candidateRequests: [],
    matchedResponses: [],
  };
}

function isLikelyLoginEndpoint(url) {
  return /(?:login|auth|token)/i.test(safeUrlPath(url));
}

function recordLoginRequest(evidence, request, matched) {
  if (!matched && !isLikelyLoginEndpoint(request.url())) return;
  const target = matched ? evidence.matchedRequests : evidence.candidateRequests;
  if (target.length >= 4) return;
  target.push({
    method: request.method(),
    path: safeUrlPath(request.url()),
  });
}

function recordLoginResponse(evidence, response, body, matched) {
  if (!matched && !isLikelyLoginEndpoint(response.url())) return;
  const target = matched ? evidence.matchedResponses : evidence.candidateRequests;
  if (target.length >= 4) return;
  const entry = {
    path: safeUrlPath(response.url()),
    status: response.status(),
    headers: Object.keys(response.headers()).sort(),
    body: summarizePayload(body),
  };
  target.push(entry);
}

function formatLoginEvidence(evidence) {
  const formatRequests = items => items.map((item) => {
    const responseDetails = item.status
      ? ` HTTP ${item.status} 字段 ${JSON.stringify(item.body)} 响应头 ${item.headers.join('|') || '无'}`
      : '';
    return `${item.method || 'RESPONSE'} ${item.path}${responseDetails}`;
  }).join(', ') || '无';
  return `配置路径 ${evidence.configuredPath}；命中请求 ${formatRequests(evidence.matchedRequests)}；命中响应 ${formatRequests(evidence.matchedResponses)}；候选请求 ${formatRequests(evidence.candidateRequests)}`;
}

function isAuthenticationFailure(response) {
  if (!response) return false;
  return response.status === 401 || response.status === 403;
}

function buildTokenMissingDiagnostic(evidence) {
  if (evidence.matchedResponses.length === 0) {
    return `登录接口未命中: ${formatLoginEvidence(evidence)}`;
  }
  const failedResponse = evidence.matchedResponses.find(response => response.status < 200 || response.status >= 300);
  if (failedResponse) {
    const category = isAuthenticationFailure(failedResponse) ? '认证失败' : '登录接口非 2xx';
    return `${category}: HTTP ${failedResponse.status}；${formatLoginEvidence(evidence)}`;
  }
  return `Token 缺失: 登录接口已命中但响应、Cookie 和后续认证请求均未提供 Token；${formatLoginEvidence(evidence)}`;
}

const LOGIN_INPUTS = {
  mainAccount: {
    label: '主账号',
    selectors: [
      'input[placeholder="请输入主账号"]',
      'input[placeholder="请输入您的主账号"]',
    ],
  },
  username: {
    label: '登录账号',
    selectors: [
      'input[placeholder="请输入登录账号"]',
      'input[placeholder="请输入您的用户名"]',
    ],
  },
  password: {
    label: '密码',
    selectors: [
      'input[placeholder="请输入密码"]',
      'input[placeholder="请输入您的密码"]',
    ],
  },
};

function getLoginInputSelector(field) {
  const input = LOGIN_INPUTS[field];
  if (!input) throw new Error(`未知登录输入框: ${field}`);
  return input.selectors.join(', ');
}

function getLoginInputLocator(page, field) {
  return page.locator(getLoginInputSelector(field)).first();
}

function isTimeoutError(error) {
  return /timeout/i.test(error?.message || String(error || ''));
}

async function fillLoginInput(page, field, value, timeout) {
  const input = LOGIN_INPUTS[field];
  const locator = getLoginInputLocator(page, field);
  try {
    await locator.waitFor({ state: 'visible', timeout });
  } catch (error) {
    if (isTimeoutError(error)) {
      throw new Error(`登录表单元素定位超时: 未找到${input.label}输入框`);
    }
    throw new Error(`登录表单元素定位失败: 无法定位${input.label}输入框 (${error.message})`);
  }

  try {
    await locator.click();
    await locator.fill(value);
  } catch (error) {
    throw new Error(`登录表单填写失败: 无法填写${input.label}输入框 (${error.message})`);
  }
}

function diagnoseNetworkError(errMessage = '') {
  const msg = String(errMessage);
  if (msg.includes('ERR_NAME_NOT_RESOLVED')) {
    return '域名解析失败 (ERR_NAME_NOT_RESOLVED)，请检查 DNS 配置或目标域名拼写。';
  }
  if (msg.includes('ERR_CONNECTION_REFUSED')) {
    return '目标服务器拒绝连接 (ERR_CONNECTION_REFUSED)，请检查网关/服务是否在目标服务器上正常运行。';
  }
  if (msg.includes('Timeout') || msg.includes('timeout')) {
    return '网络请求超时 (Timeout)，请检查公司 VPN 是否打开以及网络连通性。';
  }
  if (msg.includes('SSL') || msg.includes('TLS') || msg.includes('CERT')) {
    return 'SSL/TLS 证书握手失败，请检查 https 证书或代理配置。';
  }
  return errMessage;
}

function isLoginEndpoint(url, resolved) {
  const requestPath = safeUrlPath(url);
  const configuredPath = safeUrlPath(resolved.loginApiPath);
  return Boolean(
    requestPath === configuredPath
    || /^\/(?:userLogin|privatizationLogin)(?:\/|$)/i.test(requestPath)
    // 辽宁环境已验证实际请求为此地址，响应根节点返回 token。
    || requestPath === '/tax/identity/v1/login',
  );
}

function loadLoginConfig(options = {}) {
  const configOptions = {
    ...(options.configOptions || {}),
    ...(options.configFile ? { configFile: options.configFile } : {}),
    ...(options.localConfigFile ? { localConfigFile: options.localConfigFile } : {}),
  };
  return loadConfig(options.env || process.env, configOptions);
}

async function login(options = {}) {
  const config = loadLoginConfig(options);
  const resolved = resolveAccount(config, typeof options.account === 'string' ? options.account : null);
  const { headless = false, timeout = resolved.timeout, emitOutput = false } = options;

  const browser = await chromium.launch({
    headless,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
  });

  const page = await context.newPage();

  let loginResponse = null;
  let loginToken = null;
  let loginRequestFailure = null;
  let loginResponseStatus = null;
  let loginSubmitted = false;
  const loginEvidence = createLoginEvidence(resolved);

  page.on('request', (request) => {
    const matched = isLoginEndpoint(request.url(), resolved);
    if (matched || loginSubmitted) {
      recordLoginRequest(loginEvidence, request, matched);
    }
    if (matched) {
      loginToken = extractLoginToken(null, request.headers()) || loginToken;
    }
    if (loginSubmitted) {
      loginToken = extractLoginToken(null, request.headers()) || loginToken;
    }
  });

  page.on('response', async (response) => {
    const url = response.url();
    const matched = isLoginEndpoint(url, resolved);
    if (!matched && (!loginSubmitted || !isLikelyLoginEndpoint(url))) return;
    const headers = response.headers();
    let responseBody = null;
    try {
      responseBody = await response.json();
    } catch (e) {
      // ignore
    }
    recordLoginResponse(loginEvidence, response, responseBody, matched);
    if (!matched) return;

    loginResponseStatus = response.status();
    const responseToken = extractLoginToken(responseBody, headers);
    loginResponse = responseBody;
    loginToken = responseToken || loginToken;
  });

  page.on('requestfailed', (request) => {
    if (!isLoginEndpoint(request.url(), resolved)) return;
    loginRequestFailure = request.failure()?.errorText || '未知网络错误';
  });

  try {
    // 换用 domcontentloaded，避免 long polling / websocket 在 networkidle 阻塞
    try {
      await page.goto(resolved.loginUrl, { waitUntil: 'domcontentloaded', timeout });
    } catch (error) {
      const reason = isTimeoutError(error) ? '登录页加载超时' : '登录页加载失败';
      throw new Error(`${reason}: ${error.message}`);
    }

    await fillLoginInput(page, 'mainAccount', resolved.mainAccount, timeout);
    await fillLoginInput(page, 'username', resolved.username, timeout);
    await fillLoginInput(page, 'password', resolved.password, timeout);

    const loginButton = page.locator('button.login-btn');
    loginSubmitted = true;
    await loginButton.click();

    try {
      await page.waitForURL('**/portal', { timeout });
    } catch (error) {
      if (loginRequestFailure) {
        throw new Error(`登录请求失败: ${diagnoseNetworkError(loginRequestFailure)}`);
      }
      if (loginResponseStatus && (loginResponseStatus < 200 || loginResponseStatus >= 300)) {
        throw new Error(buildTokenMissingDiagnostic(loginEvidence));
      }
      if (loginEvidence.matchedRequests.length === 0) {
        throw new Error(buildTokenMissingDiagnostic(loginEvidence));
      }
      const reason = isTimeoutError(error) ? '登录后跳转超时' : '登录后跳转失败';
      throw new Error(`${reason}: 未跳转至 **/portal (${error.message})`);
    }
    await page.waitForTimeout(1000);

    const cookieToken = extractTokenFromCookies(await context.cookies());
    loginToken = cookieToken || loginToken;

    if (process.env.BS_LOGIN_DIAGNOSTICS === '1') {
      console.error(`登录诊断: ${formatLoginEvidence(loginEvidence)}`);
    }

    const token = loginToken || extractLoginToken(loginResponse);
    if (token) {
      const result = {
        success: true,
        account: resolved.accountName,
        env: resolved.envName,
        token,
        authorization: token,
        lastLoginTime: loginResponse?.lastLoginTime || loginResponse?.response?.lastLoginTime || loginResponse?.data?.lastLoginTime || loginResponse?.result?.lastLoginTime,
        pageUrl: page.url(),
        timestamp: new Date().toISOString(),
      };

      if (emitOutput) {
        console.log(JSON.stringify(result, null, 2));
      }

      await browser.close();
      return result;
    } else {
      throw new Error(buildTokenMissingDiagnostic(loginEvidence));
    }
  } catch (err) {
    const diagnosedReason = err.message;
    const result = {
      success: false,
      account: resolved.accountName,
      env: resolved.envName,
      error: diagnosedReason,
      pageUrl: page.url(),
      timestamp: new Date().toISOString(),
    };

    if (emitOutput) {
      console.error(JSON.stringify(result, null, 2));
    }

    await browser.close();
    throw new Error(diagnosedReason);
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const headless = args.includes('--headless');

  let account = null;
  const accountIdx = args.indexOf('--account');
  if (accountIdx !== -1 && args[accountIdx + 1]) {
    account = args[accountIdx + 1];
  }

  login({ account, headless, emitOutput: true })
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}

module.exports = {
  login,
  loadConfig,
  loadLoginConfig,
  resolveAccount,
  extractLoginToken,
  extractTokenFromCookies,
  buildTokenMissingDiagnostic,
  getLoginInputSelector,
  getLoginInputLocator,
  fillLoginInput,
  isLoginEndpoint,
  JAVARUN_MD,
  JAVARUN_LOCAL_MD,
};
