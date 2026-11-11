// What the end of a compile run hands over, after InfoTest's delivery directory (docs/engine/07_display_contract.md §11.9 of the
// reference engine): a pass volume that was dispatched whole and passed item by item, an unsuccessful volume of the cases that
// have a plan but did not pass, a report with one section per case not delivered (what happened, how it was judged, the fix or
// the trade-off), a longer report for whoever picks those cases up, and a machine summary. Every status and count here comes
// from the jobs' verdicts as the Hub relays them (decision 160), and a failed case closes by the reference engine's rules
// (closeFailed). The model writes only the judged paragraphs of each case not delivered and, for a product-defect candidate, quotes
// that are checked verbatim; nothing here reads device prose to decide anything.
import { isRecord } from './text.ts';
import { isDynamicTerminal, labelOf } from './generated/vocabulary.ts';

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
export interface CaseNote { judged: string; remedy: string; evidence?: string; defect_candidate?: DefectCandidate }
export interface Notes { batch?: string; cases: Record<string, CaseNote> }
/** What the document holds for a case: its title and original lines (steps with their expectations), when known. */
export interface Original { title: string; lines: Array<{ text: string; expected: string[] }> }

const SHA = /^[0-9a-f]{64}$/;
const RUN = /^run_[0-9a-z]{26}$/;
const NOTE_MAX = 4000;
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((v) => typeof v === 'string' && v.length > 0);

