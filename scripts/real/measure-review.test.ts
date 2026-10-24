import { canonicalJson } from './gold/compile-check.ts';
import type { Attribution, StaticTerminal, Reason } from '../../contracts/generated/vocabulary.ts';
// Tests of the repeated measurement driver (task gold-review step 4) with fake sessions and a fake `run show`: no
// real client, no real model, no real Hub. The fixtures are synthetic mind maps and run details.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { MindNode, MindTree, Planned } from './lib/inject.ts';
import { judgeRun, measureReview, outAllowed, parseSession, type Drivers, type MeasureOptions, type SessionSpec } from './measure-review.ts';

const staticFixture = (terminal: StaticTerminal, attribution?: Attribution, reason?: Reason) => ({ terminal, ...(attribution === undefined ? {} : { attribution }), ...(reason === undefined ? {} : { reason }) });

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
    { item: 'run:x:case:c1', requirements: [{ requirement: 'literal', layers: [staticFixture('violation', 'author_input')], claims: [{ statement: { verdict: 'refute', code: 'core.structure.required_empty' }, qualifier: { nature: 'fact', source_role: 'subject' } }] }] },
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

test('node-id refutations on fallback identities are disclosed without failing the measurement', () => {
  const tree: MindTree = { root: group('r', '合成文档', group('g', '合成分组',
    kase('same', '第一份', '合成期望甲'), kase('same', '第二份', '合成期望乙'),
    { data: { text: '缺少编号', priority: 2, resource: ['configuration'] }, children: [leaf('missing-e', '合成期望丙')] },
    kase('healthy', '健康用例', '合成期望丁'),
  )) };
  const { out, source, plan: planPath } = fixtures(tree, []);
  const delivered = ['same#1', 'same#2', '@6'].map(id => ({ item: `doc:${id}`, requirements: [{ requirement: 'literal', layers: [staticFixture('violation', 'author_input')], claims: [{ statement: { verdict: 'refute', code: id.startsWith('@') ? 'core.structure.required_empty' : 'core.structure.duplicate_key' }, qualifier: { nature: 'fact', source_role: 'subject' } }] }] }));
  delivered.push({ item: 'doc:healthy', requirements: [] });
  const drivers = fakeDrivers({ drafts: [{ calls: callLine('rn_synthetic', 'accepted'), run: () => runDetail({ items: 4, sources: [{ reference: `src:${copyShaOf(out)}` }], delivered }) }] });
  const lines: string[] = [];
  assert.equal(measureReview({ ...options(out), source, plan: planPath }, drivers, line => lines.push(line)), 0);
  assert.ok(lines.some(l => l.includes('误报 0、漏标 0') && l.includes('data.id 缺失或重复 3 个')));
  assert.ok(!lines.join('\n').includes('same#'));
});

test('measurement reports each catalog mark as lacking an independent answer without judging it', () => {
  const { out, source, plan: planPath } = fixtures(document(1), []);
  const delivered = [{ item: 'doc:c1', requirements: [{ requirement: 'catalog', layers: [staticFixture('violation', 'author_input')], claims: ['core.catalog.not_member', 'core.catalog.param_out_of_range'].map(code => ({ statement: { verdict: 'refute', code }, qualifier: { nature: 'fact', source_role: 'subject' } })) }] }];
  const drivers = fakeDrivers({ drafts: [{ calls: callLine('rn_synthetic', 'accepted'), run: () => runDetail({ items: 1, sources: [{ reference: `src:${copyShaOf(out)}` }], delivered }) }] });
  const lines: string[] = [];
  assert.equal(measureReview({ ...options(out), source, plan: planPath }, drivers, line => lines.push(line)), 0);
  assert.ok(lines.some(l => l.includes('目录类标记还没有独立答案 2 条')));
  assert.ok(!lines.join('\n').includes('core.catalog'));
});

