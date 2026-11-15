import { isAdmin } from '../records/api.ts';
// Decision 105 (W03, D06): an accepted run whose pack declares a hub_template effect row is dispatched by the Hub, and
// the jobs bound to the run are reported to the runner, so repeating the same submission reads their progress.
// Issue 142 (decision 155): what went wrong comes back in the answer of the call that triggered the dispatch, in three
// kinds. Not sent: the reason, and a repeat tries again. Rejected by the target: the stage, and a repeat tries again
// after the fix. Sent without an answer: the request id, and no repeat sends again, since the target may have run it; the
// Hub asks the target by that id and only what stays unresolved goes to a named administrator.
import { labelOf, type CallErrorCategory } from '../../contracts/generated/vocabulary.ts';
import { PROTOCOL_CODES, callErrorCategory, formatCallError } from '../../contracts/generated/protocol.ts';
import type { DispatchNoteFacts, DispatchRunFacts, DispatchAttemptFacts } from '../../contracts/api.ts';
import type { Principal, RecordsKit } from '../records/api.ts';
import type { DispatchService, JobStatus } from './service.ts';
import { readRunJobs, type RunJob } from './read-runs.ts';
import { reportMissingFacts, releaseMissingFacts, statusDiagnostics, attemptScopeLabel, type DispatchDiagnostics } from './reasons.ts';
export type { DispatchMissingFact, DispatchDiagnostics } from './reasons.ts';

