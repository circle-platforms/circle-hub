// The client starts one writer per case; the Hub keeps every content check.
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export const WRITER_NAME = 'case-plan-writer';
export const TOOL_NAME = 'write_case_plans';
export const WRITER_TOOLS = ['read_file', 'write_file', 'edit_file', 'ls', 'glob', 'grep'] as const;

export const WRITER_DESCRIPTION = 'Writes the plan file of one case of a downloaded case-compile run from the case\'s brief. It reads and searches files and writes one file; it cannot ask the user and cannot start agents. The write_case_plans tool starts it, one per case; do not start it with task.';

export const WRITER_SYSTEM_PROMPT = [
  '你是自动化用例的编写者，一次只写一条用例的自动化用例文件。',
  '',
  '- 收到的第一条消息给出这条用例的编写简报、要写的文件路径和几个目录。先读完简报，再读技能目录里的 SKILL.md，按它写自动化用例的规则写。开运行、提交、生成工作簿、上机、释放预订是主代理的事，你不做。',
  '- 只写一个文件，就是消息里给的路径，内容是这条用例的自动化用例（简报末尾有文件外壳）。不写别的文件，也不往自动化用例目录放任何别的东西。该文件已经存在时，它是这条用例上一轮的自动化用例，先读它。',
  '- 你没有问使用者的工具，也不能开子代理。资料里查得到的自己查；定不了的不要猜，写进报告。',
  '- 最后一条回复就是交给主代理的报告，最多 8 行：写出的文件路径；没定下来的缺口，每条一行，写明缺什么事实、你怎么处理的。不重述自动化用例内容。',
].join('\n');

export const TOOL_DESCRIPTION = [
  'Write the plan files of a downloaded case-compile run. It starts one writer per case at the same time, each with its own briefs/<index>.md, waits until all of them have finished and returns each writer\'s report and the plan file it wrote.',
  'Use it instead of the task tool for plan writers: it never groups cases and never sends them in waves. The writers cannot ask the user or start agents; what they cannot settle is in their reports.',
  'A case without a brief is not started and is listed with the reason. A writer that did not write its file, wrote one that is not a plan item, or left an existing file as it was is listed with that status; start those again with `only`.',
  'Files other than the plan files that appeared in plans_directory are listed in stray_files: remove them before tools/submit-plans.ts reads the directory.',
].join(' ');

export const TOOL_SCHEMA = {
  type: 'object',
  properties: {
    run_directory: { type: 'string', description: 'The directory tools/download-run.ts wrote: items/, briefs/ and knowledge/ are in it.' },
    plans_directory: { type: 'string', description: 'Where the plan files go: the directory later given to tools/submit-plans.ts as --plans. One file per case: the file that already holds the item, else a new name made from the item id, so a rework run writes the same file again.' },
    skill_directory: { type: 'string', description: 'The installed case-compile directory: SKILL.md, slots.schema.json and examples/ are in it.' },
    only: { type: 'array', items: { type: 'string' }, description: 'The item indexes to write, as in items/<index>.json, for example ["03","07"] to write failed cases again. Default: every case that has a brief.' },
    notes: { type: 'object', additionalProperties: { type: 'string' }, description: 'Text for the writer of one index (the key), for example what the device returns of a failed run said and the attribution you made.' },
  },
  required: ['run_directory', 'plans_directory', 'skill_directory'],
  additionalProperties: false,
} as const;

type Json = { [key: string]: unknown };
const isRecord = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const oneLine = (text: string, chars: number): string => Array.from(text.replace(/\s+/g, ' ').trim()).slice(0, chars).join('');
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const sameIndex = (a: string, b: string): boolean => Number(a) === Number(b);

const REPORT_CHARS = 2000, NOTE_CHARS = 4000, TITLE_CHARS = 80, NAME_CHARS = 80, ERROR_CHARS = 300;

export interface Arguments { runDirectory: string; plansDirectory: string; skillDirectory: string; only: string[] | null; notes: Map<string, string> }

