import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { loadConfig } from '../../src/lib/config.js';

function writeMarkdown(dir, name, loginRows, jvmOpts = []) {
  const file = path.join(dir, name);
  writeFileSync(file, `# JAVARUN.md

## java 环境地址

/opt/java

## nacos 配置参数

NACOS_HOST=base-host
NACOS_NAMESPACE=base-ns

## JVM 参数

\`\`\`jvm-opts
${jvmOpts.join('\n')}
\`\`\`

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

test('loadConfig reads JVM opts with local and env overrides', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bs-java-run-config-'));
  const loginRows = [
    '| 登录地址 |  |',
    '| 主账号 |  |',
    '| 用户名 |  |',
    '| 密码 |  |',
    '| 登录接口 | `POST /base/login` |'
  ].join('\n');
  const baseFile = writeMarkdown(dir, 'JAVARUN.md', loginRows, [
    '-Dsaas.feign.context-path=/saas-industry',
    '-Ddemo.ribbon.listOfServers=http://127.0.0.1:81',
  ]);

  const baseConfig = loadConfig({}, { configFile: baseFile });
  assert.deepEqual(baseConfig.javaOpts, [
    '-Dsaas.feign.context-path=/saas-industry',
    '-Ddemo.ribbon.listOfServers=http://127.0.0.1:81',
  ]);

  const localFile = writeMarkdown(dir, 'JAVARUN.local.md', loginRows, [
    '-Dlocal.only=true',
  ]);
  const localConfig = loadConfig({}, { configFile: baseFile, localConfigFile: localFile });
  assert.deepEqual(localConfig.javaOpts, ['-Dlocal.only=true']);

  const envConfig = loadConfig({ JAVA_OPTS: '-Dfrom.env=true -Xmx512m' }, { configFile: baseFile, localConfigFile: localFile });
  assert.deepEqual(envConfig.javaOpts, ['-Dfrom.env=true', '-Xmx512m']);
});

test('loadConfig applies a named runtime profile without changing the default environment', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bs-java-run-config-'));
  const loginRows = [
    '| 登录地址 |  |',
    '| 主账号 |  |',
    '| 用户名 |  |',
    '| 密码 |  |',
    '| 登录接口 | `POST /base/login` |'
  ].join('\n');
  const baseFile = writeMarkdown(dir, 'JAVARUN.md', loginRows, [
    '-Dsaas.feign.context-path=/saas-industry',
    '-Dserver.servlet.context-path=/saas-industry',
    '-Dsaas-industry-basic-server.ribbon.listOfServers=http://old-gateway:30000',
    '-Dsaas-zhsf-base-server.config-base.listOfServers=http://127.0.0.1:8020',
  ]);
  const localFile = writeMarkdown(dir, 'JAVARUN.local.md', loginRows);
  writeFileSync(localFile, `${readFileSync(localFile, 'utf8')}
## 运行环境

| 运行环境 | Nacos 主机 | Nacos 命名空间 | Feign 上下文 | 服务端上下文 | 行业网关 |
|----------|------------|----------------|--------------|--------------|----------|
| zhsf-test | test-host:30050 | test-ns | test-industry-02 | /test-industry-02 | http://test-gateway:30000 |
`);

  const defaultConfig = loadConfig({}, { configFile: baseFile, localConfigFile: localFile });
  assert.equal(defaultConfig.nacosHost, 'base-host');
  assert.deepEqual(defaultConfig.javaOpts.slice(0, 2), [
    '-Dsaas.feign.context-path=/saas-industry',
    '-Dserver.servlet.context-path=/saas-industry',
  ]);

  const profileConfig = loadConfig({ BS_JAVARUN_PROFILE: 'zhsf-test' }, { configFile: baseFile, localConfigFile: localFile });
  assert.equal(profileConfig.nacosHost, 'test-host:30050');
  assert.equal(profileConfig.nacosNamespace, 'test-ns');
  assert.ok(profileConfig.javaOpts.includes('-Dsaas.feign.context-path=test-industry-02'));
  assert.ok(profileConfig.javaOpts.includes('-Dserver.servlet.context-path=/test-industry-02'));
  assert.ok(profileConfig.javaOpts.includes('-Dsaas-industry-basic-server.ribbon.listOfServers=http://test-gateway:30000'));
  assert.ok(profileConfig.javaOpts.includes('-Dsaas-zhsf-base-server.config-base.listOfServers=http://127.0.0.1:18080'));
});
