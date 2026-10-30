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
  if (jobs.length) return jobs.map(noteOf);
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
  return [{ ...(settled.executor ? { executor: settled.executor } : {}), text: settled.started ? 'Hub 已派发作业' : `Hub 没有派发：${settled.reason}` }];
}

function noteOf(job: RunJob): DispatchNote {
  const { status } = job;
  const parts = [`作业 ${job.job}：阶段 ${status.phase}`, `${labelOf('effect_outcome', status.outcome)}`];
  if (status.result) parts.push(`结果引用 ${status.result}（每个派发条目一行，读它看逐条结论）`);
  else if (status.phase !== 'complete') parts.push('作业还在进行，稍后对同一提交再调用 submit_result');
  if (status.next_action) parts.push(`下一步：${status.next_action}`);
  return { job: job.job, ...(status.result ? { result: status.result } : {}), text: parts.join('；').slice(0, 800) };
}
