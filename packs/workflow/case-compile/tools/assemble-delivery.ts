import {extractScopeUserRulings} from '../functions/scope.ts';
import { formatClientCallError, parseHubOrigin } from '../functions/client-cli.ts';
import { realpathSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isRecord, failCall, CallFailure, localMinute } from '../functions/text.ts';
import { generateWorkbookSet, GENERATOR } from '../functions/generate.ts';
import { volumeOrder, type MovedCase } from '../functions/channels.ts';
import { JUDGE_LINES, openedJudge, openRecordBelongs, closingHints, modelCheckpointsOf, neverReachedBed, unsentOf, type Unsent, assemble, auditKey, auditPasses, closeFailed, closeUnrun, caseConclusion, caseBasisOf, REPORT_FILES, CLOSING, resultLine, deliveryReport, evidenceProblems, failureLine, lockedStatements, parseRunJobs, readNotes, reworked, settledDispatch, STATUS, terminalLabel, trailingUnreached, unexecutedAfter, unsuccessfulReport, type CaseOutcome, type ModelCheckpoint, type ConflictGround, type Dispatch, type JobRow, type MissingFact, type Original, type OutOfScopeCase, type ReportInput, type RowAudit, type ScopeSummary } from '../functions/delivery.ts';
import { canonicalJson } from '../functions/canonical-json.ts';
import { HubReplyError, RUN_ID, sha256 } from '../functions/generated/skills/run-tools/hub-client/index.ts';
import { fetchBytesRetrying, getRetrying, downloadRetryControl, KNOWLEDGE_MAX_BYTES, KNOWLEDGE_TIMEOUT_MS, readSubmittedFileBytes, readTokenFromStdin, requireBearerToken, type RetryControl } from '../functions/hub-retry.ts';
import { fetchRunInputs, type RunInputs } from './fetch-run.ts';
import { passReviewInputs, satisfiedRecipes } from './generate-workbook.ts';
import { parsedPlanFile } from './submit-plans.ts';
import { afterDelivery } from '../functions/next-step.ts';
import { DEFAULT_DOCS, hubTools, NotReady, refusalWords, type CallTool } from './open-compile.ts';

