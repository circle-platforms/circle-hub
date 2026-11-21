// What the end of a compile run hands over, after InfoTest's delivery directory (docs/engine/07_display_contract.md §11.9 of the
// reference engine): a pass volume that was dispatched whole and passed item by item, an unsuccessful volume of the cases that
// have a plan but did not pass, a report with one section per case not delivered (what happened, how it was judged, the fix or
// the trade-off), a longer report for whoever picks those cases up, and a machine summary. Every status and count here comes
// from the jobs' verdicts as the Hub relays them (decision 160), and a failed case closes by the reference engine's rules
// (closeFailed). Model-supplied defect candidates and author conflicts carry quotations checked verbatim.
import { isRecord, failCall, localMinute, reportStatement } from './text.ts';
import { movedText, type MovedCase } from './channels.ts';
import { quoteMatches } from './quote.ts';
import { labelOf, isAttribution, isExitAction, type Attribution } from './generated/vocabulary.ts';

export const STATUS = { delivered: '交付', failed: '上机未通过', unsettled: '无结论', unrun: '没有上机' } as const;
export type Status = keyof typeof STATUS;

/** Why a reported pass is not taken as one: the device output it came with and the line in it (see failureLine). */
export interface RowAudit { where: string; line: string }
/**
 * A case of a dispatched workbook that the run never reached: `by` is the case before it, in the same workbook, whose step
 * raised an exception that ended the whole run (see unexecutedRows). It is no device verdict and no attempt of the case.
 */
export interface NotExecuted { by: { item: string; step: number | null }; reason: string; next_action: string }
export interface JobRow { report_check?: { mapped_terminal?: string; [key: string]: unknown }; reported_terminal?: string; qualifier?: { nature: string; marks: string[] }; accepted_as_fact?: boolean; missing_facts?: string[]; missing_fact?: string; next_action?: string; item: string; dynamic_terminal: string; evidence?: { log?: string; sessions?: Record<string, string> }; audit?: RowAudit; not_executed?: NotExecuted }
export interface ExportedJob { job: string; verification_run: string; plan_run: string; items: string[]; sha256: string; ended: 'done' | 'unknown' | null; outcome: string; frozen: boolean; result: string | null; device_return: string | null; rows: JobRow[] | null;
  /** the Hub's own reason and named next step of a job that did not go out, as run-jobs@1 would carry them. */
  missing_facts?: Array<{ fact: string; next_action: string }>; member_missing_facts?: Array<{ fact: string; next_action: string }>; next_action?: string }
/** a verification run none of whose jobs went to the bed (every job ended before anything was sent) is not a run of the cases. */
export function neverReachedBed(run: string, jobs: readonly ExportedJob[]): boolean {
  const own = jobs.filter((job) => job.verification_run === run);
  return own.length > 0 && own.every((job) => job.ended === 'done' && job.outcome === 'not_dispatched');
}
/** what the report says about a verification run that never reached the bed: which job, which cases, why, and who acts. */
export interface Unsent { run: string; job: string; plan_run: string; sha256: string; items: string[]; missing_facts: Array<{ fact: string; next_action: string }>; member_missing_facts?: Array<{ fact: string; next_action: string }>; next_action?: string }
export function unsentOf(run: string, jobs: readonly ExportedJob[]): Unsent {
  const last = jobs.filter((job) => job.verification_run === run).at(-1)!;
  return { run, job: last.job, plan_run: last.plan_run, sha256: last.sha256, items: [...last.items], missing_facts: structuredClone(last.missing_facts ?? []), ...(last.member_missing_facts !== undefined ? { member_missing_facts: structuredClone(last.member_missing_facts) } : {}), ...(last.next_action ? { next_action: last.next_action } : {}) };
}
/** User prose selects the recorded member view without replacing the caller's original machine facts. */
const reportFacts = (u: Unsent) => u.member_missing_facts ?? u.missing_facts;
/** One dispatch that settled: the run it verified, the plan run it was generated from, the workbook digest and each item's verdict. */
export interface Dispatch { run: string; job: string; plan_run: string; sha256: string; items: string[]; rows: JobRow[] }
/** A product-defect candidate (InfoTest fail_attribution.py defect_candidate): how to reproduce it, the author's expected text and the device's actual words. */
export interface DefectCandidate { repro: string; expected: string; actual: string }
// The model proposes the conflict; quotation checks do not decide who is right.
export interface AuthorConflict { author: string; manual: string; reference: string }
export interface CaseNote { attribution?: Attribution; absent?: true; judged: string; remedy: string; /** one sentence of why the case did not succeed, for the closing reply. */ cause?: string; round?: number; evidence?: string; defect_candidate?: DefectCandidate; author_conflict?: AuthorConflict }
export interface Notes { round?: number; batch?: string; cases: Record<string, CaseNote> }
/** What the document holds for a case: its title and original lines (steps with their expectations), when known. */
export interface Original { title: string; lines: Array<{ text: string; expected: string[] }> }

const SHA = /^[0-9a-f]{64}$/;
const RUN = /^run_[0-9a-z]{26}$/;
const CAUSE_MAX = 200;
const NOTE_MAX = 4000;
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((v) => typeof v === 'string' && v.length > 0);

/** The Hub's run-jobs@1 answer for `run`, checked for shape; anything else is refused rather than guessed at. */
export function parseRunJobs(value: unknown, run: string): ExportedJob[] {
  if (!isRecord(value) || value.schema !== 'run-jobs@1' || value.run !== run || !Array.isArray(value.jobs)) failCall('temporarily_unavailable', `Hub 返回的上机验证信息不完整或不属于本次上机验证`, '请维护者核对 Hub 作业导出的结构和运行绑定后重试');
  return value.jobs.map((job) => {
    if (!isRecord(job) || typeof job.job !== 'string' || !RUN.test(String(job.verification_run)) || !RUN.test(String(job.plan_run)) || !strings(job.items) || !SHA.test(String(job.sha256)) || typeof job.frozen !== 'boolean' || typeof job.outcome !== 'string') failCall('temporarily_unavailable', `Hub 返回的上机验证信息不完整`, '请维护者核对 Hub 作业导出的结构和运行绑定后重试');
    if (job.rows !== null && (!Array.isArray(job.rows) || job.rows.some((row) => !isRecord(row) || typeof row.item !== 'string' || typeof row.dynamic_terminal !== 'string'))) failCall('temporarily_unavailable', `Hub 返回的原始用例结论不完整`, '请维护者核对 Hub 作业导出的结构和运行绑定后重试');
    return job as unknown as ExportedJob;
  });
}

/** The dispatch of a verification run that counts: its latest job that ended with a verdict for every item. */
export function settledDispatch(run: string, jobs: ExportedJob[]): Dispatch {
  const own = jobs.filter((job) => job.verification_run === run);
  const settled = own.filter((job) => job.ended === 'done' && !job.frozen && job.rows !== null);
  const job = settled.at(-1);
  if (!job) {
    const open = own.find((j) => j.ended === null);
    if (open) failCall('temporarily_unavailable', `上机验证还没有结束，请等结束后生成交付报告`, '请读取原作业的进展，取得完整且未冻结的逐条结果后重试');
    const frozen = own.find((j) => j.frozen || j.ended === 'unknown');
    if (frozen) failCall('temporarily_unavailable', `上机验证状态未知，原因还没查清；下一步由使用者联系管理员处理，再生成交付报告`, '请读取原作业的进展，取得完整且未冻结的逐条结果后重试');
    failCall('temporarily_unavailable', `尚未上机验证，或设备输出缺少逐条结论；--runs 请只选择已结束的上机验证`, '请读取原作业的进展，取得完整且未冻结的逐条结果后重试');
  }
  const rows = job.rows!;
  if (rows.length !== job.items.length || new Set(rows.map((r) => r.item)).size !== rows.length || rows.some((r) => !job.items.includes(r.item))) failCall('temporarily_unavailable', `设备输出中的结论没有覆盖本次上机验证的全部原始用例`, '请读取原作业的进展，取得完整且未冻结的逐条结果后重试');
  return { run, job: job.job, plan_run: job.plan_run, sha256: job.sha256, items: [...job.items], rows };
}

/**
 * `history` holds the device observations of a case, one per dispatch that ran it: every count of device attempts reads it.
 * `not_executed` holds the dispatches that held the case but never reached it; they are no observation and no attempt.
 */
export interface CaseOutcome { autoid: string; status: Status; history: Array<{ report_check?: JobRow['report_check']; qualifier?: JobRow['qualifier']; accepted_as_fact?: boolean; missing_facts?: string[]; missing_fact?: string; next_action?: string; ordinal: number; run: string; job: string; terminal: string; reported_terminal?: string; log?: string; sessions?: Record<string, string>; audit?: RowAudit }>; not_executed?: Array<NotExecuted & { ordinal: number; run: string; job: string; plan_run: string }>; rounds?: number; pending?: string[]; evidence_unverified?: true; basis?: CaseBasis; closing?: Closing; missing?: MissingFact; conflict?: AuthorConflict }
/**
 * What the Hub recorded for a case's own plan in `plan_run`: `requirement` left pending on a data gap with a request (a missing
 * fact), or left without an accepted plan after the repair rounds were used up (repair_exhausted).
 */
export interface MissingFact { kind: 'data_gap' | 'repair_exhausted'; plan_run: string; requirement: string; missing: string; attributions?: Attribution[]; gaps?: Array<{ reason?: string; missing: string; exit?: unknown }>; exit?: unknown }
export interface CaseBasis {
  plan_run: string;
  attributions: Attribution[];
  gaps: Array<{ requirement: string; reason?: string; attribution?: Attribution; missing?: string; exit?: unknown }>;
}
/** Reads every declared independent cause; labels and prose never determine attribution. */
export function caseBasisOf(exported: unknown, run: string, id: string): CaseBasis | null {
  if (!isRecord(exported) || exported.schema !== 'run-export@1' || !isRecord(exported.run) || exported.run.run !== run || !isRecord(exported.result) || exported.result.run !== run || !isRecord(exported.result.partitions)) return null;
  const entries = Object.values(exported.result.partitions).flatMap(value => Array.isArray(value) ? value : []).filter(entry => isRecord(entry) && entry.item === id);
  if (entries.length !== 1 || !Array.isArray(entries[0].requirements)) return null;
  const gaps: CaseBasis['gaps'] = [];
  for (const requirement of entries[0].requirements) {
    if (!isRecord(requirement) || typeof requirement.requirement !== 'string' || !Array.isArray(requirement.layers)) continue;
    for (const layer of requirement.layers.filter(isRecord)) {
      for (const cause of [layer, ...(Array.isArray(layer.gaps) ? layer.gaps.filter(isRecord) : [])]) {
        if (cause.reason === undefined && cause.attribution === undefined && cause.missing === undefined && cause.exit === undefined) continue;
        gaps.push({ requirement: requirement.requirement, ...(typeof cause.reason === 'string' ? { reason: cause.reason } : {}), ...(isAttribution(cause.attribution) ? { attribution: cause.attribution } : {}), ...(typeof cause.missing === 'string' && cause.missing.trim() ? { missing: cause.missing } : {}), ...(cause.exit !== undefined ? { exit: structuredClone(cause.exit) } : {}) });
      }
    }
  }
  return { plan_run: run, attributions: [...new Set(gaps.flatMap(gap => gap.attribution ? [gap.attribution] : []))], gaps };
}