export function parseArguments(args: Json, workspace: string): { ok: true; value: Arguments } | { ok: false; problem: string } {
  const directory = (name: string): string | null => {
    const value = args[name];
    return typeof value === 'string' && value.trim() !== '' && !value.includes('\0') ? resolve(workspace, value) : null;
  };
  const runDirectory = directory('run_directory'), plansDirectory = directory('plans_directory'), skillDirectory = directory('skill_directory');
  if (runDirectory === null || plansDirectory === null || skillDirectory === null) {
    const missing = [['run_directory', runDirectory], ['plans_directory', plansDirectory], ['skill_directory', skillDirectory]].filter(([, value]) => value === null).map(([name]) => name);
    return { ok: false, problem: `${missing.join('、')} 要写成目录路径` };
  }
  let only: string[] | null = null;
  if (args.only !== undefined) {
    if (!Array.isArray(args.only) || !args.only.every((value) => typeof value === 'string' && /^\d+$/.test(value))) return { ok: false, problem: 'only 要写成序号的列表，例如 ["03","07"]，序号是 items/ 里文件名的数字' };
    only = [...new Set(args.only as string[])];
  }
  const notes = new Map<string, string>();
  if (args.notes !== undefined) {
    if (!isRecord(args.notes)) return { ok: false, problem: 'notes 要写成对象：键是序号，值是给那个编写者的文字' };
    for (const [index, text] of Object.entries(args.notes)) {
      if (!/^\d+$/.test(index) || typeof text !== 'string' || text.trim() === '' || Array.from(text).length > NOTE_CHARS) return { ok: false, problem: `notes 里 ${index} 不合式：键是序号，值是不超过 ${NOTE_CHARS} 字的非空文字` };
      notes.set(index, text);
    }
  }
  return { ok: true, value: { runDirectory, plansDirectory, skillDirectory, only, notes } };
}

export interface RunCase { index: string; item: unknown; brief: string | null; unreadable?: string }
export interface PlannedCase { index: string; item: string; title: string; brief: string; file: string; path: string; exists: boolean; note: string | null }
export interface SkippedCase { index: string; item: string | null; reason: string }

export function planFileName(item: string): string {
  const readable = item.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^[._]+/, '').slice(0, NAME_CHARS);
  return `${readable === '' ? 'case' : readable}-${createHash('sha256').update(item).digest('hex').slice(0, 8)}.json`;
}

export function planFanOut(input: { cases: readonly RunCase[]; only: readonly string[] | null; notes: ReadonlyMap<string, string>; plansDirectory: string; existing: ReadonlySet<string>; fileOfItem?: ReadonlyMap<string, string> }): { planned: PlannedCase[]; skipped: SkippedCase[]; problems: string[] } {
  const planned: PlannedCase[] = [], skipped: SkippedCase[] = [], problems: string[] = [];
  const only = input.only;
  for (const index of only ?? []) if (!input.cases.some((value) => sameIndex(value.index, index))) problems.push(`这次运行里没有序号 ${index} 的原始用例`);
  for (const value of input.cases) {
    if (only !== null && !only.some((index) => sameIndex(index, value.index))) continue;
    const item = isRecord(value.item) && typeof value.item.id === 'string' && value.item.id !== '' ? value.item.id : null;
    if (item === null) { skipped.push({ index: value.index, item: null, reason: value.unreadable ?? `items/${value.index}.json 里没有原始用例号 id` }); continue; }
    if (value.brief === null || value.brief.trim() === '') { skipped.push({ index: value.index, item, reason: `没有编写简报 briefs/${value.index}.md（这条用例没有重组记录，或简报没有写出）；不启动编写者，由主代理另行处理` }); continue; }
    const fields = isRecord(value.item) && isRecord(value.item.fields) ? value.item.fields : {};
    const file = input.fileOfItem?.get(item) ?? planFileName(item);
    const note = [...input.notes].find(([index]) => sameIndex(index, value.index))?.[1] ?? null;
    planned.push({ index: value.index, item, title: typeof fields.title === 'string' ? oneLine(fields.title, TITLE_CHARS) : '', brief: value.brief, file, path: join(input.plansDirectory, file), exists: input.existing.has(file), note });
  }
  const seen = new Map<string, string>();
  for (const value of planned) {
    const earlier = seen.get(value.item);
    if (earlier !== undefined) problems.push(`序号 ${earlier} 和 ${value.index} 的原始用例号相同（${value.item}），一个原始用例只能有一个自动化用例文件`);
    seen.set(value.item, value.index);
  }
  for (const index of input.notes.keys()) if (!planned.some((value) => sameIndex(value.index, index))) problems.push(`notes 里的序号 ${index} 不是这次要写的用例`);
  return { planned, skipped, problems };
}

