import { createRequire } from 'module';
import { saveToken, saveTokenToFile, loadToken } from '../lib/token-cache.js';
import { info, success, error, quietOutput } from '../lib/logger.js';

const require = createRequire(import.meta.url);
const { login } = require('../../login-script.js');

export async function loginCommand(options) {
  try {
    const result = await login({ headless: options.headless });

    if (result.success && result.token) {
      // 缓存 token
      saveToken(result.token, {
        lastLoginTime: result.lastLoginTime,
        pageUrl: result.pageUrl,
      });

      // 保存到文件（如果指定）
      if (options.saveToken) {
        saveTokenToFile(result.token, options.saveToken);
        success(`Token 已保存到: ${options.saveToken}`);
      }

      if (options.quiet) {
        quietOutput(result.token);
      } else {
        console.log(JSON.stringify(result, null, 2));
      }

      return 0;
    } else {
      error('登录失败');
      return 1;
    }
  } catch (e) {
    error(`登录失败: ${e.message}`);
    return 1;
  }
}

export async function tokenCommand(options) {
  const token = loadToken();
  if (!token) {
    error('没有缓存的 Token，请先运行 bs-java-run login');
    return 1;
  }

  if (options.quiet) {
    quietOutput(token);
  } else {
    console.log(JSON.stringify({ token }, null, 2));
  }

  return 0;
}
