import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HubReplyError, RUN_ID } from '../functions/generated/skills/run-tools/hub-client/index.ts';
import { DEFAULT_TIMING, READ_RETRY_BUDGET_MS, READ_TIMEOUT_MS, downloadRunRetrying, getRetrying, readTokenFromStdin, requireBearerToken, type FetchLike, type RetryControl } from '../functions/hub-retry.ts';
import { formatClientCallError, parseHubOrigin } from '../functions/client-cli.ts';
import { DEVICE_HISTORY_SCHEMA, HISTORY_BUDGET_MS, HISTORY_DIRECTORY, HISTORY_FETCHING_FILE, HISTORY_FILE, HISTORY_MAX_RUNS, HISTORY_PENDING_REASON, parseDeviceHistory, parseHubHistory, type DeviceHistoryFile, type HistoryReturn, type HubHistory } from '../functions/device-history.ts';
import { writeBriefs } from './authoring-brief.ts';
import { downloadReturns } from './download-returns.ts';
import { fetchLate, lateSummary, writeNewLateFile } from './refresh-late.ts';
import { CallFailure, isRecord, failCall, parseCliOptions } from '../functions/text.ts';

async function saveRunReference(origin: string, bearer: string, run: string, out: string, retry?: RetryControl): Promise<string | undefined> {
  const bytes = await getRetrying(`${origin}/run-export/${run}/run`, bearer, retry);
  let exported: unknown;
  try { exported = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { failCall('temporarily_unavailable', '运行引用答复不是完整的 UTF-8 JSON', '请维护者恢复符合声明协议的完整运行导出，再按同一请求读取 run_reference'); }
  if (!isRecord(exported) || typeof exported.run_reference !== 'string' || !exported.run_reference) return undefined;
  await writeFile(join(out, 'references.json'), Buffer.from(JSON.stringify({ schema: 'run-references@1', run, run_reference: exported.run_reference }, null, 2) + '\n'), { flag: 'wx', mode: 0o600 });
  return exported.run_reference;
}

export interface HistoryControl {
  budgetMs?: number; maxRuns?: number; parallel?: number;
  inline?: boolean;
  start?: StartFetch;
}
export type StartFetch = (argv: string[], token: string) => void;
export interface HistoryReport { status: 'fetched' | 'reused' | 'fetching' | 'unavailable_from_hub'; runs: number; downloaded: number; file: string; reason?: string }
const startSelf: StartFetch = (argv, token) => {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...argv], { detached: true, stdio: ['pipe', 'ignore', 'ignore'] });
  child.on('error', () => undefined); child.stdin.on('error', () => undefined);
  child.stdin.end(`${token}\n`);
  child.unref();
};
const HISTORY_PARALLEL = 3;
const said = (error: unknown): string => (error instanceof CallFailure ? error.fact : error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').trim().slice(0, 300);

export async function deviceHistory(input: { origin: string; bearer: string; run: string; out: string; shared: string; reuseOnly: boolean; replace?: boolean }, retry?: RetryControl, control: HistoryControl = {}): Promise<HistoryReport> {
  const timing = retry?.timing ?? DEFAULT_TIMING, started = timing.now(), budget = control.budgetMs ?? HISTORY_BUDGET_MS, deadline = started + budget;
  const maxRuns = Math.max(1, Math.min(HISTORY_MAX_RUNS, control.maxRuns ?? HISTORY_MAX_RUNS));
  const target = join(input.out, HISTORY_FILE), kept = join(input.shared, HISTORY_FILE);
  const bytes = (file: DeviceHistoryFile) => Buffer.from(JSON.stringify(file, null, 2) + '\n');
  const put = input.replace ? { mode: 0o600 } : { flag: 'wx', mode: 0o600 };
  const reportOf = (file: DeviceHistoryFile, reused: boolean): HistoryReport => ({
    status: file.status === 'fetched' ? (reused ? 'reused' : 'fetched') : 'unavailable_from_hub',
    runs: file.answer?.runs.length ?? 0, downloaded: file.returns.filter((row) => row.dir !== null).length, file: target, ...(file.reason ? { reason: file.reason } : {}),
  });
  const unavailable = (reason: string): DeviceHistoryFile => ({ schema: DEVICE_HISTORY_SCHEMA, run: input.run, fetched_at: new Date().toISOString(), status: 'unavailable', reason, answer: null, returns: [], elapsed_ms: Math.max(0, timing.now() - started) });

  let earlier: DeviceHistoryFile | null = null;
  try { earlier = parseDeviceHistory(JSON.parse(await readFile(kept, 'utf8'))); } catch { earlier = null; }
  if (earlier && (earlier.status === 'fetched' || input.reuseOnly)) { await writeFile(target, bytes(earlier), put); return reportOf(earlier, true); }
  if (input.reuseOnly) {
    const none = unavailable(`这次编译开始时没有取到上机历史（${kept} 不存在），返工新开的运行不再向 Hub 取`);
    await writeFile(target, bytes(none), put);
    return reportOf(none, false);
  }

  const left = () => deadline - timing.now(), spent = () => left() <= 25;
  const base: FetchLike = retry?.fetch ?? fetch;
  const bounded = (): RetryControl => ({
    ...retry, timing, maxWaitMs: Math.max(0, Math.min(retry?.maxWaitMs ?? READ_RETRY_BUDGET_MS, left())), timeoutMs: Math.max(1, Math.min(retry?.timeoutMs ?? READ_TIMEOUT_MS, left())),
    fetch: (url, init) => {
      const remaining = left();
      if (spent()) return Promise.reject(Object.assign(new Error('history budget spent'), { name: 'TimeoutError' }));
      const limit = AbortSignal.timeout(Math.max(1, remaining));
      return base(url, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, limit]) : limit });
    },
  });
  const save = async (file: DeviceHistoryFile): Promise<HistoryReport> => {
    await mkdir(input.shared, { recursive: true, mode: 0o700 });
    await writeFile(kept, bytes(file), { mode: 0o600 });
    await writeFile(target, bytes(file), put);
    return reportOf(file, false);
  };

  let answer: HubHistory | null = null, reason = '';
  try {
    const reply = await getRetrying(`${input.origin}/run-export/${input.run}/history?limit=${maxRuns}`, input.bearer, bounded());
    let parsed: unknown = null;
    try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(reply)); } catch { parsed = null; }
    answer = parseHubHistory(parsed, input.run);
    if (answer === null) reason = 'Hub 对历次上机验证的答复不是 run-history@1，没有采用';
  } catch (error) {
    reason = error instanceof HubReplyError && error.status === 404
      ? 'Hub 没有历次上机验证的查询接口（答复 404）：这台 Hub 的版本早于这个接口'
      : `向 Hub 取历次上机验证没有成功：${said(error)}`;
  }
  if (answer === null) return save(unavailable(reason));

  const runs = answer.runs.slice(0, maxRuns), returns: HistoryReturn[] = new Array(runs.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let at = next++; at < runs.length; at = next++) {
      const run = runs[at]!.run, dir = join(input.shared, run), shown = relative(process.cwd(), resolve(dir)) || '.';
      if (existsSync(join(dir, 'index.json'))) { returns[at] = { run, dir: shown }; continue; }
      if (spent()) { returns[at] = { run, dir: null, reason: `取上机历史的总时限 ${Math.round(budget / 1000)} 秒已到，这一次的设备输出没有下载` }; continue; }
      try {
        const { timing: _timing, ...control } = bounded();
        await downloadReturns({ origin: input.origin, bearer: input.bearer, run, out: dir }, timing, control);
        returns[at] = { run, dir: shown };
      } catch (error) { returns[at] = { run, dir: null, reason: spent() ? `取上机历史的总时限 ${Math.round(budget / 1000)} 秒已到，这一次的设备输出没有下载完` : said(error) }; }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(control.parallel ?? HISTORY_PARALLEL, runs.length)) }, worker));
  return save({ schema: DEVICE_HISTORY_SCHEMA, run: input.run, fetched_at: new Date().toISOString(), status: 'fetched', answer: { ...answer, runs }, returns, elapsed_ms: Math.max(0, timing.now() - started) });
}