test('review 1: judgment-only injections never fail the mechanical exit gate', () => {
  const planned: Planned[] = [...plan, { label: '含糊期望', seen_by: 'judgment', op: { kind: 'vague_expected', node: 'c2', text: '正常' } }];
  const f = fixtures(document(3), planned), lines: string[] = [];
  const delivered = [{ item: 'doc:c1', requirements: [{ requirement: 'literal', layers: [staticFixture('violation', 'author_input')], claims: [{ statement: { verdict: 'refute', code: 'core.structure.required_empty' }, qualifier: { nature: 'fact', source_role: 'subject' } }] }] }];
  const drivers = fakeDrivers({ drafts: Array.from({ length: 3 }, () => ({ calls: callLine('rn_mixed', 'accepted'), run: () => runDetail({ run: 'rn_mixed', items: 3, sources: [{ reference: `src:${copyShaOf(f.out)}` }], delivered }) })) });
  assert.equal(measureReview({ ...options(f.out), source: f.source, plan: f.plan, repeat: 3 }, drivers, line => lines.push(line)), 0);
  assert.ok(lines.some(line => line.includes('Hub 看得见的注入缺陷全部查出 是')));
});

test('review 5: refused runs do not shadow the one accepted run in a repaired session', () => {
  const f = fixtures(document(1), []), calls = callLine('rn_abandoned', 'not_accepted') + '\n' + callLine('rn_final', 'accepted');
  const detail = () => runDetail({ run: 'rn_final', items: 1, sources: [{ reference: `src:${copyShaOf(f.out)}` }], delivered: [{ item: 'doc:c1', requirements: [] }] });
  const driver = fakeDrivers({ drafts: [{ calls, run: detail }] });
  assert.equal(measureReview({ ...options(f.out), source: f.source, plan: f.plan }, driver, () => {}), 0);
  assert.equal(judgeRun(calls, detail(), { packPrefix: 'case-review@' }).ok, true);
});

test('review 6: accepted evidence survives a nonzero client exit and failed retrieval has its own reason', () => {
  const f = fixtures(document(1), []), calls = callLine('rn_timeout', 'accepted');
  const driver: Drivers = { review: () => ({ code: 1, calls }), show: () => ({ code: 0, json: runDetail({ run: 'rn_timeout', items: 1, sources: [{ reference: `src:${copyShaOf(f.out)}` }], delivered: [{ item: 'doc:c1', requirements: [] }] }) }) };
  assert.equal(measureReview({ ...options(f.out), source: f.source, plan: f.plan }, driver, () => {}), 0);
  const g = fixtures(document(1), []), lines: string[] = [];
  assert.equal(measureReview({ ...options(g.out), source: g.source, plan: g.plan }, { ...driver, show: () => ({ code: 1, json: '' }) }, s => lines.push(s)), 1);
  assert.ok(lines.some(l => l.includes('取不到运行'))); assert.ok(!lines.some(l => l.includes('任务包不对')));
});

test('review 10: endpoint session arguments cannot override driver prompt or output flags', () => {
  for (const flag of ['--prompt', '--out', '--name']) assert.throws(() => parseSession(JSON.stringify({ args: [flag, 'private-value'], prompt: 'synthetic' }), 'draft'), /驱动/);
});

