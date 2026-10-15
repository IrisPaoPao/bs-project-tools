import { resolveStartupTimeoutSeconds, resolveServiceRuntimeConfig } from '../lib/config.js';
import {
  checkPort,
  findPidsByPort,
  getProcessCommand,
  startJavaService,
  waitServiceReady,
  buildService,
  DependencyResolutionError,
  ensureLogDir,
  resolveJavaExecutable,
  createServiceFingerprint,
  inspectServiceProcess,
  markPidReady,
} from '../lib/process-manager.js';
import { selectServices } from '../lib/service-selector.js';
import { withJsonOutput } from '../lib/command-output.js';
import {
  header,
  footer,
  info,
  success,
  error,
} from '../lib/logger.js';

function setPhase(runContext, phase, detail) {
  try {
    runContext?.setPhase?.(phase, detail);
  } catch {
    // 运行记录失败不应影响服务操作。
  }
}

function outputPlan(plan, asJson) {
  if (asJson) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }
  header(`${plan.command} 预览（dry-run）`);
  console.log(`  激活运行环境: ${plan.environment || '（未指定）'}`);
  console.log(`  启动前构建: ${plan.build ? '是' : '否'}`);
  console.log(`  依赖复用: ${plan.reuseDependencies ? '是' : '否'}`);
  for (const service of plan.services) {
    console.log(`  ${service.name}: ${service.action}，端口 ${service.port}`);
  }
  footer();
}

export async function start(serviceArg, options = {}, dependencies = {}) {
  return withJsonOutput(
    options,
    () => startImplementation(serviceArg, { ...options, __jsonCapture: true }, dependencies),
    code => ({
      command: options.commandName || 'start',
      dryRun: false,
      code,
      outcome: code === 0 ? 'success' : 'failed',
    }),
  );
}

