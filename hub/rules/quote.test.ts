// Verbatim quotation against the shared vectors (quote-vectors.json), which hub/refs runs too.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { quoteInterpreter } from './interpreters/quote.ts';
import { collapseWhitespace, quoteMatches } from './text.ts';

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
    });
  }

  it('case differences and the empty quote are not matches (the mutation-check survivors M12 and M17)', () => {
    // Written out besides the vectors so a mutation that drops the vectors' meaning fails here too.
    assert.equal(quoteMatches('设置 3 区浇灌 15 分钟', '设置 3 区浇灌 15 分钟'), true);
    assert.equal(quoteMatches('Show Version', 'show version'), false, 'case stays significant (M12)');
    assert.equal(quoteMatches('Show Version', 'SHOW VERSION'), false, 'case stays significant in the fragment too (M12)');
    assert.equal(quoteMatches('abc', ''), false, 'an empty quote never matches (M17)');
    assert.equal(quoteMatches('', ''), false, 'an empty quote never matches an empty fragment (M17)');
    assert.equal(quoteMatches('abc', ' \n\t'), false, 'a quote of white space only never matches (M17)');
    assert.equal(quoteMatches('\u00a0\u3000', '\u00a0\u3000'), false, 'even an exact whitespace-only fragment is not a quotation (M17)');
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

  it('missing evidence stays unknown while malformed references are refuted', () => {
    const table = { schema: 'quote@1', origin: '测试', quotes: [{ select: '$.quotes[*]', text: '/text', reference: '/reference' }] };
    const outcomes = quoteInterpreter.run({
      interpreter: 'quote@1',
      table,
      subject: { quotes: [{ text: 'x', reference: `src:${'d'.repeat(64)}` }, { text: 'x', reference: 'not a reference' }, { reference: `src:${'d'.repeat(64)}` }] },
      sources: { text: () => undefined },
      context: {},
    });
    assert.deepEqual(
      outcomes.map((o) => [o.verdict, o.reason ?? o.code]),
      [
        ['unknown', 'missing_input'],
        ['refute', 'QUOTE_MISMATCH'],
        ['unknown', 'missing_input'],
      ],
    );
  });
});

it('quotation whitespace is exact while ordinary table normalization still collapses', () => {
  assert.equal(collapseWhitespace('中 \n A'), '中 A');
  for (const whitespace of ['\t', '\n', '\r\n', '\u00a0', '\u3000']) {
    assert.equal(quoteMatches(`中${whitespace}文`, `中${whitespace}文`), true, JSON.stringify(whitespace));
    assert.equal(quoteMatches(`中${whitespace}文`, '中文'), false, JSON.stringify(whitespace));
    assert.equal(quoteMatches(`中${whitespace}文`, '中 文'), false, JSON.stringify(whitespace));
  }
  assert.equal(quoteMatches('中 \n A', '中A'), false);
  assert.equal(quoteMatches('Ａ \n B', 'ＡB'), false);
  assert.equal(quoteMatches('set 10 0', 'set 100'), false);
  for (const quote of ['', ' ', '\t\r\n', '\u00a0\u3000']) assert.equal(quoteMatches(quote, quote), false, JSON.stringify(quote));
});

it('quotation matching has no runtime dependency on refs', async () => {
  const { default: ts } = await import('typescript');
  const source = readFileSync(new URL('./text.ts', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('text.ts', source, ts.ScriptTarget.Latest, true);
  for (const statement of ast.statements) if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text.includes('refs/')) assert.ok(statement.importClause?.isTypeOnly, 'rules may import only refs types');
});

it('documents the strict quotation contract in both package READMEs', () => {
  const refs = readFileSync(new URL('../refs/README.md', import.meta.url), 'utf8');
  const rules = readFileSync(new URL('./README.md', import.meta.url), 'utf8');
  assert.match(refs, /exact contiguous substring/);
  assert.match(rules, /exact contiguous substring/);
});

it('checks a shared MiB fragment across many quotations', () => {
  const fragment = 'alpha beta\n'.repeat(Math.ceil((1 << 20) / 11)).slice(0, 1 << 20);
  const reference = `src:${'a'.repeat(64)}/text@1/l/1`;
  const subject = { quotes: Array.from({ length: 100 }, (_, i) => ({ text: `absent${i}`, reference })) };
  const table = { schema: 'quote@1', origin: 'synthetic', quotes: [{ select: '$.quotes[*]', text: '/text', reference: '/reference' }] };
  const started = performance.now();
  const outcomes = quoteInterpreter.run({ interpreter: 'quote@1', table, subject, sources: { text: () => fragment }, context: {} });
  const elapsed = performance.now() - started;
  assert.equal(outcomes.length, 100); assert.ok(outcomes.every(o => o.verdict === 'refute'));
  assert.ok(elapsed < 1000, `shared-fragment verification took ${elapsed}ms`);
});
