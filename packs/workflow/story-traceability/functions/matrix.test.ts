import assert from 'node:assert/strict';
import { test } from 'node:test';
import project from './project.ts';
import check from './check.ts';
import counts from './counts.ts';
import { normalizeId } from './ids.ts';
import { normalizeId as defectId } from '../../traceability/functions/ids.ts';
import { boundView, caseEntry, indexViewOf } from '../../traceability/functions/test-support.ts';

export function input(ids = ['00021', '22', '23']) {
  return { inputs: [boundView('stories', { stories: [{ id: '21', status: 'synthetic-status', stage: 'synthetic-stage', title: '合成需求' }, { id: '22', title: null, fields_absent: ['status', 'stage'] }], unread: ['23'] }, `plm:stories:${ids.map(normalizeId).join('+')}`),
    boundView('cases', indexViewOf('case', 'stories', [
      caseEntry({ defects: ['22'], stories: ['00021'], case: 'c1' }),
      caseEntry({ defects: [], stories: ['21', '22'], case: 'c2' }),
    ]))] };
}
export function projected(value: unknown = input()): any {
  const p = project(value) as any;
  assert.ok(!p.error, JSON.stringify(p));
  return { items: p.items, context: { groups: p.groups } };
}

test('one item per requested id including unread; exact story join excludes same-numbered bugs', () => {
  const s = projected();
  assert.deepEqual(s.items.map((i: any) => [i.id, i.fields.cases.map((c: any) => c.case)]), [['21', ['c1', 'c2']], ['22', ['c2']], ['23', []]]);
  const outcomes = check({ subject: s }) as any[];
  assert.deepEqual(outcomes.map(o => o.verdict), ['support', 'support', 'support']);
  assert.equal(outcomes[2].data.plm_returned, false);
  assert.match(outcomes[2].statement, /完整需求号键列表覆盖的索引视图/);
  assert.equal(outcomes[2].data.coverage.complete, true);
  assert.ok(outcomes[2].grounds.includes(s.context.groups[0].view.source));
  assert.match(outcomes[2].statement, /10_6/);
  const [total] = counts({ subject: s }) as any[];
  assert.deepEqual([total.data.stories, total.data.traced, total.data.untraced, total.data.plm_unread], [3, 2, 1, 1]);
  assert.deepEqual(total.data.statuses, [{ status: 'synthetic-status', count: 1 }]);
});

test('normalisation matches defect pack and order cannot change the result', () => {
  for (let n = 0; n < 2000; n++) assert.equal(normalizeId(`000${n}`), defectId(`000${n}`));
  const i = input();
  assert.deepEqual(project({ inputs: [...i.inputs].reverse() }), project(i));
});

test('contradictory raw story ids and false completeness are refuted', () => {
  const s = projected(); s.items[0].fields.cases[0].stories = ['999'];
  assert.equal((check({ subject: s }) as any[])[0].code, 'story-traceability.join_mismatch');
  s.context.groups[0].view.total_entries++;
  assert.equal((counts({ subject: s }) as any[])[0].code, 'story-traceability.count_mismatch');
});

test('two thousand requirements match an independent double loop', () => {
  let seed = 123;
  const random = () => (seed = Math.imul(seed, 1664525) + 1013904223 >>> 0) / 2 ** 32;
  const stories = Array.from({ length: 2000 }, (_, i) => ({ id: String(i + 1), status: 'synthetic', stage: null, title: null }));
  const cases = Array.from({ length: 1300 }, (_, i) => caseEntry({ defects: [String(i + 1)], stories: Array.from({ length: 3 }, () => String(1 + Math.floor(random() * 2000))), case: `c${i}` }));
  const inputs = [];
  for (let i = 0; i < stories.length; i += 50) { const batch = stories.slice(i, i + 50); inputs.push(boundView('stories', { stories: batch, unread: [] }, `plm:stories:${batch.map(s => s.id).join('+')}`)); }
  inputs.push(boundView('cases', indexViewOf('case', 'stories', cases)));
  const s = projected({ inputs });
  for (const row of s.items) {
    const expected = cases.filter(c => (c.data.stories as string[]).some(id => id === row.id)).map(c => c.data.node).sort();
    assert.deepEqual(row.fields.cases.map((c: any) => c.case).sort(), expected);
  }
});