export interface Assembly {
  cases: CaseOutcome[];
  /** The last dispatch, when every item of it passed: its workbook is the pass volume. */
  pass: Dispatch | null;
  /** The cases of the unsuccessful volume in document order, each with the dispatch of its latest verdict (its plan goes in). */
  unsuccessful: { items: string[]; sources: Record<string, { plan_run: string; run: string | null }> } | null;
  totals: Record<Status, number> & { cases: number };
}

/**
 * Settles every case of the document from the dispatches in the order they ran. The pass volume is the latest dispatch that
 * passed whole after which none of its cases failed; a later dispatch may rerun its cases if they pass again, and may try other
 * cases. As in the reference engine, every case whose latest verdict is a pass goes to the bed in that one volume and passes
 * there item by item. A pass outside that verified volume remains a reported pass with pending delivery eligibility;
 * it does not prevent the verified volume and the remaining case report from being written.
 */
export function assemble(population: string[], dispatches: Dispatch[]): Assembly {
  if (!population.length || new Set(population).size !== population.length) failCall('invalid_parameters', '原始用例清单为空或用例 ID 重复', '请提供同一文档范围内、互不重复的上机验证记录');
  if (new Set(dispatches.map((d) => d.run)).size !== dispatches.length) failCall('invalid_parameters', '--runs 中重复选择了同一次上机验证', '请提供同一文档范围内、互不重复的上机验证记录');
  for (const d of dispatches) for (const item of d.items) if (!population.includes(item)) failCall('invalid_parameters', `上机验证包含不在这份原始用例清单里的原始用例 ${item}`, '请提供同一文档范围内、互不重复的上机验证记录');
  const passedWhole = (d: Dispatch) => d.rows.length > 0 && d.rows.every((r) => r.dynamic_terminal === 'pass');
  // A dispatch that never reached a case says nothing against an earlier pass of it.
  const holds = (k: number) => dispatches.slice(k + 1).every((later) => later.rows.every((r) => r.not_executed !== undefined || !dispatches[k].items.includes(r.item) || r.dynamic_terminal === 'pass'));
  const at = dispatches.findLastIndex((d, k) => passedWhole(d) && holds(k));
  const pass = at < 0 ? null : dispatches[at];
  const delivered = new Set(pass?.items ?? []);
  const cases: CaseOutcome[] = population.map((autoid) => {
    // A row the run did not reach is no observation of the case: it stays out of `history`, which every count of attempts reads.
    const skipped: NonNullable<CaseOutcome['not_executed']> = [];
    const history = dispatches.flatMap((d, k) => d.rows.filter((r) => r.item === autoid).flatMap((r) => {
      if (r.not_executed) { skipped.push({ ordinal: k + 1, run: d.run, job: d.job, plan_run: d.plan_run, ...structuredClone(r.not_executed) }); return []; }
      return [{ ordinal: k + 1, run: d.run, job: d.job, terminal: r.dynamic_terminal, ...(r.report_check ? { report_check: structuredClone(r.report_check) } : {}), ...(r.reported_terminal ? { reported_terminal: r.reported_terminal } : {}), ...(r.qualifier ? { qualifier: r.qualifier } : {}), ...(r.accepted_as_fact === undefined ? {} : { accepted_as_fact: r.accepted_as_fact }), ...(r.missing_facts ? { missing_facts: r.missing_facts } : {}), ...(r.missing_fact ? { missing_fact: r.missing_fact } : {}), ...(r.next_action ? { next_action: r.next_action } : {}), ...(r.evidence?.log ? { log: r.evidence.log } : {}), ...(r.evidence?.sessions ? { sessions: r.evidence.sessions } : {}), ...(r.audit ? { audit: r.audit } : {}) }];
    }));
    const unexecuted = skipped.length ? { not_executed: skipped } : {};
    if (delivered.has(autoid)) return { autoid, status: 'delivered' as const, history, ...unexecuted };
    const latest = history.at(-1);
    if (!latest) return { autoid, status: 'unrun' as const, history, ...unexecuted };
    return { autoid, status: latest.terminal === 'fail' ? 'failed' as const : 'unsettled' as const, history, ...unexecuted, ...(latest.terminal === 'pass' ? { pending: ['最近一次正确的观察不在已验证整卷中，交付资格尚未核验；保留该观察，下一步把这些用例合成整卷并验证'] } : latest.missing_facts?.length ? { pending: ['设备输出的完整性前提尚未核验'] } : latest.missing_fact ? { pending: [latest.missing_fact] } : {}) };
  });
  const unpassed = cases.filter((c) => c.status === 'failed' || c.status === 'unsettled').map((c) => c.autoid);
  let unsuccessful: Assembly['unsuccessful'] = null;
  if (unpassed.length) {
    const sources: Record<string, { plan_run: string; run: string | null }> = {};
    for (const item of unpassed) sources[item] = dispatches.find((d) => d.run === cases.find((c) => c.autoid === item)!.history.at(-1)!.run)!;
    unsuccessful = { items: unpassed, sources };
  }
  const totals = { cases: cases.length, delivered: 0, failed: 0, unsettled: 0, unrun: 0 } as Assembly['totals'];
  for (const c of cases) totals[c.status]++;
  return { cases, pass, unsuccessful, totals };
}

/**
 * The reference engine's single-case verdict downgrade (tools/device/batch_tools.py:1091-1158 with the domain grammar's
 * exec_failure_markers): a pass whose output carries a line with an execution-failure marker that none of the case's own
 * assertions reads is no verdict there ("broken", a vacuous-pass suspicion). That engine scans the run log of a pass, having
 * fetched device sessions only for cases that failed, and so does this one (owner 2026-11-09: the reference engine's way, no
 * session scan of passes). `texts` maps where (the run log) to its text; a line is exempt when one of the assertion texts is
 * part of it, and so is the runner's own line before a step (`#######   stepN: <description>`), which prints the workbook's text
 * and not the device's. Returns the first such line, or null.
 */
export function failureLine(texts: Readonly<Record<string, string>>, markers: readonly string[], assertions: readonly string[]): RowAudit | null {
  for (const [where, text] of Object.entries(texts)) for (const raw of text.replace(/\r/g, '').split('\n')) {
    const line = raw.trim();
    if (!line || !markers.some((marker) => line.includes(marker))) continue;
    if (STEP_LINE.test(line.replace(LOG_STAMP, ''))) continue;
    if (assertions.some((assertion) => assertion.length > 0 && line.includes(assertion))) continue;
    return { where, line };
  }
  return null;
}
/** The dispatches with each audited pass, keyed run and item, turned into no verdict with the line that did it. */
export function auditPasses(dispatches: readonly Dispatch[], hits: ReadonlyMap<string, RowAudit>): Dispatch[] {
  return dispatches.map((d) => ({ ...d, rows: d.rows.map((r) => { const hit = r.dynamic_terminal === 'pass' ? hits.get(auditKey(d.run, r.item)) : undefined; return hit ? { ...r, reported_terminal: r.dynamic_terminal, dynamic_terminal: 'no_verdict', audit: hit } : r; }) }));
}
export const auditKey = (run: string, item: string): string => `${run}\u0000${item}`;

/**
 * A run that stopped in one case. InfoTest's runner (knowledge/framework/mirror/lib/test_xlsx.py) runs every case of a workbook
 * in ONE pytest test and puts no guard around a step, so an exception raised in a step ends the whole test: the cases after it
 * never begin (parser_case_id, which opens a case's result row and its log, is not reached) and the gateway has neither a result
 * row nor a log nor a session for them. InfoTest meets the same thing in its batch runs (tools/device/structural_gate.py: "the
 * whole pytest file crashes — every case after this one is skipped") and calls those cases "crashed/not reached", a cascade and
 * not failures (tools/device/batch_tools.py dev_run_batch_digest); its engine records them as broken, with no fail signature and no
 * deep attribution, a recompose burns no round, and the report counts them apart as "N cases not run (reason)" (docs/engine/
 * 03_pipeline.md, S_BROKEN; compile_engine/facts.py rounds_used counts authored versions, not runs). The Hub, which only reads the
 * gateway's `complete`, answers every case of such a job with the same no verdict, "the report is not complete, resume later",
 * which is no advice for a case that will never have a report. The rule below is read from the rows and the log by structure alone.
 */
const LOG_STAMP = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\s+/;
/** pytest's report of an exception marks the source line that raised with `>` and the exception text with `E` (conftest.py hands report.longreprtext to check_point.close(), which writes it into the log of the case that was running). */
const FAILING_SOURCE = /^>\s{3,}\S/, EXCEPTION_TEXT = /^E\s{3,}\S/;
/** The runner's own line before each step that has a description: `#######   step9: <description>`; the number is the workbook's column C. */
const STEP_LINE = /^#{2,}\s+step(\d+):/;
export interface RunnerAbort { step: number | null }
/**
 * Whether the log of a case carries pytest's report of an exception the runner did not catch, and the number of the last step line
 * the log printed before it (a row without a description prints none, so the step is that of the last row that had one). A case
 * that failed a check point closes with the same FAIL banner but carries no such report: the run went on.
 */
