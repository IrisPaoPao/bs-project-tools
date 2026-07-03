import { start } from './start.js';
import { stop } from './stop.js';

export async function restart(serviceArg, options) {
  const serviceName = serviceArg || 'all';

  // 1. 停止服务
  console.log('==========================================================');
  console.log(`  重启服务: ${serviceName}`);
  console.log(`  启动前构建: ${options.build ? '是' : '否'}`);
  if (options.nacosHost) console.log(`  Nacos 主机: ${options.nacosHost}`);
  if (options.nacosNamespace) console.log(`  Nacos 命名空间: ${options.nacosNamespace}`);
  console.log('==========================================================');
  console.log('');

  console.log('[INFO]  停止服务 ...');
  const stopResult = await stop(serviceName, { yes: true, skipPid: false });
  if (stopResult !== 0) {
    console.log('[FAIL]  服务停止失败');
    return 1;
  }
  console.log('[OK]    服务停止完成');
  console.log('');

  // 2. 启动服务
  console.log('[INFO]  启动服务 ...');
  const startResult = await start(serviceName, options);
  if (startResult !== 0) {
    console.log('[FAIL]  服务启动失败');
    return 1;
  }
  console.log('');
  console.log('[OK]    重启流程完成');

  return 0;
}
