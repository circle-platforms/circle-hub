// Tests of the repeated measurement driver (task gold-review step 4) with fake sessions and a fake `run show`: no
// real client, no real model, no real Hub. The fixtures are synthetic mind maps and run details.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { MindNode, MindTree, Planned } from './lib/inject.ts';
import { judgeRun, measureReview, outAllowed, type Drivers, type MeasureOptions, type SessionSpec } from './measure-review.ts';

const leaf = (id: string, text: string): MindNode => ({ data: { id, text }, children: [] });
const kase = (id: string, text: string, expected: string, tag = 'configuration'): MindNode => ({ data: { id, text, resource: [tag], priority: 2 }, children: [leaf(`${id}e`, expected)] });
const group = (id: string, text: string, ...children: MindNode[]): MindNode => ({ data: { id, text }, children });
const document = (n: number): MindTree => ({
  root: group('r', '文档', group('g', '配置', ...Array.from({ length: n }, (_, i) => kase(`c${i + 1}`, `用例${i + 1}`, '老化时间为 3600 秒')))),
});

const plan: Planned[] = [{ label: '期望结果缺失', seen_by: 'mechanical', op: { kind: 'delete_expected', node: 'c1' } }];

/** A run detail the way `run show --json` gives it. */
const runDetail = (over: { run?: string; pack?: string; predecessor?: string; items?: number; sources?: Array<{ reference: string }>; acceptance?: string; delivered?: unknown[] }): string =>
  JSON.stringify({
    run: { run: over.run ?? 'rn_1', pack: over.pack ?? 'case-review@1.0.0', items: Array.from({ length: over.items ?? 3 }, () => ({ item: 'x' })), sources: over.sources ?? [], ...(over.predecessor === undefined ? {} : { predecessor: over.predecessor }) },
    latest: { record: 'rec:1', result: { acceptance: over.acceptance ?? 'accepted', partitions: { delivered: over.delivered ?? [], rejected: [], quarantined: [], incomplete: [] } } },
  });

const callLine = (run: string | null, acceptance: string | null): string =>
  JSON.stringify({ at: '2026-10-23T10:00:00.000Z', tool: 'submit_result', run, call_result: 'ok', acceptance, error_code: null, duration_ms: 1, args_size: 1, session: null });

interface Scripted {
  /** Per round: the call log text and the run json the fake `run show` returns (lazy: the copy exists only once the
   * round has begun). */
  drafts: Array<{ calls: string; run: () => string }>;
  verifies?: Array<{ calls: string; run: () => string }>;
}

/** Fake drivers: the calls text is also left in <out>/<name>.calls.jsonl the way the real one does; `show` answers
 * with the script of the session that most recently ran. */
const fakeDrivers = (scripted: Scripted): Drivers & { prompts: string[] } => {
  const prompts: string[] = [];
  let draftAt = -1;
  let verifyAt = -1;
  let last: 'draft' | 'verify' = 'draft';
  return {
    prompts,
    review: (spec: SessionSpec, prompt: string, out: string, name: string) => {
      prompts.push(prompt);
      const script = name === 'draft' ? scripted.drafts[draftAt + 1] : scripted.verifies?.[verifyAt + 1];
      if (script === undefined) return { code: 1, calls: '' };
      if (name === 'draft') draftAt += 1;
      else verifyAt += 1;
      last = name === 'draft' ? 'draft' : 'verify';
      writeFileSync(join(out, `${name}.calls.jsonl`), script.calls);
      return { code: 0, calls: script.calls };
    },
    show: () => {
      const script = last === 'draft' ? scripted.drafts[draftAt] : scripted.verifies?.[verifyAt];
      return { code: 0, json: script === undefined ? '{}' : script.run() };
    },
  };
};

const options = (out: string, over: Partial<MeasureOptions> = {}): MeasureOptions => ({
  source: '',
  plan: '',
  draft: { args: ['--endpoint-from', 'circle'], prompt: '请评审 {copy}' },
  repeat: 1,
  out,
  ...over,
});

