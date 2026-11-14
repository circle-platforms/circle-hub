import { realpathSync } from 'node:fs';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatCallError, isRecord } from '../functions/text.ts';
import { generateWorkbookSet, GENERATOR } from '../functions/generate.ts';
import { volumeOrder, type MovedCase } from '../functions/channels.ts';
import { assemble, auditKey, auditPasses, closeFailed, closeUnrun, caseConclusion, CLOSING, deliveryReport, evidenceProblems, failureLine, lockedStatements, parseRunJobs, readNotes, reworked, settledDispatch, STATUS, terminalLabel, unsuccessfulReport, type CaseOutcome, type ConflictGround, type Dispatch, type MissingFact, type Original, type OutOfScopeCase, type ReportInput, type RowAudit, type ScopeSummary } from '../functions/delivery.ts';
import { canonicalJson } from '../functions/canonical-json.ts';
import { hubOrigin, HubReplyError, RUN_ID, sha256, writeNew } from '../functions/generated/skills/run-tools/hub-client/index.ts';
import { fetchBytesRetrying, getRetrying, KNOWLEDGE_MAX_BYTES, KNOWLEDGE_TIMEOUT_MS, readSubmittedFileBytes, readTokenFromStdin, requireBearerToken, RetryExhaustedError, type RetryControl } from '../functions/hub-retry.ts';
import { fetchRunInputs, type RunInputs } from './fetch-run.ts';
import { passReviewInputs, satisfiedRecipes } from './generate-workbook.ts';
import { parsedPlanFile } from './submit-plans.ts';

