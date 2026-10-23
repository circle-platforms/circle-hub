import { recordRefusal, refusalSummary } from './lib/inject.ts';
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
//     [--baseline <previous --out>] --out <dir>
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { caseNodes, firstCases, inject, type ManualFragment, type MindTree, type Planned } from './lib/inject.ts';
import { aggregate, score, type AggregateRun, type ResultLike, type Score } from './lib/score.ts';
import { literalGold } from './gold/literal.ts';
import { parseCallLog } from './review-circle.ts';

export interface SessionSpec {
  /** review-circle.ts's endpoint and connection arguments, verbatim. */
  args: string[];
  /** The prompt template; {copy} becomes the copy path, {draft_run} this round's draft run. */
  prompt: string;
}

export interface Drivers {
  /** Runs one review-circle session (the real one spawns `node scripts/real/review-circle.ts`). */
  review(spec: SessionSpec, prompt: string, out: string, name: string): { code: number; calls: string };
  /** Fetches one run (`node bin/circle-hub run show <run> --json`). */
  show(run: string): { code: number; json: string };
}

/** The real drivers: subprocesses, with the Hub's loopback URL and the repo's binary. */
export const realDrivers: Drivers = {
  review: (spec, prompt, out, name) => {
    const run = spawnSync('node', [resolve(import.meta.dirname, 'review-circle.ts'), ...spec.args, '--prompt', prompt, '--out', out, '--name', name], { cwd: resolve(import.meta.dirname, '../..'), encoding: 'utf8', env: process.env });
    return { code: run.status ?? 1, calls: existsSync(join(out, `${name}.calls.jsonl`)) ? readFileSync(join(out, `${name}.calls.jsonl`), 'utf8') : '' };
  },
  show: (run) => {
    const shown = spawnSync('node', ['bin/circle-hub', 'run', 'show', run, '--json'], { cwd: resolve(import.meta.dirname, '../..'), encoding: 'utf8', env: process.env, maxBuffer: 64 * 1024 * 1024 });
    return { code: shown.status ?? 1, json: shown.stdout };
  },
};

/** The fixed invalid reasons (task step 4): nothing else may be said on the screen. */
export type InvalidReason = '没有受理' | '不止一个运行' | '评审对象不是副本' | '条目数不对' | '任务包不对' | '前驱不对' | '取不到运行';

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
  out: string;
}

const MAX_CASES = 100; // packs/workflow/case-review/SKILL.md: one run reviews at most 100 cases

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

