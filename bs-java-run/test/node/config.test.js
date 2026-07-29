import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { loadConfig, resolveServiceRuntimeConfig, mergeJvmOptions, parseJvmOptionKey } from '../../src/lib/config.js';

function writeMarkdown(dir, name, envRows = '', serviceRows = '', envServiceRows = '', jvmOpts = []) {
  const file = path.join(dir, name);
  writeFileSync(file, `# JAVARUN.md

## 运行环境

| 环境别名 | Nacos 主机 | Nacos 命名空间 | 登录地址 | 登录接口 | 行业网关 | Feign 上下文 | 服务端上下文 | 环境 JVM 参数 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
${envRows}

## 账户定义

| 账户别名 | 环境 | 主账号 | 用户名 | 密码 |
| --- | --- | --- | --- | --- |
| test-user | dev | tenant | user | 123456 |

## 服务定义

| 服务名 | 路径 | 端口 | 依赖服务 | 专属 Nacos | 专属 Nacos 命名空间 | 专属 JVM 参数 |
| --- | --- | --- | --- | --- | --- | --- |
${serviceRows}

## 环境 x 服务 专属覆盖

| 环境别名 | 服务名 | 专属 Nacos | 专属 Nacos 命名空间 | 专属 JVM 参数 |
| --- | --- | --- | --- | --- |
${envServiceRows}

## JVM 参数

\`\`\`jvm-opts
${jvmOpts.join('\n')}
\`\`\`
`);
  return file;
}

const DEFAULT_SERVICE_ROW = '| demo-service | /path/demo | 8080 | | | | |';

test('parseJvmOptionKey correct extracts keys for -D, -Xmx, -XX and ignores unrecognized', () => {
  assert.equal(parseJvmOptionKey('-Dsaas.feign.context-path=/app'), 'saas.feign.context-path');
  assert.equal(parseJvmOptionKey('-Xmx1g'), '-Xmx');
  assert.equal(parseJvmOptionKey('-Xms512m'), '-Xms');
  assert.equal(parseJvmOptionKey('-XX:+UseG1GC'), '-XX:UseG1GC');
  assert.equal(parseJvmOptionKey('-XX:MaxMetaspaceSize=256m'), '-XX:MaxMetaspaceSize');
  assert.equal(parseJvmOptionKey('-javaagent:/path/to/agent.jar'), null);
});

test('mergeJvmOptions resolves six-tier precedence and filters reserved keys', () => {
  const globalOpts = ['-Xmx512m', '-Dsaas.feign.context-path=/base', '-Dserver.port=8080'];
  const envOpts = ['-Dsaas.feign.context-path=/env-path'];
  const serviceOpts = ['-Xmx1g', '-Dservice.custom=true'];
  const envServiceOpts = ['-Dsaas.feign.context-path=/override-path'];
  const osOpts = ['-Xmx2g'];
  const cliOpts = ['-Dservice.custom=cli-override', '-javaagent:/agent.jar'];

  const merged = mergeJvmOptions(globalOpts, envOpts, serviceOpts, envServiceOpts, osOpts, cliOpts);

  assert.ok(merged.includes('-Dsaas.feign.context-path=/override-path'));
  assert.ok(merged.includes('-Xmx2g'));
  assert.ok(merged.includes('-Dservice.custom=cli-override'));
  assert.ok(merged.includes('-javaagent:/agent.jar'));
  assert.ok(!merged.some(opt => opt.startsWith('-Dserver.port=')));
});

test('loadConfig merges GFM tables by name and respects empty cell inheritance', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bs-java-run-config-'));
  const baseFile = writeMarkdown(
    dir,
    'JAVARUN.md',
    '| dev | base-host:3000 | base-ns | http://base/login | POST /base/login | http://base-gw | /base | /base | -Dbase=1 |',
    [
      '| base-service | /path/base | 8080 | | | | |',
      '| demo-service | /path/demo | 8081 | base-service | | | |',
    ].join('\n'),
  );

  const localFile = writeMarkdown(
    dir,
    'JAVARUN.local.md',
    '| dev | local-host:3000 |  |  |  |  |  |  | -Dlocal=2 |',
    '| demo-service | /path/local | 8081 | | | | |',
  );

  const config = loadConfig({}, { configFile: baseFile, localConfigFile: localFile, env: 'dev' });

  assert.equal(config.activeEnv.nacosHost, 'local-host:3000');
  assert.equal(config.activeEnv.nacosNamespace, 'base-ns');
  const demoService = config.services.find(service => service.name === 'demo-service');
  assert.equal(demoService.path, '/path/local');
  assert.deepEqual(demoService.dependsOn, ['base-service']);
});