export async function startHistory(input: { hub: string; bearer: string; run: string; out: string; shared: string }, control: HistoryControl = {}): Promise<HistoryReport> {
  const target = join(input.out, HISTORY_FILE), kept = join(input.shared, HISTORY_FILE), marker = join(input.shared, HISTORY_FETCHING_FILE);
  const bytes = (file: DeviceHistoryFile) => Buffer.from(JSON.stringify(file, null, 2) + '\n');
  let earlier: DeviceHistoryFile | null = null;
  try { earlier = parseDeviceHistory(JSON.parse(await readFile(kept, 'utf8'))); } catch { earlier = null; }
  if (earlier?.status === 'fetched') {
    await writeFile(target, bytes(earlier), { flag: 'wx', mode: 0o600 });
    return { status: 'reused', runs: earlier.answer?.runs.length ?? 0, downloaded: earlier.returns.filter((row) => row.dir !== null).length, file: target };
  }
  const shared = relative(process.cwd(), resolve(input.shared)) || '.';
  await writeFile(target, bytes({ schema: DEVICE_HISTORY_SCHEMA, run: input.run, fetched_at: new Date().toISOString(), status: 'unavailable', reason: HISTORY_PENDING_REASON, answer: null, returns: [], elapsed_ms: 0, pending: { shared } }), { flag: 'wx', mode: 0o600 });
  await mkdir(input.shared, { recursive: true, mode: 0o700 });
  let under = false;
  try { const mark: unknown = JSON.parse(await readFile(marker, 'utf8')); under = isRecord(mark) && typeof mark.started_ms === 'number' && Date.now() - mark.started_ms < (control.budgetMs ?? HISTORY_BUDGET_MS) + 60_000; } catch { under = false; }
  if (!under) {
    await writeFile(marker, JSON.stringify({ run: input.run, started_ms: Date.now() }) + '\n', { mode: 0o600 });
    try { (control.start ?? startSelf)(['--hub', input.hub, '--run', input.run, '--out', input.out, '--history-fetch', 'yes'], input.bearer); }
    catch (error) { await rm(marker, { force: true }); return { status: 'unavailable_from_hub', runs: 0, downloaded: 0, file: target, reason: `取上机历史的后台进程没有起来：${said(error)}` }; }
  }
  return { status: 'fetching', runs: 0, downloaded: 0, file: target };
}

