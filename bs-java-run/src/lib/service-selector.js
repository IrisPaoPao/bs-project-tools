import { getActiveEnvironmentServices, getConfig, requireService } from './config.js';
import { header, error, interactiveSelect } from './logger.js';

// 拓扑正序（依赖项在前，被依赖项在后，适合启动）
export function topologicalSort(services) {
  const serviceMap = new Map(services.map(s => [s.name, s]));
  const visited = new Set();
  const result = [];

  function visit(service) {
    if (!service || visited.has(service.name)) return;
    visited.add(service.name);

    for (const depName of service.dependsOn || []) {
      const depService = serviceMap.get(depName);
      if (depService) {
        visit(depService);
      }
    }
    result.push(service);
  }

  for (const s of services) {
    visit(s);
  }

  return result;
}

// 拓扑逆序（依赖项在后，被依赖项在前，适合停止）
export function reverseTopologicalSort(services) {
  return topologicalSort(services).reverse();
}

// 传递补齐依赖项（选定特定服务时，递归包含该服务所依赖的所有基础服务）
export function resolveDependenciesClosure(targetServices, allServices) {
  const allMap = new Map(allServices.map(s => [s.name, s]));
  const closureSet = new Set();

  function collect(service) {
    if (!service || closureSet.has(service.name)) return;
    closureSet.add(service.name);

    for (const depName of service.dependsOn || []) {
      const depService = allMap.get(depName);
      if (depService) {
        collect(depService);
      }
    }
  }

  for (const s of targetServices) {
    collect(s);
  }

  const closureList = [...closureSet].map(name => allMap.get(name)).filter(Boolean);
  return topologicalSort(closureList);
}

/**
 * 检查反向依赖（Downstream Dependents）
 * 如果要停止 targetServices，但系统中还有某些处于运行中的服务依赖 targetServices 中任何一个服务，返回这些反向依赖的服务名。
 */
export function findRunningReverseDependents(targetServices, allServices, isRunningFn) {
  const targetNames = new Set(targetServices.map(s => s.name));
  const reverseDependents = [];

  for (const service of allServices) {
    if (targetNames.has(service.name)) continue; // 跳过要停止的服务本身

    // 检查该服务是否依赖任何要停止的服务
    const hasDepOnTarget = (service.dependsOn || []).some(dep => targetNames.has(dep));
    if (hasDepOnTarget && isRunningFn(service)) {
      reverseDependents.push(service.name);
    }
  }

  return reverseDependents;
}

export async function selectServices(serviceArg, options, title, { includeDependencies = true, environmentScoped = false } = {}) {
  const config = getConfig();
  const allServices = environmentScoped ? getActiveEnvironmentServices(config) : config.services;
  let serviceName = serviceArg;

  if (!serviceName) {
    if (!options.yes && process.stdin.isTTY) {
      header(title);
      const items = allServices.map(s => `${s.name.padEnd(30)}  端口: ${s.port}`);
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
    if (environmentScoped && !allServices.some(service => service.name === serviceName)) {
      throw new Error(`服务 ${serviceName} 未在环境 ${config.activeEnvName} 的服务清单中启用`);
    }
  }

  const initialSelected = serviceName === 'all'
    ? allServices
    : allServices.filter(s => s.name === serviceName);

  if (initialSelected.length === 0) {
    error(`没有要处理的服务: ${serviceName}`);
    return { config, serviceName, services: [], cancelled: false, empty: true };
  }

  if (environmentScoped) {
    const enabledNames = new Set(allServices.map(service => service.name));
    for (const service of initialSelected) {
      for (const dependency of service.dependsOn || []) {
        if (!enabledNames.has(dependency)) {
          throw new Error(`环境 ${config.activeEnvName} 启用了 ${service.name}，但未启用其依赖服务 ${dependency}`);
        }
      }
    }
  }

  // 启动/重启需要依赖闭包；构建保持用户明确指定的范围。
  const sortedServices = includeDependencies
    ? resolveDependenciesClosure(initialSelected, allServices)
    : topologicalSort(initialSelected);

  return { config, serviceName, services: sortedServices, cancelled: false, empty: false };
}
