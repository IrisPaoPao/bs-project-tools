#!/usr/bin/env node

import { program, Option } from 'commander';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import { start } from '../src/commands/start.js';
import { stop } from '../src/commands/stop.js';
import { restart } from '../src/commands/restart.js';
import { status } from '../src/commands/status.js';
import { build } from '../src/commands/build.js';
import { up } from '../src/commands/up.js';
import { loginCommand, tokenCommand } from '../src/commands/login.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 读取 package.json 版本
const packageJson = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));

program
  .name('bs-java-run')
  .description('BS Java 服务运行管理 CLI 工具')
  .version(packageJson.version, '-v, --version');

// start 命令
program
  .command('start [service]')
  .description('启动 Java 服务')
  .option('-b, --build', '启动前先执行 mvn package', false)
  .addOption(new Option('-s, --skip-build', '兼容旧参数：start 现在默认不构建').hideHelp().default(false))
  .option('-H, --nacos-host <host>', 'Nacos 主机地址')
  .option('-N, --nacos-ns <namespace>', 'Nacos 命名空间')
  .option('-T, --startup-timeout <seconds>', '服务启动等待超时时间（秒）')
  .option('-y, --yes', '非交互模式，默认选择全部', false)
  .action(async (service, options) => {
    const code = await start(service, options);
    process.exit(code);
  });

// build 命令
program
  .command('build [service]')
  .description('构建 Java 服务')
  .option('-y, --yes', '非交互模式，默认构建全部', false)
  .action(async (service, options) => {
    const code = await build(service, options);
    process.exit(code);
  });

// up 命令
program
  .command('up [service]')
  .description('构建并启动 Java 服务')
  .option('-H, --nacos-host <host>', 'Nacos 主机地址')
  .option('-N, --nacos-ns <namespace>', 'Nacos 命名空间')
  .option('-T, --startup-timeout <seconds>', '服务启动等待超时时间（秒）')
  .option('-y, --yes', '非交互模式，默认构建并启动全部', false)
  .action(async (service, options) => {
    const code = await up(service, options);
    process.exit(code);
  });

// stop 命令
program
  .command('stop [service]')
  .description('停止 Java 服务')
  .option('-p, --skip-pid', '跳过 PID 文件，直接按端口清理', false)
  .option('-y, --yes', '非交互模式，默认停止全部', false)
  .action(async (service, options) => {
    const code = await stop(service, options);
    process.exit(code);
  });

// restart 命令
program
  .command('restart [service]')
  .description('重启 Java 服务')
  .option('-b, --build', '启动前先执行 mvn package', false)
  .addOption(new Option('-s, --skip-build', '兼容旧参数：restart 现在默认不构建').hideHelp().default(false))
  .option('-H, --nacos-host <host>', 'Nacos 主机地址')
  .option('-N, --nacos-ns <namespace>', 'Nacos 命名空间')
  .option('-T, --startup-timeout <seconds>', '服务启动等待超时时间（秒）')
  .option('-y, --yes', '非交互模式，默认重启全部', false)
  .action(async (service, options) => {
    const code = await restart(service, options);
    process.exit(code);
  });

// status 命令
program
  .command('status [service]')
  .description('查看服务状态')
  .action(async (service, options) => {
    const code = status(service, options);
    process.exit(code);
  });

// login 命令
program
  .command('login')
  .description('登录获取 Authorization Token（多账户）')
  .option('-a, --account <name>', '指定登录账户，跳过交互选择')
  .option('-l, --headless', '无头模式（后台运行）', false)
  .option('-t, --save-token <file>', '保存 token 到文件')
  .option('-q, --quiet', '只输出 token 字符串', false)
  .option('--no-clipboard', '不自动复制 token 到剪贴板')
  .action(async (options) => {
    const code = await loginCommand(options);
    process.exit(code);
  });

// token 命令（无缓存，每次重新 headless 登录获取）
program
  .command('token')
  .description('获取 Authorization Token（每次重新登录，不缓存）')
  .option('-a, --account <name>', '指定登录账户，跳过交互选择')
  .option('-q, --quiet', '只输出 token 字符串', false)
  .option('--no-clipboard', '不自动复制 token 到剪贴板')
  .option('--no-headless', '显示浏览器窗口（默认无头）')
  .action(async (options) => {
    const code = await tokenCommand(options);
    process.exit(code);
  });

// 解析参数
program.parse();

// 如果没有参数，显示帮助
if (process.argv.length <= 2) {
  program.help();
}
