// The command coverage relations of architecture 6b, with explicit synthetic command assignments.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import TABLE from '../tables/template-v3.json' with { type: 'json' };
import { baseDocument, shuffled, withoutCategory, withCase, witnessCase, type DocumentSpec } from '../testing/mindmap.ts';
import { assignedCases, bindIndex, indexView, LOCK } from '../testing/index.ts';
import { bind, isFailure, projectionInput } from '../testing/support.ts';
import { projectDocuments } from './project.ts';
import { commandSubject } from './command-subject.ts';
import { commandOutcomes } from './command-check.ts';
const document = '900001';
function read(source: DocumentSpec, indexSource = source, reverse = false) {
  const records = assignedCases(indexSource, document);
  const view = indexView(records);
  if (reverse) { view.entries = Object.fromEntries(Object.entries(view.entries).reverse()); view.keys = Object.fromEntries(Object.entries(view.keys).map(([k, entries]) => [k, [...entries].reverse()])); }
  const out = projectDocuments({ ...projectionInput([bind(source, { external: `agile:mindmap:${document}` }), bindIndex(view)]), context: LOCK });
  assert.ok(!isFailure(out));
  const outcomes = commandOutcomes(commandSubject({ item: out.items[0], context: { ...LOCK, groups: out.groups } }));
  return { item: out.items[0]!, outcomes };
}
for (const category of TABLE.categories.filter(c => c.group === 'command')) test(`command metamorphism: remove and restore ${category.id}`, () => {
  const base = baseDocument(); const removed = withoutCategory(base, category.id);
  const gap = read(removed); assert.equal(gap.outcomes[0]!.code, 'template-gap.command_shortfall'); assert.deepEqual(gap.outcomes[0]!.data?.missing, [category.id]);
  const restored = read(withCase(removed, '其他', witnessCase(category.id, 1234)));
  assert.equal(restored.outcomes[0]!.verdict, 'support');
});
test('permuting cases and index entries leaves item and conclusion bytes unchanged', () => {
  const base = baseDocument(); const expected = read(base);
  for (let seed = 1; seed <= 5; seed++) {
    const source = shuffled(base, seed); const actual = read(source, source, true);
    const stable = (item: typeof actual.item) => {
      const copy = structuredClone(item);
      copy.fields.classifications.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      for (const row of copy.fields.classifications) delete (row as { visit?: number }).visit;
      assert.ok(copy.fields.case_resources);
      copy.fields.case_resources.sort((a, b) => a.case < b.case ? -1 : a.case > b.case ? 1 : 0);
      return JSON.stringify(copy);
    };
    // visit 和 resource 列表跟着文档顺序。类别、摘要和命令结论不跟着变。
    assert.equal(stable(actual.item), stable(expected.item));
    assert.equal(actual.item.summary, expected.item.summary);
    assert.equal(JSON.stringify(actual.outcomes), JSON.stringify(expected.outcomes));
  }
});
test('an extra case absent from the index cannot turn known command support into refutation', () => {
  const base = baseDocument(); const added = withCase(base, '其他', witnessCase('audit_log', 9876));
  const result = read(added, base);
  assert.equal(result.outcomes[0]!.verdict, 'support');
  assert.ok(!result.outcomes.some(o => o.verdict === 'refute'));
  const gap = result.outcomes.find(o => o.data?.scope === 'document')!;
  assert.equal(gap.verdict, 'unknown'); assert.equal(gap.data?.unmatched_cases_count, 1); assert.ok(gap.data?.next_action);
});
