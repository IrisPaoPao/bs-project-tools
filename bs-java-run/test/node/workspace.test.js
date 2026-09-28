import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../../src/lib/config.js';
import { doctorWorkspace, initWorkspace, reconfigureWorkspace, smokeWorkspace, updateWorkspace } from '../../src/commands/workspace.js';

const require = createRequire(import.meta.url);
const { loadConfig: loadLoginConfig } = require('../../login-script.cjs');

function createProject(root, name, { port } = {}) {
  const project = path.join(root, name);
  const server = path.join(project, `${name}-server`);
  fs.mkdirSync(path.join(server, 'src/main/resources'), { recursive: true });
  fs.writeFileSync(path.join(project, 'pom.xml'), `<project><artifactId>${name}</artifactId></project>`, 'utf8');
  if (port) {
    fs.writeFileSync(path.join(server, 'src/main/resources/application.yml'), `server:\n  port: ${port}\n`, 'utf8');
  }
  return project;
}

function createWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-java-run-workspace-'));
  createProject(root, 'demo-service', { port: 19001 });
  createProject(root, 'demo-sdk', { port: 19002 });
  fs.mkdirSync(path.join(root, 'pom-only'));
  fs.writeFileSync(path.join(root, 'pom-only/pom.xml'), '<project/>', 'utf8');
  return root;
}

function testSetup() {
  return {
    javaHome: '',
    environments: [{
      name: 'workspace-test',
      nacosHost: '127.0.0.1:8848',
      nacosNamespace: 'workspace-test',
      loginUrl: 'http://127.0.0.1/login',
      loginApi: '/login',
      industryGateway: 'http://127.0.0.1:30000',
      feignContextPath: '',
      serverContextPath: '',
    }],
    accounts: [{
      name: 'workspace-user',
      env: 'workspace-test',
      mainAccount: 'tenant',
      username: 'tester',
      password: 'test-password',
    }],
  };
}

function environmentSetup(name, nacosHost = '127.0.0.1:8848') {
  return {
    javaHome: '',
    environments: [{
      name,
      nacosHost,
      nacosNamespace: `${name}-namespace`,
      loginUrl: `http://${name}.example/login`,
      loginApi: '/login',
      industryGateway: '',
      feignContextPath: '',
      serverContextPath: '',
    }],
    accounts: [],
  };
}

async function captureConsole(action) {
  const original = console.log;
  const output = [];
  console.log = (...args) => output.push(args.join(' '));
  try {
    await action();
  } finally {
    console.log = original;
  }
  return output.join('\n');
}

