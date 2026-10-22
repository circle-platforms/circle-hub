// The build_candidates check (K01 R[10]): per item (document), the candidates are the context builds of the located version
// line, of every name family, an alias shown with its base; written build names are cross-checked against the knowledge
// base's builds (known, of another line — an advisory violation, or not known — an unknown, never a violation); no located
// line or a line without builds is an unknown, never a pass; the order of the context builds never changes the outcome.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { candidatesOutcomes } from './candidates.ts';
import type { CheckOutcome, ContextBuild, ItemFields, LocateSubject } from './types.ts';

const TREE = { root: 'NSAE', ancestors: ['030：APV/NSAE测试项目', '060：10.6.1', '004：10.6.1-R2-2026/7', 'SSL'] };

function item(id: string, title: string, ancestors: string[] = TREE.ancestors, root: string | null = TREE.root): { id: string; location: string; fields: ItemFields } {
  return {
    id,
    location: `src:${id.padStart(64, '0')}/kityminder@1/n/${id}`,
    fields: { kind: 'document', document: id, node: null, source: `agile:mindmap:${id}@1`, root, ancestors, title, path: [], case_title: null },
  };
}

function build(name: string, family: string, line: string, extra: Partial<ContextBuild> = {}): ContextBuild {
  return { name, family, line, base: name, platform: null, built_at: null, released_at: null, has_root: true, ...extra };
}

// The context builds of the bound line and around it: two name families, an alias carrying its base, an unreleased build,
// and a build of another line.
const BUILDS: ContextBuild[] = [
  build('Rel_APV_10_6_1_57', 'APV', '10.6.1', { built_at: '2026-09-01T00:00:00.000Z', released_at: '2026-09-02T00:00:00.000Z' }),
  build('Rel_NSAE_10_6_1_57', 'NSAE', '10.6.1', { base: 'Rel_APV_10_6_1_57', built_at: '2026-09-01T00:00:00.000Z', released_at: '2026-09-05T00:00:00.000Z' }),
  build('Rel_APV_10_6_1_60', 'APV', '10.6.1', { built_at: '2026-09-18T00:00:00.000Z', released_at: '2026-09-20T00:00:00.000Z' }),
  build('Rel_APV_10_6_1_63', 'APV', '10.6.1', { built_at: '2026-09-25T00:00:00.000Z', released_at: null }),
  build('Rel_APV_10_5_1_101', 'APV', '10.5.1', { built_at: '2026-05-01T00:00:00.000Z', released_at: '2026-05-02T00:00:00.000Z' }),
];

function subjectOf(items: Array<{ id: string; location: string; fields: ItemFields }>, builds: ContextBuild[] = BUILDS): LocateSubject {
  return { items, context: { product: 'apv', names: ['APV', 'NSAE'], parameters: {}, builds } };
}

const byVerdict = (outcomes: CheckOutcome[], verdict: string): CheckOutcome[] => outcomes.filter((o) => o.verdict === verdict);