const OPTIONS = { hub: true, runs: true, notes: true, out: true, recompose: false, name: false } as const;
function options(argv: string[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.startsWith('--') ? argv[i].slice(2) : '';
    if (key === 'scope') {
      throw new Error('参数无效：交付时不允许从本地 --scope 文件收窄范围（按范围交付须在开运行时传入 parameters.scope 锚定到 Hub 运行记录）。参数写法：--hub --runs --notes --out 必填，--recompose --name 可选，每个只写一次');
    }
    if (!Object.hasOwn(OPTIONS, key) || !argv[i + 1] || Object.hasOwn(values, key)) throw new Error('参数写法：--hub --runs --notes --out 必填，--recompose --name 可选，每个只写一次');
    values[key] = argv[i + 1];
  }
  const missing = Object.entries(OPTIONS).filter(([key, required]) => required && !values[key]).map(([key]) => '--' + key);
  if (missing.length) {
    throw new Error(
      `参数无效：缺少参数：${missing.join('、')}${missing.includes('--notes') ? '（--notes 为模型手写的说明 JSON 文件路径）' : ''}。参数写法：--hub --runs --notes --out 必填，--recompose --name 可选，每个只写一次`,
    );
  }
  return values;
}
const json = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const decode = (bytes: Uint8Array) => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
function localTime(date: Date): string { const p = (n: number) => String(n).padStart(2, '0'); return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}`; }
const autoidOf = (item: unknown): string | null => isRecord(item) && isRecord(item.fields) && typeof item.fields.autoid === 'string' ? item.fields.autoid : null;
function excludedOf(run: Record<string, unknown>): string[] { const p = run.parameters; return isRecord(p) && Array.isArray(p.exclude) ? p.exclude.filter((v): v is string => typeof v === 'string') : []; }
interface FrozenScope { words: string; cases: string[] }
function frozenScopeOf(run: Record<string, unknown>, label: string): FrozenScope | null {
  const p = run.parameters;
  if (!isRecord(p) || p.scope === undefined) return null;
  if (Array.isArray(p.exclude) && p.exclude.length > 0) {
    throw new Error(`参数无效：Hub 运行记录 ${label} 同时写入了 parameters.scope 与 parameters.exclude，二者互斥。请重新用 start_run 单独使用其中一项后重试`);
  }
  const raw = p.scope;
  if (!isRecord(raw) || Object.keys(raw).some((k) => k !== 'words' && k !== 'cases') || typeof raw.words !== 'string' || !raw.words.trim() || !Array.isArray(raw.cases) || !raw.cases.length || raw.cases.some((v) => typeof v !== 'string' || !v) || new Set(raw.cases).size !== raw.cases.length) {
    throw new Error(`参数无效：Hub 运行记录 ${label} 中的 parameters.scope 不完整或格式无效。请重新用 start_run 按规范传入 parameters.scope 并完成上机验证后重试`);
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
  const entries = await readdir(directory).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return [] as string[]; throw new Error('--out 无法读取'); });
  if (entries.length) throw new Error(`--out 目录里已有 ${entries.slice(0, 3).join('、')}${entries.length > 3 ? ' 等' : ''}，不覆盖；另选一个新目录`);
}

/** The reference that names a compilation: the recomposition result a plan run is bound to, or else the document it judges. */
function lineageKeyOf(sources: unknown): string | null {
  const bound = (slot: string) => { const found = Array.isArray(sources) ? sources.find((s) => isRecord(s) && s.slot === slot && typeof s.reference === 'string') : undefined; return isRecord(found) ? found.reference as string : undefined; };
  return bound('recomposition_result') ?? bound('subject') ?? null;
}
const lineageKey = (run: Record<string, unknown>) => lineageKeyOf(run.sources);
/** The Hub's run-successors@1 answer for `run`: the runs started from it that the reader may export. */
function parseSuccessors(value: unknown, run: string): Array<{ run: string; pack: string; started_at: string; parameters: Record<string, unknown>; sources: unknown }> {
  if (!isRecord(value) || value.schema !== 'run-successors@1' || value.run !== run || !Array.isArray(value.successors)) throw new Error(`Hub 返回的后续脚本编写和上机验证信息不完整`);
  return value.successors.map((r) => {
    if (!isRecord(r) || typeof r.run !== 'string' || !RUN_ID.test(r.run) || typeof r.pack !== 'string' || typeof r.started_at !== 'string' || !isRecord(r.parameters) || !Array.isArray(r.sources)) throw new Error(`Hub 返回的后续脚本编写和上机验证信息不完整`);
    return { run: r.run, pack: r.pack, started_at: r.started_at, parameters: r.parameters, sources: r.sources };
  });
}
/** The answer the model gives the person, made here so it holds the counts and paths and nothing else. */
export function replyText(out: string, totals: Record<string, number>, files: string[], cases: CaseOutcome[] = [], input?: ReportInput): string {
  const scopeLine = input?.scope
    ? [`范围：本次共 ${input.assembly.totals.cases} / ${input.scope.totalCases} 条原始用例，另有 ${input.scope.outOfScope.length} 条未纳入本次范围（详见交付报告）。`]
    : [];
  return [`交付目录 ${out}`, ...scopeLine, ...(input ? cases.map((outcome) => caseConclusion(input, outcome)) : [`共 ${totals.cases} 条原始用例。`]), ...files.map((name) => `- ${join(out, name)}`)].join('\n');
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
    for (const requirement of entry.requirements) {
      if (!isRecord(requirement) || typeof requirement.requirement !== 'string' || requirement.requirement === 'workbook_verified' || requirement.status === 'satisfied' || !Array.isArray(requirement.layers)) continue;
      const layer = requirement.layers.find((l) => isRecord(l) && l.attribution === 'data_gap' && isRecord(l.exit) && l.exit.action === 'request');
      if (isRecord(layer)) return { kind: 'data_gap', plan_run: run, requirement: requirement.requirement, missing: typeof layer.missing === 'string' ? layer.missing.trim() : '' };
    }
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
export function planDigest(plan: RunInputs, autoid: string): string {
  const item = (plan.run.items as unknown[] ?? []).find((i) => autoidOf(i) === autoid);
  const id = isRecord(item) ? item.id : undefined;
  const entry = Array.isArray(plan.submission.items) ? plan.submission.items.find((s) => isRecord(s) && s.item === id) : undefined;
  return isRecord(entry) && id !== undefined ? sha256(canonicalJson(withoutAudit(entry.slots ?? null))) : `run:${String(plan.run.run)}`;
}

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
    if (error instanceof HubReplyError && error.status === 404) {
      throw new Error(`Hub 无法读取脚本编写时使用的手册和命令树，原始用例与手册冲突的判断尚未核对`);
    }
    if (error instanceof RetryExhaustedError || error instanceof HubReplyError) throw error;
    if (error instanceof Error && error.message === '手册和命令树超过可读取的大小，原始用例与手册冲突的判断尚未核对') throw error;
    throw new Error(`暂时不可用：Hub 尚未返回脚本编写时使用的手册和命令树。请稍后用同一命令重新下载`);
  }
  if (!digest || digest !== sha256(bytes)) throw new Error('手册和命令树与保存的原件不一致，原始用例与手册冲突的判断尚未核对');
  return bytes;
}
async function citedStatements(origin: string, bearer: string, cited: ReadonlySet<string>, planRuns: readonly string[], rootOf: (run: string) => unknown, retry?: RetryControl): Promise<Map<string, string>> {
  const statements = new Map<string, string>();
  const roots = new Set([...cited].flatMap((reference) => { const root = /^tree:([0-9a-f]{64})\//.exec(reference)?.[1]; return root ? [root] : []; }));
  for (const root of roots) {
    const holder = [...planRuns].reverse().find((run) => rootOf(run) === root);
    if (!holder) continue;
    const batch = lockedStatements(await knowledgeBatch(origin, bearer, holder, retry), holder, cited);
    if (batch.root !== root) throw new Error(`手册和命令树与脚本编写时使用的构建不一致，原始用例与手册冲突的判断尚未核对`);
    for (const [reference, statement] of batch.statements) statements.set(reference, statement);
  }
  return statements;
}

export async function main(argv: string[], readToken: () => Promise<string> = readTokenFromStdin, now: () => Date = () => new Date(), retry?: RetryControl): Promise<number> {
  try {
    const args = options(argv);
    const runs = args.runs.split(',').map((v) => v.trim()).filter(Boolean);
    if (!runs.length || runs.some((run) => !RUN_ID.test(run)) || (args.recompose !== undefined && !RUN_ID.test(args.recompose))) throw new Error('--runs 请按上机验证的先后顺序填写编号，以逗号分隔；--recompose 请填写用例重组的编号');
    // The notes are a file the model writes and edits by hand: a break in it is named with its place and the text around it, as
    // submit-plans does for a case file (in run 20 the shared reader's answer told the model to export the run's input again).
    const notesValue = parsedPlanFile(`说明文件 ${basename(args.notes)}`, await readSubmittedFileBytes(args.notes, 'notes'));
    await emptyOrAbsent(args.out);
    const origin = hubOrigin(args.hub);
    const bearer = await requireBearerToken(readToken);

    const jobsOf = async (run: string) => parseRunJobs(JSON.parse(decode(await getRetrying(`${origin}/run-export/${run}/jobs`, bearer, retry))), run);
    const successorsOf = async (run: string) => parseSuccessors(JSON.parse(decode(await getRetrying(`${origin}/run-export/${run}/successors`, bearer, retry))), run);
    const plans = new Map<string, RunInputs>();
    const planOf = async (run: string) => { if (!plans.has(run)) plans.set(run, await fetchRunInputs(origin, bearer, run, retry)); return plans.get(run)!; };
    const given = new Map<string, Dispatch>();
    for (const run of runs) given.set(run, settledDispatch(run, await jobsOf(run)));

    // The runs named are where the walk starts, not the whole list: every verification run of the same compilation (plan runs
    // under the same booking bound to the same recomposition, or the same document without one) is read from the Hub's lineage,
    // so a dispatch the model left out still counts (decision 162).
    const keys = new Set<string>(), roots = new Set<string>(), started = new Map<string, string>(), planRuns = new Map<string, string>();
    const runOf = async (run: string): Promise<Record<string, unknown> | null> => { const exported = JSON.parse(decode(await getRetrying(`${origin}/run-export/${run}/run`, bearer, retry))); return isRecord(exported) && isRecord(exported.run) && exported.run.run === run ? exported.run : null; };
    const ours = (run: Record<string, unknown> | null, key: string) => !!run && typeof run.pack === 'string' && run.pack.split('@')[0] === 'case-compile' && lineageKey(run) === key;
    for (const d of given.values()) { const key = lineageKey((await planOf(d.plan_run)).run as Record<string, unknown>); if (key) keys.add(key); }
    if (keys.size !== 1) throw new Error('--runs 中的自动化用例不是来自同一份重组后的用例或原始用例，请只选择这份原始用例的上机验证');
    const [key] = keys;
    // Up: a rework's plan run may name the booking or the verification run before it as predecessor (run 12 did the first, run 14
    // the second), so the walk climbs while the predecessor is a run of this compilation and starts below the first one that is not.
    for (const d of given.values()) {
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
    for (const run of given.keys()) if (!started.has(run)) { const exported = JSON.parse(decode(await getRetrying(`${origin}/run-export/${run}/run`, bearer, retry))); started.set(run, isRecord(exported) && isRecord(exported.run) && typeof exported.run.started_at === 'string' ? exported.run.started_at : ''); }
    const dispatches: Dispatch[] = [], added: string[] = [];
    for (const run of [...started.keys()].sort((a, b) => (started.get(a)! < started.get(b)! ? -1 : started.get(a)! > started.get(b)! ? 1 : a < b ? -1 : 1))) {
      if (given.has(run)) { dispatches.push(given.get(run)!); continue; }
      const jobs = await jobsOf(run);
      // Verified but never sent to the bed: no job, or only jobs that ended before anything went out (not_dispatched, as when a
      // pre-dispatch check failed); like the reference engine, a dispatch that never reached the bed is not a run of the cases.
      if (!jobs.some((job) => job.verification_run === run && !(job.ended === 'done' && job.outcome === 'not_dispatched'))) continue;
      dispatches.push(settledDispatch(run, jobs)); added.push(run);
    }
    for (const d of dispatches) await planOf(d.plan_run);

    // Every verification run and its plan run must carry the exact same frozen Hub parameters.scope; midway scope changes
    // require a fresh start_run rather than merging runs from different scopes.
    const scopedRuns: Array<{ run: string; scope: FrozenScope | null; key: string }> = [];
    for (const d of dispatches) {
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
      throw new Error(`参数无效：所选运行的冻结 parameters.scope 不一致（${summary}），不能合并交付。中途改范围须用 start_run 重开运行；请只选择相同 parameters.scope 的上机验证后重试`);
    }
    const activeScope = scopedRuns[0]?.scope ?? null;

    // The document's cases: the recomposition run's, or else every case, exclusion and frozen out-of-scope entry from plan runs.
    const originals: Record<string, Original> = {}; let population: string[] = [];
    if (args.recompose) {
      const exported = JSON.parse(decode(await getRetrying(`${origin}/run-export/${args.recompose}/run`, bearer, retry)));
      if (!isRecord(exported) || exported.schema !== 'run-export@1' || !isRecord(exported.run) || exported.run.run !== args.recompose || !Array.isArray(exported.run.items)) throw new Error('Hub 返回的重组后的用例不完整或与本次用例重组不符');
      for (const item of exported.run.items) { const read = isRecord(item) ? atomOriginal(item) : null; if (!read) throw new Error('重组后的用例缺少原始用例 ID 或原句'); population.push(read.autoid); originals[read.autoid] = read.original; }
    }
    const excluded = [...new Set([...plans.values()].flatMap((p) => excludedOf(p.run)))];
    for (const d of dispatches) for (const item of (plans.get(d.plan_run)!.run.items as unknown[]) ?? []) {
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
          if (!args.recompose && !population.includes(entry.autoid)) population.push(entry.autoid);
        }
      }
    }
    if (!args.recompose) for (const autoid of excluded) if (!population.includes(autoid)) population.push(autoid);
    population = population.filter((v, k, all) => all.indexOf(v) === k);

    if (activeScope) {
      const missingFromDoc = activeScope.cases.filter((autoid) => !population.includes(autoid));
      if (missingFromDoc.length) {
        throw new Error(`参数无效：Hub 运行记录中的 parameters.scope 包含不在本次文档原始用例里的编号：${missingFromDoc.join('、')}。请核对运行参数与文档后重试`);
      }
      const allowed = new Set(activeScope.cases);
      for (const d of dispatches) {
        const extra = d.items.filter((autoid) => !allowed.has(autoid));
        if (extra.length) {
          throw new Error(`参数无效：上机验证 ${d.run} 包含未纳入本次 parameters.scope 的原始用例 ${extra.join('、')}。请核对运行范围并重新用 start_run 编写与上机后重试`);
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
    // The reference engine's pass review (functions/delivery.ts failureLine): a pass whose words carry an execution-failure line
    // that the case's own assertions do not read is no verdict. The markers are the contract declaration of each dispatch's plan
    // run; the words are the run log the Hub saved for the row, checked against its digest (the reference engine reads only
    // the run log of a pass).
    const texts = new Map<string, string | null>();
    const textOf = async (run: string, reference: string): Promise<string | null> => {
      const found = /^src:([0-9a-f]{64})$/.exec(reference); if (!found) return null;
      if (!texts.has(found[1])) { try { const bytes = await getRetrying(`${origin}/run-export/${run}/sources/${found[1]}`, bearer, retry); texts.set(found[1], sha256(bytes) === found[1] ? new TextDecoder('utf-8').decode(bytes) : null); } catch { texts.set(found[1], null); } }
      return texts.get(found[1]) ?? null;
    };
    const hits = new Map<string, RowAudit>(); let markerCount: number | null = null, read = 0, wordless = 0;
    for (const d of dispatches) {
      const { markers, assertions: assertionsOf } = passReviewInputs(inputsOf(plans.get(d.plan_run)!));
      if (!markers.length) continue;
      markerCount = Math.max(markerCount ?? 0, markers.length);
      for (const row of d.rows) {
        if (row.dynamic_terminal !== 'pass') continue;
        const text = row.evidence?.log ? await textOf(d.run, row.evidence.log) : null;
        if (text === null) { wordless++; continue; }
        read++;
        const hit = failureLine({ 运行日志: text }, markers, assertionsOf.get(row.item) ?? []);
        if (hit) hits.set(auditKey(d.run, row.item), hit);
      }
    }
    dispatches.splice(0, dispatches.length, ...auditPasses(dispatches, hits));
    // When no dispatch counts as a whole-volume pass, the pass review may be why: the refusal then names the passes it turned
    // into no verdict and the line that did it (in run 20 the tool only listed the passes that stood, and the model had to find
    // the missing one and its line by itself).
    const assembly = (() => {
      try { return assemble(inScope, dispatches); } catch (error) {
        if (!(error instanceof Error) || !hits.size) throw error;
        const told = [...hits.entries()].slice(-5).map(([key, hit]) => `原始用例 ${key.split('\u0000')[1]} ${originals[key.split('\u0000')[1]]?.title ?? '标题未知'} 的设备输出里有一行“${hit.line.length > 160 ? `${hit.line.slice(0, 160)}…` : hit.line}”`);
        throw new Error(`${error.message}。核对设备输出后，以下原始用例状态未知，执行失败原话没有被自动化用例检查：${told.join('；')}。下一步由编写模型检查这行设备输出，或改用不会执行失败的观察，再把自动化用例 Excel 一起做上机验证`);
      }
    })();
    const undelivered = assembly.cases.filter((c) => c.status !== 'delivered').map((c) => c.autoid);
    const notes = readNotes(notesValue, undelivered);

    const outputs: Array<{ name: string; bytes: Uint8Array }> = [];
    let passFile: { sha256: string } | null = null, unsuccessfulFile: { sha256: string } | null = null;
    let passLast: MovedCase[] = [], unsuccessfulLast: MovedCase[] = [];
    if (assembly.pass) {
      const passRecipes = recipesOf(plans.get(assembly.pass.plan_run)!);
      const bytes = generateWorkbookSet(passRecipes);
      if (sha256(bytes) !== assembly.pass.sha256) throw new Error(`重新生成的自动化用例 Excel 与上机验证使用的文件不一致；请使用最近一次一起做上机验证且全部正确的自动化用例 Excel`);
      passLast = volumeOrder(passRecipes).moved;
      outputs.push({ name: 'case.xlsx', bytes }); passFile = { sha256: assembly.pass.sha256 };
    }
    if (assembly.unsuccessful) {
      // Each case goes in as it last went to the bed: its recipe from the plan run of its latest dispatch, merged in document order.
      const { items, sources } = assembly.unsuccessful;
      const recipes = new Map<string, ReturnType<typeof recipesOf>>();
      const selected = items.map((autoid) => {
        const planRun = sources[autoid].plan_run; const plan = plans.get(planRun)!;
        if (!recipes.has(planRun)) recipes.set(planRun, recipesOf(plan));
        const k = (plan.run.items as unknown[]).findIndex((item) => autoidOf(item) === autoid);
        if (k < 0) throw new Error(`原始用例 ${autoid} ${originals[autoid]?.title ?? '标题未知'} 的自动化用例不在脚本编写结果里，却在上机验证中出现`);
        return recipes.get(planRun)![k];
      });
      const bytes = generateWorkbookSet(selected, { merged: true });
      unsuccessfulLast = volumeOrder(selected).moved;
      outputs.push({ name: 'unsuccessful_cases.xlsx', bytes }); unsuccessfulFile = { sha256: sha256(bytes) };
    }

    const logs: ReportInput['logs'] = {};
    for (const outcome of assembly.cases.filter((c) => c.status !== 'delivered')) {
      const last = outcome.history.at(-1); const found = last?.log ? /^src:([0-9a-f]{64})$/.exec(last.log) : null;
      if (!last || !found) continue;
      try { const bytes = await getRetrying(`${origin}/run-export/${last.run}/sources/${found[1]}`, bearer, retry); if (sha256(bytes) !== found[1]) throw new Error('设备输出与保存的原件不一致'); logs[outcome.autoid] = { reference: last.log!, job: last.job, text: new TextDecoder('utf-8').decode(bytes) }; }
      catch (error) { logs[outcome.autoid] = { reference: last.log!, job: last.job, text: null, withheld: error instanceof HubReplyError && error.status === 403 ? '没有读取这份设备输出的权限' : `没有取到：${error instanceof Error ? error.message : '读取失败'}` }; }
    }
    // The reference engine's attribution rule: a case not delivered that went to the bed is explained with the device's own words,
    // verbatim from its last device output (the runner log or a device session), checked here against the bytes the Hub relays.
    const deviceTexts: Record<string, string[]> = {};
    for (const outcome of assembly.cases.filter((c) => c.status !== 'delivered')) {
      const last = outcome.history.at(-1); if (!last) continue;
      const texts: string[] = []; const logText = logs[outcome.autoid]?.text; if (logText) texts.push(logText);
      for (const reference of Object.values(last.sessions ?? {})) {
        const found = /^src:([0-9a-f]{64})$/.exec(reference); if (!found) continue;
        try { const bytes = await getRetrying(`${origin}/run-export/${last.run}/sources/${found[1]}`, bearer, retry); if (sha256(bytes) === found[1]) texts.push(new TextDecoder('utf-8').decode(bytes)); } catch { /* an unreadable session is evidence neither way */ }
      }
      deviceTexts[outcome.autoid] = texts;
    }
    // The reference engine's closing rules: a case that failed, or whose pass the pass review dropped, is reworked until three
    // authored versions of it did not pass on the bed, unless it closes earlier as a verbatim product-defect candidate
    // (closeFailed in functions/delivery.ts). A round is a distinct plan that failed or whose pass was dropped.
    const rounds: Record<string, number> = {};
    for (const outcome of assembly.cases.filter(reworked)) rounds[outcome.autoid] = new Set(outcome.history.filter((h) => h.terminal === 'fail' || h.audit).map((h) => planDigest(plans.get(dispatches[h.ordinal - 1].plan_run)!, outcome.autoid))).size;
    const authored = Object.fromEntries(Object.entries(originals).map(([autoid, original]) => [autoid, original.lines.flatMap((line) => line.expected)]));
    const conflictGround: ConflictGround = {
      authored: Object.fromEntries(Object.entries(originals).map(([autoid, original]) => [autoid, [original.title, ...original.lines.flatMap((line) => [line.text, ...line.expected])].filter((text) => text.length > 0)])),
      statements: await citedStatements(origin, bearer, new Set(Object.values(notes.cases).flatMap((note) => (note.author_conflict ? [note.author_conflict.reference] : []))), dispatches.map((d) => d.plan_run), (run) => plans.get(run)?.run.root, retry),
    };
    const closed = closeFailed(assembly.cases, notes, rounds, authored, deviceTexts, conflictGround);
    // The reference engine's exits for a case it could not compile: only what its own checks recorded certifies one. A case never
    // dispatched is looked up in the latest plan run of this compilation that holds it and has an accepted result: a plan run
    // opened but never answered judged no plan (closeUnrun in functions/delivery.ts).
    const facts: Record<string, MissingFact> = {};
    const unrun = closed.cases.filter((c) => c.status === 'unrun').map((c) => c.autoid);
    if (unrun.length) {
      const latestFirst = [...planRuns.keys()].sort((a, b) => (planRuns.get(a)! > planRuns.get(b)! ? -1 : planRuns.get(a)! < planRuns.get(b)! ? 1 : a > b ? -1 : 1));
      const itemsOf = new Map<string, unknown[]>();
      for (const run of latestFirst) { try { const record = await runOf(run); itemsOf.set(run, Array.isArray(record?.items) ? record.items : []); } catch { itemsOf.set(run, []); } }
      const answered = new Map<string, unknown>();
      for (const autoid of unrun) {
        for (const holder of latestFirst.filter((run) => itemsOf.get(run)!.some((item) => autoidOf(item) === autoid))) {
          const item = itemsOf.get(holder)!.find((i) => autoidOf(i) === autoid);
          if (!isRecord(item) || typeof item.id !== 'string') continue;
          if (!answered.has(holder)) { let exported: unknown = null; try { exported = JSON.parse(decode(await getRetrying(`${origin}/run-export/${holder}`, bearer, retry))); } catch { /* no accepted submission */ } answered.set(holder, exported); }
          const exported = answered.get(holder);
          if (!isRecord(exported) || !isRecord(exported.result)) continue; // never answered: no plan was judged there
          const fact = missingFactOf(exported, holder, item.id); if (fact) facts[autoid] = fact;
          break;
        }
      }
    }
    const settled = closeUnrun(closed.cases, facts, notes, conflictGround);
    const unproven = [...evidenceProblems(notes, deviceTexts), ...closed.problems, ...settled.problems];
    if (unproven.length) throw new Error(unproven.join('；'));
    assembly.cases = settled.cases;
    const lastPlan = plans.get((assembly.pass ?? dispatches.at(-1)!).plan_run)!.run;
    const input: ReportInput = { name: args.name ?? basename(resolve(args.out)), generatedAt: localTime(now()), build: typeof lastPlan.build === 'string' ? lastPlan.build : null, assembly, notes, originals, excluded, files: { pass: passFile, unsuccessful: unsuccessfulFile }, logs, passAudit: { markers: markerCount, read, downgraded: hits.size, wordless }, placedLast: { pass: passLast, unsuccessful: unsuccessfulLast }, ...(scopeSummary ? { scope: scopeSummary } : {}) };
    outputs.push({ name: 'delivery_report.md', bytes: Buffer.from(deliveryReport(input)) }, { name: 'unsuccessful_cases.md', bytes: Buffer.from(unsuccessfulReport(input)) });
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
      pass_audit: { markers: markerCount, read, downgraded: [...hits.entries()].map(([key, hit]) => { const [run, item] = key.split('\u0000'); return { run, item, where: hit.where, line: hit.line }; }), wordless },
      pass_volume: assembly.pass ? { file: 'case.xlsx', sha256: assembly.pass.sha256, run: assembly.pass.run, job: assembly.pass.job, plan_run: assembly.pass.plan_run, items: assembly.pass.items, ...(passLast.length ? { moved_tail: passLast } : {}) } : null,
      unsuccessful_volume: assembly.unsuccessful ? { file: 'unsuccessful_cases.xlsx', sha256: unsuccessfulFile!.sha256, items: assembly.unsuccessful.items.map((autoid) => ({ autoid, plan_run: assembly.unsuccessful!.sources[autoid].plan_run, run: assembly.unsuccessful!.sources[autoid].run })), dispatched: false, ...(unsuccessfulLast.length ? { moved_tail: unsuccessfulLast } : {}) } : null,
      closings: Object.fromEntries((Object.keys(CLOSING) as Array<keyof typeof CLOSING>).map((closing) => [closing, assembly.cases.filter((c) => c.closing === closing).length])),
      cases: assembly.cases.map((c) => ({ autoid: c.autoid, title: originals[c.autoid]?.title ?? null, status: c.status, label: STATUS[c.status], ...(c.closing ? { closing: c.closing, closing_label: CLOSING[c.closing], rounds: c.rounds } : {}), ...(c.missing ? { missing: c.missing } : {}), ...(c.conflict ? { conflict: c.conflict } : {}), dispatches: c.history.map((h) => ({ run: h.run, job: h.job, terminal: h.terminal, label: terminalLabel(h.terminal), ...(h.audit ? { audit: h.audit } : {}) })) })),
    };
    outputs.push({ name: 'delivery.json', bytes: json(summary) });

    await emptyOrAbsent(args.out);
    await mkdir(args.out, { recursive: true, mode: 0o700 });
    const written: string[] = []; const files: Record<string, string> = {};
    try { for (const { name, bytes } of outputs) { const path = join(args.out, name); await writeNew(path, bytes); written.push(path); files[name] = sha256(bytes); } }
    catch (error) { await Promise.all(written.map((path) => rm(path, { force: true }))); throw error; }
    const out = resolve(args.out);
    process.stdout.write(JSON.stringify({
      out,
      totals: assembly.totals,
      ...(scopeSummary ? { scope: { source: 'hub_run_parameters', words: scopeSummary.words, cases: scopeSummary.cases }, in_scope_total: inScope.length, out_of_scope_total: scopeSummary.outOfScope.length } : {}),
      files,
      runs: dispatches.map((d) => d.run),
      added_runs: added,
      reply: replyText(out, assembly.totals, Object.keys(files), assembly.cases, input),
    }) + '\n');
    return 0;
  } catch (error) { process.stderr.write(formatCallError(error) + '\n'); return 1; }
}
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) process.exitCode = await main(process.argv.slice(2));
