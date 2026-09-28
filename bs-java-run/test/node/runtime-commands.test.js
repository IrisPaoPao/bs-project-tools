import { test } from 'node:test';
import assert from 'node:assert/strict';

import { start } from '../../src/commands/start.js';
import { restart } from '../../src/commands/restart.js';
import { stop } from '../../src/commands/stop.js';
import { status } from '../../src/commands/status.js';
import {
  classifyStartupException,
  createServiceFingerprint,
} from '../../src/lib/process-manager.js';

async function captureJson(action) {
  const originalLog = console.log;
  const lines = [];
  console.log = (...args) => lines.push(args.join(' '));
  try {
    const code = await action();
    return { code, value: JSON.parse(lines.join('\n')) };
  } finally {
    console.log = originalLog;
  }
}

function runtimeConfig(service) {
  return {
    service,
    nacosHost: '127.0.0.1:8848',
    nacosNamespace: 'test',
    javaOpts: ['-Xmx512m', '-Dfeature.enabled=true'],
  };
}

test('service fingerprint hashes runtime identity but does not expose JVM values', () => {
  const first = createServiceFingerprint({
    servicePath: process.cwd(),
    port: 18080,
    environment: 'dev',
    nacosHost: '127.0.0.1:8848',
    nacosNamespace: 'test',
    javaOpts: ['-Daccess-token=secret-value'],
  });
  const second = createServiceFingerprint({
    servicePath: process.cwd(),
    port: 18080,
    environment: 'dev',
    nacosHost: '127.0.0.1:8848',
    nacosNamespace: 'test',
    javaOpts: ['-Daccess-token=changed-value'],
  });

  assert.notEqual(first.fingerprint, second.fingerprint);
  assert.deepEqual(first.fingerprintSummary.javaOptKeys, ['access-token']);
  assert.doesNotMatch(JSON.stringify(first.fingerprintSummary), /secret-value/);
});

test('start dry-run JSON plans targets and dependencies without starting or building', async () => {
  const dependency = { name: 'base', path: process.cwd(), port: 18080, dependsOn: [] };
  const target = { name: 'app', path: process.cwd(), port: 18081, dependsOn: ['base'] };
  let started = 0;
  const { code, value } = await captureJson(() => start('app', {
    dryRun: true,
    json: true,
    reuseDependencies: false,
  }, {
    selectServices: async () => ({
      cancelled: false,
      empty: false,
      config: {
        activeEnvName: 'dev',
        javaHome: '',
        startupTimeoutSeconds: 10,
        logDir: process.cwd(),
      },
      services: [dependency, target],
    }),
    resolveServiceRuntimeConfig: (_config, name) => runtimeConfig(name === 'base' ? dependency : target),
    checkPort: () => false,
    startJavaService: async () => { started++; },
    buildService: async () => { throw new Error('dry-run must not build'); },
  }));

  assert.equal(code, 0);
  assert.equal(started, 0);
  assert.equal(value.command, 'start');
  assert.equal(value.dryRun, true);
  assert.deepEqual(value.services.map(service => [service.name, service.role, service.action]), [
    ['base', 'dependency', 'start'],
    ['app', 'target', 'start'],
  ]);
});

test('start reuses only a matching automatic dependency and still starts the target', async () => {
  const dependency = { name: 'base', path: process.cwd(), port: 18080, dependsOn: [] };
  const target = { name: 'app', path: process.cwd(), port: 18081, dependsOn: ['base'] };
  const started = [];
  const { code } = await captureJson(() => start('app', {
    json: true,
    reuseDependencies: true,
    startupTimeout: 10,
  }, {
    selectServices: async () => ({
      cancelled: false,
      empty: false,
      config: {
        activeEnvName: 'dev',
        javaHome: '',
        startupTimeoutSeconds: 10,
        logDir: process.cwd(),
      },
      services: [dependency, target],
    }),
    resolveServiceRuntimeConfig: (_config, name) => runtimeConfig(name === 'base' ? dependency : target),
    checkPort: port => port === dependency.port,
    findPidsByPort: () => [],
    getProcessCommand: () => 'java',
    inspectServiceProcess: service => service.name === dependency.name ? { reusable: true } : { reusable: false },
    startJavaService: async (name) => {
      started.push(name);
      return { pid: 1201, uuid: `uuid-${name}`, logCursor: {} };
    },
    waitServiceReady: async () => true,
    markPidReady: () => true,
    ensureLogDir: () => process.cwd(),
  }));

  assert.equal(code, 0);
  assert.deepEqual(started, ['app']);
});

test('restart and stop dry-run JSON expose frozen order without invoking operations', async () => {
  const base = { name: 'base', path: process.cwd(), port: 18080, dependsOn: [] };
  const app = { name: 'app', path: process.cwd(), port: 18081, dependsOn: ['base'] };
  const config = {
    activeEnvName: 'dev',
    activeEnv: { name: 'dev' },
    environments: [{ name: 'dev' }],
    environmentServices: [{ envName: 'dev', serviceName: 'base' }, { envName: 'dev', serviceName: 'app' }],
    services: [base, app],
  };
  let stopCalls = 0;
  let startCalls = 0;
  const restartResult = await captureJson(() => restart('app', { dryRun: true, json: true }, {
    selectServices: async () => ({ config, services: [base, app], cancelled: false, empty: false }),
    inspectServiceProcess: () => ({ running: false }),
    stop: async () => { stopCalls++; return 0; },
    start: async () => { startCalls++; return 0; },
  }));
  assert.equal(restartResult.code, 0);
  assert.deepEqual(restartResult.value.stopOrder, ['app', 'base']);
  assert.deepEqual(restartResult.value.startOrder, ['base', 'app']);
  assert.equal(stopCalls, 0);
  assert.equal(startCalls, 0);

  const stopResult = await captureJson(() => stop('app', { dryRun: true, json: true }, {
    getConfig: () => ({ services: [base, app] }),
    requireService: () => app,
    checkPort: () => false,
    readPidInfo: () => null,
    isProcessAlive: () => false,
    stopSingleService: async () => { throw new Error('dry-run must not stop'); },
  }));
  assert.equal(stopResult.code, 0);
  assert.deepEqual(stopResult.value.stopOrder, ['app']);
});

test('startup diagnostics distinguish Bean conflicts and missing Beans', () => {
  assert.equal(
    classifyStartupException("BeanDefinitionOverrideException: Cannot register bean definition 'invoiceApi'" ).category,
    'bean-conflict',
  );
  assert.equal(
    classifyStartupException("NoSuchBeanDefinitionException: No qualifying bean of type 'com.example.Storage'" ).category,
    'bean-missing',
  );
});

test('status JSON works without an environment and reports stopped state', () => {
  const previous = globalThis._bsJavaRunConfig;
  const originalLog = console.log;
  const lines = [];
  globalThis._bsJavaRunConfig = {
    activeEnvName: '',
    activeEnv: null,
    services: [{ name: 'status-only', path: process.cwd(), port: 18999, dependsOn: [] }],
    environmentServices: [],
    environments: [],
    jvmOptionGroups: new Map(),
    logDir: process.cwd(),
  };
  console.log = (...args) => lines.push(args.join(' '));
  try {
    assert.equal(status('all', { json: true }), 0);
    const output = JSON.parse(lines.join('\n'));
    assert.equal(output.environment, null);
    assert.equal(output.services[0].environmentStatus, 'stopped');
    assert.equal(output.services[0].fingerprintMatch, null);
  } finally {
    console.log = originalLog;
    if (previous === undefined) delete globalThis._bsJavaRunConfig;
    else globalThis._bsJavaRunConfig = previous;
  }
});