export async function main(argv: string[], readToken: () => Promise<string> = readTokenFromStdin, brief: (directory: string) => Promise<{ briefs: number }> = writeBriefs, retry?: RetryControl, history?: HistoryControl): Promise<number> {
  try {
    const args = parseCliOptions(argv, { hub: true, run: true, out: true, 'history-reuse': false, 'history-fetch': false }, 'download-run.ts --hub <MCP地址> --run <运行编号> --out <新的空目录>') as Record<string, string>;
    if (!RUN_ID.test(args.run)) failCall('invalid_parameters', '--run 不是声明格式的运行编号', '请使用本次用例重组或脚本编写的编号后重试');
    const origin = parseHubOrigin(args.hub);
    const bearer = await requireBearerToken(readToken);
    const shared = args['history-reuse'] ?? join(dirname(args.out), HISTORY_DIRECTORY);
    if (args['history-fetch'] !== undefined) {
      let fetched: HistoryReport;
      try { fetched = await deviceHistory({ origin, bearer, run: args.run, out: args.out, shared, reuseOnly: false, replace: true }, retry, history); }
      catch (error) { fetched = { status: 'unavailable_from_hub', runs: 0, downloaded: 0, file: join(args.out, HISTORY_FILE), reason: `上机历史没有存下来：${said(error)}` }; }
      finally { await rm(join(shared, HISTORY_FETCHING_FILE), { force: true }); }
      process.stdout.write(JSON.stringify({ run: args.run, history: fetched }) + '\n'); return 0;
    }
    const late = await fetchLate(origin, bearer, args.run, retry);
    const { files, ...report } = await downloadRunRetrying(origin, bearer, args.run, args.out, retry);
    const runReference = await saveRunReference(origin, bearer, args.run, args.out, retry);
    if (late) await writeNewLateFile(args.out, late);
    let briefs = 0, note: string | undefined;
    try { briefs = (await brief(args.out)).briefs; } catch (error) { note = `脚本编写所需的原始用例和手册未保存。原因${error instanceof Error ? error.message : '还没查清'}；其余原始资料已下载，请从原始资料继续脚本编写`; }
    const historyFile = join(args.out, HISTORY_FILE);
    let historyReport: HistoryReport;
    try {
      historyReport = args['history-reuse'] !== undefined || history?.inline
        ? await deviceHistory({ origin, bearer, run: args.run, out: args.out, shared, reuseOnly: args['history-reuse'] !== undefined }, retry, history)
        : await startHistory({ hub: args.hub, bearer, run: args.run, out: args.out, shared }, history);
    }
    catch (error) { historyReport = { status: 'unavailable_from_hub', runs: 0, downloaded: 0, file: historyFile, reason: `上机历史没有存下来：${said(error)}` }; }
    const lateReport = late ? (() => { const summary = lateSummary(late, null); return { late: { accepted: summary.accepted.length, waiting: summary.waiting.length, note: `${summary.waiting.length} 条用例的重组记录还没被受理；每受理一条，用 refresh-late.ts 重取 late.json 并补写它的编写简报` } }; })() : {};
    process.stdout.write(JSON.stringify({ ...report, ...(runReference ? { run_reference: runReference } : {}), ...lateReport, written: Object.keys(files).length + (runReference ? 1 : 0) + (late ? 1 : 0) + briefs, briefs, ...(note ? { briefs_note: note } : {}), history: historyReport }) + '\n'); return 0;
  } catch (error) { process.stderr.write(formatClientCallError(error) + '\n'); return 1; }
}
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) process.exitCode = await main(process.argv.slice(2));
