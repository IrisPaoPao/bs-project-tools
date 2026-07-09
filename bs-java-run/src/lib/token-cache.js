import fs from 'fs';
import path from 'path';
import os from 'os';

const CACHE_DIR = path.join(os.homedir(), '.bs-java-run');
const LAST_ACCOUNT_FILE = path.join(CACHE_DIR, 'last-account');

function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 });
  } else {
    fs.chmodSync(CACHE_DIR, 0o700);
  }
}

// 不再缓存 token：每次需要都重新登录获取。
// 只保留一个“上次使用的账户名”指针，供 login/token 默认选中。

export function saveLastAccount(accountName) {
  ensureCacheDir();
  fs.writeFileSync(LAST_ACCOUNT_FILE, String(accountName || ''), { mode: 0o600 });
  fs.chmodSync(LAST_ACCOUNT_FILE, 0o600);
}

export function loadLastAccount() {
  if (!fs.existsSync(LAST_ACCOUNT_FILE)) return null;
  const name = fs.readFileSync(LAST_ACCOUNT_FILE, 'utf8').trim();
  return name || null;
}

// 显式保存 token 到用户指定文件（不算缓存，由 --save-token 触发）
export function saveTokenToFile(token, filePath) {
  fs.writeFileSync(filePath, token, { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

export { CACHE_DIR };
