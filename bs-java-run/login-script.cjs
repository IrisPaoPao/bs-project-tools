#!/usr/bin/env node
/**
 * SAAS Industry 登录脚本
 * 供 Agent 调用，自动完成登录并返回 Authorization Token
 *
 * 使用方式:
 *   node login-script.js
 *   node login-script.js --headless  # 无头模式
 *
 * 输出:
 *   stdout 输出 JSON 格式的登录结果
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const SCRIPT_DIR = __dirname;
const JAVARUN_MD = path.resolve(SCRIPT_DIR, 'JAVARUN.md');

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

function requireValue(value, key) {
  if (!value) {
    throw new Error(`JAVARUN.md 缺少登录配置: ${key}`);
  }
  return value;
}

function loginPathFromMethodLine(value) {
  return value.replace(/^[A-Z]+\s+/, '');
}

function loadConfig(env = process.env) {
  let content;
  try {
    content = fs.readFileSync(JAVARUN_MD, 'utf8');
  } catch (error) {
    throw new Error(`无法读取 JAVARUN.md: ${JAVARUN_MD} (${error.message})`);
  }

  const timeout = Number(env.BS_LOGIN_TIMEOUT || 30000);
  if (!Number.isInteger(timeout) || timeout <= 0) {
    throw new Error(`BS_LOGIN_TIMEOUT 必须是正整数毫秒值: ${env.BS_LOGIN_TIMEOUT}`);
  }

  const loginApi = env.BS_LOGIN_API || readTableValue(content, '登录接口');

  return {
    loginUrl: requireValue(env.BS_LOGIN_URL || readTableValue(content, '登录地址'), '登录地址'),
    mainAccount: requireValue(env.BS_LOGIN_MAIN_ACCOUNT || readTableValue(content, '主账号'), '主账号'),
    username: requireValue(env.BS_LOGIN_USERNAME || readTableValue(content, '用户名'), '用户名'),
    password: requireValue(env.BS_LOGIN_PASSWORD || readTableValue(content, '密码'), '密码'),
    loginApiPath: requireValue(loginPathFromMethodLine(loginApi), '登录接口'),
    timeout,
  };
}

// ============ 登录配置 ============
const CONFIG = loadConfig();

// ============ 登录函数 ============
async function login(options = {}) {
  const { headless = false, timeout = CONFIG.timeout } = options;

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
    if (url.includes(CONFIG.loginApiPath)) {
      try {
        loginResponse = await response.json();
      } catch (e) {
        // ignore
      }
    }
  });

  try {
    // 第 1 步：打开登录页
    await page.goto(CONFIG.loginUrl, { waitUntil: 'networkidle', timeout });

    // 第 2 步：填写主账号
    const mainAccountInput = page.locator('input[placeholder="请输入您的主账号"]');
    await mainAccountInput.click();
    await mainAccountInput.fill(CONFIG.mainAccount);

    // 第 3 步：填写用户名
    const usernameInput = page.locator('input[placeholder="请输入您的用户名"]');
    await usernameInput.click();
    await usernameInput.fill(CONFIG.username);

    // 第 4 步：填写密码
    const passwordInput = page.locator('input[placeholder="请输入您的密码"]');
    await passwordInput.click();
    await passwordInput.fill(CONFIG.password);

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
        token: loginResponse.token,
        authorization: loginResponse.token,
        lastLoginTime: loginResponse.lastLoginTime,
        pageUrl: page.url(),
        timestamp: new Date().toISOString(),
      };

      // 输出到 stdout
      console.log(JSON.stringify(result, null, 2));

      await browser.close();
      return result;
    } else {
      throw new Error('未能获取到登录 Token');
    }
  } catch (error) {
    const result = {
      success: false,
      error: error.message,
      pageUrl: page.url(),
      timestamp: new Date().toISOString(),
    };

    console.error(JSON.stringify(result, null, 2));

    await browser.close();
    throw error;
  }
}

// ============ 命令行入口 ============
if (require.main === module) {
  const args = process.argv.slice(2);
  const headless = args.includes('--headless');

  login({ headless })
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}

module.exports = { login, CONFIG, loadConfig };
