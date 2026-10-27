import { resolve } from 'node:path';
import { captureAfterTool, flushCaptures } from './lib/capture.ts';
import { disable, enable, outputBytes, readSettings, recoverCaptures, recoveryCount, verifyState } from './lib/state.ts';
import { normalizeHubUrl, OperationError } from './lib/common.ts';
import { validateTokenFile } from './lib/hub.ts';
import { submitProposals } from './lib/integrate.ts';

function options(args: string[], allowed: readonly string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith('--') || !allowed.includes(key) || value === undefined || result.has(key)) throw new OperationError('invalid_arguments', '命令参数不符合技能说明');
    result.set(key, value);
  }
  return result;
}

function required(values: Map<string, string>, key: string): string {
  const value = values.get(key);
  if (value === undefined) throw new OperationError('invalid_arguments', `缺参数 ${key}`);
  return value;
}

async function main(args: string[]): Promise<number> {
  const [command, ...rest] = args;
  if (command === 'hook') {
    const value: unknown = JSON.parse(await new Promise<string>((resolveInput, reject) => {
      const chunks: Buffer[] = [];
      process.stdin.on('data', chunk => chunks.push(Buffer.from(chunk)));
      process.stdin.on('end', () => resolveInput(Buffer.concat(chunks).toString('utf8')));
      process.stdin.on('error', reject);
    }));
    await captureAfterTool(value);
    return 0;
  }
  if (command === 'enable') {
    const values = options(rest, ['--session', '--hub', '--token-file']);
    const session = required(values, '--session');
    const hub = normalizeHubUrl(required(values, '--hub')).href;
    const tokenFile = resolve(required(values, '--token-file'));
    await validateTokenFile(tokenFile);
    await enable(session, hub, tokenFile);
    process.stdout.write('已只为本会话开启共享；工具输出由钩子脱敏后自动上传\n');
    return 0;
  }
  if (command === 'disable') {
    const values = options(rest, ['--session']);
    await disable(required(values, '--session'));
    process.stdout.write('已关闭本会话的新采集和待传上传\n');
    return 0;
  }
  if (command === 'recover') {
    const values = options(rest, ['--session']);
    const count = await recoverCaptures(required(values, '--session'));
    process.stdout.write(`已保全 ${count} 份未提交恢复件；它们不会作为完整原件上传\n`);
    return 0;
  }
  if (command === 'status') {
    const values = options(rest, ['--session']);
    const session = required(values, '--session');
    const settings = await readSettings(session);
    const captures = await verifyState(session);
    const uploaded = captures.filter(row => row.upload !== null).length;
    const recovered = await recoveryCount(session);
    process.stdout.write(`${JSON.stringify({ enabled: settings?.enabled ?? false, captured: captures.length, uploaded, pending: captures.length - uploaded, recovered }, null, 2)}\n`);
    return 0;
  }
  if (command === 'verify' || command === 'list') {
    const values = options(rest, ['--session']);
    const session = required(values, '--session');
    const captures = await verifyState(session);
    if (command === 'verify') process.stdout.write(`清单、哈希链、原件字节与上传引用一致；共 ${captures.length} 条采集，${await recoveryCount(session)} 份未提交恢复件\n`);
    else process.stdout.write(`${JSON.stringify(captures.map(row => ({ sequence: row.capture.sequence, captured_at: row.capture.captured_at, tool: row.capture.tool, input: row.capture.input, targets: row.capture.targets, output: row.capture.output, upload: row.upload?.source ?? null })), null, 2)}\n`);
    return 0;
  }
  if (command === 'read') {
    const values = options(rest, ['--session', '--sha']);
    const session = required(values, '--session');
    const digest = required(values, '--sha');
    const row = (await verifyState(session)).find(capture => capture.capture.output.sha256 === digest);
    if (!row?.upload) throw new OperationError('capture_not_uploaded', '没有已上传的这份原件');
    const bytes = await outputBytes(session, row.capture);
    process.stdout.write(bytes);
    return 0;
  }
  if (command === 'flush') {
    const values = options(rest, ['--session']);
    const count = await flushCaptures(required(values, '--session'));
    process.stdout.write(`本次重试 ${count} 条待传采集；用 status 核对实际上传回执\n`);
    return 0;
  }
  if (command === 'submit') {
    const values = options(rest, ['--session', '--proposals', '--product', '--build', '--model']);
    const answer = await submitProposals(
      required(values, '--session'),
      required(values, '--proposals'),
      required(values, '--product'),
      values.get('--build'),
      required(values, '--model'),
    );
    process.stdout.write(`${answer.texts.length > 0 ? answer.texts.join('\n') : JSON.stringify(answer.result, null, 2)}\n`);
    return answer.result.acceptance === 'accepted' ? 0 : 3;
  }
  throw new OperationError('invalid_arguments', '未知命令；按 SKILL.md 使用 enable、disable、status、verify、list、read、flush、recover 或 submit');
}

if (import.meta.main) {
  try { process.exitCode = await main(process.argv.slice(2)); }
  catch (error) {
    const code = error instanceof OperationError ? error.code : 'internal_error';
    const detail = error instanceof OperationError ? `：${error.message}` : '';
    process.stderr.write(`操作失败（${code}）${detail}\n`);
    process.exitCode = 1;
  }
}
