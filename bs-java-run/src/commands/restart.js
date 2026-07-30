import { start } from './start.js';
import { stop } from './stop.js';
import { header, footer, info, success, error } from '../lib/logger.js';
import { selectServices } from '../lib/service-selector.js';

export async function restart(serviceArg, options) {
  const serviceName = serviceArg || 'all';
  let selection;
  try {
    selection = await selectServices(serviceName, { ...options, yes: true }, '重启服务', { environmentScoped: true });
  } catch (e) {
    error(e.message);
    return 1;
  }
  if (selection.cancelled) return 0;
  if (selection.empty) return 1;
  const targetServiceNames = selection.services.map(service => service.name);

  header(`重启服务: ${serviceName}`);
  console.log(`  级联重启: ${options.cascade ? '是 (--cascade)' : '否'}`);
  console.log(`  强杀残留: ${options.force ? '是 (--force)' : '否'}`);
  console.log(`  启动前构建: ${options.build ? '是' : '否'}`);
  footer();

  // 阶段 1：全逆序停止（透传 --force 与 --cascade 给 stop）
  info('[阶段 1/2] 执行拓扑逆序停止 ...');
  const stopOptions = {
    yes: true,
    cascade: Boolean(options.cascade),
    force: Boolean(options.force),
    targetServiceNames,
  };

  const stopResult = await stop(serviceName, stopOptions);
  if (stopResult !== 0) {
    error('重启中断: 服务全逆序停止阶段失败');
    return 1;
  }
  success('服务全逆序停止阶段完成');
  console.log('');

  // 阶段 2：全正序启动
  info('[阶段 2/2] 执行拓扑正序启动 ...');
  const startResult = await start(serviceName, options);
  if (startResult !== 0) {
    error('重启中断: 服务全正序启动阶段失败');
    return 1;
  }

  console.log('');
  header('重启流程全部完成!');
  return 0;
}
