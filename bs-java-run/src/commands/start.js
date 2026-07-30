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
} from '../lib/process-manager.js';
import { selectServices } from '../lib/service-selector.js';
import {
  header,
  footer,
  info,
  success,
  error,
} from '../lib/logger.js';

export async function start(serviceArg, options) {
  let selection;
  try {
    selection = await selectServices(serviceArg, options, '启动服务', { environmentScoped: true });
  } catch (e) {
    error(e.message);
    return 1;
  }
  if (selection.cancelled) return 0;
  if (selection.empty) return 1;

  const config = selection.config;
  const selectedServices = selection.services;
  const startupTimeoutSeconds = resolveStartupTimeoutSeconds(options.startupTimeout, config.startupTimeoutSeconds);

  header('启动配置求解明细');
  console.log(`  激活运行环境: ${config.activeEnvName || '（默认无）'}`);
  console.log(`  Java 路径:    ${config.javaHome || '系统默认'}`);
  console.log(`  启动服务列表: ${selectedServices.map(s => s.name).join(', ')}`);
  console.log(`  启动前构建:  ${options.build ? '是' : '否'}`);
  console.log(`  启动等待超时: ${startupTimeoutSeconds}s`);
  console.log(`  日志目录:    ${ensureLogDir()}`);

  for (const service of selectedServices) {
    const runtimeConfig = resolveServiceRuntimeConfig(config, service.name, options);
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
  for (const service of selectedServices) {
    if (checkPort(service.port)) {
      const pids = findPidsByPort(service.port);
      error(`端口 ${service.port} (${service.name}) 已被占用，相关进程 PID: ${pids.join(', ')}`);
      for (const p of pids) {
        console.log(`  PID ${p} 命令行: ${getProcessCommand(p)}`);
      }
      error('start 命令不具备强制杀进程权限，请先手动清理或使用 stop 命令停止。');
      return 1;
    }
  }
  success('端口检查通过');

  // 2. 构建
  if (options.build) {
    console.log('');
    for (const service of selectedServices) {
      try {
        buildService(service.path);
      } catch (e) {
        if (e instanceof DependencyResolutionError) {
          console.error(e.message);
          return 1;
        }
        throw e;
      }
    }
  }

  // 3. 启动（传递 Offset 游标，防误判）
  for (const service of selectedServices) {
    console.log('');
    const runtimeConfig = resolveServiceRuntimeConfig(config, service.name, options);
    const { logCursor } = startJavaService(service.name, service.port, service.path, {
      javaHome: options.javaHome,
      runtimeConfig,
    });
    const ready = await waitServiceReady(service.name, service.port, logCursor, startupTimeoutSeconds);
    if (!ready) {
      return 1;
    }
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
