import { getConfig, requireService } from '../lib/config.js';
import {
  checkPort,
  startJavaService,
  waitServiceReady,
  buildService,
  ensureLogDir,
} from '../lib/process-manager.js';
import {
  header,
  footer,
  info,
  success,
  error,
  interactiveSelect,
} from '../lib/logger.js';

export async function start(serviceArg, options) {
  const config = getConfig();
  const services = config.services;
  let serviceName = serviceArg;

  if (!serviceName) {
    if (!options.yes && process.stdin.isTTY) {
      header('启动服务');
      const items = services.map(s => `${s.name.padEnd(30)}  端口: ${s.port}`);
      serviceName = await interactiveSelect(items, '请选择');
      if (!serviceName) {
        console.log('已取消');
        return;
      }
      // 从选择字符串中提取服务名
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

  if (selectedServices.length === 0) {
    error(`没有要启动的服务: ${serviceName}`);
    return 1;
  }

  header('启动配置');
  console.log(`  Nacos:       ${options.nacosHost || config.nacosHost || '（默认）'}`);
  console.log(`  Nacos 命名空间: ${options.nacosNamespace || config.nacosNamespace || '（默认）'}`);
  console.log(`  Java:        ${config.javaHome || '系统默认'}`);
  console.log(`  启动服务:    ${serviceName}`);
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

  // 2. 构建
  if (!options.skipBuild) {
    console.log('');
    for (const service of selectedServices) {
      buildService(service.path);
    }
  } else {
    info('跳过构建 (--skip-build)');
  }

  // 3. 启动
  for (const service of selectedServices) {
    console.log('');
    startJavaService(service.name, service.port, service.path, {
      nacosHost: options.nacosHost,
      nacosNamespace: options.nacosNamespace,
    });
    const ready = await waitServiceReady(service.name, service.port);
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