const fixtures = (tree: MindTree, planned: readonly Planned[]): { out: string; source: string; plan: string } => {
  const out = mkdtempSync(join(tmpdir(), 'measure-'));
  const source = join(out, 'source.json');
  const planPath = join(out, 'plan.json');
  writeFileSync(source, JSON.stringify(tree));
  writeFileSync(planPath, JSON.stringify(planned));
  return { out, source, plan: planPath };
};

/** The copy's sha as measureReview wrote it (the fakes read it at round time, like a real check would). */
const copyShaOf = (out: string): string => createHash('sha256').update(readFileSync(join(out, 'mutated.json'))).digest('hex');

test('three valid rounds with the Hub finding everything: exit 0, scores written, screen clean', () => {
  const { out, source, plan: planPath } = fixtures(document(3), plan);
  const delivered = [
    { item: 'run:x:case:c1', requirements: [{ requirement: 'literal', layers: [{ terminal: 'violation', attribution: 'subject' }], claims: [{ statement: { verdict: 'refute', code: 'core.structure.required_empty' }, qualifier: { nature: 'fact' } }] }] },
    { item: 'run:x:case:c2', requirements: [] },
    { item: 'run:x:case:c3', requirements: [] },
  ];
  const calls = callLine('rn_9', 'accepted');
  const drivers = {
    prompts: [] as string[],
    review: (_spec: SessionSpec, prompt: string, outDir: string, name: string): { code: number; calls: string } => {
      drivers.prompts.push(prompt);
      writeFileSync(join(outDir, `${name}.calls.jsonl`), calls);
      return { code: 0, calls };
    },
    show: (run: string): { code: number; json: string } => {
      assert.equal(run, 'rn_9');
      return { code: 0, json: runDetail({ run: 'rn_9', items: 3, sources: [{ reference: `src:${copyShaOf(out)}` }], delivered }) };
    },
  } satisfies Drivers & { prompts: string[] };
  const lines: string[] = [];
  const code = measureReview({ ...options(out), source, plan: planPath, repeat: 3 }, drivers, (line) => lines.push(line));
  assert.equal(code, 0);
  assert.equal(lines.filter((l) => l.startsWith('第')).length, 3);
  assert.match(lines[0]!, /^副本 sha256 [0-9a-f]{64}；标准答案 sha256 [0-9a-f]{64}；用例 3 个，注入 1 处；重复 3 次，有效 3 次$/);
  assert.ok(lines.some((l) => l.includes('Hub 看得见的注入缺陷全部查出 是')));
  for (let n = 1; n <= 3; n++) {
    const scoreJson = JSON.parse(readFileSync(join(out, `r${n}`, 'score.json'), 'utf8')) as { recall: { mechanical: [number, number] } };
    assert.deepEqual(scoreJson.recall.mechanical, [1, 1]);
  }
  assert.ok(drivers.prompts.every((p) => p.includes(join(out, 'mutated.json'))), 'the prompt names the copy');
  const screen = lines.join('\n');
  for (const secret of ['c1', 'c2', '用例1', 'rn_9', '老化时间']) assert.ok(!screen.includes(secret), `the screen leaks ${secret}`);
});

test('a round whose submissions were never accepted is invalid with the fixed reason, and the exit code is 1', () => {
  const { out, source, plan: planPath } = fixtures(document(3), plan);
  const drivers = fakeDrivers({ drafts: [{ calls: callLine('rn_1', null), run: () => runDetail({ items: 3 }) }] });
  const lines: string[] = [];
  const code = measureReview({ ...options(out), source, plan: planPath }, drivers, (line) => lines.push(line));
  assert.equal(code, 1);
  assert.ok(lines.some((l) => l.includes('初评 未取得 无效（没有受理）')), lines.join('\n'));
});

test('a run whose subject is not the copy is invalid with the fixed reason', () => {
  const { out, source, plan: planPath } = fixtures(document(3), plan);
  const drivers = fakeDrivers({ drafts: [{ calls: callLine('rn_1', 'accepted'), run: () => runDetail({ items: 3, sources: [{ reference: `src:${'a'.repeat(64)}` }] }) }] });
  const lines: string[] = [];
  measureReview({ ...options(out), source, plan: planPath }, drivers, (line) => lines.push(line));
  assert.ok(lines.some((l) => l.includes('无效（评审对象不是副本）')), lines.join('\n'));
});