/** The Hub's run-jobs@1 answer for `run`, checked for shape; anything else is refused rather than guessed at. */
export function parseRunJobs(value: unknown, run: string): ExportedJob[] {
  if (!isRecord(value) || value.schema !== 'run-jobs@1' || value.run !== run || !Array.isArray(value.jobs)) throw new Error(`Hub 给的运行 ${run} 的作业清单不合式或不是这个运行的`);
  return value.jobs.map((job) => {
    if (!isRecord(job) || typeof job.job !== 'string' || !RUN.test(String(job.verification_run)) || !RUN.test(String(job.plan_run)) || !strings(job.items) || !SHA.test(String(job.sha256)) || typeof job.frozen !== 'boolean' || typeof job.outcome !== 'string') throw new Error(`运行 ${run} 的作业条目不合式`);
    if (job.rows !== null && (!Array.isArray(job.rows) || job.rows.some((row) => !isRecord(row) || typeof row.item !== 'string' || typeof row.dynamic_terminal !== 'string'))) throw new Error(`运行 ${run} 的作业 ${job.job} 的逐条结论不合式`);
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
    if (open) throw new Error(`运行 ${run} 的作业 ${open.job} 还没有结束；等它结束再组交付`);
    const frozen = own.find((j) => j.frozen || j.ended === 'unknown');
    if (frozen) throw new Error(`运行 ${run} 的作业 ${frozen.job} 结果未知、等管理员处置；处置前它不算一次上机，不组交付`);
    throw new Error(`运行 ${run} 没有派发过、或作业没有带回逐条结论；--runs 只写派发过并已结束的核验运行`);
  }
  const rows = job.rows!;
  if (rows.length !== job.items.length || new Set(rows.map((r) => r.item)).size !== rows.length || rows.some((r) => !job.items.includes(r.item))) throw new Error(`运行 ${run} 的作业 ${job.job} 的逐条结论没有逐一覆盖派发的用例`);
  return { run, job: job.job, plan_run: job.plan_run, sha256: job.sha256, items: [...job.items], rows };
}

export interface CaseOutcome { autoid: string; status: Status; history: Array<{ ordinal: number; run: string; job: string; terminal: string; log?: string; sessions?: Record<string, string>; audit?: RowAudit }>; rounds?: number; closing?: Closing; missing?: MissingFact }
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
  if (!population.length || new Set(population).size !== population.length) throw new Error('用例清单为空或有重复的 autoid');
  if (!dispatches.length) throw new Error('没有上机过的核验运行；--runs 至少写一次整卷上机');
  if (new Set(dispatches.map((d) => d.run)).size !== dispatches.length) throw new Error('--runs 里同一个核验运行写了两次');
  for (const d of dispatches) for (const item of d.items) if (!population.includes(item)) throw new Error(`运行 ${d.run} 派发了不在这份脑图用例清单里的 ${item}`);
  const passedWhole = (d: Dispatch) => d.rows.length > 0 && d.rows.every((r) => r.dynamic_terminal === 'pass');
  const latestOf = (item: string) => [...dispatches].reverse().flatMap((d) => d.rows.filter((r) => r.item === item))[0]?.dynamic_terminal;
  const lastPassed = population.filter((item) => latestOf(item) === 'pass');
  const holds = (k: number) => dispatches.slice(k + 1).every((later) => later.rows.every((r) => !dispatches[k].items.includes(r.item) || r.dynamic_terminal === 'pass'));
  const at = dispatches.findLastIndex((d, k) => passedWhole(d) && holds(k));
  const pass = at < 0 ? null : dispatches[at];
  // Every latest pass belongs in the pass volume; without one, or with passes outside it, dispatch the volume that holds them all.
  const outside = pass ? lastPassed.filter((item) => !pass.items.includes(item)) : [];
  if (pass && outside.length) throw new Error(`最近一次上机通过的 ${outside.join('、')} 不在最后一次整卷全部通过的那一卷（核验运行 ${pass.run}）里。所有最近一次上机通过的用例要放在同一卷里一起整卷上机、逐条通过才交付：开新的计划运行，parameters.exclude 写上没通过的和没编出来的用例，原样重交所有最近一次上机通过的用例的计划，生成、核验、派发，再组交付`);
  if (!pass && lastPassed.length) throw new Error(`还没有一次整卷全部通过、之后也没再失败的上机，${lastPassed.join('、')} 最近一次上机通过了。通过卷要单独整卷上机：开新的计划运行，parameters.exclude 写上没通过的和没编出来的用例，原样重交通过用例的计划，生成、核验、派发，再把那次核验运行加到 --runs 末尾`);
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
const LEADING_PROMPT = /^([A-Za-z][A-Za-z0-9_.-]{0,20}(?:\([A-Za-z0-9_\- ]+\))?[#>])/;
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
 * runner contract declares is the device's own verdict on that command, and the lines before it are its reason. Read by
 * position in the terminal transcript and by the declared lines alone (the reference keeps one authority for a device's CLI
 * errors, device_errors.py, and hands the lines of the last run that carry one to the next writer with the directive that the
 * fault is in the case's own command sequence, compile_engine/briefs.py execution_failures). What the refusal means is not
 * decided here. A long command is echoed with the terminal's own redrawing, so the command is the echo up to its first
 * control character and `echo_cut` says it is only the beginning; the run log holds the whole line.
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
    let refused = false;
    for (let j = i + 1; j < lines.length && !LEADING_PROMPT.test(lines[j]); j++) {
      const line = lines[j].trim();
      if (!line) continue;
      reply.push(line.length > REPLY_CHARS ? line.slice(0, REPLY_CHARS) + '…' : line);
      if (markers.some((marker) => line.includes(marker))) { refused = true; break; }
    }
    if (!refused) continue;
    const refusal: ExecutionRefusal = { command, prompt: typed[1], reply: reply.slice(-REPLY_LINES), ...(control < 0 ? {} : { echo_cut: true as const }) };
    const key = JSON.stringify([refusal.command, refusal.prompt, refusal.reply]);
    if (!seen.has(key)) { seen.add(key); found.push(refusal); }
  }
  return found;
}

/** The model's notes: one judged paragraph and one fix-or-trade-off paragraph for exactly the cases not delivered. */
export function readNotes(value: unknown, undelivered: string[]): Notes {
  if (!isRecord(value) || !isRecord(value.cases) || Object.keys(value).some((key) => key !== 'cases' && key !== 'batch')) throw new Error('说明文件要写成 {"cases":{"<autoid>":{"judged":"…","remedy":"…","evidence":"…"}},"batch":"…"}（batch 可省）');
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
    if (!isRecord(note) || Object.keys(note).some((k) => !['judged', 'remedy', 'evidence', 'defect_candidate'].includes(k))) throw new Error(`用例 ${autoid} 的说明只写 judged（怎么判断的）、remedy（修复方案或取舍）、evidence（设备原话）和判产品缺陷时的 defect_candidate`);
    const candidate = note.defect_candidate;
    if (candidate !== undefined && (!isRecord(candidate) || Object.keys(candidate).sort().join() !== 'actual,expected,repro')) throw new Error(`用例 ${autoid} 的 defect_candidate 恰好写 repro（复现步骤）、expected（作者期望原文）和 actual（设备原话）三项`);
    cases[autoid] = {
      judged: text(note.judged, `用例 ${autoid} 的 judged`), remedy: text(note.remedy, `用例 ${autoid} 的 remedy`),
      ...(note.evidence === undefined ? {} : { evidence: text(note.evidence, `用例 ${autoid} 的 evidence`) }),
      ...(isRecord(candidate) ? { defect_candidate: { repro: text(candidate.repro, `用例 ${autoid} 的 defect_candidate.repro`), expected: text(candidate.expected, `用例 ${autoid} 的 defect_candidate.expected`), actual: text(candidate.actual, `用例 ${autoid} 的 defect_candidate.actual`) } } : {}),
    };
  }
  return { ...(value.batch === undefined ? {} : { batch: text(value.batch, 'batch') }), cases };
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
    if (evidence === undefined) problems.push(`用例 ${autoid} 上过机，说明里缺 evidence：从它最后一次上机的设备返回（运行日志或设备会话）逐字复制说明失败的那一段`);
    else if (!texts.some((text) => plain(text).includes(plain(evidence)))) problems.push(`用例 ${autoid} 的 evidence 不是它最后一次上机设备返回里的原话；逐字复制，不改写、不拼接`);
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
export const CLOSING = { authoring_failure: '模型未找到解决方案', device_defect: '声明与设备行为冲突（待仲裁）', missing_fact: '缺少 Hub 点名的事实（待补齐）' } as const;
export type Closing = keyof typeof CLOSING;

/** The line by which the pass review dropped the case's latest pass, when that is how its last dispatch ended. */
export const droppedPass = (outcome: CaseOutcome): RowAudit | undefined => (outcome.status === 'unsettled' ? outcome.history.at(-1)?.audit : undefined);
/** Whether the closing rules of a failed case apply: its latest verdict is a failure, or a pass the pass review dropped. */
export const reworked = (outcome: CaseOutcome): boolean => outcome.status === 'failed' || droppedPass(outcome) !== undefined;

/**
 * Closes every case that failed or whose pass the pass review dropped, or says why the delivery cannot be assembled yet.
 * `rounds` holds, per such case, how many distinct plans of it did not pass on the bed (a failure or a dropped pass);
 * `authored` the author's expectation texts of each case; `deviceTexts` its last device output.
 */
export function closeFailed(cases: CaseOutcome[], notes: Notes, rounds: Record<string, number>, authored: Record<string, string[]>, deviceTexts: Record<string, string[]>): { cases: CaseOutcome[]; problems: string[] } {
  const problems: string[] = [];
  const plain = (text: string) => text.replace(/\r/g, '');
  const closed = cases.map((outcome) => {
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
        problems.push(`用例 ${outcome.autoid} 的 defect_candidate：它最后一次上机里设备用 ^ 拒绝了命令 ${refused.slice(0, 3).map((r) => `“${r.command.length > 80 ? `${r.command.slice(0, 80)}…` : r.command}”${r.prompt ? `（在 ${r.prompt} 下）` : ''}`).join('、')}。设备没有接受这条命令的写法，作者的场景没有在设备上实现，够不上声明与设备行为冲突：去掉 defect_candidate，先修这条命令再上机；${MAX_ROUNDS} 轮未过的记为模型未找到解决方案`);
        return outcome;
      }
      const wrong: string[] = [];
      if (!(authored[outcome.autoid] ?? []).some((text) => plain(text).includes(plain(candidate.expected)))) wrong.push('expected 不是这条用例作者期望原文里的字');
      if (!(deviceTexts[outcome.autoid] ?? []).some((text) => plain(text).includes(plain(candidate.actual)))) wrong.push('actual 不是它最后一次上机设备返回里的原话');
      if (!wrong.length) return { ...outcome, rounds: used, closing: 'device_defect' as const };
      problems.push(`用例 ${outcome.autoid} 的 defect_candidate：${wrong.join('；')}；逐字复制，不改写、不拼接`);
      return outcome;
    }
    if (used >= MAX_ROUNDS) return { ...outcome, rounds: used, closing: 'authoring_failure' as const };
    const dropped = droppedPass(outcome);
    if (dropped) {
      problems.push(`用例 ${outcome.autoid} 最近一次上机运行器报通过，通过复核改记为无判定：${dropped.where}里有执行失败的设备原话“${dropped.line.length > 160 ? `${dropped.line.slice(0, 160)}…` : dropped.line}”，它自己的断言没有读这一行。照 InfoTest，这样的用例和上机没通过的一样回到编写：它没通过的编写轮次是 ${used}，还不到 ${MAX_ROUNDS} 轮（同一份计划重跑不算新的一轮）。让它的断言读到这一行，或换一种不会执行失败的观察，改计划后整卷上机；${MAX_ROUNDS} 轮未过的记为模型未找到解决方案`);
      return outcome;
    }
    problems.push(`用例 ${outcome.autoid} 上机没通过的编写轮次是 ${used}，还不到 ${MAX_ROUNDS} 轮（同一份计划重跑不算新的一轮）。说明里的判断不能让它定下结论：环境缺数据、缺拓扑、缺前置这类文字主张不是依据，照用例原样继续编写；“未定”就在被测命令前加只读观察再上机；按设备原话改计划，整卷上机。只有核对得上的产品缺陷候选（defect_candidate：repro 复现步骤、expected 作者期望原文、actual 设备原话，后两项逐字）可以提前定下结论`);
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
 * engine closes a case whose authored attempts were all refused at its round cap (compose_rejected counts as an attempt). Any
 * other case never dispatched goes back to authoring.
 */
export function closeUnrun(cases: CaseOutcome[], facts: Record<string, MissingFact>): { cases: CaseOutcome[]; problems: string[] } {
  const problems: string[] = [];
  const closed = cases.map((outcome) => {
    if (outcome.status !== 'unrun') return outcome;
    const fact = facts[outcome.autoid];
    if (fact) return { ...outcome, closing: fact.kind === 'data_gap' ? 'missing_fact' as const : 'authoring_failure' as const, missing: fact };
    problems.push(`用例 ${outcome.autoid} 没有上机，Hub 也没有给它的计划记下缺少的事实或修正轮次用完。说明里的判断不能让它定下结论：环境缺数据、缺拓扑、缺前置、缺命令这类文字主张不是依据，照用例原样编写、交卷，和其他用例一起整卷上机，按设备原话归因，最多 ${MAX_ROUNDS} 轮。它自己的计划交给 Hub 后被判缺原合约事实（Hub 记下数据缺口并点名补证请求），或修正轮次用完仍没有受理的，才可以不上机定下结论`);
    return outcome;
  });
  return { cases: closed, problems };
}
const MISSING_SHOWN = 240;
/** The closing of a case as one line: what it is and the fact it rests on. */
export function closingLine(outcome: CaseOutcome): string | null {
  if (outcome.closing === 'authoring_failure' && outcome.missing?.kind === 'repair_exhausted') {
    const said = outcome.missing.missing.length > MISSING_SHOWN ? `${outcome.missing.missing.slice(0, MISSING_SHOWN)}…` : outcome.missing.missing;
    return `${CLOSING.authoring_failure}：它的计划在计划运行 ${outcome.missing.plan_run} 交给 Hub，修正轮次用完也没有受理${said ? `（Hub 原话：${said}）` : ''}，没有上机；按 InfoTest 的收口规则，编写每次都被提交规则拒绝、拒满轮次的，记为模型未找到解决方案。下面“怎么判断的”是模型自述，不是定下结论的依据。`;
  }
  if (outcome.closing === 'authoring_failure') {
    const dropped = outcome.history.filter((h) => h.audit).length;
    return `${CLOSING.authoring_failure}：编写 ${outcome.rounds} 轮，每一轮上机都没通过${dropped ? `（其中 ${dropped} 次上机运行器报通过，通过复核改记无判定，照 InfoTest 算没通过）` : ''}，作者内容未改、没有核对得上的缺陷候选；下面“怎么判断的”是模型自述，不是定下结论的依据。`;
  }
  if (outcome.closing === 'device_defect') return `${CLOSING.device_defect}：作者期望原文和设备原话已逐字核对，只形成待仲裁的缺陷候选，不是已确认的产品缺陷。`;
  if (outcome.closing === 'missing_fact' && outcome.missing) {
    const said = outcome.missing.missing.length > MISSING_SHOWN ? `${outcome.missing.missing.slice(0, MISSING_SHOWN)}…` : outcome.missing.missing;
    return `${CLOSING.missing_fact}：它的计划在计划运行 ${outcome.missing.plan_run} 交给 Hub，Hub 判它缺少事实并点名了补证请求${said ? `（Hub 原话：${said}）` : ''}；补齐前不生成工作簿、不上机。下面“怎么判断的”是模型自述。`;
  }
  return null;
}

export const terminalLabel = (terminal: string): string => isDynamicTerminal(terminal) ? labelOf('dynamic_terminal', terminal) : '无法识别的结论';
/** What happened, mechanically from the verdict sequence (the reference engine translates its verdict ledger the same way). */
export function timeline(outcome: CaseOutcome, excluded: boolean): string {
  if (!outcome.history.length) return excluded ? '没有上机：计划运行用 parameters.exclude 排除了这一条，没有编出可执行的计划。' : '没有上机：没有一次派发包含这一条。';
  const steps = outcome.history.map((h) => `第 ${h.ordinal} 次上机（核验运行 ${h.run}）：${terminalLabel(h.terminal)}${h.audit ? `（运行器报通过，但 ${h.audit.where} 里有执行失败的设备原话“${h.audit.line}”，本条断言没有读它，不算通过）` : ''}`).join(' → ');
  return steps + '。';
}

export interface ReportInput {
  name: string; generatedAt: string; build: string | null;
  assembly: Assembly; notes: Notes; originals: Record<string, Original>; excluded: string[];
  files: { pass: { sha256: string } | null; unsuccessful: { sha256: string } | null };
  /** For the long report: the tail of each case's last device log, or why it is not quoted. */
  logs: Record<string, { reference: string; job: string; text: string | null; withheld?: string }>;
  /** The pass review: how many markers the contracts declared (null: none declared), passes read, turned into no verdict, and passes with no device words saved. */
  passAudit?: { markers: number | null; read: number; downgraded: number; wordless: number };
}
const title = (input: ReportInput, autoid: string) => input.originals[autoid]?.title || `用例 …${autoid.slice(-6)}`;
/** The closings of the failed cases, of those whose pass was dropped and of those never dispatched, one sentence each, naming only those that occur; empty when none closed. */
export function closingCounts(cases: CaseOutcome[]): string {
  return (['failed', 'unsettled', 'unrun'] as const).map((status) => {
    const counts = (Object.keys(CLOSING) as Closing[]).map((closing) => [closing, cases.filter((c) => c.status === status && c.closing === closing).length] as const).filter(([, n]) => n > 0);
    return counts.length ? `${STATUS[status]}的终态：${counts.map(([closing, n]) => `${CLOSING[closing]} ${n}`).join('，')}。` : '';
  }).join('');
}
function head(input: ReportInput): string[] {
  const { totals, pass, unsuccessful } = input.assembly;
  const closings = closingCounts(input.assembly.cases);
  const lines = [
    `本份脑图选中 ${totals.cases} 个用例：${STATUS.delivered} ${totals.delivered}，${STATUS.failed} ${totals.failed}，${STATUS.unsettled} ${totals.unsettled}，${STATUS.unrun} ${totals.unrun}。${closings}`,
    '',
    pass && input.files.pass ? `- 通过卷 \`case.xlsx\`：${pass.items.length} 个用例。这份工作簿（sha256 ${input.files.pass.sha256.slice(0, 12)}…）在核验运行 ${pass.run}（作业 ${pass.job.slice(0, 12)}）里整卷上机，逐条通过。` : '- 没有通过卷：最后一次上机没有用例通过。',
    unsuccessful && input.files.unsuccessful ? `- 未通过卷 \`unsuccessful_cases.xlsx\`：${unsuccessful.items.length} 个用例，每条用它最后一次上机的计划（计划运行 ${[...new Set(unsuccessful.items.map((item) => unsuccessful.sources[item].plan_run))].join('、')}），没有再上机。` : '- 没有未通过卷：没有带计划却没通过的用例。',
  ];
  if (input.build) lines.push(`- 构建：${input.build}`);
  const audit = input.passAudit;
  if (audit) lines.push(audit.markers === null
    ? '- 通过复核：合约没有声明执行失败标记，通过的条目没有按 InfoTest 的规则复核。'
    : `- 通过复核（InfoTest 的执行失败标记，合约声明 ${audit.markers} 条）：读了 ${audit.read} 条通过的运行日志，${audit.downgraded} 条里有本条断言没读的执行失败原话、改记无判定${audit.wordless ? `；${audit.wordless} 条通过没有存下运行日志，没有复核` : ''}。`);
  if (input.notes.batch) lines.push('', `> ${input.notes.batch.replace(/\n/g, '\n> ')}`);
  return lines;
}
function section(input: ReportInput, outcome: CaseOutcome): string[] {
  const note = input.notes.cases[outcome.autoid];
  const fence = (text: string) => ['```device-evidence', text.replace(/```/g, '`​``'), '```'];
  const closing = closingLine(outcome);
  const candidate = outcome.closing === 'device_defect' ? note.defect_candidate : undefined;
  return [
    `## ${title(input, outcome.autoid)}`,
    `- 编号 \`${outcome.autoid}\` · 状态：${STATUS[outcome.status]} · 上机 ${outcome.history.length} 次${outcome.closing ? ` · 终态：${CLOSING[outcome.closing]}` : ''}`,
    '', `**发生了什么**：${timeline(outcome, input.excluded.includes(outcome.autoid))}`,
    ...(note.evidence ? ['', `**设备原话**（已核对出自最后一次上机的设备返回）：`, ...fence(note.evidence)] : []),
    ...(closing ? ['', `**结论**：${closing}`] : []),
    ...(candidate ? ['', `**缺陷候选**：复现步骤：${candidate.repro}`, '', '作者期望（原文）：', ...fence(candidate.expected), '', '设备实际（原话）：', ...fence(candidate.actual)] : []),
    '', `**怎么判断的**：${note.judged}`,
    '', `**修复方案／取舍**：${note.remedy}`,
  ];
}
const DELIVERABLES = '交付物：`case.xlsx`（通过卷）、`unsuccessful_cases.xlsx`（未通过卷）、`delivery_report.md`（本报告）、`unsuccessful_cases.md`（未通过用例详报）、`delivery.json`（机读汇总）；没有的卷上面已说明。';

export function deliveryReport(input: ReportInput): string {
  const delivered = input.assembly.cases.filter((c) => c.status === 'delivered');
  const others = input.assembly.cases.filter((c) => c.status !== 'delivered');
  const lines = [`# 交付报告 — ${input.name}`, `> 生成 ${input.generatedAt}`, '', ...head(input)];
  if (delivered.length) lines.push('', '## 交付的用例', ...delivered.map((c) => `- \`${c.autoid}\` ${title(input, c.autoid)}`));
  for (const c of others) lines.push('', ...section(input, c));
  lines.push('', '---', DELIVERABLES);
  return lines.join('\n') + '\n';
}

const LOG_TAIL = 1500;
export function unsuccessfulReport(input: ReportInput): string {
  const others = input.assembly.cases.filter((c) => c.status !== 'delivered');
  const lines = [`# 未通过用例详报 — ${input.name}`, `> 生成 ${input.generatedAt} · 共 ${others.length} 个`];
  for (const c of others) {
    lines.push('', ...section(input, c));
    const original = input.originals[c.autoid];
    if (original?.lines.length) {
      lines.push('', '**脑图原始用例**：');
      for (const line of original.lines) lines.push(`- ${line.text}${line.expected.length ? ` → 预期：${line.expected.join('；')}` : ''}`);
    }
    const log = input.logs[c.autoid];
    if (log) {
      if (log.text === null) lines.push('', `**最后一次设备日志**（作业 ${log.job.slice(0, 12)}，${log.reference}）：${log.withheld ?? '没有取到字节'}`);
      else {
        const tail = log.text.length > LOG_TAIL ? log.text.slice(-LOG_TAIL) : log.text;
        lines.push('', `**最后一次设备日志**（作业 ${log.job.slice(0, 12)}，${log.text.length > LOG_TAIL ? `末尾 ${LOG_TAIL} 字` : '全文'}；原件 ${log.reference}）：`, '```device-evidence', tail.replace(/```/g, '`​``'), '```');
      }
    }
  }
  return lines.join('\n') + '\n';
}
