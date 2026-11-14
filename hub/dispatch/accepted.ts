import { isAdmin } from '../records/api.ts';
// Decision 105 (W03, D06): an accepted run whose pack declares a hub_template effect row is dispatched by the Hub, and
// the jobs bound to the run are reported to the runner, so repeating the same submission reads their progress.
// Issue 142 (decision 155): what went wrong comes back in the answer of the call that triggered the dispatch, in three
// kinds. Not sent: the reason, and a repeat tries again. Rejected by the target: the stage, and a repeat tries again
// after the fix. Sent without an answer: the request id, and no repeat sends again, since the target may have run it; the
// Hub asks the target by that id and only what stays unresolved goes to a named administrator.
import { labelOf, type CallErrorCategory } from '../../contracts/generated/vocabulary.ts';
import { callErrorCategory, formatCallError } from '../../contracts/generated/protocol.ts';
import type { Principal, RecordsKit } from '../records/api.ts';
import type { DispatchService, JobStatus } from './service.ts';
import { readRunJobs, type RunJob } from './read-runs.ts';
import { toolLocalMinute } from '../tool-time.ts';
import { reportMissingFacts, releaseMissingFacts, statusDiagnostics, type DispatchDiagnostics } from './reasons.ts';
export type { DispatchMissingFact, DispatchDiagnostics } from './reasons.ts';

export interface DispatchNote extends Partial<DispatchDiagnostics> { run?: string; job?: string; executor?: string; result?: string; text: string }
/** How long an accepted submission waits for the job to be reserved before it answers that the release check still runs. */
export const RESERVE_WAIT_MS = 60_000;
/** The answer's limits (submit_result output schema): at most 16 notes, each at most 800 characters. */
export const MAX_NOTES = 16, MAX_NOTE_TEXT = 800;
const clip = (text: string) => text.length <= MAX_NOTE_TEXT ? text : `${text.slice(0, MAX_NOTE_TEXT - 1)}…`;
/** The newest notes within the limit, after one line that counts the older jobs left out. */
function capped(notes: DispatchNote[], run: string): DispatchNote[] {
  if (notes.length <= MAX_NOTES) return notes.map(note=>({...note,run:note.run??run}));
  const kept = notes.slice(-(MAX_NOTES - 1));
  return [{ run, text: `这个运行另有 ${notes.length - kept.length} 个更早的作业，这里只列最近 ${kept.length} 个` }, ...kept.map(note=>({...note,run:note.run??run}))];
}
// Progress reread: the model repeats the same script-merge submission (Boss 20:53; no「任务包」「提交」).
const REREAD = '下一步由模型稍后把这次脚本合并原样再交一次，读取进展';

async function activeAdmin(records: Pick<RecordsKit, 'principals'>) {
  return (await records.principals.list()).find((p) => isAdmin(p) && !p.disabled);
}


/** The responsibility administrator is not the caller. Absence of caller identity never grants administrative diagnostics. */
async function callerAdmin(records: Pick<RecordsKit, 'principals'>, service: DispatchService, run: string, caller?: Principal): Promise<boolean> {
  if (!caller) return false;
  const current = await records.principals.get(caller.id);
  if (!current || current.disabled || !await service.options.runs.getRun(current, run)) throw new Error('调用者或运行不可用');
  return isAdmin(current);
}
async function jobNote(service: DispatchService, job: RunJob, admin: string, retried: boolean, administrative: boolean): Promise<DispatchNote> {
  const note = runnerNote(job, admin, retried, administrative);
  const report = await reportMissingFacts(service.options.records, job, administrative);
  const facts = [...note.missing_facts ?? [], ...report.missing_facts].slice(0, 16);
  return { ...note, run:job.verification_run, ...(administrative&&job.executor?{executor:job.executor}:{}), ...(report.no_verdict !== undefined ? { no_verdict: report.no_verdict } : {}), missing_facts: facts, ...(report.no_verdict ? {text:clip(note.text+'；'+report.missing_facts.map(fact=>fact.fact).join('；'))} : {}) };
}

type Settled = Awaited<ReturnType<DispatchService['dispatchAccepted']>>;
/** One dispatch attempt of a run in this process. A repeat of the submission reads it (REREAD) instead of starting another,
 * so a refusal that comes after the answer, when the release checks take longer than the wait, reaches the next repeat. */
