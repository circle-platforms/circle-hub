// Decision 105 (W03, D06): an accepted run whose pack declares a hub_template effect row is dispatched by the Hub, and
// the jobs bound to the run are reported to the runner, so repeating the same submission reads their progress.
import { labelOf } from '../../contracts/generated/vocabulary.ts';
import type { RecordsKit } from '../records/api.ts';
import type { DispatchService, JobStatus } from './service.ts';
import { readRunJobs, type RunJob } from './read-runs.ts';

export interface DispatchNote { job?: string; executor?: string; result?: string; text: string }
/** How long an accepted submission waits for the job to be reserved before it answers that the release check still runs. */
export const RESERVE_WAIT_MS = 60_000;
/** The answer's limits (submit_result output schema): at most 16 notes, each at most 800 characters. */
export const MAX_NOTES = 16, MAX_NOTE_TEXT = 800;
const clip = (text: string) => text.length <= MAX_NOTE_TEXT ? text : `${text.slice(0, MAX_NOTE_TEXT - 1)}…`;
/** The newest notes within the limit, after one line that counts the older jobs left out. */
function capped(notes: DispatchNote[]): DispatchNote[] {
  if (notes.length <= MAX_NOTES) return notes;
  const kept = notes.slice(-(MAX_NOTES - 1));
  return [{ text: `这个运行另有 ${notes.length - kept.length} 个更早的作业，这里只列最近 ${kept.length} 个` }, ...kept];
}
// CES reads a running task's status by its id and never resubmits it; here the progress read is the same submission.
const PROGRESS = '稍后逐字原样重交派发时的那次提交读进展';

async function activeAdmin(records: Pick<RecordsKit, 'principals'>) {
  return (await records.principals.list()).find((p) => p.role === 'admin' && !p.disabled);
}

export async function acceptedDispatch(records: Pick<RecordsKit, 'store' | 'principals'>, service: DispatchService, run: string, ready: boolean, wait = RESERVE_WAIT_MS): Promise<DispatchNote[]> {
  const admin = await activeAdmin(records);
  if (!admin) return ready ? [{ text: 'Hub 没有在职管理员负责作业未知结果的处置，没有自动派发；等管理员开通账号' }] : [];
  const jobs = await readRunJobs(records, service, admin, run, { unbound: true });
  // A job refused at the effect boundary before any remote call sent nothing and used nothing of the run's dispatch: once
  // the cause is fixed (a lease covering the target, for example), a repeat of the ready submission tries again, as CES
  // resubmits a workbook its gateway refused. A job that reached the target, its precheck included, is only read.
  const retry = ready && jobs.length > 0 && jobs.every((job) => job.ended === 'done' && job.boundary_refused && job.status.outcome === 'not_dispatched');
  if (jobs.length && !retry) return capped(jobs.map((job) => runnerNote(job, admin.id)));
  if (!ready) return [];
  const state: { reserved?: { job: string; executor: string } } = {};
  let wake: () => void = () => {};
  const woken = new Promise<void>((resolve) => { wake = resolve; });
  // The job itself keeps running after this answer; its journal and the scheduled reconciliation carry it to its end.
  const work = service.dispatchAccepted(run, (job, executor) => { state.reserved = { job, executor }; wake(); })
    .then((result) => { wake(); return result; }, (error: unknown) => { wake(); return { started: false, reason: error instanceof Error ? error.message : '派发前核对失败' } as Awaited<ReturnType<DispatchService['dispatchAccepted']>>; });
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([woken, new Promise<void>((resolve) => { timer = setTimeout(resolve, wait); })]);
  clearTimeout(timer);
  if (state.reserved) { const { job, executor } = state.reserved; return [{ job, executor, text: clip(`Hub 已按任务包的效果行派发作业 ${job}（执行器 ${executor}）；${PROGRESS}，作业结束后同样的答复带结果引用`) }]; }
  const settled = await Promise.race([work, Promise.resolve(null)]);
  if (settled === null) return [{ text: `Hub 正在做派发前核对；${PROGRESS}` }];
  // A dispatch that ended before any reservation was refused at the effect boundary (for example without a lease covering
  // the executor's whole target): nothing was sent, so the answer says why instead of reporting a dispatch.
  if (settled.started && settled.status) {
    const { status } = settled;
    const job = (await readRunJobs(records, service, admin, run, { unbound: true })).find((row) => row.job === status.job);
    const why = [status.reason ?? status.missing_fact ?? '派发前核对没有通过', ...details(status)].join('；');
    return [{ job: status.job, ...(settled.executor ? { executor: settled.executor } : {}), text: clip(`Hub 没有派发：${why}；下一步：${job ? nextStep(job, admin.id) : NO_MORE}`) }];
  }
  return [{ ...(settled.executor ? { executor: settled.executor } : {}), text: clip(`Hub 没有派发：${settled.reason ?? '派发前核对没有通过'}`) }];
}

