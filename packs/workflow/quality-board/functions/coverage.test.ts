import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalTag, TAG_SPELLINGS } from './tags.ts';
import { canonicalTag as templateTag } from '../../template-gap/functions/tags.ts';
import { projectItems } from './project.ts';
import { boardOutcomes } from './board.ts';
import { totalsOutcome } from './totals.ts';
import { buildSubject } from './subject.ts';
import { boundView, facetViewOf, facetRow, ROOT } from './test-support.ts';

const counts = facetViewOf([facetRow({ line: '10.7', module: '合成模块', has_expected: false, vague_expected: false, negative: false }, 3)]);
const tags = (rows: Array<{ tags: string | null; count: number }>, extra = {}) => facetViewOf(rows.map((r) => facetRow({ line: '10.7', module: '合成模块', tags: r.tags }, r.count)), { by: ['line', 'module', 'tags'], total: 3, ...extra });
const placement = facetViewOf([facetRow({ commands: null }, 2), facetRow({ commands: '/synthetic' }, 1)], { by: ['commands'], total: 3 });
const project = (tagView?: Record<string, unknown>, place = placement, more: unknown[] = []) => projectItems({ inputs: [boundView('facets', counts), ...(tagView ? [boundView('facets', tagView)] : []), boundView('placement', place), ...more], parameters: {} });
function items(out: ReturnType<typeof project>) { assert.ok(!('error' in out), JSON.stringify(out)); return out; }
const subject = (out: ReturnType<typeof items>) => buildSubject({ items: out.items.map((i) => ({ ...i, location: 'src:' + i.location.source })), context: { groups: out.groups } });

test('tag normalization stays equal to the template across thousands of spellings', () => {
  let compared = 0;
  for (const aliases of Object.values(TAG_SPELLINGS)) for (const alias of aliases) for (const left of ['', '[', '【', ' "', '（', '#']) for (const right of ['', ']', '】', ')', '测试', ' tests', ' case', '！？', 'testing', '测试用例', ' cases', '，' ]) {
    const raw = left + alias.toUpperCase() + right;
    assert.equal(canonicalTag(raw), templateTag(raw), raw); compared++;
  }
  assert.ok(compared > 2000);
});
test('all six types, duplicate spellings, unknown tags and exact untagged counts', () => {
  const out = items(project(tags([{ tags: 'Functional', count: 1 }, { tags: 'function', count: 1 }, { tags: 'Configuration', count: 1 }, { tags: 'Integration', count: 1 }, { tags: 'Compatibility', count: 1 }, { tags: 'Negative', count: 1 }, { tags: 'Stress', count: 1 }, { tags: 'release-label', count: 1 }, { tags: null, count: 1 }])));
  const coverage = out.items[0].fields.coverage as { present: string[]; missing: string[]; untagged: number; partial: boolean };
  assert.equal(coverage.present.length, 6); assert.deepEqual(coverage.missing, []); assert.equal(coverage.untagged, 1);
  assert.match(out.items[0].summary!, /未打标签 1 个/);
  assert.match(boardOutcomes(subject(out))[0].statement, /未打标签 1 个/);
  assert.match(totalsOutcome(subject(out)).statement, /2 个用例没有解析出命令/);
});
test('only untagged cases and unknown tags show no recognized types', () => {
  for (const tag of [null, 'release-label']) {
    const out = items(project(tags([{ tags: tag, count: 3 }])));
    const c = out.items[0].fields.coverage as { missing: string[]; untagged: number };
    assert.equal(c.missing.length, 6); assert.equal(c.untagged, tag === null ? 3 : 0);
  }
});
test('partial tags disclose absence in read sources and do not invent an untagged zero', () => {
  const out = items(project(tags([{ tags: 'Functional', count: 1 }], { truncated: true, skipped: 2 })));
  assert.match(out.items[0].summary!, /部分/);
  const c = out.items[0].fields.coverage as { untagged: number | null };
  assert.equal(c.untagged, null);
  assert.match(boardOutcomes(subject(out))[0].statement, /在已读的来源里没看到/);
});
test('wrong roots, duplicate count views and missing placement are refusals with fixes', () => {
  for (const out of [project(tags([], { root: 'b'.repeat(64) })), project(counts), projectItems({ inputs: [boundView('facets', counts)] }), project(undefined, { ...placement, build: { build: 'alias', root: 'b'.repeat(64) } })]) {
    assert.ok('error' in out); assert.ok(out.error.fix.length > 0);
  }
  assert.equal(ROOT.length, 64);
});
test('truncated placement without the null row refuses rather than finishing unknown', () => {
  const out = project(undefined, facetViewOf([facetRow({ commands: '/synthetic' }, 1)], { by: ['commands'], total: 3, truncated: true }));
  assert.ok('error' in out); assert.match(out.error.message, /未归位数/); assert.match(out.error.fix, /能力缺口/);
});
test('without tags the board metrics and summary stay unchanged', () => {
  const out = items(project());
  assert.equal(out.items[0].summary, '用例 3 个；无期望结果 3 个（100.0%）；含糊期望 0 个（0.0%）；负面用例 0 个（0.0%）');
  assert.equal(out.items[0].fields.coverage, undefined);
});

