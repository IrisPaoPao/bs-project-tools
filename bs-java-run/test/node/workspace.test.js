import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { loadConfig } from '../../src/lib/config.js';
import { doctorWorkspace, initWorkspace, reconfigureWorkspace, updateWorkspace } from '../../src/commands/workspace.js';

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

test('workspace init generates isolated config, redacted local template and forwarding script', async () => {
  const root = createWorkspace();
  try {
    assert.equal(await initWorkspace(root, { setup: testSetup() }), 0);
    const configDir = path.join(root, '.bs-java-run');
    const managed = fs.readFileSync(path.join(configDir, 'JAVARUN.md'), 'utf8');
    const local = fs.readFileSync(path.join(configDir, 'JAVARUN.local.md'), 'utf8');
    const manifest = JSON.parse(fs.readFileSync(path.join(configDir, 'workspace-manifest.json'), 'utf8'));

    assert.match(managed, /demo-service/);
    assert.doesNotMatch(managed, /demo-sdk/);
    assert.match(managed, /19001/);
    assert.match(managed, /workspace-test/);
    assert.doesNotMatch(managed, /52-saas-industry-dev/);
    assert.match(local, /workspace-user/);
    assert.match(local, /test-password/);
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
    assert.equal(await updateWorkspace(root), 0);
    assert.match(fs.readFileSync(localFile, 'utf8'), /local edit/);

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

test('workspace reconfigure replaces user-entered connection settings and keeps a private backup', async () => {
  const root = createWorkspace();
  try {
    await initWorkspace(root, { setup: testSetup() });
    const replacement = testSetup();
    replacement.environments[0] = { ...replacement.environments[0], name: 'workspace-test-2', nacosHost: '127.0.0.1:9848' };
    replacement.accounts[0] = { ...replacement.accounts[0], name: 'workspace-user-2', env: 'workspace-test-2', password: 'replacement-password' };
    await reconfigureWorkspace(root, { setup: replacement });

    const configDir = path.join(root, '.bs-java-run');
    const managed = fs.readFileSync(path.join(configDir, 'JAVARUN.md'), 'utf8');
    const local = fs.readFileSync(path.join(configDir, 'JAVARUN.local.md'), 'utf8');
    assert.match(managed, /workspace-test-2/);
    assert.doesNotMatch(managed, /^\| workspace-test \|/m);
    assert.match(local, /workspace-user-2/);
    assert.match(local, /replacement-password/);
    assert.ok(fs.readdirSync(configDir).some(name => name.startsWith('JAVARUN.local.md.bak-')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
