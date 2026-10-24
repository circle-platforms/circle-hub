// The pack data the case index shares with other packs and the contracts: the case rule and the negative tags of the
// case-review workflow pack, the ids the agile system pack reads, the list limit of product@1, the vague phrases.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MAX_LIST_SOURCES } from '../../../../contracts/src/product.ts';
import { mindmapPlan, ROOTS_KEY } from '../../../system/agile-platform/functions/agile.ts';
import { normalizeTag } from '../../../workflow/case-review/functions/tags.ts';
import { AGILE_ID, CASE_RULE, CASE_TREE_ID, MINDMAP_PREFIX, negativeOf, tagKey } from './cases-rules.ts';
import { MAX_CASE_DOCUMENTS } from './cases-sync.ts';
import { randomText, seeded } from '../testing/test-support.ts';

describe('shared with other packs and the contracts', () => {
  it('the case rule is the case-review projection\'s default', async () => {
    const { LIMITS } = await import('../../../workflow/case-review/functions/project.ts');
    assert.ok(LIMITS.maxDepth === 200);
    const projected = (await import('../../../workflow/case-review/functions/project.ts')).projectItems({
      documents: [{ slot: 's', documentId: 'd1', model: { nodes: [{ text: '根', data: {}, children: [1] }, { text: '用例', data: { priority: CASE_RULE.casePriority }, children: [2] }, { text: '期望', data: {}, children: [] }] } }],
      parameters: { caseRule: 'marked' },
    });
    assert.ok(!('error' in projected) && projected.items.length === 1, 'priority 2 with children is the template case marker');
    assert.deepEqual(CASE_RULE, { casePriority: 2, groupPriority: 1, preconditionPriority: 3 });
  });

  it('negative tags: every spelling decides as the case-review pack decides', () => {
    const spellings = ['Negative', 'negative', '[Negative]', '[negative', '负向', '负面', '反向', '逆向', '异常', 'neg', 'NEG ', 'negative test', 'Negative-Case', '负向测试', '反向用例', ' 「负向」 ', 'Function', '功能', 'Stress', 'R2ADD', '', ' ', '\u0085', '﻿negative', 'negative　', 'nega tive', 'nonnegative', 'negativetesting', '异常测试用例'];
    const random = seeded(91);
    for (let k = 0; k < 2000; k++) spellings.push(random.pick(spellings) + randomText(random, 4));
    for (const tag of spellings) {
      const expected = normalizeTag(tag).canonical === 'negative';
      assert.equal(negativeOf([tag]) === true, expected, JSON.stringify(tag));
    }
    assert.equal(negativeOf([]), null);
    assert.equal(negativeOf([' ', '　']), null, 'blank tags are no tags');
    assert.equal(negativeOf(['Function']), null);
    assert.equal(negativeOf(['functional']), false);
    assert.equal(tagKey(' [Negative-Case] '), ' [Negative-Case] ');
  });

  it('document ids the agile system pack reads, and the list limit of product@1', () => {
    for (const key of ['950001', 'a-b_C9', 'bad id', '', 'x'.repeat(65), 'é', '9'.repeat(64)]) {
      const plan = mindmapPlan({ round: 1, external: { key }, settings: {} });
      assert.equal(AGILE_ID.test(key), plan.requests.length > 0, key);
    }
    assert.equal(MAX_CASE_DOCUMENTS, MAX_LIST_SOURCES);
    assert.equal(CASE_TREE_ID, `agile:tree:${ROOTS_KEY}`);
    assert.equal(MINDMAP_PREFIX, 'agile:mindmap:');
  });
});

// R3 semantic quality is covered by vague-retirement.test.ts and accepted review judgments.