test('configured build scope is optional and missing field requests ids without guessing', () => {
  const cases = input().inputs.filter(i => i.slot === 'cases');
  const build = boundView('build', { builds: [{ id: '7', name: (cases[0].model as any).build.build, stories: ['21', '23'], scope_note: '需求范围取自构建记录' }] }, 'plm:builds:5');
  const p = project({ inputs: [...cases, build], parameters: { build_id: '7' } }) as any;
  assert.deepEqual(p.items.map((i: any) => i.id), ['21', '23']);
  assert.equal(p.items[0].fields.scope, 'observed');
  build.model = { builds: [{ id: '7', name: (cases[0].model as any).build.build, stories: null, scope_note: '缺少设置 settings.build_story_field' }] };
  const absent = project({ inputs: [...cases, build], parameters: { build_id: '7' } }) as any;
  assert.match(absent.error.message, /未提供可用的需求编号数组/);
  assert.match(absent.error.message, /settings.build_story_field/);
});

test('empty raw story arrays contradict a key mapping while omitted raw fields permit slim views', () => {
  const i = input(); const view = i.inputs[1].model as any;
  for (const entry of Object.values(view.entries) as any[]) delete entry.data.stories;
  const s = projected(i);
  assert.equal((check({ subject: s }) as any[])[0].verdict, 'support');
  s.items[0].fields.cases[0].stories = [];
  assert.equal((check({ subject: s }) as any[])[0].verdict, 'refute');
});

test('partial views refuse projection and name the missing facts and recovery action', () => {
  for (const patch of [{ total_keys: 4, truncated: true }, { skipped: 1, notes: ['来源 src:synthetic 不可读'] }, { only: ['21'] }]) {
    const i = input(); Object.assign(i.inputs[1].model as any, patch);
    const p = project(i) as any; assert.ok(p.error); assert.match(p.error.message, /缺少|不完整/); assert.match(p.error.fix, /知识同步/);
    if ('notes' in patch) assert.match(p.error.message, /src:synthetic/);
  }
  const i = input(); const view = i.inputs[1].model as any; delete view.entries[Object.keys(view.entries)[0]];
  assert.ok(!(project(i) as any).error, 'missing bodies do not hide an absent key');
});
test('corrupt and conflicting inputs remain refused', () => {
  const i = input(); assert.ok((project({ inputs: [] }) as any).error);
  assert.ok((project({ inputs: [i.inputs[0], i.inputs[0], i.inputs[1]] }) as any).items);
  const other = structuredClone(i.inputs[0]); (other.model as any).stories[0].status = 'different';
  assert.ok((project({ inputs: [...i.inputs, other] }) as any).error);
});

test('build-derived detail reads are split into fifty ids and record absent fields without actions', async () => {
  const { default: expected } = await import('./expected.ts');
  const items = Array.from({ length: 123 }, (_, i) => ({ id: String(i + 1), fields: { scope: 'observed' } }));
  const e = expected({ items }) as any;
  assert.deepEqual(e.sources.map((s: any) => s.external.split(':')[2].split('+').length), [50, 50, 23]);
  const s = projected();
  const outcomes = check({ subject: s }) as any[];
  assert.deepEqual(outcomes[1].data.fields_absent, ['status', 'stage']);
  assert.deepEqual(outcomes[1].data.next_actions, []);
});

test('projection output meets the shared schema including unread locations', async () => {
  const { ProjectionOutput } = await import('../../../../contracts/src/pack.ts');
  assert.equal(ProjectionOutput.safeParse(project(input())).success, true);
});

test('absent PLM fields are observed absence, scalar values are raw, and unread ids ask the user to confirm', () => {
  const i = input(); (i.inputs[0].model as any).stories = [{ id: '21', stage: 0, fields_absent: ['status'] }, { id: '22', status: 4, stage: false, fields_absent: [] }];
  const s = projected(i); const outcomes = check({ subject: s }) as any[];
  assert.deepEqual(outcomes[0].data.fields_absent, ['status']); assert.equal(outcomes[0].data.stage, 0);
  assert.deepEqual(outcomes[0].data.gaps, []); assert.deepEqual(outcomes[0].data.next_actions, []);
  assert.doesNotMatch(outcomes[0].statement, /未知|补齐|重跑/);
  assert.equal(outcomes[1].data.status, 4); assert.equal(outcomes[1].data.stage, false);
  assert.match(outcomes[2].statement, /应答里没有编号/);
  assert.ok(outcomes[2].data.next_actions.some((action: string) => action.includes('用户确认')));
  const [total] = counts({ subject: s }) as any[];
  assert.deepEqual(total.data.statuses, [{ status: 4, count: 1 }]); assert.equal(total.data.status_absent, 1);
  assert.doesNotMatch(total.statement, /未知/);
});

