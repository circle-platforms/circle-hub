import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getInterpreter } from '../../../../hub/rules/api.ts';
import { CANONICAL_TAGS } from './tags.ts';
import coverageDefault, { keywordForm, matchForm, templateCoverage } from './template-coverage.ts';
import { assertJson, isFailure, parseFixture, parseLarge, project, reviewProjection, table } from '../testing/test-support.ts';
import type { CoverageFacts, Template } from './types.ts';

const template = table('template-v3.json') as Template;
const facts = (input: unknown): CoverageFacts => {
  const out = templateCoverage(input);
  assert.ok(!isFailure(out), JSON.stringify(out));
  return out;
};
const coverageCheck = (subject: unknown) => {
  const interpreter = getInterpreter('coverage@1');
  assert.ok(interpreter);
  return interpreter.run({ interpreter: 'coverage@1', table: table('template-v3-coverage.json'), subject, context: {} });
};

describe('the template table', () => {
  it('is a case-review.template@1 table whose categories all load', () => {
    assert.equal(template.schema, 'case-review.template@1');
    assert.ok(template.origin.length > 0);
    const out = facts({ items: [], template });
    assert.deepEqual(out.warnings, []);
    assert.equal(out.categories.length, template.categories.length);
    assert.equal(new Set(template.categories.map((category) => category.id)).size, template.categories.length);
  });

  it('has one category per canonical tag and the categories the template describes', () => {
    const byTag = template.categories.filter((category) => category.tags?.length);
    assert.deepEqual(
      byTag.flatMap((category) => category.tags),
      [...CANONICAL_TAGS],
    );
    for (const id of ['command_add', 'command_delete', 'command_modify', 'command_query', 'show_at_maximum', 'no_command', 'clear_command', 'operation_log', 'audit_log', 'configuration_sync', 'configuration_save', 'configuration_restore', 'configuration_clear', 'upgrade_new_to_new', 'upgrade_old_to_new', 'upgrade_new_to_old', 'security', 'database']) {
      assert.ok(template.categories.some((category) => category.id === id), id);
    }
  });
});

describe('templateCoverage', () => {
  it('finds every category in the template document; only the six test types are required', () => {
    const { items } = project(parseFixture('template.km.json').model, 'template');
    const out = facts({ items, template });
    assert.deepEqual(out.missing, []);
    assert.deepEqual(out.required, ['functional', 'configuration', 'integration', 'compatibility', 'negative', 'stress']);
    assert.deepEqual(
      out.covered,
      template.categories.map((category) => category.id),
    );
    for (const category of out.categories) assert.ok(category.present && category.evidence.length > 0, category.id);
  });

  it('finds every category in the review document, with item ids as evidence', () => {
    const { items } = reviewProjection();
    const out = facts({ items, template });
    assert.deepEqual(out.missing, []);
    const ids = new Set(items.map((item) => item.id));
    for (const category of out.categories) {
      assert.ok(category.evidence.every((id) => ids.has(id)), category.id);
      assert.equal(category.present, category.count > 0);
    }
    const upgrade = out.categories.find((category) => category.id === 'upgrade_new_to_new');
    assert.equal(upgrade?.count, 1, 'the arrow "→" matches the keyword written with "->"');
    // The group "no 与 clear" names both commands; its cases are the evidence of both categories.
    const inGroup = items.filter((item) => item.fields.path.includes('no 与 clear')).map((item) => item.id);
    assert.equal(inGroup.length, 2);
    assert.deepEqual(out.categories.find((category) => category.id === 'no_command')?.evidence, inGroup);
    assert.deepEqual(out.categories.find((category) => category.id === 'clear_command')?.evidence, inGroup);
    assertJson(out);
  });

  it('feeds the coverage@1 check: removing every case of a required category is a shortfall, a gap with a reason is not', () => {
    const items = reviewProjection().items.filter((item) => !item.fields.tagsNormalized.includes('Stress'));
    const gap = facts({ items, template });
    assert.deepEqual(gap.missing, ['stress']);
    const [shortfall] = coverageCheck(gap);
    assert.equal(shortfall.verdict, 'refute');
    assert.equal(shortfall.code, 'core.coverage.shortfall');
    assert.deepEqual(shortfall.data?.missing, ['stress']);
    assert.equal(shortfall.tier, 'advisory');
    const skipped = facts({ items, template, skipped: [{ category: 'stress', reason: '本功能不涉及性能' }] });
    assert.deepEqual(skipped.missing, []);
    const [support] = coverageCheck(skipped);
    assert.equal(support.verdict, 'support');
    const restored = facts({ items: [...items, ...reviewProjection().items.filter((item) => item.fields.title === '压力过程中反复增删池')], template });
    assert.deepEqual(restored.missing, [], 'adding one case of the category makes it present');
    const tiny = facts({ items: project(parseFixture('tiny.km.json').model, 'tiny').items, template });
    assert.deepEqual(tiny.covered, ['functional', 'command_add', 'command_query']);
  });

  it('reports a category that is not required as absent without counting it missing', () => {
    const items = reviewProjection().items.filter((item) => !item.fields.path.includes('no 与 clear'));
    const out = facts({ items, template });
    assert.deepEqual(out.missing, []);
    assert.deepEqual(
      out.categories.filter((category) => !category.present).map((category) => category.id),
      ['no_command', 'clear_command'],
    );
    assert.equal(coverageCheck(out)[0].verdict, 'support');
  });

  it('counts a category present through optional categories too, and only required ones as missing', () => {
    const optional: Template = { ...template, categories: [{ id: 'extra', label: '附加', required: false, contains: ['不会出现的词'] }, ...template.categories] };
    const out = facts({ items: reviewProjection().items, template: optional });
    assert.equal(out.required.includes('extra'), false);
    assert.equal(out.missing.includes('extra'), false);
  });

  it('matches keywords as written, with the spaces around a word kept', () => {
    assert.equal(matchForm('  新版本 →  新版本 '), '新版本->新版本');
    assert.equal(keywordForm(' Add '), ' add ');
    const item = (title: string) => ({ id: title, fields: { path: [], title, tags: [], steps: [], expected: [], preconditions: [] } });
    const only: Template = { schema: 'case-review.template@1', id: 't', origin: 'test', categories: [{ id: 'add', label: '添加', contains: [' add '], prefixes: ['add '], fields: ['title'] }] };
    assert.equal(facts({ items: [item('relay endpoint add 192.0.2.30 80')], template: only }).missing.length, 0);
    assert.equal(facts({ items: [item('add pool')], template: only }).missing.length, 0);
    assert.equal(facts({ items: [item('widget pool add')], template: only }).missing.length, 0);
    assert.deepEqual(facts({ items: [item('address of the endpoint'), item('padding')], template: only }).missing, ['add']);
  });

  it('stays fast on the 3,000-node document', () => {
    const { items } = project(parseLarge().model, 'large');
    const start = performance.now();
    const out = facts({ items, template });
    assert.ok(performance.now() - start < 1000);
    assert.ok(out.categories.every((category) => category.evidence.length <= 50));
  });
});

