import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { extractLoginToken, isLoginEndpoint, loadConfig, loadLoginConfig, resolveAccount } = require('../../login-script.cjs');

test('extractLoginToken supports authorization and legacy token response wrappers', () => {
  assert.equal(extractLoginToken({ authorization: 'root-authorization' }), 'root-authorization');
  assert.equal(extractLoginToken({ response: { authorization: 'response-authorization' } }), 'response-authorization');
  assert.equal(extractLoginToken({ data: { authorization: 'data-authorization' } }), 'data-authorization');
  assert.equal(extractLoginToken({ token: 'root-token' }), 'root-token');
  assert.equal(extractLoginToken({ response: { token: 'response-token' } }), 'response-token');
  assert.equal(extractLoginToken({ data: { token: 'data-token' } }), 'data-token');
  assert.equal(extractLoginToken({ result: { token: 'result-token' } }), 'result-token');
  assert.equal(extractLoginToken({ data: {} }), null);
});

test('isLoginEndpoint rejects unrelated business requests', () => {
  const resolved = { loginApiPath: '/saas/login' };
  assert.equal(isLoginEndpoint('http://example/saas/login', resolved), true);
  assert.equal(isLoginEndpoint('http://example/other/api', resolved), false);
});

test('login script reads the unified runtime environment table', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bs-java-run-login-'));
  const configFile = path.join(dir, 'JAVARUN.md');
  writeFileSync(configFile, `## 运行环境

| 环境名 | Nacos 主机 | Nacos 命名空间 | 登录地址 | 登录接口 | 行业网关 | Feign 上下文 | 服务端上下文 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 52test | host | namespace | http://login | POST /login | http://gateway | /feign | /server |

## 账户定义

| 账户别名 | 环境 | 主账号 | 用户名 | 密码 |
| --- | --- | --- | --- | --- |
| test-account | 52test | tenant | user | password |
`);

  const config = loadConfig({}, { configFile, localConfigFile: path.join(dir, 'missing.local.md') });
  const account = resolveAccount(config, 'test-account');

  assert.equal(config.environments[0].name, '52test');
  assert.equal(account.loginUrl, 'http://login');
  assert.equal(account.loginApiPath, '/login');
});

test('login script reads a private account next to an explicitly provided workspace config file', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bs-java-run-workspace-login-'));
  const configFile = path.join(dir, 'JAVARUN.md');
  const localConfigFile = path.join(dir, 'JAVARUN.local.md');
  writeFileSync(configFile, `## 运行环境

| 环境名 | Nacos 主机 | Nacos 命名空间 | 登录地址 | 登录接口 | 行业网关 | Feign 上下文 | 服务端上下文 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| dev | host | namespace | http://login | POST /login | http://gateway | /feign | /server |
`);
  writeFileSync(localConfigFile, `## 账户定义

| 账户别名 | 环境 | 主账号 | 用户名 | 密码 |
| --- | --- | --- | --- | --- |
| workspace-account | dev | tenant | user | password |
`);

  const config = loadLoginConfig({ env: {}, configFile });
  const account = resolveAccount(config, 'workspace-account');

  assert.equal(account.accountName, 'workspace-account');
  assert.equal(account.envName, 'dev');
});
