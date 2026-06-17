import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  javaTimeoutMs,
  findJavaHome,
  javaBin,
  compileExecutor,
  buildExecutorRequest,
  runExecutor,
  executorErrorResult,
  parseJavaMajorVersion,
  versionOutputAtLeast17
} from '../../src/java-runner.js';
import { resolveToolPath } from '../../src/config.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('javaTimeoutMs is defined and has reasonable value', () => {
  assert.equal(typeof javaTimeoutMs, 'number');
  assert.ok(javaTimeoutMs > 0, 'javaTimeoutMs should be positive');
  assert.ok(javaTimeoutMs >= 30000, 'javaTimeoutMs should be at least 30 seconds');
});

test('findJavaHome finds Java 17+ installation', { timeout: 10000 }, async () => {
  // This test depends on having Java installed
  try {
    const javaHome = await findJavaHome();
    assert.equal(typeof javaHome, 'string');
    assert.ok(javaHome.length > 0, 'javaHome should not be empty');
  } catch (e) {
    // If Java is not installed, this test should skip rather than fail
    // But in our CI environment we expect Java to be present
    assert.fail(`Expected to find Java 17+, but got: ${e.message}`);
  }
});

test('javaBin returns java executable path', { timeout: 10000 }, async () => {
  const binPath = await javaBin('java');
  assert.equal(typeof binPath, 'string');
  assert.ok(binPath.includes('java'), 'Path should include "java"');
});

test('compileExecutor compiles JdbcExecutor.java', { timeout: 30000 }, async () => {
  // Should complete without throwing
  await compileExecutor();
});

test('buildExecutorRequest builds correct request structure', () => {
  const db = {
    jdbcUrl: 'jdbc:mysql://localhost:3306/test',
    driverClass: 'com.mysql.cj.jdbc.Driver',
    driverJars: ['drivers/mysql-connector-j.jar'],
    username: 'root',
    password: 'secret'
  };

  const request = buildExecutorRequest({
    action: 'execute',
    db,
    options: { maxRows: 100, timeoutSeconds: 30 },
    sql: 'SELECT * FROM users WHERE id = ?',
    params: [1],
    sqlKind: 'query'
  });

  assert.equal(request.action, 'execute');
  assert.equal(request.jdbcUrl, 'jdbc:mysql://localhost:3306/test');
  assert.equal(request.driverClass, 'com.mysql.cj.jdbc.Driver');
  assert.equal(request.username, 'root');
  assert.equal(request.password, 'secret');
  assert.equal(request.sql, 'SELECT * FROM users WHERE id = ?');
  assert.deepEqual(request.params, [1]);
  assert.equal(request.maxRows, 100);
  assert.equal(request.timeoutSeconds, 30);
  assert.equal(request.sqlKind, 'query');

  // driverJars should be absolute paths
  assert.ok(Array.isArray(request.driverJars));
  assert.ok(request.driverJars.length > 0);
  assert.ok(path.isAbsolute(request.driverJars[0]), 'driverJars should be absolute paths');
});

test('buildExecutorRequest builds testConnection request', () => {
  const db = {
    jdbcUrl: 'jdbc:mysql://localhost:3306/test',
    driverClass: 'com.mysql.cj.jdbc.Driver',
    driverJars: ['drivers/mysql-connector-j.jar'],
    username: 'root',
    password: 'secret'
  };

  const request = buildExecutorRequest({
    action: 'testConnection',
    db
  });

  assert.equal(request.action, 'testConnection');
  assert.equal(request.jdbcUrl, 'jdbc:mysql://localhost:3306/test');
  assert.equal(request.driverClass, 'com.mysql.cj.jdbc.Driver');
  assert.equal(request.username, 'root');
  assert.equal(request.password, 'secret');
  assert.ok(Array.isArray(request.driverJars));
});

test('executorErrorResult returns error result structure', () => {
  const error = new Error('Test error message');
  error.hint = 'Check your Java installation';

  const result = executorErrorResult(error, 'testdb');

  assert.equal(result.success, false);
  assert.equal(result.alias, 'testdb');
  assert.equal(result.error.type, 'ExecutorError');
  assert.equal(result.error.message, 'Test error message');
  assert.equal(result.error.hint, 'Check your Java installation');
});

test('executorErrorResult works without alias', () => {
  const error = new Error('Test error');
  const result = executorErrorResult(error);

  assert.equal(result.success, false);
  assert.equal(result.alias, undefined);
  assert.equal(result.error.type, 'ExecutorError');
  assert.equal(result.error.message, 'Test error');
});