export function runnerAbort(log: string): RunnerAbort | null {
  const lines = log.replace(/\r/g, '').split('\n').map((line) => line.replace(LOG_STAMP, ''));
  const exception = lines.findIndex((line) => EXCEPTION_TEXT.test(line));
  if (exception < 0) return null;
  const source = lines.findLastIndex((line, index) => index < exception && FAILING_SOURCE.test(line));
  if (source < 0) return null;
  for (let index = source - 1; index >= 0; index--) { const step = STEP_LINE.exec(lines[index]); if (step) return { step: Number(step[1]) }; }
  return { step: null };
}
/** A dispatched row as the run's reach is read: whether the Hub holds a log or a session of it, and the log's words when they are at hand. */
export interface ReachRow { item: string; reached: boolean; log?: string | null }
export const NOT_EXECUTED_NEXT = '修正前一条后重新上机；本次不算本条的一次上机';
/** The program-decided reason of a case the run did not reach: the case before it and the step that ended the run. */
export function notExecutedReason(by: NotExecuted['by'], title: string | undefined): string {
  return `同一份自动化用例 Excel 中排在前面的原始用例 ${by.item} ${title || '标题未知'} ${by.step === null ? '' : `在第 ${by.step} 步`}出现异常，运行器中止了整本，本条没有在设备上执行`;
}
/**
 * The case the run reached last and the cases after it, in the workbook's order (the order the dispatch was submitted in, which
 * the gateway echoed back), when there are any: the cases that stand after every log and session the Hub holds.
 */
export function trailingUnreached(items: readonly string[], rows: readonly ReachRow[]): { last: string; later: string[] } | null {
  const ordered = items.flatMap((item) => rows.filter((row) => row.item === item));
  const last = ordered.findLastIndex((row) => row.reached);
  return last < 0 || last === ordered.length - 1 ? null : { last: ordered[last].item, later: ordered.slice(last + 1).map((row) => row.item) };
}
/** The cases after `tail.last` are not executed when its log, whose words are `log`, ends in the exception. */
export function unexecutedAfter(tail: { last: string; later: readonly string[] }, log: string | null, titleOf: (item: string) => string | undefined = () => undefined): Map<string, NotExecuted> {
  const found = new Map<string, NotExecuted>();
  const abort = log === null ? null : runnerAbort(log);
  if (!abort) return found;
  const by = { item: tail.last, step: abort.step }, reason = notExecutedReason(by, titleOf(tail.last));
  for (const item of tail.later) found.set(item, { by: { ...by }, reason, next_action: NOT_EXECUTED_NEXT });
  return found;
}
/**
 * The cases of one dispatch that the run did not reach: those after the last case it reached, when that case's log ends in the
 * exception that stopped the run. Nothing is said when the run reached every case, when the last case it reached shows no
 * exception (the run may be unfinished, killed or collected in part: that is no proof), or when a later case has any log or session.
 */
export function unexecutedRows(items: readonly string[], rows: readonly ReachRow[], titleOf?: (item: string) => string | undefined): Map<string, NotExecuted> {
  const tail = trailingUnreached(items, rows);
  return tail === null ? new Map() : unexecutedAfter(tail, rows.find((row) => row.item === tail.last)?.log ?? null, titleOf);
}
/**
 * What the dispatch as a whole says when its run stopped in a case (the cases `unexecutedRows` found): the case and the step that
 * ended it, once, and the next step. The Hub's own report_check of every case of the job is that the report is not complete, which
 * is the same whether the report is still arriving or the run ended in a case and no more of it will come; this is the second.
 */
export interface WorkbookAbort { by: NotExecuted['by']; reason: string; next_action: string }
export function workbookAbort(stopped: ReadonlyMap<string, NotExecuted>, titleOf?: (item: string) => string | undefined): WorkbookAbort | null {
  const [first] = stopped.values();
  if (!first) return null;
  const { by } = first;
  return {
    by: { ...by },
    reason: `同一份自动化用例 Excel 中的原始用例 ${by.item} ${titleOf?.(by.item) || '标题未知'} ${by.step === null ? '' : `在第 ${by.step} 步`}出现异常，运行器中止了整本：其后 ${stopped.size} 条没有在设备上执行，整份报告因此不完整`,
    next_action: `修正原始用例 ${by.item} 后重新上机，异常报告在它的设备输出里；等待和 job resume 都补不出缺的报告，也不重新提交这次上机验证`,
  };
}

/** A command the device refused to parse, as one of its sessions shows it (see syntaxRejections). */
export interface SyntaxRejection { command: string; token?: string; prompt?: string }
const isCaretLine = (line: string): boolean => { const s = line.trim(); return s === '^' || (s.length <= 3 && s.includes('^')); };
export const LEADING_PROMPT = /^([A-Za-z][A-Za-z0-9_.-]{0,20}(?:\([A-Za-z0-9_\- ]+\))?[#>])/;
const PROMPT_LOOKBACK = 8;
/** The word of `line` the caret column points at, or the next word after it (the reference engine's locate_caret_token). */
function wordAt(line: string, column: number): string | null {
  const words = [...line.matchAll(/\S+/g)];
  const hit = words.find((w) => w.index <= column && column < w.index + w[0].length) ?? words.find((w) => w.index > column);
  return hit ? hit[0] : null;
}
/**
 * The reference engine's one mechanical pre-judgement of a failed case (main/ist_core/tools/device/fail_attribution.py
 * attribute_fail, device_errors.py has_caret_error and parse_caret_positions): a session line that holds only a caret is the
 * device refusing to parse the command it echoed on the line directly above; the caret stands under the word it stopped at.
 * That is a fact of the terminal protocol, read by position, and the only cause of failure a program names: the command was
 * not accepted, so what fails later in the same case mostly follows from it. Everything else stays the model's to attribute.
 * `prompt` is the prompt the command was typed at, when that line is still in the session. In run 19 one case met the same
 * caret three rounds running under a command sent at the wrong prompt, read each time as the bed lacking a configuration.
 */
export function syntaxRejections(session: string): SyntaxRejection[] {
  const lines = session.replace(/\r/g, '').split('\n'), found: SyntaxRejection[] = [], seen = new Set<string>();
  for (let i = 1; i < lines.length; i++) {
    if (!isCaretLine(lines[i]) || !lines[i - 1].trim()) continue;
    const above = lines[i - 1], prompted = LEADING_PROMPT.exec(above);
    const rejection: SyntaxRejection = { command: (prompted ? above.slice(prompted[1].length) : above).trim() };
    if (!rejection.command) continue;
    if (prompted) rejection.prompt = prompted[1];
    else {
      // The echo shares the caret's columns only when it carries no prompt; the prompt is on the line the command was typed at.
      const word = wordAt(above, lines[i].indexOf('^'));
      if (word) rejection.token = word;
      for (let j = i - 2; j >= 0 && j >= i - PROMPT_LOOKBACK; j--) {
        const typed = LEADING_PROMPT.exec(lines[j]);
        if (typed && lines[j].slice(typed[1].length).trim() === rejection.command) { rejection.prompt = typed[1]; break; }
      }
    }
    const key = JSON.stringify([rejection.command, rejection.token ?? null, rejection.prompt ?? null]);
    if (!seen.has(key)) { seen.add(key); found.push(rejection); }
  }
  return found;
}

/** A command the device answered with a declared execution-failure line: the prompt it was typed at, the command as the session echoes it, and the device's reply up to that line. */
export interface ExecutionRefusal { command: string; prompt: string; reply: string[]; echo_cut?: true }
const REPLY_LINES = 6, REPLY_CHARS = 400;
/**
 * The commands a session shows the device refusing to execute. A line that begins with a prompt is a command typed at it and
 * the lines down to the next such line are the device's reply; a reply that carries one of the execution-failure lines the
 * runner contract declares is the device's
 * own verdict on that command, and the lines before/at it are its reason. Read by position in the terminal transcript (the
 * reference keeps one authority for a device's CLI errors, device_errors.py, and hands the lines of the last run that carry
 * one to the next writer with the directive that the fault is in the case's own command sequence, compile_engine/briefs.py
 * execution_failures). What the refusal means is not decided here. A long command is echoed with the terminal's own
 * redrawing, so the command is the echo up to its first control character and `echo_cut` says it is only the beginning; the
 * run log holds the whole line.
 */
export function executionRefusals(session: string, markers: readonly string[]): ExecutionRefusal[] {
  if (!markers.length) return [];
  const lines = session.replace(/\r/g, '').split('\n'), found: ExecutionRefusal[] = [], seen = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    const typed = LEADING_PROMPT.exec(lines[i]);
    if (!typed) continue;
    const echoed = lines[i].slice(typed[1].length), control = echoed.search(/[\u0000-\u001f\u007f]/);
    const command = (control < 0 ? echoed : echoed.slice(0, control)).trim();
    if (!command) continue;
    const reply: string[] = [];
    let markerHit = false;
    for (let j = i + 1; j < lines.length && !LEADING_PROMPT.test(lines[j]); j++) {
      const line = lines[j].trim();
      if (!line) continue;
      reply.push(line.length > REPLY_CHARS ? line.slice(0, REPLY_CHARS) + '…' : line);
      if (markers.some((marker) => line.includes(marker))) { markerHit = true; break; }
    }
    if (!markerHit) continue;
    const trimmedReply = reply.slice(-REPLY_LINES);
    const refusal: ExecutionRefusal = { command, prompt: typed[1], reply: trimmedReply, ...(control < 0 ? {} : { echo_cut: true as const }) };
    const key = JSON.stringify([refusal.command, refusal.prompt, refusal.reply]);
    if (!seen.has(key)) { seen.add(key); found.push(refusal); }
  }
  return found;
}

/** The model's notes: one judged paragraph and one fix-or-trade-off paragraph for exactly the cases not delivered. */
export function readNotes(value: unknown, undelivered: string[]): Notes {
  if (!isRecord(value) || !isRecord(value.cases) || Object.keys(value).some((key) => key !== 'cases' && key !== 'batch' && key !== 'round')) failCall('invalid_parameters', '说明文件请按原始用例分别写结论、下一步和设备输出，格式见交付工具说明', '请按交付说明提供模型说明文件并保留原句');
  const parseRound = (v: unknown, where: string): number => {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) failCall('invalid_parameters', `${where} 的轮次（round）须是大于等于 1 的整数`, '请按交付说明提供模型说明文件；没有到过设备的条目不写 round，有上机记录时填写对应的正整数轮次');
    return v;
  };
  const text = (v: unknown, where: string): string => {
    if (typeof v !== 'string' || !v.trim() || v.length > NOTE_MAX || /[\u0000-\u0009\u000b-\u001f\u007f]/.test(v)) failCall('invalid_parameters', `${where} 要是 1 到 ${NOTE_MAX} 字的文字（可换行，不含其他控制字符）`, '请按交付说明提供模型说明文件并保留原句');
    return v.trim();
  };
  const sentence = (v: unknown, where: string): string => {
    const said = text(v, where);
    if (said.length > CAUSE_MAX || said.includes('\n')) failCall('invalid_parameters', `${where}要是一句话：不换行，不超过 ${CAUSE_MAX} 字`, '请按交付说明提供模型说明文件并保留原句');
    return said;
  };
  const keys = Object.keys(value.cases);
  const missing = undelivered.filter((a) => !keys.includes(a)), extra = keys.filter((a) => !undelivered.includes(a));
  if (extra.length) failCall('invalid_parameters', `说明要恰好覆盖没有交付的用例：${missing.length ? `缺 ${missing.join('、')}` : ''}${missing.length && extra.length ? '；' : ''}${extra.length ? `多了 ${extra.join('、')}（交付的用例不写说明）` : ''}`, '请按交付说明提供模型说明文件并保留原句');
  const cases: Record<string, CaseNote> = {};
  for (const autoid of undelivered) {
    const note = value.cases[autoid];
    if (note === undefined) { cases[autoid] = { judged: '尚未提供模型说明', remedy: '尚未提供模型建议', absent: true }; continue; }
    if (!isRecord(note) || Object.keys(note).some((k) => !['judged', 'remedy', 'cause', 'round', 'evidence', 'defect_candidate', 'author_conflict', 'attribution'].includes(k))) failCall('invalid_parameters', `用例 ${autoid} 的说明请只写结论、下一步、可选的一句话原因 cause、可选轮次 round、设备输出，以及判断设备问题或原始用例问题所需的原文`, '请按交付说明提供模型说明文件并保留原句');
    if (note.attribution !== undefined && !isAttribution(note.attribution)) failCall('invalid_parameters', `用例 ${autoid} 的 attribution 必须来自已声明原因代码`, '请按交付说明提供模型说明文件并保留原句');
    const candidate = note.defect_candidate, conflict = note.author_conflict;
    if (candidate !== undefined && (!isRecord(candidate) || Object.keys(candidate).sort().join() !== 'actual,expected,repro')) failCall('invalid_parameters', `用例 ${autoid} 判断设备的问题时，请只写复现步骤、原始用例期望原句和设备输出三项`, '请按交付说明提供模型说明文件并保留原句');
    if (conflict !== undefined && (!isRecord(conflict) || Object.keys(conflict).sort().join() !== 'author,manual,reference')) failCall('invalid_parameters', `用例 ${autoid} 判断原始用例的问题时，请只写原始用例原句、手册原话和对应的手册三项`, '请按交付说明提供模型说明文件并保留原句');
    if (candidate !== undefined && conflict !== undefined) failCall('invalid_parameters', `用例 ${autoid} 不能同时判断为设备的问题和原始用例的问题；手册排除这个取值时请核对原始用例，手册支持这个取值时请核对设备输出`, '请按交付说明提供模型说明文件并保留原句');
    cases[autoid] = {
      judged: text(note.judged, `用例 ${autoid} 的结论`), remedy: text(note.remedy, `用例 ${autoid} 的下一步`),
      ...(isAttribution(note.attribution) ? { attribution: note.attribution } : {}),
      ...(note.cause === undefined ? {} : { cause: sentence(note.cause, `用例 ${autoid} 的一句话原因`) }),
      ...(note.round === undefined ? {} : { round: parseRound(note.round, `用例 ${autoid}`) }),
      ...(note.evidence === undefined ? {} : { evidence: text(note.evidence, `用例 ${autoid} 的设备输出`) }),
      ...(isRecord(candidate) ? { defect_candidate: { repro: text(candidate.repro, `用例 ${autoid} 的复现步骤`), expected: text(candidate.expected, `用例 ${autoid} 的期望原句`), actual: text(candidate.actual, `用例 ${autoid} 的设备输出`) } } : {}),
      ...(isRecord(conflict) ? { author_conflict: { author: text(conflict.author, `用例 ${autoid} 的原始用例原句`), manual: text(conflict.manual, `用例 ${autoid} 的手册原话`), reference: text(conflict.reference, `用例 ${autoid} 对应的手册`) } } : {}),
    };
  }
  return { ...(value.round === undefined ? {} : { round: parseRound(value.round, '说明文件') }), ...(value.batch === undefined ? {} : { batch: text(value.batch, '补充说明') }), cases };
}

