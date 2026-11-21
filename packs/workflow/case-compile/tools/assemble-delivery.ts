import {extractScopeUserRulings} from '../functions/scope.ts';
import { formatClientCallError, parseHubOrigin } from '../functions/client-cli.ts';
import { realpathSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isRecord, failCall, CallFailure, localMinute } from '../functions/text.ts';
import { generateWorkbookSet, GENERATOR } from '../functions/generate.ts';
import { volumeOrder, type MovedCase } from '../functions/channels.ts';
import { closingHints, modelCheckpointsOf, neverReachedBed, unsentOf, type Unsent, assemble, auditKey, auditPasses, closeFailed, closeUnrun, caseConclusion, caseBasisOf, REPORT_FILES, CLOSING, OBSERVATION_NOTE, type Status, deliveryReport, evidenceProblems, failureLine, lockedStatements, parseRunJobs, readNotes, reworked, settledDispatch, STATUS, terminalLabel, trailingUnreached, unexecutedAfter, unsuccessfulReport, type CaseOutcome, type ModelCheckpoint, type ConflictGround, type Dispatch, type JobRow, type MissingFact, type Original, type OutOfScopeCase, type ReportInput, type RowAudit, type ScopeSummary } from '../functions/delivery.ts';
import { canonicalJson } from '../functions/canonical-json.ts';
import { HubReplyError, RUN_ID, sha256 } from '../functions/generated/skills/run-tools/hub-client/index.ts';
import { fetchBytesRetrying, getRetrying, downloadRetryControl, KNOWLEDGE_MAX_BYTES, KNOWLEDGE_TIMEOUT_MS, readSubmittedFileBytes, readTokenFromStdin, requireBearerToken, type RetryControl } from '../functions/hub-retry.ts';
import { fetchRunInputs, type RunInputs } from './fetch-run.ts';
import { passReviewInputs, satisfiedRecipes } from './generate-workbook.ts';
import { parsedPlanFile } from './submit-plans.ts';

const OPTIONS = { hub: true, runs: true, notes: true, out: true, recompose: false, name: false } as const;
function options(argv: string[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.startsWith('--') ? argv[i].slice(2) : '';
    if (key === 'scope') {
      failCall('invalid_parameters', '交付时不允许从本地 --scope 文件收窄范围（按范围交付须在开运行时传入 parameters.scope 锚定到 Hub 运行记录）。参数写法：--hub --runs --notes --out 必填，--recompose --name 可选，每个只写一次', '请使用 --hub、--runs、--notes 和 --out 的合法写法重试');
    }
    if (!Object.hasOwn(OPTIONS, key) || !argv[i + 1] || Object.hasOwn(values, key)) failCall('invalid_parameters', '参数写法：--hub --runs --notes --out 必填，--recompose --name 可选，每个只写一次', '请使用 --hub、--runs、--notes 和 --out 的合法写法重试');
    values[key] = argv[i + 1];
  }
  const missing = Object.entries(OPTIONS).filter(([key, required]) => required && !values[key]).map(([key]) => '--' + key);
  if (missing.length) {
    failCall('invalid_parameters', `缺少参数：${missing.join('、')}${missing.includes('--notes') ? '（--notes 为模型手写的说明 JSON 文件路径）' : ''}。参数写法：--hub --runs --notes --out 必填，--recompose --name 可选，每个只写一次`, '请使用 --hub、--runs、--notes 和 --out 的合法写法重试');
  }
  return values;
}
const json = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + '\n');
function hubDocument(bytes: Uint8Array): unknown {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { failCall('temporarily_unavailable', 'Hub 元数据不是完整的 UTF-8 JSON，尚未据此生成结论', '请维护者恢复原运行完整的元数据后重试'); }
}
const autoidOf = (item: unknown): string | null => isRecord(item) && isRecord(item.fields) && typeof item.fields.autoid === 'string' ? item.fields.autoid : null;
function excludedOf(run: Record<string, unknown>): string[] { const p = run.parameters; return isRecord(p) && Array.isArray(p.exclude) ? p.exclude.filter((v): v is string => typeof v === 'string') : []; }
interface FrozenScope { words: string; cases: string[] }
function frozenScopeOf(run: Record<string, unknown>, label: string): FrozenScope | null {
  const p = run.parameters;
  if (!isRecord(p) || p.scope === undefined) return null;
  if (Array.isArray(p.exclude) && p.exclude.length > 0) {
    failCall('invalid_parameters', `Hub 运行记录 ${label} 同时写入了 parameters.scope 与 parameters.exclude，二者互斥。请重新用 start_run 单独使用其中一项后重试`, '请重新开运行并传入一致的冻结范围后重试');
  }
  const raw = p.scope;
  if (!isRecord(raw) || Object.keys(raw).some((k) => k !== 'words' && k !== 'cases') || typeof raw.words !== 'string' || !raw.words.trim() || !Array.isArray(raw.cases) || !raw.cases.length || raw.cases.some((v) => typeof v !== 'string' || !v) || new Set(raw.cases).size !== raw.cases.length) {
    failCall('invalid_parameters', `Hub 运行记录 ${label} 中的 parameters.scope 不完整或格式无效。请重新用 start_run 按规范传入 parameters.scope 并完成上机验证后重试`, '请重新开运行并传入一致的冻结范围后重试');
  }
  return { words: raw.words.trim(), cases: [...(raw.cases as string[])] };
}
const canonicalScopeKey = (scope: FrozenScope | null): string => (scope === null ? 'null' : JSON.stringify({ words: scope.words, cases: [...scope.cases].sort() }));
/** A plan run's original of a case: its title and steps with their expectations, as the run froze them. */
function planOriginal(item: Record<string, unknown>): Original | null {
  const f = item.fields;
  if (!isRecord(f) || typeof f.title !== 'string' || !Array.isArray(f.steps)) return null;
  return { title: f.title, lines: f.steps.filter(isRecord).map((s) => ({ text: String(s.text ?? ''), expected: Array.isArray(s.expected) ? s.expected.map(String) : [] })) };
}
/** A recomposition run's original of a case, from its atoms: the intent is the title, each action a line, each expectation under the action it follows. */
function atomOriginal(item: Record<string, unknown>): { autoid: string; original: Original } | null {
  const f = item.fields;
  if (!isRecord(f) || typeof f.case_id !== 'string' || !Array.isArray(f.atoms)) return null;
  let title = ''; const lines: Array<{ id: string; text: string; expected: string[] }> = [];
  for (const atom of f.atoms.filter(isRecord)) {
    const content = String(atom.content ?? '');
    if (atom.kind === 'intent' && !title) title = content;
    else if (atom.kind === 'action') lines.push({ id: String(atom.id), text: content, expected: [] });
    else if (atom.kind === 'expectation') {
      const after = Array.isArray(atom.after) ? atom.after.map(String) : [];
      const owner = [...lines].reverse().find((line) => after.includes(line.id)) ?? lines.at(-1);
      if (owner) owner.expected.push(content); else lines.push({ id: String(atom.id), text: '', expected: [content] });
    }
  }
  return { autoid: f.case_id, original: { title, lines: lines.map(({ text, expected }) => ({ text, expected })) } };
}
async function emptyOrAbsent(directory: string): Promise<void> {
  const entries = await readdir(directory).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return [] as string[]; throw error; });
  if (entries.length) failCall('occupied', `--out 目录里已有 ${entries.slice(0, 3).join('、')}${entries.length > 3 ? ' 等' : ''}，不覆盖；另选一个新目录`, '请检查目录读取权限并选择新的空输出目录');
}

