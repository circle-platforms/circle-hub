import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { caseEvidenceVerifier, caseQuoteMatches } from './category-evidence.ts';
import type { DocumentCases } from './cases.ts';

// A pre-order node table in the shape returned by casesOf: two sibling cases and a nested case.
const document: Pick<DocumentCases, 'cases' | 'nodes'> = {
  nodes: {
    texts: ['共同原文', '第一例', '共同原文', '逐字结果', '嵌套例', '共同原文', '第二例', '共同原文'],
    parents: Int32Array.from([-1, 0, 1, 2, 1, 4, 0, 6]),
  },
  cases: [[1, 'd:first'], [4, 'd:nested'], [6, 'd:second']].map(([visit, id]) => ({
    id: String(id), nodeId: String(id), visit: Number(visit), title: '', tags: [], steps: [], expected: [], preconditions: [],
  })),
};

describe('case-local category evidence', () => {
  it('accepts an exact quotation at the case, its step or its result', () => {
    for (const [visit, quote] of [[1, '第一例'], [2, '共同原文'], [3, '逐字结果']] as const) {
      assert.equal(caseQuoteMatches(document, 'd:first', visit, quote), true);
    }
  });

  it('rejects identical text at an ancestor, sibling case or nested case', () => {
    for (const visit of [0, 5, 7]) assert.equal(caseQuoteMatches(document, 'd:first', visit, '共同原文'), false);
    assert.equal(caseQuoteMatches(document, 'd:first', 4, '嵌套例'), false);
    assert.equal(caseQuoteMatches(document, 'd:nested', 5, '共同原文'), true);
    assert.equal(caseQuoteMatches(document, 'd:second', 7, '共同原文'), true);
  });

  it('rejects missing cases, unresolved nodes, empty quotations and absent text', () => {
    assert.equal(caseQuoteMatches(document, 'd:missing', 2, '共同原文'), false);
    for (const visit of [-1, 8, 1.5, NaN, Infinity]) assert.equal(caseQuoteMatches(document, 'd:first', visit, '共同原文'), false);
    assert.equal(caseQuoteMatches(document, 'd:first', 2, ''), false);
    assert.equal(caseQuoteMatches(document, 'd:first', 2, '不存在的原文'), false);
  });

  it('verifies contiguous raw quotations without case, Unicode or whitespace normalization', () => {
    const changed = { ...document, nodes: { ...document.nodes, texts: document.nodes.texts.with(2, 'Exact Ａ  text\n结果') } };
    assert.equal(caseQuoteMatches(changed, 'd:first', 2, 'Ａ  text\n结果'), true);
    for (const quote of ['exact', 'A  text', 'Ａ text', 'text 结果']) assert.equal(caseQuoteMatches(changed, 'd:first', 2, quote), false);
  });

  it('uses the nearest case boundary independent of the order of case records', () => {
    const reordered = { ...document, cases: [...document.cases].reverse() };
    for (let visit = 0; visit < document.nodes.texts.length; visit++) {
      assert.equal(caseQuoteMatches(reordered, 'd:first', visit, document.nodes.texts[visit]), caseQuoteMatches(document, 'd:first', visit, document.nodes.texts[visit]));
    }
  });

  it('rejects malformed parent graphs rather than borrowing an unrelated case', () => {
    for (const parents of [Int32Array.from([-1]), Int32Array.from([-1, 1, 1, 2, 1, 4, 0, 6]), Int32Array.from([-1, 0, -2, 2, 1, 4, 0, 6]), Int32Array.from([-1, -1, 1, 2, 1, 4, 0, 6])]) {
      const verify = caseEvidenceVerifier({ ...document, nodes: { ...document.nodes, parents } });
      assert.equal(verify('d:first', 2, '共同原文'), false);
    }
  });
});
