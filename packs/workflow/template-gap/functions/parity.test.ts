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
const withoutRequired = ({ required: _required, ...rest }: Category) => rest;

describe('parity with case-review', () => {
  it('copies the categories of case-review template v3 unchanged except that every one is required', () => {
    assert.deepEqual(ourTemplate.categories.map(withoutRequired), theirTemplate.categories.map(withoutRequired));
    assert.ok(ourTemplate.categories.every((category) => category.required !== false), 'here: all 24 required');
    assert.deepEqual(
      theirTemplate.categories.filter((category) => category.required !== false).map((category) => category.id),
      theirTemplate.categories.filter((category) => category.group === 'test_type').map((category) => category.id),
      'case-review: the six test types only',
    );
  });

  for (const fixture of FIXTURES) {
    it(`${fixture}: the same cases, identities and evidence; each pack's own missing categories`, () => {
      const bytes = fixtureBytes(fixture);
      const theirs = projectItems({ documents: [{ slot: 'documents', documentId: '880001', model: parse(bytes).model }] });
      assert.ok(!('error' in theirs), JSON.stringify(theirs).slice(0, 300));
      const coverage = templateCoverage({ items: theirs.items, template: theirTemplate });
      assert.ok(!('error' in coverage));
      const [mine] = project([bind(bytes, { external: 'agile:mindmap:880001' })]).items;
      assert.equal(mine.fields.caseCount, theirs.items.length);
      for (const category of coverage.categories) {
        const own = mine.fields.categories.find((c) => c.id === category.id);
        assert.ok(own, category.id);
        assert.deepEqual([own.present, own.count], [category.present, category.count], category.id);
        // case-review keeps the first 50 in document order; this pack the first MAX_EVIDENCE by id, from all of them.
        if (category.count <= category.evidence.length) assert.deepEqual(own.evidence, [...category.evidence].sort().slice(0, MAX_EVIDENCE), category.id);
        else for (const id of own.evidence) assert.ok(theirs.items.some((item) => item.id === id), `${category.id}: ${id}`);
      }
      const absent = coverage.categories.filter((category) => !category.present).map((category) => category.id);
      assert.deepEqual(mine.fields.missing, absent, 'here every absent category is missing');
      assert.deepEqual(coverage.missing, absent.filter((id) => theirTemplate.categories.find((c) => c.id === id)?.group === 'test_type'), 'case-review: the absent test types');
    });
  }
});
