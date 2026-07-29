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

function parseMultiColumnTable(content, headerFirstCell) {
  const rows = [];
  const lines = String(content || '').split(/\r?\n/);
  let inTable = false;

  for (const line of lines) {
    const trimmed = line.trim();
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
  return parseMultiColumnTable(content, '环境别名')
    .map(cells => ({
      name: cells[0],
      loginUrl: cells[3] || cells[1] || '',
      loginApi: (cells[4] || cells[2] || '').replace(/^[A-Z]+\s+/, ''),
    }))
    .filter(e => e.name);
}

function parseLoginAccounts(content) {
  return parseMultiColumnTable(content, '账户别名')
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
  return Boolean(
    (resolved.loginApiPath && url.includes(resolved.loginApiPath))
    || /\/(?:userLogin|privatizationLogin)(?:[/?#]|$)/i.test(url),
  );
}

async function login(options = {}) {
  const config = loadConfig(options.env || process.env, options.configOptions || {});
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

  page.on('request', (request) => {
    if (!isLoginEndpoint(request.url(), resolved)) return;
    loginToken = extractLoginToken(null, request.headers()) || loginToken;
  });

  page.on('response', async (response) => {
    const url = response.url();
    if (!isLoginEndpoint(url, resolved)) return;

    const headers = response.headers();
    let responseBody = null;
    try {
      responseBody = await response.json();
    } catch (e) {
      // ignore
    }
    const responseToken = extractLoginToken(responseBody, headers);
    if (!responseToken) return;
    loginResponse = responseBody;
    loginToken = responseToken;
  });

  try {
    // 换用 domcontentloaded，避免 long polling / websocket 在 networkidle 阻塞
    await page.goto(resolved.loginUrl, { waitUntil: 'domcontentloaded', timeout });

    const mainAccountInput = page.locator('input[placeholder="请输入您的主账号"]');
    await mainAccountInput.waitFor({ state: 'visible', timeout });
    await mainAccountInput.click();
    await mainAccountInput.fill(resolved.mainAccount);

    const usernameInput = page.locator('input[placeholder="请输入您的用户名"]');
    await usernameInput.click();
    await usernameInput.fill(resolved.username);

    const passwordInput = page.locator('input[placeholder="请输入您的密码"]');
    await passwordInput.click();
    await passwordInput.fill(resolved.password);

    const loginButton = page.locator('button.login-btn');
    await loginButton.click();

    await page.waitForURL('**/portal', { timeout });
    await page.waitForTimeout(1000);

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
      throw new Error('未能获取到有效的登录 Token');
    }
  } catch (err) {
    const diagnosedReason = diagnoseNetworkError(err.message);
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

module.exports = { login, loadConfig, resolveAccount, extractLoginToken, isLoginEndpoint, JAVARUN_MD, JAVARUN_LOCAL_MD };
