import { getConfig, requireService } from '../lib/config.js';
import {
  checkPort,
  findPidsByPort,
  getProcessCommand,
  isProcessAlive,
  killProcess,
  waitPortFree,
  waitProcessExit,
  readPidInfo,
  removePidFile,
  verifyProcessBelongsToService,
} from '../lib/process-manager.js';
import {
  reverseTopologicalSort,
  resolveDependenciesClosure,
  findRunningReverseDependents,
} from '../lib/service-selector.js';
import {
  header,
  info,
  success,
  error,
  interactiveSelect,
} from '../lib/logger.js';

function isServiceRunning(service) {
  if (checkPort(service.port)) return true;
  const pidInfo = readPidInfo(service.name);
  if (pidInfo && pidInfo.pid && isProcessAlive(pidInfo.pid)) return true;
  return false;
}

async function stopSingleService(service, options) {
  const pidInfo = readPidInfo(service.name);
  const port = service.port;

  // 1. 按 PID 停止
  if (!options.skipPid && pidInfo && pidInfo.pid) {
    const pid = pidInfo.pid;
    if (isProcessAlive(pid)) {
      const isBelongs = verifyProcessBelongsToService(pid, pidInfo);
      if (isBelongs || options.force) {
        info(`停止 ${service.name} (PID ${pid}, UUID ${pidInfo.uuid || '未知'}) ...`);
        await killProcess(pid, 'SIGTERM');
        const exited = await waitProcessExit(pid, 15);
        if (!exited) {
          info(`  进程未响应 SIGTERM，发送 SIGKILL ...`);
          await killProcess(pid, 'SIGKILL');
          await waitProcessExit(pid, 5);
        }
        success(`  ${service.name} (PID ${pid}) 已停止`);
        removePidFile(service.name);
      } else {
        error(`安全拦截: PID ${pid} 的命令行与 ${service.name} 记录的 UUID (${pidInfo.uuid}) 不匹配！`);
        error(`命令行: ${getProcessCommand(pid)}`);
        if (!options.force) {
          error('已取消自动清理，如需强杀请添加 --force 参数');
          return false;
        }
      }
    } else {
      removePidFile(service.name);
    }
  }

  // 2. 检查端口残留
  let portPids = findPidsByPort(port);
  if (portPids.length > 0) {
    info(`检查端口 ${port} (${service.name}) 残留进程: ${portPids.join(', ')} ...`);
    for (const pid of portPids) {
      const cmd = getProcessCommand(pid);
      const isOurProcess = pidInfo && verifyProcessBelongsToService(pid, pidInfo);

      if (isOurProcess || options.force) {
        if (options.force && !isOurProcess) {
          info(`  [--force 强杀] 清理占用端口 ${port} 的非本工具进程 PID ${pid} (${cmd})`);
        }
        await killProcess(pid, 'SIGKILL');
      } else {
        error(`安全拦截: 端口 ${port} 被非本工具实例进程 (PID ${pid}) 占用`);
        error(`  命令行: ${cmd}`);
        error('为防止误杀宿主其它进程，默认拒绝停止。如需强杀请添加 --force 参数。');
        return false;
      }
    }
    const freed = await waitPortFree(port, 15);
    if (!freed) return false;
  }

  return true;
}

export async function stop(serviceArg, options) {
  const config = getConfig();
  const allServices = config.services;
  let serviceName = serviceArg;

  if (!serviceName) {
    if (!options.yes && process.stdin.isTTY) {
      header('停止服务');
      const items = allServices.map(s => `${s.name.padEnd(30)}  端口: ${s.port}`);
      serviceName = await interactiveSelect(items, '请选择');
      if (!serviceName) {
        console.log('已取消');
        return 0;
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

  let targetServices = Array.isArray(options.targetServiceNames)
    ? allServices.filter(service => options.targetServiceNames.includes(service.name))
    : (serviceName === 'all'
      ? allServices
      : allServices.filter(s => s.name === serviceName));

  // 检查反向依赖 (Downstream dependents)
  if (serviceName !== 'all' && !options.cascade) {
    const runningDependents = findRunningReverseDependents(targetServices, allServices, isServiceRunning);
    if (runningDependents.length > 0) {
      error(`拒绝停止: 以下仍处于运行中的服务反向依赖于 ${serviceName}:`);
      for (const depName of runningDependents) {
        error(`  - ${depName}`);
      }
      error('停止该基础服务将导致上述依赖服务发生连接异常！');
      error('若确认要将依赖服务一并级联停止，请加上 --cascade 参数 (bs-java-run stop ${serviceName} --cascade)。');
      return 1;
    }
  }

  // 若传入了 --cascade，自动计算完整的级联服务 closure
  if (options.cascade && serviceName !== 'all') {
    const reverseClosureSet = new Set(targetServices.map(s => s.name));
    let added = true;
    while (added) {
      added = false;
      for (const s of allServices) {
        if (!reverseClosureSet.has(s.name) && isServiceRunning(s)) {
          const hasDepInSet = (s.dependsOn || []).some(d => reverseClosureSet.has(d));
          if (hasDepInSet) {
            reverseClosureSet.add(s.name);
            added = true;
          }
        }
      }
    }
    targetServices = [...reverseClosureSet].map(name => allServices.find(s => s.name === name)).filter(Boolean);
  }

  // 拓扑逆序（依赖上游的服务先停，基础服务后停）
  const stopOrder = reverseTopologicalSort(targetServices);

  header('停止服务');
  console.log(`  停止目标:     ${serviceName}`);
  console.log(`  级联模式:     ${options.cascade ? '是 (--cascade)' : '否'}`);
  console.log(`  强杀模式:     ${options.force ? '是 (--force)' : '否'}`);
  console.log(`  拓扑逆序顺序: ${stopOrder.map(s => s.name).join(' -> ')}`);
  console.log('');

  for (const service of stopOrder) {
    const success = await stopSingleService(service, options);
    if (!success) {
      return 1;
    }
  }

  console.log('');
  info('停止操作完成 (保留日志文件现场)');
  return 0;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