export interface DispatchNote extends DispatchNoteFacts { run?: string; job?: string; executor?: string; text: string }
/** How long an accepted submission waits for the job to be reserved before it answers that the release check still runs. */
export const RESERVE_WAIT_MS = 60_000;
/** The answer's limits (submit_result output schema): at most 16 notes, each at most 800 characters. */
export const MAX_NOTES = 16, MAX_NOTE_TEXT = 800;
const clip = (text: string) => text.length <= MAX_NOTE_TEXT ? text : `${text.slice(0, MAX_NOTE_TEXT - 1)}…`;
/** The newest notes within the limit, after one line that counts the older jobs left out. */
function capped(notes: DispatchNote[], run: string): DispatchNote[] {
  if (notes.length <= MAX_NOTES) return notes.map(note=>({...note,run:note.run??run}));
  const kept = notes.slice(-(MAX_NOTES - 1));
  return [{ run, run_facts: { scope: { run } }, text: `这个运行另有 ${notes.length - kept.length} 个更早的作业，这里只列最近 ${kept.length} 个` }, ...kept.map(note=>({...note,run:note.run??run}))];
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
  const facts = [...note.job_facts?.missing_facts ?? [], ...report.missing_facts].slice(0, 16);
  return { ...note, run: job.verification_run, ...(administrative && job.executor ? { executor: job.executor } : {}),
    job_facts: { ...note.job_facts!, missing_facts: facts },
    ...(report.no_verdict ? { text: clip(note.text + '。作业历史报告中部分条目没有判定；缺失事实：' + report.missing_facts.map(fact => fact.fact).join('；')) } : {}) };
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

function workerFacts(run: string, attempt: Attempt): DispatchRunFacts {
  return { scope: { run }, worker_settled: attempt.settled !== undefined };
}

export async function acceptedDispatch(records: Pick<RecordsKit, 'store' | 'principals'>, service: DispatchService, run: string, ready: boolean, wait = RESERVE_WAIT_MS, caller?: Principal): Promise<DispatchNote[]> {
  const administrative = await callerAdmin(records, service, run, caller);
  const admin = await activeAdmin(records);
  if (!admin) return ready ? [{ run, run_facts: { scope: { run } }, text: '本次运行的自动处理缺少在职管理员负责作业未知结果的处置；请联系管理员开通账号' }] : [];
  const open = attemptsOf(service);
  const jobs = await readRunJobs(records, service, admin, run, { unbound: true });
  const retry = ready && jobs.length > 0 && jobs.every(retriable);
  if (jobs.length && !retry) {
    open.delete(run);
    return capped(await Promise.all(jobs.map(job => jobNote(service, job, admin.id, false, administrative))), run);
  }
  if (!ready) return [];
  const earlier = await Promise.all(jobs.map(job => jobNote(service, job, admin.id, true, administrative)));
  const answer = (notes: DispatchNote[]) => capped([...earlier, ...notes], run);
  let attempt = open.get(run);
  if (!attempt) { attempt = begin(service, run); open.set(run, attempt); }
  if (!attempt.settled && !attempt.reserved) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([attempt.woken, new Promise<void>(resolve => { timer = setTimeout(resolve, wait); })]);
    clearTimeout(timer);
  }
  const run_facts = workerFacts(run, attempt);
  if (attempt.reserved) {
    open.delete(run);
    const { job, executor } = attempt.reserved;
    return answer([{ run_facts, job, job_facts: { scope: { job }, reservation_recorded: true }, ...(administrative ? { executor } : {}), text: clip(`Hub ${earlier.length ? '已再次' : '已'}按工作流的规定自动开始上机验证；${REREAD}，之后同样的答复带进展或可读的结果引用`) }]);
  }
  const settled = attempt.settled;
  if (!settled) return answer([{ run_facts, text: `Hub 正在做上机验证前的核对；${REREAD}` }]);
  if (attempt.uncertain || settled.job_status_unavailable === true) {
    const next = administrative ? `circle-hub run show ${run} --json` : '不要重新发送或另开运行；联系管理员只读核对原作业';
    return answer([{ run_facts: { ...run_facts, missing_facts: [{ fact: '本次运行的派发处理未取得可核对的作业记录', next_action: next }], next_action: next }, text: clip(`本次运行的派发处理已结束，但作业事实尚未确认；下一步：${next}`) }]);
  }
  open.delete(run);
  if (settled.started && settled.status) {
    const { status } = settled;
    const job = (await readRunJobs(records, service, admin, run, { unbound: true })).find(row => row.job === status.job);
    if (job) return answer([{ ...await jobNote(service, job, admin.id, false, administrative), run_facts }]);
    const diagnostics = statusDiagnostics({ job: status.job, status, ended: null, boundary_refused: false }, administrative);
    return answer([{ run_facts, job: status.job, ...diagnostics, text: clip(`本作业核对尚未完成；${diagnostics.job_facts.next_action}`) }]);
  }
  if(settled.error_code==='SOURCE_NOT_PERMITTED'&&settled.call_error_reason==='environment_registration_incomplete') {
    const admission_error={code:settled.error_code,call_error_reason:settled.call_error_reason,object_kind:'test_environment' as const,message:settled.reason??'该测试环境还没有登记完成，尚未声明资源清单'};
    return answer([{run_facts:{...run_facts,admission_error},...(administrative&&settled.executor?{executor:settled.executor}:{}),text:admission_error.message}]);
  }
  const missing = !administrative ? settled.member_missing_facts ?? (settled.checks ? releaseMissingFacts(settled.checks) : []) : [];
  const facts = missing.length ? missing : [{ fact: settled.error_code === 'SOURCE_NOT_PERMITTED' ? '运行发起账户没有可采用的测试环境使用授权；请核对有效分配及账户状态' : settled.error_code === 'SOURCE_UNAVAILABLE' ? '本次环境权限尚未核对，缺少可读取的核对事实；请恢复权限检查接线或读取能力' : administrative ? clip(settled.reason ?? '上机验证前核对没有通过') : '本次运行的上机前核对未通过，尚未取得作业记录', next_action: '核对本次预订和核验结果；需要管理员处理的，联系管理员核对' }];
  const category = invocationCategory(settled);
  const fact = facts.map(row => row.fact).join('；'), next = facts.map(row => row.next_action).join('；');
  const admission_error = settled.error_code ? { code: settled.error_code, message: fact, fix: next } : undefined;
  return answer([{ run_facts: { ...run_facts, ...(admission_error ? { admission_error } : {}), missing_facts: facts, next_action: next }, ...(administrative && settled.executor ? { executor: settled.executor } : {}), text: clip(category ? formatCallError(category, '本次运行的准入核对：' + fact, next) : '本次运行的准入核对未通过：' + fact) }]);
}

