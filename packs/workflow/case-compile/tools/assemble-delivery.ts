// The delivery directory at the end of a compile run, after the reference engine's (InfoTest docs/engine/07_display_contract.md
// §11.9): case.xlsx (the pass volume), unsuccessful_cases.xlsx, delivery_report.md, unsuccessful_cases.md and delivery.json.
// Verdicts come from the Hub's relay of the jobs (GET /run-export/<run>/jobs); the pass volume is regenerated from its plan run
// and must be byte for byte the workbook that was dispatched; the unsuccessful volume merges each case not passed as it last went
// to the bed, from the plan run of its latest dispatch. The model supplies only the judged paragraphs (--notes). The token is read from
// standard input only, in the one form the skills home admits:
//   node <skill directory>/tools/assemble-delivery.ts --hub %HUB_URL% --runs <run>,<run> --recompose <run> --notes <file> --out <directory> <<'EOF'
//   %HUB_TOKEN%
//   EOF
import { realpathSync } from 'node:fs';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isRecord } from '../functions/text.ts';
import { generateWorkbookSet, GENERATOR } from '../functions/generate.ts';
import { volumeOrder, type MovedCase } from '../functions/channels.ts';
import { assemble, auditKey, auditPasses, closeFailed, closeUnrun, closingCounts, CLOSING, deliveryReport, evidenceProblems, failureLine, parseRunJobs, readNotes, reworked, settledDispatch, STATUS, terminalLabel, unsuccessfulReport, type CaseOutcome, type Dispatch, type MissingFact, type Original, type ReportInput, type RowAudit } from '../functions/delivery.ts';
import { canonicalJson } from '../functions/canonical-json.ts';
import { bearerFrom, get, hubOrigin, HubReplyError, readBytes, RUN_ID, sha256, tokenFromStdin, writeNew } from '../functions/generated/skills/run-tools/hub-client/index.ts';
import { fetchRunInputs, type RunInputs } from './fetch-run.ts';
import { passReviewInputs, satisfiedRecipes } from './generate-workbook.ts';
import { parsedPlanFile } from './submit-plans.ts';