test('review 11: invalid or empty baselines refuse startup and valid rounds are unioned', () => {
  const f = fixtures(document(2), []), baseline = fixtures(document(2), []).out;
  writeFileSync(join(baseline, 'mutated.json'), JSON.stringify(document(2)));
  const sha = createHash('sha256').update(readFileSync(join(baseline, 'mutated.json'))).digest('hex');
  const before = [
    [{ item: 'doc:c1', requirements: [{ requirement: 'catalog', layers: [staticFixture('violation', 'author_input')], claims: [{ statement: { verdict: 'refute', code: 'core.catalog.not_member' }, qualifier: { nature: 'fact', source_role: 'subject' } }] }] }],
    [{ item: 'doc:c2', requirements: [{ requirement: 'findings', layers: [], claims: [{ statement: { code: 'synthetic-finding' }, qualifier: { nature: 'judgment' } }] }] }],
  ];
  before.forEach((delivered, i) => { const dir = join(baseline, `r${i + 1}`); mkdirSync(dir); writeFileSync(join(dir, 'score.json'), '{}'); writeFileSync(join(dir, 'draft.run.json'), runDetail({ items: 2, sources: [{ reference: `src:${sha}` }], delivered })); });
  const drivers = fakeDrivers({ drafts: [{ calls: callLine('rn_current', 'accepted'), run: () => runDetail({ run: 'rn_current', items: 2, sources: [{ reference: `src:${copyShaOf(f.out)}` }], delivered: before.flat() }) }] });
  assert.equal(measureReview({ ...options(f.out), source: f.source, plan: f.plan, baseline }, drivers, () => {}), 0);
  const scored = JSON.parse(readFileSync(join(f.out, 'r1/score.json'), 'utf8')); assert.equal(scored.otherMarks.fresh, 0); assert.equal(scored.extras[0].inBaseline, true);
  const empty = fixtures(document(1), []); const lines: string[] = [];
  assert.equal(measureReview({ ...options(empty.out), source: empty.source, plan: empty.plan, baseline: fixtures(document(1), []).out }, fakeDrivers({ drafts: [] }), l => lines.push(l)), 2);
  assert.ok(lines.some(l => l.includes('--baseline') && l.includes('空计划基线')));
});

test('review 14: an invalid draft leaves verification explicitly unrun', () => {
  const f = fixtures(document(1), []), lines: string[] = [];
  measureReview({ ...options(f.out), source: f.source, plan: f.plan, verify: { args: [], prompt: 'verify' } }, fakeDrivers({ drafts: [{ calls: '', run: () => '{}' }] }), line => lines.push(line));
  assert.ok(lines.some(line => line.includes('复核 未跑（初评无效）'))); assert.ok(!lines.join('').includes('undefined'));
});

test('review 15: no valid rounds cannot claim that checks passed vacuously', () => {
  const f = fixtures(document(1), []), lines: string[] = [];
  measureReview({ ...options(f.out), source: f.source, plan: f.plan }, fakeDrivers({ drafts: [{ calls: '', run: () => '{}' }] }), line => lines.push(line));
  const pass = lines.find(line => line.startsWith('通过：'))!;
  assert.ok(!pass.includes('全部查出 是')); assert.ok(!pass.includes('没有误报和漏标 是')); assert.match(pass, /没有有效.*重跑/);
  assert.ok(lines.some(line => line.includes('有效运行少于 2') && line.includes('补足')));
});

const catalogFixture = (t: { after(fn: () => void): void }, over: { provideSubmission?: boolean; code?: string | null; negative?: boolean } = {}) => {
  const tree = document(1); tree.root.children![0].children![0].data.text = 'widget port 21';
  if (over.negative) tree.root.children![0].children![0].data.resource = ['Negative'];
  const files = fixtures(tree, []); t.after(() => rmSync(files.out, { recursive: true, force: true }));
  const commandTree = join(files.out, 'commands.xml');
  writeFileSync(commandTree, '<catalog version="10.8.1"><menu name="widget"><item name="port"><arguments><arg name="port" type="U16" limit="[1 - 20]"/></arguments></item></menu></catalog>');
  const argumentTypes = join(files.out, 'argument-types.json'); writeFileSync(argumentTypes, '[]');
  const original = join(files.out, 'submission-{n}.json');
  let round = 0;
  const driver: Drivers = {
    review: (_session, _prompt, dir, name) => { round++; const calls = callLine('rn_catalog', 'accepted'); writeFileSync(join(dir, `${name}.calls.jsonl`), calls); return { code: 0, calls }; },
    show: () => {
      const body = Buffer.from(JSON.stringify({ run: 'rn_catalog', items: [{ item: 'doc:c1', handling: 'handled', slots: { findings: [{ text: '合成引用', commands: [{ command: 'widget port 21' }] }] } }] }));
      if (over.provideSubmission !== false) writeFileSync(original.replace('{n}', String(round)), body);
      const code = over.code === undefined ? 'core.catalog.param_out_of_range' : over.code;
      const delivered = [{ item: 'doc:c1', requirements: [{ requirement: 'catalog', layers: [{ layer: 'static', ...staticFixture('violation', over.negative ? undefined : 'author_input') }], claims: code === null ? [] : [{ pointer: '/phrases/0', statement: { verdict: 'refute', code, data: { command: 'widget port 21' } }, qualifier: { nature: 'fact', source_role: 'subject' } }] }] }];
      const value = JSON.parse(runDetail({ run: 'rn_catalog', items: 1, sources: [{ reference: `src:${copyShaOf(files.out)}` }], delivered }));
      const manifest = JSON.parse(readFileSync(new URL('../../packs/workflow/case-review/pack.json', import.meta.url), 'utf8'));
      value.run.pack = manifest.id + '@' + manifest.version; value.run.pack_digest = createHash('sha256').update(canonicalJson(manifest)).digest('hex');
      value.run.root = 'a'.repeat(64); value.run.sources[0].role = 'subject';
      value.latest.result.run = 'rn_catalog'; value.latest.result.submission = createHash('sha256').update(canonicalJson(JSON.parse(body.toString()))).digest('hex');
      return { code: 0, json: JSON.stringify(value) };
    },
  };
  return { ...files, commandTree, argumentTypes, original, driver };
};

