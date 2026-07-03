import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

function mode(pathname) {
  return statSync(pathname).mode & 0o777;
}

test('saveToken writes cache directory and token file with private permissions', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'bs-java-run-token-'));
  const originalHome = process.env.HOME;
  process.env.HOME = home;

  const { saveToken, CACHE_DIR, TOKEN_FILE } = await import('../../src/lib/token-cache.js');

  const cacheDir = path.join(home, '.bs-java-run');
  const tokenFile = path.join(cacheDir, 'token.json');

  try {
    saveToken('secret-token');

    assert.equal(CACHE_DIR, cacheDir);
    assert.equal(TOKEN_FILE, tokenFile);
    assert.equal(existsSync(tokenFile), true);
    assert.equal(mode(cacheDir), 0o700);
    assert.equal(mode(tokenFile), 0o600);
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
  }
});
