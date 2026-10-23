import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeG, decodeG, GSyntaxError } from './g-syntax.ts';
const round = (args: string[], keywords: Record<string, string | number> = {}, options = {}) => {
  const expected = { args, keywords }; const cell = encodeG(expected, { keywordNames: Object.keys(keywords), ...options });
  const back = decodeG(cell, options); assert.deepEqual(back.args, args); assert.deepEqual({ ...back.keywords }, keywords); return cell;
};
test('empty cells, empty fragments, keyword overwrite and positional digits follow runner behavior', () => {
  assert.deepEqual(decodeG(null).args, ['None']); assert.deepEqual(decodeG('').args, ['None']);
  assert.deepEqual(decodeG('a,, ,b,').args, ['a', 'b']);
  const v = decodeG('007,k=001,k=2'); assert.deepEqual(v.args, ['007']); assert.deepEqual({ ...v.keywords }, { k: 2 });
  assert.equal(decodeG('k=１２').keywords.k, 12); assert.equal(decodeG('k=١٢').keywords.k, 12);
});
test('paired, unpaired, nested opposite quotes and backslashes remain literal', () => {
  assert.deepEqual(decodeG('"a,b",c').args, ['a,b', 'c']); assert.deepEqual(decodeG('"a,b').args, ['"a', 'b']);
  assert.deepEqual(decodeG('"a\\"b",c').args, ['a\\"b', 'c']);
  for (const v of ['a,b', '"quoted"', "'quoted'", 'a\\b', 'a"b', 'a=b c=ok', 'echo a=b', 'x"y\'z']) {
    if (v === 'a=b c=ok') assert.throws(() => round([v])); else round([v]);
  }
});
test('Python whitespace stripping includes full-width spaces but excludes BOM', () => {
  assert.deepEqual(decodeG('\u3000 a \u3000,\u0085b\u001c').args, ['a', 'b']); round(['\ufeffx']);
});
test('keywords recognize equals after outer quote removal and preserve strings versus integers', () => {
  assert.deepEqual({ ...decodeG('"k=value",a b=c,empty=').keywords }, { k: 'value', empty: '' });
  assert.deepEqual(decodeG('a b=c').args, ['a b=c']);
  round(['007'], { count: 7, label: 'x=ok', comma: 'a,b', empty: '' });
});
test('newline passthrough and explicitly folded methods are different behaviors', () => {
  const v = '\"a,b\"\n k=2'; round([v]);
  assert.deepEqual(decodeG(' a\n,b\r\n', { foldNewlines: true }).args, ['a', 'b']);
  assert.deepEqual(decodeG('a\nk=2').args, ['a\nk=2']); round(['k=2\nnext']);
});
test('literal assertions are unsplit and waiting accepts one ASCII duration', () => {
  round(['a,b\n"c"'], {}, { literalAssertion: true });
  round(['001'], {}, { wait: true }); assert.throws(() => round(['-1'], {}, { wait: true }));
});
for (const [name, args, keywords, options] of [
  ['zero arguments', [], {}, {}], ['empty positional', [''], {}, {}], ['edge whitespace', [' a'], {}, {}], ['CR', ['a\rb'], {}, {}],
  ['mixed quotes requiring wrapping', ['a,b"c\'d'], {}, {}], ['quoted trailing slash', ['a,b\\'], {}, {}], ['equals positional', ['k=value'], {}, {}],
  ['newline with another argument', ['a\nb', 'c'], {}, {}], ['folded newline', ['a\nb'], {}, { foldNewlines: true }],
  ['numeric text keyword', [], { k: '007' }, {}], ['unicode numeric text', [], { k: '１２' }, {}], ['negative keyword', [], { k: -1 }, {}], ['fraction keyword', [], { k: 1.5 }, {}],
  ['unknown keyword', [], { k: 'text' }, { keywordNames: [] }], ['empty assertion', [''], {}, { literalAssertion: true }],
] as const) test(`encoding refusal names the failing rule: ${name}`, () => assert.throws(() => encodeG({ args: [...args], keywords: { ...keywords } }, { keywordNames: Object.keys(keywords), ...options }), (e: unknown) => e instanceof GSyntaxError && e.rule.length > 0));
test('fixed-seed supported argument corpus roundtrips', () => {
  let seed = 173;
  const alphabet = 'abcXYZ09,=_- \\"';
  for (let i = 0; i < 500; i++) {
    let text = 'echo fixture '; for (let k = 0; k < 12; k++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; text += alphabet[seed % alphabet.length]; } text += 'z';
    round([text], { limit: i, label: `value${i}` });
  }
});
