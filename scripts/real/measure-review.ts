import { PublicRefusal, type PublicRefusalReason, recordRefusal, refusalSummary } from './lib/inject.ts';
// Drives the whole injection measurement repeatedly (task gold-review step 4). One pass: write the copy and the gold
// exactly the way inject-defects.ts does, compute the independent literal answer of the copy, then for each round run
// a fresh draft session through scripts/real/review-circle.ts (the only reader of the endpoint and the keys), read the
// run it had accepted from the call log, fetch it with `circle-hub run show --json`, check it is valid (the right
// pack, accepted, the copy as its subject, the right item count — and for a verify run the right predecessor), score
// it and write the score beside the evidence. The screen carries the fixed count lines only; node ids, titles,
// commands, run ids, build names and case texts stay in --out. A fact this driver cannot yet name is never left as an
// unknown: the copy, the gold and the literal answer are always computed, and a round that fails says which fixed
// reason it failed for.
//   HUB_REAL_TOKEN=… node scripts/real/measure-review.ts --source <mindmap.json> --plan <plan.json> [--keep <n>]
//     [--manual <fragment>] [--case-rule marked|tagged] --draft <session.json> [--verify <session.json>] [--repeat 3]
//     [--baseline <previous --out>] [--tree <command XML>] [--submission <raw-file-{n}.json>]
//     [--catalog-table <declaration.json>] [--catalog-manifest <pack.json>] [--argument-types <JSON array>] --out <dir>
// Accepted bodies are read by record reference and bound by canonical JSON digest; missing reads request positioned evidence.
// Verify prompt templates: {copy} is the copy path, {draft_run} the current draft run, and {draft_record} its accepted
// validation result's root rec:<64 lowercase hex> reference (not a submission original). The record comes from the same
// run-show snapshot used to judge validity. A template using it requires that reference; otherwise the draft is invalid
// and no verify session starts. The reference stays in the private prompt/evidence, never the fixed screen count lines.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { caseNodes, firstCases, inject, type ManualFragment, type MindTree, type Planned } from './lib/inject.ts';
import { aggregate, score, type AggregateRun, type ResultLike, type Score } from './lib/score.ts';
import { literalGold } from './gold/literal.ts';
import { outsideGit, readArgumentTypes, acceptedSubmissionReference, CatalogInputError, CatalogOutputError, decodeCatalog, catalogMarks, catalogGapReport, catalogPreflight, catalogSummary, readCatalogInput, readDeclaration, writeCatalogReport, type CatalogReport, type DeclaredArgumentType } from './gold/catalog-marks.ts';
import { parseCallLog } from './review-circle.ts';

export interface SessionSpec {
  /** review-circle.ts's endpoint and connection arguments, verbatim. */
  args: string[];
  /** Prompt template: {copy} is the copy path; verify also receives {draft_run} and the accepted result {draft_record}. */
  prompt: string;
}

export interface Drivers {
  /** Runs one review-circle session (the real one spawns `node scripts/real/review-circle.ts`). */
  review(spec: SessionSpec, prompt: string, out: string, name: string): { code: number; calls: string };
  /** Fetches one run (`node bin/circle-hub run show <run> --json`). */
  show(run: string): { code: number; json: string };
  readSubmission?(reference: string, out: string, hubUrl?: string): {code:number;json:string};
}

/** Fetch the complete record body; a cursor loop or unavailable page cannot become a partial submission. */
export function readSubmissionPages(read: (args: {reference:string;cursor?:string}) => {code:number;json:string}, reference: string): {code:number;json:string} {
  let cursor: string | undefined, text = '';
  const seen = new Set<string>();
  for (let page = 0; page < 1024; page++) {
    const result = read({reference,...(cursor === undefined ? {} : {cursor})});
    if (result.code !== 0) return {code:1,json:''};
    let value: unknown;
    try { value = JSON.parse(result.json); } catch (error) { if (error instanceof SyntaxError) return {code:1,json:''}; throw error; }
    if (value === null || typeof value !== 'object') return {code:1,json:''};
    const row = value as {content?:{reference?:unknown;readable?:unknown;text?:unknown};next?:unknown};
    if (row.content?.reference !== reference || row.content.readable !== true || typeof row.content.text !== 'string') return {code:1,json:''};
    text += row.content.text;
    if (Buffer.byteLength(text) > 64 * 1024 * 1024) return {code:1,json:''};
    if (row.next === null || row.next === undefined) return {code:0,json:text};
    if (typeof row.next !== 'string' || !row.next || seen.has(row.next)) return {code:1,json:''};
    cursor = row.next; seen.add(cursor);
  }
  return {code:1,json:''};
}

export function submissionReadArgs(args:{reference:string;cursor?:string}, file:string, hubUrl?:string):string[] {
  return [resolve(import.meta.dirname,'hub-call.ts'),...(hubUrl === undefined ? [] : ['--url',hubUrl]),'--token-env','HUB_REAL_TOKEN','--structured',file,'get_nodes',JSON.stringify(args)];
}

