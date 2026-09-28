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
  findRunningReverseDependents,
} from '../lib/service-selector.js';
import {
  header,
  info,
  success,
  error,
  interactiveSelect,
} from '../lib/logger.js';
import { withJsonOutput } from '../lib/command-output.js';

function setPhase(runContext, phase, detail) {
  try {
    runContext?.setPhase?.(phase, detail);
  } catch {
    // 运行记录失败不影响停止流程。
  }
}

function outputPlan(plan, asJson) {
  if (asJson) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }
  header(`${plan.command} 预览（dry-run）`);
  console.log(`  停止目标: ${plan.service}`);
  console.log(`  级联模式: ${plan.cascade ? '是' : '否'}`);
  if (plan.blockedBy?.length) console.log(`  被反向依赖阻断: ${plan.blockedBy.join(', ')}`);
  console.log(`  停止顺序: ${plan.stopOrder.join(' -> ') || '（无）'}`);
  footer();
}

function isServiceRunning(service, dependencies = {}) {
  const portOccupied = dependencies.checkPort || checkPort;
  const getPidInfo = dependencies.readPidInfo || readPidInfo;
  const processAlive = dependencies.isProcessAlive || isProcessAlive;
  if (portOccupied(service.port)) return true;
  const pidInfo = getPidInfo(service.name);
  if (pidInfo && pidInfo.pid && processAlive(pidInfo.pid)) return true;
  return false;
}

function removePidInfoIfMatches(name, pidInfo, getPidInfo, removePid) {
  const current = getPidInfo(name);
  if (!current) return;
  const matches = pidInfo.uuid
    ? current.uuid === pidInfo.uuid && current.pid === pidInfo.pid
    : current.pid === pidInfo.pid;
  if (matches) removePid(name);
}

export async function stopSingleService(service, options = {}, dependencies = {}) {
  const getPidInfo = dependencies.readPidInfo || readPidInfo;
  const removePid = dependencies.removePidFile || removePidFile;
  const getPidsByPort = dependencies.findPidsByPort || findPidsByPort;
  const processCommand = dependencies.getProcessCommand || getProcessCommand;
  const processAlive = dependencies.isProcessAlive || isProcessAlive;
  const terminate = dependencies.killProcess || killProcess;
  const waitExit = dependencies.waitProcessExit || waitProcessExit;
  const waitPortReleased = dependencies.waitPortFree || waitPortFree;
  const verifyBelongs = dependencies.verifyProcessBelongsToService || verifyProcessBelongsToService;
  const trackedInstance = Array.isArray(options.startedInstances)
    ? options.startedInstances.find(instance => instance.serviceName === service.name)
    : null;
  const pidInfo = Array.isArray(options.startedInstances) ? trackedInstance : getPidInfo(service.name);
  const port = service.port;

  // 冒烟清理只处理本次启动清单中的服务；启动前已存在的实例不会被回收。
  if (Array.isArray(options.startedInstances) && !trackedInstance) return true;

  // 1. 按 PID 停止
  if (!options.skipPid && pidInfo && pidInfo.pid) {
    const pid = pidInfo.pid;
    if (processAlive(pid)) {
      const isBelongs = verifyBelongs(pid, pidInfo);
      if (isBelongs || options.force) {
        info(`停止 ${service.name} (PID ${pid}, UUID ${pidInfo.uuid || '未知'}) ...`);
        const termSent = await terminate(pid, 'SIGTERM');
        if (!termSent && processAlive(pid)) {
          error(`  无法向 ${service.name} (PID ${pid}) 发送 SIGTERM，停止失败`);
          return false;
        }
        let exited = await waitExit(pid, 15);
        if (!exited && !processAlive(pid)) exited = true;
        if (!exited) {
          info(`  进程未响应 SIGTERM，发送 SIGKILL ...`);
          const killSent = await terminate(pid, 'SIGKILL');
          if (!killSent && processAlive(pid)) {
            error(`  无法向 ${service.name} (PID ${pid}) 发送 SIGKILL，停止失败`);
            return false;
          }
          exited = await waitExit(pid, 5);
          if (!exited && !processAlive(pid)) exited = true;
        }
        if (!exited) {
          error(`  ${service.name} (PID ${pid}) 在 SIGKILL 后仍未退出，停止失败`);
          return false;
        }
        success(`  ${service.name} (PID ${pid}) 已停止`);
        removePidInfoIfMatches(service.name, pidInfo, getPidInfo, removePid);
      } else {
        error(`安全拦截: PID ${pid} 的命令行与 ${service.name} 记录的 UUID (${pidInfo.uuid}) 不匹配！`);
        error(`命令行: ${processCommand(pid)}`);
        if (!options.force) {
          error('已取消自动清理，如需强杀请添加 --force 参数');
          return false;
        }
      }
    } else {
      removePidInfoIfMatches(service.name, pidInfo, getPidInfo, removePid);
    }
  }

  // 2. 检查端口残留
  const portPids = getPidsByPort(port);
  if (portPids.length > 0) {
    info(`检查端口 ${port} (${service.name}) 残留进程: ${portPids.join(', ')} ...`);
    for (const pid of portPids) {
      const cmd = processCommand(pid);
      const isOurProcess = pidInfo && verifyBelongs(pid, pidInfo);

      if (isOurProcess || options.force) {
        if (options.force && !isOurProcess) {
          info(`  [--force 强杀] 清理占用端口 ${port} 的非本工具进程 PID ${pid} (${cmd})`);
        }
        const killSent = await terminate(pid, 'SIGKILL');
        if (!killSent && processAlive(pid)) {
          error(`无法停止占用端口 ${port} 的 PID ${pid}`);
          return false;
        }
      } else {
        error(`安全拦截: 端口 ${port} 被非本工具实例进程 (PID ${pid}) 占用`);
        error(`  命令行: ${cmd}`);
        error('为防止误杀宿主其它进程，默认拒绝停止。如需强杀请添加 --force 参数。');
        return false;
      }
    }
    const freed = await waitPortReleased(port, 15);
    if (!freed) return false;
  }

  return true;
}

