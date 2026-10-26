// The build_candidates check (K01 R[10]): per item (document), the candidates are the context builds of the located version
// line, of every name family, an alias shown with its base; written build names are cross-checked against the knowledge
// base's builds (known, of another line — an advisory violation, or not known — an unknown, never a violation); no located
// line or a line without builds is an unknown, never a pass; the order of the context builds never changes the outcome.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { candidatesOutcomes } from './candidates.ts';
import type { CheckOutcome, ContextBuild, ItemFields, LocateSubject } from './types.ts';

const TREE = { root: 'FAMY', ancestors: ['030：FAMX/FAMY测试项目', '060：10.6.1', '004：10.6.1-R2-2026/7', 'SSL'] };

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
  build('Rel_FAMX_10_6_1_57', 'FAMX', '10.6.1', { built_at: '2026-09-01T00:00:00.000Z', released_at: '2026-09-02T00:00:00.000Z' }),
  build('Rel_FAMY_10_6_1_57', 'FAMY', '10.6.1', { base: 'Rel_FAMX_10_6_1_57', built_at: '2026-09-01T00:00:00.000Z', released_at: '2026-09-05T00:00:00.000Z' }),
  build('Rel_FAMX_10_6_1_60', 'FAMX', '10.6.1', { built_at: '2026-09-18T00:00:00.000Z', released_at: '2026-09-20T00:00:00.000Z' }),
  build('Rel_FAMX_10_6_1_63', 'FAMX', '10.6.1', { built_at: '2026-09-25T00:00:00.000Z', released_at: null }),
  build('Rel_FAMX_10_7_4_101', 'FAMX', '10.7.4', { built_at: '2026-05-01T00:00:00.000Z', released_at: '2026-05-02T00:00:00.000Z' }),
];

function subjectOf(items: Array<{ id: string; location: string; fields: ItemFields }>, builds: ContextBuild[] = BUILDS): LocateSubject {
  return { items, context: { product: 'famx', names: ['FAMX', 'FAMY'], parameters: {}, builds } };
}

const byVerdict = (outcomes: CheckOutcome[], verdict: string): CheckOutcome[] => outcomes.filter((o) => o.verdict === verdict);