/** The real drivers: subprocesses, with the Hub's loopback URL and the repo's binary. */
export const realDrivers: Drivers = {
  readSubmission: (reference, out, hubUrl) => {
    let page = 0;
    return readSubmissionPages(args => {
      const file = join(out, 'submission-page-' + (++page) + '.jsonl');
      writeFileSync(file, '', {flag:'wx',mode:0o600});
      const result = spawnSync(process.execPath, submissionReadArgs(args,file,hubUrl), {cwd:resolve(import.meta.dirname,'../..'),encoding:'utf8',env:process.env,maxBuffer:64*1024*1024});
      return {code:result.status ?? 1,json:readFileSync(file,'utf8').trim()};
    },reference);
  },
  review: (spec, prompt, out, name) => {
    const run = spawnSync('node', [resolve(import.meta.dirname, 'review-circle.ts'), ...spec.args, '--prompt', prompt, '--out', out, '--name', name], { cwd: resolve(import.meta.dirname, '../..'), encoding: 'utf8', env: process.env });
    writeFileSync(join(out, name + '.stdout.txt'), run.stdout ?? '', { mode: 0o600 });
    writeFileSync(join(out, name + '.stderr.txt'), run.stderr ?? '', { mode: 0o600 });
    return { code: run.status ?? 1, calls: existsSync(join(out, `${name}.calls.jsonl`)) ? readFileSync(join(out, `${name}.calls.jsonl`), 'utf8') : '' };
  },
  show: (run) => {
    const shown = spawnSync('node', ['bin/circle-hub', 'run', 'show', run, '--json'], { cwd: resolve(import.meta.dirname, '../..'), encoding: 'utf8', env: process.env, maxBuffer: 64 * 1024 * 1024 });
    return { code: shown.status ?? 1, json: shown.stdout };
  },
};

/** The fixed invalid reasons (task step 4): nothing else may be said on the screen. */
export type InvalidReason = '没有受理' | '不止一个运行' | '评审对象不是副本' | '条目数不对' | '任务包不对' | '前驱不对' | '取不到运行' | '启动参数不完整';

interface RunLike {
  run: { run: string; pack: string; predecessor?: string; items: Array<{ item: string }>; sources: Array<{ role?: string; reference?: string }> };
  latest: { record: string; result: { acceptance: string; partitions: Record<string, unknown[]> } } | null;
}

export interface RoundOutcome {
  n: number;
  draftPack: string;
  draftValid: boolean;
  draftReason?: InvalidReason;
  draftRun?: string;
  verifyPack: string;
  verifyValid: boolean;
  verifyReason?: InvalidReason;
  verifyRun?: string;
  score?: Score;
  catalog?: CatalogReport;
}

export interface MeasureOptions {
  source: string;
  plan: string;
  keep?: number;
  manual?: string;
  caseRule?: 'marked' | 'tagged';
  draft: SessionSpec;
  verify?: SessionSpec;
  repeat: number;
  baseline?: string;
  tree?: string;
  /** Submission JSON path, canonically bound; {n} expands to the round number. */
  submission?: string;
  catalogTable?: string;
  catalogManifest?: string;
  argumentTypes?: string;
  out: string;
}

const MAX_CASES = 100; // packs/workflow/case-review/SKILL.md: one run reviews at most 100 cases

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

export class SessionRefusal extends PublicRefusal {
  constructor(reason: Extract<PublicRefusalReason,'session_shape'|'session_reserved'|'session_json'|'session_unreadable'>, where: string, flag?: string) {
    super(reason);
    const side = where === '--verify' || where === 'verify' ? '--verify' : '--draft';
    this.message = reason === 'session_reserved' ? `${side} 的 args 里有 ${flag}：--prompt、--out、--name 由驱动设置，从会话 JSON 里删掉`
      : reason === 'session_shape' ? `${side} 会话 JSON 要有字符串 args 数组和 prompt，修正后重跑`
      : reason === 'session_json' ? `${side} 会话 JSON 无效，重新导出合法 JSON 后重跑`
      : `${side} 会话文件不可读，补取可读的会话 JSON 后重跑`;
  }
}
export function parseSession(text: string, where: string): SessionSpec {
  let value: unknown;
  try { value = JSON.parse(text); } catch (error) { if (error instanceof SyntaxError) throw new SessionRefusal('session_json',where); throw error; }
  if (value === null || typeof value !== 'object') throw new SessionRefusal('session_shape',where);
  const spec=value as {args?:unknown;prompt?:unknown};
  if (!Array.isArray(spec.args) || !spec.args.every((a): a is string => typeof a === 'string') || typeof spec.prompt !== 'string') throw new SessionRefusal('session_shape',where);
  for(const flag of ['--prompt','--out','--name']) if(spec.args.some(arg=>arg===flag || arg.startsWith(flag+'='))) throw new SessionRefusal('session_reserved',where,flag);
  return {args:spec.args,prompt:spec.prompt};
}
export function validateSessionStartup(draftText: string, verifyText?: string): {code:0;draft:SessionSpec;verify?:SessionSpec}|{code:2;message:string;error:SessionRefusal} {
  try { return {code:0,draft:parseSession(draftText,'--draft'),...(verifyText === undefined ? {} : {verify:parseSession(verifyText,'--verify')})}; }
  catch(error) { if(error instanceof SessionRefusal) return {code:2,message:error.message,error}; throw error; }
}
function readSession(file: string, side: string): string {
  try { return readFileSync(file,'utf8'); } catch { throw new SessionRefusal('session_unreadable',side); }
}

