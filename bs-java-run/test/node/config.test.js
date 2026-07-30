import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  getActiveEnvironmentServices,
  loadConfig,
  mergeJvmOptions,
  parseJvmOptionKey,
  resolveServiceRuntimeConfig,
} from '../../src/lib/config.js';

function renderGroups(groups = {}) {
  return Object.entries(groups).map(([name, options]) => `### ${name}\n\n\`\`\`jvm-env-opts\n${options.join('\n')}\n\`\`\``).join('\n\n');
}

function writeMarkdown(dir, name, {
  envRows = '',
  accountRows = '| test-user | dev | tenant | user | 123456 |',
  serviceRows = '',
  environmentServiceRows = '',
  groups = {},
} = {}) {
  const file = path.join(dir, name);
  writeFileSync(file, `# JAVARUN.md

## 运行环境

| 环境名 | Nacos 主机 | Nacos 命名空间 | 登录地址 | 登录接口 | 行业网关 | Feign 上下文 | 服务端上下文 |
| --- | --- | --- | --- | --- | --- | --- | --- |
${envRows}

## 账户定义

| 账户别名 | 环境 | 主账号 | 用户名 | 密码 |
| --- | --- | --- | --- | --- |
${accountRows}

## 服务定义

| 服务名 | 路径 | 端口 | 依赖服务 |
| --- | --- | --- | --- |
${serviceRows}

## 环境服务

| 环境名 | 服务名 | 专属 JVM 参数 |
| --- | --- | --- |
${environmentServiceRows}

## JVM 参数组

${renderGroups(groups)}
`);
  return file;
}

const DEFAULT_ENV_ROW = '| dev | host | ns | http://login | POST /login | http://gateway | /feign | /server |';
const DEFAULT_SERVICE_ROW = '| demo-service | /path/demo | 8080 | |';
const DEFAULT_ENV_SERVICE_ROW = '| dev | demo-service | |';

test('parseJvmOptionKey extracts keys for -D, -Xmx, -XX and ignores unrecognized options', () => {
  assert.equal(parseJvmOptionKey('-Dsaas.feign.context-path=/app'), 'saas.feign.context-path');
  assert.equal(parseJvmOptionKey('-Xmx1g'), '-Xmx');
  assert.equal(parseJvmOptionKey('-Xms512m'), '-Xms');
  assert.equal(parseJvmOptionKey('-XX:+UseG1GC'), '-XX:UseG1GC');
  assert.equal(parseJvmOptionKey('-XX:MaxMetaspaceSize=256m'), '-XX:MaxMetaspaceSize');
  assert.equal(parseJvmOptionKey('-javaagent:/path/to/agent.jar'), null);
});

test('mergeJvmOptions resolves environment-service, OS and CLI precedence', () => {
  const merged = mergeJvmOptions(
    ['-Xmx1g', '-Denv=true'],
    ['-Dservice=true'],
    ['-Xmx2g'],
    ['-Dservice=cli-override', '-javaagent:/agent.jar', '-Dserver.port=8080'],
  );

  assert.ok(merged.includes('-Xmx2g'));
  assert.ok(merged.includes('-Denv=true'));
  assert.ok(merged.includes('-Dservice=cli-override'));
  assert.ok(merged.includes('-javaagent:/agent.jar'));
  assert.ok(!merged.some(option => option.startsWith('-Dserver.port=')));
});