test('a verify run with the wrong predecessor is invalid with the fixed reason', () => {
  const { out, source, plan: planPath } = fixtures(document(3), plan);
  const calls = callLine('rn_5', 'accepted');
  const draftRun = () => runDetail({ run: 'rn_5', items: 3, sources: [{ reference: `src:${copyShaOf(out)}` }] });
  const verifyRun = JSON.stringify({ run: { run: 'rn_6', pack: 'case-review-verify@1.0.0', items: [], sources: [], predecessor: 'rn_other' }, latest: { record: 'rec:2', result: { acceptance: 'accepted', partitions: { delivered: [], rejected: [], quarantined: [], incomplete: [] } } } });
  const drivers = fakeDrivers({ drafts: [{ calls, run: draftRun }], verifies: [{ calls, run: () => verifyRun }] });
  const lines: string[] = [];
  const code = measureReview({ ...options(out), source, plan: planPath, verify: { args: [], prompt: '复核 {draft_run}' } }, drivers, (line) => lines.push(line));
  assert.equal(code, 1);
  assert.ok(lines.some((l) => l.includes('复核 case-review-verify@1.0.0 无效（前驱不对）')), lines.join('\n'));
  assert.ok(drivers.prompts.some((p) => p.includes('rn_5')), 'the verify prompt names the draft run');
});

test('an --out inside the repository is refused', () => {
  assert.equal(outAllowed(join(import.meta.dirname, 'tmp-out')), false);
  assert.equal(outAllowed(join(tmpdir(), 'outside')), true);
});

test('a copy with more than 100 cases is refused', () => {
  const { out, source, plan: planPath } = fixtures(document(101), []);
  const lines: string[] = [];
  const code = measureReview({ ...options(out), source, plan: planPath }, fakeDrivers({ drafts: [] }), (line) => lines.push(line));
  assert.equal(code, 2);
  assert.ok(lines.some((l) => l.includes('超过一次运行的 100 个上限')), lines.join('\n'));
});

test('a missed Hub-visible defect makes the exit code 1 even when every round is valid', () => {
  const { out, source, plan: planPath } = fixtures(document(3), plan);
  const delivered = [{ item: 'run:x:case:c1', requirements: [] }, { item: 'run:x:case:c2', requirements: [] }, { item: 'run:x:case:c3', requirements: [] }];
  const calls = callLine('rn_7', 'accepted');
  const drivers = fakeDrivers({ drafts: [{ calls, run: () => runDetail({ run: 'rn_7', items: 3, sources: [{ reference: `src:${copyShaOf(out)}` }], delivered }) }] });
  const lines: string[] = [];
  const code = measureReview({ ...options(out), source, plan: planPath }, drivers, (line) => lines.push(line));
  assert.equal(code, 1);
  assert.ok(lines.some((l) => l.includes('Hub 看得见的注入缺陷全部查出 否')), lines.join('\n'));
});

test('judgeRun refuses the wrong pack, several accepted runs and the wrong item count with their fixed reasons', () => {
  const pack = judgeRun(callLine('rn_2', 'accepted'), runDetail({ pack: 'other-pack@1.0.0' }), { packPrefix: 'case-review@' });
  assert.equal(pack.ok, false);
  assert.equal(pack.reason, '任务包不对');
  const several = judgeRun(`${callLine('rn_2', 'accepted')}\n${callLine('rn_3', 'accepted')}`, runDetail({}), { packPrefix: 'case-review@' });
  assert.equal(several.ok, false);
  assert.equal(several.reason, '不止一个运行');
  const items = judgeRun(callLine('rn_2', 'accepted'), runDetail({ items: 4 }), { packPrefix: 'case-review@', caseCount: 3 });
  assert.equal(items.ok, false);
  assert.equal(items.reason, '条目数不对');
});
