// Parity with the case-review pack, whose projection and template coverage this pack's functions were ported from: on the
// shared synthetic mind maps the same cases get the same identities, and every template category is shown by the same cases.
// One declared difference (README deviation 1): this pack requires every category of the template, case-review only the six
// test types. A test-only import of the other pack: if case-review changes what a case is or how the template matches, this
// test says that the two packs no longer agree.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { projectItems } from '../../case-review/functions/project.ts';
import { templateCoverage } from '../../case-review/functions/template-coverage.ts';
import { fixtureBytes, type MindmapFixture } from '../../../../tests/fixtures/mindmaps/index.ts';
import { bind, parse, project, table } from '../testing/support.ts';
import { MAX_EVIDENCE } from './template.ts';

const FIXTURES: MindmapFixture[] = ['review-150.km.json', 'review-150.double.json', 'template.km.json', 'tiny.km.json'];
type Category = { id: string; required?: boolean; group?: string };
const theirTemplate = JSON.parse(readFileSync(new URL('../../case-review/tables/template-v3.json', import.meta.url), 'utf8')) as { categories: Category[] };
const ourTemplate = table('template-v3.json') as { categories: Category[] };

describe('parity with case-review', () => {
  it('copies the categories of case-review template v3 unchanged except that every one is required', () => {
    assert.deepEqual(ourTemplate.categories, theirTemplate.categories);
    // 类别对象不再写 required。六个测试类型的必选范围在 template-v3-coverage.json，不在类别上。
    const theirCoverage = JSON.parse(readFileSync(new URL('../../case-review/tables/template-v3-coverage.json', import.meta.url), 'utf8')) as { required: { values: string[] } };
    assert.deepEqual(
      theirCoverage.required.values,
      theirTemplate.categories.filter((category) => category.group === 'test_type').map((category) => category.id),
      'case-review: the six test types only',
    );
  });

  for (const fixture of FIXTURES) {
    for (const rule of ['marked', 'tagged'] as const) {
      it(`${fixture} (case_rule: ${rule}): the same cases, identities and evidence; each pack's own missing categories`, () => {
        const bytes = fixtureBytes(fixture);
        const theirs = projectItems({ documents: [{ slot: 'documents', documentId: '880001', model: parse(bytes).model }], parameters: { caseRule: rule } });
        assert.ok(!('error' in theirs), JSON.stringify(theirs).slice(0, 300));
        const coverage = templateCoverage({ items: theirs.items, template: theirTemplate });
        assert.ok(!('error' in coverage));
        const [mine] = project([bind(bytes, { external: 'agile:mindmap:880001' })], { case_rule: rule }).items;
        assert.equal(mine.fields.caseCount, theirs.items.length);
        assert.equal(mine.fields.case_rule, rule);
        for (const category of coverage.categories) {
          const own = mine.fields.categories.find((c) => c.id === category.id);
          assert.ok(own, category.id);
          assert.deepEqual([own.present, own.count], [category.present, category.count], category.id);
          // case-review keeps the first 50 in document order; this pack the first MAX_EVIDENCE by id, from all of them.
          if (category.count <= category.evidence.length) assert.deepEqual(own.evidence, [...category.evidence].sort().slice(0, MAX_EVIDENCE), category.id);
          else for (const id of own.evidence) assert.ok(theirs.items.some((item) => item.id === id), `${category.id}: ${id}`);
        }
        // 未声明不算没有某类用例。两包在夹具未逐条声明类型时都不把未见类别写成缺失。
        assert.deepEqual(mine.fields.missing, [], 'template-gap withholds absent categories while cases are unclassified');
        assert.deepEqual(coverage.missing, [], 'case-review withholds absent test types while cases are unclassified');
      });
    }
  }
});