/**
 * The reference engine accepts an attribution only when its evidence is a verbatim substring of the device context (InfoTest
 * fail_attribution.py). Here: every case not delivered whose last device output was read must carry evidence copied from that
 * output (the runner log or a device session); carriage returns are ignored, nothing else is normalized. Returns the problems.
 */
export function evidenceProblems(notes: Notes, deviceTexts: Record<string, string[]>): string[] {
  const problems: string[] = [];
  const plain = (text: string) => text.replace(/\r/g, '');
  for (const [autoid, texts] of Object.entries(deviceTexts)) {
    if (!texts.length) continue;
    const evidence = notes.cases[autoid]?.evidence;
    if (evidence === undefined) problems.push(`用例 ${autoid} 已做上机验证，但说明缺少设备输出；请逐字复制最近一次上机验证说明错误的那段设备输出`);
    else if (!texts.some((text) => plain(text).includes(plain(evidence)))) problems.push(`用例 ${autoid} 的设备输出不是最近一次上机验证的原话；逐字复制，不改写、不拼接`);
  }
  return problems;
}

/**
 * How a case that failed on the bed closes, after the reference engine (InfoTest compile_engine/remedies.py derive_queue with
 * max_rounds 3, terminal_outcomes.py, render.py; tools/device/fail_attribution.py and verifiability_tool.py). It goes back to
 * authoring until MAX_ROUNDS authored versions of it failed on the bed (a rerun of the same plan is not a new round). Before that
 * it closes only as a device-defect candidate whose expected text is the author's and whose actual text is the device's, both
 * verbatim, and whose last device output holds no syntax rejection (see syntaxRejections); a written judgement that the bed lacks a prerequisite, that the product is at fault or that the cause is undetermined
 * is not a terminal credential ("continue authoring the case as written"; undetermined goes back with a read-only observation).
 * At the cap it closes as the model not finding a solution, and the judged paragraphs stay the model's own account.
 * A pass the pass review turned into no verdict (failureLine below; the reference engine records it as broken with the subtype
 * errored) takes the same road: compile_engine/nodes.py author_redispatch_disposition sends failed, contradicted and
 * broken-errored cases back to the author under the one round cap. In run 20 such a case was left out of the pass volume and
 * handed over as 上机没有结论 after two authored versions, with no third round and no closing.
 */
export const MAX_ROUNDS = 3;
export const CLOSING = { authoring_failure: '所记录的核验尚未通过', device_defect: '声明与设备行为冲突（待仲裁）', missing_fact: '缺少 Hub 点名的事实（待补齐）', author_conflict: '作者步骤与手册冲突（待作者或用户裁定）' } as const;
export type Closing = keyof typeof CLOSING;

/** The line by which the pass review dropped the case's latest pass, when that is how its last dispatch ended. */
export const droppedPass = (outcome: CaseOutcome): RowAudit | undefined => (outcome.status === 'unsettled' ? outcome.history.at(-1)?.audit : undefined);
/** Whether the closing rules of a failed case apply: its latest verdict is a failure, or a pass the pass review dropped. */
export const reworked = (outcome: CaseOutcome): boolean => outcome.status === 'failed' || droppedPass(outcome) !== undefined;

export interface ConflictGround { authored: Readonly<Record<string, readonly string[]>>; statements: ReadonlyMap<string, string>; unavailable?: ReadonlyMap<string, string> }
// Quotation width follows the existing author-conflict evidence rule.
const CONFLICT_MIN_QUOTE = 4;
const shownRejections = (refused: readonly SyntaxRejection[]): string => refused.slice(0, 3).map((r) => `“${r.command.length > 80 ? `${r.command.slice(0, 80)}…` : r.command}”${r.prompt ? `（在 ${r.prompt} 下）` : ''}`).join('、');

export function authorConflictProblems(autoid: string, conflict: AuthorConflict, ground: ConflictGround | undefined, deviceTexts: readonly string[]): string[] {
  const refused = deviceTexts.flatMap((text) => syntaxRejections(text));
  if (refused.length) return [`用例 ${autoid} 判断原始用例的问题时，它最后一次上机里设备用 ^ 拒绝了命令 ${shownRejections(refused)}。设备没有接受这条命令的写法，作者的场景没有在设备上实现，够不上作者步骤与手册冲突：请重新判断原因，先修这条命令再做上机验证；最多重交 ${MAX_ROUNDS} 次，仍未核对正确时只陈述这些内容的核验结果，原因未查清就保留未知`];
  const plain = (text: string) => text.replace(/\r/g, '');
  const wrong: string[] = [];
  if (plain(conflict.author).length < CONFLICT_MIN_QUOTE || plain(conflict.manual).length < CONFLICT_MIN_QUOTE) wrong.push(`原始用例原句和手册原话各要逐字引用一整句，至少 ${CONFLICT_MIN_QUOTE} 个字，几个字指不出作者要的是什么、手册排除的是什么`);
  else {
    const words = ground?.authored[autoid];
    if (!words?.length) wrong.push('这条原始用例的原文取不到，请补齐用例重组或脚本编写时的原始用例');
    else if (!words.some((line) => quoteMatches(plain(line), plain(conflict.author)))) wrong.push('原始用例引文不是标题、步骤或期望的原句');
    const statement = ground?.statements.get(conflict.reference);
    if (statement === undefined) wrong.push(ground?.unavailable?.get(conflict.reference) ?? '所选手册不属于脚本编写时使用的手册和命令树，请使用同一构建的手册和命令树');
    else if (!quoteMatches(plain(statement), plain(conflict.manual))) wrong.push('手册引文不是所选手册的原话');
  }
  return wrong.length ? [`用例 ${autoid} 判断原始用例的问题时，${wrong.join('；')}；逐字复制，不改写、不拼接`] : [];
}