/** The run's jobs that have not ended, with their notes, or null: submit_result keeps a different submission from them. */
export async function runInFlight(records: Pick<RecordsKit, 'store' | 'principals'>, service: DispatchService, run: string): Promise<{ jobs: string[]; notes: DispatchNote[] } | null> {
  const admin = await activeAdmin(records);
  if (!admin) return null;
  const running = (await readRunJobs(records, service, admin, run)).filter((job) => job.ended === null);
  return running.length ? { jobs: running.map((job) => job.job), notes: capped(running.map((job) => runnerNote(job, admin.id))) } : null;
}

const NO_MORE = '这个核验运行不会再派发：能在计划、工作簿或预订上改的，改好后开新的核验运行；其余等管理员处理';

/** What the runner can do next in the job's state. The administrator's next action (a CLI command) is never forwarded. */
function nextStep(job: Pick<RunJob, 'status' | 'ended' | 'boundary_refused'>, admin: string): string {
  const { status } = job;
  if (job.ended === null) return `作业还在进行；${PROGRESS}`;
  if (status.decided_by) return '管理员已处置这个作业；要再派发请开新的核验运行';
  if (job.ended === 'unknown' || status.frozen) return `结果未知，等管理员 ${admin} 对账（Hub 已记下）；对账后原样重交读进展`;
  if (status.report_pending) return `目标报告还没取全，Hub 会自动补读；${PROGRESS}`;
  if (status.outcome === 'not_dispatched') return job.boundary_refused ? '按原因补齐（例如预订整个自动化测试环境）后原样重交，Hub 会再试一次' : NO_MORE;
  if (status.missing_fact) return '部分条目没有判定，缺的事实写在结果引用对应的行里；要管理员补的 Hub 已记下';
  return '读结果引用看逐条结论';
}

/** A failed bed check is reported as it is, the way CES reports its environment check before a run. */
function details(status: JobStatus): string[] {
  const parts = (status.failed_checks ?? []).map((check) => `未通过的核对 ${[check.step, check.seat, check.check].filter(Boolean).join(' ')}：${check.missing_fact}`);
  if (status.failed_conditions?.length) parts.push(`未满足的条件：${status.failed_conditions.map((c) => `${c.pointer} ${c.operator}`).join('、')}`);
  return parts;
}

/** The runner's note on one job of the run. */
export function runnerNote(job: Pick<RunJob, 'job' | 'status' | 'ended' | 'boundary_refused'>, admin: string): DispatchNote {
  const { status } = job;
  const state = job.ended === 'done' ? '已结束' : job.ended === 'unknown' ? '结果未知' : '进行中';
  const parts = [`作业 ${job.job}：${state}（阶段 ${status.phase}）`, `${labelOf('effect_outcome', status.outcome)}`];
  // Before anything is sent the reference holds the pre-dispatch device checks, never results of the cases (decision 116).
  if (status.result) parts.push(status.outcome === 'not_dispatched'
    ? `派发前核对的结论 ${status.result}（逐台设备的版本和接口核对，不是用例在设备上的结果：用例还没有发到设备）`
    : `结果引用 ${status.result}（每个派发条目一行，读它看逐条结论；没有通过的条目在 evidence 里列出目标报告的日志和各设备会话，读它们找原因）`);
  if (status.reason) parts.push(`原因：${status.reason}`);
  parts.push(...details(status), `下一步：${nextStep(job, admin)}`);
  return { job: job.job, ...(status.result ? { result: status.result } : {}), text: clip(parts.join('；')) };
}