test('resolveServiceRuntimeConfig resolves final service-level nacos and javaOpts', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bs-java-run-config-'));
  const baseFile = writeMarkdown(
    dir,
    'JAVARUN.md',
    '| dev | base-nacos | dev-ns | http://login | POST /login | http://gw | /feign | /server | -Denv=true |',
    '| biz-service | /path/biz | 8082 | | | | -Xmx512m |',
    '| dev | biz-service | override-nacos | override-ns | -Doverride=true |',
  );

  const localFile = writeMarkdown(
    dir,
    'JAVARUN.local.md',
    '',
    '',
    '| dev | biz-service | local-nacos | | -Dlocal.override=true |',
  );
  const config = loadConfig({}, { configFile: baseFile, localConfigFile: localFile, env: 'dev' });
  const runtime = resolveServiceRuntimeConfig(config, 'biz-service', {
    javaOpt: ['-Xmx1g', '-Dcli.override=true'],
  });

  assert.equal(runtime.nacosHost, 'local-nacos');
  assert.equal(runtime.nacosNamespace, 'override-ns');
  assert.ok(runtime.javaOpts.includes('-Xmx1g'));
  assert.ok(!runtime.javaOpts.includes('-Doverride=true'));
  assert.ok(runtime.javaOpts.includes('-Dlocal.override=true'));
  assert.ok(runtime.javaOpts.includes('-Dcli.override=true'));
});

test('loadConfig reads java home from the local machine configuration first', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bs-java-run-config-'));
  const baseFile = writeMarkdown(dir, 'JAVARUN.md', '', DEFAULT_SERVICE_ROW);
  const localFile = writeMarkdown(dir, 'JAVARUN.local.md', '', DEFAULT_SERVICE_ROW);
  writeFileSync(localFile, '\n## java 环境地址\n\n/opt/Java/local-home\n', { flag: 'a' });

  const config = loadConfig({}, { configFile: baseFile, localConfigFile: localFile });
  assert.equal(config.javaHome, '/opt/Java/local-home');
});

test('loadConfig accepts an old runtime and login table layout during migration', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bs-java-run-config-'));
  const file = path.join(dir, 'JAVARUN.md');
  writeFileSync(file, `## 运行环境

| 运行环境 | Nacos 主机 | Nacos 命名空间 | Feign 上下文 | 服务端上下文 | 行业网关 |
| --- | --- | --- | --- | --- | --- |
| legacy | legacy-nacos | legacy-ns | /legacy | /legacy | http://gateway |

## 登录环境

| 别名 | 登录地址 | 登录接口 |
| --- | --- | --- |
| legacy | http://login | POST /login |

## 服务定义

| 服务名 | 路径 | 端口 |
| --- | --- | --- |
| legacy-service | /path/legacy | 8080 |
`);

  const config = loadConfig({}, { configFile: file, env: 'legacy' });
  assert.equal(config.activeEnv.nacosHost, 'legacy-nacos');
  assert.equal(config.activeEnv.loginUrl, 'http://login');
  assert.equal(config.services[0].name, 'legacy-service');
});

test('loadConfig detects conflicting --env and --profile', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bs-java-run-config-'));
  const envRows = [
    '| dev | host | ns | url | api | gw | feign | server | |',
    '| test | host2 | ns2 | url2 | api2 | gw2 | feign2 | server2 | |',
  ].join('\n');
  const baseFile = writeMarkdown(dir, 'JAVARUN.md', envRows, DEFAULT_SERVICE_ROW);

  assert.throws(
    () => loadConfig({}, { configFile: baseFile, env: 'dev', profile: 'test' }),
    /参数冲突: --env \(dev\) 与 --profile \(test\)/,
  );
});

test('loadConfig validates duplicate service names and ports', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bs-java-run-config-'));
  const serviceRows = [
    '| dup-service | /path1 | 8080 | | | | |',
    '| dup-service | /path2 | 8081 | | | | |',
  ].join('\n');
  const file1 = writeMarkdown(dir, 'JAVARUN.md', '', serviceRows);

  assert.throws(
    () => loadConfig({}, { configFile: file1 }),
    /存在重复的服务名: dup-service/,
  );
});
