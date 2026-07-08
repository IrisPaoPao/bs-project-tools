import { spawnSync } from 'child_process';

// 按平台选择剪贴板写入命令
function resolveClipboardCommand() {
  switch (process.platform) {
    case 'darwin':
      return { cmd: 'pbcopy', args: [] };
    case 'win32':
      return { cmd: 'clip', args: [] };
    default:
      // Linux: 优先 xclip，退化到 xsel
      return { cmd: 'xclip', args: ['-selection', 'clipboard'], fallback: { cmd: 'xsel', args: ['--clipboard', '--input'] } };
  }
}

// 将文本写入系统剪贴板，成功返回 true。全程不回显内容。
export function copyToClipboard(text) {
  const { cmd, args, fallback } = resolveClipboardCommand();

  const run = (c, a) => spawnSync(c, a, { input: text, stdio: ['pipe', 'ignore', 'ignore'] });

  let result = run(cmd, args);
  if ((result.error || result.status !== 0) && fallback) {
    result = run(fallback.cmd, fallback.args);
  }

  return !result.error && result.status === 0;
}