export function lockedStatements(bytes: Uint8Array, run: string, wanted: ReadonlySet<string>): { root: string; statements: Map<string, string> } {
  let head: Record<string, unknown> | null = null, nodes = 0;
  const statements = new Map<string, string>();
  let lines: string[];
  try { lines = new TextDecoder('utf-8', { fatal: true }).decode(bytes).split('\n'); } catch { failCall('temporarily_unavailable', '手册和命令树无法读取', '请维护者恢复与原摘要和冻结根一致的完整手册字节后重试'); }
  for (const line of lines) {
    if (line.length === 0) continue;
    let value: unknown;
    try { value = JSON.parse(line); } catch { failCall('temporarily_unavailable', '手册和命令树内容不完整', '请维护者恢复与原摘要和冻结根一致的完整手册字节后重试'); }
    if (head === null) {
      if (!isRecord(value) || value.schema !== 'run-knowledge@1' || value.run !== run || typeof value.root !== 'string') failCall('temporarily_unavailable', `手册和命令树不属于本次脚本编写或内容不完整`, '请维护者恢复与原摘要和冻结根一致的完整手册字节后重试');
      head = value; continue;
    }
    if (!isRecord(value) || !Array.isArray(value.entries)) failCall('temporarily_unavailable', '手册和命令树内容不完整', '请维护者恢复与原摘要和冻结根一致的完整手册字节后重试');
    nodes++;
    for (const entry of value.entries) if (isRecord(entry) && typeof entry.reference === 'string' && typeof entry.statement === 'string' && wanted.has(entry.reference)) statements.set(entry.reference, entry.statement);
  }
  if (head === null || head.nodes !== nodes) failCall('temporarily_unavailable', `手册和命令树缺少内容`, '请维护者恢复与原摘要和冻结根一致的完整手册字节后重试');
  return { root: head.root as string, statements };
}

/**
 * Closes every case that failed or whose pass the pass review dropped, or says why the delivery cannot be assembled yet.
 * `rounds` holds, per such case, how many distinct plans of it did not pass on the bed (a failure or a dropped pass);
 * `authored` holds expectations; `deviceTexts` holds the last device output; `ground` anchors author-conflict quotations.
 */
export function closeFailed(cases: CaseOutcome[], notes: Notes, rounds: Record<string, number>, authored: Record<string, string[]>, deviceTexts: Record<string, string[]>, ground?: ConflictGround): { cases: CaseOutcome[]; problems: string[] } {
  const plain = (text: string) => text.replace(/\r/g, '');
  const closed = cases.map((outcome): CaseOutcome => {
    const problems: string[] = [];
    const evaluate = (): CaseOutcome => {
      const conflict = notes.cases[outcome.autoid]?.author_conflict;
      if (conflict && (outcome.status === 'failed' || outcome.status === 'unsettled')) {
        const wrong = authorConflictProblems(outcome.autoid, conflict, ground, deviceTexts[outcome.autoid] ?? []);
        if (wrong.length) { problems.push(...wrong); return outcome; }
        return { ...outcome, ...(rounds[outcome.autoid] === undefined ? {} : { rounds: rounds[outcome.autoid] }), closing: 'author_conflict' as const, conflict };
      }
      if (!reworked(outcome)) return outcome;
      const used = rounds[outcome.autoid] ?? 0;
      const candidate = notes.cases[outcome.autoid]?.defect_candidate;
      if (candidate) {
        // A defect candidate is a signed "the author's expectation against what the device did" finding, "not a grammar,
        // environment, transient, or engine fault" (the reference engine's submit_attribution), and a lone caret is its one
        // grammar fault named by program: the device did not accept a command of the plan, so the author's scenario was not
        // realized on it. In run 19 a case closed as a candidate on the caret under a command typed at the wrong prompt.
        const refused = (deviceTexts[outcome.autoid] ?? []).flatMap((text) => syntaxRejections(text));
        if (refused.length) {
          problems.push(`用例 ${outcome.autoid} 判断设备的问题时，它最后一次上机里设备用 ^ 拒绝了命令 ${shownRejections(refused)}。设备没有接受这条命令的写法，作者的场景没有在设备上实现，够不上声明与设备行为冲突：请重新判断原因，先修这条命令再做上机验证；最多重交 ${MAX_ROUNDS} 次，仍未核对正确时只陈述这些内容的核验结果，原因未查清就保留未知`);
          return outcome;
        }
        const wrong: string[] = [];
        if (!(authored[outcome.autoid] ?? []).some((text) => plain(text).includes(plain(candidate.expected)))) wrong.push('期望不是原始用例的原句');
        if (!(deviceTexts[outcome.autoid] ?? []).some((text) => plain(text).includes(plain(candidate.actual)))) wrong.push('设备输出不是最近一次上机验证的原话');
        if (!wrong.length) return { ...outcome, rounds: used, closing: 'device_defect' as const };
        problems.push(`用例 ${outcome.autoid} 判断设备的问题时，${wrong.join('；')}；逐字复制，不改写、不拼接`);
        return outcome;
      }
      if (used >= MAX_ROUNDS) return { ...outcome, rounds: used, closing: 'authoring_failure' as const };
      const dropped = droppedPass(outcome);
      if (dropped) {
        problems.push(`用例 ${outcome.autoid} 最近一次上机验证状态未知，设备输出有执行失败原话“${dropped.line.length > 160 ? `${dropped.line.slice(0, 160)}…` : dropped.line}”，自动化用例没有检查这一行。下一步由编写模型检查这行设备输出，或改用不会执行失败的观察，改好自动化用例再一起做上机验证。已核验 ${used} 份不同自动化用例，最多 ${MAX_ROUNDS} 份；同一份自动化用例重新验证不增加内容份数`)
        return outcome;
      }
      problems.push(`已记录 ${used} 份不同内容的核验尚未通过，缺少可核验的原因归属；该条仍可在最多 ${MAX_ROUNDS} 份内容的既有预算内继续编写。模型自报的测试环境缺口或前置条件保持未确认，不以重复提交充当新证据`);
      return outcome;
    };
    const evaluated = evaluate();
    return problems.length ? { ...evaluated, closing: undefined, pending: [...(evaluated.pending ?? []), ...problems] } : evaluated;
  });
  return { cases: closed, problems: [] };
}

/**
 * How a case that never went to the bed closes, after the reference engine's exits for a case it could not compile (InfoTest
 * tools/device/verifiability_tool.py `_credential_gates`): each exit is certified only by what the engine's own checks recorded
 * in the session, and "a free-text claim that the bed lacks data, certificates, topology, or a helper is not a terminal
 * credential. Continue authoring the case as written." Two of the engine's own records are ported (`facts`, found by
 * tools/assemble-delivery.ts in the latest plan run that holds the case and has an accepted result): a requirement of the plan
 * (not the workbook's) left pending on a data gap with a request, which closes it as a missing fact; and the plan left without an
 * accepted version after the repair rounds were used up, which closes it as the model not finding a solution, as the reference
 * engine closes a case whose authored attempts were all refused at its round cap (compose_rejected counts as an attempt).
 * A verified author-conflict claim closes without a device return; other cases go back to authoring.
 */
export function closeUnrun(cases: CaseOutcome[], facts: Record<string, MissingFact>, notes?: Notes, ground?: ConflictGround): { cases: CaseOutcome[]; problems: string[] } {
  const closed = cases.map((outcome): CaseOutcome => {
    if (outcome.status !== 'unrun') return outcome;
    const fact = facts[outcome.autoid];
    if (fact) return { ...outcome, closing: fact.kind === 'data_gap' ? 'missing_fact' : 'authoring_failure', missing: fact };
    const conflict = notes?.cases[outcome.autoid]?.author_conflict;
    if (conflict) {
      const wrong = authorConflictProblems(outcome.autoid, conflict, ground, []);
      return wrong.length ? { ...outcome, pending: wrong } : { ...outcome, closing: 'author_conflict', conflict };
    }
    // A case a dispatch held but the run did not reach has its named exit already: the case before it, then going up again.
    const unexecuted = outcome.not_executed?.at(-1);
    if (unexecuted) return { ...outcome, pending: [`${unexecuted.reason}；${unexecuted.next_action}`] };
    return { ...outcome, pending: ['没有取得可核验的计划结论或具名缺失事实出口'] };
  });
  return { cases: closed, problems: [] };
}

const MISSING_SHOWN = 240;
/** The closing of a case as one line: what it is and the fact it rests on. */
export function closingLine(outcome: CaseOutcome): string | null {
  if (outcome.closing === 'authoring_failure' && outcome.missing?.kind === 'repair_exhausted') {
    const readable = publicWords(outcome.missing.missing);
    const said = readable.length > MISSING_SHOWN ? `${readable.slice(0, MISSING_SHOWN)}…` : readable;
    return `${CLOSING.authoring_failure}：它的计划已交给 Hub，修正轮次用完也没有被脚本合并接受${said ? `（Hub 核对结果摘要：${said}）` : ''}，没有上机；结论仅限本运行记录的内容和核验次数，不能据此确认原因在编写模型。下面“怎么判断的”是模型自述，不是定下结论的依据。`;
  }
  if (outcome.closing === 'authoring_failure') {
    const dropped = outcome.history.filter((h) => h.audit).length;
    return `${CLOSING.authoring_failure}：已核验 ${outcome.rounds} 份不同内容，所记录的核验均未通过${dropped ? `（其中 ${dropped} 次上机运行器报通过，通过复核改记无判定，按规则算没通过）` : ''}，未取得已核验的缺陷候选；结论仅限这些尝试，原因仍待归属；下面“怎么判断的”是模型自述，不是定下结论的依据。`;
  }
  if (outcome.closing === 'device_defect') return `${CLOSING.device_defect}：作者期望原文和设备原话已逐字核对，只形成待仲裁的缺陷候选，不是已确认的产品缺陷。`;
  if (outcome.closing === 'author_conflict') {
    const ran = outcome.history.length ? `它已上机 ${outcome.history.length} 次${outcome.rounds === undefined ? '' : `（已核验 ${outcome.rounds} 份不同内容）`}` : '它没有上机';
    return `${CLOSING.author_conflict}：模型判断作者的步骤要的取值或写法，在产品自己的手册说明里被排除了。作者原句和手册原句已逐字核对（见下），工具只核了这两段原文确实存在，没有核它们是否真的对不上，也没有判谁对：是按手册改作者的步骤，还是作者就要照原样测，由作者或用户裁定。${ran}，裁定前不再为它上机，也不为凑满 ${MAX_ROUNDS} 轮再跑一卷。下面“怎么判断的”是模型自述，不是裁定。`;
  }
  if (outcome.closing === 'missing_fact' && outcome.missing) {
    const readable = publicWords(outcome.missing.missing);
    const said = readable.length > MISSING_SHOWN ? `${readable.slice(0, MISSING_SHOWN)}…` : readable;
    return `${CLOSING.missing_fact}：它的计划已交给 Hub，Hub 判它缺少事实并点名了补证请求${said ? `（Hub 核对结果摘要：${said}）` : ''}；补齐前不生成工作簿、不上机。下面“怎么判断的”是模型自述。`;
  }
  return null;
}

