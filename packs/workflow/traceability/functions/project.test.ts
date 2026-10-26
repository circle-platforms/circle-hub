// The item projection: the two bound index views become one item per defect of the build, with the joined cases frozen in
// the item fields and the view facts in the run's groups. Refusals cover the wrong view in a slot, views that disagree on
// product or root, an invalid statuses parameter, no defects to trace and the size budgets.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { projectItems, PROJECT_LIMITS, type ProjectLimits } from './project.ts';
import { boundPair, boundView, caseEntry, defectEntry, indexViewOf, reversed, sha256, type ViewEntrySpec } from './test-support.ts';
import type { MatrixRow } from './types.ts';

const CONTEXT = { product: 'famx', names: ['FAMX', 'FAMY'], line: null, build: null, root: null, parameters: {}, groups: [] };

function projectionOf(defects: ViewEntrySpec[], cases: ViewEntrySpec[], options: { statuses?: unknown; defectsView?: Record<string, unknown>; casesView?: Record<string, unknown> } = {}) {
  const pair = boundPair(defects, cases, options);
  const parameters = options.statuses === undefined ? {} : { statuses: options.statuses };
  return { input: { inputs: pair.inputs, parameters, context: { ...CONTEXT, parameters } }, pair };
}

function project(defects: ViewEntrySpec[], cases: ViewEntrySpec[], options: Parameters<typeof projectionOf>[2] = {}, limits?: Partial<ProjectLimits>) {
  const { input } = projectionOf(defects, cases, options);
  return projectItems(input, limits);
}

type Items = { items: Array<{ id: string; label: string; summary?: string; location: { slot: string; source: string; parser: string; selector: string }; fields: MatrixRow }>; groups?: Array<Record<string, unknown>>; warnings: Array<{ code: string; message: string }> };

const asItems = (out: ReturnType<typeof projectItems>): Items => {
  assert.ok(!('error' in out), `not a refusal: ${'error' in out ? out.error.code : ''}`);
  return out as Items;
};

