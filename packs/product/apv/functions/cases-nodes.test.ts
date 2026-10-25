// The case nodes of test mind maps: the corpus truth of tests/fixtures/case-index (built while the documents were built),
// parity with the case-review workflow pack's projection under its marked rule (the tagged rule or the marked one), and
// hostile models.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { kityminderParser } from '../../../../hub/refs/api.ts';
import { caseCorpus, documentBytes } from '../../../../tests/fixtures/case-index/index.ts';
import { fixtureBytes as mindmapBytes, largeDocument, compactText } from '../../../../tests/fixtures/mindmaps/index.ts';
import { projectItems } from '../../../workflow/case-review/functions/project.ts';
import { caseNodes } from './cases-nodes.ts';
import {tagDeclaration} from './cases-rules.ts';
import { negativeOf } from './cases-rules.ts';
import { assertTotal, hostileInputs } from '../testing/test-support.ts';

const corpus = caseCorpus();
const parse = (bytes: Uint8Array) => kityminderParser.parse(bytes).model;

describe('case nodes against the corpus truth', () => {
  it('finds exactly the cases the corpus put into every document, with their contents', () => {
    let checked = 0;
    for (const doc of corpus.truth) {
      const scan = caseNodes(parse(documentBytes(corpus.documents[doc.id])));
      assert.equal(scan.malformed, 0);
      assert.deepEqual(
        scan.cases.map((c) => ({
          selector: c.selector,
          title: c.title,
          path: c.path,
          priority: c.priority,
          tags: c.tags,
          expected: c.expectedCount,
          has: c.hasExpected,
          vague: undefined,
          steps: c.steps,
          autoid: c.autoid,
          negative: negativeOf(c.tags),
        })),
        doc.cases.map((t) => ({
          selector: t.selector,
          title: t.title,
          path: t.path_labels,
          priority: t.priority,
          tags: t.tags,
          expected: t.expected_count,
          has: t.has_expected,
          vague: undefined,
          steps: t.steps_count,
          autoid: t.autoid,
          negative: tagDeclaration(t.tags).negative,
        })),
        doc.id,
      );
      checked += doc.cases.length;
    }
    assert.ok(checked > 4000, `${checked} cases checked`);
  });

  it('marks the selector the parser gives: by id when the id is unique, by position otherwise', () => {
    const doc = corpus.truth.find((d) => d.cases.some((c) => c.selector.startsWith('i/')));
    assert.ok(doc);
    const parsed = parse(documentBytes(corpus.documents[doc.id]));
    for (const found of caseNodes(parsed).cases) assert.equal(found.selector, parsed.nodes[found.index].selector);
  });
});

describe('parity with the case-review projection (caseRule marked)', () => {
  const compare = (documentId: string, model: unknown): number => {
    const projected = projectItems({ documents: [{ slot: 'subject', documentId, model }], parameters: { caseRule: 'marked' }, limits: { outputBytes: Number.POSITIVE_INFINITY } });
    if ('error' in projected) {
      assert.equal(projected.error.code, 'case-review.no_case');
      assert.deepEqual(caseNodes(model).cases, []);
      return 0;
    }
    const mine = caseNodes(model).cases;
    assert.deepEqual(
      mine.map((c) => [c.selector, c.title, c.path, c.priority, c.tags, c.expectedCount, c.steps, c.autoid, negativeOf(c.tags)]),
      projected.items.map((item) => [item.location.selector, item.fields.title, item.fields.path, item.fields.priority, item.fields.tags, item.fields.expectedCount, item.fields.steps.length, item.fields.autoid, item.fields.negative]),
      documentId,
    );
    return mine.length;
  };

  it('on the review, template, untagged and outline maps', () => {
    let total = 0;
    for (const name of ['review-150.km.json', 'template.km.json', 'untagged.km.json', 'outline.km.json', 'tiny.km.json'] as const) total += compare(name.replace(/\W/g, ''), parse(mindmapBytes(name)));
    assert.ok(total > 70);
  });

  it('on the 3,000-node document and on every corpus document', () => {
    assert.ok(compare('large', parse(new TextEncoder().encode(compactText(largeDocument())))) > 500);
    for (const doc of corpus.truth) compare(doc.id, parse(documentBytes(corpus.documents[doc.id])));
  });
});

describe('case nodes on bad input', () => {
  it('is total and finds nothing in what is no mind map', () => {
    for (const [k, input] of hostileInputs().entries()) {
      const out = assertTotal((value) => caseNodes(value), input, `hostile ${k}`) as ReturnType<typeof caseNodes>;
      assert.ok(Array.isArray(out.cases));
    }
  });

  it('survives cycles, shared children, invalid indices and deep trees, and counts them', () => {
    const node = (id: string, text: string, data: Record<string, unknown>, children: number[], selector = `n/${id}`) => ({ id, text, data: { id, text, ...data }, children, parent: null, depth: 0, selector, extra: null });
    const model = {
      nodes: [
        node('r', '根', {}, [1, 2, 2, 99, -1, 'x' as unknown as number]),
        node('g', '分组', { priority: 1 }, [3, 0]),
        node('c', '用例', { priority: 2, resource: ['Function'] }, [4]),
        node('e', '期望', {}, []),
        node('x', '设备正常', {}, [1]),
      ],
    };
    const out = caseNodes(model);
    assert.ok(out.malformed >= 4);
    assert.deepEqual(out.cases.map((c) => c.title), ['用例']);
    const deep: Array<ReturnType<typeof node>> = [];
    for (let k = 0; k < 400; k++) deep.push(node(`n${k}`, `层 ${k}`, k === 300 ? { priority: 2, resource: ['Function'] } : {}, k < 399 ? [k + 1] : []));
    const far = caseNodes({ nodes: deep });
    assert.equal(far.cases.length, 0, 'a case below the depth limit is not read');
    assert.ok(far.deep > 0);
  });
});
