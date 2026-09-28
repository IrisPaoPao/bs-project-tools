import { start } from './start.js';
import { stop } from './stop.js';
import { header, footer, info, success, error } from '../lib/logger.js';
import { getActiveEnvironmentServices } from '../lib/config.js';
import { inspectServiceProcess } from '../lib/process-manager.js';
import { resolveRestartServices, selectServices } from '../lib/service-selector.js';
import { withJsonOutput } from '../lib/command-output.js';

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
  console.log(`  停止顺序: ${plan.stopOrder.join(' -> ')}`);
  console.log(`  启动顺序: ${plan.startOrder.join(' -> ')}`);
  console.log(`  启动前构建: ${plan.build ? '是' : '否'}`);
  footer();
}

export async function restart(serviceArg, options = {}, dependencies = {}) {
  return withJsonOutput(
    options,
    () => restartImplementation(serviceArg, { ...options, __jsonCapture: true }, dependencies),
    code => ({
      command: 'restart',
      dryRun: false,
      code,
      outcome: code === 0 ? 'success' : 'failed',
    }),
  );
}

async function restartImplementation(serviceArg, options = {}, dependencies = {}) {
  const select = dependencies.selectServices || selectServices;
  const stopServices = dependencies.stop || stop;
  const startServices = dependencies.start || start;
  const inspectService = dependencies.inspectServiceProcess || inspectServiceProcess;
  const serviceName = serviceArg || 'all';
  let selection;
  try {
    selection = await select(serviceName, { ...options, yes: true }, '重启服务', { environmentScoped: true });
  } catch (e) {
    error(e.message);
    return 1;
  }
  if (selection.cancelled) return 0;
  if (selection.empty) return 1;

  const activeServices = getActiveEnvironmentServices(selection.config);
  const frozenPlan = resolveRestartServices(
    selection.services,
    activeServices,
    selection.config.services,
    service => {
      const state = inspectService(service);
      return typeof state === 'boolean' ? { running: state } : state;
    },
    Boolean(options.cascade),
    selection.config.activeEnvName,
  );
  if (frozenPlan.crossEnvironmentServices.length > 0) {
    error(`重启中断: 以下运行服务不属于环境 ${selection.config.activeEnvName}，无法在停止后安全恢复:`);
    for (const name of frozenPlan.crossEnvironmentServices) error(`  - ${name}`);
    setPhase(options.runContext, 'stopping', { outcome: 'failed', errorCategory: 'configuration' });
    return 1;
  }
  if (frozenPlan.services.length === 0) {
    error('重启中断: 冻结的服务范围为空');
    setPhase(options.runContext, 'stopping', { outcome: 'failed', errorCategory: 'selection' });
    return 1;
  }
  const targetServiceNames = frozenPlan.services.map(service => service.name);

  const restartPlan = {
    command: 'restart',
    dryRun: Boolean(options.dryRun),
    environment: selection.config.activeEnvName || null,
    build: Boolean(options.build),
    services: frozenPlan.services.map(service => ({ name: service.name, port: service.port })),
    stopOrder: [...frozenPlan.services].reverse().map(service => service.name),
    startOrder: frozenPlan.services.map(service => service.name),
  };
  if (options.dryRun) {
    outputPlan(restartPlan, Boolean(options.json));
    return 0;
  }

  header(`重启服务: ${serviceName}`);
  console.log(`  级联重启: ${options.cascade ? '是 (--cascade)' : '否'}`);
  console.log(`  强杀残留: ${options.force ? '是 (--force)' : '否'}`);
  console.log(`  启动前构建: ${options.build ? '是' : '否'}`);
  footer();

  // 阶段 1：按冻结范围全逆序停止，避免stop阶段重新计算级联范围。
  info('[阶段 1/2] 执行拓扑逆序停止 ...');
  setPhase(options.runContext, 'stopping', { serviceName: serviceName === 'all' ? undefined : serviceName });
  const stopOptions = {
    yes: true,
    // 级联范围已经冻结；stop只执行该列表，不在停止期间重新扩展。
    cascade: false,
    force: Boolean(options.force),
    targetServiceNames,
    runContext: options.runContext,
  };

  const stopResult = await stopServices(serviceName, stopOptions);
  if (stopResult !== 0) {
    error('重启中断: 服务全逆序停止阶段失败');
    setPhase(options.runContext, 'stopping', { outcome: 'failed', errorCategory: 'process' });
    return 1;
  }
  success('服务全逆序停止阶段完成');
  console.log('');

  // 阶段 2：全正序启动
  info('[阶段 2/2] 执行拓扑正序启动 ...');
  const startOptions = { ...options, targetServiceNames };
  const startResult = await startServices(serviceName, startOptions);
  if (startResult !== 0) {
    error('重启中断: 服务全正序启动阶段失败');
    setPhase(options.runContext, 'starting', { outcome: 'failed', errorCategory: 'process' });
    return 1;
  }

  console.log('');
  header('重启流程全部完成!');
  return 0;
}
