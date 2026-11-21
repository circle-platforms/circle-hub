import { realpathSync } from 'node:fs';
import { lstat, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HubReplyError, RUN_ID, sha256 } from '../functions/generated/skills/run-tools/hub-client/index.ts';
import { fetchBytesRetrying, MAX_BYTES, readTokenFromStdin, requireBearerToken, type RetryControl } from '../functions/hub-retry.ts';
import { formatClientCallError, parseHubOrigin } from '../functions/client-cli.ts';
import { LATE_FILE, overlayOf, readLate, readLateFile, type RunLate } from '../functions/late.ts';
import { failCall, isRecord, parseCliOptions } from '../functions/text.ts';
import { writeBriefs } from './authoring-brief.ts';

const USAGE = "node <技能目录>/tools/refresh-late.ts --hub <MCP地址> --run <脚本编写运行号> --dir <运行目录>";

export async function fetchLate(origin: string, bearer: string, run: string, retry?: RetryControl): Promise<RunLate | null> {
  let reply: Awaited<ReturnType<typeof fetchBytesRetrying>>;
  try { reply = await fetchBytesRetrying(`${origin}/run-export/${run}/late`, bearer, MAX_BYTES, retry); } catch (error) {
    if (error instanceof HubReplyError && error.status === 404) return null;
    throw error;
  }
  if (reply.digest !== null && sha256(reply.bytes) !== reply.digest) failCall('invalid_parameters', '晚绑定导出的字节与 Hub 给的摘要不符，什么都没有写入', '稍后用同一命令重取；仍不符时请维护者核对 Hub 的晚绑定导出');
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(reply.bytes)); } catch { failCall('invalid_parameters', 'Hub 的晚绑定导出不是完整的 UTF-8 JSON，什么都没有写入', '稍后用同一命令重取；仍不完整时请维护者核对 Hub 的晚绑定导出'); }
  const late = readLate(value, run);
  if (typeof late === 'string') failCall('invalid_parameters', `Hub 的晚绑定导出不是运行 ${run} 的 run-late@1 答复（${late}），什么都没有写入`, '核对 --run 是本次脚本编写的运行号；仍不符时请维护者核对 Hub 的晚绑定导出');
  return late;
}

const lateBytes = (late: RunLate): Buffer => Buffer.from(JSON.stringify(late, null, 2) + '\n');

export async function writeNewLateFile(directory: string, late: RunLate): Promise<void> {
  await writeFile(join(directory, LATE_FILE), lateBytes(late), { flag: 'wx', mode: 0o600 });
}

export async function replaceLateFile(directory: string, late: RunLate): Promise<void> {
  const target = join(directory, LATE_FILE), staged = join(directory, `.${LATE_FILE}.${process.pid}.tmp`);
  try {
    await writeFile(staged, lateBytes(late), { flag: 'wx', mode: 0o600 });
    await rename(staged, target);
  } catch (error) { await rm(staged, { force: true }); throw error; }
}

export function lateSummary(late: RunLate, before: RunLate | null): { accepted: string[]; waiting: Array<{ item: string; state: string | null; problem: string | null }>; newly_accepted: string[]; changed: string[] } {
  const accepted: string[] = [], waiting: Array<{ item: string; state: string | null; problem: string | null }> = [], newly: string[] = [], changed: string[] = [];
  for (const row of late.items) {
    const proof = row.late.recomposition, earlier = overlayOf(before, row.id)?.recomposition;
    if (isRecord(proof)) {
      accepted.push(row.id);
      if (!isRecord(earlier)) newly.push(row.id);
      else if (earlier.record_sha256 !== proof.record_sha256) changed.push(row.id);
      continue;
    }
    const waits = isRecord(row.late.recomposition_waiting) ? row.late.recomposition_waiting : null;
    waiting.push({ item: row.id, state: waits && typeof waits.state === 'string' ? waits.state : null, problem: typeof row.late.recomposition_problem === 'string' ? row.late.recomposition_problem : null });
  }
  return { accepted, waiting, newly_accepted: newly, changed };
}

export async function main(argv: string[], readToken: () => Promise<string> = readTokenFromStdin, retry?: RetryControl): Promise<number> {
  try {
    const args = parseCliOptions(argv, { hub: true, run: true, dir: true }, USAGE) as Record<string, string>;
    if (!RUN_ID.test(args.run)) failCall('invalid_parameters', '--run 不是声明格式的运行编号', '请使用本次脚本编写的运行编号后重试');
    const origin = parseHubOrigin(args.hub);
    const directory = resolve(args.dir);
    const runFile = await lstat(join(directory, 'run.json')).catch(() => null);
    if (!runFile?.isFile()) failCall('not_found', `--dir ${args.dir} 里没有 run.json（不是 download-run.ts 下载的运行目录），什么都没有写入`, '--dir 写 download-run.ts 下载本次脚本编写运行的目录（放 run.json 的目录）');
    let frozen: unknown;
    try { frozen = JSON.parse(await readFile(join(directory, 'run.json'), 'utf8')); } catch { failCall('invalid_parameters', `--dir ${args.dir} 里的 run.json 不是完整的 JSON，什么都没有写入`, '用 download-run.ts 把本次脚本编写运行重新下载到一个新目录，再对那个目录运行本命令'); }
    if (!isRecord(frozen) || frozen.run !== args.run) failCall('invalid_parameters', `--dir ${args.dir} 里的 run.json 是运行 ${isRecord(frozen) ? String(frozen.run) : '（不明）'} 的，不是 --run 的 ${args.run}，什么都没有写入`, '--dir 写 download-run.ts 下载这个脚本编写运行的目录，--run 写同一个运行号');
    const bearer = await requireBearerToken(readToken);
    const before = readLateFile(directory, args.run);
    const late = await fetchLate(origin, bearer, args.run, retry);
    if (!late) {
      process.stdout.write(JSON.stringify({ run: args.run, dir: args.dir, late: false, note: `Hub 说运行 ${args.run} 没有开运行后再绑定的输入（晚绑定导出答 404），${LATE_FILE} 不写；条目的重组记录都冻结在 items/<序号>.json` }) + '\n');
      return 0;
    }
    await replaceLateFile(directory, late);
    let briefs = 0, note: string | undefined;
    try { briefs = (await writeBriefs(directory)).briefs; } catch (error) { note = `编写简报没有写成：${error instanceof Error ? error.message : '原因还没查清'}；${LATE_FILE} 已更新，写手可直接读它和 items/<序号>.json`; }
    const summary = lateSummary(late, before);
    process.stdout.write(JSON.stringify({ run: args.run, dir: args.dir, resolved_at: late.resolved_at, inputs: late.late.inputs, accepted: summary.accepted.length, newly_accepted: summary.newly_accepted, ...(summary.changed.length ? { changed: summary.changed, changed_note: '这些用例的重组记录在上次取之后又被受理了一份不同的记录（record_sha256 变了）；已写的简报和计划要按新记录核对' } : {}), waiting: summary.waiting, briefs, ...(note ? { briefs_note: note } : {}) }) + '\n');
    return 0;
  } catch (error) { process.stderr.write(formatClientCallError(error) + '\n'); return 1; }
}
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) process.exitCode = await main(process.argv.slice(2));
