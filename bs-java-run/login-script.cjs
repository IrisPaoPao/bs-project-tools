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

function requireValue(value, key) {
  if (!value) {
    throw new Error(`JAVARUN.md 缺少登录配置: ${key}`);
  }
  return value;
}

function loginPathFromMethodLine(value) {
  return value.replace(/^[A-Z]+\s+/, '');
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

  const loginApi = env.BS_LOGIN_API || readMergedTableValue(localContent, content, '登录接口');

  return {
    loginUrl: requireValue(env.BS_LOGIN_URL || readMergedTableValue(localContent, content, '登录地址'), '登录地址'),
    mainAccount: requireValue(env.BS_LOGIN_MAIN_ACCOUNT || readMergedTableValue(localContent, content, '主账号'), '主账号'),
    username: requireValue(env.BS_LOGIN_USERNAME || readMergedTableValue(localContent, content, '用户名'), '用户名'),
    password: requireValue(env.BS_LOGIN_PASSWORD || readMergedTableValue(localContent, content, '密码'), '密码'),
    loginApiPath: requireValue(loginPathFromMethodLine(loginApi), '登录接口'),
    timeout,
  };
}

// ============ 登录函数 ============
async function login(options = {}) {
  const config = loadConfig(options.env || process.env, options.configOptions || {});
  const { headless = false, timeout = config.timeout } = options;

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
    if (url.includes(config.loginApiPath)) {
      try {
        loginResponse = await response.json();
      } catch (e) {
        // ignore
      }
    }
  });

  try {
    // 第 1 步：打开登录页
    await page.goto(config.loginUrl, { waitUntil: 'networkidle', timeout });

    // 第 2 步：填写主账号
    const mainAccountInput = page.locator('input[placeholder="请输入您的主账号"]');
    await mainAccountInput.click();
    await mainAccountInput.fill(config.mainAccount);

    // 第 3 步：填写用户名
    const usernameInput = page.locator('input[placeholder="请输入您的用户名"]');
    await usernameInput.click();
    await usernameInput.fill(config.username);

    // 第 4 步：填写密码
    const passwordInput = page.locator('input[placeholder="请输入您的密码"]');
    await passwordInput.click();
    await passwordInput.fill(config.password);

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
    .catch((error) => {
      console.error(JSON.stringify({
        success: false,
        error: error.message,
        timestamp: new Date().toISOString(),
      }, null, 2));
      process.exit(1);
    });
}

module.exports = { login, loadConfig, JAVARUN_MD, JAVARUN_LOCAL_MD };