test('executorErrorResult works with string error', () => {
  const result = executorErrorResult('String error message');

  assert.equal(result.success, false);
  assert.equal(result.error.type, 'ExecutorError');
  assert.equal(result.error.message, 'String error message');
});

test('runExecutor fails with invalid database config', { timeout: 30000 }, async () => {
  // This should fail but return a proper JSON error response from Java
  const request = buildExecutorRequest({
    action: 'testConnection',
    db: {
      jdbcUrl: 'jdbc:invalid://localhost/test',
      driverClass: 'invalid.Driver',
      driverJars: ['drivers/mysql-connector-j.jar'], // valid jar but invalid driver
      username: 'test',
      password: 'test'
    }
  });

  const result = await runExecutor(request, 10);
  assert.equal(result.success, false);
  assert.ok(result.error, 'Should have error property');
});

// Java version parsing tests
test('parseJavaMajorVersion parses Java 8 correctly', () => {
  const outputs = [
    'java version "1.8.0_401"',
    'java version "1.8.0_401"\nJava(TM) SE Runtime Environment (build 1.8.0_401-b10)\nJava HotSpot(TM) 64-Bit Server VM (build 25.401-b10, mixed mode)',
    'openjdk version "1.8.0_392"'
  ];
  for (const output of outputs) {
    assert.equal(parseJavaMajorVersion(output), 8, `Failed for: ${output}`);
  }
});

test('parseJavaMajorVersion parses Java 17 correctly', () => {
  const outputs = [
    'openjdk version "17.0.10" 2024-01-16',
    'openjdk version "17.0.10" 2024-01-16\nOpenJDK Runtime Environment Temurin-17.0.10+7 (build 17.0.10+7)\nOpenJDK 64-Bit Server VM Temurin-17.0.10+7 (build 17.0.10+7, mixed mode, sharing)',
    'java version "17.0.1" 2021-10-19'
  ];
  for (const output of outputs) {
    assert.equal(parseJavaMajorVersion(output), 17, `Failed for: ${output}`);
  }
});

test('parseJavaMajorVersion parses Java 21 correctly', () => {
  const outputs = [
    'openjdk version "21" 2023-09-19',
    'openjdk version "21.0.2" 2024-01-16',
    'java version "21" 2023-09-19'
  ];
  for (const output of outputs) {
    assert.equal(parseJavaMajorVersion(output), 21, `Failed for: ${output}`);
  }
});

test('parseJavaMajorVersion parses version without quotes correctly', () => {
  // Some outputs don't use "version" keyword or quotes
  const outputs = [
    'openjdk 17.0.10 2024-01-16',
    'openjdk 21 2023-09-19'
  ];
  for (const output of outputs) {
    const version = parseJavaMajorVersion(output);
    assert.ok(version >= 17, `Expected >= 17 for: ${output}, got ${version}`);
  }
});

test('parseJavaMajorVersion returns null for invalid inputs', () => {
  const invalidInputs = [
    null,
    undefined,
    '',
    'UTF-8',
    'some random text',
    'error: could not find java',
    'version "UTF-8"', // false positive test
    'file.encoding=UTF-8', // false positive test
  ];
  for (const input of invalidInputs) {
    assert.equal(parseJavaMajorVersion(input), null, `Should return null for: ${input}`);
  }
});

test('versionOutputAtLeast17 returns correct boolean', () => {
  // Java 8 should fail
  assert.equal(versionOutputAtLeast17('java version "1.8.0_401"'), false);

  // Java 17 should pass
  assert.equal(versionOutputAtLeast17('openjdk version "17.0.10"'), true);

  // Java 21 should pass
  assert.equal(versionOutputAtLeast17('openjdk version "21"'), true);

  // Invalid input should return false
  assert.equal(versionOutputAtLeast17('invalid'), false);
  assert.equal(versionOutputAtLeast17(null), false);
  assert.equal(versionOutputAtLeast17(''), false);
});

test('parseJavaMajorVersion handles edge cases', () => {
  // Java 11
  assert.equal(parseJavaMajorVersion('openjdk version "11.0.20" 2023-07-18'), 11);

  // Java 9 (old versioning scheme transition)
  assert.equal(parseJavaMajorVersion('java version "9.0.1"'), 9);

  // Very high version (should still parse, though unlikely to exist)
  assert.equal(parseJavaMajorVersion('openjdk version "99"'), 99);
});