interface Attempt { woken: Promise<void>; reserved?: { job: string; executor: string }; settled?: Settled; uncertain?: boolean }
const attempts = new WeakMap<DispatchService, Map<string, Attempt>>();
function attemptsOf(service: DispatchService): Map<string, Attempt> {
  let open = attempts.get(service);
  if (!open) attempts.set(service, open = new Map());
  return open;
}
function begin(service: DispatchService, run: string): Attempt {
  let wake: () => void = () => {};
  const attempt: Attempt = { woken: new Promise<void>((resolve) => { wake = resolve; }) };
  // The job itself keeps running after this answer; its journal and the scheduled reconciliation carry it to its end.
  void service.dispatchAccepted(run, (job, executor) => { attempt.reserved = { job, executor }; wake(); })
    .then((result) => { attempt.settled = result; wake(); }, (_error: unknown) => { attempt.uncertain = true; attempt.settled = { started: false }; wake(); });
  return attempt;
}

export async function acceptedDispatch(records: Pick<RecordsKit, 'store' | 'principals'>, service: DispatchService, run: string, ready: boolean, wait = RESERVE_WAIT_MS, caller?: Principal): Promise<DispatchNote[]> {
  const administrative = await callerAdmin(records, service, run, caller);
  const admin = await activeAdmin(records);
  if (!admin) return ready ? [{ run, text: 'Hub 没有在职管理员负责作业未知结果的处置，没有自动上机验证；等管理员开通账号' }] : [];
  const open = attemptsOf(service);
  const jobs = await readRunJobs(records, service, admin, run, { unbound: true });
  // Every job of the run ended without an effect that could repeat (see `retriable`): a repeat of the ready submission
  // tries again, as the reference compile skill resubmits a workbook its gateway refused. Any other job is only read.
  const retry = ready && jobs.length > 0 && jobs.every(retriable);
  if (jobs.length && !retry) { open.delete(run); return capped(await Promise.all(jobs.map(job => jobNote(service, job, admin.id, false, administrative))),run); }
  if (!ready) return [];
  // What the earlier jobs came to is told beside the new attempt: the runner learns why the last one ended before it reads
  // that the Hub tried again. Keep our in-process Attempt map so a late refusal after the wait still reaches the next repeat.
  const earlier = await Promise.all(jobs.map(job => jobNote(service, job, admin.id, true, administrative)));
  const answer = (notes: DispatchNote[]) => capped([...earlier, ...notes],run);
  let attempt = open.get(run);
  if (!attempt) { attempt = begin(service, run); open.set(run, attempt); }
  if (!attempt.settled && !attempt.reserved) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([attempt.woken, new Promise<void>((resolve) => { timer = setTimeout(resolve, wait); })]);
    clearTimeout(timer);
  }
  if (attempt.reserved) { open.delete(run); const { job, executor } = attempt.reserved; return answer([{ job, ...(administrative ? { executor } : {}), text: clip(`Hub ${earlier.length ? '已再次' : '已'}按工作流的规定自动开始上机验证；${REREAD}；上机验证结束后，同样的答复里带设备输出的引用`) }]); }
  const settled = attempt.settled;
  if (!settled) return answer([{ text: `Hub 正在做上机验证前的核对；${REREAD}` }]);
  if (attempt.uncertain || settled.outcome==='unknown') { const next=administrative?`circle-hub run show ${run} --json`:'不要重新发送或另开运行；联系管理员只读核对原作业';return answer([{outcome:'unknown',missing_facts:[{fact:'本次调用未取得可核对的派发记录',next_action:next}],next_action:next,text:clip(`上机验证状态尚未确认；不要重新发送或另开运行；下一步：${next}`)}]); }
  // A settled attempt is answered once; a repeat after that tries again, as before (a cause the runner fixes, as a booking).
  open.delete(run);
  // A dispatch that ended before any reservation was refused at the effect boundary (for example without a lease covering
  // the executor's whole target): nothing was sent, so the answer says why instead of reporting a dispatch.
  if (settled.started && settled.status) {
    const { status } = settled;
    const job = (await readRunJobs(records, service, admin, run, { unbound: true })).find((row) => row.job === status.job);
    if (job) return answer([await jobNote(service, job, admin.id, false, administrative)]);
    const diagnostics = statusDiagnostics({ job: status.job, status, ended: null, boundary_refused: false }, administrative);
    return answer([{ job: status.job, ...diagnostics, text: clip(`上机验证核对尚未完成；${diagnostics.next_action}`) }]);
  }
  const missing = !administrative ? settled.member_missing_facts ?? (settled.checks ? releaseMissingFacts(settled.checks) : []) : [];
  const facts = missing.length ? missing : [{fact:settled.error_code==='SOURCE_NOT_PERMITTED'?'运行发起账户没有可采用的测试环境使用授权；请核对有效分配及账户状态':settled.error_code==='SOURCE_UNAVAILABLE'?'本次环境权限尚未核对，缺少可读取的核对事实；请恢复权限检查接线或读取能力':administrative ? clip(settled.reason ?? '上机验证前核对没有通过') : '上机前的放行条件尚未满足，未取得可采用的派发结果',next_action:'核对本次预订和核验结果；需要管理员处理的，联系管理员核对'}];
  const category=invocationCategory(settled);
  const fact=facts.map(row=>row.fact).join('；'),next=facts.map(row=>row.next_action).join('；');
  return answer([{ ...(administrative && settled.executor ? { executor: settled.executor } : {}), outcome:'not_dispatched', ...(settled.error_code?{error_code:settled.error_code}:{}), missing_facts:facts,next_action:next,text:clip(category?formatCallError(category,fact,next):'上机验证没有发出：'+fact) }]);
}