describe('projectItems', () => {
  it('projects one item per defect with the joined cases frozen in the fields', () => {
    const defect = defectEntry({ bug: '7001', statement: '告警阈值修改后不生效' });
    const a = caseEntry({ defects: ['7001'], case: 'C-a', title: '修改告警阈值' });
    const b = caseEntry({ defects: ['7001'], case: 'C-b', title: '阈值超出范围' });
    const out = asItems(project([defect], [b, a]));
    assert.equal(out.items.length, 1);
    const [item] = out.items;
    assert.equal(item.id, '7001');
    assert.equal(item.label, '告警阈值修改后不生效');
    assert.equal(item.summary, '已修复；2 个用例');
    assert.equal(item.location.slot, 'defects');
    assert.equal(item.location.parser, 'json@1');
    assert.match(item.location.selector, /^p\/entries\/[0-9a-f]{64}$/);
    assert.equal(item.fields.bug, '7001');
    assert.deepEqual(item.fields.statuses, ['fixed']);
    assert.equal(item.fields.conflict, false);
    assert.deepEqual(
      item.fields.cases.map((c) => [c.case, c.title]),
      [
        ['C-a', '修改告警阈值'],
        ['C-b', '阈值超出范围'],
      ],
    );
    assert.equal(out.warnings.length, 0);
  });

  it('summarises an untraced defect as unknown, never as a failure', () => {
    const out = asItems(project([defectEntry({ bug: '7002' })], []));
    assert.equal(out.items[0].summary, '已修复；无已索引用例（未知）');
  });

  it('marks a known defect in the label of its status and a conflict in its summary', () => {
    const out = asItems(project([defectEntry({ bug: '7003', status: 'known' }), defectEntry({ bug: '7004', status: 'known' }), defectEntry({ bug: '7004', status: 'fixed' })], []));
    const [known, conflict] = out.items;
    assert.equal(known.summary, '已知；无已索引用例（未知）');
    assert.equal(conflict.summary, '状态矛盾（已修复、已知）；无已索引用例（未知）');
    assert.equal(conflict.fields.conflict, true);
  });

  it('freezes the view facts in the run groups: sources, totals, skipped and truncated per view', () => {
    const pair = projectionOf([defectEntry({ bug: '7005' })], [caseEntry({ defects: ['7005'] })], {
      defectsView: { skipped: 1 },
      casesView: { truncated: true, notes: ['被截断'] },
    });
    const out = asItems(projectItems(pair.input));
    const groups = out.groups as Array<{ product: string; build: string; root: string; statuses: string[]; views: { defects: Record<string, unknown>; cases: Record<string, unknown> } }>;
    assert.equal(groups.length, 1);
    const [group] = groups;
    assert.deepEqual([group.product, group.build, group.root], ['famx', 'Rel_FAMX_10_6_1_57', sha256('traceability synthetic root of Rel_FAMX_10_6_1_57')]);
    assert.deepEqual(group.statuses, ['fixed', 'known']);
    assert.deepEqual(group.views.defects.skipped, 1);
    assert.deepEqual(group.views.cases.truncated, true);
    assert.match(group.views.defects.source as string, /^src:[0-9a-f]{64}$/);
    // A truncated view warns: the matrix covers only the listed part.
    assert.ok(out.warnings.some((w) => w.code === 'traceability.view_truncated' && w.message.includes('用例索引')));
  });

  it('selects the defect entries by the statuses parameter and refuses values outside fixed and known', () => {
    const only = asItems(project([defectEntry({ bug: '7006' }), defectEntry({ bug: '7007', status: 'known' })], [], { statuses: ['fixed'] }));
    assert.deepEqual(
      only.items.map((i) => i.id),
      ['7006'],
    );
    const invalid = project([defectEntry({ bug: '7006' })], [], { statuses: ['fixed', 'open'] });
    assert.ok('error' in invalid);
    if ('error' in invalid) assert.equal(invalid.error.code, 'traceability.invalid_parameter');
  });

  it('refuses the wrong view in a slot: schema, kind or key not the ones the slot reads', () => {
    const defect = defectEntry({ bug: '7008' });
    const wrongKind = indexViewOf('case', 'defects', [caseEntry({ defects: ['7008'] })]);
    const input = { inputs: [boundView('defects', wrongKind), boundView('cases', indexViewOf('case', 'defects', []))], parameters: {}, context: CONTEXT };
    const out = projectItems(input);
    assert.ok('error' in out);
    if ('error' in out) {
      assert.equal(out.error.code, 'traceability.wrong_view');
      assert.match(out.error.message, /defects/);
      assert.ok(out.error.fix.length > 0);
    }
  });

  it('refuses when the two views name different products or different roots, or a product other than the run’s', () => {
    const defect = defectEntry({ bug: '7009' });
    const kase = caseEntry({ defects: ['7009'] });
    const byProduct = { inputs: [boundView('defects', indexViewOf('defect', 'bug', [defect], { product: 'other' })), boundView('cases', indexViewOf('case', 'defects', [kase]))], parameters: {}, context: CONTEXT };
    const byRoot = { inputs: [boundView('defects', indexViewOf('defect', 'bug', [defect], { root: 'f'.repeat(64) })), boundView('cases', indexViewOf('case', 'defects', [kase]))], parameters: {}, context: CONTEXT };
    const byRun = { inputs: boundPair([defect], [kase]).inputs, parameters: {}, context: { ...CONTEXT, product: 'other' } };
    for (const input of [byProduct, byRoot, byRun]) {
      const out = projectItems(input);
      assert.ok('error' in out);
      if ('error' in out) assert.equal(out.error.code, 'traceability.view_mismatch');
    }
  });

  it('refuses when no defect of the build matches the statuses (the run would have no items)', () => {
    const out = project([defectEntry({ bug: '7010', status: 'known' })], [], { statuses: ['fixed'] });
    assert.ok('error' in out);
    if ('error' in out) assert.equal(out.error.code, 'traceability.no_defects');
  });

  it('refuses a run over the item budget or the output budget, with a fix', () => {
    const defects = Array.from({ length: 12 }, (_, i) => defectEntry({ bug: `${72000 + i}` }));
    const items = project(defects, [], {}, { maxItems: 5 });
    assert.ok('error' in items);
    if ('error' in items) assert.equal(items.error.code, 'traceability.too_large');
    const big = caseEntry({ defects: ['72000'], case: 'C-big', title: '长'.repeat(4000) });
    const bytes = project([defects[0]], [big], {}, { outputBytes: 4096 });
    assert.ok('error' in bytes);
    if ('error' in bytes) assert.equal(bytes.error.code, 'traceability.too_large');
  });

  it('warns about entries a key lists but the view does not carry', () => {
    const defect = defectEntry({ bug: '7011' });
    const view = indexViewOf('defect', 'bug', [defect]);
    (view.keys as Record<string, string[]>)['7011'].push('e'.repeat(64));
    const out = projectItems({ inputs: [boundView('defects', view), boundView('cases', indexViewOf('case', 'defects', []))], parameters: {}, context: CONTEXT });
    const items = asItems(out);
    assert.ok(items.warnings.some((w) => w.code === 'traceability.entry_missing'));
  });

  it('is deterministic and independent of member order in the views', () => {
    const defects = [defectEntry({ bug: '7101' }), defectEntry({ bug: '07102' }), defectEntry({ bug: '7103', status: 'known' })];
    const cases = [caseEntry({ defects: ['7101', '7102'], case: 'C-1' }), caseEntry({ defects: ['7102'], case: 'C-2' })];
    const one = asItems(project(defects, cases));
    const pair = boundPair(defects, cases);
    const flipped = { inputs: pair.inputs.map((bound, i) => ({ ...bound, model: reversed(i === 0 ? pair.defects : pair.cases) })), parameters: {}, context: CONTEXT };
    const two = asItems(projectItems(flipped));
    // The flipped inputs keep the original digests (as the Hub's canonical storage would): the outputs are identical.
    assert.deepEqual(two, one);
  });

  it('keeps every summary within 200 characters', () => {
    const defect = defectEntry({ bug: '7013', statement: '长'.repeat(300) });
    const kase = caseEntry({ defects: ['7013'], case: 'C-l', title: '题'.repeat(150) });
    const out = asItems(project([defect], [kase]));
    for (const item of out.items) {
      assert.ok([...item.summary!].length <= 200, item.summary);
      assert.ok([...item.label].length <= 200, item.label);
    }
  });

  it('the default budgets admit the spec’s scale of items (8,000) and refuse only beyond', () => {
    assert.equal(PROJECT_LIMITS.maxItems, 8000);
    assert.ok(PROJECT_LIMITS.outputBytes <= 5 * 1024 * 1024);
  });
});

  it('no_defects refusal identifies observed view facts without guessing a missing release note',()=>{
    for(const [view,pattern] of [[{skipped:2},/列出.*2.*未读/],[{total_entries:0,total_keys:0},/视图.*未列出/]] as const){
      const out=project([],[],{defectsView:view});
      assert.ok('error' in out);if('error' in out){assert.match(out.error.message,pattern);assert.doesNotMatch(out.error.fix,/可能/);}
    }
  });
