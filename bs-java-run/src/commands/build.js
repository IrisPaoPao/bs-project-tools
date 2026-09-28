import {
  buildService,
  DependencyResolutionError,
} from '../lib/process-manager.js';
import { selectServices } from '../lib/service-selector.js';
import {
  header,
  footer,
  success,
} from '../lib/logger.js';

export async function build(serviceArg, options) {
  const selection = await selectServices(serviceArg, options, '构建服务', { includeDependencies: false });
  if (selection.cancelled) return 0;
  if (selection.empty) return 1;

  header('构建配置');
  console.log(`  构建服务:    ${selection.serviceName}`);
  footer();

  for (const service of selection.services) {
    console.log('');
    console.log(`服务: ${service.name}`);
    try {
      options.runContext?.setPhase?.('building', { serviceName: service.name });
    } catch {
      // 运行记录失败不影响构建。
    }
    try {
      const logPath = await buildService(service.path, { serviceName: service.name });
      try {
        options.runContext?.setPhase?.('building', {
          serviceName: service.name,
          outcome: 'success',
          logPath,
        });
      } catch {
        // 运行记录失败不影响构建。
      }
    } catch (e) {
      if (e instanceof DependencyResolutionError) {
        console.error(e.message);
        try {
          options.runContext?.setPhase?.('building', {
            serviceName: service.name,
            outcome: 'failed',
            errorCategory: 'dependency-resolution',
            logPath: e.logFile,
          });
        } catch {
          // 运行记录失败不影响错误处理。
        }
        return 1;
      }
      console.error(`服务 ${service.name} 构建失败: ${e.message}`);
      try {
        options.runContext?.setPhase?.('building', {
          serviceName: service.name,
          outcome: 'failed',
          errorCategory: 'build',
          logPath: e.logFile,
        });
      } catch {
        // 运行记录失败不影响错误处理。
      }
      return 1;
    }
  }

  console.log('');
  success('构建完成');
  return 0;
}