describe('input checks', () => {
  it('refuses a template that fails admission (closed shape, origin, literal keywords), naming the problem', () => {
    const category = { id: 'x', label: 'x', contains: ['x'] };
    const cases: Array<[unknown, RegExp]> = [
      [undefined, /不是对象/],
      [null, /不是对象/],
      [{ ...template, schema: 'x@1' }, /schema/],
      [{ ...template, id: '' }, /id/],
      [{ ...template, origin: undefined }, /origin/],
      [{ ...template, origin: ' ' }, /origin/],
      [{ ...template, extra: 1 }, /extra/],
      [{ ...template, categories: [] }, /categories/],
      [{ ...template, categories: [{ ...category, id: 'Bad Id' }] }, /第 1 个类别id/],
      [{ ...template, categories: [category, category] }, /第 2 个类别id x 重复/],
      [{ ...template, categories: [{ ...category, pattern: 'a.*b' }] }, /pattern/],
      [{ ...template, categories: [{ ...category, tags: ['Boundary'] }] }, /tags/],
      [{ ...template, categories: [{ ...category, fields: ['nowhere'] }] }, /fields/],
      [{ ...template, categories: [{ ...category, fields: [] }] }, /fields/],
      [{ ...template, categories: [{ ...category, contains: 'x' }] }, /contains/],
      [{ ...template, categories: [{ ...category, contains: ['x', ' '] }] }, /contains/],
      [{ ...template, categories: [{ id: 'x', label: 'x' }] }, /判定条件/],
      [{ ...template, categories: [{ ...category, required: 'yes' }] }, /required/],
      [{ ...template, categories: [{ ...category, label: '' }] }, /label/],
    ];
    for (const [bad, problem] of cases) {
      const out = templateCoverage({ items: [], template: bad });
      assert.ok(isFailure(out), JSON.stringify(bad)?.slice(0, 60));
      assert.equal(out.error.code, 'case-review.template_invalid');
      assert.match(out.error.message, problem);
    }
  });

  it('ignores bad items and skips with warnings', () => {
    const out = facts({ items: [null, { id: 'x' }, ...reviewProjection().items], template, skipped: [{ category: 'nope', reason: 'x' }, { category: 'security', reason: '  ' }, 'x', { category: 'database', reason: '不涉及' }, { category: 'database', reason: '重复' }] });
    const codes = out.warnings.map((warning) => warning.code);
    assert.deepEqual(codes, ['case-review.item_ignored', 'case-review.skip_ignored', 'case-review.skip_ignored', 'case-review.skip_ignored', 'case-review.skip_ignored']);
    assert.match(out.warnings[4].message, /database 已经声明过跳过/);
    assert.deepEqual(out.skipped, [{ category: 'database', reason: '不涉及' }]);
  });

  it('never throws and is deterministic', () => {
    for (const input of [null, 1, 'x', {}, { items: 'x' }]) {
      const out = coverageDefault(input);
      assert.ok(isFailure(out));
      assert.equal(out.error.code, 'case-review.invalid_input');
    }
    const items = reviewProjection().items;
    assert.deepEqual(coverageDefault({ items, template }), coverageDefault({ items: structuredClone(items), template: structuredClone(template) }));
  });
});
