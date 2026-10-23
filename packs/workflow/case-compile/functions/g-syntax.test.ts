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
for (const [name, args, keywords, options, rule] of [
  [
    "zero arguments",
    [],
    {},
    {},
    "empty_cell"
  ],
  [
    "empty positional",
    [
      ""
    ],
    {},
    {},
    "positional_text"
  ],
  [
    "edge whitespace",
    [
      " a"
    ],
    {},
    {},
    "positional_text"
  ],
  [
    "CR",
    [
      "a\rb"
    ],
    {},
    {},
    "positional_text"
  ],
  [
    "mixed quotes requiring wrapping",
    [
      "a,b\"c'd"
    ],
    {},
    {},
    "mixed_quotes"
  ],
  [
    "quoted trailing slash",
    [
      "a,b\\"
    ],
    {},
    {},
    "quoted_backslash"
  ],
  [
    "equals positional",
    [
      "k=value"
    ],
    {},
    {},
    "positional_keyword"
  ],
  [
    "newline with another argument",
    [
      "a\nb",
      "c"
    ],
    {},
    {},
    "newline_single"
  ],
  [
    "folded newline",
    [
      "a\nb"
    ],
    {},
    {
      "foldNewlines": true
    },
    "newline_single"
  ],
  [
    "numeric text keyword",
    [],
    {
      "k": "007"
    },
    {},
    "keyword_numeric_text"
  ],
  [
    "unicode numeric text",
    [],
    {
      "k": "１２"
    },
    {},
    "keyword_numeric_text"
  ],
  [
    "negative keyword",
    [],
    {
      "k": -1
    },
    {},
    "keyword_integer"
  ],
  [
    "fraction keyword",
    [],
    {
      "k": 1.5
    },
    {},
    "keyword_integer"
  ],
  [
    "unknown keyword",
    [],
    {
      "k": "text"
    },
    {
      "keywordNames": []
    },
    "keyword_name"
  ],
  [
    "empty assertion",
    [
      ""
    ],
    {},
    {
      "literalAssertion": true
    },
    "assertion_literal"
  ]
] as const) test(`encoding refusal names the failing rule: ${name}`, () => assert.throws(() => encodeG({ args: [...args], keywords: { ...keywords } }, { keywordNames: Object.keys(keywords), ...options }), (e: unknown) => e instanceof GSyntaxError && e.rule === rule));
test('fixed-seed supported argument corpus roundtrips', () => {
  let seed = 173;
  const alphabet = 'abcXYZ09,=_- \\"';
  for (let i = 0; i < 500; i++) {
    let text = 'echo fixture '; for (let k = 0; k < 12; k++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; text += alphabet[seed % alphabet.length]; } text += 'z';
    round([text], { limit: i, label: `value${i}` });
  }
});

for(const [text,rule]of [['k='+ '9'.repeat(20),'integer_range'],['k=²','unicode_numeric']] as const)test(`decoding names ${rule}`,()=>assert.throws(()=>decodeG(text),(error:unknown)=>error instanceof GSyntaxError&&error.rule===rule));
test('keyword text and final roundtrip have exact refusal rules',()=>{for(const [value,rule]of [[{args:[],keywords:{k:' x'}},'keyword_text'],[{args:['a"b','c"d'],keywords:{}},'roundtrip']] as const)assert.throws(()=>encodeG({args:[...value.args],keywords:{...value.keywords}},{keywordNames:['k']}),(error:unknown)=>error instanceof GSyntaxError&&error.rule===rule);});
test('expanded deterministic corpus either roundtrips exactly or reports its codec rule',()=>{let seed=173;const alphabet=Array.from("abc09,=_- \\\"'\u3000\u0085\n");const known=new Set(['positional_text','positional_keyword','newline_single','mixed_quotes','quoted_backslash','keyword_text','keyword_numeric_text','roundtrip']);for(let i=0;i<500;i++){let value='';for(let n=0;n<12;n++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;value+=alphabet[seed%alphabet.length];}try{round([value],{label:i%2?'value'+i:value});}catch(error){assert.ok(error instanceof GSyntaxError);assert.ok(known.has(error.rule),error.rule);}}});
