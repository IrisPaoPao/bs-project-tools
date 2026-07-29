import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

function mode(pathname) {
  return statSync(pathname).mode & 0o777;
}

test('saveLastAccount and saveTokenToFile write files with private 0o600 permissions', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'bs-java-run-token-'));
  const originalHome = process.env.HOME;
  process.env.HOME = home;

  const { saveLastAccount, loadLastAccount, saveTokenToFile, CACHE_DIR } = await import('../../src/lib/token-cache.js');

  const cacheDir = path.join(home, '.bs-java-run');
  const lastAccountFile = path.join(cacheDir, 'last-account');
  const customTokenFile = path.join(home, 'my-token.txt');

  try {
    saveLastAccount('admin-001');

    assert.equal(CACHE_DIR, cacheDir);
    assert.equal(existsSync(lastAccountFile), true);
    assert.equal(mode(cacheDir), 0o700);
    assert.equal(mode(lastAccountFile), 0o600);
    assert.equal(loadLastAccount(), 'admin-001');

    saveTokenToFile('custom-jwt-token', customTokenFile);
    assert.equal(existsSync(customTokenFile), true);
    assert.equal(mode(customTokenFile), 0o600);
    assert.equal(readFileSync(customTokenFile, 'utf8'), 'custom-jwt-token');
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
  }
});
