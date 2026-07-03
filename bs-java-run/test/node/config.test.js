import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { loadConfig } from '../../src/lib/config.js';

function writeMarkdown(dir, name, loginRows) {
  const file = path.join(dir, name);
  writeFileSync(file, `# JAVARUN.md

## java 环境地址

/opt/java

## nacos 配置参数

NACOS_HOST=base-host
NACOS_NAMESPACE=base-ns

## 服务定义

| 服务名 | 路径 | 端口 |
| ------ | ---- | ---- |
| \`demo-service\` | \`${dir}\` | 8080 |

## 登录配置

| 配置项 | 值 |
| ------ | -- |
${loginRows}
`);
  return file;
}

test('loadConfig uses JAVARUN.local.md values before tracked placeholders', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bs-java-run-config-'));
  const baseFile = writeMarkdown(dir, 'JAVARUN.md', [
    '| 登录地址 |  |',
    '| 主账号 |  |',
    '| 用户名 |  |',
    '| 密码 |  |',
    '| 登录接口 | `POST /base/login` |'
  ].join('\n'));
  const localFile = writeMarkdown(dir, 'JAVARUN.local.md', [
    '| 登录地址 | `http://local/login` |',
    '| 主账号 | `tenant` |',
    '| 用户名 | `user` |',
    '| 密码 | `secret` |',
    '| 登录接口 | `POST /local/login` |'
  ].join('\n'));

  const config = loadConfig({}, { configFile: baseFile, localConfigFile: localFile });

  assert.equal(config.login.loginUrl, 'http://local/login');
  assert.equal(config.login.mainAccount, 'tenant');
  assert.equal(config.login.username, 'user');
  assert.equal(config.login.password, 'secret');
  assert.equal(config.login.loginApi, '/local/login');
  assert.equal(config.nacosHost, 'base-host');
  assert.equal(config.services[0].name, 'demo-service');
});

test('loadConfig uses a unified startup timeout for all services', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bs-java-run-config-'));
  const baseFile = writeMarkdown(dir, 'JAVARUN.md', [
    '| 登录地址 |  |',
    '| 主账号 |  |',
    '| 用户名 |  |',
    '| 密码 |  |',
    '| 登录接口 | `POST /base/login` |'
  ].join('\n'));

  const defaultConfig = loadConfig({}, { configFile: baseFile });
  assert.equal(defaultConfig.startupTimeoutSeconds, 420);

  const envConfig = loadConfig({ BS_STARTUP_TIMEOUT: '600' }, { configFile: baseFile });
  assert.equal(envConfig.startupTimeoutSeconds, 600);
});
