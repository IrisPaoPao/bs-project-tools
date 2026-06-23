import { getConfig, requireService } from '../lib/config.js';
import {
  readPidFile,
  isProcessAlive,
  findPidsByPort,
  getLogFile,
} from '../lib/process-manager.js';
import { table } from '../lib/logger.js';
import fs from 'fs';

export function status(serviceArg, options) {
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

  const headers = ['SERVICE', 'PORT', 'PID', 'PORT_STATE', 'LOG'];
  const rows = selectedServices.map(service => {
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

    return [service.name, String(service.port), pidState, portState, logPath];
  });

  table(headers, rows);

  return 0;
}
