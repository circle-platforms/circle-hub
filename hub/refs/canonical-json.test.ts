import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { canonicalJson, recordDigest } from './api.ts';
import { sha256 } from './test-support.ts';

describe('canonical JSON (RFC 8785)', () => {
  it('sorts members by UTF-16 code units and drops white space', () => {
    assert.equal(canonicalJson({ b: 1, a: [true, null, 'x'], '€': 0, '\r': 1, '1': 2, 'ö': 3 }), '{"\\r":1,"1":2,"a":[true,null,"x"],"b":1,"ö":3,"€":0}');
  });

  it('serializes numbers the ECMAScript way', () => {
    assert.equal(canonicalJson([0, -0, 1e21, 1e-7, 0.1, 333333333.3333333, 4.5, -1.5e-7, 9007199254740991]), '[0,0,1e+21,1e-7,0.1,333333333.3333333,4.5,-1.5e-7,9007199254740991]');
    assert.throws(() => canonicalJson(Number.NaN), TypeError);
    assert.throws(() => canonicalJson(Number.POSITIVE_INFINITY), TypeError);
  });

  it('escapes strings like JSON.stringify', () => {
    assert.equal(canonicalJson('a"\\\u0001 中'), '"a\\"\\\\\\u0001 中"');
  });

  it('refuses what hub/records refuses: values that are not JSON data', () => {
    class Point {
      x = 1;
    }
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    let deep: unknown = 1;
    for (let i = 0; i < 1001; i++) deep = [deep];
    // eslint-disable-next-line no-sparse-arrays
    const refused: Array<[string, unknown]> = [
      ['a hole in an array', [1, , 2]],
      ['undefined in an array', [undefined]],
      ['a Date', { at: new Date(0) }],
      ['a Map', new Map([[1, 2]])],
      ['a class instance', new Point()],
      ['a Buffer', Buffer.from('x')],
      ['a lone surrogate', 'a\ud800'],
      ['a lone surrogate in a member name', { '\udc00': 1 }],
      ['a cycle', cyclic],
      ['a bigint', 1n],
      ['a function', () => 1],
      ['a symbol', Symbol('s')],
      ['undefined', undefined],
      ['nesting deeper than 1000 levels', deep],
    ];
    for (const [name, value] of refused) assert.throws(() => canonicalJson(value), TypeError, name);
  });

  it('serializes what hub/records serializes', () => {
    assert.equal(canonicalJson({ a: undefined, b: [null, {}], c: Object.create(null) }), '{"b":[null,{}],"c":{}}');
    let deep: unknown = 1;
    for (let i = 0; i < 1000; i++) deep = [deep];
    assert.equal(canonicalJson(deep).length, 2001, '1000 levels are allowed');
    const shared = { x: 1 };
    assert.equal(canonicalJson([shared, shared]), '[{"x":1},{"x":1}]', 'a repeated object is not a cycle');
  });

  it('digests a record from kind, schema, provenance, created_at and body only', () => {
    const record = { kind: 'claim', schema: 'claim@1', provenance: 'observed', created_at: '2026-10-21T08:00:00.000Z', body: { b: 2, a: 1 } };
    const expected = sha256('{"body":{"a":1,"b":2},"created_at":"2026-10-21T08:00:00.000Z","kind":"claim","provenance":"observed","schema":"claim@1"}');
    assert.equal(recordDigest(record), expected);
    assert.equal(recordDigest({ ...record, id: 'rcd_x', digest: 'y' } as typeof record), expected);
  });
});
