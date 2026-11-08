// What the end of a compile run hands over, after InfoTest's delivery directory (docs/engine/07_display_contract.md §11.9 of the
// reference engine): a pass volume that was dispatched whole and passed item by item, an unsuccessful volume of the cases that
// have a plan but did not pass, a report with one section per case not delivered (what happened, how it was judged, the fix or
// the trade-off), a longer report for whoever picks those cases up, and a machine summary. Every status and count here comes
// from the jobs' verdicts as the Hub relays them (decision 160); the model writes only the two judged paragraphs of each case
// not delivered, and nothing here reads device prose to decide anything.
import { isRecord } from './text.ts';
import { isDynamicTerminal, labelOf } from './generated/vocabulary.ts';

export const STATUS = { delivered: '交付', failed: '上机未通过', unsettled: '上机没有结论', unrun: '没有上机' } as const;
export type Status = keyof typeof STATUS;

export interface JobRow { item: string; dynamic_terminal: string; evidence?: { log?: string; sessions?: Record<string, string> } }
export interface ExportedJob { job: string; verification_run: string; plan_run: string; items: string[]; sha256: string; ended: 'done' | 'unknown' | null; outcome: string; frozen: boolean; result: string | null; device_return: string | null; rows: JobRow[] | null }
/** One dispatch that settled: the run it verified, the plan run it was generated from, the workbook digest and each item's verdict. */
export interface Dispatch { run: string; job: string; plan_run: string; sha256: string; items: string[]; rows: JobRow[] }
export interface CaseNote { judged: string; remedy: string; evidence?: string }
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