const OPTIONS = { hub: true, runs: true, notes: true, out: true, recompose: false, name: false } as const;
function options(argv: string[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.startsWith('--') ? argv[i].slice(2) : '';
    if (!Object.hasOwn(OPTIONS, key) || !argv[i + 1] || Object.hasOwn(values, key)) throw new Error('参数写法：--hub --runs --notes --out 必填，--recompose --name 可选，每个只写一次');
    values[key] = argv[i + 1];
  }
  const missing = Object.entries(OPTIONS).filter(([key, required]) => required && !values[key]).map(([key]) => '--' + key);
  if (missing.length) throw new Error(`缺少参数：${missing.join('、')}`);
  return values;
}
const json = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const decode = (bytes: Uint8Array) => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
function localTime(date: Date): string { const p = (n: number) => String(n).padStart(2, '0'); return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}`; }
const autoidOf = (item: unknown): string | null => isRecord(item) && isRecord(item.fields) && typeof item.fields.autoid === 'string' ? item.fields.autoid : null;
function excludedOf(run: Record<string, unknown>): string[] { const p = run.parameters; return isRecord(p) && Array.isArray(p.exclude) ? p.exclude.filter((v): v is string => typeof v === 'string') : []; }
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
  if (!isRecord(value) || value.schema !== 'run-successors@1' || value.run !== run || !Array.isArray(value.successors)) throw new Error(`Hub 给的运行 ${run} 的后继清单不合式`);
  return value.successors.map((r) => {
    if (!isRecord(r) || typeof r.run !== 'string' || !RUN_ID.test(r.run) || typeof r.pack !== 'string' || typeof r.started_at !== 'string' || !isRecord(r.parameters) || !Array.isArray(r.sources)) throw new Error(`运行 ${run} 的后继条目不合式`);
    return { run: r.run, pack: r.pack, started_at: r.started_at, parameters: r.parameters, sources: r.sources };
  });
}
/** The answer the model gives the person, made here so it holds the counts and paths and nothing else. */
export function replyText(out: string, totals: Record<string, number>, files: string[], cases: CaseOutcome[] = []): string {
  const counts = (Object.keys(STATUS) as Array<keyof typeof STATUS>).map((status) => `${STATUS[status]} ${totals[status] ?? 0}`).join('，');
  const closings = closingCounts(cases);
  return [`交付目录：${out}`, `共 ${totals.cases} 条：${counts}。`, ...(closings ? [closings] : []), ...files.map((name) => `- ${join(out, name)}`)].join('\n');
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

export async function main(argv: string[], readToken: () => Promise<string> = tokenFromStdin, now: () => Date = () => new Date()): Promise<number> {
  try {
    const args = options(argv);
    const runs = args.runs.split(',').map((v) => v.trim()).filter(Boolean);
    if (!runs.length || runs.some((run) => !RUN_ID.test(run)) || (args.recompose !== undefined && !RUN_ID.test(args.recompose))) throw new Error('--runs 写按上机先后排列、逗号分隔的核验运行号；--recompose 写重组运行号');
    // The notes are a file the model writes and edits by hand: a break in it is named with its place and the text around it, as
    // submit-plans does for a case file (in run 20 the shared reader's answer told the model to export the run's input again).
    const notesValue = parsedPlanFile(`说明文件 ${basename(args.notes)}`, await readBytes(args.notes, 'notes'));
    await emptyOrAbsent(args.out);
    const origin = hubOrigin(args.hub);
    const bearer = await bearerFrom(readToken);

    const jobsOf = async (run: string) => parseRunJobs(JSON.parse(decode(await get(`${origin}/run-export/${run}/jobs`, bearer))), run);
    const successorsOf = async (run: string) => parseSuccessors(JSON.parse(decode(await get(`${origin}/run-export/${run}/successors`, bearer))), run);
    const plans = new Map<string, RunInputs>();
    const planOf = async (run: string) => { if (!plans.has(run)) plans.set(run, await fetchRunInputs(origin, bearer, run)); return plans.get(run)!; };
    const given = new Map<string, Dispatch>();
    for (const run of runs) given.set(run, settledDispatch(run, await jobsOf(run)));

    // The runs named are where the walk starts, not the whole list: every verification run of the same compilation (plan runs
    // under the same booking bound to the same recomposition, or the same document without one) is read from the Hub's lineage,
    // so a dispatch the model left out still counts (decision 162).
    const keys = new Set<string>(), roots = new Set<string>(), started = new Map<string, string>(), planRuns = new Map<string, string>();
    const runOf = async (run: string): Promise<Record<string, unknown> | null> => { const exported = JSON.parse(decode(await get(`${origin}/run-export/${run}/run`, bearer))); return isRecord(exported) && isRecord(exported.run) && exported.run.run === run ? exported.run : null; };
    const ours = (run: Record<string, unknown> | null, key: string) => !!run && typeof run.pack === 'string' && run.pack.split('@')[0] === 'case-compile' && lineageKey(run) === key;
    for (const d of given.values()) { const key = lineageKey((await planOf(d.plan_run)).run as Record<string, unknown>); if (key) keys.add(key); }
    if (keys.size !== 1) throw new Error('--runs 的核验运行不是同一份重组（或同一份脑图）编出来的；只写这份脑图的核验运行');
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
    for (const run of given.keys()) if (!started.has(run)) { const exported = JSON.parse(decode(await get(`${origin}/run-export/${run}/run`, bearer))); started.set(run, isRecord(exported) && isRecord(exported.run) && typeof exported.run.started_at === 'string' ? exported.run.started_at : ''); }
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

    // The document's cases: the recomposition run's, or else every case and exclusion the plan runs name, in first-seen order.
    const originals: Record<string, Original> = {}; let population: string[] = [];
    if (args.recompose) {
      const exported = JSON.parse(decode(await get(`${origin}/run-export/${args.recompose}/run`, bearer)));
      if (!isRecord(exported) || exported.schema !== 'run-export@1' || !isRecord(exported.run) || exported.run.run !== args.recompose || !Array.isArray(exported.run.items)) throw new Error('Hub 给的重组运行不合式或不是 --recompose 指定的');
      for (const item of exported.run.items) { const read = isRecord(item) ? atomOriginal(item) : null; if (!read) throw new Error('重组运行的条目没有 case_id 和用例原句，不是重组运行'); population.push(read.autoid); originals[read.autoid] = read.original; }
    }
    const excluded = [...new Set([...plans.values()].flatMap((p) => excludedOf(p.run)))];
    for (const d of dispatches) for (const item of (plans.get(d.plan_run)!.run.items as unknown[]) ?? []) {
      const autoid = autoidOf(item); if (!autoid || !isRecord(item)) continue;
      const original = planOriginal(item); if (original) originals[autoid] = original;
      if (!args.recompose && !population.includes(autoid)) population.push(autoid);
    }
    if (!args.recompose) for (const autoid of excluded) if (!population.includes(autoid)) population.push(autoid);
    population = population.filter((v, k, all) => all.indexOf(v) === k);

    const inputsOf = (plan: RunInputs) => ({ run: plan.run, result: plan.result, submission: plan.submission, contract: plan.originals.contract, profile: plan.originals.profile, inventory: plan.originals.inventory });
    const recipesOf = (plan: RunInputs) => satisfiedRecipes(inputsOf(plan));
    // The reference engine's pass review (functions/delivery.ts failureLine): a pass whose words carry an execution-failure line
    // that the case's own assertions do not read is no verdict. The markers are the contract declaration of each dispatch's plan
    // run; the words are the run log the Hub saved for the row, checked against its digest (the reference engine reads only
    // the run log of a pass).
    const texts = new Map<string, string | null>();
    const textOf = async (run: string, reference: string): Promise<string | null> => {
      const found = /^src:([0-9a-f]{64})$/.exec(reference); if (!found) return null;
      if (!texts.has(found[1])) { try { const bytes = await get(`${origin}/run-export/${run}/sources/${found[1]}`, bearer); texts.set(found[1], sha256(bytes) === found[1] ? new TextDecoder('utf-8').decode(bytes) : null); } catch { texts.set(found[1], null); } }
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
      try { return assemble(population, dispatches); } catch (error) {
        if (!(error instanceof Error) || !hits.size) throw error;
        const told = [...hits.entries()].slice(-5).map(([key, hit]) => `用例 ${key.split('\u0000')[1]} 的${hit.where}里有一行“${hit.line.length > 160 ? `${hit.line.slice(0, 160)}…` : hit.line}”`);
        throw new Error(`${error.message}。通过复核把这些通过改记为无判定（合约声明的执行失败原话出现在它的运行日志里，而它自己的断言没有读到这一行）：${told.join('；')}。让这条用例的断言读到这一行，或换一种不会执行失败的观察，再整卷上机`);
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
      if (sha256(bytes) !== assembly.pass.sha256) throw new Error(`从计划运行 ${assembly.pass.plan_run} 重算的工作簿和核验运行 ${assembly.pass.run} 派发的那份字节不一致；通过卷只能是最后一次整卷上机的那份`);
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
        if (k < 0) throw new Error(`计划运行 ${planRun} 里没有用例 ${autoid}，它却在那次上机里`);
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
      try { const bytes = await get(`${origin}/run-export/${last.run}/sources/${found[1]}`, bearer); if (sha256(bytes) !== found[1]) throw new Error('日志字节和引用的摘要不符'); logs[outcome.autoid] = { reference: last.log!, job: last.job, text: new TextDecoder('utf-8').decode(bytes) }; }
      catch (error) { logs[outcome.autoid] = { reference: last.log!, job: last.job, text: null, withheld: error instanceof HubReplyError && error.status === 403 ? 'Hub 的读取层级不给这份日志的字节' : `没有取到：${error instanceof Error ? error.message : '读取失败'}` }; }
    }
    // The reference engine's attribution rule: a case not delivered that went to the bed is explained with the device's own words,
    // verbatim from its last device output (the runner log or a device session), checked here against the bytes the Hub relays.
    const deviceTexts: Record<string, string[]> = {};
    for (const outcome of assembly.cases.filter((c) => c.status !== 'delivered')) {
      const last = outcome.history.at(-1); if (!last) continue;
      const texts: string[] = []; const logText = logs[outcome.autoid]?.text; if (logText) texts.push(logText);
      for (const reference of Object.values(last.sessions ?? {})) {
        const found = /^src:([0-9a-f]{64})$/.exec(reference); if (!found) continue;
        try { const bytes = await get(`${origin}/run-export/${last.run}/sources/${found[1]}`, bearer); if (sha256(bytes) === found[1]) texts.push(new TextDecoder('utf-8').decode(bytes)); } catch { /* an unreadable session is evidence neither way */ }
      }
      deviceTexts[outcome.autoid] = texts;
    }
    // The reference engine's closing rules: a case that failed, or whose pass the pass review dropped, is reworked until three
    // authored versions of it did not pass on the bed, unless it closes earlier as a verbatim product-defect candidate
    // (closeFailed in functions/delivery.ts). A round is a distinct plan that failed or whose pass was dropped.
    const rounds: Record<string, number> = {};
    for (const outcome of assembly.cases.filter(reworked)) rounds[outcome.autoid] = new Set(outcome.history.filter((h) => h.terminal === 'fail' || h.audit).map((h) => planDigest(plans.get(dispatches[h.ordinal - 1].plan_run)!, outcome.autoid))).size;
    const authored = Object.fromEntries(Object.entries(originals).map(([autoid, original]) => [autoid, original.lines.flatMap((line) => line.expected)]));
    const closed = closeFailed(assembly.cases, notes, rounds, authored, deviceTexts);
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
          if (!answered.has(holder)) { let exported: unknown = null; try { exported = JSON.parse(decode(await get(`${origin}/run-export/${holder}`, bearer))); } catch { /* no accepted submission */ } answered.set(holder, exported); }
          const exported = answered.get(holder);
          if (!isRecord(exported) || !isRecord(exported.result)) continue; // never answered: no plan was judged there
          const fact = missingFactOf(exported, holder, item.id); if (fact) facts[autoid] = fact;
          break;
        }
      }
    }
    const settled = closeUnrun(closed.cases, facts);
    const unproven = [...evidenceProblems(notes, deviceTexts), ...closed.problems, ...settled.problems];
    if (unproven.length) throw new Error(unproven.join('；'));
    assembly.cases = settled.cases;
    const lastPlan = plans.get((assembly.pass ?? dispatches.at(-1)!).plan_run)!.run;
    const input: ReportInput = { name: args.name ?? basename(resolve(args.out)), generatedAt: localTime(now()), build: typeof lastPlan.build === 'string' ? lastPlan.build : null, assembly, notes, originals, excluded, files: { pass: passFile, unsuccessful: unsuccessfulFile }, logs, passAudit: { markers: markerCount, read, downgraded: hits.size, wordless }, placedLast: { pass: passLast, unsuccessful: unsuccessfulLast } };
    outputs.push({ name: 'delivery_report.md', bytes: Buffer.from(deliveryReport(input)) }, { name: 'unsuccessful_cases.md', bytes: Buffer.from(unsuccessfulReport(input)) });
    const summary = {
      schema: 'case-delivery@1', generator: GENERATOR, name: input.name, generated_at: now().toISOString(), build: input.build, totals: assembly.totals,
      dispatches: dispatches.map((d) => ({ run: d.run, job: d.job, plan_run: d.plan_run, sha256: d.sha256, items: d.items })),
      added_runs: added,
      pass_audit: { markers: markerCount, read, downgraded: [...hits.entries()].map(([key, hit]) => { const [run, item] = key.split('\u0000'); return { run, item, where: hit.where, line: hit.line }; }), wordless },
      pass_volume: assembly.pass ? { file: 'case.xlsx', sha256: assembly.pass.sha256, run: assembly.pass.run, job: assembly.pass.job, plan_run: assembly.pass.plan_run, items: assembly.pass.items, ...(passLast.length ? { moved_tail: passLast } : {}) } : null,
      unsuccessful_volume: assembly.unsuccessful ? { file: 'unsuccessful_cases.xlsx', sha256: unsuccessfulFile!.sha256, items: assembly.unsuccessful.items.map((autoid) => ({ autoid, plan_run: assembly.unsuccessful!.sources[autoid].plan_run, run: assembly.unsuccessful!.sources[autoid].run })), dispatched: false, ...(unsuccessfulLast.length ? { moved_tail: unsuccessfulLast } : {}) } : null,
      closings: Object.fromEntries((Object.keys(CLOSING) as Array<keyof typeof CLOSING>).map((closing) => [closing, assembly.cases.filter((c) => c.closing === closing).length])),
      cases: assembly.cases.map((c) => ({ autoid: c.autoid, title: originals[c.autoid]?.title ?? null, status: c.status, label: STATUS[c.status], ...(c.closing ? { closing: c.closing, closing_label: CLOSING[c.closing], rounds: c.rounds } : {}), ...(c.missing ? { missing: c.missing } : {}), dispatches: c.history.map((h) => ({ run: h.run, job: h.job, terminal: h.terminal, label: terminalLabel(h.terminal), ...(h.audit ? { audit: h.audit } : {}) })) })),
    };
    outputs.push({ name: 'delivery.json', bytes: json(summary) });

    await emptyOrAbsent(args.out);
    await mkdir(args.out, { recursive: true, mode: 0o700 });
    const written: string[] = []; const files: Record<string, string> = {};
    try { for (const { name, bytes } of outputs) { const path = join(args.out, name); await writeNew(path, bytes); written.push(path); files[name] = sha256(bytes); } }
    catch (error) { await Promise.all(written.map((path) => rm(path, { force: true }))); throw error; }
    const out = resolve(args.out);
    process.stdout.write(JSON.stringify({ out, totals: assembly.totals, files, runs: dispatches.map((d) => d.run), added_runs: added, reply: replyText(out, assembly.totals, Object.keys(files), assembly.cases) }) + '\n');
    return 0;
  } catch (error) { process.stderr.write(`交付没有组成：${error instanceof Error ? error.message : '输入无效'}\n`); return 1; }
}
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) process.exitCode = await main(process.argv.slice(2));
