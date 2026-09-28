/**
 * 机器可读模式下暂存命令内部的人类日志，保证 stdout 最终只有一个 JSON 文档。
 * 运行期间仍允许业务代码正常写日志；命令结束后统一恢复原输出流。
 */
export async function withJsonOutput(options, execute, createPayload) {
  if (!options?.json || options.dryRun || options.__jsonCapture) {
    return execute();
  }

  const captured = [];
  const originalLog = console.log;
  const originalError = console.error;
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  const capture = chunk => {
    if (chunk !== undefined && chunk !== null) captured.push(String(chunk));
  };

  console.log = (...args) => capture(args.join(' '));
  console.error = (...args) => capture(args.join(' '));
  process.stdout.write = chunk => {
    capture(chunk);
    return true;
  };
  process.stderr.write = chunk => {
    capture(chunk);
    return true;
  };

  let code = 1;
  let thrown = null;
  try {
    code = await execute();
  } catch (error) {
    thrown = error;
  } finally {
    console.log = originalLog;
    console.error = originalError;
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }

  const payload = createPayload(code, { captured, error: thrown });
  originalLog(JSON.stringify(payload, null, 2));
  if (thrown) return 1;
  return code;
}
