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
  const selection = await selectServices(serviceArg, options, '构建服务');
  if (selection.cancelled) return 0;
  if (selection.empty) return 1;

  header('构建配置');
  console.log(`  构建服务:    ${selection.serviceName}`);
  footer();

  for (const service of selection.services) {
    console.log('');
    console.log(`服务: ${service.name}`);
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

  console.log('');
  success('构建完成');
  return 0;
}