/** One round's draft (or verify) run: the call log's accepted runs must be exactly one, and the run must be valid. */
export function judgeRun(
  calls: string,
  shown: string,
  expect: { packPrefix: string; subjectSha?: string; caseCount?: number; predecessor?: string },
): { ok: true; run: string; detail: RunLike; result: ResultLike } | { ok: false; reason: InvalidReason; run?: string; detail?: RunLike } {
  const accepted = [...new Set(parseCallLog(calls).filter((l) => l.run !== null && l.acceptance === 'accepted').map((l) => l.run as string))];
  if (accepted.length === 0) return { ok: false, reason: '没有受理' };
  if (accepted.length > 1) return { ok: false, reason: '不止一个运行' };
  const run = accepted[0]!;
  let detail: RunLike;
  try {
    detail = JSON.parse(shown) as RunLike;
  } catch {
    return { ok: false, reason: '取不到运行', run };
  }
  if (!detail?.run || typeof detail.run.pack !== 'string') return { ok: false, reason: '取不到运行', run };
  if (!detail.run?.pack?.startsWith(expect.packPrefix)) return { ok: false, reason: '任务包不对', run, detail };
  if (detail.latest == null || detail.latest.result?.acceptance !== 'accepted') return { ok: false, reason: '没有受理', run, detail };
  if (expect.predecessor !== undefined && detail.run.predecessor !== expect.predecessor) return { ok: false, reason: '前驱不对', run, detail };
  if (expect.subjectSha !== undefined && !detail.run.sources.some((s) => typeof s.reference === 'string' && s.reference.startsWith(`src:${expect.subjectSha}`))) {
    return { ok: false, reason: '评审对象不是副本', run, detail };
  }
  if (expect.caseCount !== undefined && detail.run.items.length !== expect.caseCount) return { ok: false, reason: '条目数不对', run, detail };
  return { ok: true, run, detail, result: detail.latest.result as unknown as ResultLike };
}

/** Use only the accepted validation result recorded by this already-judged run-show snapshot. */
function acceptedDraftRecord(detail: RunLike): string | null {
  if (detail.latest?.result.acceptance !== 'accepted' || typeof detail.latest.record !== 'string') return null;
  const digest = /^(?:rec:)?([a-f0-9]{64})$/.exec(detail.latest.record)?.[1];
  return digest === undefined ? null : 'rec:' + digest;
}