test('workspace init generates isolated config, redacted local template and forwarding script', async () => {
  const root = createWorkspace();
  try {
    const configDir = path.join(root, '.bs-java-run');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, '.gitignore'), 'custom-rule\nlogs/\n', 'utf8');
    assert.equal(await initWorkspace(root, { setup: testSetup() }), 0);
    const managed = fs.readFileSync(path.join(configDir, 'JAVARUN.md'), 'utf8');
    const local = fs.readFileSync(path.join(configDir, 'JAVARUN.local.md'), 'utf8');
    const ignore = fs.readFileSync(path.join(configDir, '.gitignore'), 'utf8');
    const manifest = JSON.parse(fs.readFileSync(path.join(configDir, 'workspace-manifest.json'), 'utf8'));

    assert.match(managed, /demo-service/);
    assert.doesNotMatch(managed, /demo-sdk/);
    assert.match(managed, /19001/);
    assert.match(managed, /workspace-test/);
    assert.doesNotMatch(managed, /52-saas-industry-dev/);
    assert.match(local, /workspace-user/);
    assert.match(local, /test-password/);
    assert.equal(fs.statSync(path.join(configDir, 'JAVARUN.local.md')).mode & 0o777, 0o600);
    assert.match(ignore, /custom-rule/);
    assert.match(ignore, /^\/history\/$/m);
    assert.match(ignore, /^\/JAVARUN\.local\.md\.bak-\*$/m);
    assert.ok(fs.statSync(path.join(root, 'javarun')).mode & 0o111);
    assert.equal(spawnSync('bash', ['-n', path.join(root, 'javarun')]).status, 0);
    assert.equal(manifest.services[0].name, 'demo-service');
    assert.equal(manifest.inference['demo-service'].port, '配置文件:demo-service-server/src/main/resources/application.yml');

    const config = loadConfig({ BS_JAVARUN_WORKSPACE: root });
    assert.equal(config.logDir, path.join(configDir, 'logs'));
    assert.equal(config.services[0].path, path.join(root, 'demo-service'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('workspace update preserves local config and refuses to overwrite managed edits', async () => {
  const root = createWorkspace();
  try {
    await initWorkspace(root, { setup: testSetup() });
    const configDir = path.join(root, '.bs-java-run');
    const localFile = path.join(configDir, 'JAVARUN.local.md');
    fs.appendFileSync(localFile, '\n<!-- local edit -->\n', 'utf8');
    const localBefore = fs.readFileSync(localFile, 'utf8');
    fs.chmodSync(localFile, 0o644);
    const localBackup = path.join(configDir, 'JAVARUN.local.md.bak-existing');
    fs.writeFileSync(localBackup, 'private backup contents', { mode: 0o644 });
    const historyDir = path.join(configDir, 'history');
    fs.mkdirSync(historyDir, { mode: 0o755 });
    const historyFile = path.join(historyDir, 'account-history.json');
    fs.writeFileSync(historyFile, 'private history contents', { mode: 0o644 });
    fs.chmodSync(historyDir, 0o755);
    assert.equal(await updateWorkspace(root), 0);
    assert.equal(fs.readFileSync(localFile, 'utf8'), localBefore);
    assert.equal(fs.statSync(localFile).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(localBackup, 'utf8'), 'private backup contents');
    assert.equal(fs.statSync(localBackup).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(historyFile, 'utf8'), 'private history contents');
    assert.equal(fs.statSync(historyFile).mode & 0o777, 0o600);
    assert.equal(fs.statSync(historyDir).mode & 0o777, 0o700);

    const managedFile = path.join(configDir, 'JAVARUN.md');
    fs.appendFileSync(managedFile, '\n<!-- managed edit -->\n', 'utf8');
    await assert.rejects(() => updateWorkspace(root), /手工修改/);
    assert.ok(fs.existsSync(path.join(configDir, 'JAVARUN.md.generated.next')));
    assert.ok(fs.existsSync(path.join(configDir, 'JAVARUN.md.update.diff')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('workspace doctor accepts a generated workspace without prebuilt WAR as a warning', async () => {
  const root = createWorkspace();
  try {
    await initWorkspace(root, { setup: testSetup() });
    assert.equal(await doctorWorkspace(root), 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('workspace init requires interactive input when setup is not supplied', async () => {
  const root = createWorkspace();
  try {
    await assert.rejects(() => initWorkspace(root), /需要交互式终端/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('workspace init and update never read the tool-level JAVARUN.md', async () => {
  const root = createWorkspace();
  const toolConfigFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../JAVARUN.md');
  const originalRead = fs.readFileSync;
  const previousWorkspace = process.env.BS_JAVARUN_WORKSPACE;
  let forbiddenReads = 0;
  try {
    process.env.BS_JAVARUN_WORKSPACE = path.join(root, 'unrelated-workspace');
    fs.readFileSync = function (file, ...args) {
      if (typeof file === 'string' && path.resolve(file) === toolConfigFile) {
        forbiddenReads++;
        throw new Error('workspace operation read tool-level config');
      }
      return originalRead.call(this, file, ...args);
    };
    await initWorkspace(root, { setup: testSetup() });
    await updateWorkspace(root);
    assert.equal(forbiddenReads, 0);
  } finally {
    fs.readFileSync = originalRead;
    if (previousWorkspace === undefined) delete process.env.BS_JAVARUN_WORKSPACE;
    else process.env.BS_JAVARUN_WORKSPACE = previousWorkspace;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('workspace local account escapes pipes and backslashes for CLI and login readers', async () => {
  const root = createWorkspace();
  try {
    const setup = testSetup();
    const password = String.raw`pipe|slash\|tail`;
    setup.accounts[0].password = password;
    await initWorkspace(root, { setup });
    const configFile = path.join(root, '.bs-java-run', 'JAVARUN.md');
    const localConfigFile = path.join(root, '.bs-java-run', 'JAVARUN.local.md');
    const cliConfig = loadConfig({ BS_JAVARUN_WORKSPACE: root });
    const loginConfig = loadLoginConfig({}, { configFile, localConfigFile });
    assert.equal(cliConfig.accounts[0].password, password);
    assert.equal(loginConfig.accounts[0].password, password);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('workspace port inference ignores Redis and test resources', async () => {
  const root = createWorkspace();
  try {
    const redisProject = createProject(root, 'redis-only');
    fs.writeFileSync(
      path.join(redisProject, 'redis-only-server/src/main/resources/application.yml'),
      'spring:\n  data:\n    redis:\n      port: 6379\n',
      'utf8',
    );
    fs.mkdirSync(path.join(redisProject, 'redis-only-server/src/test/resources'), { recursive: true });
    fs.writeFileSync(
      path.join(redisProject, 'redis-only-server/src/test/resources/application.yml'),
      'server:\n  port: 6379\n',
      'utf8',
    );
    await initWorkspace(root, { setup: testSetup() });
    const service = loadConfig({ BS_JAVARUN_WORKSPACE: root }).services.find(item => item.name === 'redis-only');
    assert.equal(service.port, 18080);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('workspace reserves discovered ports before assigning automatic ports and reads bootstrap flow YAML', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-java-run-workspace-'));
  try {
    createProject(root, 'a-auto');
    const fixedProject = createProject(root, 'b-fixed');
    fs.writeFileSync(
      path.join(fixedProject, 'b-fixed-server/src/main/resources/bootstrap.yml'),
      'server: { port: 18080 }\n',
      'utf8',
    );
    await initWorkspace(root, { setup: testSetup() });
    const services = loadConfig({ BS_JAVARUN_WORKSPACE: root }).services;
    assert.equal(services.find(item => item.name === 'a-auto').port, 18081);
    assert.equal(services.find(item => item.name === 'b-fixed').port, 18080);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('workspace port inference reports conflicting server.port values across application and bootstrap files', async () => {
  const root = createWorkspace();
  try {
    const serverResources = path.join(root, 'demo-service/demo-service-server/src/main/resources');
    fs.writeFileSync(path.join(serverResources, 'bootstrap.yml'), 'server:\n  port: 19002\n', 'utf8');
    await assert.rejects(
      () => initWorkspace(root, { setup: testSetup() }),
      /server\.port 配置存在冲突.*19001.*19002/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('workspace port inference rejects an invalid explicit server.port instead of assigning a fallback', async () => {
  const root = createWorkspace();
  try {
    const applicationFile = path.join(root, 'demo-service/demo-service-server/src/main/resources/application.yml');
    fs.writeFileSync(applicationFile, 'server:\n  port: ${SERVER_PORT}\n', 'utf8');
    await assert.rejects(
      () => initWorkspace(root, { setup: testSetup() }),
      /server\.port 无效/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('workspace configure merges a new environment, keeps accounts and generates both backups without leaking secrets', async () => {
  const root = createWorkspace();
  try {
    const initial = testSetup();
    initial.environments[0].name = '52-saas-industry-dev';
    initial.environments[0].nacosNamespace = '52-saas-industry-dev';
    initial.accounts[0].env = '52-saas-industry-dev';
    await initWorkspace(root, { setup: initial });
    const output = await captureConsole(() => reconfigureWorkspace(root, {
      setup: environmentSetup('84-saas-industry-dev', '127.0.0.1:9848'),
    }));

    const configDir = path.join(root, '.bs-java-run');
    const managed = fs.readFileSync(path.join(configDir, 'JAVARUN.md'), 'utf8');
    const local = fs.readFileSync(path.join(configDir, 'JAVARUN.local.md'), 'utf8');
    assert.match(managed, /^\| 52-saas-industry-dev \|/m);
    assert.match(managed, /^\| 84-saas-industry-dev \|/m);
    assert.match(managed, /^\| 84-saas-industry-dev \| demo-service \|/m);
    assert.match(managed, /### 84-saas-industry-dev/);
    assert.match(local, /workspace-user/);
    assert.equal(loadConfig({ BS_JAVARUN_WORKSPACE: root, BS_ENV: '52-saas-industry-dev' }).activeEnv.name, '52-saas-industry-dev');
    assert.equal(loadConfig({ BS_JAVARUN_WORKSPACE: root, BS_ENV: '84-saas-industry-dev' }).activeEnv.name, '84-saas-industry-dev');
    assert.match(output, /环境 - 新增: 84-saas-industry-dev/);
    assert.doesNotMatch(output, /test-password/);
    assert.doesNotMatch(output, /127\.0\.0\.1:9848/);
    assert.ok(fs.readdirSync(configDir).some(name => name.startsWith('JAVARUN.md.bak-')));
    assert.ok(fs.readdirSync(configDir).some(name => name.startsWith('JAVARUN.local.md.bak-')));
    for (const name of fs.readdirSync(configDir).filter(name => name.includes('.bak-'))) {
      assert.equal(fs.statSync(path.join(configDir, name)).mode & 0o777, 0o600);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('workspace configure updates a same-name environment without changing other environments or accounts', async () => {
  const root = createWorkspace();
  try {
    const initial = testSetup();
    initial.environments[0].name = '52-saas-industry-dev';
    initial.accounts[0].env = '52-saas-industry-dev';
    await initWorkspace(root, { setup: initial });
    await reconfigureWorkspace(root, { setup: environmentSetup('84-saas-industry-dev') });
    await reconfigureWorkspace(root, { setup: environmentSetup('52-saas-industry-dev', '127.0.0.1:9848') });

    const config = loadConfig({ BS_JAVARUN_WORKSPACE: root });
    assert.equal(config.environments.find(item => item.name === '52-saas-industry-dev').nacosHost, '127.0.0.1:9848');
    assert.ok(config.environments.some(item => item.name === '84-saas-industry-dev'));
    assert.ok(config.accounts.some(item => item.name === 'workspace-user' && item.env === '52-saas-industry-dev'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('workspace replace-all removes old environments only after explicit confirmation', async () => {
  const root = createWorkspace();
  try {
    const initial = testSetup();
    initial.environments[0].name = '52-saas-industry-dev';
    initial.accounts[0].env = '52-saas-industry-dev';
    await initWorkspace(root, { setup: initial });
    await reconfigureWorkspace(root, { setup: environmentSetup('84-saas-industry-dev') });

    const replacement = environmentSetup('84-saas-industry-dev', '127.0.0.1:9848');
    await captureConsole(() => reconfigureWorkspace(root, {
      setup: replacement,
      replaceAll: true,
      confirmReplaceAll: () => false,
    }));
    assert.ok(loadConfig({ BS_JAVARUN_WORKSPACE: root }).environments.some(item => item.name === '52-saas-industry-dev'));

    await captureConsole(() => reconfigureWorkspace(root, {
      setup: replacement,
      replaceAll: true,
      confirmReplaceAll: () => true,
    }));
    const config = loadConfig({ BS_JAVARUN_WORKSPACE: root });
    assert.deepEqual(config.environments.map(item => item.name), ['84-saas-industry-dev']);
    assert.equal(config.accounts.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('workspace configure rolls back both configuration files when an atomic replacement fails', async () => {
  const root = createWorkspace();
  const originalRename = fs.renameSync;
  try {
    await initWorkspace(root, { setup: testSetup() });
    const configDir = path.join(root, '.bs-java-run');
    const managedFile = path.join(configDir, 'JAVARUN.md');
    const localFile = path.join(configDir, 'JAVARUN.local.md');
    const managedBefore = fs.readFileSync(managedFile, 'utf8');
    const localBefore = fs.readFileSync(localFile, 'utf8');
    let renameCount = 0;
    fs.renameSync = (...args) => {
      renameCount++;
      if (renameCount === 2) throw new Error('simulated replace failure');
      return originalRename(...args);
    };

    await assert.rejects(
      () => reconfigureWorkspace(root, { setup: environmentSetup('84-saas-industry-dev') }),
      /配置写入失败，原文件已回滚/,
    );
    assert.equal(fs.readFileSync(managedFile, 'utf8'), managedBefore);
    assert.equal(fs.readFileSync(localFile, 'utf8'), localBefore);
  } finally {
    fs.renameSync = originalRename;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('workspace update cleans private staged files after staging fails', async () => {
  const root = createWorkspace();
  const originalWrite = fs.writeFileSync;
  try {
    await initWorkspace(root, { setup: testSetup() });
    const configDir = path.join(root, '.bs-java-run');
    const configFile = path.join(configDir, 'JAVARUN.md');
    const managedBefore = fs.readFileSync(configFile, 'utf8');
    let stagedWrites = 0;
    let firstTempMode = null;
    fs.writeFileSync = function (file, ...args) {
      if (typeof file === 'string' && file.endsWith('.tmp')) {
        stagedWrites++;
        if (stagedWrites === 2) throw new Error('simulated stage failure');
        const result = originalWrite.call(this, file, ...args);
        firstTempMode = fs.statSync(file).mode & 0o777;
        return result;
      }
      return originalWrite.call(this, file, ...args);
    };
    await assert.rejects(() => updateWorkspace(root), /配置写入失败，原文件未发生变化: simulated stage failure/);
    assert.equal(fs.readFileSync(configFile, 'utf8'), managedBefore);
    assert.equal(firstTempMode, 0o600);
    assert.deepEqual(fs.readdirSync(configDir).filter(name => name.endsWith('.tmp')), []);
  } finally {
    fs.writeFileSync = originalWrite;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('workspace reports rollback failure and keeps its recovery file private', async () => {
  const root = createWorkspace();
  const originalRename = fs.renameSync;
  try {
    await initWorkspace(root, { setup: testSetup() });
    let renameCount = 0;
    fs.renameSync = (...args) => {
      renameCount++;
      if (renameCount === 2 || renameCount === 3) throw new Error(`simulated rename failure ${renameCount}`);
      return originalRename(...args);
    };
    await assert.rejects(
      () => updateWorkspace(root),
      error => /回滚未完全成功/.test(error.message) && /保留恢复文件:/.test(error.message),
    );
    const configDir = path.join(root, '.bs-java-run');
    const recoveryFiles = fs.readdirSync(configDir).filter(name => name.endsWith('.rollback'));
    assert.equal(recoveryFiles.length, 1);
    assert.equal(fs.statSync(path.join(configDir, recoveryFiles[0])).mode & 0o777, 0o600);
  } finally {
    fs.renameSync = originalRename;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('workspace smoke cleans only tracked instances in finally after a partial startup failure', async () => {
  const root = createWorkspace();
  const previousWorkspace = process.env.BS_JAVARUN_WORKSPACE;
  const previousConfig = globalThis._bsJavaRunConfig;
  const events = [];
  let trackedInstances;
  try {
    const code = await smokeWorkspace(root, 'demo-service', { build: false, keepRunning: false }, {
      doctorWorkspace: async () => 0,
      selectServices: async () => ({
        cancelled: false,
        empty: false,
        services: [{ name: 'demo-service' }, { name: 'pre-existing-service' }],
      }),
      start: async (serviceName, options) => {
        assert.equal(serviceName, 'demo-service');
        options.startedInstances.push({
          serviceName: 'demo-service',
          pid: 1201,
          uuid: 'smoke-instance-uuid',
          serverModule: 'demo-service-server',
          warName: 'demo-service.war',
        });
        trackedInstances = options.startedInstances;
        events.push('start');
        throw new Error('simulated failure after first process spawn');
      },
      stop: async (serviceName, options) => {
        assert.equal(serviceName, 'all');
        assert.deepEqual(options.startedInstances, trackedInstances);
        assert.deepEqual(options.startedInstances.map(item => item.serviceName), ['demo-service']);
        assert.equal(options.targetServiceNames, undefined);
        events.push('stop');
        return 0;
      },
    });

    assert.equal(code, 1);
    assert.deepEqual(events, ['start', 'stop']);
  } finally {
    if (previousWorkspace === undefined) delete process.env.BS_JAVARUN_WORKSPACE;
    else process.env.BS_JAVARUN_WORKSPACE = previousWorkspace;
    if (previousConfig === undefined) delete globalThis._bsJavaRunConfig;
    else globalThis._bsJavaRunConfig = previousConfig;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