/** The run's jobs that have not ended, with their notes, or null: submit_result keeps a different submission from them. */
export async function runInFlight(records: Pick<RecordsKit, 'store' | 'principals'>, service: DispatchService, run: string, caller?: Principal): Promise<{ jobs: string[]; notes: DispatchNote[] } | null> {
  const admin = await activeAdmin(records);
  if (!admin) return null;
  const administrative = await callerAdmin(records, service, run, caller);
  const running = (await readRunJobs(records, service, admin, run)).filter((job) => job.ended === null);
  return running.length ? { jobs: running.map((job) => job.job), notes: capped(await Promise.all(running.map(job => jobNote(service, job, admin.id, false, administrative))),run) } : null;
}

/** Whole-job retry is allowed only before any observed completed round or for the first proven harmless attempt. */
function retriable(job: Pick<RunJob, 'status' | 'ended' | 'boundary_refused'>): boolean {
  const facts = job.status.job_facts, attempt = job.status.dispatch_attempt;
  if (job.ended !== 'done' || facts.frozen || facts.decided_by || facts.rounds?.length) return false;
  if (!attempt) return facts.admission_error !== undefined;
  if (attempt.scope.operation !== 'dispatch' || attempt.scope.round !== 1) return false;
  if (attempt.phase === 'round_refused' && !job.boundary_refused) return false;
  return attempt.outcome === 'not_dispatched' && attempt.not_sent === true || attempt.outcome === 'target_rejected' || attempt.outcome === 'proven_not_executed';
}

function attemptLabel(attempt: DispatchAttemptFacts): string {
  return attemptScopeLabel(attempt.scope);
}

function attemptNext(attempt: DispatchAttemptFacts, job: Pick<RunJob, 'status' | 'ended' | 'boundary_refused'>): string {
  const scope = attemptLabel(attempt);
  if (attempt.outcome === 'unknown') return `${scope}的上机验证结果未知：不要重交，也不要另开运行重发，目标可能已经执行过一次；之后原样重交读进展，需要时联系管理员只读核对`;
  if (attempt.report_pending) return `${scope}目标报告还没取全；原样重交原提交补读报告，不要重新发送作业`;
  if (attempt.not_sent === true) return retriable(job) ? `${scope}没有发出用例数据；原因消除后原样重交，Hub 会再试一次` : `${scope}没有发出用例数据；按本作业的放行说明处理，不自行重新发送`;
  if (attempt.outcome === 'target_rejected') return `${scope}目标没有接收，也没有执行；` + (retriable(job) ? '按该次拒绝原因修正后原样重交，Hub 会再试一次' : '读取该次拒绝记录，不自行重发整个作业');
  if (attempt.outcome === 'proven_not_executed') return `${scope}已证明目标没有执行；` + (retriable(job) ? '原样重交，Hub 会再试一次' : '读取该次记录，不自行重发整个作业');
  return attempt.device_return ? `${scope}读设备返回，读完再判断` : `${scope}读结果引用看逐条结论；没有结论时不要当作通过`;
}

function invocationCategory(facts: Pick<JobStatus['job_facts'], 'error_code' | 'call_error_category' | 'booking'>): CallErrorCategory | null {
  if (facts.call_error_category === null) return null;
  if (!facts.error_code && facts.call_error_category) return facts.call_error_category;
  const category = callErrorCategory(facts.error_code ?? '');
  if (category) return category;
  if (facts.error_code === 'LEASE_UNAVAILABLE') return facts.call_error_category ?? (facts.booking?.coverage_complete === false ? 'not_found' : null);
  return null;
}