test('with --tree the measurement scores independent catalog marks and keeps source values off screen', t => {
  const f = catalogFixture(t), screen: string[] = [];
  assert.equal(measureReview({ ...options(f.out), source: f.source, plan: f.plan, tree: f.commandTree, argumentTypes: f.argumentTypes, submission: f.original, repeat: 3 }, f.driver, line => screen.push(line)), 0);
  assert.ok(screen.some(line => line.includes('目录独立核对') && line.includes('一致 3') && line.includes('设计缺口 0')));
  assert.ok(!screen.some(line => line.includes('目录类标记还没有独立答案')));
  for (const value of ['widget port', 'rn_catalog', 'doc:c1', 'core.catalog']) assert.ok(!screen.join('').includes(value));
  assert.equal(statSync(join(f.out, 'r1/catalog/catalog-marks.json')).mode & 0o777, 0o600);
});
test('with --tree but without original submission bytes the measurement records a design gap and exits one', t => {
  const f = catalogFixture(t, { provideSubmission: false }), screen: string[] = [];
  assert.equal(measureReview({ ...options(f.out), source: f.source, plan: f.plan, tree: f.commandTree, argumentTypes: f.argumentTypes }, f.driver, line => screen.push(line)), 1);
  const requests = JSON.parse(readFileSync(join(f.out, 'r1/catalog/evidence-requests.json'), 'utf8'));
  assert.ok(requests.some((r: { input: string; next_action: string }) => r.input === 'submission' && r.next_action.includes('get_nodes')));
});
for (const [label, code] of [['missed', null], ['wrong code', 'core.catalog.arity_mismatch']] as const) test(`independent catalog ${label} makes the measurement fail`, t => {
  const f = catalogFixture(t, { code });
  assert.equal(measureReview({ ...options(f.out), source: f.source, plan: f.plan, tree: f.commandTree, argumentTypes: f.argumentTypes, submission: f.original }, f.driver, () => {}), 1);
});
test('without --tree catalog marks remain unscored and say which input and action are missing', t => {
  const f = catalogFixture(t), screen: string[] = [];
  assert.equal(measureReview({ ...options(f.out), source: f.source, plan: f.plan }, f.driver, line => screen.push(line)), 0);
  assert.ok(screen.some(line => line.includes('还没有独立答案') && line.includes('缺 --tree')));
});

test('unsupported catalog scope is rejected before any review session starts', t => {
  const f = catalogFixture(t), declaration = join(f.out, 'unsupported-table.json');
  writeFileSync(declaration, JSON.stringify({ schema: 'catalog@1', scope: 'all' }));
  let calls = 0;
  const driver: Drivers = { ...f.driver, review: () => { calls++; throw new Error('must not start'); } };
  assert.equal(measureReview({ ...options(f.out), source: f.source, plan: f.plan, tree: f.commandTree, argumentTypes: f.argumentTypes, catalogTable: declaration }, driver, () => {}), 1);
  assert.equal(calls, 0);
  assert.ok(JSON.parse(readFileSync(join(f.out, 'catalog-preflight/evidence-requests.json'), 'utf8')).some((r: { pointer: string }) => r.pointer === '/scope'));
});

