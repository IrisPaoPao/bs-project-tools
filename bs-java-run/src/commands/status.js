import { getConfig, requireService, resolveServiceRuntimeConfig } from '../lib/config.js';
import {
  readPidFile,
  isProcessAlive,
  findPidsByPort,
  getLogFile,
  createServiceFingerprint,
  inspectServiceProcess,
} from '../lib/process-manager.js';
import { table } from '../lib/logger.js';
import fs from 'fs';

export function status(serviceArg, options = {}) {
  const config = getConfig();
  const services = config.services;
  let serviceName = serviceArg;

  if (!serviceName) {
    serviceName = 'all';
  }

  if (serviceName !== 'all') {
    requireService(serviceName);
  }

  const selectedServices = serviceName === 'all'
    ? services
    : services.filter(s => s.name === serviceName);

  const stateRows = selectedServices.map(service => {
    const pid = readPidFile(service.name);
    let pidState;
    if (!pid) {
      pidState = 'no-pid-file';
    } else if (isProcessAlive(pid)) {
      pidState = `alive:${pid}`;
    } else {
      pidState = `dead:${pid}`;
    }

    const pids = findPidsByPort(service.port);
    const portState = pids.length > 0 ? `listening:${pids.join(',')}` : 'not-listening';

    const logFile = getLogFile(service.name);
    const logPath = fs.existsSync(logFile) ? logFile : 'N/A';

    let expectedFingerprint = null;
    if (config.activeEnvName) {
      try {
        const runtimeConfig = resolveServiceRuntimeConfig(config, service.name, options);
        expectedFingerprint = createServiceFingerprint({
          servicePath: service.path,
          port: service.port,
          environment: config.activeEnvName,
          nacosHost: runtimeConfig.nacosHost,
          nacosNamespace: runtimeConfig.nacosNamespace,
          javaOpts: runtimeConfig.javaOpts,
        }).fingerprint;
      } catch {
        // 当前环境缺少服务运行参数时仍展示 PID/端口状态，不让 status 失去诊断能力。
      }
    }
    const inspection = inspectServiceProcess(service, {
      expectedFingerprint,
      expectedEnvironment: config.activeEnvName || null,
    });
    const environmentStatus = !inspection.running
      ? 'stopped'
      : !inspection.environmentKnown
        ? 'unknown'
        : config.activeEnvName && inspection.environment !== config.activeEnvName
          ? 'mismatch'
          : 'known';

    return {
      service: service.name,
      port: service.port,
      pid: pid || null,
      pidState,
      portState,
      portPids: pids,
      log: logPath,
      running: inspection.running,
      readiness: inspection.ready ? 'ready' : 'not-ready',
      environment: inspection.environment,
      pidEnvironment: inspection.pidInfo?.environment || null,
      expectedEnvironment: config.activeEnvName || null,
      environmentStatus,
      fingerprint: inspection.fingerprint,
      fingerprintMatch: inspection.fingerprintMatch,
    };
  });

  if (options.json) {
    console.log(JSON.stringify({
      command: 'status',
      environment: config.activeEnvName || null,
      services: stateRows,
    }, null, 2));
    return 0;
  }

  const headers = ['SERVICE', 'PORT', 'PID', 'PORT_STATE', 'LOG'];
  const rows = stateRows.map(row => [row.service, String(row.port), row.pidState, row.portState, row.log]);

  table(headers, rows);

  return 0;
}
