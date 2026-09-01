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
import {
  doctorWorkspace,
  initWorkspace,
  reconfigureWorkspace,
  smokeWorkspace,
  updateWorkspace,
} from '../src/commands/workspace.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const packageJson = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));

function collectJavaOpt(val, memo) {
  memo.push(val);
  return memo;
}

program
  .name('bs-java-run')
  .description('BS Java 服务运行管理 CLI 工具')
  .version(packageJson.version, '-v, --version');

program.option('-e, --env <name>', '选择目标运行环境名');
program.option('-P, --profile <name>', '兼容旧参数：选择命名运行环境（同 --env）');
program.option('-w, --workspace <directory>', '使用目标聚合目录下的 .bs-java-run 配置');

program.hook('preAction', (thisCommand, actionCommand) => {
  const globalOpts = thisCommand.opts();
  const actionOpts = actionCommand.opts();

  const env = actionOpts.env || globalOpts.env;
  const profile = actionOpts.profile || globalOpts.profile;

  if (env && profile && env !== profile) {
    console.error(`错误: 参数冲突 --env (${env}) 与 --profile (${profile}) 指定了不同的环境名称`);
    process.exit(1);
  }

  const selectedEnv = env || profile;
  if (selectedEnv) {
    process.env.BS_ENV = selectedEnv;
    process.env.BS_JAVARUN_PROFILE = selectedEnv;
  }

  const workspace = actionOpts.workspace || globalOpts.workspace;
  if (workspace) {
    process.env.BS_JAVARUN_WORKSPACE = workspace;
    delete globalThis._bsJavaRunConfig;
  }
});

// start 命令
program
  .command('start [service]')
  .description('启动 Java 服务')
  .option('-e, --env <name>', '选择目标运行环境名')
  .option('-P, --profile <name>', '兼容旧参数：选择命名运行环境')
  .option('-J, --java-opt <arg>', '追加/覆盖 JVM 参数（可指定多次）', collectJavaOpt, [])
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
  .option('-e, --env <name>', '选择目标运行环境名')
  .option('-P, --profile <name>', '兼容旧参数：选择命名运行环境')
  .option('-J, --java-opt <arg>', '追加/覆盖 JVM 参数（可指定多次）', collectJavaOpt, [])
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
  .option('-e, --env <name>', '选择目标运行环境名')
  .option('-P, --profile <name>', '兼容旧参数：选择命名运行环境')
  .option('-c, --cascade', '级联递归停止依赖该服务的反向运行服务', false)
  .option('-f, --force', '强杀非本工具 PID / 端口占用的残留进程', false)
  .option('-p, --skip-pid', '跳过 PID 文件，直接按端口清理', false)
  .option('-y, --yes', '非交互模式，默认停止全部', false)
  .action(async (service, options) => {
    const code = await stop(service, options);
    process.exit(code);
  });

// restart 命令
program
  .command('restart [service]')
  .description('重启 Java 服务（按全逆序停止 -> 全正序启动）')
  .option('-e, --env <name>', '选择目标运行环境名')
  .option('-P, --profile <name>', '兼容旧参数：选择命名运行环境')
  .option('-J, --java-opt <arg>', '追加/覆盖 JVM 参数（可指定多次）', collectJavaOpt, [])
  .option('-c, --cascade', '级联递归重启依赖该服务的反向运行服务', false)
  .option('-f, --force', '强杀非本工具 PID / 端口占用的残留进程（透传给停止阶段）', false)
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
  .option('-e, --env <name>', '指定登录环境名，筛选该环境下的账户')
  .option('-P, --profile <name>', '兼容旧参数：指定环境名')
  .option('-a, --account <name>', '指定登录账户，跳过交互选择')
  .option('-l, --headless', '无头模式（后台运行）', false)
  .option('-t, --save-token <file>', '保存 token 到文件')
  .option('-q, --quiet', '只输出 token 字符串', false)
  .option('--no-clipboard', '不自动复制 token 到剪贴板')
  .action(async (options) => {
    const code = await loginCommand(options);
    process.exit(code);
  });

// token 命令
program
  .command('token')
  .description('获取 Authorization Token（每次重新登录，不缓存）')
  .option('-e, --env <name>', '指定登录环境名，筛选该环境下的账户')
  .option('-P, --profile <name>', '兼容旧参数：指定环境名')
  .option('-a, --account <name>', '指定登录账户，跳过交互选择')
  .option('-q, --quiet', '只输出 token 字符串', false)
  .option('--no-clipboard', '不自动复制 token 到剪贴板')
  .option('--no-headless', '显示浏览器窗口（默认无头）')
  .action(async (options) => {
    const code = await tokenCommand(options);
    process.exit(code);
  });

// 聚合目录启动组件管理命令。
const workspace = program.command('workspace').description('生成、更新和校验聚合目录的启动组件');

workspace
  .command('init <directory>')
  .description('生成目标目录的 javarun 转发脚本和 .bs-java-run 配置')
  .action(async directory => {
    try {
      process.exit(await initWorkspace(directory));
    } catch (error) {
      console.error(`错误: ${error.message}`);
      process.exit(1);
    }
  });

workspace
  .command('update <directory>')
  .description('重新扫描项目并更新受托管启动组件')
  .option('--configure', '交互式合并录入运行环境、Nacos 和可用用户')
  .option('--replace-all', '仅与 --configure 一起使用：全量覆盖未重新录入的环境和账户')
  .action(async (directory, options) => {
    try {
      if (options.replaceAll && !options.configure) {
        throw new Error('--replace-all 只能与 --configure 一起使用');
      }
      process.exit(await (options.configure
        ? reconfigureWorkspace(directory, { replaceAll: options.replaceAll })
        : updateWorkspace(directory)));
    } catch (error) {
      console.error(`错误: ${error.message}`);
      process.exit(1);
    }
  });

workspace
  .command('doctor <directory>')
  .description('校验工作区配置、工具链和构建产物')
  .action(async directory => {
    try {
      process.exit(await doctorWorkspace(directory));
    } catch (error) {
      console.error(`错误: ${error.message}`);
      process.exit(1);
    }
  });

workspace
  .command('smoke <directory> [service]')
  .description('显式启动冒烟，默认在就绪后停止本次进程')
  .option('-e, --env <name>', '选择目标运行环境名')
  .option('-P, --profile <name>', '兼容旧参数：选择命名运行环境')
  .option('-b, --build', '冒烟前构建服务', false)
  .option('-k, --keep-running', '就绪后保留本次启动的服务', false)
  .option('-T, --startup-timeout <seconds>', '服务启动等待超时时间（秒）')
  .action(async (directory, service, options) => {
    try {
      process.env.BS_JAVARUN_WORKSPACE = directory;
      delete globalThis._bsJavaRunConfig;
      process.exit(await smokeWorkspace(directory, service, options));
    } catch (error) {
      console.error(`错误: ${error.message}`);
      process.exit(1);
    }
  });

program.parse();

if (process.argv.length <= 2) {
  program.help();
}
