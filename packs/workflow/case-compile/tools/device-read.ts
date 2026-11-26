import { realpathSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RUN_ID } from '../functions/generated/skills/run-tools/hub-client/index.ts';
import { readTokenFromStdin, requireBearerToken } from '../functions/hub-retry.ts';
import { formatClientCallError, parseHubOrigin } from '../functions/client-cli.ts';
import { failCall, isRecord, parseCliOptions } from '../functions/text.ts';
import { hubTools, NotReady, refusalWords, type CallTool } from './open-compile.ts';

const USAGE = "device-read.ts --hub <MCP地址> --booking <test-bed 预订号> --device <设备名> --line <只读命令> --inventory <doc:doc:名字> --out <新文件> [--bed <测试环境名>]";
const READ_TIMEOUT_MS = 120_000;

export interface DeviceRead { read: true; file: string; line: string; device: string; lines: number; chars: number; truncated: boolean }
export interface NoDeviceRead { read: false; why: string }

export function readClaim(envelope: Record<string, unknown> | null): { output: string; truncated: boolean; observed: string | null } | string {
  const run = isRecord(envelope) && isRecord(envelope.run) ? envelope.run : null;
  const claims = run && Array.isArray(run.device_reads) ? run.device_reads.filter(isRecord) : [];
  for (const claim of claims) {
    const statement = isRecord(claim.statement) ? claim.statement : {}, data = isRecord(statement.data) ? statement.data : {};
    const qualifier = isRecord(claim.qualifier) ? claim.qualifier : {};
    if (typeof data.output === 'string') return { output: data.output, truncated: data.truncated === true, observed: typeof qualifier.collected_at === 'string' ? qualifier.collected_at : null };
  }
  const said = claims.map((claim) => (isRecord(claim.statement) && typeof claim.statement.text === 'string' ? claim.statement.text : '')).filter(Boolean).join('；');
  return said || 'Hub 的答复里没有这条命令的设备输出';
}

export async function readDevice(call: CallTool, options: { booking: string; device: string; line: string; inventory: string; bed?: string }): Promise<{ output: string; truncated: boolean; observed: string | null } | string> {
  const answer = await call('start_run', { pack: 'test-bed', inputs: { inventory: { external: options.inventory } }, predecessor: options.booking, parameters: { action: 'read', booking: options.booking, device: options.device, line: options.line, ...(options.bed ? { bed: options.bed } : {}) } });
  if (answer.failed) return refusalWords(answer).slice(0, 300);
  return readClaim(answer.envelope);
}

export async function main(argv: string[], readToken: () => Promise<string> = readTokenFromStdin, tools: (origin: string, bearer: string) => CallTool = (origin, bearer) => hubTools(origin, bearer, READ_TIMEOUT_MS)): Promise<number> {
  try {
    const args = parseCliOptions(argv, { hub: true, booking: true, device: true, line: true, out: true, bed: false, inventory: true }, USAGE) as Record<string, string>;
    if (!RUN_ID.test(args.booking)) failCall('invalid_parameters', '--booking 不是声明格式的运行编号', '写 test-bed 预订那次运行的编号后重试');
    if (/[\u0000-\u001f\u007f]/.test(args.line) || !args.line.trim()) failCall('invalid_parameters', '--line 要是一行普通文字', '写一条只读命令，不带换行和控制字符');
    const origin = parseHubOrigin(args.hub);
    const bearer = await requireBearerToken(readToken);
    let got: Awaited<ReturnType<typeof readDevice>>;
    try { got = await readDevice(tools(origin, bearer), { booking: args.booking, device: args.device, line: args.line.trim(), inventory: args.inventory, ...(args.bed ? { bed: args.bed } : {}) }); }
    catch (error) { if (!(error instanceof NotReady)) throw error; got = error.message.split('\n')[0]!.replace(/[：:]\s*$/, '').slice(0, 300); }
    if (typeof got === 'string') { process.stdout.write(JSON.stringify({ read: false, why: got } satisfies NoDeviceRead) + '\n'); return 0; }
    const head = `# 设备 ${args.device} 对“${args.line.trim()}”的输出${got.observed ? `（${got.observed} 读到）` : ''}；目标自报，未排除本地操作${got.truncated ? '；输出过长，已截断' : ''}\n# 只说明输出的写法和排版，不能当期望值的依据。\n`;
    await writeFile(args.out, head + got.output + (got.output.endsWith('\n') ? '' : '\n'), { flag: 'wx', mode: 0o600 });
    process.stdout.write(JSON.stringify({ read: true, file: args.out, line: args.line.trim(), device: args.device, lines: got.output.split('\n').length, chars: got.output.length, truncated: got.truncated } satisfies DeviceRead) + '\n');
    return 0;
  } catch (error) { process.stderr.write(formatClientCallError(error) + '\n'); return 1; }
}
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) process.exitCode = await main(process.argv.slice(2));