test('measurement fetches the accepted submission record after run show without reopening a session', t => {
 const f=catalogFixture(t,{provideSubmission:false}); let fetched=0;
 const driver:Drivers={...f.driver,show:(id)=>{const shown=JSON.parse(f.driver.show(id).json);shown.submissions=[{record:'c'.repeat(64),result:shown.latest.record}];return{code:0,json:JSON.stringify(shown)};},
 readSubmission:(reference)=>{fetched++;assert.equal(reference,'rec:'+'c'.repeat(64));return{code:0,json:JSON.stringify({run:'rn_catalog',items:[{item:'doc:c1',handling:'handled',slots:{findings:[{text:'合成引用',commands:[{command:'widget port 21'}]}]}}]})};}};
 assert.equal(measureReview({...options(f.out),...f,tree:f.commandTree},driver,()=>{}),0);
 assert.equal(fetched,1);
});

test('record reads join all pages and refuse partial or differently bound output', async () => {
 const {readSubmissionPages}=await import('./measure-review.ts'); let page=0;
 const result=readSubmissionPages(args=>{page++;return{code:0,json:JSON.stringify({call_result:'ok',content:{reference:args.reference,readable:true,text:page===1?'{"items":':'[]}'},next:page===1?'page-two':null})};},'rec:'+'d'.repeat(64));
 assert.equal(result.code,0); assert.deepEqual(JSON.parse(result.json),{items:[]}); assert.equal(page,2);
 assert.equal(readSubmissionPages(()=>({code:0,json:JSON.stringify({content:{reference:'other',readable:true,text:'{}'}})}),'rec:'+'d'.repeat(64)).code,1);
});

test('missing locked-root argument type declarations refuses before spending a session', t => {
  const f = catalogFixture(t); let calls = 0;
  const driver = {...f.driver, review: () => { calls++; throw new Error('must not start'); }};
  assert.equal(measureReview({...options(f.out),source:f.source,plan:f.plan,tree:f.commandTree},driver,()=>{}),1);
  assert.equal(calls,0);
});

test('catalog gaps remain unverified on screen and name the evidence follow up', t => {
  const f=catalogFixture(t,{provideSubmission:false}), screen:string[]=[];
  assert.equal(measureReview({...options(f.out),source:f.source,plan:f.plan,tree:f.commandTree,argumentTypes:f.argumentTypes},f.driver,line=>screen.push(line)),1);
  assert.ok(screen.some(line=>/没有误报和漏标 没判（设计缺口/.test(line)));
  assert.ok(screen.some(line=>line.includes('r1/catalog/evidence-requests.json') && line.includes('follow_up')));
  assert.ok(screen.some(line=>line.includes('未独立核对 1')));
});

test('existing measurement evidence is refused with a fixed reason before any session or overwrite', t => {
 for(const collision of ['r1/catalog','catalog-preflight']) {
  const f=catalogFixture(t); mkdirSync(join(f.out,collision),{recursive:true});
  writeFileSync(join(f.out,'mutated.json'),'original sentinel');
  let calls=0; const driver={...f.driver,review:()=>{calls++; throw new Error('must not start');}};
  assert.throws(()=>measureReview({...options(f.out),source:f.source,plan:f.plan,tree:f.commandTree,argumentTypes:f.argumentTypes},driver,()=>{}),e=>typeof e==='object' && e!==null && 'reason' in e && e.reason==='output_exists');
  assert.equal(calls,0); assert.equal(readFileSync(join(f.out,'mutated.json'),'utf8'),'original sentinel');
 }
});