async function startImplementation(serviceArg, options = {}, dependencies = {}) {
  const select = dependencies.selectServices || selectServices;
  const runtimeConfigFor = dependencies.resolveServiceRuntimeConfig || resolveServiceRuntimeConfig;
  const isPortOccupied = dependencies.checkPort || checkPort;
  const getPortPids = dependencies.findPidsByPort || findPidsByPort;
  const processCommand = dependencies.getProcessCommand || getProcessCommand;
  const startService = dependencies.startJavaService || startJavaService;
  const waitReady = dependencies.waitServiceReady || waitServiceReady;
  const build = dependencies.buildService || buildService;
  const createLogDirectory = dependencies.ensureLogDir || ensureLogDir;
  const inspectProcess = dependencies.inspectServiceProcess || inspectServiceProcess;
  const markReady = dependencies.markPidReady || markPidReady;

  let selection;
  try {
    selection = await select(serviceArg, options, '启动服务', { environmentScoped: true });
  } catch (e) {
    error(e.message);
    return 1;
  }
  if (selection.cancelled) return 0;
  if (selection.empty) return 1;

  const config = selection.config;
  const selectedServices = selection.services;
  let startupTimeoutSeconds;
  let javaBin;
  try {
    startupTimeoutSeconds = resolveStartupTimeoutSeconds(options.startupTimeout, config.startupTimeoutSeconds);
    // 先校验显式 Java 配置，避免构建后才发现配置错误或静默退回系统 Java。
    javaBin = resolveJavaExecutable(options.javaHome || config.javaHome);
  } catch (e) {
    error(e.message);
    setPhase(options.runContext, 'starting', { outcome: 'failed', errorCategory: 'configuration' });
    return 1;
  }

  if (!Array.isArray(options.startedInstances)) options.startedInstances = [];
  const startedInstances = options.startedInstances;

  // 只有用户未明确选择的传递依赖才允许使用 --reuse-dependencies 复用。
  const explicitNames = new Set(
    Array.isArray(options.targetServiceNames)
      ? options.targetServiceNames
      : serviceArg && serviceArg !== 'all'
        ? [serviceArg]
        : selectedServices.map(service => service.name),
  );
  const runtimePlans = selectedServices.map(service => {
    const runtimeConfig = runtimeConfigFor(config, service.name, options);
    const fingerprint = createServiceFingerprint({
      servicePath: service.path,
      port: service.port,
      environment: config.activeEnvName,
      nacosHost: runtimeConfig.nacosHost,
      nacosNamespace: runtimeConfig.nacosNamespace,
      javaOpts: runtimeConfig.javaOpts,
    });
    const automaticDependency = !explicitNames.has(service.name);
    let processState = null;
    if (options.reuseDependencies && automaticDependency) {
      processState = inspectProcess(service, { expectedFingerprint: fingerprint.fingerprint });
    }
    const reusable = Boolean(
      options.reuseDependencies
      && automaticDependency
      && (processState?.reusable === true || processState === true),
    );
    return {
      service,
      runtimeConfig,
      fingerprint,
      automaticDependency,
      processState,
      reusable,
    };
  });

  const plan = {
    command: options.commandName || 'start',
    dryRun: Boolean(options.dryRun),
    environment: config.activeEnvName || null,
    build: Boolean(options.build),
    reuseDependencies: Boolean(options.reuseDependencies),
    services: runtimePlans.map(item => {
      const portOccupied = Boolean(isPortOccupied(item.service.port));
      return {
        name: item.service.name,
        port: item.service.port,
        role: item.automaticDependency ? 'dependency' : 'target',
        portOccupied,
        action: item.reusable ? 'reuse' : portOccupied ? 'blocked-port' : 'start',
        fingerprint: item.fingerprint.fingerprint,
        fingerprintSummary: item.fingerprint.fingerprintSummary,
      };
    }),
  };
  if (options.dryRun) {
    outputPlan(plan, Boolean(options.json));
    return 0;
  }

  header('启动配置求解明细');
  console.log(`  激活运行环境: ${config.activeEnvName || '（默认无）'}`);
  console.log(`  Java 路径:    ${javaBin}`);
  console.log(`  启动服务列表: ${selectedServices.map(s => s.name).join(', ')}`);
  console.log(`  启动前构建:  ${options.build ? '是' : '否'}`);
  console.log(`  启动等待超时: ${startupTimeoutSeconds}s`);
  let logDirectory;
  try {
    logDirectory = createLogDirectory();
  } catch (e) {
    error(`无法准备日志目录: ${e.message}`);
    setPhase(options.runContext, 'starting', { outcome: 'failed', errorCategory: 'process' });
    return 1;
  }
  console.log(`  日志目录:    ${logDirectory}`);

  for (const service of selectedServices) {
    const runtimeConfig = runtimeConfigFor(config, service.name, options);
    console.log(`\n  [服务明细: ${service.name}]`);
    console.log(`    端口:            ${service.port}`);
    console.log(`    Nacos 地址:      ${runtimeConfig.nacosHost || '（环境未配置）'}`);
    console.log(`    Nacos 命名空间:  ${runtimeConfig.nacosNamespace || '（环境未配置）'}`);
    console.log(`    四层合并 JVM 参数 (${runtimeConfig.javaOpts.length} 项):`);
    for (const opt of runtimeConfig.javaOpts) {
      console.log(`      ${opt}`);
    }
  }
  footer();

  // 1. 端口占用检查（start 严禁杀进程，若占用直接报警）
  info('检查端口占用 ...');
  const startupPlans = [];
  const reusedPlans = [];
  for (const item of runtimePlans) {
    const { service } = item;
    if (item.reusable) {
      reusedPlans.push(item);
      info(`依赖服务 ${service.name} 已由匹配的本工具实例就绪，复用现有进程。`);
      continue;
    }
    if (isPortOccupied(service.port)) {
      const pids = getPortPids(service.port);
      error(`端口 ${service.port} (${service.name}) 已被占用，相关进程 PID: ${pids.join(', ')}`);
      for (const p of pids) {
        console.log(`  PID ${p} 命令行: ${processCommand(p)}`);
      }
      error('start 命令不具备强制杀进程权限，请先手动清理或使用 stop 命令停止。');
      setPhase(options.runContext, 'starting', { serviceName: service.name, outcome: 'failed', errorCategory: 'process' });
      return 1;
    }
    startupPlans.push(item);
  }
  success('端口检查通过');

  // 2. 构建
  if (options.build) {
    console.log('');
    for (const { service } of startupPlans) {
      setPhase(options.runContext, 'building', { serviceName: service.name });
      try {
        const logPath = await build(service.path, { serviceName: service.name });
        setPhase(options.runContext, 'building', {
          serviceName: service.name,
          outcome: 'success',
          logPath: typeof logPath === 'string' ? logPath : undefined,
        });
      } catch (e) {
        if (e instanceof DependencyResolutionError) {
          console.error(e.message);
          setPhase(options.runContext, 'building', {
            serviceName: service.name,
            outcome: 'failed',
            errorCategory: 'dependency-resolution',
            logPath: e.logFile,
          });
          return 1;
        }
        error(`服务 ${service.name} 构建失败: ${e.message}`);
        setPhase(options.runContext, 'building', {
          serviceName: service.name,
          outcome: 'failed',
          errorCategory: 'build',
          logPath: e.logFile,
        });
        return 1;
      }
    }
  }

  // 3. 启动（传递 Offset 游标，防误判）
  for (const item of startupPlans) {
    const { service, runtimeConfig } = item;
    console.log('');
    setPhase(options.runContext, 'starting', { serviceName: service.name });
    let instance;
    try {
      instance = await startService(service.name, service.port, service.path, {
        javaBin,
        javaHome: options.javaHome,
        runtimeConfig,
        onInstanceStarted: started => {
          const instanceInfo = {
            serviceName: service.name,
            pid: started.pid,
            logPid: started.logPid,
            uuid: started.uuid,
            environment: started.environment || config.activeEnvName || null,
            serverModule: started.serverModule,
            warName: started.warName,
          };
          if (!startedInstances.some(item => item.uuid === instanceInfo.uuid)) {
            startedInstances.push(instanceInfo);
          }
          try {
            options.runContext?.recordStartedInstance?.({ serviceName: service.name });
          } catch {
            // 历史记录失败不应中断已经启动的实例管理。
          }
        },
      });
    } catch (e) {
      error(`服务 ${service.name} 启动失败: ${e.message}`);
      setPhase(options.runContext, 'starting', { serviceName: service.name, outcome: 'failed', errorCategory: 'process' });
      return 1;
    }

    if (instance?.pid && !startedInstances.some(item => item.uuid === instance.uuid)) {
      // 测试替身和旧启动适配器可能不触发onInstanceStarted回调。
      startedInstances.push({
        serviceName: service.name,
        pid: instance.pid,
        logPid: instance.pidInfo?.logPid,
        uuid: instance.uuid,
        environment: instance.pidInfo?.environment || config.activeEnvName || null,
        serverModule: instance.pidInfo?.serverModule,
        warName: instance.pidInfo?.warName,
      });
      try {
        options.runContext?.recordStartedInstance?.({ serviceName: service.name });
      } catch {
        // 历史记录失败不应中断已经启动的实例管理。
      }
    }

    setPhase(options.runContext, 'waiting-readiness', { serviceName: service.name });
    let ready;
    let readinessDiagnostic = null;
    try {
      ready = await waitReady(service.name, service.port, instance?.logCursor, startupTimeoutSeconds, {
        expectedPid: instance?.pid,
        expectedUuid: instance?.uuid,
        onDiagnostic: diagnostic => { readinessDiagnostic = diagnostic; },
      });
    } catch (e) {
      error(`服务 ${service.name} 就绪检查失败: ${e.message}`);
      setPhase(options.runContext, 'waiting-readiness', {
        serviceName: service.name,
        outcome: 'failed',
        errorCategory: readinessDiagnostic?.errorCategory || 'unknown',
        logPath: readinessDiagnostic?.logFile,
      });
      return 1;
    }
    if (!ready) {
      setPhase(options.runContext, 'waiting-readiness', {
        serviceName: service.name,
        outcome: 'failed',
        errorCategory: readinessDiagnostic?.errorCategory || 'unknown',
        logPath: readinessDiagnostic?.logFile,
      });
      return 1;
    }
    try {
      markReady(service.name, { pid: instance?.pid, uuid: instance?.uuid }, true);
    } catch {
      // 就绪标记失败不改变已经完成的端口/日志检查结果，复用时会按不安全实例处理。
    }
    setPhase(options.runContext, 'waiting-readiness', { serviceName: service.name, outcome: 'success' });
  }

  // 4. 完成
  console.log('');
  header('服务启动完成!');
  for (const service of selectedServices) {
    console.log(`  ${service.name}: http://127.0.0.1:${service.port}`);
  }
  console.log(`  日志目录: ${config.logDir}`);
  console.log('');
  console.log('  停止服务: bs-java-run stop');
  footer();

  return 0;
}