test('loadConfig merges environment and service tables while retaining local inheritance', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bs-java-run-config-'));
  const baseFile = writeMarkdown(dir, 'JAVARUN.md', {
    envRows: '| dev | base-host:3000 | base-ns | http://base/login | POST /base/login | http://base-gw | /base | /base |',
    serviceRows: [
      '| base-service | /path/base | 8080 | |',
      '| demo-service | /path/demo | 8081 | base-service |',
    ].join('\n'),
    environmentServiceRows: [
      '| dev | base-service | |',
      '| dev | demo-service | -Xmx512m |',
    ].join('\n'),
  });
  const localFile = writeMarkdown(dir, 'JAVARUN.local.md', {
    envRows: '| dev | local-host:3000 |  |  |  |  |  |  |',
    serviceRows: '| demo-service | /path/local | 8081 | |',
    environmentServiceRows: '',
    accountRows: '',
  });

  const config = loadConfig({}, { configFile: baseFile, localConfigFile: localFile, env: 'dev' });
  const demoService = config.services.find(service => service.name === 'demo-service');

  assert.equal(config.activeEnv.nacosHost, 'local-host:3000');
  assert.equal(config.activeEnv.nacosNamespace, 'base-ns');
  assert.equal(demoService.path, '/path/local');
  assert.deepEqual(demoService.dependsOn, ['base-service']);
});

test('resolveServiceRuntimeConfig uses environment and environment-service JVM groups', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bs-java-run-config-'));
  const baseFile = writeMarkdown(dir, 'JAVARUN.md', {
    envRows: DEFAULT_ENV_ROW,
    serviceRows: DEFAULT_SERVICE_ROW,
    environmentServiceRows: '| dev | demo-service | -Xmx1g -Dservice=true |',
    groups: {
      dev: ['-Denv=true'],
    },
  });

  const config = loadConfig({ JAVA_OPTS: '-Xmx2g' }, { configFile: baseFile, env: 'dev' });
  const runtime = resolveServiceRuntimeConfig(config, 'demo-service', {
    javaOpt: ['-Dservice=cli-override'],
  });

  assert.equal(runtime.nacosHost, 'host');
  assert.equal(runtime.nacosNamespace, 'ns');
  assert.ok(runtime.javaOpts.includes('-Denv=true'));
  assert.ok(runtime.javaOpts.includes('-Dsaas.feign.context-path=/feign'));
  assert.ok(runtime.javaOpts.includes('-Dserver.servlet.context-path=/server'));
  assert.ok(runtime.javaOpts.includes('-Xmx2g'));
  assert.ok(runtime.javaOpts.includes('-Dservice=cli-override'));
});

test('getActiveEnvironmentServices only exposes services enabled for the selected environment', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bs-java-run-config-'));
  const baseFile = writeMarkdown(dir, 'JAVARUN.md', {
    envRows: [DEFAULT_ENV_ROW, '| test | host2 | ns2 | http://login2 | POST /login | http://gateway2 | /feign2 | /server2 |'].join('\n'),
    serviceRows: [
      '| base-service | /path/base | 8080 | |',
      '| demo-service | /path/demo | 8081 | base-service |',
    ].join('\n'),
    environmentServiceRows: [
      '| dev | base-service | |',
      '| dev | demo-service | |',
      '| test | base-service | |',
    ].join('\n'),
  });
  const config = loadConfig({}, { configFile: baseFile, env: 'dev' });

  assert.deepEqual(getActiveEnvironmentServices(config).map(service => service.name), ['base-service', 'demo-service']);
  assert.throws(() => getActiveEnvironmentServices({ ...config, activeEnvName: '', activeEnv: null }), /必须通过 --env 或 BS_ENV/);
});

test('loadConfig rejects legacy global JVM and service-scoped configuration', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bs-java-run-config-'));
  const legacyJvm = path.join(dir, 'legacy-jvm.md');
  writeFileSync(legacyJvm, '## JVM 参数\n\n```jvm-opts\n-Dlegacy=true\n```\n');
  assert.throws(() => loadConfig({}, { configFile: legacyJvm }), /不再支持全局 JVM 参数/);

  const legacyService = writeMarkdown(dir, 'legacy-service.md', {
    envRows: DEFAULT_ENV_ROW,
    serviceRows: '| demo-service | /path/demo | 8080 | | | | -Xmx512m |',
    environmentServiceRows: DEFAULT_ENV_SERVICE_ROW,
  });
  assert.throws(() => loadConfig({}, { configFile: legacyService }), /服务定义只支持/);

  const legacyEnvironment = path.join(dir, 'legacy-environment.md');
  writeFileSync(legacyEnvironment, '## 运行环境\n\n| 环境别名 | Nacos 主机 |\n| --- | --- |\n| dev | host |\n');
  assert.throws(() => loadConfig({}, { configFile: legacyEnvironment }), /不再支持旧环境配置/);
});

