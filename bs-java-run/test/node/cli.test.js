import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('non-login commands do not require login credentials', () => {
  const result = spawnSync(process.execPath, ['bin/bs-java-run.js', 'status'], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8'
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /SERVICE/);
});

test('CLI exposes separate build and up commands', () => {
  const result = spawnSync(process.execPath, ['bin/bs-java-run.js', '--help'], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8'
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /build \[options\] \[service\]/);
  assert.match(result.stdout, /up \[options\] \[service\]/);
});

test('start builds only when explicitly requested', () => {
  const result = spawnSync(process.execPath, ['bin/bs-java-run.js', 'start', '--help'], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8'
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /--build/);
  assert.doesNotMatch(result.stdout, /--skip-build/);
});

test('restart builds only when explicitly requested', () => {
  const result = spawnSync(process.execPath, ['bin/bs-java-run.js', 'restart', '--help'], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8'
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /--build/);
  assert.doesNotMatch(result.stdout, /--skip-build/);
});

test('old skip-build option remains accepted as hidden compatibility flag', () => {
  const result = spawnSync(process.execPath, ['bin/bs-java-run.js', 'start', '--skip-build', '--help'], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8'
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /--build/);
  assert.doesNotMatch(result.stdout, /--skip-build/);
});
