// What the end of a compile run hands over, after InfoTest's delivery directory (docs/engine/07_display_contract.md §11.9 of the
// reference engine): a pass volume that was dispatched whole and passed item by item, an unsuccessful volume of the cases that
// have a plan but did not pass, a report with one section per case not delivered (what happened, how it was judged, the fix or
// the trade-off), a longer report for whoever picks those cases up, and a machine summary. Every status and count here comes
// from the jobs' verdicts as the Hub relays them (decision 160), and a failed case closes by the reference engine's rules
// (closeFailed). Model-supplied defect candidates and author conflicts carry quotations checked verbatim.
import { isRecord } from './text.ts';
import { movedText, type MovedCase } from './channels.ts';
import { quoteMatches } from './quote.ts';

export const STATUS = { delivered: '交付', failed: '上机未通过', unsettled: '上机没有结论', unrun: '没有上机' } as const;
export type Status = keyof typeof STATUS;

/** Why a reported pass is not taken as one: the device output it came with and the line in it (see failureLine). */
export interface RowAudit { where: string; line: string }
export interface JobRow { item: string; dynamic_terminal: string; evidence?: { log?: string; sessions?: Record<string, string> }; audit?: RowAudit }
export interface ExportedJob { job: string; verification_run: string; plan_run: string; items: string[]; sha256: string; ended: 'done' | 'unknown' | null; outcome: string; frozen: boolean; result: string | null; device_return: string | null; rows: JobRow[] | null }
/** One dispatch that settled: the run it verified, the plan run it was generated from, the workbook digest and each item's verdict. */
export interface Dispatch { run: string; job: string; plan_run: string; sha256: string; items: string[]; rows: JobRow[] }
/** A product-defect candidate (InfoTest fail_attribution.py defect_candidate): how to reproduce it, the author's expected text and the device's actual words. */
export interface DefectCandidate { repro: string; expected: string; actual: string }
// The model proposes the conflict; quotation checks do not decide who is right.
export interface AuthorConflict { author: string; manual: string; reference: string }
export interface CaseNote { judged: string; remedy: string; round?: number; evidence?: string; defect_candidate?: DefectCandidate; author_conflict?: AuthorConflict }
export interface Notes { round?: number; batch?: string; cases: Record<string, CaseNote> }
/** What the document holds for a case: its title and original lines (steps with their expectations), when known. */
export interface Original { title: string; lines: Array<{ text: string; expected: string[] }> }

const SHA = /^[0-9a-f]{64}$/;
const RUN = /^run_[0-9a-z]{26}$/;
const NOTE_MAX = 4000;
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((v) => typeof v === 'string' && v.length > 0);