export interface CaseOutcome { autoid: string; status: Status; history: Array<{ ordinal: number; run: string; job: string; terminal: string; log?: string; sessions?: Record<string, string> }>; leftOut?: string }
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
 * passed whole (the final verification: the reference engine delivers only a volume dispatched on its own and passed item by
 * item) after which none of its cases failed; a later dispatch may rerun its cases if they pass again, and may try other cases.
 * Every case whose latest verdict is a pass must be in it, or it was never final-verified with the volume it would ship in.
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
  // Without a pass volume a case that passed has never been final-verified: dispatch one. With one, a case that passed but was
  // left out of it (judged unstable, say) is not delivered and is reported as such; nothing is delivered unverified either way.
  if (!pass && lastPassed.length) throw new Error(`还没有一次整卷全部通过、之后也没再失败的上机，${lastPassed.join('、')} 最近一次上机通过了。通过卷要单独整卷上机：开新的计划运行，parameters.exclude 写上没通过的和没编出来的用例，原样重交通过用例的计划，生成、核验、派发，再把那次核验运行加到 --runs 末尾`);
  const delivered = new Set(pass?.items ?? []);
  const cases: CaseOutcome[] = population.map((autoid) => {
    const history = dispatches.flatMap((d, k) => d.rows.filter((r) => r.item === autoid).map((r) => ({ ordinal: k + 1, run: d.run, job: d.job, terminal: r.dynamic_terminal, ...(r.evidence?.log ? { log: r.evidence.log } : {}), ...(r.evidence?.sessions ? { sessions: r.evidence.sessions } : {}) })));
    if (delivered.has(autoid)) return { autoid, status: 'delivered' as const, history };
    const latest = history.at(-1);
    if (!latest) return { autoid, status: 'unrun' as const, history };
    if (latest.terminal === 'pass') return { autoid, status: 'unsettled' as const, history, leftOut: pass!.run };
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

/** The model's notes: one judged paragraph and one fix-or-trade-off paragraph for exactly the cases not delivered. */
export function readNotes(value: unknown, undelivered: string[]): Notes {
  if (!isRecord(value) || !isRecord(value.cases) || Object.keys(value).some((key) => key !== 'cases' && key !== 'batch')) throw new Error('说明文件要写成 {"cases":{"<autoid>":{"judged":"…","remedy":"…"}},"batch":"…"}（batch 可省）');
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
    if (!isRecord(note) || Object.keys(note).some((k) => k !== 'judged' && k !== 'remedy' && k !== 'evidence')) throw new Error(`用例 ${autoid} 的说明只写 judged（怎么判断的）、remedy（修复方案或取舍）和 evidence（设备原话）`);
    cases[autoid] = { judged: text(note.judged, `用例 ${autoid} 的 judged`), remedy: text(note.remedy, `用例 ${autoid} 的 remedy`), ...(note.evidence === undefined ? {} : { evidence: text(note.evidence, `用例 ${autoid} 的 evidence`) }) };
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

export const terminalLabel = (terminal: string): string => isDynamicTerminal(terminal) ? labelOf('dynamic_terminal', terminal) : '无法识别的结论';
/** What happened, mechanically from the verdict sequence (the reference engine translates its verdict ledger the same way). */
export function timeline(outcome: CaseOutcome, excluded: boolean): string {
  if (!outcome.history.length) return excluded ? '没有上机：计划运行用 parameters.exclude 排除了这一条，没有编出可执行的计划。' : '没有上机：没有一次派发包含这一条。';
  const steps = outcome.history.map((h) => `第 ${h.ordinal} 次上机（核验运行 ${h.run}）：${terminalLabel(h.terminal)}`).join(' → ');
  return outcome.leftOut ? `${steps}；最近一次通过了，但不在终验（核验运行 ${outcome.leftOut}）的通过卷里，没有交付。` : steps + '。';
}

export interface ReportInput {
  name: string; generatedAt: string; build: string | null;
  assembly: Assembly; notes: Notes; originals: Record<string, Original>; excluded: string[];
  files: { pass: { sha256: string } | null; unsuccessful: { sha256: string } | null };
  /** For the long report: the tail of each case's last device log, or why it is not quoted. */
  logs: Record<string, { reference: string; job: string; text: string | null; withheld?: string }>;
}
const title = (input: ReportInput, autoid: string) => input.originals[autoid]?.title || `用例 …${autoid.slice(-6)}`;
function head(input: ReportInput): string[] {
  const { totals, pass, unsuccessful } = input.assembly;
  const lines = [
    `本份脑图选中 ${totals.cases} 个用例：${STATUS.delivered} ${totals.delivered}，${STATUS.failed} ${totals.failed}，${STATUS.unsettled} ${totals.unsettled}，${STATUS.unrun} ${totals.unrun}。`,
    '',
    pass && input.files.pass ? `- 通过卷 \`case.xlsx\`：${pass.items.length} 个用例。这份工作簿（sha256 ${input.files.pass.sha256.slice(0, 12)}…）在核验运行 ${pass.run}（作业 ${pass.job.slice(0, 12)}）里整卷上机，逐条通过。` : '- 没有通过卷：最后一次上机没有用例通过。',
    unsuccessful && input.files.unsuccessful ? `- 未通过卷 \`unsuccessful_cases.xlsx\`：${unsuccessful.items.length} 个用例，每条用它最后一次上机的计划（计划运行 ${[...new Set(unsuccessful.items.map((item) => unsuccessful.sources[item].plan_run))].join('、')}），没有再上机。` : '- 没有未通过卷：没有带计划却没通过的用例。',
  ];
  if (input.build) lines.push(`- 构建：${input.build}`);
  if (input.notes.batch) lines.push('', `> ${input.notes.batch.replace(/\n/g, '\n> ')}`);
  return lines;
}
function section(input: ReportInput, outcome: CaseOutcome): string[] {
  const note = input.notes.cases[outcome.autoid];
  return [
    `## ${title(input, outcome.autoid)}`,
    `- 编号 \`${outcome.autoid}\` · 状态：${STATUS[outcome.status]} · 上机 ${outcome.history.length} 次`,
    '', `**发生了什么**：${timeline(outcome, input.excluded.includes(outcome.autoid))}`,
    ...(note.evidence ? ['', `**设备原话**（已核对出自最后一次上机的设备返回）：`, '```device-evidence', note.evidence.replace(/```/g, '`​``'), '```'] : []),
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