test('closure baseline: a valid empty-plan baseline includes positional duplicate-id cases', t => {
 const tree=document(3); tree.root.children![0].children![0].data.id='same';tree.root.children![0].children![1].data.id='same';
 const b=fixtures(tree,[]), f=fixtures(tree,[]);t.after(()=>{rmSync(b.out,{recursive:true,force:true});rmSync(f.out,{recursive:true,force:true});});
 const driverFor=(out:string)=>fakeDrivers({drafts:[{calls:callLine('rn_baseline','accepted'),run:()=>runDetail({items:3,sources:[{reference:`src:${copyShaOf(out)}`} ]})}]});
 assert.equal(measureReview({...options(b.out),source:b.source,plan:b.plan},driverFor(b.out),()=>{}),0);
 assert.equal(measureReview({...options(f.out),source:f.source,plan:f.plan,baseline:b.out},driverFor(f.out),()=>{}),0);
});

test('closure startup session validation refuses reserved flags with exit two and a safe exact action', async () => {
 const {validateSessionStartup}=await import('./measure-review.ts');
 for(const side of ['--draft','--verify']) for(const flag of ['--prompt','--out','--name']) {
  const valid=JSON.stringify({args:[],prompt:'synthetic'}), bad=JSON.stringify({args:[flag+'=private-value'],prompt:'synthetic'});
  const checked=validateSessionStartup(side==='--draft'?bad:valid,side==='--verify'?bad:undefined);
  assert.equal(checked.code,2); if(checked.code===2) {
   assert.equal(checked.message,`${side} 的 args 里有 ${flag}：--prompt、--out、--name 由驱动设置，从会话 JSON 里删掉`);
   assert.ok(!checked.message.includes('private-value'));
  }
 }
});

test('Latin-1 measurement tree receipts hash the original bytes rather than re-encoded XML', t => {
 const f=catalogFixture(t);
 const bytes=Buffer.from('<?xml version="1.0" encoding="ISO-8859-1"?><commands><menu name="widget"><item name="port" help_string="café"><arguments><arg name="port" type="U16" limit="[1 - 20]"/></arguments></item></menu></commands>','latin1');
 writeFileSync(f.commandTree,bytes);
 assert.equal(measureReview({...options(f.out),source:f.source,plan:f.plan,tree:f.commandTree,argumentTypes:f.argumentTypes,submission:f.original},f.driver,()=>{}),0);
 const report=JSON.parse(readFileSync(join(f.out,'r1/catalog/catalog-marks.json'),'utf8'));
 assert.equal(report.inputs.tree_sha256,createHash('sha256').update(bytes).digest('hex'));
});

test('closure B1 untouched negative expected refutation has no attribution and is not a false positive', t => {
 const f = catalogFixture(t, {negative:true});
 assert.equal(measureReview({...options(f.out),source:f.source,plan:f.plan,tree:f.commandTree,argumentTypes:f.argumentTypes,submission:f.original},f.driver,()=>{}),0);
 const report=JSON.parse(readFileSync(join(f.out,'r1/catalog/catalog-marks.json'),'utf8'));
 assert.equal(report.negative_observed.length,1);assert.equal(report.extra.length,0);
});

test('closure B8 another checkout is refused before output or sessions exist',t=>{
 const f=catalogFixture(t);const checkout=join(f.out,'another-checkout');mkdirSync(join(checkout,'.git'),{recursive:true});
 const target=join(checkout,'new-output');assert.equal(outAllowed(target),false);
 let calls=0;const driver={...f.driver,review:()=>{calls++;throw new Error('must not start');}};
 assert.throws(()=>measureReview({...options(target),source:f.source,plan:f.plan,tree:f.commandTree,argumentTypes:f.argumentTypes},driver,()=>{}),e=>e instanceof Error && 'reason' in e && e.reason==='path_in_git');
 assert.equal(calls,0);assert.throws(()=>statSync(target));
});