/** The Hub's run-jobs@1 answer for `run`, checked for shape; anything else is refused rather than guessed at. */
export function parseRunJobs(value: unknown, run: string): ExportedJob[] {
  if (!isRecord(value) || value.schema !== 'run-jobs@1' || value.run !== run || !Array.isArray(value.jobs)) throw new Error(`Hub 返回的上机验证信息不完整或不属于本次上机验证`);
  return value.jobs.map((job) => {
    if (!isRecord(job) || typeof job.job !== 'string' || !RUN.test(String(job.verification_run)) || !RUN.test(String(job.plan_run)) || !strings(job.items) || !SHA.test(String(job.sha256)) || typeof job.frozen !== 'boolean' || typeof job.outcome !== 'string') throw new Error(`Hub 返回的上机验证信息不完整`);
    if (job.rows !== null && (!Array.isArray(job.rows) || job.rows.some((row) => !isRecord(row) || typeof row.item !== 'string' || typeof row.dynamic_terminal !== 'string'))) throw new Error(`Hub 返回的原始用例结论不完整`);
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
    if (open) throw new Error(`上机验证还没有结束，请等结束后生成交付报告`);
    const frozen = own.find((j) => j.frozen || j.ended === 'unknown');
    if (frozen) throw new Error(`上机验证状态未知，原因还没查清；下一步由使用者联系管理员处理，再生成交付报告`);
    throw new Error(`尚未上机验证，或设备输出缺少逐条结论；--runs 请只选择已结束的上机验证`);
  }
  const rows = job.rows!;
  if (rows.length !== job.items.length || new Set(rows.map((r) => r.item)).size !== rows.length || rows.some((r) => !job.items.includes(r.item))) throw new Error(`设备输出中的结论没有覆盖本次上机验证的全部原始用例`);
  return { run, job: job.job, plan_run: job.plan_run, sha256: job.sha256, items: [...job.items], rows };
}

export interface CaseOutcome { autoid: string; status: Status; history: Array<{ ordinal: number; run: string; job: string; terminal: string; log?: string; sessions?: Record<string, string>; audit?: RowAudit }>; rounds?: number; closing?: Closing; missing?: MissingFact; conflict?: AuthorConflict }
/**
 * What the Hub recorded for a case's own plan in `plan_run`: `requirement` left pending on a data gap with a request (a missing
 * fact), or left without an accepted plan after the repair rounds were used up (repair_exhausted).
 */
export interface MissingFact { kind: 'data_gap' | 'repair_exhausted'; plan_run: string; requirement: string; missing: string }
export interface Assembly {
  cases: CaseOutcome[];
  /** The last dispatch, when every item of it passed: its workbook is the pass volume. */
  pass: Dispatch | null;
  /** The cases of the unsuccessful volume in document order, each with the dispatch of its latest verdict (its plan goes in). */
  unsuccessful: { items: string[]; sources: Record<string, Dispatch> } | null;
  totals: Record<Status, number> & { cases: number };
}

/**
 * Settles every case of the document from the dispatches in the order they ran. The pass volume is the latest dispatch that
 * passed whole after which none of its cases failed; a later dispatch may rerun its cases if they pass again, and may try other
 * cases. As in the reference engine, every case whose latest verdict is a pass goes to the bed in that one volume and passes
 * there item by item: a pass outside it was never run with the volume it would ship in, so the delivery is refused until such a
 * volume is dispatched (run 15 ran fourteen passes together, reran one alone, and that one became the only delivered case).
 */
export function assemble(population: string[], dispatches: Dispatch[]): Assembly {
  if (!population.length || new Set(population).size !== population.length) throw new Error('原始用例清单为空或用例 ID 重复');
  if (!dispatches.length) throw new Error('尚未上机验证；--runs 请至少选择一次自动化用例 Excel 的上机验证');
  if (new Set(dispatches.map((d) => d.run)).size !== dispatches.length) throw new Error('--runs 中重复选择了同一次上机验证');
  for (const d of dispatches) for (const item of d.items) if (!population.includes(item)) throw new Error(`上机验证包含不在这份原始用例清单里的原始用例 ${item}`);
  const passedWhole = (d: Dispatch) => d.rows.length > 0 && d.rows.every((r) => r.dynamic_terminal === 'pass');
  const latestOf = (item: string) => [...dispatches].reverse().flatMap((d) => d.rows.filter((r) => r.item === item))[0]?.dynamic_terminal;
  const lastPassed = population.filter((item) => latestOf(item) === 'pass');
  const holds = (k: number) => dispatches.slice(k + 1).every((later) => later.rows.every((r) => !dispatches[k].items.includes(r.item) || r.dynamic_terminal === 'pass'));
  const at = dispatches.findLastIndex((d, k) => passedWhole(d) && holds(k));
  const pass = at < 0 ? null : dispatches[at];
  // Every latest pass belongs in the pass volume; without one, or with passes outside it, dispatch the volume that holds them all.
  const outside = pass ? lastPassed.filter((item) => !pass.items.includes(item)) : [];
  if (pass && outside.length) throw new Error(`原始用例 ${outside.join('、')} 最近一次上机验证正确，但不在最近一份全部正确的自动化用例 Excel 里。下一步由编写模型把最近一次上机验证正确的原始用例单独做脚本合并，生成自动化用例 Excel，一起做上机验证后再生成交付报告`);
  if (!pass && lastPassed.length) throw new Error(`尚无一起做上机验证且全部正确的自动化用例 Excel。原始用例 ${lastPassed.join('、')} 最近一次上机验证正确。下一步由编写模型把这些原始用例单独做脚本合并，生成自动化用例 Excel，一起做上机验证后再生成交付报告`);
  const delivered = new Set(pass?.items ?? []);
  const cases: CaseOutcome[] = population.map((autoid) => {
    const history = dispatches.flatMap((d, k) => d.rows.filter((r) => r.item === autoid).map((r) => ({ ordinal: k + 1, run: d.run, job: d.job, terminal: r.dynamic_terminal, ...(r.evidence?.log ? { log: r.evidence.log } : {}), ...(r.evidence?.sessions ? { sessions: r.evidence.sessions } : {}), ...(r.audit ? { audit: r.audit } : {}) })));
    if (delivered.has(autoid)) return { autoid, status: 'delivered' as const, history };
    const latest = history.at(-1);
    if (!latest) return { autoid, status: 'unrun' as const, history };
    return { autoid, status: latest.terminal === 'fail' ? 'failed' as const : 'unsettled' as const, history };
  });
  const unpassed = cases.filter((c) => c.status === 'failed' || c.status === 'unsettled').map((c) => c.autoid);
  let unsuccessful: Assembly['unsuccessful'] = null;
  if (unpassed.length) {
    const sources: Record<string, Dispatch> = {};
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
 * part of it. Returns the first such line, or null.
 */
export function failureLine(texts: Readonly<Record<string, string>>, markers: readonly string[], assertions: readonly string[]): RowAudit | null {
  for (const [where, text] of Object.entries(texts)) for (const raw of text.replace(/\r/g, '').split('\n')) {
    const line = raw.trim();
    if (!line || !markers.some((marker) => line.includes(marker))) continue;
    if (assertions.some((assertion) => assertion.length > 0 && line.includes(assertion))) continue;
    return { where, line };
  }
  return null;
}
/** The dispatches with each audited pass, keyed run and item, turned into no verdict with the line that did it. */
export function auditPasses(dispatches: readonly Dispatch[], hits: ReadonlyMap<string, RowAudit>): Dispatch[] {
  return dispatches.map((d) => ({ ...d, rows: d.rows.map((r) => { const hit = r.dynamic_terminal === 'pass' ? hits.get(auditKey(d.run, r.item)) : undefined; return hit ? { ...r, dynamic_terminal: 'no_verdict', audit: hit } : r; }) }));
}
export const auditKey = (run: string, item: string): string => `${run}\u0000${item}`;

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
const CLI_ERROR_LINE = /^(?:Error:\s*\S|Failed to\s+\S|%\s*(?:Invalid|Error|Unknown|Unrecognized)\b)/i;
/**
 * The commands a session shows the device refusing to execute. A line that begins with a prompt is a command typed at it and
 * the lines down to the next such line are the device's reply; a reply that carries one of the execution-failure lines the
 * runner contract declares, or a generic CLI refusal/failure reply when the contract's markers are loaded, is the device's
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
    let markerHit = false, cliErrorAt = -1;
    for (let j = i + 1; j < lines.length && !LEADING_PROMPT.test(lines[j]); j++) {
      const line = lines[j].trim();
      if (!line) continue;
      reply.push(line.length > REPLY_CHARS ? line.slice(0, REPLY_CHARS) + '…' : line);
      if (markers.some((marker) => line.includes(marker))) { markerHit = true; break; }
      if (CLI_ERROR_LINE.test(line)) cliErrorAt = reply.length - 1;
    }
    if (!markerHit && cliErrorAt < 0) continue;
    const trimmedReply = markerHit
      ? reply.slice(-REPLY_LINES)
      : reply.slice(0, reply.length <= REPLY_LINES ? reply.length : Math.min(reply.length, cliErrorAt + 2)).slice(-REPLY_LINES);
    const refusal: ExecutionRefusal = { command, prompt: typed[1], reply: trimmedReply, ...(control < 0 ? {} : { echo_cut: true as const }) };
    const key = JSON.stringify([refusal.command, refusal.prompt, refusal.reply]);
    if (!seen.has(key)) { seen.add(key); found.push(refusal); }
  }
  return found;
}

/** The model's notes: one judged paragraph and one fix-or-trade-off paragraph for exactly the cases not delivered. */
export function readNotes(value: unknown, undelivered: string[]): Notes {
  if (!isRecord(value) || !isRecord(value.cases) || Object.keys(value).some((key) => key !== 'cases' && key !== 'batch' && key !== 'round')) throw new Error('说明文件请按原始用例分别写结论、下一步和设备输出，格式见交付工具说明');
  const parseRound = (v: unknown, where: string): number => {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) throw new Error(`${where} 的轮次（round）须是大于等于 1 的整数`);
    return v;
  };
  const text = (v: unknown, where: string): string => {
    if (typeof v !== 'string' || !v.trim() || v.length > NOTE_MAX || /[\u0000-\u0009\u000b-\u001f\u007f]/.test(v)) throw new Error(`${where} 要是 1 到 ${NOTE_MAX} 字的文字（可换行，不含其他控制字符）`);
    return v.trim();
  };
  const keys = Object.keys(value.cases);
  const missing = undelivered.filter((a) => !keys.includes(a)), extra = keys.filter((a) => !undelivered.includes(a));
  if (missing.length || extra.length) throw new Error(`说明要恰好覆盖没有交付的用例：${missing.length ? `缺 ${missing.join('、')}` : ''}${missing.length && extra.length ? '；' : ''}${extra.length ? `多了 ${extra.join('、')}（交付的用例不写说明）` : ''}`);
  const cases: Record<string, CaseNote> = {};
  for (const autoid of undelivered) {
    const note = value.cases[autoid];
    if (!isRecord(note) || Object.keys(note).some((k) => !['judged', 'remedy', 'round', 'evidence', 'defect_candidate', 'author_conflict'].includes(k))) throw new Error(`用例 ${autoid} 的说明请只写结论、下一步、可选轮次 round、设备输出，以及判断设备问题或原始用例问题所需的原文`);
    const candidate = note.defect_candidate, conflict = note.author_conflict;
    if (candidate !== undefined && (!isRecord(candidate) || Object.keys(candidate).sort().join() !== 'actual,expected,repro')) throw new Error(`用例 ${autoid} 判断设备的问题时，请只写复现步骤、原始用例期望原句和设备输出三项`);
    if (conflict !== undefined && (!isRecord(conflict) || Object.keys(conflict).sort().join() !== 'author,manual,reference')) throw new Error(`用例 ${autoid} 判断原始用例的问题时，请只写原始用例原句、手册原话和对应的手册三项`);
    if (candidate !== undefined && conflict !== undefined) throw new Error(`用例 ${autoid} 不能同时判断为设备的问题和原始用例的问题；手册排除这个取值时请核对原始用例，手册支持这个取值时请核对设备输出`);
    cases[autoid] = {
      judged: text(note.judged, `用例 ${autoid} 的结论`), remedy: text(note.remedy, `用例 ${autoid} 的下一步`),
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
export const CLOSING = { authoring_failure: '模型未找到解决方案', device_defect: '声明与设备行为冲突（待仲裁）', missing_fact: '缺少 Hub 点名的事实（待补齐）', author_conflict: '作者步骤与手册冲突（待作者或用户裁定）' } as const;
export type Closing = keyof typeof CLOSING;

/** The line by which the pass review dropped the case's latest pass, when that is how its last dispatch ended. */
export const droppedPass = (outcome: CaseOutcome): RowAudit | undefined => (outcome.status === 'unsettled' ? outcome.history.at(-1)?.audit : undefined);
/** Whether the closing rules of a failed case apply: its latest verdict is a failure, or a pass the pass review dropped. */
export const reworked = (outcome: CaseOutcome): boolean => outcome.status === 'failed' || droppedPass(outcome) !== undefined;

export interface ConflictGround { authored: Readonly<Record<string, readonly string[]>>; statements: ReadonlyMap<string, string> }
// Quotation width follows the existing author-conflict evidence rule.
const CONFLICT_MIN_QUOTE = 4;
const shownRejections = (refused: readonly SyntaxRejection[]): string => refused.slice(0, 3).map((r) => `“${r.command.length > 80 ? `${r.command.slice(0, 80)}…` : r.command}”${r.prompt ? `（在 ${r.prompt} 下）` : ''}`).join('、');

export function authorConflictProblems(autoid: string, conflict: AuthorConflict, ground: ConflictGround | undefined, deviceTexts: readonly string[]): string[] {
  const refused = deviceTexts.flatMap((text) => syntaxRejections(text));
  if (refused.length) return [`用例 ${autoid} 判断原始用例的问题时，它最后一次上机里设备用 ^ 拒绝了命令 ${shownRejections(refused)}。设备没有接受这条命令的写法，作者的场景没有在设备上实现，够不上作者步骤与手册冲突：请重新判断原因，先修这条命令再做上机验证；最多重交 ${MAX_ROUNDS} 次，仍未核对正确时写明编写模型的问题`];
  const plain = (text: string) => text.replace(/\r/g, '');
  const wrong: string[] = [];
  if (plain(conflict.author).length < CONFLICT_MIN_QUOTE || plain(conflict.manual).length < CONFLICT_MIN_QUOTE) wrong.push(`原始用例原句和手册原话各要逐字引用一整句，至少 ${CONFLICT_MIN_QUOTE} 个字，几个字指不出作者要的是什么、手册排除的是什么`);
  else {
    const words = ground?.authored[autoid];
    if (!words?.length) wrong.push('这条原始用例的原文取不到，请补齐用例重组或脚本编写时的原始用例');
    else if (!words.some((line) => quoteMatches(plain(line), plain(conflict.author)))) wrong.push('原始用例引文不是标题、步骤或期望的原句');
    const statement = ground?.statements.get(conflict.reference);
    if (statement === undefined) wrong.push('所选手册不属于脚本编写时使用的手册和命令树，请使用同一构建的手册和命令树');
    else if (!quoteMatches(plain(statement), plain(conflict.manual))) wrong.push('手册引文不是所选手册的原话');
  }
  return wrong.length ? [`用例 ${autoid} 判断原始用例的问题时，${wrong.join('；')}；逐字复制，不改写、不拼接`] : [];
}

export function lockedStatements(bytes: Uint8Array, run: string, wanted: ReadonlySet<string>): { root: string; statements: Map<string, string> } {
  let head: Record<string, unknown> | null = null, nodes = 0;
  const statements = new Map<string, string>();
  let lines: string[];
  try { lines = new TextDecoder('utf-8', { fatal: true }).decode(bytes).split('\n'); } catch { throw new Error('手册和命令树无法读取'); }
  for (const line of lines) {
    if (line.length === 0) continue;
    let value: unknown;
    try { value = JSON.parse(line); } catch { throw new Error('手册和命令树内容不完整'); }
    if (head === null) {
      if (!isRecord(value) || value.schema !== 'run-knowledge@1' || value.run !== run || typeof value.root !== 'string') throw new Error(`手册和命令树不属于本次脚本编写或内容不完整`);
      head = value; continue;
    }
    if (!isRecord(value) || !Array.isArray(value.entries)) throw new Error('手册和命令树内容不完整');
    nodes++;
    for (const entry of value.entries) if (isRecord(entry) && typeof entry.reference === 'string' && typeof entry.statement === 'string' && wanted.has(entry.reference)) statements.set(entry.reference, entry.statement);
  }
  if (head === null || head.nodes !== nodes) throw new Error(`手册和命令树缺少内容`);
  return { root: head.root as string, statements };
}

/**
 * Closes every case that failed or whose pass the pass review dropped, or says why the delivery cannot be assembled yet.
 * `rounds` holds, per such case, how many distinct plans of it did not pass on the bed (a failure or a dropped pass);
 * `authored` holds expectations; `deviceTexts` holds the last device output; `ground` anchors author-conflict quotations.
 */
export function closeFailed(cases: CaseOutcome[], notes: Notes, rounds: Record<string, number>, authored: Record<string, string[]>, deviceTexts: Record<string, string[]>, ground?: ConflictGround): { cases: CaseOutcome[]; problems: string[] } {
  const problems: string[] = [];
  const plain = (text: string) => text.replace(/\r/g, '');
  const closed = cases.map((outcome) => {
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
        problems.push(`用例 ${outcome.autoid} 判断设备的问题时，它最后一次上机里设备用 ^ 拒绝了命令 ${shownRejections(refused)}。设备没有接受这条命令的写法，作者的场景没有在设备上实现，够不上声明与设备行为冲突：请重新判断原因，先修这条命令再做上机验证；最多重交 ${MAX_ROUNDS} 次，仍未核对正确时写明编写模型的问题`);
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
      problems.push(`用例 ${outcome.autoid} 最近一次上机验证状态未知，设备输出有执行失败原话“${dropped.line.length > 160 ? `${dropped.line.slice(0, 160)}…` : dropped.line}”，自动化用例没有检查这一行。下一步由编写模型检查这行设备输出，或改用不会执行失败的观察，改好自动化用例再一起做上机验证。已重写自动化用例 ${used} 次，最多重交 ${MAX_ROUNDS} 次，同一份自动化用例重新验证不算重写`)
      return outcome;
    }
    problems.push(`用例 ${outcome.autoid} 上机验证有错误，已重写自动化用例 ${used} 次，最多重交 ${MAX_ROUNDS} 次，同一份自动化用例重新验证不算重写。说明里的判断尚未确认：测试环境缺资料或前置条件的说明尚未确认，请按原始用例继续脚本编写；原因还没查清时，请在被测命令前加只读观察；编写模型按设备输出改好自动化用例，再把自动化用例 Excel 一起做上机验证。只有复现步骤、原始用例原句、设备输出均已核对的设备问题，或原始用例和手册原话均已核对的原始用例问题，才能提前结束脚本编写并由使用者决定`);
    return outcome;
  });
  return { cases: closed, problems };
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
  const problems: string[] = [];
  const unresolved: string[] = [];
  const closed = cases.map((outcome) => {
    if (outcome.status !== 'unrun') return outcome;
    const fact = facts[outcome.autoid];
    if (fact) return { ...outcome, closing: fact.kind === 'data_gap' ? 'missing_fact' as const : 'authoring_failure' as const, missing: fact };
    const conflict = notes?.cases[outcome.autoid]?.author_conflict;
    if (conflict) {
      const wrong = authorConflictProblems(outcome.autoid, conflict, ground, []);
      if (wrong.length) { problems.push(...wrong); return outcome; }
      return { ...outcome, closing: 'author_conflict' as const, conflict };
    }
    unresolved.push(outcome.autoid);
    return outcome;
  });
  if (unresolved.length > 0) {
    const maxList = 10;
    const shown = unresolved.slice(0, maxList).join('、');
    const suffix = unresolved.length > maxList
      ? ` 等共 ${unresolved.length} 条用例`
      : unresolved.length > 1
        ? `（共 ${unresolved.length} 条）`
        : '';
    problems.push(
      `不存在：用例 ${shown}${suffix}尚未上机验证，也未查到 Hub 确认缺资料、重交次数用完或原句核对后的原始用例与手册不一致说明。请先按原始用例继续脚本编写与脚本合并，在最多 ${MAX_ROUNDS} 次重交内完成上机验证或补齐确认依据后再组交付`,
    );
  }
  return { cases: closed, problems };
}
const MISSING_SHOWN = 240;
/** The closing of a case as one line: what it is and the fact it rests on. */
export function closingLine(outcome: CaseOutcome): string | null {
  if (outcome.closing === 'authoring_failure' && outcome.missing?.kind === 'repair_exhausted') {
    const said = outcome.missing.missing.length > MISSING_SHOWN ? `${outcome.missing.missing.slice(0, MISSING_SHOWN)}…` : outcome.missing.missing;
    return `${CLOSING.authoring_failure}：它的计划在脚本编写运行 ${outcome.missing.plan_run} 交给 Hub，修正轮次用完也没有被脚本合并接受${said ? `（Hub 原话：${said}）` : ''}，没有上机；按结办规则，编写每次都被提交规则拒绝、拒满轮次的，记为模型未找到解决方案。下面“怎么判断的”是模型自述，不是定下结论的依据。`;
  }
  if (outcome.closing === 'authoring_failure') {
    const dropped = outcome.history.filter((h) => h.audit).length;
    return `${CLOSING.authoring_failure}：编写 ${outcome.rounds} 轮，每一轮上机都没通过${dropped ? `（其中 ${dropped} 次上机运行器报通过，通过复核改记无判定，按规则算没通过）` : ''}，作者内容未改、没有核对得上的缺陷候选；下面“怎么判断的”是模型自述，不是定下结论的依据。`;
  }
  if (outcome.closing === 'device_defect') return `${CLOSING.device_defect}：作者期望原文和设备原话已逐字核对，只形成待仲裁的缺陷候选，不是已确认的产品缺陷。`;
  if (outcome.closing === 'author_conflict') {
    const ran = outcome.history.length ? `它已上机 ${outcome.history.length} 次${outcome.rounds === undefined ? '' : `（编写 ${outcome.rounds} 轮）`}` : '它没有上机';
    return `${CLOSING.author_conflict}：模型判断作者的步骤要的取值或写法，在产品自己的手册说明里被排除了。作者原句和手册原句已逐字核对（见下），工具只核了这两段原文确实存在，没有核它们是否真的对不上，也没有判谁对：是按手册改作者的步骤，还是作者就要照原样测，由作者或用户裁定。${ran}，裁定前不再为它上机，也不为凑满 ${MAX_ROUNDS} 轮再跑一卷。下面“怎么判断的”是模型自述，不是裁定。`;
  }
  if (outcome.closing === 'missing_fact' && outcome.missing) {
    const said = outcome.missing.missing.length > MISSING_SHOWN ? `${outcome.missing.missing.slice(0, MISSING_SHOWN)}…` : outcome.missing.missing;
    return `${CLOSING.missing_fact}：它的计划在计划运行 ${outcome.missing.plan_run} 交给 Hub，Hub 判它缺少事实并点名了补证请求${said ? `（Hub 原话：${said}）` : ''}；补齐前不生成工作簿、不上机。下面“怎么判断的”是模型自述。`;
  }
  return null;
}

export const terminalLabel = (terminal: string): string => terminal === 'pass' ? '正确' : terminal === 'fail' ? '错误' : '未知';
export function timeline(outcome: CaseOutcome, excluded: boolean): string {
  if (!outcome.history.length) return excluded ? '未做上机验证，这条原始用例未完成脚本编写。' : '未做上机验证。';
  return outcome.history.map((h) => `第 ${h.ordinal} 次上机验证${h.audit ? `状态未知，设备输出有执行失败原话“${h.audit.line}”，自动化用例没有检查这一行` : `判断${terminalLabel(h.terminal)}`}`).join('；') + '。';
}

export interface OutOfScopeCase { autoid: string; title: string }
export interface ScopeSummary { words: string; cases: string[]; outOfScope: OutOfScopeCase[]; totalCases: number }

export interface ReportInput {
  name: string; generatedAt: string; build: string | null;
  assembly: Assembly; notes: Notes; originals: Record<string, Original>; excluded: string[];
  files: { pass: { sha256: string } | null; unsuccessful: { sha256: string } | null };
  /** For the long report: the tail of each case's last device log, or why it is not quoted. */
  logs: Record<string, { reference: string; job: string; text: string | null; withheld?: string }>;
  /** The pass review: how many markers the contracts declared (null: none declared), passes read, turned into no verdict, and passes with no device words saved. */
  passAudit?: { markers: number | null; read: number; downgraded: number; wordless: number };
  placedLast?: { pass: MovedCase[]; unsuccessful: MovedCase[] };
  scope?: ScopeSummary;
}
const title = (input: ReportInput, autoid: string) => input.originals[autoid]?.title || '标题未知';
export function closingCounts(cases: CaseOutcome[]): string {
  return cases.filter((outcome) => outcome.closing).map((outcome) => `原始用例 ${outcome.autoid}，原因${reasonOf(outcome)}。`).join('');
}
const reasonOf = (outcome: CaseOutcome): string => outcome.closing === 'authoring_failure' ? '编写模型的问题' : outcome.closing === 'author_conflict' ? '原始用例的问题' : outcome.closing === 'missing_fact' ? '缺资料' : '还没查清';
export function caseConclusion(input: ReportInput, outcome: CaseOutcome): string {
  const named = `原始用例 ${outcome.autoid} ${title(input, outcome.autoid)}`;
  if (outcome.status === 'delivered') return `${named}，自动化用例 Excel 已完成上机验证，状态已确认，判断正确。决定者程序。`;
  const note = input.notes.cases[outcome.autoid];
  const model = outcome.closing === 'author_conflict' || outcome.closing === 'device_defect';
  const status = model ? '未确认' : outcome.closing === 'authoring_failure' ? '已确认' : outcome.closing === 'missing_fact' || outcome.status === 'unsettled' || outcome.status === 'unrun' ? '未知' : '已确认';
  const conclusion = outcome.closing === 'author_conflict' ? '模型判断原始用例与手册冲突' : outcome.closing === 'device_defect' ? '模型判断原始用例的期望与设备输出不一致' : outcome.closing === 'authoring_failure' ? `自动化用例尚未编写正确${outcome.rounds === undefined ? '' : `，已重写自动化用例 ${outcome.rounds} 次`}` : outcome.closing === 'missing_fact' ? '缺少脚本编写所需的资料' : outcome.status === 'failed' ? '上机验证发现错误' : '上机验证尚无结论';
  const next = model ? '使用者核对原始用例、手册和设备输出后决定是否修改原始用例' : note.remedy;
  return `${named}，${conclusion}，状态${status}${status === '未知' ? '' : '，判断错误'}。原因${reasonOf(outcome)}，下一步${next}。决定者${model ? '模型' : '程序'}。`;
}
function head(input: ReportInput): string[] {
  const { pass, unsuccessful } = input.assembly;
  const lines = [
    ...(input.scope ? [`本次范围：${input.scope.words}（共 ${input.scope.totalCases} 条原始用例，纳入本次范围 ${input.assembly.totals.cases} 条，另有 ${input.scope.outOfScope.length} 条未纳入本次范围）。`] : []),
    pass && input.files.pass ? `自动化用例 Excel case.xlsx 中的 ${pass.items.length} 条原始用例已一起完成上机验证，判断正确。` : '尚无核对正确的自动化用例 Excel。',
    unsuccessful && input.files.unsuccessful ? `自动化用例 Excel unsuccessful_cases.xlsx 包含 ${unsuccessful.items.length} 条仍有错误或未知的原始用例，使用各自最近一次上机验证的自动化用例，尚未一起做上机验证。` : '没有其他自动化用例 Excel。',
  ];
  if (input.build) lines.push(`构建 ${input.build}。`);
  for (const moved of [input.placedLast?.pass, input.placedLast?.unsuccessful]) if (moved?.length) lines.push(movedText(moved, new Map(moved.map((row) => [row.autoid, input.originals[row.autoid]?.title ?? ''] as const))));
  const audit = input.passAudit;
  if (audit?.markers === null) lines.push('状态未知。原因缺资料，执行器规则没有说明哪些设备输出表示执行失败；下一步由使用者补齐执行器规则，再核对设备输出。决定者程序。');
  else if (audit?.downgraded || audit?.wordless) lines.push(`核对设备输出后，${audit.downgraded} 条原始用例有执行失败原话却未被自动化用例检查，状态未知；${audit.wordless} 条缺少设备输出，状态未知。下一步由编写模型补齐检查或由使用者补齐设备输出。决定者程序。`);
  return lines;
}
function section(input: ReportInput, outcome: CaseOutcome): string[] {
  const note = input.notes.cases[outcome.autoid];
  const fence = (text: string) => ['```', text.replace(/```/g, '`​``'), '```'];
  const candidate = outcome.closing === 'device_defect' ? note.defect_candidate : undefined;
  const conflict = outcome.closing === 'author_conflict' ? outcome.conflict : undefined;
  return [
    `## 原始用例 ${outcome.autoid} ${title(input, outcome.autoid)}`,
    caseConclusion(input, outcome),
    '', timeline(outcome, input.excluded.includes(outcome.autoid)),
    ...(note.judged ? ['', `模型说明，状态未确认。${note.judged}`] : []),
    ...(outcome.missing?.missing ? ['', `证据，Hub 核对结果原话。${outcome.missing.missing}`] : []),
    ...(note.evidence ? ['', '**证据，设备输出**，已按照规则核对设备输出。', ...fence(note.evidence)] : []),
    ...(candidate ? ['', `复现步骤 ${candidate.repro}`, '', '原始用例原句', ...fence(candidate.expected), '', '设备输出', ...fence(candidate.actual)] : []),
    ...(conflict ? ['', '**证据，原始用例原句**，已按照规则核对原文。', ...fence(conflict.author), '', `**证据，手册原话**，构建 ${input.build ?? '未知'}，已按照规则核对原文。`, ...fence(conflict.manual)] : []),
  ];
}
const DELIVERABLES = '自动化用例 Excel：`case.xlsx`、`unsuccessful_cases.xlsx`。交付报告：`delivery_report.md`、`unsuccessful_cases.md`。机器可读结果：`delivery.json`。';

export function deliveryReport(input: ReportInput): string {
  const lines = [`# 交付报告 — ${input.name}`, `> 生成 ${input.generatedAt}`, '', ...head(input)];
  for (const outcome of input.assembly.cases) lines.push('', ...(outcome.status === 'delivered' ? [caseConclusion(input, outcome)] : section(input, outcome)));
  if (input.scope && input.scope.outOfScope.length > 0) {
    lines.push('', `## 未纳入本次范围的原始用例（${input.scope.outOfScope.length} 条）`, '', '以下原始用例在开运行时未纳入本次范围，本次未做脚本编写与上机验证。', '');
    for (const omitted of input.scope.outOfScope) {
      lines.push(`- 原始用例 ${omitted.autoid} ${omitted.title || '标题未知'}`);
    }
  }
  lines.push('', '---', DELIVERABLES);
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
      if (log.text === null) lines.push('', `**设备输出**。状态未知，原因缺资料，${log.withheld ?? '没有取得设备输出'}；下一步由使用者补齐设备输出。`);
      else {
        const tail = log.text.length > LOG_TAIL ? log.text.slice(-LOG_TAIL) : log.text;
        lines.push('', `**设备输出**${log.text.length > LOG_TAIL ? `，末尾 ${LOG_TAIL} 字` : ''}`, '```', tail.replace(/```/g, '`​``'), '```');
      }
    }
  }
  return lines.join('\n') + '\n';
}
