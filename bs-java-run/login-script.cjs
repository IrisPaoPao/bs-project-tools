#!/usr/bin/env node
/**
 * SAAS Industry 登录脚本
 * 供 Agent 调用，自动完成登录并返回 Authorization Token
 *
 * 使用方式:
 *   node login-script.cjs
 *   node login-script.cjs --headless  # 无头模式
 *
 * 输出:
 *   stdout 输出 JSON 格式的登录结果
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const SCRIPT_DIR = __dirname;
const JAVARUN_MD = path.resolve(SCRIPT_DIR, 'JAVARUN.md');
const JAVARUN_LOCAL_MD = path.resolve(SCRIPT_DIR, 'JAVARUN.local.md');

function stripMarkdownValue(value) {
  return value.trim().replace(/^`|`$/g, '');
}

// 解析多列表格：按表头首列单元格定位，返回每行单元格数组
function parseMultiColumnTable(content, headerFirstCell) {
  const rows = [];
  const lines = String(content || '').split(/\r?\n/);
  let inTable = false;

  for (const line of lines) {
    if (!line.trim().startsWith('|')) {
      inTable = false;
      continue;
    }
    const cells = line.split('|').slice(1, -1).map(stripMarkdownValue);
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
  return parseMultiColumnTable(content, '别名')
    .map(cells => ({
      name: cells[0],
      loginUrl: cells[1] || '',
      loginApi: (cells[2] || '').replace(/^[A-Z]+\s+/, ''),
    }))
    .filter(e => e.name);
}

function parseLoginAccounts(content) {
  return parseMultiColumnTable(content, '账户名')
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
  for (const item of globalList) map.set(item.name, item);
  for (const item of localList) map.set(item.name, item);
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

// 根据账户名解析出完整登录配置；accountName 为空时用第一个账户
function resolveAccount(config, accountName) {
  if (config.accounts.length === 0) {
    throw new Error('JAVARUN.md / JAVARUN.local.md 未配置任何登录账户（## 登录账户 表）');
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
    throw new Error(`账户 "${account.name}" 引用的环境 "${account.env}" 不存在，请在 ## 登录环境 表中定义`);
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

// ============ 登录函数 ============
async function login(options = {}) {
  const config = loadConfig(options.env || process.env, options.configOptions || {});
  // options.account 可为账户名字符串；不传则用第一个账户
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

  // 用于捕获登录接口的响应
  let loginResponse = null;

  // 监听登录接口响应
  page.on('response', async (response) => {
    const url = response.url();
    if (url.includes(resolved.loginApiPath)) {
      try {
        loginResponse = await response.json();
      } catch (e) {
        // ignore
      }
    }
  });

  try {
    // 第 1 步：打开登录页
    await page.goto(resolved.loginUrl, { waitUntil: 'networkidle', timeout });

    // 第 2 步：填写主账号
    const mainAccountInput = page.locator('input[placeholder="请输入您的主账号"]');
    await mainAccountInput.click();
    await mainAccountInput.fill(resolved.mainAccount);

    // 第 3 步：填写用户名
    const usernameInput = page.locator('input[placeholder="请输入您的用户名"]');
    await usernameInput.click();
    await usernameInput.fill(resolved.username);

    // 第 4 步：填写密码
    const passwordInput = page.locator('input[placeholder="请输入您的密码"]');
    await passwordInput.click();
    await passwordInput.fill(resolved.password);

    // 第 5 步：点击登录按钮
    const loginButton = page.locator('button.login-btn');
    await loginButton.click();

    // 第 6 步：等待页面跳转到 portal
    await page.waitForURL('**/portal', { timeout });

    // 等待一小段时间确保所有请求完成
    await page.waitForTimeout(1000);

    // 从监听到的登录响应中获取 token
    if (loginResponse && loginResponse.token) {
      const result = {
        success: true,
        account: resolved.accountName,
        env: resolved.envName,
        token: loginResponse.token,
        authorization: loginResponse.token,
        lastLoginTime: loginResponse.lastLoginTime,
        pageUrl: page.url(),
        timestamp: new Date().toISOString(),
      };

      if (emitOutput) {
        console.log(JSON.stringify(result, null, 2));
      }

      await browser.close();
      return result;
    } else {
      throw new Error('未能获取到登录 Token');
    }
  } catch (err) {
    const result = {
      success: false,
      account: resolved.accountName,
      env: resolved.envName,
      error: err.message,
      pageUrl: page.url(),
      timestamp: new Date().toISOString(),
    };

    if (emitOutput) {
      console.error(JSON.stringify(result, null, 2));
    }

    await browser.close();
    throw err;
  }
}

// ============ 命令行入口 ============
if (require.main === module) {
  const args = process.argv.slice(2);
  const headless = args.includes('--headless');

  // 支持 --account <name>
  let account = null;
  const accountIdx = args.indexOf('--account');
  if (accountIdx !== -1 && args[accountIdx + 1]) {
    account = args[accountIdx + 1];
  }

  login({ account, headless, emitOutput: true })
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}

module.exports = { login, loadConfig, resolveAccount, JAVARUN_MD, JAVARUN_LOCAL_MD };