/** The summary counts of the fixed screen lines; no node id, title or text appears here. */
export function summaryLines(options: { copySha: string; goldSha: string; manualSha: string | null; cases: number; injected: number; repeat: number; hasVerify: boolean; rounds: RoundOutcome[]; totals: ReturnType<typeof aggregate>; untouched: number; catalogProvided?: boolean }): string[] {
  const valid = options.rounds.filter((r) => r.draftValid && (options.hasVerify ? r.verifyValid : true));
  const lines = [
    `副本 sha256 ${options.copySha}；标准答案 sha256 ${options.goldSha}${options.manualSha === null ? '' : `；片段 sha256 ${options.manualSha}`}；用例 ${options.cases} 个，注入 ${options.injected} 处；重复 ${options.repeat} 次，有效 ${valid.length} 次`,
  ];
  for (const round of options.rounds) {
    const verdict = (ok: boolean, reason?: string): string => (ok ? '有效' : `无效（${reason}）`);
    void verdict;
    lines.push(
      `第 ${round.n} 次：初评 ${round.draftPack || '未取得'} ${verdict(round.draftValid, round.draftReason)}${options.hasVerify ? !round.draftValid ? '；复核 未跑（初评无效）' : `；复核 ${round.verifyPack || '未取得'} ${verdict(round.verifyValid, round.verifyReason)}` : ''}`,
    );
  }
  for (const kind of options.totals.kinds) {
    lines.push(`${kind.title}（${kind.kind}）：注入 ${kind.injected}×${kind.validRuns}；Hub 字面检查 ${kind.mechanical}；初评 ${kind.draft}；复核 ${kind.verify}；合起来 ${kind.combined}`);
  }
  const scores = valid.map((r) => r.score!).filter((s): s is Score => s !== undefined);
  const sum = (pick: (s: Score) => number): number => scores.reduce((n, s) => n + pick(s), 0);
  const catalogs = valid.flatMap(round => round.catalog ? [round.catalog] : []);
  const catSum = (pick: (report: CatalogReport) => number): number => catalogs.reduce((n, report) => n + pick(report), 0);
  const verifiedCatalogCount = (fresh: boolean): number => valid.reduce((n, round) => n + (round.catalog && !round.catalog.requests.length && round.score ? (fresh ? round.score.otherMarks.catalog.fresh : round.score.otherMarks.catalog.total) : 0), 0);
  const gaps = catSum(r => r.requests.length);
  for (const round of valid) if (round.catalog?.requests.length) lines.push('下一步：按 r' + round.n + '/catalog/evidence-requests.json 的 follow_up 补证后重跑独立核对');
  const catalogText = options.catalogProvided
    ? `目录独立核对：一致 ${catSum(r => r.supported.length)}，Hub 漏了 ${catSum(r => r.missed.length)}，Hub 多了 ${catSum(r => r.extra.length)}；反向预期 ${catSum(r => r.negative_expected.length)}；设计缺口 ${catSum(r => r.requests.length)}`
    : `目录类标记还没有独立答案 ${sum(s => s.otherMarks.catalog.total)} 条（未改动评审里没有的 ${sum(s => s.otherMarks.catalog.fresh)} 条）；缺 --tree，下一步补锁定根的命令树原件后重跑`;

  lines.push(
    `未注入的用例 ${options.untouched} 个：Hub 标记支持 ${sum((s) => s.structure.supported.length)}、误报 ${sum((s) => s.structure.falsePositives.length)}、漏标 ${sum((s) => s.structure.missed.length)}；未独立核对 ${sum((s) => s.otherMarks.total) - (options.catalogProvided ? verifiedCatalogCount(false) : 0)}（未改动评审里没有的 ${sum((s) => s.otherMarks.fresh) - (options.catalogProvided ? verifiedCatalogCount(true) : 0)}）；${catalogText}；各次相同 ${options.totals.structureStable === null ? '没跑（有效运行少于 2 次，补足有效运行后比较）' : options.totals.structureStable ? '是' : '否'}；不计分 ${sum((s) => s.literalUnscored) + (scores[0]?.noUniqueId ?? 0)}（data.id 缺失或重复 ${scores[0]?.noUniqueId ?? 0} 个）`,
  );
  lines.push(
    `未注入的用例上模型的发现：初评 ${sum((s) => s.extras.length)} 个用例（未改动评审里没有的 ${sum((s) => s.extras.filter((e) => !e.inBaseline).length)}），复核新增 ${sum((s) => s.verifyExtras.length)} 个用例`,
  );
  const mechanicalAllFound = scores.every(s => s.detections.filter(d => d.entry.seen_by === 'mechanical').every(d => d.mechanical));
  const structureClean = scores.every((s) => s.structure.falsePositives.length === 0 && s.structure.missed.length === 0) && (!options.catalogProvided || catalogs.length === valid.length && catalogs.every(r => !r.requests.length && !r.missed.length && !r.extra.length));
  lines.push(
    `通过：Hub 看得见的注入缺陷全部查出 ${valid.length === 0 ? '没跑（没有有效运行，按原因重跑初评）' : mechanicalAllFound ? '是' : '否'}；未注入用例上没有误报和漏标 ${valid.length === 0 ? '没跑（没有有效运行，按原因重跑初评）' : gaps > 0 ? '没判（设计缺口 ' + gaps + '）' : structureClean ? '是' : '否'}；每次都有效 ${valid.length === options.rounds.length && options.rounds.length > 0 ? '是' : '否'}`,
  );
  if (options.repeat < 3) lines.push('不构成统计：重复次数少于 3');
  return lines;
}