test('failed detail sources are distinct from a successful PLM response without an id', () => {
  const cases = input().inputs.filter(i => i.slot === 'cases');
  const build = boundView('build', { builds: [{ id: '7', name: (cases[0].model as any).build.build, stories: ['21', '23'] }] }, 'plm:builds:5');
  const s = projected({ inputs: [...cases, build], parameters: { build_id: '7' } });
  const unavailable = check({ subject: s, sources: {}, unread_sources: ['src:missing'] }) as any[];
  assert.match(unavailable[0].statement, /详情没有读到（来源不可用）/); assert.doesNotMatch(unavailable[0].statement, /应答里没有编号/);
  const [total] = counts({ subject: s, sources: {} }) as any[];
  assert.equal(total.data.plm_unread, 0); assert.equal(total.data.plm_unavailable, 2);
  const reference = 'src:' + 'b'.repeat(64);
  const sources = { [reference]: JSON.stringify({ stories: [{ id: '21', stage: 3 }], unread: ['23'] }) };
  const [read] = counts({ subject: s, sources }) as any[];
  assert.equal(read.data.plm_unread, 1); assert.equal(read.data.plm_unavailable, 0);
  const outcomes = check({ subject: s, sources }) as any[];
  assert.match(outcomes[1].statement, /应答里没有编号 23/); assert.ok(outcomes[1].grounds.includes(reference));
  const ignored = counts({ subject: s, sources, unread_sources: [reference] }) as any[];
  assert.equal(ignored[0].data.plm_unavailable, 2);
});


test('scope codes come from provenance_type and labels never drive expected reads', async () => {
  const { default: expected } = await import('./expected.ts');
  const user = projected(); assert.equal(user.items[0].fields.scope, 'declared');
  assert.deepEqual((expected({ items: user.items }) as any).sources, []);
  const items = [{ id: '21', fields: { scope: 'observed', scope_label: '任意显示文案' } }];
  assert.equal((expected({ items }) as any).sources[0].external, 'plm:stories:21');
});

test('pack label snapshot equals the authoritative generated vocabulary', async () => {
  const { readFile } = await import('node:fs/promises');
  const { vocabularyText } = await import('../testing/generate-vocabulary.ts');
  const { PROVENANCE_TYPE, labelOf } = await import('../../../../contracts/generated/vocabulary.ts');
  const snapshot = await import('./generated/vocabulary.ts');
  assert.equal(await readFile(new URL('./generated/vocabulary.ts', import.meta.url), 'utf8'), vocabularyText());
  for (const code of PROVENANCE_TYPE) assert.equal(snapshot.labelOf('provenance_type', code), labelOf('provenance_type', code));
});

test('build ids compare after normalization and refusal names an empty array rather than a missing field', () => {
  const cases = input().inputs.filter(i => i.slot === 'cases');
  const build = boundView('build', { builds: [{ id: '7', name: (cases[0].model as any).build.build, stories: ['21'] }] }, 'plm:builds:5');
  const p = project({ inputs: [...cases, build], parameters: { build_id: '007' } }) as any;
  assert.deepEqual(p.items?.map((i: any) => i.id), ['21']);
  build.model = { builds: [{ id: '7', name: (cases[0].model as any).build.build, stories: [], scope_note: '需求范围取自构建记录' }] };
  const empty = project({ inputs: [...cases, build], parameters: { build_id: '007' } }) as any;
  assert.match(empty.error.message, /构建记录 7.*数组为空/); assert.doesNotMatch(empty.error.message, /没有需求字段|缺少指定构建记录/);
  const missing = project({ inputs: [...cases, build], parameters: { build_id: '8' } }) as any;
  assert.match(missing.error.message, /未包含.*8/); assert.doesNotMatch(missing.error.message, /没有需求字段/);
});

