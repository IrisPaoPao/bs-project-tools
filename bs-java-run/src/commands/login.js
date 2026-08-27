import { createRequire } from 'module';
import path from 'path';
import { getConfig } from '../lib/config.js';
import { saveTokenToFile, saveLastAccount, loadLastAccount } from '../lib/token-cache.js';
import { copyToClipboard } from '../lib/clipboard.js';
import { info, success, error, quietOutput, selectOne } from '../lib/logger.js';

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

/**
 * 登录脚本独立运行时默认读取工具目录配置；CLI 调用时必须沿用已加载配置所在目录，
 * 才能使工作区的 JAVARUN.local.md 与账户选择保持一致。
 */
export function getLoginConfigFile(config) {
  return path.join(config.configDirectory, 'JAVARUN.md');
}

export function filterAccountsByEnvironment(accounts, environments, environmentName) {
  if (!environmentName) return accounts;
  if (!environments.some(environment => environment.name === environmentName)) {
    const available = environments.map(environment => environment.name).join(', ');
    throw new Error(`未找到登录环境: ${environmentName}${available ? `\n可用环境: ${available}` : ''}`);
  }
  const matched = accounts.filter(account => account.env === environmentName);
  if (matched.length === 0) {
    throw new Error(`登录环境 "${environmentName}" 未配置登录账户`);
  }
  return matched;
}

async function resolveAccountName(options, { preferLast = false } = {}) {
  const config = getConfig();
  const accounts = config.accounts || [];
  const environments = config.environments || [];
  const selectedEnv = options.env || config.activeEnvName;

  const scopedAccounts = filterAccountsByEnvironment(accounts, environments, selectedEnv);
  if (scopedAccounts.length === 0) {
    throw new Error('未配置任何登录账户，请在 JAVARUN.md / JAVARUN.local.md 的 ## 账户定义 表中添加');
  }
  if (options.account) {
    const found = scopedAccounts.find(a => a.name === options.account);
    if (!found) {
      const available = scopedAccounts.map(a => a.name).join(', ');
      const scope = selectedEnv ? `（登录环境: ${selectedEnv}）` : '';
      throw new Error(`未找到账户${scope}: ${options.account}\n可用账户: ${available}`);
    }
    return options.account;
  }
  if (preferLast) {
    const last = loadLastAccount();
    if (last && scopedAccounts.find(a => a.name === last)) {
      return last;
    }
    return scopedAccounts[0].name;
  }
  const last = loadLastAccount();
  const items = scopedAccounts.map(a => {
    const env = environments.find(e => e.name === a.env);
    const envLabel = env ? a.env : `${a.env}（环境未定义）`;
    const mark = a.name === last ? '  [上次]' : '';
    return { label: `${a.name}  (${envLabel}, 主账号 ${a.mainAccount})${mark}`, value: a.name };
  });
  return await selectOne(items, '请选择登录账户');
}

async function doLogin(options, { headless, preferLast = false }) {
  const config = getConfig();
  const accountName = await resolveAccountName(options, { preferLast });
  if (!options.quiet) {
    info(`登录账户: ${accountName}`);
  }

  const result = await login({
    account: accountName,
    headless,
    configFile: getLoginConfigFile(config),
  });

  if (!result.success || !result.token) {
    if (options.quiet) console.error('登录失败');
    else error('登录失败');
    return 1;
  }

  saveLastAccount(accountName);

  if (options.saveToken) {
    saveTokenToFile(result.token, options.saveToken);
    if (!options.quiet) {
      success(`Token 已保存到: ${options.saveToken}`);
    }
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
    if (options.quiet) console.error(`登录失败: ${e.message}`);
    else error(`登录失败: ${e.message}`);
    return 1;
  }
}

export async function tokenCommand(options) {
  try {
    return await doLogin(options, { headless: options.headless !== false, preferLast: true });
  } catch (e) {
    if (options.quiet) console.error(`获取 Token 失败: ${e.message}`);
    else error(`获取 Token 失败: ${e.message}`);
    return 1;
  }
}