describe('candidatesOutcomes', () => {
  it('the located line gives its builds of both name families, an alias with its base, by built time descending', () => {
    const outcomes = candidatesOutcomes(subjectOf([item('24001', '需求20931 证书链校验')]));
    const [candidates] = outcomes;
    assert.deepEqual([candidates.verdict, candidates.tier, candidates.item], ['support', 'advisory', '24001']);
    const data = candidates.data as { line: string; candidates: Array<{ name: string; family: string; base: string; alias: boolean; platform: string | null; released: boolean }> };
    assert.equal(data.line, '10.6.1');
    assert.deepEqual(
      data.candidates.map((c) => [c.name, c.family, c.base, c.alias, c.released]),
      [
        ['Rel_FAMX_10_6_1_63', 'FAMX', 'Rel_FAMX_10_6_1_63', false, false],
        ['Rel_FAMX_10_6_1_60', 'FAMX', 'Rel_FAMX_10_6_1_60', false, true],
        ['Rel_FAMX_10_6_1_57', 'FAMX', 'Rel_FAMX_10_6_1_57', false, true],
        ['Rel_FAMY_10_6_1_57', 'FAMY', 'Rel_FAMX_10_6_1_57', true, true],
      ],
    );
    assert.match(candidates.statement, /版本线 10\.6\.1/);
    assert.match(candidates.statement, /按制作时间从新到旧/);
    assert.match(candidates.statement, /别名/);
    assert.deepEqual(candidates.grounds, [`src:${'24001'.padStart(64, '0')}/kityminder@1/n/24001`]);
  });

  it('the statement writes the build time of every candidate and its based-on base, and the release state apart', () => {
    const outcomes = candidatesOutcomes(subjectOf([item('24014', '需求20931 证书链校验')]));
    const [candidates] = outcomes;
    // Built time from the page's “build on”, alias with 基于, release state written apart, ordered by built time.
    assert.match(candidates.statement, /按制作时间从新到旧/);
    assert.match(candidates.statement, /Rel_FAMX_10_6_1_60（FAMX）制作于 2026-09-18 00:00，已发布 2026-09-20/);
    assert.match(candidates.statement, /Rel_FAMY_10_6_1_57（FAMY，基于 Rel_FAMX_10_6_1_57）制作于 2026-09-01 00:00，已发布 2026-09-05/);
    assert.match(candidates.statement, /Rel_FAMX_10_6_1_63（FAMX）制作于 2026-09-25 00:00，未发布/);
    assert.ok(!candidates.statement.includes('按发布从新到旧'), 'the order is by built time now');
    assert.ok(!candidates.statement.includes('依据'), 'the alias wording is 基于 now');
    const data = candidates.data as { candidates: Array<{ name: string; built_at: string | null; base: string }> };
    const withTimes = new Map(data.candidates.map((c) => [c.name, [c.built_at, c.base]] as const));
    assert.deepEqual(withTimes.get('Rel_FAMX_10_6_1_60'), ['2026-09-18T00:00:00.000Z', 'Rel_FAMX_10_6_1_60']);
    assert.deepEqual(withTimes.get('Rel_FAMY_10_6_1_57'), ['2026-09-01T00:00:00.000Z', 'Rel_FAMX_10_6_1_57']);
  });

  it('orders by built time descending, name as the tie-break; a build without a built time is last and says so', () => {
    const builds: ContextBuild[] = [
      build('Rel_FAMX_10_6_1_50', 'FAMX', '10.6.1', { built_at: '2026-08-01T00:00:00.000Z', released_at: '2026-08-02T00:00:00.000Z' }),
      build('Rel_FAMX_10_6_1_57', 'FAMX', '10.6.1', { built_at: '2026-09-01T00:00:00.000Z', released_at: null }),
      build('Rel_FAMX_10_6_1_58', 'FAMX', '10.6.1', { built_at: '2026-09-01T00:00:00.000Z', released_at: null }),
      build('Rel_FAMX_10_6_1_no-time', 'FAMX', '10.6.1', { built_at: null, released_at: '2026-07-01T00:00:00.000Z' }),
    ];
    const outcomes = candidatesOutcomes(subjectOf([item('24015', '需求20931 证书链校验')], builds));
    const [candidates] = outcomes;
    const names = (candidates.data as { candidates: Array<{ name: string }> }).candidates.map((c) => c.name);
    assert.deepEqual(names, ['Rel_FAMX_10_6_1_57', 'Rel_FAMX_10_6_1_58', 'Rel_FAMX_10_6_1_50', 'Rel_FAMX_10_6_1_no-time']);
    assert.match(candidates.statement, /Rel_FAMX_10_6_1_no-time（FAMX）制作时间未知，已发布 2026-07-01/);
  });

  it('a written name equal to a candidate or to the base of an alias is known (support)', () => {
    const outcomes = candidatesOutcomes(subjectOf([item('24002', 'Rel_FAMY_10_6_1_57 回归 证书'), item('24003', 'Rel_FAMX_10_6_1_60 升级')]));
    const supports = byVerdict(outcomes, 'support').filter((o) => (o.data as { kind?: string }).kind === 'written_build');
    assert.equal(supports.length, 2);
    assert.match(supports[0].statement, /Rel_FAMY_10_6_1_57/);
    assert.match(supports[1].statement, /Rel_FAMX_10_6_1_60/);
  });

  it('a written name of another line is an advisory violation naming that line', () => {
    const outcomes = candidatesOutcomes(subjectOf([item('24004', 'Rel_FAMX_10_7_4_101 回归')]));
    const violation = byVerdict(outcomes, 'refute')[0];
    assert.deepEqual([violation.code, violation.tier, violation.item], ['case-location.build_other_line', 'advisory', '24004']);
    assert.match(violation.statement, /10\.7\.4/);
    const data = violation.data as { name: string; line: string };
    assert.deepEqual([data.name, data.line], ['Rel_FAMX_10_7_4_101', '10.7.4']);
  });

  it('a written name the build site does not list is a deterministic advisory refutation, never an unknown', () => {
    const outcomes = candidatesOutcomes(subjectOf([item('24005', 'Rel_FAMX_10_9_9_9 回归')]));
    const refute = outcomes.find((o) => o.code === 'case-location.build_not_listed');
    assert.ok(refute, JSON.stringify(outcomes));
    assert.equal(refute.item, '24005');
    assert.equal(refute.tier, 'advisory');
    assert.match(refute.statement, /Rel_FAMX_10_9_9_9/);
    assert.match(refute.statement, /构建站没有列出/);
    assert.equal(refute.missing, undefined);
  });

  it('no located line, or a line without any known build, is an unknown with the reason — never a pass', () => {
    // No version level in the folders: the located line is null.
    const noLine = candidatesOutcomes(subjectOf([item('24006', '基本功能', ['通用用例', '基础功能'], 'FAMX')]));
    assert.equal(byVerdict(noLine, 'support').length, 0, 'never a pass');
    const [unknownLine] = byVerdict(noLine, 'unknown');
    assert.equal(unknownLine.reason, 'missing_input');
    assert.match(unknownLine.statement, /版本线/);
    // A located line the knowledge base has no builds of.
    const noBuilds = candidatesOutcomes(subjectOf([item('24007', 'x', ['030：FAMX/FAMY测试项目', '060：10.6.0', '004：10.6.0-R1-2026/1', 'SSL'])]));
    const [empty] = byVerdict(noBuilds, 'unknown');
    assert.match(empty.statement, /10\.6\.0/);
    assert.match(empty.statement, /没有已知构建|没有.*构建/);
  });

  it('the outcome does not depend on the order of the context builds', () => {
    const one = candidatesOutcomes(subjectOf([item('24008', 'Rel_FAMX_10_7_4_101 回归')]));
    const two = candidatesOutcomes(subjectOf([item('24008', 'Rel_FAMX_10_7_4_101 回归')], [...BUILDS].reverse()));
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
    for (let i = 0; i < 2000; i++) many.push(build(`Rel_FAMX_10_6_${1 + (i % 40)}_${i}`, 'FAMX', `10.6.${1 + (i % 40)}`, { released_at: i % 3 === 0 ? `2026-09-${String(1 + (i % 28)).padStart(2, '0')}T00:00:00.000Z` : null }));
    many.push(build('Rel_FAMY_10_6_1_57', 'FAMY', '10.6.1', { base: 'Rel_FAMX_10_6_1_57', released_at: '2026-09-05T00:00:00.000Z' }));
    const started = performance.now();
    const outcomes = candidatesOutcomes(subjectOf([item('24010', 'Rel_FAMY_10_6_1_57 回归')], many));
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 2000, `${elapsed.toFixed(0)} ms`);
    const [candidates] = outcomes;
    assert.equal(candidates.verdict, 'support');
    assert.equal((candidates.data as { candidates: unknown[] }).candidates.length, 51);
  });

  it('the statement names every candidate: build and family, the built time, an alias with the build it is based on, the release state apart', () => {
    const outcomes = candidatesOutcomes(subjectOf([item('24011', '需求20931 证书链校验')]));
    const [candidates] = outcomes;
    assert.match(candidates.statement, /Rel_FAMX_10_6_1_60（FAMX）制作于 2026-09-18 00:00，已发布 2026-09-20/);
    assert.match(candidates.statement, /Rel_FAMY_10_6_1_57（FAMY，基于 Rel_FAMX_10_6_1_57）制作于 2026-09-01 00:00，已发布 2026-09-05/);
    assert.match(candidates.statement, /Rel_FAMX_10_6_1_57（FAMX）制作于 2026-09-01 00:00，已发布 2026-09-02/);
    assert.match(candidates.statement, /Rel_FAMX_10_6_1_63（FAMX）制作于 2026-09-25 00:00，未发布/);
    assert.match(candidates.statement, /按制作时间从新到旧/);
  });

  it('the statement writes at most the first 12 candidates and counts the rest', () => {
    const many: ContextBuild[] = [];
    for (let i = 0; i < 20; i++) many.push(build(`Rel_FAMX_10_6_1_${String(i).padStart(2, '0')}`, 'FAMX', '10.6.1', { built_at: `2026-08-${String(1 + i).padStart(2, '0')}T00:00:00.000Z`, released_at: `2026-09-${String(1 + i).padStart(2, '0')}T00:00:00.000Z` }));
    const outcomes = candidatesOutcomes(subjectOf([item('24012', 'x')], many));
    const [candidates] = outcomes;
    assert.equal((candidates.data as { candidates: unknown[] }).candidates.length, 20);
    assert.match(candidates.statement, /构建候选 20 个/);
    assert.match(candidates.statement, /Rel_FAMX_10_6_1_08（FAMX）制作于 2026-08-09 00:00，已发布 2026-09-09/, 'the 12th candidate (newest built first) is written out');
    assert.ok(!candidates.statement.includes('Rel_FAMX_10_6_1_07（'), 'the 13th candidate is not written out');
    assert.match(candidates.statement, /另有 8 个/);
  });

  it('every classification of a written build name carries the name in its statement', () => {
    // Rel_FAMX_10_6_1_58 is not a build of the line; only the alias Rel_FAMY_10_6_1_58 is based on it.
    const withBaseOnly = [...BUILDS, build('Rel_FAMY_10_6_1_58', 'FAMY', '10.6.1', { base: 'Rel_FAMX_10_6_1_58', released_at: '2026-09-06T00:00:00.000Z' })];
    // One name per label, at its start: the declared scope of the build-name grammar is the label, not prose inside it.
    const outcomes = candidatesOutcomes(subjectOf([item('24013', 'Rel_FAMX_10_6_1_58 回归'), item('24019', 'Rel_FAMX_10_7_4_101 回归'), item('24020', 'Rel_FAMX_10_9_9_9 回归')], withBaseOnly));
    const written = outcomes.filter((o) => (o.data as { kind?: string } | undefined)?.kind === 'written_build');
    assert.equal(written.length, 3);
    for (const outcome of written) assert.match(outcome.statement, /Rel_FAMX_10_(6_1_58|7_4_101|9_9_9)/);
    assert.match(written[0].statement, /写出的构建名 Rel_FAMX_10_6_1_58 是候选 Rel_FAMY_10_6_1_58 所依据的构建/);
  });
});

