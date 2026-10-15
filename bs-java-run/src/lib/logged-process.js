import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** JVM 参数经 IPC 传递，日志进程的命令行不额外暴露运行配置。 */
export function launchLoggedProcess(command, args, { cwd, logFile, instanceUuid }) {
  return new Promise((resolve, reject) => {
    const runner = fork(fileURLToPath(new URL('./service-runner.js', import.meta.url)), [instanceUuid], {
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      execArgv: [],
    });
    let settled = false;
    const release = () => {
      if (runner.connected) runner.disconnect();
      runner.unref();
    };
    const failed = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      runner.kill('SIGTERM');
      release();
      reject(error);
    };
    const timer = setTimeout(() => failed(new Error('日志进程启动超时')), 10000);
    runner.once('error', failed);
    runner.once('exit', code => failed(new Error(`日志进程已退出 (${code})`)));
    runner.on('message', message => {
      if (message.error) {
        failed(new Error(message.error));
      } else if (message.pid && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve({
          pid: message.pid,
          logPid: runner.pid,
          release,
          stop() { runner.send({ type: 'stop' }, () => {}); },
        });
      }
    });
    runner.send({ type: 'start', command, args, cwd, logFile, instanceUuid }, error => {
      if (error) failed(error);
    });
  });
}
