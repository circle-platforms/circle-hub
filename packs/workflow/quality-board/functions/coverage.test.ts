import { labelOf } from './generated/vocabulary.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalTag, RESOURCE_TAGS, TYPE_LABELS } from './tags.ts';
import { canonicalTag as templateTag } from '../../template-gap/functions/tags.ts';
import { projectItems } from './project.ts';
import { boardOutcomes } from './board.ts';
import { totalsOutcome } from './totals.ts';
import { buildSubject } from './subject.ts';
import { boundView, facetViewOf, facetRow, ROOT } from './test-support.ts';

const counts = facetViewOf([facetRow({ line: '10.7', module: '合成模块', has_expected: false, vague_expected: false, negative: false }, 3)]);
const tags = (rows: Array<{ tags: string | null; count: number }>, extra = {}) => facetViewOf(rows.map((r) => facetRow({ line: '10.7', module: '合成模块', tags: r.tags }, r.count)), { by: ['line', 'module', 'tags','resource_empty','tag_valid'], total: 3, ...extra });
const placement = facetViewOf([facetRow({ commands: null }, 2), facetRow({ commands: '/synthetic' }, 1)], { by: ['commands'], total: 3 });
const project = (tagView?: Record<string, unknown>, place = placement, more: unknown[] = []) => projectItems({ inputs: [boundView('facets', counts), ...(tagView ? [boundView('facets', tagView)] : []), boundView('placement', place), ...more], parameters: {} });
function items(out: ReturnType<typeof project>) { assert.ok(!('error' in out), JSON.stringify(out)); return out; }
const subject = (out: ReturnType<typeof items>) => buildSubject({ items: out.items.map((i) => ({ ...i, location: 'src:' + i.location.source })), context: { groups: out.groups } });

test('only exact generated resource declarations name a test type in either consumer', () => {
  for(const declaration of RESOURCE_TAGS){
    const expected=declaration.test_type?declaration.id:null;
    assert.equal(canonicalTag(declaration.text),expected);
    assert.equal(templateTag(declaration.text),expected);
    for(const raw of ['['+declaration.text+']',' '+declaration.text,declaration.text+' tests']){assert.equal(canonicalTag(raw),null);assert.equal(templateTag(raw),null);}
  }
});
test('all six types, duplicate spellings, unknown tags and exact untagged counts', () => {
  const out = items(project(tags([{ tags: 'functional', count: 1 }, { tags: 'function', count: 1 }, { tags: 'configuration', count: 1 }, { tags: 'integration', count: 1 }, { tags: 'compatibility', count: 1 }, { tags: 'negative', count: 1 }, { tags: 'stress', count: 1 }, { tags: 'release-label', count: 1 }, { tags: null, count: 1 }])));
  const coverage = out.items[0].fields.coverage as { present: string[]; missing: string[]; untagged: number; partial: boolean };
  assert.equal(coverage.present.length, 6); assert.deepEqual(coverage.missing, []); assert.equal(coverage.untagged, 1);
  assert.match(out.items[0].summary!, /未打标签 1 个/);
  assert.match(boardOutcomes(subject(out))[0].statement, /未打标签 1 个/);
  assert.ok(totalsOutcome(subject(out)).statement.includes(labelOf('knowledge_count', 'commandless_cases') + ' 2 个'));
});
test('only untagged cases and unknown tags show no recognized types', () => {
  for (const tag of [null, 'release-label']) {
    const out = items(project(tags([{ tags: tag, count: 3 }])));
    const c = out.items[0].fields.coverage as { missing: string[]; untagged: number };
    assert.equal(c.missing.length, 6); assert.equal(c.untagged, tag === null ? 3 : 0);
  }
});
test('partial tags disclose absence in read sources and do not invent an untagged zero', () => {
  const out = items(project(tags([{ tags: 'functional', count: 1 }], { truncated: true, skipped: 2 })));
  assert.equal((out.items[0].fields.coverage as {partial:boolean}).partial,true);
  const c = out.items[0].fields.coverage as { untagged: number | null };
  assert.equal(c.untagged, null);
  assert.match(boardOutcomes(subject(out))[0].statement, /在已读.*未见/);
});
test('wrong roots, duplicate count views and missing placement are refusals with fixes', () => {
  for (const out of [project(tags([], { root: 'b'.repeat(64) })), project(counts), projectItems({ inputs: [boundView('facets', counts)] }), project(undefined, { ...placement, build: { build: 'alias', root: 'b'.repeat(64) } })]) {
    assert.ok('error' in out); assert.ok(out.error.fix.length > 0);
  }
  assert.equal(ROOT.length, 64);
});
test('truncated placement without the null row refuses rather than finishing unknown', () => {
  const out = project(undefined, facetViewOf([facetRow({ commands: '/synthetic' }, 1)], { by: ['commands'], total: 3, truncated: true }));
  assert.ok('error' in out); assert.ok(out.error.message.includes(labelOf('knowledge_count', 'commandless_cases'))); assert.match(out.error.fix, /能力缺口/);
});
test('without tags the board metrics and summary stay unchanged', () => {
  const out = items(project());
  assert.match(out.items[0].summary!, /用例 3 个；无期望结果 3 个（100.0%）/);
  assert.match(out.items[0].summary!, /已判断 0 个/);
  assert.match(out.items[0].summary!, /有效声明分母 3/);
  assert.equal(out.items[0].fields.coverage, undefined);
});

