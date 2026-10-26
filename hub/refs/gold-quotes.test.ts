// Cross-boundary conformance only: the gold implementation never imports the Hub or a product/workflow pack.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { quoteMatches } from './api.ts';
import { checkVerbatimQuote } from '../../scripts/real/gold/compile-check.ts';

const REFERENCE = `src:${'a'.repeat(64)}/text@1/l/1`;
const shared = JSON.parse(readFileSync(new URL('../rules/quote-vectors.json', import.meta.url), 'utf8')) as { vectors: { note: string; fragment: string; quote: string; match: boolean }[] };
const additional = [
  { note: 'exact Chinese hard wrap', fragment: '超时\r\n时间', quote: '超时\r\n时间', match: true },
  { note: 'wide left and Latin right cannot delete newline', fragment: '中文\nvalue', quote: '中文value', match: false },
  { note: 'Latin left and wide right cannot delete tab', fragment: 'value\t中文', quote: 'value中文', match: false },
  { note: 'fullwidth letter cannot delete adjacent whitespace', fragment: 'Ａ \n B', quote: 'ＡB', match: false },
  { note: 'supplementary wide code point cannot delete adjacent newline', fragment: '𠀀\nA', quote: '𠀀A', match: false },
  { note: 'wide emoji cannot delete adjacent newline', fragment: '🙂\nA', quote: '🙂A', match: false },
  { note: 'Latin whitespace does not collapse', fragment: 'set\t10\r\n0', quote: 'set 10 0', match: false },
  { note: 'Latin boundary cannot disappear', fragment: 'set 10 0', quote: 'set 100', match: false },
  { note: 'Latin boundary cannot appear', fragment: 'set100', quote: 'set 100', match: false },
  { note: 'punctuation boundaries stay', fragment: 'a + b', quote: 'a+b', match: false },
  { note: 'ambiguous width stays narrow', fragment: 'α β', quote: 'αβ', match: false },
  { note: 'halfwidth stays narrow', fragment: 'ｱ A', quote: 'ｱA', match: false },
  { note: 'BOM format character can be literal quoted text', fragment: '中\ufeff文', quote: '\ufeff', match: true },
  { note: 'format characters are not whitespace', fragment: '中\ufeff文', quote: '中文', match: false },
  { note: 'NEL is not an ASCII space', fragment: 'a\u0085b', quote: 'a b', match: false },
  { note: 'exact NEL matches', fragment: 'a\u0085b', quote: 'a\u0085b', match: true },
  { note: 'half a surrogate is never a quote', fragment: '🙂', quote: '\ude42', match: false },
  { note: 'all whitespace is empty', fragment: 'anything', quote: '\u0085\u3000', match: false },
];
for (const vector of [...shared.vectors, ...additional]) {
  test(`independent gold agrees with Hub: ${vector.note}`, () => {
    const gold = checkVerbatimQuote(new Map([[REFERENCE, vector.fragment]]), REFERENCE, vector.quote);
    assert.equal(gold.verdict, vector.match ? 'pass' : 'fail');
    assert.equal(quoteMatches(vector.fragment, vector.quote), vector.match);
  });
}

test('independent gold and Hub agree on a deterministic synthetic Unicode corpus', () => {
  let seed = 71;
  for (let i = 0; i < 5000; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    let cp = seed % 0x110000; if (cp >= 0xd800 && cp <= 0xdfff) cp = 0x41;
    const char = String.fromCodePoint(cp);
    const fragment = i % 2 ? `A\n${char}B` : `A${char}\r\nB`;
    const sources = new Map([[REFERENCE, fragment]]);
    assert.equal(checkVerbatimQuote(sources, REFERENCE, fragment).verdict, 'pass', `exact U+${cp.toString(16)}`);
    assert.equal(quoteMatches(fragment, fragment), true, `exact U+${cp.toString(16)}`);
    const quote = `A${char}B`;
    assert.equal(checkVerbatimQuote(sources, REFERENCE, quote).verdict, 'fail', `deleted whitespace U+${cp.toString(16)}`);
    assert.equal(quoteMatches(fragment, quote), false, `deleted whitespace U+${cp.toString(16)}`);
  }
});

test('gold production dependency closure imports neither Hub nor pack modules', async () => {
  const { default: ts } = await import('typescript');
  const { dirname, resolve, sep, isAbsolute } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const pending = [resolve(root, 'scripts/real/gold/compile-check.ts')]; const seen = new Set<string>();
  while (pending.length) {
    const file = pending.pop()!; if (seen.has(file)) continue; seen.add(file);
    const ast = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const visit = (node: import('typescript').Node): void => {
      let specifier: string | undefined;
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) specifier = node.moduleSpecifier.text;
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === 'require')) {
        assert.ok(node.arguments[0] && ts.isStringLiteralLike(node.arguments[0]), 'gold module paths must be statically readable');
        specifier = (node.arguments[0] as import('typescript').StringLiteralLike).text;
      }
      if (specifier && (specifier.startsWith('.') || isAbsolute(specifier))) {
        const dependency = resolve(dirname(file), specifier);
        for (const forbidden of ['hub', 'packs']) assert.ok(!dependency.startsWith(resolve(root, forbidden) + sep), `forbidden dependency: ${specifier}`);
        pending.push(dependency);
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
  }
});