export function writerMessage(value: PlannedCase, where: { runDirectory: string; skillDirectory: string }): string {
  return [
    `脚本编写 ${value.index}：${value.title === '' ? value.item : value.title}`,
    '',
    `原始用例 ${value.item}。`,
    `运行下载目录：${where.runDirectory}（items/${value.index}.json 是这条用例，briefs/${value.index}.md 是下面的简报，knowledge/ 和 sources/ 也在其中）。`,
    `技能目录：${where.skillDirectory}（SKILL.md 是写自动化用例的规则，slots.schema.json 和 examples/submit-result.json 是自动化用例的形状）。`,
    `要写的文件：${value.path}。${value.exists ? '它已经存在，是这条用例上一轮的自动化用例，先读它；返工的规矩见技能目录里 tools/delivery.md 的第 1 步。' : '它还不存在。'}`,
    '只写这一个文件。最后一条回复是给主代理的报告，格式照系统提示。',
    ...(value.note === null ? [] : ['', '## 主代理的补充', '', value.note]),
    '',
    '## 编写简报',
    '',
    value.brief,
  ].join('\n');
}

export type Outcome<R> = { state: 'done'; value: R } | { state: 'failed'; error: unknown } | { state: 'skipped' };

export async function runPool<T, R>(items: readonly T[], limit: number, worker: (item: T, at: number) => Promise<R>, signal?: AbortSignal): Promise<Array<Outcome<R>>> {
  const outcomes: Array<Outcome<R>> = items.map(() => ({ state: 'skipped' }));
  let next = 0;
  const lanes = Math.max(1, Math.min(items.length, limit));
  await Promise.all(Array.from({ length: lanes }, async () => {
    while (next < items.length && signal?.aborted !== true) {
      const at = next++;
      try { outcomes[at] = { state: 'done', value: await worker(items[at] as T, at) }; } catch (error) { outcomes[at] = { state: 'failed', error }; }
    }
  }));
  return outcomes;
}

export function concurrencyLimit(settings: Json): number {
  const value = settings.max_parallel;
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : Number.POSITIVE_INFINITY;
}

export type PlanFileState = { state: 'ok' } | { state: 'missing' } | { state: 'bad'; reason: string };

export function checkPlanFile(bytes: Uint8Array | null, item: string): PlanFileState {
  if (bytes === null) return { state: 'missing' };
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return { state: 'bad', reason: '不是合法的 UTF-8 文本' }; }
  let value: unknown;
  try { value = JSON.parse(text); } catch (error) { return { state: 'bad', reason: `不是合法的 JSON（${error instanceof Error ? oneLine(error.message, ERROR_CHARS) : '无法解析'}）` }; }
  if (!isRecord(value) || typeof value.item !== 'string' || value.item === '' || typeof value.handling !== 'string') return { state: 'bad', reason: '不是一个原始用例：要写 {"item":"<编号>","handling":"handled","slots":{"plan":[…]}}' };
  if (value.item !== item) return { state: 'bad', reason: `里面的原始用例号是 ${value.item}，不是这条用例的 ${item}` };
  return { state: 'ok' };
}

export interface FileStamp { size: number; mtimeMs: number }

