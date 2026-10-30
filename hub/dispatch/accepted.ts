// Decision 105 (model W03, D06): an accepted run whose pack declares a hub_template effect row is dispatched by the Hub, and
// the jobs bound to the run are reported to the runner, so repeating the same submission reads their progress.
import { labelOf } from '../../contracts/generated/vocabulary.ts';
import type { RecordsKit } from '../records/api.ts';
import type { DispatchService } from './service.ts';
import { readRunJobs, type RunJob } from './read-runs.ts';

export interface DispatchNote { job?: string; executor?: string; result?: string; text: string }
/** How long an accepted submission waits for the job to be reserved before it answers that the release check still runs. */
export const RESERVE_WAIT_MS = 60_000;

export async function acceptedDispatch(records: Pick<RecordsKit, 'store' | 'principals'>, service: DispatchService, run: string, ready: boolean, wait = RESERVE_WAIT_MS): Promise<DispatchNote[]> {
  const admin = (await records.principals.list()).find((p) => p.role === 'admin' && !p.disabled);
  if (!admin) return ready ? [{ text: 'Hub 没有在职管理员负责作业未知结果的处置，没有自动派发；请管理员开通账号，或由管理员用 job dispatch 派发' }] : [];
  const jobs = await readRunJobs(records, service, admin, run);
  // A job refused at the effect boundary ended before any reservation or remote call and used nothing of the run's dispatch:
  // once the cause is fixed (a lease covering the target, for example), a repeat of the ready submission tries again, as CES
  // resubmits a workbook its gateway refused. A job that reached the target, its precheck included, is only read.
  const retry = ready && jobs.length > 0 && jobs.every((job) => job.ended === 'done' && job.boundary_refused && job.status.outcome === 'not_dispatched');
  if (jobs.length && !retry) return jobs.map(noteOf);
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
  if (state.reserved) { const { job, executor } = state.reserved; return [{ job, executor, text: `Hub 已按任务包的效果行派发作业 ${job}（执行器 ${executor}）；作业结束后对同一提交再调用 submit_result 读进展和结果引用` }]; }
  const settled = await Promise.race([work, Promise.resolve(null)]);
  if (settled === null) return [{ text: 'Hub 正在做派发前核对；稍后对同一提交再调用 submit_result 读进展' }];
  // A dispatch that ended before any reservation was refused at the effect boundary (for example without a lease covering
  // the executor's whole target): nothing was sent, so the answer says why instead of reporting a dispatch.
  if (settled.started && settled.status) {
    const { status } = settled; const why = status.reason ?? status.next_action ?? '派发前核对没有通过';
    return [{ job: status.job, ...(settled.executor ? { executor: settled.executor } : {}), text: `Hub 没有派发：${why}${status.reason && status.next_action ? `；下一步：${status.next_action}` : ''}`.slice(0, 800) }];
  }
  return [{ ...(settled.executor ? { executor: settled.executor } : {}), text: `Hub 没有派发：${settled.reason ?? '派发前核对没有通过'}` }];
}

function noteOf(job: RunJob): DispatchNote {
  const { status } = job;
  const state = job.ended === 'done' ? '已结束' : job.ended === 'unknown' ? '结果未知，等管理员对账' : '进行中';
  const parts = [`作业 ${job.job}：${state}（阶段 ${status.phase}）`, `${labelOf('effect_outcome', status.outcome)}`];
  if (status.result) parts.push(`结果引用 ${status.result}（每个派发条目一行，读它看逐条结论；没有通过的条目在 evidence 里列出目标报告的日志和各设备会话，读它们找原因）`);
  else if (job.ended === null) parts.push('作业还在进行，稍后对同一提交再调用 submit_result');
  if (status.reason) parts.push(`原因：${status.reason}`);
  // A failed bed check is reported as it is, the way CES reports its environment check before a run.
  for (const check of status.failed_checks ?? []) parts.push(`未通过的核对 ${[check.step, check.seat, check.check].filter(Boolean).join(' ')}：${check.missing_fact}`);
  if (status.failed_conditions?.length) parts.push(`未满足的条件：${status.failed_conditions.map((c) => `${c.pointer} ${c.operator}`).join('、')}`);
  if (status.next_action) parts.push(`下一步：${status.next_action}`);
  return { job: job.job, ...(status.result ? { result: status.result } : {}), text: parts.join('；').slice(0, 800) };
}