const OPTIONS = { hub: true, runs: true, notes: true, out: true, open: true, recompose: false, name: false, 'keep-booking': false, 'release-booking': false } as const;
const BOOKING_OPTIONS = '；预订另有可选的 --keep-booking yes（保留）和 --release-booking yes（释放），不能一起写';
function options(argv: string[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.startsWith('--') ? argv[i].slice(2) : '';
    if (!Object.hasOwn(OPTIONS, key) || !argv[i + 1] || Object.hasOwn(values, key)) failCall('invalid_parameters', `参数写法：--hub --runs --notes --out --open 必填，--recompose --name 可选，每个只写一次${BOOKING_OPTIONS}`, '请使用 --hub、--runs、--notes、--out 和 --open 的合法写法重试');
    values[key] = argv[i + 1];
  }
  const missing = Object.entries(OPTIONS).filter(([key, required]) => required && !values[key]).map(([key]) => '--' + key);
  if (missing.length) {
    failCall('invalid_parameters', `缺少参数：${missing.join('、')}${missing.includes('--notes') ? '（--notes 为模型手写的说明 JSON 文件路径）' : ''}${missing.includes('--open') ? '（--open 为这一轮用的开运行记录，pipeline.json 的 open）' : ''}。参数写法：--hub --runs --notes --out --open 必填，--recompose --name 可选，每个只写一次${BOOKING_OPTIONS}`, '请使用 --hub、--runs、--notes、--out 和 --open 的合法写法重试');
  }
  if (values['keep-booking'] !== undefined && values['release-booking'] !== undefined) failCall('invalid_parameters', '--keep-booking 和 --release-booking 不能一起写：一个要保留预订，一个要释放它', '只写其中一个后重试');
  for (const key of ['keep-booking', 'release-booking']) if (values[key] !== undefined && values[key] !== 'yes') failCall('invalid_parameters', `--${key} 只能写 yes`, `要${key === 'keep-booking' ? '保留' : '释放'}预订就写 --${key} yes，不要就不写这个选项`);
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
function planOriginal(item: Record<string, unknown>): Original | null {
  const f = item.fields;
  if (!isRecord(f) || typeof f.title !== 'string' || !Array.isArray(f.steps)) return null;
  return { title: f.title, lines: f.steps.filter(isRecord).map((s) => ({ text: String(s.text ?? ''), expected: Array.isArray(s.expected) ? s.expected.map(String) : [] })) };
}
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

export function lineageKeyOf(sources: unknown): string | null {
  const bound = (slot: string) => { const found = Array.isArray(sources) ? sources.find((s) => isRecord(s) && s.slot === slot && typeof s.reference === 'string') : undefined; return isRecord(found) ? found.reference as string : undefined; };
  return bound('recomposition_run') ?? bound('recomposition_result') ?? bound('subject') ?? null;
}
const lineageKey = (run: Record<string, unknown>) => lineageKeyOf(run.sources);
function parseSuccessors(value: unknown, run: string): Array<{ run: string; pack: string; started_at: string; parameters: Record<string, unknown>; sources: unknown }> {
  if (!isRecord(value) || value.schema !== 'run-successors@1' || value.run !== run || !Array.isArray(value.successors)) failCall('temporarily_unavailable', `Hub 返回的后续脚本编写和上机验证信息不完整`, '请维护者核对原运行导出协议与完整性后重试');
  return value.successors.map((r) => {
    if (!isRecord(r) || typeof r.run !== 'string' || !RUN_ID.test(r.run) || typeof r.pack !== 'string' || typeof r.started_at !== 'string' || !isRecord(r.parameters) || !Array.isArray(r.sources)) failCall('temporarily_unavailable', `Hub 返回的后续脚本编写和上机验证信息不完整`, '请维护者核对原运行导出协议与完整性后重试');
    return { run: r.run, pack: r.pack, started_at: r.started_at, parameters: r.parameters, sources: r.sources };
  });
}
export function replyText(out: string, files: string[], cases: CaseOutcome[], input: ReportInput): string {
  const at = (name: string): string => join(out, name);
  const others = cases.filter((outcome) => outcome.status !== 'delivered');
  const drafted = cases.filter((outcome) => outcome.status === 'delivered').map((outcome) => input.checkpoints?.[outcome.autoid]?.length ?? 0).filter((count) => count > 0);
  return [
    resultLine(input),
    ...(input.judge ? [JUDGE_LINES[input.judge]] : []),
    files.includes('case.xlsx') ? `自动化用例 Excel：${at('case.xlsx')}` : '没有生成成功的用例，没有自动化用例 Excel。',
    ...(others.length ? ['', `失败的 ${others.length} 条：`, ...others.map((outcome) => `- ${caseConclusion(input, outcome, 'cause')}`), ''] : []),
    ...(drafted.length ? [`生成成功的用例里有 ${drafted.length} 条含模型拟定的检查点（共 ${drafted.reduce((sum, count) => sum + count, 0)} 处），建议复核，逐项见交付报告。`] : []),
    ...(others.length && files.includes(REPORT_FILES.unsuccessful) ? [`失败用例的详细说明：${at(REPORT_FILES.unsuccessful)}`] : []),
    ...(files.includes('unsuccessful_cases.xlsx') ? [`失败用例的 Excel（没有整卷上机验证）：${at('unsuccessful_cases.xlsx')}`] : []),
    `交付报告：${at(REPORT_FILES.report)}`,
  ].join('\n');
}

export function missingFactOf(exported: unknown, run: string, id: string): MissingFact | null {
  if (!isRecord(exported) || exported.schema !== 'run-export@1' || !isRecord(exported.run) || exported.run.run !== run || !isRecord(exported.result) || exported.result.run !== run || !isRecord(exported.result.partitions)) return null;
  for (const entries of Object.values(exported.result.partitions)) for (const entry of Array.isArray(entries) ? entries : []) {
    if (!isRecord(entry) || entry.item !== id || !Array.isArray(entry.requirements)) continue;
    const basis = caseBasisOf(exported, run, id);
    const dataGaps = basis?.gaps.filter(gap => gap.requirement !== 'workbook_verified' && (gap.attribution === 'data_gap' || gap.reason === 'missing_input') && typeof gap.missing === 'string' && isRecord(gap.exit) && gap.exit.action === 'request') ?? [];
    if (dataGaps.length) return { kind: 'data_gap', plan_run: run, requirement: dataGaps[0].requirement, missing: dataGaps.map(gap => gap.missing).join('；'), gaps: dataGaps.map(gap => ({ missing: gap.missing!, ...(gap.reason ? { reason: gap.reason } : {}), exit: gap.exit })), exit: dataGaps[0].exit, attributions: [...new Set(['data_gap' as const, ...(basis?.attributions ?? [])])] };
    const rounds = isRecord(exported.result.rounds) ? exported.result.rounds : null;
    const spent = !!rounds && Number.isSafeInteger(rounds.used) && Number.isSafeInteger(rounds.max) && (rounds.used as number) >= (rounds.max as number);
    const skipped = entry.skip_reason !== undefined || entry.requirements.some((r) => isRecord(r) && Array.isArray(r.layers) && r.layers.some((l) => isRecord(l) && l.reason === 'declared_skip'));
    for (const requirement of spent && !skipped ? entry.requirements : []) {
      if (!isRecord(requirement) || typeof requirement.requirement !== 'string' || requirement.requirement === 'workbook_verified' || requirement.status === 'satisfied' || !Array.isArray(requirement.layers)) continue;
      const layer = requirement.layers.find((l) => isRecord(l) && l.reason === 'repair_exhausted');
      if (isRecord(layer)) return { kind: 'repair_exhausted', plan_run: run, requirement: requirement.requirement, missing: typeof layer.missing === 'string' ? layer.missing.trim() : '' };
    }
  }
  return null;
}
function withoutAudit(slots: unknown): unknown {
  if (!isRecord(slots)) return slots;
  const strip = (entry: unknown) => (isRecord(entry) && isRecord(entry.data) && Object.hasOwn(entry.data, 'fidelity') ? { ...entry, data: Object.fromEntries(Object.entries(entry.data).filter(([key]) => key !== 'fidelity')) } : entry);
  return { ...slots, ...(slots.plan !== undefined ? { plan: Array.isArray(slots.plan) ? slots.plan.map(strip) : strip(slots.plan) } : {}) };
}
export function planDigest(plan: RunInputs, autoid: string): string | null {
  const item = (plan.run.items as unknown[] ?? []).find((i) => autoidOf(i) === autoid);
  const id = isRecord(item) ? item.id : undefined;
  const entry = Array.isArray(plan.submission.items) ? plan.submission.items.find((s) => isRecord(s) && s.item === id) : undefined;
  return isRecord(entry) && id !== undefined && isRecord(entry.slots) && entry.slots.plan !== undefined ? sha256(canonicalJson(withoutAudit(entry.slots))) : null;
}

class CitationUnavailable extends Error {}
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

const RELEASE_TIMEOUT_MS = 60_000;
// What the client adds to its own words when the Hub does not answer: it tells to run the opening tool again, which is not what a release needs.
const CLIENT_ADVICE = /；(?:读运行列表确认有没有开出运行，再重跑本工具|核对 --hub 和网络后重跑本工具)$/u;
interface OpenedBooking { run: string; acquired: boolean; inventory: string }
/** The booking the open record names and whether this compile took it itself; a record that names no booking says nothing about one. */
function openedBooking(record: unknown): OpenedBooking | null {
  if (!isRecord(record)) return null;
  const acquired = record.booking_acquired;
  if (acquired !== undefined && acquired !== true) failCall('invalid_parameters', `--open 里的 booking_acquired 是 ${JSON.stringify(acquired).slice(0, 40)}，只能是 true（没有这一项就是这次编译没有自己预订测试环境）`, '--open 写 open-compile.ts 写的文件，不手改');
  if (typeof record.booking === 'string' && RUN_ID.test(record.booking)) return { run: record.booking, acquired: acquired === true, inventory: typeof record.inventory === 'string' && record.inventory ? record.inventory : DEFAULT_DOCS.inventory };
  if (acquired === true) failCall('invalid_parameters', '--open 说这次编译自己预订了测试环境，却没有写预订的运行编号（booking）', '--open 写 open-compile.ts 写的文件，不手改');
  return null;
}
type Settled = { run: string; state: 'released'; reason?: string } | { run: string; state: 'kept'; asked: boolean } | { run: string; state: 'not_released'; reason: string } | { run: string; state: 'unknown'; reason: string };
/** One start_run of the test-bed release action as the test-bed skill gives it: the booking is the predecessor and the booking released, with the inventory the compile was opened with. */
async function releaseBooking(call: CallTool, run: string, inventory: string): Promise<Settled> {
  try {
    const answer = await call('start_run', { pack: 'test-bed', inputs: { inventory: { external: inventory } }, predecessor: run, parameters: { action: 'release', booking: run } });
    if (!answer.failed) return { run, state: 'released' };
    const words = refusalWords(answer).slice(0, 300);
    const errors = Array.isArray(answer.envelope?.errors) ? answer.envelope.errors.filter(isRecord) : [];
    // test-bed answers a release of a booking that holds nothing with not_holder: nothing is left to release.
    return errors.some((error) => error.code === 'test-bed.not_holder') ? { run, state: 'released', reason: words } : { run, state: 'not_released', reason: words };
  } catch (error) {
    // No answer to go by (no reply in time, no connection, an HTTP error, a broken body): whether the Hub released the booking is not known.
    return { run, state: 'unknown', reason: (error instanceof NotReady ? error.message.replace(CLIENT_ADVICE, '') : `释放没有做成：${error instanceof Error ? error.message : String(error)}`).slice(0, 300) };
  }
}
async function settleBooking(booking: OpenedBooking, args: Record<string, string>, call: CallTool): Promise<Settled> {
  if (args['keep-booking'] !== undefined) return { run: booking.run, state: 'kept', asked: true };
  if (!booking.acquired && args['release-booking'] === undefined) return { run: booking.run, state: 'kept', asked: false };
  return releaseBooking(call, booking.run, booking.inventory);
}
const bookingJson = (settled: Settled) => ({ run: settled.run, state: settled.state, ...('reason' in settled && settled.reason ? { reason: settled.reason } : {}) });
function bookingReply(settled: Settled): string {
  if (settled.state === 'released') return '测试环境的预订已释放。';
  if (settled.state === 'kept') return settled.asked ? '测试环境的预订按要求保留。' : '测试环境的预订仍保留（不是这次编译预订的）。不再使用时请要求释放。';
  return `测试环境的预订${settled.state === 'unknown' ? '是否已释放未知' : '没有释放'}：${settled.reason.replace(/。+$/u, '')}。请再要求释放一次，或请管理员核对。`;
}
function bookingNext(settled: Settled): string[] {
  if (settled.state === 'kept' && !settled.asked) return [`预订 ${settled.run} 不是这次编译预订的，没有释放；使用者要求时在重跑时加 --release-booking yes，或按 test-bed 技能的 release 释放`];
  if (settled.state === 'not_released') return [`预订 ${settled.run} 没有释放（原因见 booking.reason）：按 test-bed 技能的 release 再试一次，仍被拒绝就把原话告诉使用者`];
  if (settled.state === 'unknown') return [`预订 ${settled.run} 是否已释放未知（原因见 booking.reason）：按 test-bed 技能的 release 再试一次，答复没有持有这个预订就是已经释放`];
  return [];
}

export async function main(argv: string[], readToken: () => Promise<string> = readTokenFromStdin, now: () => Date = () => new Date(), retry?: RetryControl): Promise<number> {
  try {
    const args = options(argv);
    const runs = [...new Set(args.runs.split(',').map((v) => v.trim()).filter(Boolean))];
    if (!runs.length || runs.some((run) => !RUN_ID.test(run)) || (args.recompose !== undefined && !RUN_ID.test(args.recompose))) failCall('invalid_parameters', '--runs 请按上机验证的先后顺序填写编号，以逗号分隔；--recompose 请填写用例重组的编号', '请核对运行、范围、产物身份和原始输入，修正后重试');
    const notesValue = parsedPlanFile(`说明文件 ${basename(args.notes)}`, await readSubmittedFileBytes(args.notes, 'notes'));
    // The record that opened this compile says who judged its commands and scenarios (no field means Plumb); the report says it in a line the program writes.
    const openRecord = parsedPlanFile(`开运行记录 ${basename(args.open)}`, await readSubmittedFileBytes(args.open, 'open'));
    const judge = openedJudge(openRecord);
    const booking = openedBooking(openRecord);
    if (args['release-booking'] !== undefined && booking === null) failCall('invalid_parameters', '--release-booking 没有预订可释放：--open 的开运行记录里没有预订的运行编号（booking）', '--open 写这一轮用的 open-compile.json（pipeline.json 的 open），不手改');
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
      if (neverReachedBed(run, jobs)) { unsent.push(unsentOf(run, jobs)); continue; }
      given.set(run, settledDispatch(run, jobs));
    }

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
    for (const d of [...given.values(), ...unsent]) {
      let current = (await planOf(d.plan_run)).run as Record<string, unknown>;
      for (let hops = 0; typeof current.predecessor === 'string' && hops < 200; hops++) {
        const up = await runOf(current.predecessor);
        if (!ours(up, key)) { roots.add(current.predecessor); break; }
        current = up!;
      }
    }
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
      if (neverReachedBed(run, jobs)) { if (!unsent.some((u) => u.run === run)) unsent.push(unsentOf(run, jobs)); continue; }
      if (!jobs.some((job) => job.verification_run === run)) continue;
      dispatches.push(settledDispatch(run, jobs)); added.push(run);
    }
    unsent.sort((a,b) => {
      const left = started.get(a.run) ?? '', right = started.get(b.run) ?? '';
      return left < right ? -1 : left > right ? 1 : a.run < b.run ? -1 : a.run > b.run ? 1 : 0;
    });
    for (const d of [...dispatches, ...unsent]) await planOf(d.plan_run);
    // The record says who judged this compile: it has to be this compile's own, not another one's (that would write another judge into this report).
    if (!openRecordBelongs(openRecord, [...planRuns.keys(), ...[...dispatches, ...unsent].map((d) => d.plan_run)], args.recompose)) {
      const named = isRecord(openRecord) ? `脚本编写运行 ${String(openRecord.plan_run ?? '没有写').slice(0, 40)}、用例重组运行 ${String(openRecord.recompose_run ?? '没有写').slice(0, 40)}` : '没有读出运行';
      failCall('invalid_parameters', `--open 的开运行记录不是这次编译的（它写的${named}，都不在 --runs 这些上机验证所属的脚本编写运行里，也不是 --recompose）`, '--open 写这一轮用的 open-compile.json（pipeline.json 的 open），不用别的编译的');
    }

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
    const reached = (row: JobRow) => Boolean(row.evidence?.log) || Object.keys(row.evidence?.sessions ?? {}).length > 0;
    for (const [k, d] of dispatches.entries()) {
      const tail = trailingUnreached(d.items, d.rows.map((row) => ({ item: row.item, reached: reached(row) })));
      if (!tail) continue;
      const reference = d.rows.find((row) => row.item === tail.last)?.evidence?.log;
      const found = unexecutedAfter(tail, reference ? await textOf(d.run, reference) : null, (item) => originals[item]?.title);
      if (found.size) dispatches[k] = { ...d, rows: d.rows.map((row) => found.has(row.item) ? { ...row, dynamic_terminal: 'not_run', not_executed: found.get(row.item)! } : row) };
    }
    const assembly = assemble(inScope, dispatches);
    const undelivered = assembly.cases.filter((c) => c.status !== 'delivered').map((c) => c.autoid);
    const notes = readNotes(notesValue, undelivered);
    const unissuedPlans = assembly.cases.filter(c => c.status === 'unrun' && (unsent.some(u => u.items.includes(c.autoid)) || c.not_executed?.length));
    if (unissuedPlans.length) {
      const volume = assembly.unsuccessful ?? { items: [], sources: {} };
      for (const outcome of unissuedPlans) {
        const source = outcome.not_executed?.at(-1) ?? unsent.filter(u => u.items.includes(outcome.autoid)).at(-1)!;
        if (!volume.items.includes(outcome.autoid)) volume.items.push(outcome.autoid);
        volume.sources[outcome.autoid] = { plan_run: source.plan_run, run: source.run };
      }
      volume.items.sort((a,b) => inScope.indexOf(a) - inScope.indexOf(b));
      assembly.unsuccessful = volume;
    }

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
    const deviceTexts: Record<string, string[]> = {};
    for (const outcome of assembly.cases.filter((c) => c.status !== 'delivered')) {
      const last = outcome.history.at(-1); if (!last) continue;
      const texts: string[] = []; const logText = logs[outcome.autoid]?.text; if (logText) texts.push(logText);
      for (const reference of Object.values(last.sessions ?? {})) {
        const found = /^src:([0-9a-f]{64})$/.exec(reference); if (!found) continue;
        try { const bytes = await getRetrying(`${origin}/run-export/${last.run}/sources/${found[1]}`, bearer, sourceRetry); if (sha256(bytes) !== found[1]) failCall('temporarily_unavailable', '设备会话原件的字节与摘要不一致', '请维护者恢复与原摘要一致的字节后重试'); texts.push(new TextDecoder('utf-8').decode(bytes)); } catch (error) { if (error instanceof CallFailure) throw error; }
      }
      deviceTexts[outcome.autoid] = texts;
    }
    const rounds: Record<string, number> = {};
    for (const outcome of assembly.cases.filter(reworked)) rounds[outcome.autoid] = new Set(outcome.history.filter((h) => h.terminal === 'fail' || h.audit).map((h) => planDigest(plans.get(dispatches[h.ordinal - 1].plan_run)!, outcome.autoid)).filter((digest): digest is string => digest !== null)).size;
    const authored = Object.fromEntries(Object.entries(originals).map(([autoid, original]) => [autoid, original.lines.flatMap((line) => line.expected)]));
    const conflictGround: ConflictGround = {
      authored: Object.fromEntries(Object.entries(originals).map(([autoid, original]) => [autoid, [original.title, ...original.lines.flatMap((line) => [line.text, ...line.expected])].filter((text) => text.length > 0)])),
      ...(await citedStatements(origin, bearer, new Set(Object.values(notes.cases).flatMap((note) => (note.author_conflict ? [note.author_conflict.reference] : []))), [...dispatches, ...unsent].map((d) => d.plan_run), (run) => plans.get(run)?.run.root, sourceRetry)),
    };
    const closed = closeFailed(assembly.cases, notes, rounds, authored, deviceTexts, conflictGround);
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
          if (!answered.has(holder)) { let exported: unknown = null; try { exported = hubDocument(await getRetrying(`${origin}/run-export/${holder}`, bearer, retry)); } catch (error) { if (error instanceof CallFailure) throw error; } if (exported !== null && (!isRecord(exported) || exported.schema !== 'run-export@1' || !isRecord(exported.run) || exported.run.run !== holder || !isRecord(exported.result) || exported.result.run !== holder)) failCall('temporarily_unavailable', 'Hub 接受结果不属于所请求的脚本编写运行', '请维护者核对运行身份与接受结果绑定后重试'); answered.set(holder, exported); }
          const exported = answered.get(holder);
          if (!isRecord(exported) || !isRecord(exported.result)) continue;
          const basis = caseBasisOf(exported, holder, item.id); if (basis) bases.set(autoid, basis);
          const fact = missingFactOf(exported, holder, item.id); if (fact) facts[autoid] = fact;
          break;
        }
      }
    }
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
    const checkpoints: Record<string, ModelCheckpoint[]> = {};
    for (const outcome of assembly.cases) {
      const planRun = assembly.pass?.items.includes(outcome.autoid) ? assembly.pass.plan_run : assembly.unsuccessful?.sources[outcome.autoid]?.plan_run;
      const plan = planRun === undefined ? undefined : plans.get(planRun);
      const item = plan && Array.isArray(plan.run.items) ? plan.run.items.find((entry) => autoidOf(entry) === outcome.autoid) : undefined;
      const found = plan && isRecord(item) && typeof item.id === 'string' ? modelCheckpointsOf(plan.result, item.id) : [];
      if (found.length) checkpoints[outcome.autoid] = found;
    }
    const hints = closingHints(assembly.cases, notes, unsent);
    const input: ReportInput = { judge, ...(Object.keys(userRulings).length?{userRulings}:{}),...(Object.keys(checkpoints).length?{checkpoints}:{}),unsent, name: args.name ?? basename(resolve(args.out)), generatedAt: localMinute(now()), build: typeof lastPlan.build === 'string' ? lastPlan.build : null, assembly, notes, originals, excluded, files: { pass: passFile, unsuccessful: unsuccessfulFile }, logs, passAudit: { markers: markerCount, read, downgraded: hits.size, wordless }, placedLast: { pass: passLast, unsuccessful: unsuccessfulLast }, ...(scopeSummary ? { scope: scopeSummary } : {}) };
    input.artifacts = [...outputs.map(output => output.name), ...Object.values(REPORT_FILES)];
    outputs.push({ name: REPORT_FILES.report, bytes: Buffer.from(deliveryReport(input)) }, { name: REPORT_FILES.unsuccessful, bytes: Buffer.from(unsuccessfulReport(input)) });
    const summary = {
      schema: 'case-delivery@1', generator: GENERATOR, name: input.name, generated_at: now().toISOString(), build: input.build, judge, judge_line: JUDGE_LINES[judge], totals: assembly.totals,
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
    const bookingOutcome = booking && !hints.length ? await settleBooking(booking, args, hubTools(origin, bearer, RELEASE_TIMEOUT_MS)) : null;
    process.stdout.write(JSON.stringify({
      out,
      totals: assembly.totals,
      ...(scopeSummary ? { scope: { source: 'hub_run_parameters', words: scopeSummary.words, cases: scopeSummary.cases }, in_scope_total: inScope.length, out_of_scope_total: scopeSummary.outOfScope.length } : {}),
      files,
      runs: dispatches.map((d) => d.run),
      added_runs: added,
      hints,
      ...(bookingOutcome ? { booking: bookingJson(bookingOutcome) } : {}),
      reply: [replyText(out, Object.keys(files), assembly.cases, input), ...(bookingOutcome ? [bookingReply(bookingOutcome)] : [])].join('\n'),
      message: [afterDelivery(hints.length), ...(bookingOutcome ? bookingNext(bookingOutcome) : [])].join('。'),
    }) + '\n');
    return hints.length ? 1 : 0;
  } catch (error) { process.stderr.write(formatClientCallError(error) + '\n'); return 1; }
}
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) process.exitCode = await main(process.argv.slice(2));