/** Every sentence names the run/job/attempt scope; scheduler authority never controls the caller projection. */
export function runnerNote(job: Pick<RunJob, 'job' | 'status' | 'ended' | 'boundary_refused'>, admin: string, retried = false, administrative = false): DispatchNote {
  const facts = job.status.job_facts;
  const diagnostics = statusDiagnostics(job, administrative), projected = diagnostics.job_facts, attempt = diagnostics.dispatch_attempt;
  const state = job.ended === 'done' ? '已结束' : job.ended === 'unknown' ? '还有未决事项' : '还在进行';
  const jobLabel = projected.operation === 'precheck' ? '本次只读预检作业' : projected.operation === 'conformance' ? `本次${labelOf('dispatch_operation', 'conformance')}作业` : projected.operation === 'dispatch' ? '本次上机验证作业' : '本作业';
  const parts = [administrative ? `作业 ${job.job}：${state}${projected.phase ? `（阶段 ${projected.phase}）` : ''}` : `${jobLabel}${state}`];
  if (projected.operation === 'precheck') parts.push(projected.readonly_verified === true ? '本作业的只读预检条件已核对通过' : '本作业的只读预检条件尚无全部通过的观察');
  if (facts.decided_by) parts.push('管理员已处置本作业；要再上机请重新开始上机验证');
  if (projected.frozen === true) parts.push('本作业保持重发保护，需按作业记录继续核对');
  if (projected.result) parts.push(projected.operation === 'precheck' ? `本作业的上机验证前核对结论 ${projected.result}（只读预检报告，不是用例在设备上的执行结果）` : `作业结果引用 ${projected.result}；读它看逐条结论，不代替各轮的执行事实`);
  if (projected.admission_error) parts.push(`本作业准入核对：${projected.admission_error.message}`);
  if (projected.missing_facts?.length) parts.push(`作业缺失事实：${projected.missing_facts.map(fact => fact.fact).join('；')}`);
  if (attempt) {
    const scope = attemptLabel(attempt);
    parts.push(`${scope}：${attempt.outcome === undefined ? '尚无可核对的结局记录' : labelOf('effect_outcome', attempt.outcome)}`);
    if (attempt.rejection_stage) parts.push(`${scope}在目标的“${attempt.rejection_stage}”阶段被拒绝`);
    if (administrative && attempt.scope.request_id) parts.push(`${scope}请求号 ${attempt.scope.request_id}`);
    if (attempt.missing_facts?.length) parts.push(`${scope}缺失事实：${attempt.missing_facts.map(fact => fact.fact).join('；')}`);
    if (attempt.result) parts.push(`${scope}结果引用 ${attempt.result}`);
    if (attempt.device_return && attempt.outcome !== 'not_dispatched' && attempt.not_sent !== true) parts.push(`${scope}设备返回 ${attempt.device_return}（原文引用不证明通过）`);
    const hasSpecificMemberAction = (job.status.dispatch_attempt?.member_missing_facts?.length ?? 0) > 0 || (job.status.dispatch_attempt?.failed_conditions?.length ?? 0) > 0 || (job.status.dispatch_attempt?.failed_checks?.length ?? 0) > 0;
    const nextAttempt = administrative ? attempt.next_action ?? diagnostics.job_facts.next_action ?? attemptNext(attempt, job) : attempt.outcome === 'unknown' ? attemptNext(attempt, job) : hasSpecificMemberAction && attempt.missing_facts?.length ? [...new Set(attempt.missing_facts.map(fact => fact.next_action))].join('；') : attemptNext(attempt, job);
    attempt.next_action = nextAttempt;
    parts.push(`${scope}下一步：${nextAttempt}`);
  }
  if (projected.awaiting_disposition === true) parts.push(facts.requests?.length ? '本作业已交给管理员处置，请按作业记录处理' : '本作业有待处置事项，请按作业记录处理');
  const next = administrative ? projected.next_action : projected.missing_facts?.map(fact => fact.next_action).join('；') || projected.next_action;
  if (next) parts.push(`作业下一步：${next}`);
  if (retried) parts.push('本次运行：这次重交 Hub 已再试，见后面的条目');
  const category = !attempt && projected.admission_error ? invocationCategory(facts) : null;
  const attemptCategory = attempt?.outcome === 'not_dispatched' ? invocationCategory(job.status.dispatch_attempt!) : null;
  const refusal = attempt && attemptCategory ? formatCallError(attemptCategory,
    `${attemptLabel(attempt)}：${labelOf('effect_outcome', attempt.outcome!)}${attempt.missing_facts?.length ? '；' + attempt.missing_facts.map(fact => fact.fact).join('；') : ''}`,
    attempt.next_action ?? attemptNext(attempt, job)) : undefined;
  return { job: job.job, ...diagnostics, text: clip(refusal ? [refusal,...parts].join('。') : category ? formatCallError(category, parts.join('。'), next ?? '') : parts.join('。')) };
}
