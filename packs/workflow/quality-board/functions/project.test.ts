// The item projection: the facet view becomes one item per (line, module) group, with the counts and ratios frozen in the
// item fields and the view facts in the run's groups. Refusals cover the wrong view, a product other than the run's,
// invalid threshold parameters, an empty view (no case entries), ambiguous group ids and the size budgets.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { projectItems, PROJECT_LIMITS, type ProjectLimits } from './project.ts';
import { placementFor, boundView, facetRow, facetViewOf, reversed } from './test-support.ts';

const CONTEXT = { product: 'famx', names: ['FAMX', 'FAMY'], line: null, build: null, root: null, parameters: {}, groups: [] };

function project(rows: Parameters<typeof facetViewOf>[0], options: { parameters?: Record<string, unknown>; overrides?: Parameters<typeof facetViewOf>[1]; context?: Record<string, unknown> } = {}, limits?: Partial<ProjectLimits>) {
  const parameters = options.parameters ?? {};
  return projectItems({ inputs: [boundView('facets', facetViewOf(rows, options.overrides)), placementFor(facetViewOf(rows, options.overrides))], parameters, context: { ...CONTEXT, ...options.context, parameters } }, limits);
}

type Items = { items: Array<{ id: string; label: string; summary?: string; location: { slot: string; source: string; parser: string; selector: string }; fields: Record<string, unknown> }>; groups?: Array<Record<string, unknown>>; warnings: Array<{ code: string; message: string }> };

const asItems = (out: ReturnType<typeof projectItems>): Items => {
  assert.ok(!('error' in out), `not a refusal: ${'error' in out ? out.error.code : ''}`);
  return out as Items;
};