test('coverage matches independent per-case calculation on 100000 random cases and is order independent', async () => {
  const { testType, TYPE_LABELS } = await import('../../../../scripts/real/gold/board.ts');
  const { randomOf } = await import('./test-support.ts');
  const random = randomOf(47001);
  const aliases = [[], ['Functional'], ['function', '[Functional]'], ['Configuration', 'Stress'], ['Negative'], ['Integration', 'Compatibility'], ['release-tag']];
  const expected = new Map<string, { present: Set<string>; untagged: number }>();
  const metricRows: ReturnType<typeof facetRow>[] = [];
  const tagRows = new Map<string, ReturnType<typeof facetRow>>();
  for (let i = 0; i < 100000; i++) {
    const line = random() < 0.5 ? '10.7' : '10.8';
    const module = `module-${Math.floor(random() * 4)}`;
    const tags = aliases[Math.floor(random() * aliases.length)];
    const id = `${line}/${module}`;
    const e = expected.get(id) ?? { present: new Set<string>(), untagged: 0 };
    if (tags.length === 0) e.untagged++;
    for (const tag of tags) { const value = testType(tag); if (value) e.present.add(value); }
    expected.set(id, e);
    metricRows.push(facetRow({ line, module, has_expected: false, vague_expected: false, negative: false }, 1));
    for (const tag of tags.length ? tags : [null]) {
      const key = JSON.stringify([line, module, tag]);
      const row = tagRows.get(key) ?? facetRow({ line, module, tags: tag }, 0);
      row.count++; tagRows.set(key, row);
    }
  }
  const metric = boundView('facets', facetViewOf(metricRows));
  const tagged = boundView('facets', facetViewOf([...tagRows.values()], { by: ['line', 'module', 'tags'], total: 100000 }));
  const place = boundView('placement', facetViewOf([facetRow({ commands: null }, 100000)], { by: ['commands'] }));
  const run = (inputs: unknown[]) => items(projectItems({ inputs }));
  const out = run([metric, tagged, place]);
  for (const item of out.items) {
    const e = expected.get(item.id)!;
    const c = item.fields.coverage as { present: string[]; missing: string[]; untagged: number };
    assert.deepEqual(c.present, Object.values(TYPE_LABELS).filter((label) => e.present.has(label)));
    assert.deepEqual(c.missing, Object.values(TYPE_LABELS).filter((label) => !e.present.has(label)));
    assert.equal(c.untagged, e.untagged);
  }
  const reversedTag = boundView('facets', facetViewOf([...tagRows.values()].reverse(), { by: ['tags', 'module', 'line'], total: 100000 }));
  const flipped = run([place, reversedTag, metric]);
  // Sources are hashes of different serializations, so compare only the derived facts.
  assert.deepEqual(flipped.items.map((i) => ({ ...i.fields.coverage as object, source: null })), out.items.map((i) => ({ ...i.fields.coverage as object, source: null })));
});

test('complete placement without null means zero; truncated with null retains the exact indexed count', () => {
  const complete = items(project(undefined, facetViewOf([facetRow({ commands: '/synthetic' }, 3)], { by: ['commands'], total: 3 })));
  assert.match(totalsOutcome(subject(complete)).statement, /0 个用例没有解析出命令/);
  const truncated = items(project(undefined, { ...placement, truncated: true }));
  assert.match(totalsOutcome(subject(truncated)).statement, /2 个用例没有解析出命令/);
  const skipped = items(project(tags([{ tags: 'Functional', count: 3 }], { skipped: 1 })));
  assert.match(skipped.items[0].summary!, /部分/);
});

test('combined count/tag views refuse even when there happens to be one label per case', () => {
  const combined = { ...counts, by: ['line', 'module', 'has_expected', 'vague_expected', 'negative', 'tags'], rows: [facetRow({ line: '10.7', module: '合成模块', has_expected: false, vague_expected: false, negative: false, tags: 'Functional' }, 3)] };
  const out = projectItems({ inputs: [boundView('facets', combined), boundView('placement', placement)] });
  assert.ok('error' in out); assert.match(out.error.message, /列表字段/);
});
