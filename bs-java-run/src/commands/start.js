import { resolveStartupTimeoutSeconds } from '../lib/config.js';
import {
  checkPort,
  startJavaService,
  waitServiceReady,
  buildService,
  DependencyResolutionError,
  ensureLogDir,
  cleanHistoricalLogs,
  removeServiceLog,
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
  const selection = await selectServices(serviceArg, options, '启动服务');
  if (selection.cancelled) return 0;
  if (selection.empty) return 1;

  const config = selection.config;
  const selectedServices = selection.services;
  const startupTimeoutSeconds = resolveStartupTimeoutSeconds(options.startupTimeout, config.startupTimeoutSeconds);

  header('启动配置');
  console.log(`  Nacos:       ${options.nacosHost || config.nacosHost || '（默认）'}`);
  console.log(`  Nacos 命名空间: ${options.nacosNamespace || config.nacosNamespace || '（默认）'}`);
  console.log(`  Java:        ${config.javaHome || '系统默认'}`);
  if (config.javaOpts && config.javaOpts.length) {
    console.log(`  JAVA_OPTS (${config.javaOpts.length}):`);
    for (const opt of config.javaOpts) console.log(`    ${opt}`);
  } else {
    console.log(`  JAVA_OPTS:   （无）`);
  }
  console.log(`  启动服务:    ${selection.serviceName}`);
  console.log(`  启动前构建:  ${options.build ? '是' : '否'}`);
  console.log(`  启动等待:    ${startupTimeoutSeconds}s`);
  console.log(`  日志目录:    ${ensureLogDir()}`);
  footer();

  // 1. 端口检查
  info('检查端口占用 ...');
  for (const service of selectedServices) {
    if (checkPort(service.port)) {
      error(`端口 ${service.port} (${service.name}) 已被占用`);
      try {
        const { execSync } = await import('child_process');
        execSync(`lsof -i :${service.port} -sTCP:LISTEN`, { stdio: 'inherit' });
      } catch {
        // ignore
      }
      return 1;
    }
  }
  success('端口检查通过');

  // 启动前清理历史日志：归档/备份/轮转日志 + 本次要启动服务的旧日志
  const removedHistory = cleanHistoricalLogs();
  let removedCurrent = 0;
  for (const service of selectedServices) {
    if (removeServiceLog(service.name)) removedCurrent++;
  }
  if (removedHistory.length || removedCurrent) {
    info(`清理历史日志: 归档/备份 ${removedHistory.length} 项, 旧日志 ${removedCurrent} 个`);
  }

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

  // 3. 启动
  for (const service of selectedServices) {
    console.log('');
    startJavaService(service.name, service.port, service.path, {
      nacosHost: options.nacosHost,
      nacosNamespace: options.nacosNamespace,
    });
    const ready = await waitServiceReady(service.name, service.port, startupTimeoutSeconds);
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
