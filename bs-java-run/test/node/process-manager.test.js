import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  buildService,
  classifyMavenFailure,
  DependencyResolutionError,
  tailLog,
} from '../../src/lib/process-manager.js';

test('tailLog reads the end of very large log files without loading the whole file', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bs-java-run-logs-'));
  const logFile = path.join(dir, 'huge-service.log');
  const originalConfig = globalThis._bsJavaRunConfig;

  fs.writeFileSync(logFile, 'start\n');
  fs.truncateSync(logFile, 600 * 1024 * 1024);
  fs.appendFileSync(logFile, 'line-a\nline-b\nline-c\n');

  globalThis._bsJavaRunConfig = { logDir: dir };

  try {
    assert.equal(tailLog('huge-service', 3), 'line-b\nline-c\n');
  } finally {
    globalThis._bsJavaRunConfig = originalConfig;
  }
});

test('classifyMavenFailure identifies dependency resolution failures', () => {
  const output = [
    '[ERROR] Failed to execute goal on project demo-app:',
    '[ERROR] Could not resolve dependencies for project com.demo:demo-app:war:1.0.0:',
    '[ERROR] Could not find artifact com.acme:missing-lib:jar:1.2.3 in nexus (http://repo.example/repository/maven-public/)',
  ].join('\n');

  const failure = classifyMavenFailure(output);

  assert.equal(failure.type, 'dependency-resolution');
  assert.match(failure.summary, /Could not resolve dependencies/);
  assert.deepEqual(failure.artifacts, ['com.acme:missing-lib:jar:1.2.3']);
  assert.deepEqual(failure.repositories, ['http://repo.example/repository/maven-public/']);
});

test('classifyMavenFailure keeps compilation failures generic', () => {
  const output = [
    '[ERROR] COMPILATION ERROR :',
    '[ERROR] /demo/src/main/java/Demo.java:[12,8] cannot find symbol',
    '[ERROR] symbol:   class MissingType',
  ].join('\n');

  const failure = classifyMavenFailure(output);

  assert.equal(failure.type, 'generic');
  assert.match(failure.summary, /COMPILATION ERROR/);
  assert.deepEqual(failure.artifacts, []);
  assert.deepEqual(failure.repositories, []);
});

test('buildService throws DependencyResolutionError for missing Maven dependencies', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bs-java-run-build-'));
  const binDir = path.join(dir, 'bin');
  const projectDir = path.join(dir, 'project');
  const mvnPath = path.join(binDir, 'mvn');
  const oldPath = process.env.PATH;

  fs.mkdirSync(binDir);
  fs.mkdirSync(projectDir);
  fs.writeFileSync(mvnPath, [
    '#!/bin/sh',
    'echo "[ERROR] Could not resolve dependencies for project com.demo:demo-app:war:1.0.0:" >&2',
    'echo "[ERROR] Could not find artifact com.acme:missing-lib:jar:1.2.3 in nexus (http://repo.example/repository/maven-public/)" >&2',
    'exit 1',
    '',
  ].join('\n'), { mode: 0o755 });

  process.env.PATH = `${binDir}${path.delimiter}${oldPath || ''}`;

  try {
    assert.throws(
      () => buildService(projectDir),
      (err) => {
        assert.ok(err instanceof DependencyResolutionError);
        assert.match(err.message, /依赖解析失败/);
        assert.match(err.message, /com\.acme:missing-lib:jar:1\.2\.3/);
        assert.match(err.message, /人工排查/);
        return true;
      }
    );
  } finally {
    process.env.PATH = oldPath;
  }
});
