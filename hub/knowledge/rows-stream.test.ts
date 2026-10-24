import assert from 'node:assert/strict';
import { test } from 'node:test';
import { visitRowsPart } from './rows-stream.ts';

test('streamed rows equal JSON.parse, including escaped delimiters, duplicate members and nested values', () => {
  const values: unknown[] = [null, true, 0, -0, 1e30, '合成😀\u0000 \\" } ] ,', [{ rows: ['nested'], data: { rows: 'ordinary data' } }], { '__proto__': 'ignored literal', text: '\\u0022' }];
  for (let i = 0; i < 100; i++)values.push({ i, data: values[i % 7], statement: '合成描述'.repeat(i), extra: [i % 3, null] });
  for (const text of [JSON.stringify({ rows: values }), ' { "rows" : [0], "rows" : ' + JSON.stringify(values) + ' } ', '{"rows":null,"rows":[{"x":1,"x":2,"data":{"__proto__":"own"}}]}']) {
    const actual: unknown[] = []; visitRowsPart(text, row => actual.push(row));
    assert.deepEqual(actual, JSON.parse(text).rows);
  }
});

test('the rows parser rejects malformed JSON and the strict outer part shape', () => {
  for (const text of ['', '[]', 'null', '{}', '{"rows":[]}', '{"rows":null}', '{"rows":1}', '{"rows":[1],"extra":0}', '{"rows":[1,]}', '{"rows":[1],}', '{"rows":[{"a":1,}]}', '{"rows":["bad\\x"]}', '{"rows":["line\nbreak"]}', '{"rows":[NaN]}', '{"rows":[01]}', '{"rows":[true false]}', '{"rows":[{}]} trailing', '{"rows":[[}]]}', '{"rows":[1],"rows":[1,]}']) {
    assert.throws(() => visitRowsPart(text, () => { }), SyntaxError, text);
  }
});

test('streaming preserves row order without a part-sized array and supports deeply nested unknown data', () => {
  const rows = Array.from({ length: 3000 }, (_, i) => ({ i, data: '合成内容'.repeat(100) })); let next = 0;
  visitRowsPart(JSON.stringify({ rows }), row => assert.deepEqual(row, rows[next++]));
  assert.equal(next, rows.length);
  const deep = '{"rows":[{"unknown":' + '['.repeat(5000) + '0' + ']'.repeat(5000) + '}]}';
  let seen = 0; visitRowsPart(deep, () => seen++); assert.equal(seen, 1);
});