test('closure B12 accepted submission reads and recovery retain the session Hub endpoint',async t=>{
 const {submissionReadArgs}=await import('./measure-review.ts');
 const f=catalogFixture(t,{provideSubmission:false});const url='http://127.0.0.1:19481/mcp',reference='rec:'+'b'.repeat(64);
 const show=f.driver.show;f.driver.show=(run)=>{const result=show(run),value=JSON.parse(result.json);value.submissions=[{record:reference,result:value.latest.record}];return {...result,json:JSON.stringify(value)};};
 let received:string|undefined;f.driver.readSubmission=(_ref,_dir,hubUrl)=>{received=hubUrl;return{code:1,json:''};};
 assert.equal(measureReview({...options(f.out),source:f.source,plan:f.plan,tree:f.commandTree,argumentTypes:f.argumentTypes,draft:{args:['--hub-url',url],prompt:'synthetic'}},f.driver,()=>{}),1);
 assert.equal(received,url);
 const argv=submissionReadArgs({reference},'synthetic.jsonl',url);assert.equal(argv[argv.indexOf('--url')+1],url);
 const requests=JSON.parse(readFileSync(join(f.out,'r1/catalog/evidence-requests.json'),'utf8'));const gap=requests.find((r:any)=>r.input==='submission');
 assert.ok(gap.next_action.includes('--url '+JSON.stringify(url)));assert.equal(gap.follow_up.args[gap.follow_up.args.indexOf('--hub-url')+1],url);
});

/** One immutable fake run-show snapshot; result records and submission originals deliberately have different digests. */
function draftRecordFixture(t: { after(fn: () => void): void }, over: { record?: unknown; acceptance?: string; prompt?: string; callsAccepted?: boolean; outputName?: string } = {}) {
  const sourceFiles = fixtures(document(1), []);
  t.after(() => rmSync(sourceFiles.out, { recursive: true, force: true }));
  const files = over.outputName === undefined ? sourceFiles : { ...sourceFiles, out: join(sourceFiles.out, over.outputName) };
  const verify: SessionSpec = { args: [], prompt: over.prompt ?? '复核 {copy}，初评运行 {draft_run}，验证结果 {draft_record}；再核对 {draft_record}' };
  const delivered = [{ item: 'synthetic:c1', requirements: [{ requirement: 'literal', layers: [{ layer: 'static', ...staticFixture('pass') }], claims: [] }] }];
  const shown = () => {
    const value = JSON.parse(runDetail({ run: 'rn_draft_record', items: 1, sources: [{ reference: `src:${copyShaOf(files.out)}` }], delivered, acceptance: over.acceptance }));
    value.latest.record = Object.hasOwn(over, 'record') ? over.record : 'd'.repeat(64);
    value.latest.result.submission = 'b'.repeat(64);
    value.submissions = [{ record: 'rec:' + 'b'.repeat(64), result: value.latest.record }];
    return JSON.stringify(value);
  };
  const drivers = fakeDrivers({ drafts: [{ calls: callLine('rn_draft_record', over.callsAccepted === false ? null : 'accepted'), run: shown }], verifies: [{
    calls: callLine('rn_verify_record', 'accepted'), run: () => runDetail({ run: 'rn_verify_record', pack: 'case-review-verify@1.0.0', predecessor: 'rn_draft_record', items: 1, delivered }),
  }] });
  const screen: string[] = [];
  return { ...files, verify, drivers, screen, run: () => measureReview({ ...options(files.out), source: files.source, plan: files.plan, verify }, drivers, line => screen.push(line)) };
}

for (const record of ['d'.repeat(64), 'rec:' + 'e'.repeat(64)]) test(`draft_record uses the accepted validation record ${record.startsWith('rec:') ? 'reference' : 'digest'} from the judged snapshot`, t => {
  const f = draftRecordFixture(t, { record });
  let shows = 0; const show = f.drivers.show; f.drivers.show = run => { shows++; return show(run); };
  assert.equal(f.run(), 0);
  const expected = record.startsWith('rec:') ? record : 'rec:' + record;
  assert.equal(f.drivers.prompts[1], `复核 ${join(f.out, 'mutated.json')}，初评运行 rn_draft_record，验证结果 ${expected}；再核对 ${expected}`);
  assert.equal(shows, 2, 'one snapshot per session, no second lookup when formatting the prompt');
  assert.ok(!f.drivers.prompts[1].includes('rec:' + 'b'.repeat(64)), 'never substitute the submission original record');
  assert.ok(!f.screen.join('\n').includes(expected.slice(4)), 'validation record digest stays off the fixed count lines');
});