/** The reference that names a compilation: the recomposition result a plan run is bound to, or else the document it judges. */
/**
 * What makes two runs one compilation: the recompose run they are bound to. A plan run opened before its recomposition is
 * accepted (decision 179) carries the recompose run's record from its start and the result only later, and its merge run carries
 * both, so the record comes first; a run from before that binding is known by the recomposition result, and one without any by
 * the document. Round 41: with the document as the key of late-bound plan runs, a delivery reached the plan runs of earlier
 * compiles of the same mind map under the same booking and was refused for their older pack version.
 */
export function lineageKeyOf(sources: unknown): string | null {
  const bound = (slot: string) => { const found = Array.isArray(sources) ? sources.find((s) => isRecord(s) && s.slot === slot && typeof s.reference === 'string') : undefined; return isRecord(found) ? found.reference as string : undefined; };
  return bound('recomposition_run') ?? bound('recomposition_result') ?? bound('subject') ?? null;
}
const lineageKey = (run: Record<string, unknown>) => lineageKeyOf(run.sources);
/** The Hub's run-successors@1 answer for `run`: the runs started from it that the reader may export. */
function parseSuccessors(value: unknown, run: string): Array<{ run: string; pack: string; started_at: string; parameters: Record<string, unknown>; sources: unknown }> {
  if (!isRecord(value) || value.schema !== 'run-successors@1' || value.run !== run || !Array.isArray(value.successors)) failCall('temporarily_unavailable', `Hub 返回的后续脚本编写和上机验证信息不完整`, '请维护者核对原运行导出协议与完整性后重试');
  return value.successors.map((r) => {
    if (!isRecord(r) || typeof r.run !== 'string' || !RUN_ID.test(r.run) || typeof r.pack !== 'string' || typeof r.started_at !== 'string' || !isRecord(r.parameters) || !Array.isArray(r.sources)) failCall('temporarily_unavailable', `Hub 返回的后续脚本编写和上机验证信息不完整`, '请维护者核对原运行导出协议与完整性后重试');
    return { run: r.run, pack: r.pack, started_at: r.started_at, parameters: r.parameters, sources: r.sources };
  });
}
/** The answer the model gives the person, made here: where the delivery is, the counts, one line a case, what the results rest on, and the paths. */
export function replyText(out: string, totals: Record<string, number>, files: string[], cases: CaseOutcome[] = [], input?: ReportInput): string {
  const scopeLine = input?.scope
    ? [`范围：共 ${input.scope.totalCases} 条原始用例，本次 ${input.assembly.totals.cases} 条，另有 ${input.scope.outOfScope.length} 条未纳入（见交付报告）。`]
    : [];
  const counted = (Object.keys(STATUS) as Status[]).filter((status) => (totals[status] ?? 0) > 0).map((status) => `${STATUS[status]} ${totals[status]} 条`);
  const result = `结果：${totals.cases} 条原始用例${counted.length ? `，${counted.join('，')}` : ''}。`;
  const note = input && cases.some((outcome) => outcome.history.length) ? [`说明：${OBSERVATION_NOTE}`] : [];
  return [`交付目录：${out}`, ...scopeLine, result, ...(input ? cases.map((outcome) => `- ${caseConclusion(input, outcome)}`) : []), ...note, '文件：', ...files.map((name) => `- ${join(out, name)}`)].join('\n');
}

/**
 * What the Hub recorded for item `id` in a plan run's latest accepted result, on a requirement of the plan, not the workbook's (a
 * plan run has no workbook yet): pending on a data gap with a request to a named audience (a missing fact), or else no accepted
 * plan after the repair rounds were used up (the result's `rounds` says used is not below max, and the item was handed in as an
 * authored plan). Null for anything else, including a run with no accepted submission and a case handed in as skipped: a
 * declared skip is a written claim, never an authored attempt, however many rounds the other items of the run used.
 */
export function missingFactOf(exported: unknown, run: string, id: string): MissingFact | null {
  if (!isRecord(exported) || exported.schema !== 'run-export@1' || !isRecord(exported.run) || exported.run.run !== run || !isRecord(exported.result) || exported.result.run !== run || !isRecord(exported.result.partitions)) return null;
  for (const entries of Object.values(exported.result.partitions)) for (const entry of Array.isArray(entries) ? entries : []) {
    if (!isRecord(entry) || entry.item !== id || !Array.isArray(entry.requirements)) continue;
    const basis = caseBasisOf(exported, run, id);
    const dataGaps = basis?.gaps.filter(gap => gap.requirement !== 'workbook_verified' && (gap.attribution === 'data_gap' || gap.reason === 'missing_input') && typeof gap.missing === 'string' && isRecord(gap.exit) && gap.exit.action === 'request') ?? [];
    if (dataGaps.length) return { kind: 'data_gap', plan_run: run, requirement: dataGaps[0].requirement, missing: dataGaps.map(gap => gap.missing).join('；'), gaps: dataGaps.map(gap => ({ missing: gap.missing!, ...(gap.reason ? { reason: gap.reason } : {}), exit: gap.exit })), exit: dataGaps[0].exit, attributions: [...new Set(['data_gap' as const, ...(basis?.attributions ?? [])])] };
    // "The repair rounds were used up" is the run's own counter, not the reason alone: the Hub marks a requirement that has no
    // repair rounds of its own (the plan slot) repair_exhausted the first time an item is handed in as skipped, so in run 20 a
    // case declared skipped once, with every round still unused, already carried that reason.
    const rounds = isRecord(exported.result.rounds) ? exported.result.rounds : null;
    const spent = !!rounds && Number.isSafeInteger(rounds.used) && Number.isSafeInteger(rounds.max) && (rounds.used as number) >= (rounds.max as number);
    // The counter is the run's, not the item's: in run 20 the other item's repair used a round while this one was declared
    // skipped in every submission. The Hub's record tells the two apart: a skipped item's entry carries skip_reason and its
    // other requirements the reason declared_skip.
    const skipped = entry.skip_reason !== undefined || entry.requirements.some((r) => isRecord(r) && Array.isArray(r.layers) && r.layers.some((l) => isRecord(l) && l.reason === 'declared_skip'));
    for (const requirement of spent && !skipped ? entry.requirements : []) {
      if (!isRecord(requirement) || typeof requirement.requirement !== 'string' || requirement.requirement === 'workbook_verified' || requirement.status === 'satisfied' || !Array.isArray(requirement.layers)) continue;
      const layer = requirement.layers.find((l) => isRecord(l) && l.reason === 'repair_exhausted');
      if (isRecord(layer)) return { kind: 'repair_exhausted', plan_run: run, requirement: requirement.requirement, missing: typeof layer.missing === 'string' ? layer.missing.trim() : '' };
    }
  }
  return null;
}
/** The slots a round counts: the plan as authored, without the audit verdict it carries (auditing the same plan again is no new round). */
function withoutAudit(slots: unknown): unknown {
  if (!isRecord(slots)) return slots;
  const strip = (entry: unknown) => (isRecord(entry) && isRecord(entry.data) && Object.hasOwn(entry.data, 'fidelity') ? { ...entry, data: Object.fromEntries(Object.entries(entry.data).filter(([key]) => key !== 'fidelity')) } : entry);
  return { ...slots, ...(slots.plan !== undefined ? { plan: Array.isArray(slots.plan) ? slots.plan.map(strip) : strip(slots.plan) } : {}) };
}
/** A case's plan in a plan run, as its digest: the slots the model submitted for it (a rerun of the same plan has the same digest). */
export function planDigest(plan: RunInputs, autoid: string): string | null {
  const item = (plan.run.items as unknown[] ?? []).find((i) => autoidOf(i) === autoid);
  const id = isRecord(item) ? item.id : undefined;
  const entry = Array.isArray(plan.submission.items) ? plan.submission.items.find((s) => isRecord(s) && s.item === id) : undefined;
  return isRecord(entry) && id !== undefined && isRecord(entry.slots) && entry.slots.plan !== undefined ? sha256(canonicalJson(withoutAudit(entry.slots))) : null;
}