/** The run's jobs that have not ended, with their notes, or null: submit_result keeps a different submission from them. */
export async function runInFlight(records: Pick<RecordsKit, 'store' | 'principals'>, service: DispatchService, run: string, caller?: Principal): Promise<{ jobs: string[]; notes: DispatchNote[] } | null> {
  const admin = await activeAdmin(records);
  if (!admin) return null;
  const administrative = await callerAdmin(records, service, run, caller);
  const running = (await readRunJobs(records, service, admin, run)).filter((job) => job.ended === null);
  return running.length ? { jobs: running.map((job) => job.job), notes: capped(await Promise.all(running.map(job => jobNote(service, job, admin.id, false, administrative))),run) } : null;
}

const NO_MORE = '这次上机验证不会再做上机验证：能在自动化用例、自动化用例 Excel 或预订上改的，改好后重新开始上机验证；其余等管理员处理';
const RETRY = '原样重交，Hub 会再试一次';

/**
 * A job after which a repeat of the same ready submission dispatches again (issue 142): it ended, no administrator has
 * disposed of it, and what it came to cannot have run on the target. Nothing was sent (refused at the effect boundary
 * before any remote call, or ended before the submit was called: no lease, an unreachable target, a failed precheck),
 * the target refused it with a certified stage, or it is proven not to have run. The dispatch itself still checks every
 * premise and the lineage's earlier attempts before it sends. A refusal at the final boundary after the target was
 * reached is not among them: its cause is in the run, and only a new verification run changes it.
 */
function retriable(job: Pick<RunJob, 'status' | 'ended' | 'boundary_refused'>): boolean {
  const { status } = job;
  if (job.ended !== 'done' || status.frozen || status.decided_by) return false;
  if (status.outcome === 'not_dispatched') return job.boundary_refused || status.not_sent === true;
  return status.outcome === 'target_rejected' || status.outcome === 'proven_not_executed';
}

/** What the runner can do next in the job's state. The administrator's next action (a CLI command) is never forwarded. */
function nextStep(job: Pick<RunJob, 'status' | 'ended' | 'boundary_refused'>, admin: string): string {
  const { status } = job;
  if (job.ended === null) return `上机验证还在进行；${REREAD}`;
  if (status.decided_by) return '管理员已处置这个作业；要再上机请重新开始上机验证';
  if (job.ended === 'unknown' || status.frozen) {
    // The Hub asks the target by the request id where the executor declares a query; what stays unresolved is a request to
    // the named administrator, and only then does the note say it was handed over.
    const due = status.requests?.find((request) => request.deadline !== null)?.deadline;
    const dueText = due ? `（期限 ${toolLocalMinute(due)}）` : '';
    const handling = status.requests?.length ? `已交给管理员处置${dueText}` : `Hub 会按请求号向目标查询，查不清再交给管理员处置`;
    // Unknown means no information yet (not “someone concluded and it is unchecked”).
    return `上机验证结果未知：不要重交，也不要另开运行重发，目标可能已经执行过一次；${handling}；之后原样重交读进展`;
  }
  if (status.report_pending) return `目标报告还没取全，Hub 会自动补读；${REREAD}`;
  if (status.outcome === 'not_dispatched') return job.boundary_refused ? `按原因补齐（例如预订整个自动化测试环境）后${RETRY}` : status.not_sent ? `什么都没有发到目标；原因消除后${RETRY}` : NO_MORE;
  if (status.outcome === 'target_rejected') return `目标没有接收，也没有执行；按拒绝的原因修正后${RETRY}`;
  if (status.outcome === 'proven_not_executed') return `已证明目标没有执行；${RETRY}`;
  if (status.missing_fact) return '部分条目没有判定，缺的事实写在结果引用对应的行里；要管理员补的 Hub 已记下';
  return status.device_return ? '读设备返回，读完再判断' : '读结果引用看逐条结论';
}