for (const record of [undefined, 'rec:1', 'f'.repeat(63), 'rec:' + 'f'.repeat(64) + '#/partitions']) test(`draft_record refuses an unavailable or non-root result reference: ${String(record)}`, t => {
  const f = draftRecordFixture(t, { record });
  assert.equal(f.run(), 1);
  assert.equal(f.drivers.prompts.length, 1, 'no verification session may receive a guessed reference');
  assert.ok(f.verify.prompt.includes('{draft_record}'), 'invalid runs do not rewrite the session template');
  assert.ok(f.screen.some(line => line.includes('初评 case-review@1.0.0 无效（取不到运行）')));
  assert.ok(f.screen.some(line => line.includes('复核 未跑（初评无效）')));
});

for (const over of [{ acceptance: 'not_accepted' }, { callsAccepted: false }]) test(`an unaccepted draft never substitutes draft_record or starts verification: ${JSON.stringify(over)}`, t => {
  const f = draftRecordFixture(t, over);
  assert.equal(f.run(), 1);
  assert.equal(f.drivers.prompts.length, 1);
  assert.ok(f.verify.prompt.includes('{draft_record}'));
  assert.ok(f.screen.some(line => line.includes('无效（没有受理）')));
  assert.ok(!f.screen.join('\n').includes('d'.repeat(64)));
});

test('legacy verification templates still run when the snapshot has no usable validation record reference', t => {
  const f = draftRecordFixture(t, { record: undefined, prompt: '复核 {copy} 的初评 {draft_run}' });
  assert.equal(f.run(), 0);
  assert.equal(f.drivers.prompts[1], `复核 ${join(f.out, 'mutated.json')} 的初评 rn_draft_record`);
});


test('a legacy template does not interpret draft_record text inside the substituted copy path', t => {
  const f = draftRecordFixture(t, { record: undefined, prompt: '复核 {copy} 的初评 {draft_run}', outputName: 'literal-{draft_record}' });
  assert.equal(f.run(), 0);
  assert.equal(f.drivers.prompts[1], `复核 ${join(f.out, 'mutated.json')} 的初评 rn_draft_record`);
});

test('each of three fresh verification sessions gets its own round accepted result record', t => {
  const files = fixtures(document(1), []);
  t.after(() => rmSync(files.out, { recursive: true, force: true }));
  const delivered = [{ item: 'synthetic:c1', requirements: [{ requirement: 'literal', layers: [{ layer: 'static', ...staticFixture('pass') }], claims: [] }] }];
  const records = ['a', 'c', 'd'].map(char => char.repeat(64));
  const drivers = fakeDrivers({
    drafts: records.map((record, index) => ({ calls: callLine(`rn_draft_${index}`, 'accepted'), run: () => {
      const value = JSON.parse(runDetail({ run: `rn_draft_${index}`, items: 1, sources: [{ reference: `src:${copyShaOf(files.out)}` }], delivered }));
      value.latest.record = record;
      value.submissions = [{ record: 'rec:' + 'b'.repeat(64), result: record }];
      return JSON.stringify(value);
    } })),
    verifies: records.map((_record, index) => ({ calls: callLine(`rn_verify_${index}`, 'accepted'), run: () => runDetail({ run: `rn_verify_${index}`, pack: 'case-review-verify@1.0.0', predecessor: `rn_draft_${index}`, delivered }) })),
  });
  const screen: string[] = [];
  assert.equal(measureReview({ ...options(files.out), source: files.source, plan: files.plan, repeat: 3, verify: { args: [], prompt: '复核 {draft_record}' } }, drivers, line => screen.push(line)), 0);
  assert.deepEqual(drivers.prompts.filter((_prompt, index) => index % 2 === 1), records.map(record => '复核 rec:' + record));
  assert.ok(records.every(record => !screen.join('\n').includes(record)));
});
