import { createRequire } from 'module';
import { getConfig } from '../lib/config.js';
import { saveTokenToFile, saveLastAccount, loadLastAccount } from '../lib/token-cache.js';
import { copyToClipboard } from '../lib/clipboard.js';
import { info, success, error, quietOutput, selectOne } from '../lib/logger.js';

// 默认把 token 复制到剪贴板（除非 --no-clipboard）。quiet 模式下静默复制，不打印提示。
function maybeCopyToken(token, options) {
  if (options.clipboard === false) return;
  const ok = copyToClipboard(token);
  if (options.quiet) return;
  if (ok) {
    success('Token 已复制到剪贴板');
  } else {
    error('复制到剪贴板失败（请手动复制）');
  }
}

const require = createRequire(import.meta.url);
const { login } = require('../../login-script.cjs');

// 选择登录账户：--account 指定则直接用；
// preferLast=true（token 命令）时优先用上次账户，不交互；
// 否则交互选择（标记上次使用的账户）
async function resolveAccountName(options, { preferLast = false } = {}) {
  const { accounts, environments } = getConfig().login;
  if (accounts.length === 0) {
    throw new Error('未配置任何登录账户，请在 JAVARUN.md / JAVARUN.local.md 的 ## 登录账户 表中添加');
  }
  if (options.account) {
    const found = accounts.find(a => a.name === options.account);
    if (!found) {
      const available = accounts.map(a => a.name).join(', ');
      throw new Error(`未找到账户: ${options.account}\n可用账户: ${available}`);
    }
    return options.account;
  }
  // token 命令：优先用上次账户，免交互
  if (preferLast) {
    const last = loadLastAccount();
    if (last && accounts.find(a => a.name === last)) {
      return last;
    }
    // 没有上次记录则用第一个账户（保证非交互场景可用）
    return accounts[0].name;
  }
  // login 命令：交互选择
  const last = loadLastAccount();
  const items = accounts.map(a => {
    const env = environments.find(e => e.name === a.env);
    const envLabel = env ? a.env : `${a.env}（环境未定义）`;
    const mark = a.name === last ? '  [上次]' : '';
    return { label: `${a.name}  (${envLabel}, 主账号 ${a.mainAccount})${mark}`, value: a.name };
  });
  return await selectOne(items, '请选择登录账户');
}

async function doLogin(options, { headless, preferLast = false }) {
  const accountName = await resolveAccountName(options, { preferLast });
  info(`登录账户: ${accountName}`);

  const result = await login({ account: accountName, headless });

  if (!result.success || !result.token) {
    error('登录失败');
    return 1;
  }

  saveLastAccount(accountName);

  if (options.saveToken) {
    saveTokenToFile(result.token, options.saveToken);
    success(`Token 已保存到: ${options.saveToken}`);
  }

  if (options.quiet) {
    quietOutput(result.token);
  } else {
    console.log(JSON.stringify(result, null, 2));
  }

  maybeCopyToken(result.token, options);
  return 0;
}

export async function loginCommand(options) {
  try {
    return await doLogin(options, { headless: options.headless });
  } catch (e) {
    error(`登录失败: ${e.message}`);
    return 1;
  }
}

// token 命令：无缓存，每次重新 headless 登录获取；默认用上次账户免交互
export async function tokenCommand(options) {
  try {
    return await doLogin(options, { headless: options.headless !== false, preferLast: true });
  } catch (e) {
    error(`获取 Token 失败: ${e.message}`);
    return 1;
  }
}