describe('candidatesOutcomes', () => {
  it('the located line gives its builds of both name families, an alias with its base, released first by date descending', () => {
    const outcomes = candidatesOutcomes(subjectOf([item('24001', '需求20931 证书链校验')]));
    const [candidates] = outcomes;
    assert.deepEqual([candidates.verdict, candidates.tier, candidates.item], ['support', 'advisory', '24001']);
    const data = candidates.data as { line: string; candidates: Array<{ name: string; family: string; base: string; alias: boolean; platform: string | null; released: boolean }> };
    assert.equal(data.line, '10.6.1');
    assert.deepEqual(
      data.candidates.map((c) => [c.name, c.family, c.base, c.alias, c.released]),
      [
        ['Rel_APV_10_6_1_60', 'APV', 'Rel_APV_10_6_1_60', false, true],
        ['Rel_NSAE_10_6_1_57', 'NSAE', 'Rel_APV_10_6_1_57', true, true],
        ['Rel_APV_10_6_1_57', 'APV', 'Rel_APV_10_6_1_57', false, true],
        ['Rel_APV_10_6_1_63', 'APV', 'Rel_APV_10_6_1_63', false, false],
      ],
    );
    assert.match(candidates.statement, /版本线 10\.6\.1/);
    assert.match(candidates.statement, /别名/);
    assert.deepEqual(candidates.grounds, [`src:${'24001'.padStart(64, '0')}/kityminder@1/n/24001`]);
  });

  it('a written name equal to a candidate or to the base of an alias is known (support)', () => {
    const outcomes = candidatesOutcomes(subjectOf([item('24002', '回归 Rel_NSAE_10_6_1_57 证书'), item('24003', 'Rel_APV_10_6_1_60 升级')]));
    const supports = byVerdict(outcomes, 'support').filter((o) => (o.data as { kind?: string }).kind === 'written_build');
    assert.equal(supports.length, 2);
    assert.match(supports[0].statement, /Rel_NSAE_10_6_1_57/);
    assert.match(supports[1].statement, /Rel_APV_10_6_1_60/);
  });

  it('a written name of another line is an advisory violation naming that line', () => {
    const outcomes = candidatesOutcomes(subjectOf([item('24004', '回归 Rel_APV_10_5_1_101')]));
    const violation = byVerdict(outcomes, 'refute')[0];
    assert.deepEqual([violation.code, violation.tier, violation.item], ['case-location.build_other_line', 'advisory', '24004']);
    assert.match(violation.statement, /10\.5\.1/);
    const data = violation.data as { name: string; line: string };
    assert.deepEqual([data.name, data.line], ['Rel_APV_10_5_1_101', '10.5.1']);
  });

  it('a written name the knowledge base does not know is an unknown with the reason, never a violation', () => {
    const outcomes = candidatesOutcomes(subjectOf([item('24005', '回归 Rel_APV_10_9_9_9')]));
    const unknown = byVerdict(outcomes, 'unknown')[0];
    assert.deepEqual([unknown.reason, unknown.item], ['missing_input', '24005']);
    assert.match(unknown.statement, /Rel_APV_10_9_9_9/);
    assert.match(unknown.statement, /知识库/);
    assert.equal(byVerdict(outcomes, 'refute').length, 0);
  });

  it('no located line, or a line without any known build, is an unknown with the reason — never a pass', () => {
    // No version level in the folders: the located line is null.
    const noLine = candidatesOutcomes(subjectOf([item('24006', '基本功能', ['通用用例', '基础功能'], 'APV')]));
    assert.equal(byVerdict(noLine, 'support').length, 0, 'never a pass');
    const [unknownLine] = byVerdict(noLine, 'unknown');
    assert.equal(unknownLine.reason, 'missing_input');
    assert.match(unknownLine.statement, /版本线/);
    // A located line the knowledge base has no builds of.
    const noBuilds = candidatesOutcomes(subjectOf([item('24007', 'x', ['030：APV/NSAE测试项目', '060：10.6.0', '004：10.6.0-R1-2026/1', 'SSL'])]));
    const [empty] = byVerdict(noBuilds, 'unknown');
    assert.match(empty.statement, /10\.6\.0/);
    assert.match(empty.statement, /没有已知构建|没有.*构建/);
  });

  it('the outcome does not depend on the order of the context builds', () => {
    const one = candidatesOutcomes(subjectOf([item('24008', '回归 Rel_APV_10_5_1_101 和 Rel_NSAE_10_6_1_57')]));
    const two = candidatesOutcomes(subjectOf([item('24008', '回归 Rel_APV_10_5_1_101 和 Rel_NSAE_10_6_1_57')], [...BUILDS].reverse()));
    assert.deepEqual(two, one);
  });

  it('an item with malformed fields is unknown, never silently passed, and an empty subject gives one unknown (check error)', () => {
    const broken = item('24009', 'x');
    (broken.fields as unknown as Record<string, unknown>).ancestors = 7;
    const outcomes = candidatesOutcomes(subjectOf([broken]));
    assert.equal(outcomes[0].verdict, 'unknown');
    assert.equal(outcomes[0].item, '24009');
    const none = candidatesOutcomes(subjectOf([]));
    assert.equal(none.length, 1);
    assert.deepEqual([none[0].verdict, none[0].reason], ['unknown', 'check_error']);
  });

  it('2,000 builds of the context are classified without noticeable cost', () => {
    const many: ContextBuild[] = [];
    for (let i = 0; i < 2000; i++) many.push(build(`Rel_APV_10_6_${1 + (i % 40)}_${i}`, 'APV', `10.6.${1 + (i % 40)}`, { released_at: i % 3 === 0 ? `2026-09-${String(1 + (i % 28)).padStart(2, '0')}T00:00:00.000Z` : null }));
    many.push(build('Rel_NSAE_10_6_1_57', 'NSAE', '10.6.1', { base: 'Rel_APV_10_6_1_57', released_at: '2026-09-05T00:00:00.000Z' }));
    const started = performance.now();
    const outcomes = candidatesOutcomes(subjectOf([item('24010', '回归 Rel_NSAE_10_6_1_57')], many));
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 2000, `${elapsed.toFixed(0)} ms`);
    const [candidates] = outcomes;
    assert.equal(candidates.verdict, 'support');
    assert.equal((candidates.data as { candidates: unknown[] }).candidates.length, 51);
  });

  it('the statement names every candidate: build, family, released with its date, an alias with the build it is based on', () => {
    const outcomes = candidatesOutcomes(subjectOf([item('24011', '需求20931 证书链校验')]));
    const [candidates] = outcomes;
    assert.match(candidates.statement, /Rel_APV_10_6_1_60（APV，2026-09-20 已发布）/);
    assert.match(candidates.statement, /Rel_NSAE_10_6_1_57（NSAE，依据 Rel_APV_10_6_1_57，2026-09-05 已发布）/);
    assert.match(candidates.statement, /Rel_APV_10_6_1_57（APV，2026-09-02 已发布）/);
    assert.match(candidates.statement, /Rel_APV_10_6_1_63（APV，未发布）/);
    assert.match(candidates.statement, /按发布从新到旧/);
  });

  it('the statement writes at most the first 12 candidates and counts the rest', () => {
    const many: ContextBuild[] = [];
    for (let i = 0; i < 20; i++) many.push(build(`Rel_APV_10_6_1_${String(i).padStart(2, '0')}`, 'APV', '10.6.1', { released_at: `2026-09-${String(1 + i).padStart(2, '0')}T00:00:00.000Z` }));
    const outcomes = candidatesOutcomes(subjectOf([item('24012', 'x')], many));
    const [candidates] = outcomes;
    assert.equal((candidates.data as { candidates: unknown[] }).candidates.length, 20);
    assert.match(candidates.statement, /构建候选 20 个/);
    assert.match(candidates.statement, /Rel_APV_10_6_1_08（APV，2026-09-09 已发布）/, 'the 12th candidate (newest first) is written out');
    assert.ok(!candidates.statement.includes('Rel_APV_10_6_1_07（'), 'the 13th candidate is not written out');
    assert.match(candidates.statement, /另有 8 个/);
  });

  it('every classification of a written build name carries the name in its statement', () => {
    // Rel_APV_10_6_1_58 is not a build of the line; only the alias Rel_NSAE_10_6_1_58 is based on it.
    const withBaseOnly = [...BUILDS, build('Rel_NSAE_10_6_1_58', 'NSAE', '10.6.1', { base: 'Rel_APV_10_6_1_58', released_at: '2026-09-06T00:00:00.000Z' })];
    const outcomes = candidatesOutcomes(subjectOf([item('24013', '回归 Rel_APV_10_6_1_58、Rel_APV_10_5_1_101 与 Rel_APV_10_9_9_9')], withBaseOnly));
    const written = outcomes.filter((o) => (o.data as { kind?: string } | undefined)?.kind === 'written_build');
    assert.equal(written.length, 3);
    for (const outcome of written) assert.match(outcome.statement, /Rel_APV_10_(6_1_58|5_1_101|9_9_9)/);
    assert.match(written[0].statement, /写出的构建名 Rel_APV_10_6_1_58 是候选 Rel_NSAE_10_6_1_58 所依据的构建/);
  });
});
