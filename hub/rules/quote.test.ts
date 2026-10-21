// Verbatim quotation against the shared vectors (quote-vectors.json), which hub/refs runs too.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { quoteInterpreter } from './interpreters/quote.ts';
import { collapseWhitespace, quoteInCollapsed, quoteMatches } from './text.ts';

interface Vector {
  note: string;
  fragment: string;
  quote: string;
  match: boolean;
}
const vectors = (JSON.parse(readFileSync(new URL('./quote-vectors.json', import.meta.url), 'utf8')) as { vectors: Vector[] }).vectors;

describe('shared quotation vectors', () => {
  it('has vectors for both outcomes', () => {
    assert.ok(vectors.some((v) => v.match) && vectors.some((v) => !v.match));
  });

  for (const v of vectors) {
    it(`${v.match ? 'matches' : 'does not match'}: ${v.note}`, () => {
      assert.equal(quoteMatches(v.fragment, v.quote), v.match);
      assert.equal(quoteInCollapsed(collapseWhitespace(v.fragment), v.quote), v.match);
    });
  }

  it('quote@1 decides every vector the same way', () => {
    const reference = `src:${'c'.repeat(64)}/markdown@1/p/1`;
    const table = { schema: 'quote@1', origin: '测试', quotes: [{ select: '$.quotes[*]', text: '/text', reference: '/reference' }] };
    for (const v of vectors) {
      const [outcome] = quoteInterpreter.run({
        interpreter: 'quote@1',
        table,
        subject: { quotes: [{ text: v.quote, reference }] },
        sources: { text: (ref) => (ref === reference ? v.fragment : undefined) },
        context: {},
      });
      assert.equal(outcome.verdict, v.match ? 'support' : 'refute', v.note);
      if (!v.match) assert.equal(outcome.code, 'QUOTE_MISMATCH');
      assert.deepEqual(outcome.grounds, [reference]);
    }
  });

  it('an unbound or invalid reference is unknown, never a mismatch', () => {
    const table = { schema: 'quote@1', origin: '测试', quotes: [{ select: '$.quotes[*]', text: '/text', reference: '/reference' }] };
    const outcomes = quoteInterpreter.run({
      interpreter: 'quote@1',
      table,
      subject: { quotes: [{ text: 'x', reference: `src:${'d'.repeat(64)}` }, { text: 'x', reference: 'not a reference' }, { reference: `src:${'d'.repeat(64)}` }] },
      sources: { text: () => undefined },
      context: {},
    });
    assert.deepEqual(
      outcomes.map((o) => [o.verdict, o.reason]),
      [
        ['unknown', 'missing_input'],
        ['unknown', 'missing_input'],
        ['unknown', 'missing_input'],
      ],
    );
  });
});