test('coverage matches independent per-case calculation on 100000 random cases and is order independent', async () => {
  const testType=(raw:string)=>{const declaration=RESOURCE_TAGS.find(tag=>tag.text===raw&&tag.test_type);return declaration?TYPE_LABELS[declaration.id as keyof typeof TYPE_LABELS]:null;};
  const { randomOf } = await import('./test-support.ts');
  const random = randomOf(47001);
  const aliases = [[], ['functional'], ['function', '[Functional]'], ['configuration', 'stress'], ['negative'], ['integration', 'compatibility'], ['release-tag']];
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
  const tagged = boundView('facets', facetViewOf([...tagRows.values()], { by: ['line', 'module', 'tags','resource_empty','tag_valid'], total: 100000 }));
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
  const reversedTag = boundView('facets', facetViewOf([...tagRows.values()].reverse(), { by: ['tags', 'module', 'line','resource_empty','tag_valid'], total: 100000 }));
  const flipped = run([place, reversedTag, metric]);
  // Sources are hashes of different serializations, so compare only the derived facts.
  assert.deepEqual(flipped.items.map((i) => ({ ...i.fields.coverage as object, source: null })), out.items.map((i) => ({ ...i.fields.coverage as object, source: null })));
});

test('complete placement without null means zero; truncated with null retains the exact indexed count', () => {
  const complete = items(project(undefined, facetViewOf([facetRow({ commands: '/synthetic' }, 3)], { by: ['commands'], total: 3 })));
  assert.ok(totalsOutcome(subject(complete)).statement.includes(labelOf('knowledge_count', 'commandless_cases') + ' 0 个'));
  const truncated = items(project(undefined, { ...placement, truncated: true }));
  assert.ok(totalsOutcome(subject(truncated)).statement.includes(labelOf('knowledge_count', 'commandless_cases') + ' 2 个'));
  const skipped = items(project(tags([{ tags: 'functional', count: 3 }], { skipped: 1 })));
  assert.equal((skipped.items[0].fields.coverage as {partial:boolean}).partial,true);
});

test('combined count/tag views refuse even when there happens to be one label per case', () => {
  const combined = { ...counts, by: ['line', 'module', 'has_expected', 'negative', 'test_type_status', 'tags'], rows: [facetRow({ line: '10.7', module: '合成模块', has_expected: false, vague_expected: false, negative: false, tags: 'functional' }, 3)] };
  const out = projectItems({ inputs: [boundView('facets', combined), boundView('placement', placement)] });
  assert.ok('error' in out); assert.match(out.error.message, /列表字段/);
});