export function strayFiles(before: ReadonlyMap<string, FileStamp>, after: ReadonlyMap<string, FileStamp>, targets: ReadonlySet<string>): string[] {
  return [...after].filter(([name, stamp]) => {
    if (targets.has(name)) return false;
    const earlier = before.get(name);
    return earlier === undefined || earlier.size !== stamp.size || earlier.mtimeMs !== stamp.mtimeMs;
  }).map(([name]) => name).sort();
}

export class FanOutProblem extends Error {}

async function stamps(directory: string): Promise<Map<string, FileStamp>> {
  const out = new Map<string, FileStamp>();
  for (const name of await readdir(directory)) {
    const info = await stat(join(directory, name)).catch(() => null);
    if (info?.isFile()) out.set(name, { size: info.size, mtimeMs: info.mtimeMs });
  }
  return out;
}

async function plansByItem(directory: string, names: Iterable<string>): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  for (const name of [...names].filter((value) => value.endsWith('.json')).sort()) {
    let value: unknown;
    try { value = JSON.parse(await readFile(join(directory, name), 'utf8')); } catch { continue; }
    if (!isRecord(value) || typeof value.item !== 'string' || value.item === '') continue;
    const earlier = found.get(value.item);
    if (earlier !== undefined) throw new FanOutProblem(`自动化用例目录里 ${earlier} 和 ${name} 是同一个原始用例 ${value.item}；每个原始用例只留一个文件，留哪个由你定，删掉另一个再来`);
    found.set(value.item, name);
  }
  return found;
}

async function readRunCases(directory: string): Promise<RunCase[]> {
  let names: string[];
  try { names = await readdir(join(directory, 'items')); } catch { throw new FanOutProblem(`${directory} 里没有 items/：run_directory 要写 tools/download-run.ts 写出的运行目录`); }
  const files = names.filter((name) => /^\d+\.json$/.test(name)).sort((a, b) => Number(a.slice(0, -5)) - Number(b.slice(0, -5)));
  if (!files.length) throw new FanOutProblem(`${join(directory, 'items')} 里没有 <序号>.json`);
  const out: RunCase[] = [];
  for (const name of files) {
    const index = name.slice(0, -'.json'.length);
    let item: unknown = null, unreadable: string | undefined;
    try { item = JSON.parse(await readFile(join(directory, 'items', name), 'utf8')); } catch { unreadable = `items/${name} 不是完整的 JSON`; }
    const brief = await readFile(join(directory, 'briefs', `${index}.md`), 'utf8').catch(() => null);
    out.push({ index, item, brief, ...(unreadable === undefined ? {} : { unreadable }) });
  }
  return out;
}

export type RunWriter = (message: string) => Promise<string>;
export type CaseStatus = 'written' | 'unchanged' | 'no_file' | 'bad_file' | 'error' | 'not_started';
export interface CaseResult {
  index: string; item: string | null; title?: string; status: CaseStatus; note?: string;
  plan_file?: string; bytes?: number; sha256?: string; report?: string; report_clipped?: boolean;
}
export interface FanOutResult {
  summary: string; plans_directory: string; concurrency: 'all' | number;
  counts: Record<CaseStatus, number>; cases: CaseResult[]; stray_files: string[]; next?: string;
}