export async function stop(serviceArg, options = {}, dependencies = {}) {
  return withJsonOutput(
    options,
    () => stopImplementation(serviceArg, { ...options, __jsonCapture: true }, dependencies),
    code => ({
      command: 'stop',
      dryRun: false,
      code,
      outcome: code === 0 ? 'success' : 'failed',
    }),
  );
}

async function stopImplementation(serviceArg, options = {}, dependencies = {}) {
  const configProvider = dependencies.getConfig || getConfig;
  const requireConfiguredService = dependencies.requireService || requireService;
  const stopOne = dependencies.stopSingleService || stopSingleService;
  const config = configProvider();
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
    requireConfiguredService(serviceName);
  }

  let targetServices = Array.isArray(options.targetServiceNames)
    ? allServices.filter(service => options.targetServiceNames.includes(service.name))
    : (serviceName === 'all'
      ? allServices
      : allServices.filter(s => s.name === serviceName));

  if (Array.isArray(options.startedInstances)) {
    const trackedNames = new Set(options.startedInstances.map(instance => instance.serviceName));
    targetServices = targetServices.filter(service => trackedNames.has(service.name));
  }

  // 检查反向依赖 (Downstream dependents)
  if (serviceName !== 'all' && !options.cascade) {
    const runningDependents = findRunningReverseDependents(
      targetServices,
      allServices,
      service => isServiceRunning(service, dependencies),
    );
    if (runningDependents.length > 0) {
      if (options.dryRun) {
        outputPlan({
          command: 'stop',
          dryRun: true,
          service: serviceName,
          cascade: Boolean(options.cascade),
          force: Boolean(options.force),
          blockedBy: runningDependents,
          services: targetServices.map(service => ({ name: service.name, port: service.port })),
          stopOrder: [],
        }, Boolean(options.json));
        return 1;
      }
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
          if (!reverseClosureSet.has(s.name) && isServiceRunning(s, dependencies)) {
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

  const stopPlan = {
    command: 'stop',
    dryRun: Boolean(options.dryRun),
    service: serviceName,
    cascade: Boolean(options.cascade),
    force: Boolean(options.force),
    blockedBy: [],
    services: targetServices.map(service => ({ name: service.name, port: service.port })),
    stopOrder: stopOrder.map(service => service.name),
  };
  if (options.dryRun) {
    outputPlan(stopPlan, Boolean(options.json));
    return 0;
  }

  header('停止服务');
  console.log(`  停止目标:     ${serviceName}`);
  console.log(`  级联模式:     ${options.cascade ? '是 (--cascade)' : '否'}`);
  console.log(`  强杀模式:     ${options.force ? '是 (--force)' : '否'}`);
  console.log(`  拓扑逆序顺序: ${stopOrder.map(s => s.name).join(' -> ')}`);
  console.log('');

  let stopFailed = false;
  for (const service of stopOrder) {
    setPhase(options.runContext, 'stopping', { serviceName: service.name });
    let stopped = false;
    try {
      stopped = await stopOne(service, options, dependencies);
    } catch (stopError) {
      error(`停止 ${service.name} 时发生异常: ${stopError.message}`);
    }
    if (!stopped) {
      stopFailed = true;
      setPhase(options.runContext, 'stopping', { serviceName: service.name, outcome: 'failed', errorCategory: 'process' });
      if (!Array.isArray(options.startedInstances)) return 1;
      continue;
    }
    setPhase(options.runContext, 'stopping', { serviceName: service.name, outcome: 'success' });
  }

  console.log('');
  if (stopFailed) {
    error('部分本次启动实例未能清理，请检查停止错误和日志现场');
    return 1;
  }
  info('停止操作完成 (保留日志文件现场)');
  return 0;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