describe('projectItems', () => {
  it('projects one item per (line, module) group with the metrics frozen in the fields', () => {
    const out = asItems(
      project([
        facetRow({ line: '10.6.1', module: 'SSL', has_expected: true, vague_expected: false, negative: false }, 23),
        facetRow({ line: '10.6.1', module: 'SSL', has_expected: false, vague_expected: false, negative: true }, 2),
        facetRow({ line: '10.6.1', module: null, has_expected: true, vague_expected: true, negative: false }, 4),
      ]),
    );
    assert.deepEqual(
      out.items.map((i) => [i.id, i.label, i.summary]),
      [
        ['10.6.1/SSL', '10.6.1/SSL', '用例 25 个；无期望结果 2 个（8.0%）；含糊期望 0 个（未判断，已判断 0 个）；未判断 25 个；负面用例 2 个（8.0%；有效声明分母 25；类型未声明 0）'],
        ['10.6.1/unplaced', '10.6.1/unplaced', '用例 4 个；无期望结果 0 个（0.0%）；含糊期望 0 个（未判断，已判断 0 个）；未判断 4 个；负面用例 0 个（0.0%；有效声明分母 4；类型未声明 0）'],
      ],
    );
    const [ssl] = out.items;
    assert.deepEqual([ssl.location.slot, ssl.location.parser, ssl.location.selector], ['facets', 'json@1', 'p/rows']);
    const fields = ssl.fields as { line: string; module: string; counts: unknown; ratios: { negative: { num: number; den: number } } };
    assert.deepEqual([fields.line, fields.module], ['10.6.1', 'SSL']);
    assert.deepEqual(fields.ratios.negative, { num: 2, den: 25 });
  });

  it('freezes the view facts in the run groups', () => {
    const out = asItems(project([facetRow({ line: '10.6.1', module: 'SSL', has_expected: true, vague_expected: false, negative: false }, 3)], { overrides: { skipped: 1, truncated: true } }));
    const groups = out.groups as Array<{ product: string; build: string; root: string; view: { skipped: number; truncated: boolean; total: number; listed_rows: number; source: string } }>;
    assert.equal(groups.length, 1);
    assert.deepEqual([groups[0].product, groups[0].build], ['famx', 'Rel_FAMX_10_6_1_57']);
    assert.deepEqual([groups[0].view.skipped, groups[0].view.truncated, groups[0].view.total, groups[0].view.listed_rows], [1, true, 3, 1]);
    assert.match(groups[0].view.source, /^src:[0-9a-f]{64}$/);
    assert.ok(out.warnings.some((w) => w.code === 'quality-board.view_truncated'));
  });

  it('refuses a view of a product other than the run’s', () => {
    const out = project([facetRow({ line: '10.6.1', module: 'SSL', has_expected: true, vague_expected: false, negative: false }, 3)], { context: { product: 'other' } });
    assert.ok('error' in out);
    if ('error' in out) assert.equal(out.error.code, 'quality-board.view_mismatch');
  });

  it('refuses an empty view (no case entries): the board would have no items', () => {
    const out = project([], { overrides: { total: 0 } });
    assert.ok('error' in out);
    if ('error' in out) {
      assert.equal(out.error.code, 'quality-board.no_cases');
      assert.ok(out.error.fix.length > 0);
    }
  });

  it('refuses invalid threshold parameters', () => {
    const out = project([facetRow({ line: '10.6.1', module: 'SSL', has_expected: true, vague_expected: false, negative: false }, 3)], { parameters: { max_missing_ratio: 'high' } });
    assert.ok('error' in out);
    if ('error' in out) assert.equal(out.error.code, 'quality-board.invalid_parameter');
  });

  it('refuses ambiguous group ids (two pairs that would share one item id)', () => {
    const out = project([facetRow({ line: 'a/b', module: 'c', has_expected: true, vague_expected: false, negative: false }, 1), facetRow({ line: 'a', module: 'b/c', has_expected: true, vague_expected: false, negative: false }, 1)]);
    assert.ok('error' in out);
    if ('error' in out) assert.equal(out.error.code, 'quality-board.ambiguous_group');
  });

  it('refuses a run over the item budget or the output budget, with a fix', () => {
    const rows = Array.from({ length: 12 }, (_, i) => facetRow({ line: '10.6.1', module: `M${i}`, has_expected: true, vague_expected: false, negative: false }, 1));
    const items = project(rows, {}, { maxItems: 5 });
    assert.ok('error' in items);
    if ('error' in items) assert.equal(items.error.code, 'quality-board.too_large');
    const bytes = project([facetRow({ line: '长'.repeat(3000), module: 'SSL', has_expected: true, vague_expected: false, negative: false }, 1)], {}, { outputBytes: 4096 });
    assert.ok('error' in bytes);
    if ('error' in bytes) assert.equal(bytes.error.code, 'quality-board.too_large');
  });

  it('is deterministic and independent of row and member order', () => {
    const rows = [
      facetRow({ line: '10.6.1', module: 'SSL', has_expected: true, vague_expected: false, negative: false }, 8),
      facetRow({ line: '10.6.1', module: 'SSL', has_expected: false, vague_expected: false, negative: true }, 2),
      facetRow({ line: null, module: null, has_expected: true, vague_expected: true, negative: false }, 1),
    ];
    const one = asItems(project(rows));
    const view = facetViewOf(rows);
    const flipped = projectItems({ inputs: [{ ...boundView('facets', view), model: reversed(view) }, placementFor(view)], parameters: {}, context: CONTEXT });
    const two = asItems(flipped);
    // The flipped input keeps the original digest (as the Hub's canonical storage would): the outputs are identical.
    assert.deepEqual(two, one);
  });

  it('keeps every summary within 200 characters', () => {
    const out = asItems(project([facetRow({ line: '10.6.1', module: 'SSL', has_expected: false, vague_expected: true, negative: true }, 999999)]));
    for (const item of out.items) assert.ok([...item.summary!].length <= 200, item.summary);
  });

  it('the default budgets admit far more groups than a real product has modules', () => {
    assert.equal(PROJECT_LIMITS.maxItems, 8000);
    assert.ok(PROJECT_LIMITS.outputBytes <= 5 * 1024 * 1024);
  });
});