export async function writeCasePlans(options: { args: Arguments; runWriter: RunWriter; signal: AbortSignal; limit: number; progress?: (done: number, total: number) => void }): Promise<FanOutResult> {
  const { args } = options;
  const skill = await stat(join(args.skillDirectory, 'SKILL.md')).catch(() => null);
  if (skill === null || !skill.isFile()) throw new FanOutProblem(`${args.skillDirectory} 里没有 SKILL.md：skill_directory 要写已安装的 case-compile 目录`);
  const cases = await readRunCases(args.runDirectory);
  try { await mkdir(args.plansDirectory, { recursive: true }); } catch { throw new FanOutProblem(`${args.plansDirectory} 不是可以放自动化用例文件的目录：plans_directory 要写一个目录`); }
  const before = await stamps(args.plansDirectory);
  const plan = planFanOut({ cases, only: args.only, notes: args.notes, plansDirectory: args.plansDirectory, existing: new Set(before.keys()), fileOfItem: await plansByItem(args.plansDirectory, before.keys()) });
  if (plan.problems.length) throw new FanOutProblem(plan.problems.join('；'));
  // A file that is already there is the last round's plan. A writer that leaves it byte for byte as it was has not written.
  const earlier = new Map<string, string>();
  for (const value of plan.planned) if (value.exists) earlier.set(value.file, sha256(await readFile(value.path)));
  const where = { runDirectory: args.runDirectory, skillDirectory: args.skillDirectory };
  let done = 0;
  if (plan.planned.length > 0) options.progress?.(0, plan.planned.length);
  const outcomes = await runPool(plan.planned, options.limit, async (value) => {
    try { return await options.runWriter(writerMessage(value, where)); } finally { options.progress?.(++done, plan.planned.length); }
  }, options.signal);
  const results: CaseResult[] = plan.skipped.map((value) => ({ index: value.index, item: value.item, status: 'not_started', note: value.reason }));
  for (const [at, value] of plan.planned.entries()) {
    const outcome = outcomes[at] as Outcome<string>;
    const base = { index: value.index, item: value.item, ...(value.title === '' ? {} : { title: value.title }) };
    if (outcome.state === 'skipped') { results.push({ ...base, status: 'not_started', note: '中止前没有启动' }); continue; }
    const bytes = await readFile(value.path).catch(() => null);
    const state = checkPlanFile(bytes, value.item);
    const digest = bytes === null ? null : sha256(bytes);
    const file = bytes === null ? {} : { plan_file: value.path, bytes: bytes.byteLength, sha256: digest as string };
    const report = outcome.state === 'done' ? Array.from(outcome.value.trim()) : [];
    const said = report.length === 0 ? {} : { report: report.slice(0, REPORT_CHARS).join(''), ...(report.length > REPORT_CHARS ? { report_clipped: true } : {}) };
    if (outcome.state === 'failed') {
      const why = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
      results.push({ ...base, status: 'error', note: `编写者出错：${oneLine(why, ERROR_CHARS)}${state.state === 'ok' ? '；它出错前已经写出一份可读的自动化用例文件，用之前自己看一遍' : ''}`, ...(state.state === 'ok' ? file : {}) });
    } else if (state.state === 'missing') results.push({ ...base, status: 'no_file', note: `编写者回了报告，但 ${value.path} 不存在`, ...said });
    else if (state.state === 'bad') results.push({ ...base, status: 'bad_file', note: `${value.path} ${state.reason}`, ...file, ...said });
    else if (earlier.get(value.file) === digest) results.push({ ...base, status: 'unchanged', note: `${value.path} 在编写者运行前后一字未变；返工时这表示它没有改，报告里有原因的话照报告`, ...file, ...said });
    else results.push({ ...base, status: 'written', ...file, ...said });
  }
  results.sort((a, b) => Number(a.index) - Number(b.index));
  const after = await stamps(args.plansDirectory);
  const stray = strayFiles(before, after, new Set(plan.planned.map((value) => value.file)));
  return resultOf(results, plan.planned.length, options.limit, args.plansDirectory, stray);
}

