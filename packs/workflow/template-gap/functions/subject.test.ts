import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runCheck, type CheckOutcome } from '../../../../hub/rules/api.ts';
import { baseDocument, withoutCategory } from '../testing/mindmap.ts';
import { CONTEXT, bind, itemOf, projectionInput, table } from '../testing/support.ts';
import { projectDocuments } from './project.ts';
import subjectDefault, { coverageSubject } from './subject.ts';
import coverageCheck from './coverage-check.ts';
import type { DocumentItem } from './types.ts';

const COVERAGE = table('template-v3-coverage.json') as { required: { values: string[] } };
const CATEGORIES = (table('template-v3.json') as { categories: Array<{ id: string }> }).categories.map((category) => category.id);
const LOCATION = 'src:2215a5b7603f58061e7d3141e51ce96c6fb14b7b99792b9045b1984650ef9f75/kityminder@1/n/r0base000001';

/** ItemSubjectInput of the engine for a document item: the item with its reference location, no slots, no evidence. */
const builderInput = (item: Pick<DocumentItem, 'id' | 'label' | 'fields'>) => ({ applies: 'item', item: { id: item.id, label: item.label, location: LOCATION, fields: item.fields }, slots: null, evidence: [], context: CONTEXT });

async function judge(subject: unknown): Promise<CheckOutcome[]> {
  return runCheck({ id: 'coverage', interpreter: 'coverage@1' }, { table: COVERAGE, subject, context: { pack: 'template-gap', requirement: 'coverage', sets: {} } });
}

describe('coverageSubject', () => {
  it('lists the covered and the skipped categories of a document item; what must be covered is the table, not the item', () => {
    const item = itemOf(withoutCategory(baseDocument(), 'stress'), { external: 'agile:mindmap:900001' }, { skipped: [{ category: 'database', reason: '不涉及' }] });
    const subject = coverageSubject(builderInput(item));
    assert.deepEqual(subject, {
      item: '900001',
      location: LOCATION,
      document: '900001',
      covered: item.fields.categories.filter((c) => c.present).map((c) => c.id),
      skipped: [{ category: 'database', reason: '不涉及' }],
    });
    assert.ok(!subject.covered?.includes('stress'));
    assert.deepEqual(COVERAGE.required.values, CATEGORIES, 'the table names all 24 categories of the template, in its order');
  });

  it('feeds coverage@1: a gap of any category is a shortfall naming it, a gap with a reason is support, both about the item', async () => {
    for (const category of ['stress', 'audit_log', 'upgrade_new_to_old']) {
      const gap = itemOf(withoutCategory(baseDocument(), category), { external: 'agile:mindmap:900001' });
      const [shortfall] = await judge(coverageSubject(builderInput(gap)));
      assert.deepEqual([shortfall.verdict, shortfall.code, shortfall.tier, shortfall.item, shortfall.grounds], ['refute', 'core.coverage.shortfall', 'advisory', '900001', [LOCATION]], category);
      assert.deepEqual(shortfall.data?.missing, [category]);
      const skipped = itemOf(withoutCategory(baseDocument(), category), { external: 'agile:mindmap:900001' }, { skipped: [{ category, reason: '用户说这份脑图不涉及' }] });
      const [support] = await judge(coverageSubject(builderInput(skipped)));
      assert.equal(support.verdict, 'support', category);
      assert.deepEqual(support.data?.skipped, [{ member: category, reason: '用户说这份脑图不涉及' }]);
    }
  });

  it('agrees with the projection: the check misses exactly the categories the item lists as missing', async () => {
    let doc = baseDocument();
    const variants = [doc];
    for (const category of ['integration', 'audit_log', 'stress', 'negative', 'command_add', 'database', 'functional', 'configuration']) variants.push((doc = withoutCategory(doc, category)));
    for (const [n, variant] of variants.entries()) {
      for (const skipped of [[], [{ category: 'negative', reason: '不需要反向' }, { category: 'show_at_maximum', reason: '没有规格上限' }]]) {
        const item = itemOf(variant, { external: 'agile:mindmap:900001' }, { skipped });
        const bound = bind(variant, { external: 'agile:mindmap:900001' });
        const [outcome] = coverageCheck({ subject: { item: item.id, document: item.fields.document, location: LOCATION, case_rule: item.fields.case_rule, scope_complete: item.fields.scope_complete, skipped, source: { sha256: bound.sha256, model: bound.model } } });
        // 还有未分类用例时不判缺类别，检查是未知。分类完成才按 missing 支持或反驳。
        const want = item.fields.classification_status !== 'classified' || item.fields.scope_complete !== true ? 'unknown' : item.fields.missing.length === 0 ? 'support' : 'refute';
        assert.equal(outcome.verdict, want, `variant ${n}`);
        if (want === 'refute') assert.deepEqual(outcome.data?.missing, item.fields.missing, `variant ${n}`);
      }
    }
    // With every case below it gone, the tagged group node (priority 1, tag Function) is a case itself (case-review's rule,
    // README deviation 5), so only Functional is shown (along with the untagged candidate case which shows no category).
    const last = projectDocuments(projectionInput([bind(withoutCategory(doc, 'compatibility'))]));
    assert.ok(!('error' in last));
    // 剩下的节点没有 category_ids，整份未分类，missing 是空的，不把其余 23 类记成缺口。
    assert.deepEqual([last.items[0].fields.caseCount, last.items[0].fields.missing], [2, []]);
  });

  it('leaves the covered list absent when the item has no category list, so the check is unknown (missing input), not a judgment of nothing', async () => {
    for (const input of [null, {}, { item: null }, { item: { id: 'x', fields: {} } }, { item: { id: 'x', fields: { categories: 'x' } } }]) {
      const subject = subjectDefault(input) as { covered?: unknown };
      assert.equal(subject.covered, undefined, JSON.stringify(input));
      const [outcome] = await judge(subject);
      assert.deepEqual([outcome.verdict, outcome.reason], ['unknown', 'missing_input'], JSON.stringify(input));
    }
    const nothing = coverageSubject({ item: { id: 'x', fields: { categories: [{ id: 'functional', required: true, present: false }, 'junk', { id: 7, present: true }], skipped: [{ category: 1 }, 'x'] } } });
    assert.deepEqual([nothing.covered, nothing.skipped], [[], []]);
    const [refuted] = await judge(nothing);
    assert.deepEqual([refuted.verdict, refuted.data?.missing], ['refute', CATEGORIES], 'an empty covered list is judged: every category is missing');
  });

  it('has no totality guard: a failure throws, so the engine records a check error instead of judging a refusal object', () => {
    const hostile = { get item(): never { throw new Error('boom'); } };
    assert.throws(() => subjectDefault(hostile), /boom/);
  });
});