it('conflicting version levels list both lines separately with the conflict first', () => {
  const outcomes = candidatesOutcomes(subjectOf([item('synthetic', '合成文档', ['060：10.6.1', '061：10.7.4'])]));
  const candidates = outcomes.filter(outcome => outcome.data?.kind === 'candidates');
  assert.deepEqual(candidates.map(outcome => outcome.data?.line), ['10.6.1', '10.7.4']);
  for (const outcome of candidates) {
    assert.match(outcome.statement, /^目录.*自相矛盾/);
    assert.ok((outcome.data?.candidates as unknown[]).length > 0);
  }
});

it('a written build of either conflicting line is not falsely called another line', () => {
  const document = item('synthetic-conflict', 'Rel_FAMX_10_7_4_101', ['060：10.6.1', '061：10.7.4']);
  const outcomes = candidatesOutcomes(subjectOf([document]));
  assert.ok(!outcomes.some(outcome => outcome.code === 'case-location.build_other_line'));
  for (const outcome of outcomes.filter(outcome => outcome.data?.kind === 'written_build')) {
    assert.match(outcome.statement, /^目录.*自相矛盾/);
    assert.equal(outcome.statement.includes('定位没有给出版本线'), false);
    assert.match(outcome.statement, /10\.7\.4/);
  }
});

