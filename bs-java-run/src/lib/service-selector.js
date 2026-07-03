import { getConfig, requireService } from './config.js';
import { header, error, interactiveSelect } from './logger.js';

export async function selectServices(serviceArg, options, title) {
  const config = getConfig();
  const services = config.services;
  let serviceName = serviceArg;

  if (!serviceName) {
    if (!options.yes && process.stdin.isTTY) {
      header(title);
      const items = services.map(s => `${s.name.padEnd(30)}  端口: ${s.port}`);
      serviceName = await interactiveSelect(items, '请选择');
      if (!serviceName) {
        console.log('已取消');
        return { config, serviceName: '', services: [], cancelled: true };
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

  if (selectedServices.length === 0) {
    error(`没有要处理的服务: ${serviceName}`);
    return { config, serviceName, services: [], cancelled: false, empty: true };
  }

  return { config, serviceName, services: selectedServices, cancelled: false, empty: false };
}