/** A failed bed check is reported as it is, the way the reference compile skill reports its environment check before a run. */
function details(status: JobStatus): string[] {
  const parts = (status.failed_checks ?? []).map((check) => `未通过的核对 ${[check.step, check.seat, check.check].filter(Boolean).join(' ')}：${check.missing_fact}`);
  if (status.failed_conditions?.length) parts.push(`未满足的条件：${status.failed_conditions.map((c) => `${c.pointer} ${c.operator}`).join('、')}`);
  return parts;
}

/** LEASE_UNAVAILABLE needs caller-verified evidence; absent evidence never means occupied. */
function invocationCategory(status: Pick<JobStatus,'error_code'|'call_error_category'|'booking'|'not_sent'|'failed_conditions'>): CallErrorCategory | null {
  if (status.call_error_category===null) return null;
  if (!status.error_code&&status.call_error_category) return status.call_error_category;
  const category=callErrorCategory(status.error_code??'');
  if (category) return category;
  if (status.error_code==='LEASE_UNAVAILABLE') {
    if (status.call_error_category) return status.call_error_category;
    if (status.booking?.coverage_complete===false) return 'not_found';
  }
  if (!status.error_code&&status.not_sent&&status.failed_conditions?.length) return callErrorCategory('EFFECT_RELEASE_UNMET');
  return null;
}

/** The runner's note on one job of the run; `retried` when the answer that carries it dispatches again after it. */
export function runnerNote(job: Pick<RunJob, 'job' | 'status' | 'ended' | 'boundary_refused'>, admin: string, retried = false, administrative = false): DispatchNote {
  const { status } = job;
  const diagnostics = statusDiagnostics(job, administrative);
  const state = job.ended === 'done' ? '已结束' : job.ended === 'unknown' ? '上机验证结果未知' : '进行中';
  const parts = [administrative ? `作业 ${job.job}：${state}（阶段 ${status.phase}）` : `上机验证${state}`, `${labelOf('effect_outcome', status.outcome)}`];
  if (status.outcome === 'target_rejected' && status.rejection_stage) parts.push(`目标在“${status.rejection_stage}”阶段拒绝`);
  // The id the Hub asks the target about: told only while the answer is missing, where it is what an administrator needs.
  if (administrative && (job.ended === 'unknown' || status.frozen) && status.request_id) parts.push(`请求号 ${status.request_id}`);
  // Before anything is sent the reference holds the pre-dispatch device checks, never results of the cases (decision 116).
  if (status.result) parts.push(status.outcome === 'not_dispatched'
    ? `上机验证前核对的结论 ${status.result}（逐台设备的版本和接口核对，不是用例在设备上的结果：用例还没有发到设备）`
    : status.device_return ? `设备返回 ${status.device_return}（逐条结论和没有通过的条目的日志、各设备会话原文，一字未改）；结果引用 ${status.result}`
    : `结果引用 ${status.result}（每个派发条目一行，读它看逐条结论；没有通过的条目在 evidence 里列出目标报告的日志和各设备会话，读它们找原因）`);
  if (administrative && status.reason) parts.push(`原因：${status.reason}`);
  if (administrative) parts.push(...details(status));
  else if (diagnostics.missing_facts.length) parts.push(diagnostics.missing_facts.map(fact => fact.fact).join('；'));
  const next = administrative ? diagnostics.next_action : job.ended==='unknown'||status.frozen||status.outcome==='unknown' ? nextStep(job, '') : diagnostics.missing_facts.length && (status.member_missing_facts?.length || status.failed_conditions?.length || status.failed_checks?.length) ? diagnostics.missing_facts.map(fact=>fact.next_action).join('；') : nextStep(job, '');
  const action = retried ? '这次重交 Hub 已再试，见后面的条目'+(!administrative && (status.member_missing_facts?.length || status.failed_conditions?.length || status.failed_checks?.length) ? `；${next}` : '') : next;
  const category = job.ended==='done'&&status.outcome==='not_dispatched'&&!status.frozen ? invocationCategory(status) : null;
  return { job: job.job, ...(status.result ? { result: status.result } : {}), ...diagnostics, text: clip(category?formatCallError(category,parts.join('；'),action):[...parts,`下一步：${action}`].join('；')) };
}
