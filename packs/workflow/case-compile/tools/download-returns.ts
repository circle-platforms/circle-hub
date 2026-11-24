import { realpathSync } from 'node:fs';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { executionRefusals, failureLine, parseRunJobs, syntaxRejections, unexecutedRows, workbookAbort, type ExecutionRefusal, type ReachRow, type RowAudit, type SyntaxRejection } from '../functions/delivery.ts';
import { HubReplyError, RUN_ID, sha256 } from '../functions/generated/skills/run-tools/hub-client/index.ts';
import {
  getOnce,
  getRetrying,
  isConnectionRefused,
  READ_RETRY_BUDGET_MS,
  READ_TIMEOUT_MS,
  readTokenFromStdin,
  requireBearerToken,
  RetryExhaustedError,
  TransientHubReplyError,
  type RetryControl,
} from '../functions/hub-retry.ts';
import { CallFailure, failCall, isRecord, parseCliOptions } from '../functions/text.ts';
import { formatClientCallError, parseHubOrigin } from '../functions/client-cli.ts';
import { fetchRunInputs } from './fetch-run.ts';
import { contractFailureMarkers, passReviewInputs } from './generate-workbook.ts';
import { afterRound, ranJob } from '../functions/next-step.ts';

const SOURCE = /^src:([0-9a-f]{64})$/;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;
const json = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const OPTIONS: Record<string, boolean> = { hub: true, run: true, out: true, wait: false };
export const WAIT_MAX_SECONDS = 86_400, POLL_MS = 20_000, UNDISPATCHED_MS = 300_000;
/**
 * The mark of how an index.json is written, beside its schema. Returns are kept on disk (the history of earlier device runs) and a later
 * download reuses them; a directory whose index lacks this mark or holds another was written by an earlier version of this tool, whose rows
 * differ (version 2 lists the commands a device refused whatever the pack version of the run), and is downloaded again. Raise it whenever
 * the rows an index holds change in what they say.
 */
export const RETURNS_FORMAT = 2;
export interface Timing { now: () => number; pause: (ms: number) => Promise<void> }
const REAL_TIME: Timing = { now: () => Date.now(), pause: (ms) => new Promise((done) => setTimeout(done, ms)) };

async function assertEmptyOutput(out: string): Promise<void> {
  const taken = await readdir(out).catch((error) => { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [] as string[]; throw error; });
  if (taken.length) failCall('occupied', '输出目录里已有文件', '另选新的空目录下载，不覆盖已有资料', { path: out, legal_form: '--out <新的空目录>' });
}

