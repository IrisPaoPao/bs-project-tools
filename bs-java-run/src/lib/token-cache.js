import fs from 'fs';
import path from 'path';
import os from 'os';

const CACHE_DIR = path.join(os.homedir(), '.bs-java-run');
const TOKEN_FILE = path.join(CACHE_DIR, 'token.json');

function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 });
  } else {
    fs.chmodSync(CACHE_DIR, 0o700);
  }
}

export function saveToken(token, metadata = {}) {
  ensureCacheDir();
  const data = {
    token,
    savedAt: new Date().toISOString(),
    ...metadata,
  };
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.chmodSync(TOKEN_FILE, 0o600);
}

export function loadToken() {
  if (!fs.existsSync(TOKEN_FILE)) {
    return null;
  }
  try {
    const data = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
    return data.token || null;
  } catch {
    return null;
  }
}

export function loadTokenMetadata() {
  if (!fs.existsSync(TOKEN_FILE)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
  } catch {
    return null;
  }
}

export function clearToken() {
  if (fs.existsSync(TOKEN_FILE)) {
    fs.unlinkSync(TOKEN_FILE);
  }
}

export function saveTokenToFile(token, filePath) {
  fs.writeFileSync(filePath, token, { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

export { TOKEN_FILE, CACHE_DIR };
