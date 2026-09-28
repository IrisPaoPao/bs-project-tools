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

/**
 * 计算重启时一次性冻结的服务范围。级联增加运行中的反向依赖，并为新增服务补齐依赖。
 */
export function resolveRestartServices(targetServices, activeServices, allServices, inspectService, cascade = false, activeEnvironmentName = '') {
  const activeByName = new Map(activeServices.map(service => [service.name, service]));
  const allByName = new Map(allServices.map(service => [service.name, service]));
  const selectedNames = new Set(targetServices.map(service => service.name));
  const crossEnvironmentServices = new Set();
  const stateCache = new Map();

  const inspect = service => {
    if (stateCache.has(service.name)) return stateCache.get(service.name);
    const state = inspectService(service) || {};
    const normalized = typeof state === 'boolean' ? { running: state } : state;
    stateCache.set(service.name, normalized);
    return normalized;
  };
  const cannotRestore = state => state.running && (
    state.environmentKnown === false
    || (activeEnvironmentName && state.environment !== activeEnvironmentName)
  );

  const reportCrossEnvironment = service => {
    const state = inspect(service);
    if (cannotRestore(state)) crossEnvironmentServices.add(service.name);
  };

  // 已运行的目标若无法确认属于当前环境，不能先停止再尝试在另一个环境恢复。
  for (const name of selectedNames) {
    const service = allByName.get(name);
    reportCrossEnvironment(service);
  }

  let changed = true;
  while (changed) {
    changed = false;

    if (cascade) {
      for (const service of allServices) {
        if (selectedNames.has(service.name) || !(service.dependsOn || []).some(name => selectedNames.has(name))) {
          continue;
        }
        const state = inspect(service);
        if (!state.running) continue;
        if (!activeByName.has(service.name)) {
          crossEnvironmentServices.add(service.name);
          continue;
        }
        if (cannotRestore(state)) {
          crossEnvironmentServices.add(service.name);
          continue;
        }
        selectedNames.add(service.name);
        changed = true;
      }
    } else {
      // 即使未指定 --cascade，也必须在停服前发现依赖服务来自其它环境。
      for (const service of allServices) {
        if (!(service.dependsOn || []).some(name => selectedNames.has(name))) continue;
        const state = inspect(service);
        if (!state.running) continue;
        if (!activeByName.has(service.name) || cannotRestore(state)) {
          crossEnvironmentServices.add(service.name);
        }
      }
    }

    const current = [...selectedNames].map(name => allByName.get(name)).filter(Boolean);
    for (const dependency of resolveDependenciesClosure(current, activeServices)) {
      if (!selectedNames.has(dependency.name)) {
        selectedNames.add(dependency.name);
        changed = true;
      }
    }
  }

  // 级联服务补齐依赖后再校验完整集合，避免停掉另一环境的依赖服务却无法按当前环境恢复。
  for (const name of selectedNames) {
    const service = allByName.get(name);
    if (service) reportCrossEnvironment(service);
  }

  if (crossEnvironmentServices.size > 0) {
    return {
      services: [],
      crossEnvironmentServices: [...crossEnvironmentServices],
    };
  }

  const services = topologicalSort(activeServices.filter(service => selectedNames.has(service.name)));
  return { services, crossEnvironmentServices: [] };
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

  const frozenNames = Array.isArray(options.targetServiceNames)
    ? new Set(options.targetServiceNames)
    : null;
  if (frozenNames) {
    const availableNames = new Set(allServices.map(service => service.name));
    const missingNames = [...frozenNames].filter(name => !availableNames.has(name));
    if (missingNames.length > 0) {
      throw new Error(`冻结的服务范围不属于当前运行环境 ${config.activeEnvName}: ${missingNames.join(', ')}`);
    }
  }

  const initialSelected = frozenNames
    ? allServices.filter(service => frozenNames.has(service.name))
    : serviceName === 'all'
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
  if (frozenNames) {
    for (const service of initialSelected) {
      for (const dependency of service.dependsOn || []) {
        if (!frozenNames.has(dependency)) {
          throw new Error(`冻结的服务范围缺少 ${service.name} 的依赖服务 ${dependency}`);
        }
      }
    }
  }

  const sortedServices = frozenNames
    ? topologicalSort(initialSelected)
    : includeDependencies
      ? resolveDependenciesClosure(initialSelected, allServices)
      : topologicalSort(initialSelected);

  return { config, serviceName, services: sortedServices, cancelled: false, empty: false };
}
