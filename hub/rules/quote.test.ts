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

  it('case differences and the empty quote are not matches (the mutation-check survivors M12 and M17)', () => {
    // Written out besides the vectors so a mutation that drops the vectors' meaning fails here too.
    assert.equal(quoteMatches('设置 3 区浇灌 15 分钟', '设置 3 区浇灌 15 分钟'), true);
    assert.equal(quoteMatches('Show Version', 'show version'), false, 'case stays significant (M12)');
    assert.equal(quoteMatches('Show Version', 'SHOW VERSION'), false, 'case stays significant in the fragment too (M12)');
    assert.equal(quoteInCollapsed(collapseWhitespace('Show Version'), 'show version'), false, 'M12 through the collapsed path the interpreter takes');
    assert.equal(quoteMatches('abc', ''), false, 'an empty quote never matches (M17)');
    assert.equal(quoteMatches('', ''), false, 'an empty quote never matches an empty fragment (M17)');
    assert.equal(quoteInCollapsed(collapseWhitespace('abc'), ''), false, 'M17 through the collapsed path the interpreter takes');
    assert.equal(quoteInCollapsed(collapseWhitespace('abc'), ' \n\t'), false, 'a quote of white space only never matches (M17)');
  });

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