export const terminalLabel = (terminal: string): string => terminal === 'pass' ? '通过' : terminal === 'fail' ? '未通过' : '无结论';
function observation(h: CaseOutcome['history'][number]): string {
  const terminal = h.report_check?.mapped_terminal ?? h.reported_terminal ?? h.terminal;
  // A result the Hub did not take up is said as that: what the runner reported, and that it does not count.
  if (h.terminal !== 'no_verdict') return terminalLabel(terminal);
  return terminal === 'pass' ? '运行器报通过，这次结果没有被采用' : terminal === 'fail' ? '运行器报未通过，这次结果没有被采用' : '没有得出结论';
}
export function timeline(outcome: CaseOutcome, excluded: boolean): string {
  // The dispatches that held the case without reaching it are listed in their place, as what they are: not an observation.
  const events = [
    ...outcome.history.map(h => ({ ordinal: h.ordinal, text: `第 ${h.ordinal} 次上机验证：${observation(h)}${h.audit ? `（设备输出有执行失败原话“${h.audit.line}”，自动化用例没有检查这一行）` : ''}` })),
    ...(outcome.not_executed ?? []).map(n => ({ ordinal: n.ordinal, text: `第 ${n.ordinal} 次未执行：${publicWords(n.reason)}` })),
  ].sort((a, b) => a.ordinal - b.ordinal);
  if (!events.length) return excluded ? '未做上机验证，这条原始用例未完成脚本编写。' : '未做上机验证。';
  return events.map(event => event.text).join('；') + '。';
}

export interface OutOfScopeCase { autoid: string; title: string }
export interface ScopeSummary { words: string; cases: string[]; outOfScope: OutOfScopeCase[]; totalCases: number }

/** A checkpoint the model chose itself for an expectation whose author wrote no literal: no independent review, the device run decides. */
export interface ModelCheckpoint { expectation: string; literal?: string; count?: number; rationale: string }
/**
 * The checkpoints one item's plan result records as the model's own judgments in the expected_grounded check: the typed criteria
 * of a block plan that no review stood behind (`model_criteria`) and the model_judgment expectations of a flat plan
 * (`model_expectations`). They are read from the Hub's record of that check, never inferred from prose.
 */
export function modelCheckpointsOf(result: unknown, id: string): ModelCheckpoint[] {
  if (!isRecord(result) || !isRecord(result.partitions)) return [];
  const found = new Map<string, ModelCheckpoint>();
  for (const entries of Object.values(result.partitions)) for (const entry of Array.isArray(entries) ? entries : []) {
    if (!isRecord(entry) || entry.item !== id || !Array.isArray(entry.requirements)) continue;
    for (const requirement of entry.requirements) {
      if (!isRecord(requirement) || requirement.requirement !== 'expected_grounded' || !Array.isArray(requirement.claims)) continue;
      for (const claim of requirement.claims) {
        const data = isRecord(claim) && isRecord(claim.statement) && claim.statement.verdict === 'support' && isRecord(claim.statement.data) ? claim.statement.data : null;
        if (!data) continue;
        for (const row of [...(Array.isArray(data.model_criteria) ? data.model_criteria : []), ...(Array.isArray(data.model_expectations) ? data.model_expectations : [])]) {
          // an absence check keeps the author's own words (or a name configured earlier), whatever else it declares: not a checkpoint of the model's
          if (!isRecord(row) || row.op === 'not_found' || !isRecord(row.quote) || typeof row.quote.text !== 'string' || typeof row.rationale !== 'string') continue;
          const literal = typeof row.literal === 'string' ? row.literal : typeof row.text === 'string' ? row.text : undefined;
          const checkpoint: ModelCheckpoint = { expectation: row.quote.text, ...(literal !== undefined ? { literal } : {}), ...(typeof row.count === 'number' && Number.isSafeInteger(row.count) ? { count: row.count } : {}), rationale: row.rationale };
          found.set(JSON.stringify(checkpoint), checkpoint);
        }
      }
    }
  }
  return [...found.values()];
}
export interface ReportInput {
  name: string; generatedAt: string; build: string | null;
  assembly: Assembly; notes: Notes; originals: Record<string, Original>; excluded: string[];
  artifacts?: string[];
  files: { pass: { sha256: string } | null; unsuccessful: { sha256: string } | null };
  /** For the long report: the tail of each case's last device log, or why it is not quoted. */
  logs: Record<string, { reference: string; job: string; text: string | null; withheld?: string }>;
  /** The pass review: how many markers the contracts declared (null: none declared), passes read, turned into no verdict, and passes with no device words saved. */
  passAudit?: { markers: number | null; read: number; downgraded: number; wordless: number };
  placedLast?: { pass: MovedCase[]; unsuccessful: MovedCase[] };
  scope?: ScopeSummary;
  /** Verbatim scoped user decisions from the working card; never used to infer a new closing or scope. */
  userRulings?:Record<string,Array<{source:string;target:string;ruling:string}>>;
  /** verification runs that never reached the bed. */
  unsent?: Unsent[];
  /** Per case, the checkpoints the model wrote itself (read from the Hub's check record by modelCheckpointsOf). */
  checkpoints?: Record<string, ModelCheckpoint[]>;
}
const title = (input: ReportInput, autoid: string) => input.originals[autoid]?.title || '标题未知';
export function closingCounts(cases: CaseOutcome[]): string {
  return cases.filter((outcome) => outcome.closing).map((outcome) => `原始用例 ${outcome.autoid}，原因${reasonOf(outcome)}。`).join('');
}
const reasonOf = (outcome: CaseOutcome): string => {
  if(outcome.closing==='author_conflict')return labelOf('attribution','author_input');
  const codes: unknown[] = [...(outcome.basis?.attributions ?? []), ...(outcome.missing?.attributions ?? [])];
  if (!codes.length) codes.push('unattributed');
  return [...new Set(codes)].filter(isAttribution).map(code => labelOf('attribution', code)).join('、');
};
/** Historical exit fields are displayed only when actually recorded, never filled from a role or a default deadline. */
function recordedNext(outcome: CaseOutcome): string[] {
  const exits = [...(outcome.basis?.gaps ?? []).map(gap => gap.exit), outcome.missing?.exit, ...(outcome.missing?.gaps ?? []).map(gap => gap.exit)];
  const texts = exits.flatMap(exit => {
    if (!isRecord(exit) || !isExitAction(exit.action) || typeof exit.due !== 'string' || !Number.isFinite(Date.parse(exit.due)) || !isRecord(exit.audience)) return [];
    if (exit.action === 'request' ? typeof exit.request_kind !== 'string' || !exit.request_kind.trim() || exit.audience.hub === true : exit.audience.hub !== true || exit.request_kind !== undefined) return [];
    const who = exit.audience.hub === true ? 'Hub' : typeof exit.audience.user === 'string' && exit.audience.user.trim() ? exit.request_kind === 'disposition' ? '测试环境管理员' : '使用者' : isRecord(exit.audience.external) && typeof exit.audience.external.identity === 'string' && typeof exit.audience.external.mapping === 'string' ? '指定的外部负责人' : null;
    return who ? [`由${who}${exit.action === 'request' ? '处理具名请求' : labelOf('exit_action', exit.action)}，期限 ${localMinute(new Date(exit.due))}`] : [];
  });
  return [...new Set(texts)];
}
/** One sentence for a case whose plan holds checkpoints the model wrote itself: its judgment, unconfirmed, decided by the device run. */
const checkpointNote = (input: ReportInput, outcome: CaseOutcome): string => {
  const count = input.checkpoints?.[outcome.autoid]?.length ?? 0;
  return count ? `其中 ${count} 项期望在原始用例中没有给出具体取值，检查点由模型拟定，未经独立复核；上机验证的结果只说明这些检查点是否命中（逐项见交付报告）。` : '';
};
/**
 * One sentence a case, as the reference engine's closing card gives one line to each case that needs attention: a case that
 * succeeded says so; one that did not says what happened and why, as specifically as the records hold it, and in the report
 * what comes next. 'cause' is the form of the closing reply: what happened and why, nothing else.
 */
export function caseConclusion(input: ReportInput, outcome: CaseOutcome, detail: 'full' | 'cause' = 'full'): string {
  const { what, why, next } = caseParts(input, outcome);
  const said = `原始用例 ${outcome.autoid} ${title(input, outcome.autoid)}：${what}。${why ? `${why}。` : ''}`;
  return detail === 'cause' ? said : `${said}${next ? `下一步：${next}。` : ''}${checkpointNote(input, outcome)}`;
}
const shown = (checkpoint: ModelCheckpoint): string => checkpoint.literal === undefined ? '两次捕获的设备输出相互比较' : `「${publicWords(checkpoint.literal)}」${checkpoint.count === undefined ? '' : `出现 ${checkpoint.count} 次`}`;
const CHECKPOINT_HEAD = '模型拟定的检查点：原始用例的这些期望没有给出具体取值，检查点由模型拟定，是模型的判断，未经独立复核；上机验证的结果只说明这些检查点是否命中，不说明期望已被确认。';
const checkpointItems = (input: ReportInput, outcome: CaseOutcome): string[] => (input.checkpoints?.[outcome.autoid] ?? []).map((checkpoint) => `- 期望「${publicWords(checkpoint.expectation)}」：检查点${shown(checkpoint)}。模型的理由：${publicWords(checkpoint.rationale)}`);
/** The report lists each such checkpoint with the author's sentence and the model's reason. */
function checkpointLines(input: ReportInput, outcome: CaseOutcome): string[] {
  const items = checkpointItems(input, outcome);
  return items.length ? ['', CHECKPOINT_HEAD, ...items] : [];
}
const QUOTE_SHOWN = 120, CAUSE_SHOWN = 160;
const clip = (text: string, max: number): string => { const flat = text.replace(/\s+/gu, ' ').trim(); return flat.length > max ? `${flat.slice(0, max)}…` : flat; };
const UNATTRIBUTED = labelOf('attribution', 'unattributed');
/**
 * Why a case did not succeed, as specifically as the records say it. The cause the Hub's own records name comes first. The two
 * quotations of a conflict or of a candidate were checked word for word and are given as they stand. What the model says of
 * the cause (its one sentence, else the start of its explanation) is always named as the model's: it never stands in for a
 * cause the records name, and never reads as one when they name none.
 */