test('loadConfig rejects environment-managed and duplicate JVM options', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bs-java-run-config-'));
  const contextFile = writeMarkdown(dir, 'context.md', {
    envRows: DEFAULT_ENV_ROW,
    serviceRows: DEFAULT_SERVICE_ROW,
    environmentServiceRows: DEFAULT_ENV_SERVICE_ROW,
    groups: { dev: ['-Dserver.servlet.context-path=/illegal'] },
  });
  assert.throws(() => loadConfig({}, { configFile: contextFile, env: 'dev' }), /不允许配置 server\.servlet\.context-path/);

  const duplicateFile = writeMarkdown(dir, 'duplicate.md', {
    envRows: DEFAULT_ENV_ROW,
    serviceRows: DEFAULT_SERVICE_ROW,
    environmentServiceRows: DEFAULT_ENV_SERVICE_ROW,
    groups: { dev: ['-Xmx512m', '-Xmx1g'] },
  });
  assert.throws(() => loadConfig({}, { configFile: duplicateFile, env: 'dev' }), /重复 JVM 参数: -Xmx/);
});

test('loadConfig rejects a JVM parameter group without a matching environment', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bs-java-run-config-'));
  const configFile = writeMarkdown(dir, 'global-group.md', {
    envRows: DEFAULT_ENV_ROW,
    serviceRows: DEFAULT_SERVICE_ROW,
    environmentServiceRows: DEFAULT_ENV_SERVICE_ROW,
    groups: { common: ['-Dlegacy.global=true'] },
  });

  assert.throws(() => loadConfig({}, { configFile }), /JVM 参数组 common 未对应已配置的运行环境/);
});

test('loadConfig validates custom environment names and conflicting environment arguments', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bs-java-run-config-'));
  const baseFile = writeMarkdown(dir, 'JAVARUN.md', {
    envRows: [DEFAULT_ENV_ROW, '| 52test | host2 | ns2 | http://login2 | POST /login2 | http://gateway2 | /feign2 | /server2 |'].join('\n'),
    serviceRows: DEFAULT_SERVICE_ROW,
    environmentServiceRows: DEFAULT_ENV_SERVICE_ROW,
  });

  assert.throws(
    () => loadConfig({}, { configFile: baseFile, env: 'dev', profile: '52test' }),
    /参数冲突: --env \(dev\) 与 --profile \(52test\)/,
  );
  assert.throws(
    () => loadConfig({}, { configFile: baseFile, env: 'missing' }),
    /未知环境: missing.*dev, 52test/,
  );
});

test('loadConfig rejects accounts and service dependencies outside their environment', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bs-java-run-config-'));
  const accountFile = writeMarkdown(dir, 'invalid-account.md', {
    envRows: DEFAULT_ENV_ROW,
    accountRows: '| test-user | missing | tenant | user | 123456 |',
    serviceRows: DEFAULT_SERVICE_ROW,
    environmentServiceRows: DEFAULT_ENV_SERVICE_ROW,
  });
  assert.throws(() => loadConfig({}, { configFile: accountFile }), /账户 test-user 引用了未配置环境/);

  const dependencyFile = writeMarkdown(dir, 'invalid-dependency.md', {
    envRows: DEFAULT_ENV_ROW,
    serviceRows: [
      '| base-service | /path/base | 8080 | |',
      '| demo-service | /path/demo | 8081 | base-service |',
    ].join('\n'),
    environmentServiceRows: '| dev | demo-service | |',
  });
  assert.throws(() => loadConfig({}, { configFile: dependencyFile }), /启用了 demo-service，但未启用其依赖服务 base-service/);
});