class CitationUnavailable extends Error {}
// A whole knowledge root uses the run download's larger response limit.
async function knowledgeBatch(origin: string, bearer: string, run: string, retry?: RetryControl): Promise<Uint8Array> {
  let bytes: Uint8Array;
  let digest: string | null;
  try {
    ({ bytes, digest } = await fetchBytesRetrying(`${origin}/run-export/${run}/knowledge`, bearer, KNOWLEDGE_MAX_BYTES, {
      ...retry,
      timeoutMs: retry?.timeoutMs ?? KNOWLEDGE_TIMEOUT_MS,
      oversizeMessage: '手册和命令树超过可读取的大小，原始用例与手册冲突的判断尚未核对',
    }));
  } catch (error) {
    throw new CitationUnavailable(error instanceof HubReplyError && error.status === 404
      ? 'Hub 无法读取脚本编写时使用的手册和命令树，原始用例与手册冲突的判断尚未核对'
      : '尚未取得可用于逐字核对的手册和命令树，缺少来源读取结果；本次不判断该模型主张真假');
  }
  if (!digest || digest !== sha256(bytes)) failCall('temporarily_unavailable', '手册和命令树与保存的原件不一致，原始用例与手册冲突的判断尚未核对', '请维护者按原摘要恢复可信原件，再核验引文');
  return bytes;
}
async function citedStatements(origin: string, bearer: string, cited: ReadonlySet<string>, planRuns: readonly string[], rootOf: (run: string) => unknown, retry?: RetryControl): Promise<{ statements: Map<string, string>; unavailable: Map<string, string> }> {
  const unavailable = new Map<string, string>();
  const statements = new Map<string, string>();
  const roots = new Set([...cited].flatMap((reference) => { const root = /^tree:([0-9a-f]{64})\//.exec(reference)?.[1]; return root ? [root] : []; }));
  for (const root of roots) {
    const holder = [...planRuns].reverse().find((run) => rootOf(run) === root);
    if (!holder) continue;
    let bytes: Uint8Array;
    try { bytes = await knowledgeBatch(origin, bearer, holder, retry); }
    catch (error) {
      if (!(error instanceof CitationUnavailable)) throw error;
      for (const reference of cited) if (reference.startsWith(`tree:${root}/`)) unavailable.set(reference, error.message);
      continue;
    }
    const batch = lockedStatements(bytes, holder, cited);
    if (batch.root !== root) failCall('temporarily_unavailable', `手册和命令树与脚本编写时使用的构建不一致，原始用例与手册冲突的判断尚未核对`, '请维护者核对冻结构建、根身份与原件摘要后重试');
    for (const [reference, statement] of batch.statements) statements.set(reference, statement);
  }
  return { statements, unavailable };
}

export async function main(argv: string[], readToken: () => Promise<string> = readTokenFromStdin, now: () => Date = () => new Date(), retry?: RetryControl): Promise<number> {
  try {
    const args = options(argv);
    const runs = [...new Set(args.runs.split(',').map((v) => v.trim()).filter(Boolean))];
    if (!runs.length || runs.some((run) => !RUN_ID.test(run)) || (args.recompose !== undefined && !RUN_ID.test(args.recompose))) failCall('invalid_parameters', '--runs 请按上机验证的先后顺序填写编号，以逗号分隔；--recompose 请填写用例重组的编号', '请核对运行、范围、产物身份和原始输入，修正后重试');
    // The notes are model-authored input: a parse failure identifies the file and repair action, as
    // submit-plans does for a case file (in run 20 the shared reader's answer told the model to export the run's input again).
    const notesValue = parsedPlanFile(`说明文件 ${basename(args.notes)}`, await readSubmittedFileBytes(args.notes, 'notes'));
    await emptyOrAbsent(args.out);
    const origin = parseHubOrigin(args.hub);
    const bearer = await requireBearerToken(readToken);
    const sourceRetry = downloadRetryControl(args.out, retry);

    const jobsOf = async (run: string) => parseRunJobs(hubDocument(await getRetrying(`${origin}/run-export/${run}/jobs`, bearer, retry)), run);
    const successorsOf = async (run: string) => parseSuccessors(hubDocument(await getRetrying(`${origin}/run-export/${run}/successors`, bearer, retry)), run);
    const plans = new Map<string, RunInputs>();
    const planOf = async (run: string) => { if (!plans.has(run)) plans.set(run, await fetchRunInputs(origin, bearer, run, sourceRetry)); return plans.get(run)!; };
    const given = new Map<string, Dispatch>();
    const unsent: Unsent[] = [];
    for (const run of runs) {
      const jobs = await jobsOf(run);
      // the same rule as the lineage walk below: a run none of whose jobs went to the bed is no run of the cases; it is disclosed, not refused.
      if (neverReachedBed(run, jobs)) { unsent.push(unsentOf(run, jobs)); continue; }
      given.set(run, settledDispatch(run, jobs));
    }

    // The runs named are where the walk starts, not the whole list: every verification run of the same compilation (plan runs
    // under the same booking bound to the same recomposition, or the same document without one) is read from the Hub's lineage,
    // so a dispatch the model left out still counts (decision 162).
    const keys = new Set<string>(), roots = new Set<string>(), started = new Map<string, string>(), planRuns = new Map<string, string>();
    const runOf = async (run: string): Promise<Record<string, unknown>> => {
      const exported = hubDocument(await getRetrying(`${origin}/run-export/${run}/run`, bearer, retry));
      if (!isRecord(exported) || exported.schema !== 'run-export@1' || !isRecord(exported.run) || exported.run.run !== run) failCall('temporarily_unavailable', 'Hub 元数据不属于所请求的运行', '请维护者核对导出的运行身份后重试');
      return exported.run;
    };
    const ours = (run: Record<string, unknown> | null, key: string) => !!run && typeof run.pack === 'string' && run.pack.split('@')[0] === 'case-compile' && lineageKey(run) === key;
    for (const d of [...given.values(), ...unsent]) { const key = lineageKey((await planOf(d.plan_run)).run as Record<string, unknown>); if (key) keys.add(key); }
    if (keys.size !== 1) failCall('invalid_parameters', '--runs 中的自动化用例不是来自同一份重组后的用例或原始用例，请只选择这份原始用例的上机验证', '请核对运行、范围、产物身份和原始输入，修正后重试');
    const [key] = keys;
    // Up: a rework's plan run may name the booking or the verification run before it as predecessor (run 12 did the first, run 14
    // the second), so the walk climbs while the predecessor is a run of this compilation and starts below the first one that is not.
    for (const d of [...given.values(), ...unsent]) {
      let current = (await planOf(d.plan_run)).run as Record<string, unknown>;
      for (let hops = 0; typeof current.predecessor === 'string' && hops < 200; hops++) {
        const up = await runOf(current.predecessor);
        if (!ours(up, key)) { roots.add(current.predecessor); break; }
        current = up!;
      }
    }
    // Down: every case-compile run of this compilation under those roots; the verification runs among them are the dispatches.
    const queue = [...roots], visited = new Set<string>();
    while (queue.length) {
      const run = queue.shift()!; if (visited.has(run)) continue; visited.add(run);
      for (const next of await successorsOf(run)) {
        if (next.pack.split('@')[0] !== 'case-compile' || lineageKeyOf(next.sources) !== key) continue;
        if (typeof next.parameters.plan_run === 'string') started.set(next.run, next.started_at); else planRuns.set(next.run, next.started_at);
        queue.push(next.run);
      }
    }
    for (const run of [...given.keys(), ...unsent.map(u => u.run)]) if (!started.has(run)) { const exported = hubDocument(await getRetrying(`${origin}/run-export/${run}/run`, bearer, retry)); started.set(run, isRecord(exported) && isRecord(exported.run) && typeof exported.run.started_at === 'string' ? exported.run.started_at : ''); }
    const dispatches: Dispatch[] = [], added: string[] = [];
    for (const run of [...started.keys()].sort((a, b) => (started.get(a)! < started.get(b)! ? -1 : started.get(a)! > started.get(b)! ? 1 : a < b ? -1 : 1))) {
      if (given.has(run)) { dispatches.push(given.get(run)!); continue; }
      const jobs = await jobsOf(run);
      // Verified but never sent to the bed: no job, or only jobs that ended before anything went out (not_dispatched, as when a
      // pre-dispatch check failed); like the reference engine, a dispatch that never reached the bed is not a run of the cases.
      if (neverReachedBed(run, jobs)) { if (!unsent.some((u) => u.run === run)) unsent.push(unsentOf(run, jobs)); continue; }
      if (!jobs.some((job) => job.verification_run === run)) continue;
      dispatches.push(settledDispatch(run, jobs)); added.push(run);
    }
    unsent.sort((a,b) => {
      const left = started.get(a.run) ?? '', right = started.get(b.run) ?? '';
      return left < right ? -1 : left > right ? 1 : a.run < b.run ? -1 : a.run > b.run ? 1 : 0;
    });
    for (const d of [...dispatches, ...unsent]) await planOf(d.plan_run);

    // Every verification run and its plan run must carry the exact same frozen Hub parameters.scope; midway scope changes
    // require a fresh start_run rather than merging runs from different scopes.
    const scopedRuns: Array<{ run: string; scope: FrozenScope | null; key: string }> = [];
    for (const d of [...dispatches, ...unsent]) {
      const planScope = frozenScopeOf(plans.get(d.plan_run)!.run, d.plan_run);
      scopedRuns.push({ run: d.plan_run, scope: planScope, key: canonicalScopeKey(planScope) });
      const verifRecord = await runOf(d.run);
      if (verifRecord) {
        const verifScope = frozenScopeOf(verifRecord, d.run);
        scopedRuns.push({ run: d.run, scope: verifScope, key: canonicalScopeKey(verifScope) });
      }
    }
    const distinctScopes = new Map<string, string>();
    for (const entry of scopedRuns) {
      if (!distinctScopes.has(entry.key)) distinctScopes.set(entry.key, entry.run);
    }
    if (distinctScopes.size > 1) {
      const summary = [...distinctScopes.entries()]
        .map(([encoded, run]) => {
          if (encoded === 'null') return `${run}（未设 parameters.scope）`;
          const parsed = JSON.parse(encoded) as { words: string; cases: string[] };
          return `${run}（scope="${parsed.words}"，[${parsed.cases.join('、')}]）`;
        })
        .join(' 与 ');
      failCall('invalid_parameters', `所选运行的冻结 parameters.scope 不一致（${summary}），不能合并交付。中途改范围须用 start_run 重开运行；请只选择相同 parameters.scope 的上机验证后重试`, '请核对运行、范围、产物身份和原始输入，修正后重试');
    }
    const activeScope = scopedRuns[0]?.scope ?? null;

    // The document's cases: the recomposition run's, or else every case, exclusion and frozen out-of-scope entry from plan runs.
    const originals: Record<string, Original> = {}; let population: string[] = [];
    if (args.recompose) {
      const exported = hubDocument(await getRetrying(`${origin}/run-export/${args.recompose}/run`, bearer, retry));
      if (!isRecord(exported) || exported.schema !== 'run-export@1' || !isRecord(exported.run) || exported.run.run !== args.recompose || !Array.isArray(exported.run.items)) failCall('invalid_parameters', 'Hub 返回的重组后的用例不完整或与本次用例重组不符', '请核对运行、范围、产物身份和原始输入，修正后重试');
      for (const item of exported.run.items) { const read = isRecord(item) ? atomOriginal(item) : null; if (!read) failCall('invalid_parameters', '重组后的用例缺少原始用例 ID 或原句', '请核对运行、范围、产物身份和原始输入，修正后重试'); population.push(read.autoid); originals[read.autoid] = read.original; }
      if (activeScope) {
        const rGroups = Array.isArray(exported.run.groups) ? exported.run.groups : [];
        const rScope = rGroups.find((g): g is Record<string, unknown> => isRecord(g) && g.kind === 'recompose-scope@1' && isRecord(g.scope))?.scope as Record<string, unknown> | undefined;
        const rOut = rScope && Array.isArray(rScope.out_of_scope) ? rScope.out_of_scope : [];
        for (const entry of rOut) {
          if (!isRecord(entry) || typeof entry.autoid !== 'string' || !entry.autoid) continue;
          const titleText = typeof entry.title === 'string' ? entry.title : '';
          if (!originals[entry.autoid] && titleText) originals[entry.autoid] = { title: titleText, lines: [] };
          if (!population.includes(entry.autoid)) population.push(entry.autoid);
        }
      }
    }
    const excluded = [...new Set([...plans.values()].flatMap((p) => excludedOf(p.run)))];
    for (const d of [...dispatches, ...unsent]) for (const item of (plans.get(d.plan_run)!.run.items as unknown[]) ?? []) {
      const autoid = autoidOf(item); if (!autoid || !isRecord(item)) continue;
      const original = planOriginal(item); if (original) originals[autoid] = original;
      if (!args.recompose && !population.includes(autoid)) population.push(autoid);
    }
    if (activeScope) {
      for (const p of plans.values()) {
        const groups = Array.isArray(p.run.groups) ? p.run.groups : [];
        const gScope = groups.find((g): g is Record<string, unknown> => isRecord(g) && g.kind === 'case-compile' && isRecord(g.scope))?.scope as Record<string, unknown> | undefined;
        const groupOut = gScope && Array.isArray(gScope.out_of_scope) ? gScope.out_of_scope : [];
        for (const entry of groupOut) {
          if (!isRecord(entry) || typeof entry.autoid !== 'string' || !entry.autoid) continue;
          const titleText = typeof entry.title === 'string' ? entry.title : '';
          if (!originals[entry.autoid] && titleText) originals[entry.autoid] = { title: titleText, lines: [] };
          if (!population.includes(entry.autoid)) population.push(entry.autoid);
        }
      }
    }
    if (!args.recompose) for (const autoid of excluded) if (!population.includes(autoid)) population.push(autoid);
    population = population.filter((v, k, all) => all.indexOf(v) === k);

    if (activeScope) {
      const missingFromDoc = activeScope.cases.filter((autoid) => !population.includes(autoid));
      if (missingFromDoc.length) {
        failCall('invalid_parameters', `Hub 运行记录中的 parameters.scope 包含不在本次文档原始用例里的编号：${missingFromDoc.join('、')}。请核对运行参数与文档后重试`, '请核对运行、范围、产物身份和原始输入，修正后重试');
      }
      const allowed = new Set(activeScope.cases);
      for (const d of [...dispatches, ...unsent]) {
        const extra = d.items.filter((autoid) => !allowed.has(autoid));
        if (extra.length) {
          failCall('invalid_parameters', `上机验证 ${d.run} 包含未纳入本次 parameters.scope 的原始用例 ${extra.join('、')}。请核对运行范围并重新用 start_run 编写与上机后重试`, '请核对运行、范围、产物身份和原始输入，修正后重试');
        }
      }
    }
    const scopeSet = activeScope ? new Set(activeScope.cases) : null;
    const inScope = scopeSet ? population.filter((autoid) => scopeSet.has(autoid)) : population;
    const outOfScopeCases: OutOfScopeCase[] = scopeSet
      ? population.filter((autoid) => !scopeSet.has(autoid)).map((autoid) => ({ autoid, title: originals[autoid]?.title ?? '标题未知' }))
      : [];
    const scopeSummary: ScopeSummary | undefined = activeScope
      ? { words: activeScope.words, cases: activeScope.cases, outOfScope: outOfScopeCases, totalCases: population.length }
      : undefined;

    const inputsOf = (plan: RunInputs) => ({ run: plan.run, result: plan.result, submission: plan.submission, contract: plan.originals.contract, profile: plan.originals.profile, inventory: plan.originals.inventory });
    const recipesOf = (plan: RunInputs) => satisfiedRecipes(inputsOf(plan));
    // A dispatch's scope is the generated workbook's scope; rows cannot silently name only part of that file.
    const workbookBindings = new Map<string, { sha256: string; autoids: string[] }>();
    for (const dispatch of [...dispatches, ...unsent]) {
      let binding = workbookBindings.get(dispatch.plan_run);
      if (!binding) {
        const recipes = recipesOf(plans.get(dispatch.plan_run)!);
        binding = { sha256: sha256(generateWorkbookSet(recipes)), autoids: recipes.map(recipe => String(recipe.fields.autoid)).sort() };
        workbookBindings.set(dispatch.plan_run, binding);
      }
      if (canonicalJson(binding.autoids) !== canonicalJson([...dispatch.items].sort())) failCall('temporarily_unavailable', '上机验证用例清单与其实际工作簿的完整用例清单不一致，交付物尚未写入', '请维护者核对派发工作簿、逐条结果和脚本编写运行绑定，恢复一致的原始记录后重试');
      if (dispatch.sha256 !== binding.sha256) failCall('temporarily_unavailable', '上机验证工作簿摘要与其脚本编写结果不一致，交付物尚未写入', '请维护者核对派发产物与原脚本编写结果，恢复对应的原始工作簿和记录后重试');
    }

    // The reference engine's pass review (functions/delivery.ts failureLine): a pass whose words carry an execution-failure line
    // that the case's own assertions do not read is no verdict. The markers are the contract declaration of each dispatch's plan
    // run; the words are the run log the Hub saved for the row, checked against its digest (the reference engine reads only
    // the run log of a pass).
    const texts = new Map<string, string | null>();
    const textOf = async (run: string, reference: string): Promise<string | null> => {
      const found = /^src:([0-9a-f]{64})$/.exec(reference); if (!found) return null;
      if (!texts.has(found[1])) { try { const bytes = await getRetrying(`${origin}/run-export/${run}/sources/${found[1]}`, bearer, sourceRetry); if (sha256(bytes) !== found[1]) failCall('temporarily_unavailable', '设备输出原件的字节与摘要不一致', '请维护者恢复与原摘要一致的字节后重试'); texts.set(found[1], new TextDecoder('utf-8').decode(bytes)); } catch (error) { if (error instanceof CallFailure) throw error; texts.set(found[1], null); } }
      return texts.get(found[1]) ?? null;
    };
    const hits = new Map<string, RowAudit>(), missingOutputs = new Set<string>(); let markerCount: number | null = null, read = 0, wordless = 0;
    for (const d of dispatches) {
      const { markers, assertions: assertionsOf } = passReviewInputs(inputsOf(plans.get(d.plan_run)!));
      if (!markers.length) continue;
      markerCount = Math.max(markerCount ?? 0, markers.length);
      for (const row of d.rows) {
        if (row.dynamic_terminal !== 'pass') continue;
        const text = row.evidence?.log ? await textOf(d.run, row.evidence.log) : null;
        if (text === null) { wordless++; missingOutputs.add(auditKey(d.run,row.item)); continue; }
        read++;
        const hit = failureLine({ 运行日志: text }, markers, assertionsOf.get(row.item) ?? []);
        if (hit) hits.set(auditKey(d.run, row.item), hit);
      }
    }
    const audited = auditPasses(dispatches, hits).map(d => ({ ...d, rows: d.rows.map(row => missingOutputs.has(auditKey(d.run, row.item)) ? {
      ...row, reported_terminal: row.dynamic_terminal, dynamic_terminal: 'no_verdict',
      missing_fact: '缺少已声明执行失败规则所需的完整设备输出，交付资格尚未核验；请从原作业补齐原件后重评',
    } : row) }));
    dispatches.splice(0, dispatches.length, ...audited);
    // A run that stopped in a case (functions/delivery.ts unexecutedRows): the cases after the one whose log ends in the runner's
    // exception never began, and the Hub's no verdict for them is no device observation. They are marked here, so that the assembly
    // keeps them out of the case's attempts; the log of the case that ended the run is read only when cases stand after it.
    const reached = (row: JobRow) => Boolean(row.evidence?.log) || Object.keys(row.evidence?.sessions ?? {}).length > 0;
    for (const [k, d] of dispatches.entries()) {
      const tail = trailingUnreached(d.items, d.rows.map((row) => ({ item: row.item, reached: reached(row) })));
      if (!tail) continue;
      const reference = d.rows.find((row) => row.item === tail.last)?.evidence?.log;
      const found = unexecutedAfter(tail, reference ? await textOf(d.run, reference) : null, (item) => originals[item]?.title);
      if (found.size) dispatches[k] = { ...d, rows: d.rows.map((row) => found.has(row.item) ? { ...row, dynamic_terminal: 'not_run', not_executed: found.get(row.item)! } : row) };
    }
    // When no dispatch counts as a whole-volume pass, the pass review may be why: the refusal then names the passes it turned
    // into no verdict and the line that did it (in run 20 the tool only listed the passes that stood, and the model had to find
    // the missing one and its line by itself).
    const assembly = assemble(inScope, dispatches);
    const undelivered = assembly.cases.filter((c) => c.status !== 'delivered').map((c) => c.autoid);
    const notes = readNotes(notesValue, undelivered);
    const unissuedPlans = assembly.cases.filter(c => c.status === 'unrun' && (unsent.some(u => u.items.includes(c.autoid)) || c.not_executed?.length));
    if (unissuedPlans.length) {
      const volume = assembly.unsuccessful ?? { items: [], sources: {} };
      for (const outcome of unissuedPlans) {
        // the dispatch that held the case without reaching it, or else the one that never went out
        const source = outcome.not_executed?.at(-1) ?? unsent.filter(u => u.items.includes(outcome.autoid)).at(-1)!;
        if (!volume.items.includes(outcome.autoid)) volume.items.push(outcome.autoid);
        volume.sources[outcome.autoid] = { plan_run: source.plan_run, run: source.run };
      }
      volume.items.sort((a,b) => inScope.indexOf(a) - inScope.indexOf(b));
      assembly.unsuccessful = volume;
    }

    // The unsuccessful volume carries the last accepted authored content, even if its verification never reached the bed.
    if (assembly.unsuccessful) {
      const latest = [...planRuns.keys()].sort((a,b) => (planRuns.get(a)! > planRuns.get(b)! ? -1 : planRuns.get(a)! < planRuns.get(b)! ? 1 : a > b ? -1 : 1));
      const selected = new Set<string>();
      for (const run of latest) {
        let plan: RunInputs;
        try { plan = await planOf(run); }
        catch (error) { if (error instanceof HubReplyError && (error.status === 409 || error.status === 404)) continue; throw error; }
        const ids = (plan.run.items as unknown[]).map(autoidOf);
        if (!assembly.unsuccessful.items.some(id => !selected.has(id) && ids.includes(id))) continue;
        if (canonicalScopeKey(frozenScopeOf(plan.run, run)) !== canonicalScopeKey(activeScope)) failCall('invalid_parameters', '最近受理的写法与本次冻结范围不一致，不能混入未成功卷', '请选择同一冻结范围的编译运行，范围变化后重新编写和核验，不用本地参数缩小范围');
        for (const autoid of assembly.unsuccessful.items) {
          if (selected.has(autoid) || !ids.includes(autoid)) continue;
          const source = dispatches.filter(d => d.plan_run === run && d.items.includes(autoid)).at(-1) ?? unsent.filter(d => d.plan_run === run && d.items.includes(autoid)).at(-1);
          assembly.unsuccessful.sources[autoid] = { plan_run: run, run: source?.run ?? null };
          selected.add(autoid);
        }
        if (selected.size === assembly.unsuccessful.items.length) break;
      }
    }


    const outputs: Array<{ name: string; bytes: Uint8Array }> = [];
    let passFile: { sha256: string } | null = null, unsuccessfulFile: { sha256: string } | null = null;
    let passLast: MovedCase[] = [], unsuccessfulLast: MovedCase[] = [];
    if (assembly.pass) {
      const passRecipes = recipesOf(plans.get(assembly.pass.plan_run)!);
      const bytes = generateWorkbookSet(passRecipes);
      if (sha256(bytes) !== assembly.pass.sha256) failCall('invalid_parameters', `重新生成的自动化用例 Excel 与上机验证使用的文件不一致；请使用最近一次一起做上机验证且全部正确的自动化用例 Excel`, '请核对运行、范围、产物身份和原始输入，修正后重试');
      passLast = volumeOrder(passRecipes).moved;
      outputs.push({ name: 'case.xlsx', bytes }); passFile = { sha256: assembly.pass.sha256 };
    }
    if (assembly.unsuccessful) {
      // Each case uses its last accepted authored content; actual device observations stay in history separately.
      const { items, sources } = assembly.unsuccessful;
      const recipes = new Map<string, ReturnType<typeof recipesOf>>();
      const selected = items.map((autoid) => {
        const planRun = sources[autoid].plan_run; const plan = plans.get(planRun)!;
        if (!recipes.has(planRun)) recipes.set(planRun, recipesOf(plan));
        const k = (plan.run.items as unknown[]).findIndex((item) => autoidOf(item) === autoid);
        if (k < 0) failCall('invalid_parameters', `原始用例 ${autoid} ${originals[autoid]?.title ?? '标题未知'} 的自动化用例不在脚本编写结果里，却在上机验证中出现`, '请核对运行、范围、产物身份和原始输入，修正后重试');
        const matching = recipes.get(planRun)!.filter(recipe => String(recipe.fields.autoid) === autoid);
        if (matching.length !== 1) failCall('invalid_parameters', `原始用例 ${autoid} 的最近一次自动化用例缺少唯一可生成的内容`, '请核对原脚本编写结果中的排除、跳过和自动化用例绑定，再重新核验');
        return matching[0];
      });
      const bytes = generateWorkbookSet(selected, { merged: true });
      unsuccessfulLast = volumeOrder(selected).moved;
      outputs.push({ name: 'unsuccessful_cases.xlsx', bytes }); unsuccessfulFile = { sha256: sha256(bytes) };
    }

    const logs: ReportInput['logs'] = {};
    for (const outcome of assembly.cases.filter((c) => c.status !== 'delivered')) {
      const last = outcome.history.at(-1); const found = last?.log ? /^src:([0-9a-f]{64})$/.exec(last.log) : null;
      if (!last || !found) continue;
      try { const bytes = await getRetrying(`${origin}/run-export/${last.run}/sources/${found[1]}`, bearer, sourceRetry); if (sha256(bytes) !== found[1]) failCall('temporarily_unavailable', '设备输出与保存的原件不一致', '请维护者恢复与原摘要一致的设备输出原件后重试'); logs[outcome.autoid] = { reference: last.log!, job: last.job, text: new TextDecoder('utf-8').decode(bytes) }; }
      catch (error) { if (error instanceof CallFailure) throw error; logs[outcome.autoid] = { reference: last.log!, job: last.job, text: null, withheld: error instanceof HubReplyError && error.status === 403 ? '没有读取这份设备输出的权限' : '没有取得已核验的设备输出原件，缺少来源读取结果' }; }
    }
    // The reference engine's attribution rule: a case not delivered that went to the bed is explained with the device's own words,
    // verbatim from its last device output (the runner log or a device session), checked here against the bytes the Hub relays.
    const deviceTexts: Record<string, string[]> = {};
    for (const outcome of assembly.cases.filter((c) => c.status !== 'delivered')) {
      const last = outcome.history.at(-1); if (!last) continue;
      const texts: string[] = []; const logText = logs[outcome.autoid]?.text; if (logText) texts.push(logText);
      for (const reference of Object.values(last.sessions ?? {})) {
        const found = /^src:([0-9a-f]{64})$/.exec(reference); if (!found) continue;
        try { const bytes = await getRetrying(`${origin}/run-export/${last.run}/sources/${found[1]}`, bearer, sourceRetry); if (sha256(bytes) !== found[1]) failCall('temporarily_unavailable', '设备会话原件的字节与摘要不一致', '请维护者恢复与原摘要一致的字节后重试'); texts.push(new TextDecoder('utf-8').decode(bytes)); } catch (error) { if (error instanceof CallFailure) throw error; /* an unreadable session is evidence neither way */ }
      }
      deviceTexts[outcome.autoid] = texts;
    }
    // The reference engine's closing rules: a case that failed, or whose pass the pass review dropped, is reworked until three
    // authored versions of it did not pass on the bed, unless it closes earlier as a verbatim product-defect candidate
    // (closeFailed in functions/delivery.ts). A round is a distinct plan that failed or whose pass was dropped.
    const rounds: Record<string, number> = {};
    for (const outcome of assembly.cases.filter(reworked)) rounds[outcome.autoid] = new Set(outcome.history.filter((h) => h.terminal === 'fail' || h.audit).map((h) => planDigest(plans.get(dispatches[h.ordinal - 1].plan_run)!, outcome.autoid)).filter((digest): digest is string => digest !== null)).size;
    const authored = Object.fromEntries(Object.entries(originals).map(([autoid, original]) => [autoid, original.lines.flatMap((line) => line.expected)]));
    const conflictGround: ConflictGround = {
      authored: Object.fromEntries(Object.entries(originals).map(([autoid, original]) => [autoid, [original.title, ...original.lines.flatMap((line) => [line.text, ...line.expected])].filter((text) => text.length > 0)])),
      ...(await citedStatements(origin, bearer, new Set(Object.values(notes.cases).flatMap((note) => (note.author_conflict ? [note.author_conflict.reference] : []))), [...dispatches, ...unsent].map((d) => d.plan_run), (run) => plans.get(run)?.run.root, sourceRetry)),
    };
    const closed = closeFailed(assembly.cases, notes, rounds, authored, deviceTexts, conflictGround);
    // The reference engine's exits for a case it could not compile: only what its own checks recorded certifies one. A case never
    // dispatched is looked up in the latest plan run of this compilation that holds it and has an accepted result: a plan run
    // opened but never answered judged no plan (closeUnrun in functions/delivery.ts).
    const facts: Record<string, MissingFact> = {};
    const unrun = closed.cases.filter((c) => c.status !== 'delivered').map((c) => c.autoid);
    const bases = new Map<string, NonNullable<ReturnType<typeof caseBasisOf>>>();
    if (unrun.length) {
      const latestFirst = [...planRuns.keys()].sort((a, b) => (planRuns.get(a)! > planRuns.get(b)! ? -1 : planRuns.get(a)! < planRuns.get(b)! ? 1 : a > b ? -1 : 1));
      const itemsOf = new Map<string, unknown[]>();
      for (const run of latestFirst) { try { const record = await runOf(run); itemsOf.set(run, Array.isArray(record?.items) ? record.items : []); } catch (error) { if (error instanceof CallFailure) throw error; itemsOf.set(run, []); } }
      const answered = new Map<string, unknown>();
      for (const autoid of unrun) {
        for (const holder of latestFirst.filter((run) => itemsOf.get(run)!.some((item) => autoidOf(item) === autoid))) {
          const item = itemsOf.get(holder)!.find((i) => autoidOf(i) === autoid);
          if (!isRecord(item) || typeof item.id !== 'string') continue;
          if (!answered.has(holder)) { let exported: unknown = null; try { exported = hubDocument(await getRetrying(`${origin}/run-export/${holder}`, bearer, retry)); } catch (error) { if (error instanceof CallFailure) throw error; /* no accepted submission */ } if (exported !== null && (!isRecord(exported) || exported.schema !== 'run-export@1' || !isRecord(exported.run) || exported.run.run !== holder || !isRecord(exported.result) || exported.result.run !== holder)) failCall('temporarily_unavailable', 'Hub 接受结果不属于所请求的脚本编写运行', '请维护者核对运行身份与接受结果绑定后重试'); answered.set(holder, exported); }
          const exported = answered.get(holder);
          if (!isRecord(exported) || !isRecord(exported.result)) continue; // never answered: no plan was judged there
          const basis = caseBasisOf(exported, holder, item.id); if (basis) bases.set(autoid, basis);
          const fact = missingFactOf(exported, holder, item.id); if (fact) facts[autoid] = fact;
          break;
        }
      }
    }
    // the plan run's own pending workbook step says nothing about a case that went to the bed: its workbook was verified and dispatched,
    // whether or not the run reached the case.
    const basisFor = (outcome: { autoid: string; history: unknown[]; not_executed?: unknown[] }) => {
      const found = bases.get(outcome.autoid); if (!found) return undefined;
      if (!outcome.history.length && !outcome.not_executed?.length) return found;
      const gaps = found.gaps.filter((gap) => gap.requirement !== 'workbook_verified');
      return gaps.length ? { ...found, gaps, attributions: [...new Set(gaps.flatMap((gap) => gap.attribution ? [gap.attribution] : []))] } : undefined;
    };
    const settled = closeUnrun(closed.cases.map(outcome => ({ ...outcome, ...(basisFor(outcome) ? { basis: basisFor(outcome) } : {}) })), facts, notes, conflictGround);
    assembly.cases = settled.cases.map(outcome => {
      const note = notes.cases[outcome.autoid];
      const problems = evidenceProblems({ ...notes, cases: note ? { [outcome.autoid]: note } : {} }, { [outcome.autoid]: deviceTexts[outcome.autoid] ?? [] });
      return problems.length ? { ...outcome, closing: undefined, evidence_unverified: true as const, pending: [...(outcome.pending ?? []), ...problems] } : outcome;
    });
    const lastPlan = plans.get((assembly.pass ?? dispatches.at(-1) ?? unsent.at(-1)!).plan_run)!.run;
    // The working card supplies verbatim scoped rulings, never a replacement for frozen Hub scope or a prose classifier.
    const userRulings:NonNullable<ReportInput['userRulings']>={};
    if(assembly.cases.some(outcome=>outcome.closing==='author_conflict')){
      const card=await readFile(resolve('scope.md')).catch((error:NodeJS.ErrnoException)=>{if(error.code==='ENOENT')return null;throw error;});
      if(card!==null){
        let words:string;try{words=new TextDecoder('utf-8',{fatal:true}).decode(card);}catch{throw new CallFailure('invalid_parameters','工作卡片 scope.md 不是完整 UTF-8','从原件恢复完整卡片后重试，不从模型说明猜使用者决定');}
        for(const outcome of assembly.cases.filter(value=>value.closing==='author_conflict')){
          const ids=new Set([outcome.autoid]);
          for(const plan of plans.values())for(const item of Array.isArray(plan.run.items)?plan.run.items:[])if(autoidOf(item)===outcome.autoid&&isRecord(item)&&typeof item.id==='string')ids.add(item.id);
          const rulings=extractScopeUserRulings(words,ids,outcome.autoid);
          if(rulings.length)userRulings[outcome.autoid]=rulings.map(row=>({source:'scope.md',...row}));
        }
      }
    }
    // Checkpoints the model wrote itself are read from the Hub's record of the plan run the case's workbook came from.
    const checkpoints: Record<string, ModelCheckpoint[]> = {};
    for (const outcome of assembly.cases) {
      const planRun = assembly.pass?.items.includes(outcome.autoid) ? assembly.pass.plan_run : assembly.unsuccessful?.sources[outcome.autoid]?.plan_run;
      const plan = planRun === undefined ? undefined : plans.get(planRun);
      const item = plan && Array.isArray(plan.run.items) ? plan.run.items.find((entry) => autoidOf(entry) === outcome.autoid) : undefined;
      const found = plan && isRecord(item) && typeof item.id === 'string' ? modelCheckpointsOf(plan.result, item.id) : [];
      if (found.length) checkpoints[outcome.autoid] = found;
    }
    const hints = closingHints(assembly.cases, notes, unsent);
    const input: ReportInput = { ...(Object.keys(userRulings).length?{userRulings}:{}),...(Object.keys(checkpoints).length?{checkpoints}:{}),unsent, name: args.name ?? basename(resolve(args.out)), generatedAt: localMinute(now()), build: typeof lastPlan.build === 'string' ? lastPlan.build : null, assembly, notes, originals, excluded, files: { pass: passFile, unsuccessful: unsuccessfulFile }, logs, passAudit: { markers: markerCount, read, downgraded: hits.size, wordless }, placedLast: { pass: passLast, unsuccessful: unsuccessfulLast }, ...(scopeSummary ? { scope: scopeSummary } : {}) };
    input.artifacts = [...outputs.map(output => output.name), ...Object.values(REPORT_FILES)];
    outputs.push({ name: REPORT_FILES.report, bytes: Buffer.from(deliveryReport(input)) }, { name: REPORT_FILES.unsuccessful, bytes: Buffer.from(unsuccessfulReport(input)) });
    const summary = {
      schema: 'case-delivery@1', generator: GENERATOR, name: input.name, generated_at: now().toISOString(), build: input.build, totals: assembly.totals,
      ...(scopeSummary ? {
        scope: { source: 'hub_run_parameters', words: scopeSummary.words, cases: scopeSummary.cases },
        in_scope_total: inScope.length,
        out_of_scope_total: scopeSummary.outOfScope.length,
        out_of_scope: scopeSummary.outOfScope,
      } : {}),
      dispatches: dispatches.map((d) => ({ run: d.run, job: d.job, plan_run: d.plan_run, sha256: d.sha256, items: d.items })),
      added_runs: added,
      unsent_runs: unsent,
      pass_audit: { markers: markerCount, read, downgraded: [...hits.entries()].map(([key, hit]) => { const [run, item] = key.split('\u0000'); return { run, item, where: hit.where, line: hit.line }; }), wordless },
      pass_volume: assembly.pass ? { file: 'case.xlsx', sha256: assembly.pass.sha256, run: assembly.pass.run, job: assembly.pass.job, plan_run: assembly.pass.plan_run, items: assembly.pass.items, ...(passLast.length ? { moved_tail: passLast } : {}) } : null,
      unsuccessful_volume: assembly.unsuccessful ? { file: 'unsuccessful_cases.xlsx', sha256: unsuccessfulFile!.sha256, items: assembly.unsuccessful.items.map((autoid) => ({ autoid, plan_run: assembly.unsuccessful!.sources[autoid].plan_run, run: assembly.unsuccessful!.sources[autoid].run })), dispatched: false, ...(unsuccessfulLast.length ? { moved_tail: unsuccessfulLast } : {}) } : null,
      hints,
      incomplete: hints.length > 0,
      closings: Object.fromEntries((Object.keys(CLOSING) as Array<keyof typeof CLOSING>).map((closing) => [closing, assembly.cases.filter((c) => c.closing === closing).length])),
      artifacts: input.artifacts,
      cases: assembly.cases.map((c) => ({ autoid: c.autoid, title: originals[c.autoid]?.title ?? null, status: c.status, label: STATUS[c.status], ...(c.closing ? { closing: c.closing, closing_label: CLOSING[c.closing], rounds: c.rounds } : {}), ...(c.missing ? { missing: c.missing } : {}), ...(c.basis ? { basis: c.basis } : {}), ...(notes.cases[c.autoid] ? { model_claims: { ...notes.cases[c.autoid], ...(!c.history.length ? { round: undefined } : {}) } } : {}), ...(c.pending?.length ? { pending: c.pending, reenter: true } : {}), ...(c.not_executed?.length ? { not_executed: c.not_executed } : {}), ...(c.conflict ? { conflict: c.conflict } : {}), ...(userRulings[c.autoid]?.length?{user_rulings:userRulings[c.autoid]}:{}),...(checkpoints[c.autoid]?.length?{model_checkpoints:checkpoints[c.autoid]}:{}), dispatches: c.history.map((h) => ({ run: h.run, job: h.job, terminal: h.terminal, ...(h.report_check ? { report_check: h.report_check } : {}), dynamic_terminal: h.reported_terminal ?? h.terminal, label: terminalLabel(h.terminal), ...(h.audit ? { audit: h.audit } : {}), ...(h.qualifier ? { qualifier: h.qualifier } : {}), ...(h.accepted_as_fact === undefined ? {} : { accepted_as_fact: h.accepted_as_fact }), ...(h.missing_facts ? { missing_facts: h.missing_facts } : {}), ...(h.missing_fact ? { missing_fact: h.missing_fact } : {}), ...(h.next_action ? { next_action: h.next_action } : {}) })) })),
    };
    outputs.push({ name: REPORT_FILES.summary, bytes: json(summary) });

    await emptyOrAbsent(args.out);
    await mkdir(args.out, { recursive: true, mode: 0o700 });
    const written: string[] = []; const files: Record<string, string> = {};
    try { for (const { name, bytes } of outputs) { const path = join(args.out, name); await writeFile(path, bytes, { flag: 'wx', mode: 0o600 }); written.push(path); files[name] = sha256(bytes); } if (canonicalJson(Object.keys(files).sort()) !== canonicalJson(input.artifacts.slice().sort())) failCall('invalid_parameters', '实际写出的文件与报告清单不一致，交付目录已撤回', '请核对运行、范围、产物身份和原始输入，修正后重试'); }
    catch (error) { await Promise.all(written.map((path) => rm(path, { force: true }))); throw error; }
    const out = resolve(args.out);
    process.stdout.write(JSON.stringify({
      out,
      totals: assembly.totals,
      ...(scopeSummary ? { scope: { source: 'hub_run_parameters', words: scopeSummary.words, cases: scopeSummary.cases }, in_scope_total: inScope.length, out_of_scope_total: scopeSummary.outOfScope.length } : {}),
      files,
      runs: dispatches.map((d) => d.run),
      added_runs: added,
      hints,
      reply: replyText(out, assembly.totals, Object.keys(files), assembly.cases, input),
    }) + '\n');
    return hints.length ? 1 : 0;
  } catch (error) { process.stderr.write(formatClientCallError(error) + '\n'); return 1; }
}
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) process.exitCode = await main(process.argv.slice(2));