export function parseSession(text: string, where: string): SessionSpec {
  const value = JSON.parse(text) as { args?: unknown; prompt?: unknown };
  if (!Array.isArray(value.args) || value.args.some((a) => typeof a !== 'string') || typeof value.prompt !== 'string') {
    throw new Error(`${where} 的会话 json 要是 { "args": [...], "prompt": "..." }`);
  }
  return { args: value.args as string[], prompt: value.prompt };
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

/** The summary counts of the fixed screen lines; no node id, title or text appears here. */
export function summaryLines(options: { copySha: string; goldSha: string; manualSha: string | null; cases: number; injected: number; repeat: number; hasVerify: boolean; rounds: RoundOutcome[]; totals: ReturnType<typeof aggregate>; untouched: number }): string[] {
  const valid = options.rounds.filter((r) => r.draftValid && (options.hasVerify ? r.verifyValid : true));
  const lines = [
    `副本 sha256 ${options.copySha}；标准答案 sha256 ${options.goldSha}${options.manualSha === null ? '' : `；片段 sha256 ${options.manualSha}`}；用例 ${options.cases} 个，注入 ${options.injected} 处；重复 ${options.repeat} 次，有效 ${valid.length} 次`,
  ];
  for (const round of options.rounds) {
    const verdict = (ok: boolean, reason?: string): string => (ok ? '有效' : `无效（${reason}）`);
    void verdict;
    lines.push(
      `第 ${round.n} 次：初评 ${round.draftPack || '未取得'} ${verdict(round.draftValid, round.draftReason)}${options.hasVerify ? `；复核 ${round.verifyPack || '未取得'} ${verdict(round.verifyValid, round.verifyReason)}` : ''}`,
    );
  }
  for (const kind of options.totals.kinds) {
    lines.push(`${kind.title}（${kind.kind}）：注入 ${kind.injected}×${kind.validRuns}；Hub 字面检查 ${kind.mechanical}；初评 ${kind.draft}；复核 ${kind.verify}；合起来 ${kind.combined}`);
  }
  const scores = valid.map((r) => r.score!).filter((s): s is Score => s !== undefined);
  const sum = (pick: (s: Score) => number): number => scores.reduce((n, s) => n + pick(s), 0);
  lines.push(
    `未注入的用例 ${options.untouched} 个：Hub 标记支持 ${sum((s) => s.structure.supported.length)}、误报 ${sum((s) => s.structure.falsePositives.length)}、漏标 ${sum((s) => s.structure.missed.length)}；未独立核对 ${sum((s) => s.otherMarks.total)}（未改动评审里没有的 ${sum((s) => s.otherMarks.fresh)}）；目录类标记还没有独立答案 ${sum(s => s.otherMarks.catalog.total)} 条（未改动评审里没有的 ${sum(s => s.otherMarks.catalog.fresh)} 条）；各次相同 ${options.totals.structureStable === null ? '无从比较' : options.totals.structureStable ? '是' : '否'}；不计分 ${sum((s) => s.literalUnscored) + (scores[0]?.noUniqueId ?? 0)}（data.id 缺失或重复 ${scores[0]?.noUniqueId ?? 0} 个）`,
  );
  lines.push(
    `未注入的用例上模型的发现：初评 ${sum((s) => s.extras.length)} 个用例（未改动评审里没有的 ${sum((s) => s.extras.filter((e) => !e.inBaseline).length)}），复核新增 ${sum((s) => s.verifyExtras.length)} 个用例`,
  );
  const mechanicalAllFound = scores.every(s => s.detections.filter(d => d.entry.seen_by === 'mechanical').every(d => d.mechanical));
  const structureClean = scores.every((s) => s.structure.falsePositives.length === 0 && s.structure.missed.length === 0);
  lines.push(
    `通过：Hub 看得见的注入缺陷全部查出 ${mechanicalAllFound ? '是' : '否'}；未注入用例上没有误报和漏标 ${structureClean ? '是' : '否'}；每次都有效 ${valid.length === options.rounds.length && options.rounds.length > 0 ? '是' : '否'}`,
  );
  if (options.repeat < 3) lines.push('不构成统计：重复次数少于 3');
  return lines;
}

export function measureReview(options: MeasureOptions, drivers: Drivers, say: (line: string) => void = () => {}): number {
  // 1. The copy, the gold and the independent answer — always computed, never skipped.
  let tree = JSON.parse(readFileSync(options.source, 'utf8')) as MindTree;
  if (options.keep !== undefined) tree = firstCases(tree, options.keep);
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
    say(`拒绝：副本有 ${caseCount} 个用例，超过一次运行的 ${MAX_CASES} 个上限`);
    return 2;
  }

  // 2. The baseline rounds (an earlier empty-plan --out): their draft results mark what the unchanged review already had.
  const baselineResults: ResultLike[] = [];
  if (options.baseline !== undefined) {
    for (const entry of readdirSync(options.baseline, { withFileTypes: true }).filter((e) => e.isDirectory()).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const file = join(options.baseline, entry.name, 'draft.run.json');
      if (!existsSync(file)) continue;
      const detail = JSON.parse(readFileSync(file, 'utf8')) as RunLike;
      if (detail.latest !== null) baselineResults.push(detail.latest.result as unknown as ResultLike);
    }
  }
  const baseline = baselineResults.at(-1);

  // 3. The rounds.
  const gold = injected.gold;
  const rounds: RoundOutcome[] = [];
  for (let n = 1; n <= options.repeat; n++) {
    const dir = join(options.out, `r${n}`);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const draftPrompt = options.draft.prompt.replaceAll('{copy}', join(options.out, 'mutated.json'));
    const draft = drivers.review(options.draft, draftPrompt, dir, 'draft');
    writeFileSync(join(dir, 'draft.client-status.json'), JSON.stringify({ code: draft.code }), { mode: 0o600 });
    const draftJudged = judgeRun(draft.calls, draftRunJson(drivers, draft, dir) !== null ? String(readFileSync(join(dir, 'draft.run.json'), 'utf8')) : '{}', { packPrefix: 'case-review@', subjectSha: copySha, caseCount });
    let round: RoundOutcome;
    if (draftJudged.ok) {
      writeFileSync(join(dir, 'draft.run.json'), JSON.stringify(draftJudged.detail, null, 2));
      if (options.verify === undefined) {
        round = { n, draftPack: packOf(draftJudged.detail), draftValid: true, draftRun: draftJudged.run, verifyPack: '', verifyValid: true };
        round.score = score(gold, draftJudged.result, { ...(baseline === undefined ? {} : { baseline }), literal: answer });
      } else {
        const verifyPrompt = options.verify.prompt.replaceAll('{copy}', join(options.out, 'mutated.json')).replaceAll('{draft_run}', draftJudged.run);
        const verifyRun = drivers.review(options.verify, verifyPrompt, dir, 'verify');
        writeFileSync(join(dir, 'verify.client-status.json'), JSON.stringify({ code: verifyRun.code }), { mode: 0o600 });
        const verifyJudged = judgeRun(verifyRun.calls, verifyCodeJson(drivers, verifyRun, dir) ?? '{}', { packPrefix: 'case-review-verify@', predecessor: draftJudged.run });
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
  const lines = summaryLines({ copySha, goldSha: createHash('sha256').update(goldBytes).digest('hex'), manualSha: manual?.sha256 ?? null, cases: caseCount, injected: gold.length, repeat: options.repeat, hasVerify: options.verify !== undefined, rounds, totals, untouched });
  for (const line of lines) say(line);
  const validRounds = rounds.filter((r) => r.draftValid && (options.verify === undefined ? true : r.verifyValid));
  const mechanicalAllFound = validRounds.every(r => r.score!.detections.filter(d => d.entry.seen_by === 'mechanical').every(d => d.mechanical));
  const scores = validRounds.map((r) => r.score).filter((s): s is Score => s !== undefined);
  const structureClean = scores.length > 0 && scores.every((s) => s.structure.falsePositives.length === 0 && s.structure.missed.length === 0);
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
  const absolute = isAbsolute(out) ? resolve(out) : resolve(process.cwd(), out);
  const repo = resolve(import.meta.dirname, '../..');
  return !(absolute === repo || absolute.startsWith(`${repo}/`));
}

function main(): number {
  const [source, plan, out] = [arg('source'), arg('plan'), arg('out')];
  const draftPath = arg('draft');
  const repeat = Number(arg('repeat') ?? 3);
  if (!source || !plan || !out || !draftPath) {
    console.error('用法：HUB_REAL_TOKEN=… node scripts/real/measure-review.ts --source <脑图 json> --plan <计划 json> [--keep <n>] [--manual <片段>] [--case-rule marked|tagged] --draft <会话 json> [--verify <会话 json>] [--repeat 3] [--baseline <基线目录>] --out <目录>');
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
  try {
    const code = measureReview(
      {
        source,
        plan,
        ...(keep === undefined ? {} : { keep: Number(keep) }),
        ...(arg('manual') === undefined ? {} : { manual: arg('manual') }),
        ...(caseRuleArg === undefined ? {} : { caseRule: caseRuleArg }),
        draft: parseSession(readFileSync(draftPath, 'utf8'), '--draft'),
        ...(arg('verify') === undefined ? {} : { verify: parseSession(readFileSync(arg('verify')!, 'utf8'), '--verify') }),
        repeat,
        ...(arg('baseline') === undefined ? {} : { baseline: arg('baseline') }),
        out,
      },
      realDrivers,
      (line) => console.log(line),
    );
    return code;
  } catch (error) {
    recordRefusal(out, error);
    console.error('拒绝：' + refusalSummary(error));
    return 1;
  }
}

if (import.meta.main) process.exitCode = main();