function whyOf(input: ReportInput, outcome: CaseOutcome, missing: string[]): string {
  const label = reasonOf(outcome), named = label !== UNATTRIBUTED;
  const lacking = missing.length ? missing.map(publicWords).join('；') : '';
  const note = input.notes?.cases?.[outcome.autoid];
  const conflict = outcome.conflict ?? note?.author_conflict, candidate = note?.defect_candidate;
  const quoted = outcome.closing === 'author_conflict' && conflict ? `作者写“${clip(publicWords(conflict.author), QUOTE_SHOWN)}”，手册写“${clip(publicWords(conflict.manual), QUOTE_SHOWN)}”`
    : outcome.closing === 'device_defect' && candidate ? `期望“${clip(publicWords(candidate.expected), QUOTE_SHOWN)}”，设备实际输出“${clip(publicWords(candidate.actual), QUOTE_SHOWN)}”` : null;
  if (quoted) return `原因${named ? `（${label}）` : ''}：${quoted}${lacking ? `。缺少：${lacking}` : ''}`;
  const said = !note || note.absent ? null : note.cause ? clip(publicWords(note.cause), CAUSE_SHOWN) : reportableProse(note.judged) ? clip(reportStatement(note.judged), CAUSE_SHOWN) : null;
  if (!said) return `原因：${label}${lacking ? `，缺少：${lacking}` : ''}`;
  return named ? `原因：${label}${lacking ? `，缺少：${lacking}` : ''}。模型的分析：${said}` : `原因（模型的分析）：${said}${lacking ? `。缺少：${lacking}` : ''}`;
}
function caseParts(input: ReportInput, outcome: CaseOutcome): { what: string; why?: string; next?: string } {
  const exits = recordedNext(outcome);
  const observed = outcome.history.at(-1);
  const unsentFacts = (input.unsent ?? []).filter(u => u.items.includes(outcome.autoid)).flatMap(u => reportFacts(u));
  if (!outcome.closing && !outcome.history.length && unsentFacts.length) return { what: '没有发到设备，无结论', why: `原因：${[...new Set(unsentFacts.map(f => publicWords(f.fact)))].join('；')}`, next: [...new Set(unsentFacts.map(f => publicWords(f.next_action)))].join('；') };
  // The run stopped in a case before it: the case did not run, and the reason and the next step are the program's own.
  const unexecuted = outcome.not_executed?.at(-1);
  if (!outcome.closing && !outcome.history.length && unexecuted) return { what: '没有在设备上执行，无结论', why: `原因：${publicWords(unexecuted.reason)}`, next: publicWords(unexecuted.next_action) };

  const sourceMissing = [...new Set([...(outcome.basis?.gaps ?? []).flatMap(gap => gap.missing ? [gap.missing] : []), ...(observed?.missing_facts?.length ? ['设备输出的完整性前提尚未核验'] : observed?.missing_fact ? [observed.missing_fact] : [])])];
  if (outcome.pending?.length) return { what: `${observed ? `上机 ${outcome.history.length} 次，最后一次${observation(observed)}` : '没有上机'}，尚不能交付`, why: whyOf(input, outcome, [...new Set([...sourceMissing, ...outcome.pending])]), next: `${exits.length ? exits.join('；') : observed?.missing_facts?.length ? '由测试环境管理员补齐设备输出完整性所需事实后重评' : (observed?.next_action ? publicWords(observed.next_action) : undefined) ?? '由模型将本条计划交给 Hub 取得具名缺失事实；若作者步骤与手册冲突，补齐两段逐字引文交使用者裁定'}；可重入，不表示必须停止编写` };
  if (outcome.status === 'delivered') return { what: '上机验证通过' };
  const model = outcome.closing === 'author_conflict' || outcome.closing === 'device_defect';
  // What was tried, counted from the records only: it says nothing of whose fault the failures are.
  const versions = outcome.rounds === undefined ? '' : `、写过 ${outcome.rounds} 版自动化用例`;
  const attempts = !outcome.history.length ? `自动化用例没有通过脚本合并的核对${versions ? `（${versions.slice(1)}）` : ''}，没有上机`
    : `上机 ${outcome.history.length} 次${versions}，${outcome.history.every((h) => h.terminal === 'fail') ? '都没有通过' : '没有得到可采用的通过结论'}`;
  const status = model || (outcome.closing === 'authoring_failure' && observed?.terminal === 'fail') ? '未确认' : outcome.closing === 'missing_fact' || outcome.status === 'unsettled' || outcome.status === 'unrun' ? '未知' : '未确认';
  const conclusion = outcome.closing === 'author_conflict' ? '原始用例与手册冲突' : outcome.closing === 'device_defect' ? '原始用例的期望与设备输出不一致' : outcome.closing === 'authoring_failure' ? attempts : outcome.closing === 'missing_fact' ? '缺少脚本编写所需的资料' : outcome.status === 'failed' ? '上机验证未通过' : '上机验证尚无结论';
  // Who concluded it and how far it holds, in the reader's words: a model's conclusion is named as one, a conclusion nobody could reach as none.
  const qualified = model ? '（模型的判断，未经确认）' : status === '未知' && outcome.closing && outcome.closing !== 'authoring_failure' ? (outcome.history.length ? '，无结论' : '，没有上机') : '';
  const ran = model && outcome.history.length ? `上机 ${outcome.history.length} 次，` : '';
  const next = outcome.closing==='author_conflict'&&input.userRulings?.[outcome.autoid]?.length ? '等作者裁定原始用例' : exits.length ? exits.join('；') : observed?.missing_facts?.length ? '由测试环境管理员补齐设备输出完整性所需事实后重评' : (observed?.next_action ? publicWords(observed.next_action) : undefined) ?? (model ? !outcome.history.length ? '由作者或使用者根据已核对的原始用例与手册原句裁定' : '由使用者核对原始用例、手册和设备输出后裁定' : '尚缺具名出口材料，核对原运行的请求记录后重评；模型建议单列为未确认');
  return { what: `${ran}${conclusion}${qualified}`, why: whyOf(input, outcome, sourceMissing), next };
}

/**
 * The result in one line, as the reference engine's report opens with one: how many cases the document holds, how many became
 * automated cases that passed on the device as one workbook, how many did not.
 */