export function measureReview(options: MeasureOptions, drivers: Drivers, say: (line: string) => void = () => {}): number {
  outsideGit(options.out);
  if (existsSync(options.out) && readdirSync(options.out).some(name => /^r[0-9]+$/.test(name) || ['catalog-preflight','mutated.json','gold.json','literal.json'].includes(name))) throw new CatalogOutputError('output_exists');
  // 1. The copy, the gold and the independent answer — always computed, never skipped.
  let tree = JSON.parse(readFileSync(options.source, 'utf8')) as MindTree;
  if (options.keep !== undefined) tree = firstCases(tree, options.keep, { caseRule: options.caseRule });
  let manual: ManualFragment | undefined;
  if (options.manual !== undefined) {
    const bytes = readFileSync(options.manual);
    manual = { text: bytes.toString('utf8'), sha256: createHash('sha256').update(bytes).digest('hex') };
  }
  const injected = inject(tree, JSON.parse(readFileSync(options.plan, 'utf8')) as Planned[], { caseRule: options.caseRule, manual });
  mkdirSync(options.out, { recursive: true, mode: 0o700 });
  const copyBytes = Buffer.from(JSON.stringify(injected.tree), 'utf8');
  const copySha = createHash('sha256').update(copyBytes).digest('hex');
  writeFileSync(join(options.out, 'mutated.json'), copyBytes);
  const goldBytes = Buffer.from(`${JSON.stringify(injected.gold, null, 2)}\n`, 'utf8');
  writeFileSync(join(options.out, 'gold.json'), goldBytes);
  const answer = literalGold(injected.tree, { caseRule: options.caseRule });
  writeFileSync(join(options.out, 'literal.json'), `${JSON.stringify(answer, null, 2)}\n`);
  const caseCount = answer.cases.length + answer.noUniqueId.length;
  if (caseCount > MAX_CASES) {
    say(`拒绝：按 ${options.caseRule ?? 'marked'} 规则副本有 ${caseCount} 个用例，超过一次运行的 ${MAX_CASES} 个上限：减小 --keep 后重跑`);
    return 2;
  }

  // Catalog declaration drift is refused before starting any review session.
  let catalogInput: { treeXml: string; treeBytes: Uint8Array; table: unknown; manifest: unknown; bytes: Uint8Array; argumentTypes?: DeclaredArgumentType[] } | undefined;
  if (options.tree !== undefined) {
    let preflight: CatalogReport | undefined;
    try {
      const treeBytes = readCatalogInput(options.tree), declaration = readDeclaration(options.catalogTable, options.catalogManifest);
      const treeXml = decodeCatalog(treeBytes);
      const requests = catalogPreflight(treeXml, declaration.table, declaration);
      if (options.argumentTypes === undefined) requests.push({ input: 'argument-types', pointer: '/', fact: '锁定根 argumentTypes 声明（可为空数组）', next_action: '请集成者导出 {command,position,type,origin} 声明数组并用 --argument-types 传入后重跑，评审会话尚未启动' });
      if (requests.length) preflight = catalogGapReport(requests, { tree_sha256: createHash('sha256').update(treeBytes).digest('hex'), source_sha256: copySha });
      else catalogInput = { treeXml, treeBytes, table: declaration.table, manifest: declaration.manifest, bytes: declaration.bytes, argumentTypes: options.argumentTypes === undefined ? undefined : readArgumentTypes(readCatalogInput(options.argumentTypes)) };
    } catch (error) { if (!(error instanceof CatalogInputError) && !(error instanceof CatalogOutputError)) throw error; preflight = catalogGapReport([{ input: error instanceof CatalogInputError && error.reason === 'argument_types' ? 'argument-types' : 'tree/table', pointer: '/', fact: '可读取并解析的输入：' + error.reason, next_action: error instanceof CatalogInputError && error.reason === 'argument_types' ? '请集成者按 {command,position,type,origin} 修正 --argument-types 声明数组后重跑；会话未启动' : '请集成者补 --tree 原件与匹配的表声明，再启动度量；脚本尚未启动评审会话' }]); }
    if (preflight !== undefined) {
      writeCatalogReport(join(options.out, 'catalog-preflight'), preflight);
      say(catalogSummary(preflight)); say('设计缺口 ' + preflight.requests.length + '；下一步按私有补证文件修正声明后重跑；评审会话未启动');
      return 1;
    }
  }

  // 2. The baseline rounds (an earlier empty-plan --out): their draft results mark what the unchanged review already had.
  const baselineResults: ResultLike[] = [];
  if (options.baseline !== undefined) {
    const copy = join(options.baseline, 'mutated.json');
    if (!existsSync(copy)) { say('--baseline 里没有有效的初评：先跑空计划基线'); return 2; }
    const baselineSha = createHash('sha256').update(readFileSync(copy)).digest('hex');
    const baselineAnswer = literalGold(JSON.parse(readFileSync(copy, 'utf8')), { caseRule: options.caseRule });
    const baselineCount = baselineAnswer.cases.length + baselineAnswer.noUniqueId.length;
    for (const entry of readdirSync(options.baseline, { withFileTypes: true }).filter((e) => e.isDirectory()).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const file = join(options.baseline, entry.name, 'draft.run.json');
      if (!existsSync(file) || !existsSync(join(options.baseline, entry.name, 'score.json'))) continue;
      const detail = JSON.parse(readFileSync(file, 'utf8')) as RunLike;
      if (detail.latest?.result.acceptance === 'accepted' && detail.run.pack.startsWith('case-review@') && detail.run.items.length === baselineCount && detail.run.sources.some(s => s.reference?.startsWith('src:' + baselineSha))) baselineResults.push(detail.latest.result as unknown as ResultLike);
    }
  }
  if (options.baseline !== undefined && !baselineResults.length) { say('--baseline 里没有有效的初评：先跑空计划基线'); return 2; }
  const baselineItems = new Map<string, ResultLike['partitions'][string][number]>();
  for (const result of baselineResults) for (const items of Object.values(result.partitions)) for (const item of items) {
    const previous = baselineItems.get(item.item);
    baselineItems.set(item.item, { ...item, requirements: [...(previous?.requirements ?? []), ...item.requirements] });
  }
  const baseline: ResultLike | undefined = baselineResults.length ? { partitions: { delivered: [...baselineItems.values()] } } : undefined;

  // 3. The rounds.
  const gold = injected.gold;
  const rounds: RoundOutcome[] = [];
  for (let n = 1; n <= options.repeat; n++) {
    const dir = join(options.out, `r${n}`);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const draftPrompt = options.draft.prompt.replaceAll('{copy}', join(options.out, 'mutated.json'));
    const draft = drivers.review(options.draft, draftPrompt, dir, 'draft');
    writeFileSync(join(dir, 'draft.client-status.json'), JSON.stringify({ code: draft.code }), { mode: 0o600 });
    let draftJudged: ReturnType<typeof judgeRun> = draft.code === 2 ? { ok: false as const, reason: '启动参数不完整' as InvalidReason } : judgeRun(draft.calls, draftRunJson(drivers, draft, dir) !== null ? String(readFileSync(join(dir, 'draft.run.json'), 'utf8')) : '{}', { packPrefix: 'case-review@', subjectSha: copySha, caseCount });
    const draftRecord = draftJudged.ok ? acceptedDraftRecord(draftJudged.detail) : null;
    // Legacy templates do not need record metadata they never consumed. Requested references must be proven, not guessed.
    if (draftJudged.ok && options.verify?.prompt.includes('{draft_record}') && draftRecord === null) {
      draftJudged = { ok: false, reason: '取不到运行', run: draftJudged.run, detail: draftJudged.detail };
    }
    let round: RoundOutcome;
    if (draftJudged.ok) {
      writeFileSync(join(dir, 'draft.run.json'), JSON.stringify(draftJudged.detail, null, 2));
      if (options.verify === undefined) {
        round = { n, draftPack: packOf(draftJudged.detail), draftValid: true, draftRun: draftJudged.run, verifyPack: '', verifyValid: true };
        round.score = score(gold, draftJudged.result, { ...(baseline === undefined ? {} : { baseline }), literal: answer });
      } else {
        const substitutions = { copy: join(options.out, 'mutated.json'), draft_run: draftJudged.run, draft_record: draftRecord ?? '' };
        // Expand only tokens in the original template, never token-looking text inside a substituted path.
        const verifyPrompt = options.verify.prompt.replace(/\{(copy|draft_run|draft_record)\}/g, (_token, key: keyof typeof substitutions) => substitutions[key]);
        const verifyRun = drivers.review(options.verify, verifyPrompt, dir, 'verify');
        writeFileSync(join(dir, 'verify.client-status.json'), JSON.stringify({ code: verifyRun.code }), { mode: 0o600 });
        const verifyJudged: ReturnType<typeof judgeRun> = verifyRun.code === 2 ? { ok: false as const, reason: '启动参数不完整' as InvalidReason } : judgeRun(verifyRun.calls, verifyCodeJson(drivers, verifyRun, dir) ?? '{}', { packPrefix: 'case-review-verify@', predecessor: draftJudged.run });
        if (verifyJudged.ok) {
          writeFileSync(join(dir, 'verify.run.json'), JSON.stringify(verifyJudged.detail, null, 2));
          round = { n, draftPack: packOf(draftJudged.detail), draftValid: true, draftRun: draftJudged.run, verifyPack: packOf(verifyJudged.detail), verifyValid: true, verifyRun: verifyJudged.run };
          round.score = score(gold, draftJudged.result, { ...(baseline === undefined ? {} : { baseline }), verify: verifyJudged.result, literal: answer });
        } else {
          round = { n, draftPack: packOf(draftJudged.detail), draftValid: true, draftRun: draftJudged.run, verifyPack: (verifyJudged.detail as { run?: { pack?: string } } | undefined)?.run?.pack ?? '', verifyValid: false, verifyReason: verifyJudged.reason };
        }
      }
    } else {
      round = { n, draftPack: (draftJudged.detail as { run?: { pack?: string } } | undefined)?.run?.pack ?? '', draftValid: false, draftReason: draftJudged.reason, verifyPack: '', verifyValid: options.verify === undefined };
      if (draftJudged.detail !== undefined) writeFileSync(join(dir, 'draft.run.json'), JSON.stringify(draftJudged.detail, null, 2));
    }
    if (catalogInput !== undefined && round.draftValid) {
      const hubUrlIndex = options.draft.args.indexOf('--hub-url');
      const hubUrl = hubUrlIndex < 0 ? undefined : options.draft.args[hubUrlIndex + 1];
      let original: Uint8Array | undefined;
      if (options.submission !== undefined) {
        try { original = readCatalogInput(options.submission.replaceAll('{n}', String(n))); } catch { /* The report requests accepted bytes by digest. */ }
      }
      const shown = JSON.parse(readFileSync(join(dir, 'draft.run.json'), 'utf8')) as unknown;
      if (original === undefined && drivers.readSubmission) {
        const reference = acceptedSubmissionReference(shown);
        if (reference !== null) {
          const read = drivers.readSubmission(reference, dir, hubUrl);
          if (read.code === 0) original = Buffer.from(read.json, 'utf8');
        }
      }
      const excludeNodes = injected.gold.flatMap(entry => [entry.node, ...(entry.copy === undefined ? [] : [entry.copy]), ...(entry.deletedCases ?? [])]);
      round.catalog = catalogMarks({ hubUrl, treeXml: catalogInput.treeXml, treeBytes: catalogInput.treeBytes, sourceBytes: copyBytes, run: shown, submissionBytes: original, table: catalogInput.table, packManifest: catalogInput.manifest, tableBytes: catalogInput.bytes, argumentTypes: catalogInput.argumentTypes, excludeNodes });
      for (const pending of round.catalog.requests) {
        pending.next_action += '；补证后运行 follow_up 参数里的独立核对，不要为重新计分再次开模型会话；提交原件路径和输出目录用新的仓库外文件';
        pending.follow_up = { program: 'node', args: ['scripts/real/gold/catalog-marks.ts', ...(hubUrl === undefined ? [] : ['--hub-url',hubUrl]), '--tree', options.tree!, '--source', join(options.out, 'mutated.json'), '--run', join(dir, 'draft.run.json'), '--submission', '<已导出的提交原件文件>', '--gold', join(options.out, 'gold.json'), ...(options.catalogManifest === undefined ? [] : ['--manifest', options.catalogManifest]), ...(options.argumentTypes === undefined ? [] : ['--argument-types', options.argumentTypes]), ...(options.catalogTable === undefined ? [] : ['--table', options.catalogTable]), '--out', '<仓库外新核对目录>'] };
      }
      writeCatalogReport(join(dir, 'catalog'), round.catalog);
      writeFileSync(join(dir, 'catalog-counts.json'), JSON.stringify(round.catalog.summary, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    }
    if (round.score !== undefined) writeFileSync(join(dir, 'score.json'), `${JSON.stringify(round.score, null, 2)}\n`);
    rounds.push(round);
  }

  // 4. The summary and the exit code.
  const totals = aggregate(gold, rounds.filter((r) => r.draftValid && (options.verify === undefined ? true : r.verifyValid)).map((r): AggregateRun => {
    const detail = JSON.parse(readFileSync(join(options.out, `r${r.n}`, 'draft.run.json'), 'utf8')) as RunLike;
    return { result: detail.latest!.result as unknown as ResultLike, valid: true, ...(r.verifyValid && existsSync(join(options.out, `r${r.n}`, 'verify.run.json')) ? { verify: (JSON.parse(readFileSync(join(options.out, `r${r.n}`, 'verify.run.json'), 'utf8')) as RunLike).latest!.result as unknown as ResultLike } : {}) };
  }), answer);
  const touched = new Set(gold.flatMap((g) => [g.node, ...(g.copy === undefined ? [] : [g.copy]), ...(g.deletedCases ?? [])]));
  const untouched = answer.cases.filter((c) => !touched.has(c.id)).length;
  const lines = summaryLines({ copySha, goldSha: createHash('sha256').update(goldBytes).digest('hex'), manualSha: manual?.sha256 ?? null, cases: caseCount, injected: gold.length, repeat: options.repeat, hasVerify: options.verify !== undefined, rounds, totals, untouched, catalogProvided: options.tree !== undefined });
  for (const line of lines) say(line);
  const validRounds = rounds.filter((r) => r.draftValid && (options.verify === undefined ? true : r.verifyValid));
  const mechanicalAllFound = validRounds.every(r => r.score!.detections.filter(d => d.entry.seen_by === 'mechanical').every(d => d.mechanical));
  const scores = validRounds.map((r) => r.score).filter((s): s is Score => s !== undefined);
  const structureClean = scores.length > 0 && scores.every((s) => s.structure.falsePositives.length === 0 && s.structure.missed.length === 0) && (options.tree === undefined || validRounds.every(r => r.catalog !== undefined && !r.catalog.requests.length && !r.catalog.missed.length && !r.catalog.extra.length));
  return validRounds.length === rounds.length && rounds.length > 0 && mechanicalAllFound && structureClean ? 0 : 1;
}

const packOf = (detail: RunLike): string => detail.run.pack;
const draftRunJson = (drivers: Drivers, review: { calls: string }, dir: string): string | null => {
  const run = [...new Set(parseCallLog(review.calls).filter((l) => l.run !== null && l.acceptance === 'accepted').map((l) => l.run as string))][0];
  if (run === undefined) return null;
  const shown = drivers.show(run);
  if (shown.code !== 0) return null;
  writeFileSync(join(dir, 'draft.run.json'), shown.json);
  return shown.json;
};
const verifyCodeJson = (drivers: Drivers, review: { calls: string }, dir: string): string | null => {
  const run = [...new Set(parseCallLog(review.calls).filter((l) => l.run !== null && l.acceptance === 'accepted').map((l) => l.run as string))][0];
  if (run === undefined) return null;
  const shown = drivers.show(run);
  if (shown.code !== 0) return null;
  writeFileSync(join(dir, 'verify.run.json'), shown.json);
  return shown.json;
};

/** Refuses an --out inside the repository: the copy, the gold and the run evidence hold real content. */
export function outAllowed(out: string): boolean {
  try { outsideGit(out); return true; }
  catch (error) { if (error instanceof CatalogOutputError) return false; throw error; }
}

function main(): number {
  if (!process.env.HUB_REAL_TOKEN) { console.error('缺少 HUB_REAL_TOKEN：由集成者提供令牌后再启动，评审未运行'); return 2; }
  const [source, plan, out] = [arg('source'), arg('plan'), arg('out')];
  const draftPath = arg('draft');
  const repeat = Number(arg('repeat') ?? 3);
  if (!source || !plan || !out || !draftPath) {
    console.error('用法：HUB_REAL_TOKEN=… node scripts/real/measure-review.ts --source <脑图 json> --plan <计划 json> [--keep <n>] [--manual <片段>] [--case-rule marked|tagged] --draft <会话 json> [--verify <会话 json>] [--repeat 3] [--baseline <基线目录>] [--tree <命令树原件>] [--submission <原件路径，{n}为轮次>] [--catalog-table <目录表>] [--catalog-manifest <pack.json>] [--argument-types <声明数组 JSON>] --out <目录>');
    return 2;
  }
  if (!outAllowed(out)) {
    console.error('拒绝：--out 在仓库里面，副本和标准答案不能进仓库');
    return 2;
  }
  const caseRuleArg = arg('case-rule');
  if (caseRuleArg !== undefined && caseRuleArg !== 'marked' && caseRuleArg !== 'tagged') {
    console.error('--case-rule 只认 marked 或 tagged');
    return 2;
  }
  const keep = arg('keep');
  let sessions: ReturnType<typeof validateSessionStartup>;
  try { sessions = validateSessionStartup(readSession(draftPath,'--draft'),arg('verify') === undefined ? undefined : readSession(arg('verify')!,'--verify')); }
  catch(error) { const diagnostic=recordRefusal(out,error); console.error('拒绝：'+refusalSummary(error)+(diagnostic?'；私有诊断 '+diagnostic:'')); return error instanceof SessionRefusal ? 2 : 1; }
  if (sessions.code === 2) { const diagnostic=recordRefusal(out,sessions.error); console.error('拒绝：'+sessions.message+(diagnostic?'；私有诊断 '+diagnostic:'')); return 2; }
  try {
    const code = measureReview(
      {
        source,
        plan,
        ...(keep === undefined ? {} : { keep: Number(keep) }),
        ...(arg('manual') === undefined ? {} : { manual: arg('manual') }),
        ...(caseRuleArg === undefined ? {} : { caseRule: caseRuleArg }),
        draft: sessions.draft,
        ...(sessions.verify === undefined ? {} : {verify:sessions.verify}),
        repeat,
        ...(arg('baseline') === undefined ? {} : { baseline: arg('baseline') }),
        ...(arg('tree') === undefined ? {} : { tree: arg('tree') }),
        ...(arg('submission') === undefined ? {} : { submission: arg('submission') }),
        ...(arg('argument-types') === undefined ? {} : { argumentTypes: arg('argument-types') }),
        ...(arg('catalog-manifest') === undefined ? {} : { catalogManifest: arg('catalog-manifest') }),
        ...(arg('catalog-table') === undefined ? {} : { catalogTable: arg('catalog-table') }),
        out,
      },
      realDrivers,
      (line) => console.log(line),
    );
    return code;
  } catch (error) {
    const diagnostic = recordRefusal(out, error);
    console.error('拒绝：' + (error instanceof CatalogOutputError ? '输出目录已有证据或路径不可用，请改用 Git 外的新目录后重跑' : refusalSummary(error)) + (diagnostic ? '；私有诊断 ' + diagnostic : '；私有诊断未保存，改用 Git 外可写目录后重跑'));
    return 1;
  }
}

if (import.meta.main) process.exitCode = main();
