import { getConfig, requireService } from '../lib/config.js';
import {
  checkPort,
  findPidsByPort,
  isProcessAlive,
  killProcess,
  waitPortFree,
  waitProcessExit,
  readPidFile,
  removePidFile,
} from '../lib/process-manager.js';
import {
  header,
  info,
  success,
  error,
  interactiveSelect,
} from '../lib/logger.js';

async function stopByPid(name) {
  const pid = readPidFile(name);
  if (!pid) {
    info(`${name}: 无 pid 文件`);
    return false;
  }

  if (isProcessAlive(pid)) {
    info(`${name} (PID ${pid}) 已发送停止信号，等待退出 ...`);
    await killProcess(pid, 'SIGTERM');
    const exited = await waitProcessExit(pid, 30);
    if (exited) {
      success(`${name} (PID ${pid}) 已停止`);
      removePidFile(name);
      return true;
    } else {
      error(`${name} (PID ${pid}) 在 30s 内未退出`);
      removePidFile(name);
      return false;
    }
  } else {
    info(`${name} (PID ${pid}) 进程不存在`);
    removePidFile(name);
    return false;
  }
}

async function stopByPort(name, port) {
  let pids = findPidsByPort(port);
  if (pids.length === 0) {
    return true;
  }

  info(`${name} 端口 ${port} 仍有进程: ${pids.join(' ')}，发送 SIGTERM ...`);
  for (const pid of pids) {
    await killProcess(pid, 'SIGTERM');
  }

  await sleep(3000);

  // 还没死的用 SIGKILL
  pids = findPidsByPort(port);
  if (pids.length > 0) {
    info('  进程仍存活，发送 SIGKILL ...');
    for (const pid of pids) {
      await killProcess(pid, 'SIGKILL');
    }
  }

  // 等待端口释放
  return await waitPortFree(port, 30);
}

export async function stop(serviceArg, options) {
  const config = getConfig();
  const services = config.services;
  let serviceName = serviceArg;

  if (!serviceName) {
    if (!options.yes && process.stdin.isTTY) {
      header('停止服务');
      const items = services.map(s => `${s.name.padEnd(30)}  端口: ${s.port}`);
      serviceName = await interactiveSelect(items, '请选择');
      if (!serviceName) {
        console.log('已取消');
        return;
      }
      if (serviceName !== 'all') {
        serviceName = serviceName.trim().split(/\s+/)[0];
      }
    } else {
      serviceName = 'all';
    }
  }

  if (serviceName !== 'all') {
    requireService(serviceName);
  }

  const selectedServices = serviceName === 'all'
    ? services
    : services.filter(s => s.name === serviceName);

  console.log('停止服务 ...');
  console.log('');

  for (const service of selectedServices) {
    // 先按 PID 文件停止
    if (!options.skipPid) {
      await stopByPid(service.name);
    }
    // 兜底：按端口清理并等待释放
    const ok = await stopByPort(service.name, service.port);
    if (!ok) {
      return 1;
    }
  }

  console.log('');
  console.log('完成');
  return 0;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