export function resultLine(input: ReportInput): string {
  const cases = input.assembly.totals?.cases ?? input.assembly.cases.length, succeeded = input.assembly.totals?.delivered ?? 0;
  const counts = `生成成功 ${succeeded} 条，失败 ${cases - succeeded} 条`;
  return input.scope
    ? `原始脑图共 ${input.scope.totalCases} 条用例，本次范围 ${cases} 条：${counts}；其余 ${input.scope.outOfScope.length} 条不在本次范围内。`
    : `原始脑图共 ${cases} 条用例：${counts}。`;
}
function head(input: ReportInput): string[] {
  const { pass, unsuccessful } = input.assembly;
  const lines = [
    resultLine(input),
    ...(input.scope ? [`本次范围：${input.scope.words}`] : []),
    pass && input.files.pass ? `自动化用例 Excel case.xlsx：${pass.items.length} 条原始用例，已整卷上机验证，全部通过。` : '没有整卷上机验证通过的自动化用例 Excel。',
    unsuccessful && input.files.unsuccessful ? `自动化用例 Excel unsuccessful_cases.xlsx：${unsuccessful.items.length} 条未通过或无结论的原始用例，各用最后一次写好的自动化用例；这些写法是否上过机见逐条记录，没有整卷上机验证。` : '没有其他自动化用例 Excel。',
  ];
  if (input.build) lines.push(`构建 ${input.build}。`);
  // a verification run that never reached the bed is told once at the head, with the Hub's own reason and named next step.
  for (const u of input.unsent ?? []) lines.push(`另有一次上机验证没有发到设备，不算一次上机验证（涉及 ${u.items.length} 条原始用例）：${reportFacts(u).length ? [...new Set(reportFacts(u).map((m) => publicWords(m.fact)))].join('；') : '原因缺少可读取的记录'}。下一步：${reportFacts(u).length ? [...new Set(reportFacts(u).map((m) => publicWords(m.next_action)))].join('；') : publicWords(u.next_action ?? '联系测试环境管理员核对未发出的原因')}。`);
  for (const moved of [input.placedLast?.pass, input.placedLast?.unsuccessful]) if (moved?.length) lines.push(movedText(moved, new Map(moved.map((row) => [row.autoid, input.originals[row.autoid]?.title ?? ''] as const))).replace(/决定者程序。$/u, '')); // the claim's own sentence names its producer; the report does not
  const audit = input.passAudit;
  if (audit?.markers === null && input.assembly.cases.some(c => c.history.length)) lines.push('设备输出尚未复核，无结论：执行器规则没有说明哪些设备输出表示执行失败。下一步由使用者补齐执行器规则，再核对设备输出。');
  else if (audit?.downgraded || audit?.wordless) lines.push(`核对设备输出后，${audit.downgraded} 条原始用例的设备输出有执行失败原话、自动化用例没有检查到，无结论；${audit.wordless} 条缺少设备输出，无结论。下一步由编写模型补齐检查或由使用者补齐设备输出。`);
  return lines;
}
function section(input: ReportInput, outcome: CaseOutcome, level = '##'): string[] {
  const note = input.notes.cases[outcome.autoid];
  const prose = (text: string): string => (reportableProse(text) ? reportStatement(text) : '模型说明含内部引用，尚未形成供使用者阅读的说明');
  const fence = (text: string) => ['```', text.replace(/```/g, '`​``'), '```'];
  const source = input.assembly.unsuccessful?.sources[outcome.autoid];
  const executed = source?.run ? outcome.history.find(h => h.run === source.run) : undefined;
  const unexecuted = source?.run ? outcome.not_executed?.find(n => n.run === source.run) : undefined;
  const candidate = note.defect_candidate;
  const conflict = outcome.conflict ?? note.author_conflict;
  const rulings=outcome.closing==='author_conflict'?input.userRulings?.[outcome.autoid]??[]:[];
  return [
    `${level} 原始用例 ${outcome.autoid} ${title(input, outcome.autoid)}`,
    caseConclusion(input, outcome),
    ...checkpointLines(input, outcome),
    '', `**发生了什么**：${timeline(outcome, input.excluded.includes(outcome.autoid))}`,
    ...rulings.flatMap(row=>['','**使用者已记录的决定（卡片原文）**',...(reportableProse(row.ruling)?fence(row.ruling):['决定原文含内部引用，完整内容见机器资料'])]),
    ...(input.assembly.unsuccessful?.sources[outcome.autoid] ? ['', executed ? `本卷这条写法已在第 ${executed.ordinal} 次上机验证中执行。` : unexecuted ? `本卷采用的这份写法在第 ${unexecuted.ordinal} 次上机验证中没有在设备上执行${outcome.history.length ? '；上面的记录来自较早一次实际到设备的上机验证' : '，还没有设备输出'}。` : '本卷采用最后一次写好的自动化用例；这份写法尚未发到设备，上面的记录来自较早一次实际到设备的上机验证。'] : []),
    ...(input.unsent ?? []).filter((u) => outcome.history.length > 0 && u.items.includes(outcome.autoid)).flatMap((u) => ['', `另有一次上机验证没有发到设备，不算一次上机验证：${reportFacts(u).length ? [...new Set(reportFacts(u).map((m) => publicWords(m.fact)))].join('；') : '原因缺少可读取的记录'}。下一步：${reportFacts(u).length ? [...new Set(reportFacts(u).map((m) => publicWords(m.next_action)))].join('；') : publicWords(u.next_action ?? '联系测试环境管理员核对未发出的原因')}。`]),
    ...(note.judged ? ['', note.absent ? '尚未提供模型说明。' : `**怎么判断的**（模型的失败分析，未经确认）：${prose(note.judged)}`] : []),
    ...(outcome.missing?.missing ? ['', `**核对结果摘要**：${publicWords(outcome.missing.missing)}`] : []),
    ...(note.evidence && !outcome.history.length ? ['', '**模型给出的依据（没有设备输出，未核对）**。出处保留在机器资料中。'] : note.evidence ? ['', outcome.evidence_unverified ? '**模型提出的设备输出**，逐字核对未通过，不能作核验依据。' : '**证据，设备输出**，已按照规则核对设备输出。', ...fence(note.evidence)] : []),
    ...(note.attribution ? ['', `模型给出的原因（未经确认）：${labelOf('attribution', note.attribution)}。`] : []),
    ...(candidate ? ['', `模型提出的复现步骤（未确认） ${candidate.repro}`, '', outcome.closing === 'device_defect' ? '原始用例原句，已逐字核对' : '模型提出的原始用例原句，核对未通过', ...fence(candidate.expected), '', outcome.closing === 'device_defect' ? '设备输出，已逐字核对' : '模型提出的设备输出，核对未通过', ...fence(candidate.actual)] : []),
    ...(conflict ? ['', outcome.closing === 'author_conflict' ? '**证据，原始用例原句**，已按照规则核对原文。' : '**模型提出的原始用例原句**，未取得完整的逐字核对依据。', ...fence(conflict.author), '', outcome.closing === 'author_conflict' ? `**证据，手册原话**，构建 ${input.build ?? '未知'}，已按照规则核对原文。` : `**模型提出的手册原话**，构建 ${input.build ?? '未知'}，未取得完整的逐字核对依据。`, ...fence(conflict.manual)] : []),
    ...(note.remedy && !note.absent ? ['', `**模型建议的下一步**：${prose(note.remedy)}`] : []),
  ];
}
/** Only protocol identity syntax is checked here; model prose never decides a case status. */
const publicWords = (text: string): string => reportStatement(text).replace(/(?:run|usr|exe)_[a-z0-9]{26}\b|(?:src|rec):[a-f0-9]{64}|tree:[a-f0-9]{64}(?:\/[^\s，；。]+)?/gu, '（对应记录见机器资料）');
export const reportableProse = (text: string): boolean => !/(?:run|usr|exe)_[a-z0-9]{26}\b|(?:src|rec):[a-f0-9]{64}|tree:[a-f0-9]{64}/u.test(text);

export function closingHints(cases: CaseOutcome[], notes: Notes, unsent: readonly Unsent[] = []): Array<{ autoid: string; missing: string; next_action: string; legal_form: string }> {
  return cases.flatMap(outcome => {
    const note = notes.cases[outcome.autoid];
    const hints: Array<{ autoid: string; missing: string; next_action: string; legal_form: string }> = [];
    if (outcome.status === 'unrun' && !outcome.closing && !outcome.not_executed?.length && !unsent.some(u => u.items.includes(outcome.autoid) && reportFacts(u).length)) hints.push({ autoid: outcome.autoid, missing: '本条没有可核验的计划结论或 Hub 具名缺失事实，也没有通过逐字核对的作者冲突', next_action: '先将本条计划交 Hub 取得具名请求；若原始用例与手册冲突，按示例填写 author_conflict 后重跑', legal_form: JSON.stringify({ cases: { [outcome.autoid]: { judged: '供使用者阅读的说明', remedy: '由谁补什么', author_conflict: { author: '<本条原始用例连续原句>', manual: '<同构建手册连续原句>', reference: '<锁定手册引用>' } } } }) });
    if (!outcome.history.length && note?.round !== undefined) hints.push({ autoid: outcome.autoid, missing: '本条没有到过设备，不能声明上机轮次', next_action: '删除本条的 round；保留作者冲突或先向 Hub 提交本条计划取得具名出口', legal_form: JSON.stringify({ judged: '未上机，说明已核对的事实', remedy: '由谁补什么' }) });
    if (note?.author_conflict && outcome.closing !== 'author_conflict' && !outcome.missing) hints.push({ autoid: outcome.autoid, missing: '作者冲突声明未取得完整的逐字核对依据', next_action: '按 pending 指出的问题改正原始用例引文、手册原句和锁定引用后重跑', legal_form: JSON.stringify({ author_conflict: { author: '<本条原始用例连续原句>', manual: '<锁定手册连续原句>', reference: '<锁定手册引用>' } }) });
    if (note?.defect_candidate && outcome.closing !== 'device_defect' && !outcome.missing) hints.push({ autoid: outcome.autoid, missing: '设备缺陷候选未取得完整的逐字核对依据', next_action: '按 pending 改正作者期望和设备原话；候选只保留未确认状态', legal_form: JSON.stringify({ defect_candidate: { repro: '<复现步骤>', expected: '<作者期望原句>', actual: '<同一个设备文件内的连续原句>' } }) });
    if (outcome.evidence_unverified) hints.push({ autoid: outcome.autoid, missing: '设备引文未通过逐字核对', next_action: '只选最近一次到过设备的一个文件，连续复制一段原句，不拼接不同文件', legal_form: JSON.stringify({ evidence: '<同一个设备文件内连续的一段原句>' }) });
    if (note && (!reportableProse(note.judged) || !reportableProse(note.remedy))) hints.push({ autoid: outcome.autoid, missing: '使用者说明含内部引用', next_action: 'judged/remedy 改写为人能阅读的解释；运行号、来源引用和文件路径留在机器资料中', legal_form: JSON.stringify({ judged: '说明现象、判断及其限制', remedy: '说明由谁补齐什么' }) });
    return hints;
  });
}

export const REPORT_FILES = { report: 'delivery_report.md', unsuccessful: 'unsuccessful_cases.md', summary: 'delivery.json' } as const;

export function deliveryReport(input: ReportInput): string {
  const lines = [`# 交付报告 — ${input.name}`, `> 生成 ${input.generatedAt}`, '', ...head(input)];
  const succeeded = input.assembly.cases.filter((outcome) => outcome.status === 'delivered'), others = input.assembly.cases.filter((outcome) => outcome.status !== 'delivered');
  if (others.length) {
    lines.push('', `## 失败的用例（${others.length} 条）`);
    for (const outcome of others) lines.push('', ...section(input, outcome, '###'));
  }
  if (succeeded.length) {
    lines.push('', `## 生成成功的用例（${succeeded.length} 条）`, '');
    for (const outcome of succeeded) {
      const drafted = input.checkpoints?.[outcome.autoid]?.length ?? 0;
      lines.push(`- 原始用例 ${outcome.autoid} ${title(input, outcome.autoid)}${drafted ? `（含 ${drafted} 处模型拟定的检查点）` : ''}`);
    }
    const drafted = succeeded.filter((outcome) => input.checkpoints?.[outcome.autoid]?.length);
    if (drafted.length) {
      lines.push('', '## 需要复核的检查点', '', CHECKPOINT_HEAD);
      for (const outcome of drafted) lines.push('', `原始用例 ${outcome.autoid} ${title(input, outcome.autoid)}`, ...checkpointItems(input, outcome));
    }
  }
  if (input.scope && input.scope.outOfScope.length > 0) {
    lines.push('', `## 未纳入本次范围的原始用例（${input.scope.outOfScope.length} 条）`, '', '以下原始用例在开运行时未纳入本次范围，本次未做脚本编写与上机验证。', '');
    for (const omitted of input.scope.outOfScope) {
      lines.push(`- 原始用例 ${omitted.autoid} ${omitted.title || '标题未知'}`);
    }
  }
  const names = input.artifacts ?? [...(input.files.pass ? ['case.xlsx'] : []), ...(input.files.unsuccessful ? ['unsuccessful_cases.xlsx'] : []), ...Object.values(REPORT_FILES)];
  lines.push('', '---', `交付物：${names.join('、')}。`);
  return lines.join('\n') + '\n';
}

const LOG_TAIL = 1500;
export function unsuccessfulReport(input: ReportInput): string {
  const others = input.assembly.cases.filter((c) => c.status !== 'delivered');
  const lines = [`# 原始用例的错误和未知 — ${input.name}`, `> 生成 ${input.generatedAt}`];
  for (const outcome of others) {
    lines.push('', ...section(input, outcome));
    const original = input.originals[outcome.autoid];
    if (original?.lines.length) {
      lines.push('', '**原始用例原句**');
      for (const line of original.lines) lines.push(`- ${line.text}${line.expected.length ? ` → 期望 ${line.expected.join('；')}` : ''}`);
    }
    const log = input.logs[outcome.autoid];
    if (log) {
      if (log.text === null) lines.push('', `**第 ${outcome.history.at(-1)?.ordinal ?? '未知'} 次上机验证的设备输出**。无结论，缺少资料：${log.withheld ?? '没有取得设备输出'}；下一步由使用者补齐设备输出。`);
      else {
        const tail = log.text.length > LOG_TAIL ? log.text.slice(-LOG_TAIL) : log.text;
        lines.push('', `**第 ${outcome.history.at(-1)?.ordinal ?? '未知'} 次上机验证的设备输出**${log.text.length > LOG_TAIL ? `，末尾 ${LOG_TAIL} 字` : ''}`, '```', tail.replace(/```/g, '`​``'), '```');
      }
    }
  }
  return lines.join('\n') + '\n';
}