export async function downloadReturns(input: { origin: string; bearer: string; run: string; out: string; wait?: number }, timing: Timing = REAL_TIME, retry?: Omit<RetryControl, 'timing'>): Promise<Record<string, unknown>> {
    const args = { run: input.run, out: input.out }, origin = input.origin, bearer = input.bearer, wait = input.wait ?? 0;
    await assertEmptyOutput(args.out);
    const readRetry: RetryControl = { ...retry, timing };
    const jobsUrl = `${origin}/run-export/${args.run}/jobs`;
    const started = timing.now(), deadline = started + wait * 1000;
    const initialBudget = wait ? Math.min(retry?.maxWaitMs ?? READ_RETRY_BUDGET_MS, wait * 1000) : retry?.maxWaitMs;
    const parsed = (bytes: Uint8Array) => { let answer: unknown; try { answer = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { failCall('temporarily_unavailable', '上机作业列表不是完整的 UTF-8 JSON', '请维护者恢复符合声明协议的完整作业列表，再按同一请求读取'); } return { answer, own: parseRunJobs(answer, args.run).filter((job) => job.verification_run === args.run) }; };
    let { answer: listed, own: jobs } = parsed(await getRetrying(jobsUrl, bearer, { ...readRetry, ...(initialBudget !== undefined ? { maxWaitMs: initialBudget } : {}) }));
    if (wait) {
      let pendingRetryAfterMs: number | null = null;
      let zeroRetryAfterCount = 0;
      let pollAttempts = 1;
      let lastPollFailure: { reason: string; status?: number; code?: string } | null = null;
      process.stderr.write(`等待上机验证结束，最多 ${wait} 秒；结束后保存设备输出\n`);
      while (!jobs.length || jobs.some((job) => job.ended === null)) {
        const now = timing.now();
        if (!jobs.length && now - started >= Math.min(UNDISPATCHED_MS, wait * 1000)) failCall('temporarily_unavailable', '尚未开始上机验证，设备输出尚未保存', '原样再做一次脚本合并，查看 Hub 的上机验证说明');
        if (now >= deadline) {
          if (lastPollFailure) {
            throw new RetryExhaustedError(
              new CallFailure('temporarily_unavailable', `${lastPollFailure.reason}，已等待 ${Math.round((now - started) / 1000)} 秒并尝试 ${pollAttempts} 次仍未恢复`, '请待 Hub 恢复后用同一命令继续等待'),
              { status: lastPollFailure.status, code: lastPollFailure.code, waitedMs: now - started, attempts: pollAttempts },
            );
          }
          failCall('temporarily_unavailable', `等了 ${wait} 秒，上机验证还没有结束，设备输出尚未保存`, '用同一命令继续等待');
        }
        const remainingWait = deadline - now;
        if (pendingRetryAfterMs !== null && pendingRetryAfterMs > remainingWait) {
          throw new RetryExhaustedError(
            new CallFailure('temporarily_unavailable', `${lastPollFailure?.reason ?? 'Hub 答复 503'}，已等待 ${Math.round((now - started) / 1000)} 秒并尝试 ${pollAttempts} 次，Hub 要求等待 ${Math.ceil(pendingRetryAfterMs / 1000)} 秒超过剩余等待时间`, '请待 Hub 恢复后用同一命令继续等待'),
            { status: 503, waitedMs: now - started, attempts: pollAttempts },
          );
        }
        let nextPause: number;
        if (pendingRetryAfterMs !== null) {
          if (pendingRetryAfterMs === 0 && zeroRetryAfterCount >= 3) nextPause = Math.min(POLL_MS, remainingWait);
          else {
            zeroRetryAfterCount = pendingRetryAfterMs === 0 ? zeroRetryAfterCount + 1 : 0;
            nextPause = pendingRetryAfterMs;
          }
        } else {
          zeroRetryAfterCount = 0;
          nextPause = Math.min(POLL_MS, remainingWait);
        }
        await timing.pause(nextPause);
        pendingRetryAfterMs = null;
        let bytes: Uint8Array | null = null;
        pollAttempts++;
        try {
          bytes = await getOnce(jobsUrl, bearer, { fetch: retry?.fetch, timeoutMs: retry?.timeoutMs ?? READ_TIMEOUT_MS, timing });
          lastPollFailure = null;
        } catch (error) {
          if (error instanceof HubReplyError && error.status < 500) throw error;
          if (error instanceof TransientHubReplyError) {
            pendingRetryAfterMs = error.retryAfterMs;
            lastPollFailure = { reason: error.summary, status: 503 };
          } else if (isConnectionRefused(error)) {
            lastPollFailure = { reason: 'Hub 不可达（ECONNREFUSED）', code: 'ECONNREFUSED' };
          } else if (error instanceof HubReplyError) {
            lastPollFailure = { reason: error.message, status: error.status };
          } else {
            lastPollFailure = { reason: error instanceof CallFailure ? error.fact : '读取上机验证状态失败' };
          }
        }
        if (bytes) ({ answer: listed, own: jobs } = parsed(bytes));
      }
    }
    if (!jobs.length) failCall('temporarily_unavailable', '尚未开始上机验证', '--run 使用已开始上机验证的编号后重试');
    const outputs: Array<{ name: string; bytes: Uint8Array }> = [{ name: 'jobs.json', bytes: json(listed) }];
    const withheld: string[] = [];
    const piece = async (reference: string | null | undefined, name: string): Promise<string | null> => {
      const sha = SOURCE.exec(String(reference ?? ''))?.[1];
      if (!sha) return null;
      let bytes: Uint8Array;
      try { bytes = await getRetrying(`${origin}/run-export/${args.run}/sources/${sha}`, bearer, readRetry); }
      catch (error) { if (error instanceof HubReplyError && error.status === 403) { withheld.push(`${name}，没有读取这份设备输出的权限`); return null; } throw error; }
      if (sha256(bytes) !== sha) failCall('invalid_parameters', `${name} 与 Hub 保存的设备输出摘要不一致，设备输出尚未保存`, '重新读取并核对该设备输出原件后重试');
      outputs.push({ name, bytes });
      return name;
    };
    const index: Array<Record<string, unknown>> = [];
    let refused = 0, unexecuted = 0, unreached = 0, aborted = 0;
    // What the returns of one plan run are read with: the failure markers of its own contract, and, when its recipes can be computed,
    // the assertions of its cases for re-reading a pass. A string is the reason nothing could be read.
    type PlanReview = { markers: string[]; assertions: Map<string, string[]> } | { markers: string[]; assertions: null; recipesFact: string };
    const reviews = new Map<string, PlanReview | string>();
    const titles = new Map<string, Map<string, string>>();
    const reviewOf = async (planRun: string): Promise<PlanReview | string> => {
      if (!reviews.has(planRun)) {
        let plan: Awaited<ReturnType<typeof fetchRunInputs>> | undefined;
        try {
          plan = await fetchRunInputs(origin, bearer, planRun, readRetry);
          titles.set(planRun, new Map((Array.isArray(plan.run.items) ? plan.run.items : []).flatMap((item) => isRecord(item) && isRecord(item.fields) && typeof item.fields.autoid === 'string' && typeof item.fields.title === 'string' ? [[item.fields.autoid, item.fields.title] as const] : [])));
          reviews.set(planRun, passReviewInputs({ run: plan.run, result: plan.result, submission: plan.submission, contract: plan.originals.contract, profile: plan.originals.profile, inventory: plan.originals.inventory }));
        }
        catch (error) {
          const fact = error instanceof Error ? error.message : '读取失败';
          // Which commands the device refused needs only the markers of this run's own contract, a source the run bound and the Hub checked
          // by digest, and the device sessions. Only re-reading a pass needs the recipes, which another version of this tool cannot compute.
          const markers = plan === undefined ? [] : contractFailureMarkers(plan.originals.contract);
          reviews.set(planRun, markers.length ? { markers, assertions: null, recipesFact: fact } : fact);
        }
      }
      return reviews.get(planRun)!;
    };
    const verdicts: Record<string, number> = {};
    const passReview = { markers: null as number | null, read: 0, downgraded: 0, wordless: 0, unread: [] as string[] };
    const passesUnread = new Set<string>();
    for (const job of jobs) {
      const folder = job.job.slice(0, 12);
      const deviceReturn = await piece(job.device_return, join(folder, 'device-return.txt'));
      const rows: Array<Record<string, unknown>> = [];
      const built: Array<{ entry: Record<string, unknown>; reach: ReachRow }> = [];
      const review = (job.rows ?? []).length ? await reviewOf(job.plan_run) : null;
      if (typeof review === 'string') passReview.unread.push(`缺少执行器规则或自动化用例，尚未核对设备输出，也未列出被设备拒绝执行的命令`);
      else if (review?.markers.length) {
        passReview.markers = Math.max(passReview.markers ?? 0, review.markers.length);
        if (review.assertions === null && !passesUnread.has(job.plan_run)) {
          passesUnread.add(job.plan_run);
          passReview.unread.push(`没有重读脚本编写运行 ${job.plan_run} 的通过结论：${review.recipesFact.replace(/[。.]+$/u, '')}；被设备拒绝执行的命令已照这个运行自己的执行器规则列出`);
        }
      }
      for (const row of job.rows ?? []) {
        if (!/^[0-9A-Za-z_-]{1,64}$/.test(row.item)) failCall('invalid_parameters', '原始用例的编号不能作为设备输出的目录名', '核对原始用例编号格式并重新导出后重试');
        const log = await piece(row.evidence?.log, join(folder, 'cases', row.item, 'log.txt'));
        let dropped: RowAudit | null = null;
        if (row.dynamic_terminal === 'pass' && review && typeof review !== 'string' && review.markers.length && review.assertions !== null) {
          const bytes = log === null ? undefined : outputs.find((output) => output.name === log)?.bytes;
          if (!bytes) passReview.wordless++;
          else { passReview.read++; dropped = failureLine({ 运行日志: new TextDecoder().decode(bytes) }, review.markers, review.assertions.get(row.item) ?? []); if (dropped) passReview.downgraded++; }
        }
        const verdict = dropped ? 'no_verdict' : row.dynamic_terminal;
        const sessions: Record<string, string | null> = {};
        for (const [k, [name, reference]] of Object.entries(row.evidence?.sessions ?? {}).entries()) {
          const file = SAFE_NAME.test(name) && name !== 'log.txt' ? name : `session-${k + 1}.txt`;
          sessions[name] = await piece(reference, join(folder, 'cases', row.item, file));
        }
        const rejected: Array<SyntaxRejection & { session: string }> = [];
        for (const [name, file] of Object.entries(sessions)) {
          const bytes = file === null ? undefined : outputs.find((output) => output.name === file)?.bytes;
          if (bytes) for (const rejection of syntaxRejections(new TextDecoder().decode(bytes))) rejected.push({ session: name, ...rejection });
        }
        refused += rejected.length;
        const markers = review && typeof review !== 'string' ? review.markers : null;
        const failed: Array<ExecutionRefusal & { session: string }> = [];
        if (markers?.length) for (const [name, file] of Object.entries(sessions)) {
          const bytes = file === null ? undefined : outputs.find((output) => output.name === file)?.bytes;
          if (bytes) for (const refusal of executionRefusals(new TextDecoder().decode(bytes), markers)) failed.push({ session: name, ...refusal });
        }
        unexecuted += failed.length;
        const logBytes = log === null ? undefined : outputs.find((output) => output.name === log)?.bytes;
        built.push({
          entry: { item: row.item, verdict, ...(row.report_check ? { report_check: row.report_check } : {}), ...(dropped ? { runner_verdict: row.dynamic_terminal, pass_review: dropped } : {}), log, sessions, ...(Object.keys(sessions).length ? { syntax_rejected: rejected, ...(markers?.length ? { execution_refused: failed } : {}) } : {}) },
          reach: { item: row.item, reached: Boolean(row.evidence?.log) || Object.keys(row.evidence?.sessions ?? {}).length > 0, log: logBytes ? new TextDecoder().decode(logBytes) : null },
        });
      }
      const titleOf = (item: string) => titles.get(job.plan_run)?.get(item);
      const stopped = unexecutedRows(job.items, built.map(({ reach }) => reach), titleOf);
      const abort = workbookAbort(stopped, titleOf);
      if (abort) aborted++;
      for (const { entry } of built) {
        const found = stopped.get(String(entry.item));
        if (found) { unreached++; const { item, verdict: _hub, ...rest } = entry; rows.push({ item, verdict: 'not_run', not_executed: { reason: found.reason, next_action: found.next_action, aborted_by: found.by }, ...rest }); }
        else rows.push(entry);
        const verdict = String(rows.at(-1)!.verdict);
        verdicts[verdict] = (verdicts[verdict] ?? 0) + 1;
      }
      index.push({ outcome: job.outcome, missing_facts: job.missing_facts ?? [], ...(job.member_missing_facts ? { member_missing_facts: job.member_missing_facts } : {}), next_action: job.next_action ?? null, job: job.job, plan_run: job.plan_run, workbook_sha256: job.sha256, ended: job.ended, device_return: deviceReturn, ...(abort ? { aborted: abort } : {}), rows });
    }
    outputs.push({ name: 'index.json', bytes: json({ schema: 'device-returns@1', format: RETURNS_FORMAT, run: args.run, jobs: index, withheld, pass_review: passReview }) });
    for (const { name } of outputs) await mkdir(join(args.out, name, '..'), { recursive: true, mode: 0o700 });
    for (const { name, bytes } of outputs) await writeFile(join(args.out, name), bytes, { flag: 'wx', mode: 0o600 });
    const outcomes: Record<string, number> = {};
    for (const job of jobs) outcomes[job.outcome] = (outcomes[job.outcome] ?? 0) + 1;
    const unsent = jobs.filter(job => job.outcome === 'not_dispatched');
    const missing = unsent.flatMap(job => job.missing_facts ?? []);
    const ran = ranJob(index);
    const next = afterRound({ unsent: unsent.length, ended: jobs.every((job) => job.ended === 'done'), rows: (ran?.rows ?? []) as Array<Record<string, unknown>> });
    return { outcomes, missing_facts: missing, ...(next ? { message: next } : {}), run: args.run, out: resolve(args.out), jobs: jobs.length, ended: jobs.map((job) => job.ended ?? 'running'), verdicts, files: outputs.length, withheld, syntax_rejected: refused, execution_refused: unexecuted, ...(unreached ? { not_executed: unreached } : {}), ...(aborted ? { aborted } : {}), pass_review: passReview };
}

export async function main(argv: string[], readToken: () => Promise<string> = readTokenFromStdin, timing: Timing = REAL_TIME, retry?: Omit<RetryControl, 'timing'>): Promise<number> {
  try {
    const args = parseCliOptions(argv, OPTIONS, 'download-returns.ts --hub <MCP地址> --run <运行编号> --out <新的空目录> [--wait <秒数>]') as Record<string, string>;
    if (!RUN_ID.test(args.run)) failCall('invalid_parameters', '--run 不是声明格式的运行编号', '使用本次上机验证的编号后重试');
    const wait = args.wait === undefined ? 0 : Number(args.wait);
    if (args.wait !== undefined && !(/^[1-9][0-9]{0,4}$/.test(args.wait) && wait <= WAIT_MAX_SECONDS)) failCall('invalid_parameters', '--wait 不在允许范围内', `填写 1 到 ${WAIT_MAX_SECONDS} 的整数秒数后重试`);
    const origin = parseHubOrigin(args.hub);
    await assertEmptyOutput(args.out);
    const bearer = await requireBearerToken(readToken);
    process.stdout.write(JSON.stringify(await downloadReturns({ origin, bearer, run: args.run, out: args.out, wait }, timing, retry)) + '\n');
    return 0;
  } catch (error) { process.stderr.write(formatClientCallError(error) + '\n'); return 1; }
}
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) process.exitCode = await main(process.argv.slice(2));