test('every projection refusal conforms to projection-output and retains its own cause', async () => {
  const { ProjectionOutput } = await import('../../../../contracts/src/pack.ts');
  const invalid = project({ inputs: [] }) as any;
  assert.equal(ProjectionOutput.safeParse(invalid).success, true);
  assert.deepEqual(invalid.warnings, []);
  const conflicting = input(['21']);
  const source = conflicting.inputs[0];
  const second = structuredClone(source); (second.model as any).stories[0].status = 'different';
  const refusal = project({ inputs: [...conflicting.inputs, second] }) as any;
  assert.match(refusal.error.message, /同一需求的 PLM 原件内容冲突/);
  assert.match(refusal.error.fix, /一致原件/);
});

for (const patch of [{ cut_keys: ['00021'], truncated: true }, { only: ['00021'], truncated: true }, { total_keys: 99, truncated: true }]) test(`listed matches remain determinate despite ${JSON.stringify(patch)}`, () => {
  const i = input(['21']); Object.assign(i.inputs[1].model as object, patch);
  const s = projected(i); const [outcome] = check({ subject: s }) as any[];
  assert.equal(outcome.verdict, 'support'); assert.match(outcome.statement, /至少 2 个已索引条目/);
  assert.equal(outcome.data.coverage.complete, false);
});
test('only the undetermined ids refuse and the fix acknowledges normalized-only matching needs', () => {
  const i = input(['21', '23']); Object.assign(i.inputs[1].model as object, { total_keys: 99, truncated: true });
  const refusal = project(i) as any;
  assert.match(refusal.error.message, /需求 23.*完整/); assert.doesNotMatch(refusal.error.message, /需求 21/);
  assert.match(refusal.error.fix, /only=/); assert.match(refusal.error.fix, /规范化/);
  assert.doesNotMatch(refusal.error.fix, /消除视图截断/);
});
test('listed digest links without bodies are positive index facts, not an absence claim', () => {
  const i = input(['21']); const view = i.inputs[1].model as any; view.entries = {};
  const s = projected(i); const [outcome] = check({ subject: s }) as any[];
  assert.equal(outcome.verdict, 'support'); assert.equal(outcome.data.indexed_match_count, 2);
  assert.match(outcome.statement, /至少 2 个已索引条目/);
  assert.doesNotMatch(outcome.statement, /没有条目携带/);
});

test('non-scalar PLM fields are determinate observations counted apart from explicit null', () => {
  const i = input(['21', '22']);
  i.inputs[0].model = { stories: [{ id: '21', status: { raw: 'synthetic' }, stage: ['synthetic'] }, { id: '22', status: null, stage: null }], unread: [] };
  const s = projected(i); const outcomes = check({ subject: s }) as any[];
  assert.deepEqual(outcomes[0].data.fields_nonscalar, ['status', 'stage']);
  assert.equal(outcomes[0].verdict, 'support'); assert.match(outcomes[0].statement, /不是单个值/);
  const [total] = counts({ subject: s }) as any[];
  assert.deepEqual([total.data.status_nonscalar, total.data.stage_nonscalar, total.data.status_absent], [1, 1, 0]);
  assert.deepEqual(total.data.statuses, [{ status: null, count: 1 }]);
  assert.match(total.statement, /PLM 返回的状态不是单个值的有 1 个，没有按状态计数/);
  const long = projected(i); long.items[1].fields.status = 'synthetic'.repeat(1000);
  const [summary] = counts({ subject: long }) as any[];
  assert.match(summary.statement.slice(0, 500), /状态不是单个值的有 1 个/);
  assert.match(summary.statement.slice(0, 500), /阶段不是单个值的有 1 个/);
});

test('build-derived details retain non-scalar markers from the system projection', () => {
  const cases = input().inputs.filter(source => source.slot === 'cases');
  const build = boundView('build', { builds: [{ id: '7', name: (cases[0].model as any).build.build, stories: ['21'] }] }, 'plm:builds:5');
  const s = projected({ inputs: [...cases, build], parameters: { build_id: '7' } });
  const sources = { ['src:' + 'c'.repeat(64)]: JSON.stringify({ stories: [{ id: '21', status: null, stage: null, fields_absent: [], fields_nonscalar: ['status'] }], unread: [] }) };
  const [total] = counts({ subject: s, sources }) as any[];
  assert.equal(total.data.status_nonscalar, 1); assert.deepEqual(total.data.statuses, []);
});