it('a written build of a third line is that other line when the version level conflicts', () => {
  const builds = [...BUILDS, build('Rel_FAMX_10_8_1_9', 'FAMX', '10.8.1', { built_at: '2026-08-01T00:00:00.000Z', released_at: '2026-08-02T00:00:00.000Z' })];
  const outcomes = candidatesOutcomes(subjectOf([item('synthetic-third', 'Rel_FAMX_10_8_1_9 合成文档', ['060：10.6.1', '061：10.7.4'])], builds));
  const written = outcomes.find(outcome => outcome.data?.kind === 'written_build');
  assert.equal(written?.verdict, 'refute');
  assert.equal(written?.code, 'case-location.build_other_line');
  assert.match(written?.statement ?? '', /10\.8\.1/);
  assert.match(written?.statement ?? '', /10\.6\.1/);
  assert.match(written?.statement ?? '', /10\.7\.4/);
  assert.equal((written?.statement ?? '').includes('定位没有给出版本线'), false);
});

it('conflicting lines that keep a trailing zero still list each line\'s builds', () => {
  const builds = ['10.7.0', '10.8.0', '10.9.0'].map((line, index) => build(`Rel_FAMX_${line.replaceAll('.', '_')}_${index + 1}`, 'FAMX', line, { built_at: `2026-0${index + 1}-01T00:00:00.000Z` }));
  const outcomes = candidatesOutcomes(subjectOf([item('synthetic-zero', builds[2].name, ['060：10.7.0', '061：10.8.0'])], builds));
  const candidates = outcomes.filter((outcome) => outcome.data?.kind === 'candidates');
  assert.deepEqual(candidates.map((outcome) => outcome.data?.line), ['10.7.0', '10.8.0']);
  for (const outcome of candidates) {
    assert.equal(outcome.verdict, 'support');
    assert.ok((outcome.data?.candidates as unknown[]).length > 0);
    assert.equal(outcome.statement.includes('没有已知构建'), false);
    assert.match(outcome.statement, /^目录.*自相矛盾/);
  }
  const written = outcomes.find((outcome) => outcome.data?.kind === 'written_build');
  assert.equal(written?.verdict, 'refute');
  assert.equal(written?.code, 'case-location.build_other_line');
});