function resultOf(cases: CaseResult[], started: number, limit: number, plansDirectory: string, stray: string[]): FanOutResult {
  const counts: Record<CaseStatus, number> = { written: 0, unchanged: 0, no_file: 0, bad_file: 0, error: 0, not_started: 0 };
  for (const value of cases) counts[value.status]++;
  const narrowed = Number.isFinite(limit) && limit < started;
  const open = counts.unchanged + counts.no_file + counts.bad_file + counts.error;
  const summary = (started === 0 ? '没有启动编写者' : `${started} 个编写者${narrowed ? `，最多同时 ${limit} 个` : '，同时开始'}：${counts.written} 份自动化用例已写出`)
    + (open > 0 ? `，${open} 个要处理` : '') + (counts.not_started > 0 ? `${started === 0 ? '：' : '，'}${counts.not_started} 条没有启动` : '') + (stray.length > 0 ? `，自动化用例目录里多出 ${stray.length} 个不属于任何用例的文件` : '') + '。';
  const next = open + counts.not_started + stray.length === 0 ? undefined
    : `要处理的先看各条的 note 和 report；编写者没写成的可以用 only 只重跑那几个序号。${stray.length > 0 ? 'stray_files 里的 .json 文件会被 tools/submit-plans.ts 当作原始用例读，提交前移走。' : ''}`;
  return { summary, plans_directory: plansDirectory, concurrency: narrowed ? limit : 'all', counts, cases, stray_files: stray, ...(next === undefined ? {} : { next }) };
}

export interface ToolContextLike { signal: AbortSignal; sessionId?: string; [key: string]: unknown }
export interface TaskTool { name: string; run(args: Json, context: ToolContextLike): Promise<string> }
export interface ModelRequestLike { tools?: ReadonlyArray<{ name: string; run?: unknown }>; [key: string]: unknown }
export type ModelMiddlewareLike = (request: ModelRequestLike, next: (request: ModelRequestLike) => Promise<unknown>) => Promise<unknown>;
export interface ExtensionApi {
  readonly ToolError: new (message: string) => Error;
  readonly signal: AbortSignal;
  readonly settings: Json;
  readonly workspace: string;
  setStatus(text: string | null, lamp?: 'running' | 'ok' | 'error' | 'wait' | 'none'): void;
  registerTool(name: string, description: string, parameters: Json, execute: (args: Json, context: ToolContextLike) => unknown, options?: { readOnly?: boolean; approval?: boolean }): void;
  registerSubagent(spec: { name: string; description: string; system_prompt: string }, tools?: string[]): void;
  registerMiddleware(handler: ModelMiddlewareLike, slot?: 'model_call' | 'tool_boundary' | 'after_model'): void;
}

const NO_TASK_TOOL = '没有取到客户端的 task 工具（这个客户端版本不让扩展启动子代理，或本次会话没有 task 工具），所以不能由代码同时派出编写者，什么都没有启动。不要自己分组派发；告诉使用者，并按技能说明用 task 工具一条用例一个子代理、同时派出。';

export function register(api: ExtensionApi): void {
  let task: TaskTool | null = null;
  api.registerSubagent({ name: WRITER_NAME, description: WRITER_DESCRIPTION, system_prompt: WRITER_SYSTEM_PROMPT }, [...WRITER_TOOLS]);
  // The harness hands every model request the live tool list; the one named `task` is what starts a subagent.
  api.registerMiddleware(async (request, next) => {
    const found = request.tools?.find((tool) => tool.name === 'task');
    if (found !== undefined && typeof found.run === 'function') task = found as TaskTool;
    return next(request);
  }, 'model_call');
  api.registerTool(TOOL_NAME, TOOL_DESCRIPTION, TOOL_SCHEMA, async (raw, context) => {
    const parsed = parseArguments(raw, api.workspace);
    if (!parsed.ok) throw new api.ToolError(parsed.problem);
    const starter = task;
    if (starter === null) throw new api.ToolError(NO_TASK_TOOL);
    const signal = AbortSignal.any([context.signal, api.signal]);
    const own = { ...context, signal };
    try {
      return await writeCasePlans({
        args: parsed.value, signal, limit: concurrencyLimit(api.settings),
        runWriter: (message) => starter.run({ description: message, subagent_type: WRITER_NAME }, own),
        progress: (done, total) => api.setStatus(`编写者 ${done}/${total}`, 'running'),
      });
    } catch (error) {
      if (error instanceof FanOutProblem) throw new api.ToolError(error.message);
      throw error;
    } finally { api.setStatus(null); }
  });
}