it('a version-only label uses that version as the candidate line', () => {
  const builds = [build('Rel_FAMY_10_9_1_37', 'FAMY', '10.9.1', { built_at: '2026-09-01T00:00:00.000Z', released_at: '2026-09-02T00:00:00.000Z' })];
  const outcomes = candidatesOutcomes(subjectOf([item('synthetic-label', '合成文档', ['10.9.1'])], builds));
  const candidates = outcomes.find(outcome => outcome.data?.kind === 'candidates');
  assert.equal(candidates?.verdict, 'support');
  assert.equal(candidates?.data?.line, '10.9.1');
  assert.equal((candidates?.statement ?? '').includes('没有版本层'), false);
});

describe('a written build name the build site does not list', () => {
  it('is a deterministic advisory refutation, never an unknown', () => {
    const subject = subjectOf([item('2499', 'Rel_FAMX_10_9_9_2 回归')]);
    const outcomes = candidatesOutcomes(subject);
    const outcome = outcomes.find((o) => o.code === 'case-location.build_not_listed');
    assert.ok(outcome, JSON.stringify(outcomes));
    assert.equal(outcome.verdict, 'refute');
    assert.equal(outcome.tier, 'advisory');
    assert.match(outcome.statement, /构建站没有列出写出的构建名 Rel_FAMX_10_9_9_2/);
    assert.match(outcome.statement, /不认识不等于写错/);
    assert.equal(outcome.missing, undefined);
  });
});
