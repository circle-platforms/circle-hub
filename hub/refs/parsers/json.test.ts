import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MAX_SELECTOR_LENGTH, ParseEncodingError, ParseLimitError, ParseSyntaxError, jsonParser } from '../api.ts';
import { assertLinearGrowth, describeGrowth } from '../../testing/growth.ts';
import { utf8 } from '../test-support.ts';

describe('json@1', () => {
  const document = jsonParser.parse(utf8('{"items":[{"id":1,"name":"甲"},{"id":2,"tags":["a b",null]}],"a/b":{"c:d":true},"":"empty key","__proto__":{"x":1}}'));

  it('locates values by member names and array indices', async () => {
    assert.equal((await document.locate('p/items/0/name'))!.text, '甲');
    assert.equal((await document.locate('p/items/1/tags/0'))!.text, 'a b');
    assert.equal((await document.locate('p/items/1/tags/1'))!.text, 'null');
    assert.equal((await document.locate('p/items/0/id'))!.text, '1');
    assert.equal((await document.locate('p/a%2Fb/c%3Ad'))!.text, 'true');
    assert.equal((await document.locate('p/items/0'))!.text, '{"id":1,"name":"甲"}');
    assert.deepEqual((await document.locate('p/items'))!.data, { type: 'array', size: 2 });
    assert.equal((await document.locate('p/__proto__/x'))!.text, '1');
    assert.equal((await document.locate('p'))!.selector, 'p');
  });

  it('refuses selectors that do not exist', async () => {
    for (const selector of ['p/items/2', 'p/items/01', 'p/items/-1', 'p/missing', 'p/items/0/name/x', 'q', 'p/constructor', 'p/toString']) {
      assert.equal((await document.locate(selector)), null, selector);
    }
  });

  it('lists every addressable value in document order', async () => {
    const selectors = document.listSelectors();
    assert.deepEqual(selectors.slice(0, 5), ['p', 'p/items', 'p/items/0', 'p/items/0/id', 'p/items/0/name']);
    assert.ok(!selectors.some((s) => s.endsWith('/')), 'the empty member name is not addressable');
    for (const selector of selectors) assert.ok((await document.locate(selector)), selector);
    assert.equal(document.listSelectors('p/items/1', { limit: 2 }).length, 2);
  });

  it('removes NUL from strings and refuses it in member names', () => {
    const cleaned = jsonParser.parse(utf8('["a\\u0000b", {"k": "\\u0000"}]'));
    assert.deepEqual(cleaned.model, ['ab', { k: '' }]);
    assert.equal(cleaned.summary().nulRemoved, 2);
    assert.throws(() => jsonParser.parse(utf8('{"a\\u0000": 1}')), ParseSyntaxError);
    assert.equal(jsonParser.parse(utf8('"x\\u0000"')).model, 'x');
  });

  it('reports syntax errors with a byte offset', () => {
    assert.throws(() => jsonParser.parse(utf8('{"名": 1,}')), (e: unknown) => e instanceof ParseSyntaxError && e.offset !== null && e.offset > 0);
    assert.throws(() => jsonParser.parse(utf8('')), ParseSyntaxError);
    assert.throws(() => jsonParser.parse(new Uint8Array([0x22, 0xe4, 0xb8, 0x22])), ParseEncodingError);
  });

  it('enforces depth and value limits', () => {
    assert.throws(() => jsonParser.parse(utf8('['.repeat(200) + ']'.repeat(200))), (e: unknown) => e instanceof ParseLimitError && e.limit === 'maxDepth');
    assert.throws(() => jsonParser.parse(utf8(JSON.stringify(Array.from({ length: 100 }, (_, i) => i))), { maxNodes: 50 }), (e: unknown) => e instanceof ParseLimitError && e.limit === 'maxNodes');
    assert.equal(jsonParser.parse(utf8('['.repeat(100) + ']'.repeat(100))).summary().depth, 100);
  });
});

describe('json@1 text that can be stored, and selectors that can be cited', () => {
  it('replaces unpaired surrogates in values and counts them, and refuses them in member names', () => {
    const document = jsonParser.parse(utf8('{"a":"case \\ud83d","b":["\\udc00x","ok \\ud83d\\ude00"]}'));
    assert.deepEqual(document.model, { a: 'case �', b: ['�x', 'ok 😀'] });
    assert.equal(document.summary().surrogatesReplaced, 2);
    assert.ok(JSON.stringify(document.model) === JSON.stringify(document.model).toWellFormed());
    assert.throws(() => jsonParser.parse(utf8('{"k\\udc00":"v"}')), ParseEncodingError);
  });

  // Whether the work stays linear is checked by growth ratios (hub/testing/growth.ts), which do not depend on how fast or
  // busy the runner is; what each case must produce is asserted on the full-size input, untimed. A hang is caught by the
  // test's timeout.
  it('hides values whose selector would be too long, and stays linear for long names over many values', { timeout: 60_000 }, async (t) => {
    const nested = (keys: number, pad: number): Uint8Array => {
      let value: unknown = Object.fromEntries(Array.from({ length: keys }, (_, i) => [`k${i}`, i]));
      for (let d = 0; d < 30; d++) value = { [`m${d}${'q'.repeat(pad)}`]: value };
      return utf8(JSON.stringify(value));
    };
    const bytes = nested(4_000, 400);
    const selectors = jsonParser.parse(bytes).listSelectors();
    assert.equal(selectors.length, 11, 'p and the ten levels that fit');
    assert.ok(selectors.every((selector) => selector.length <= MAX_SELECTOR_LENGTH));
    const document = jsonParser.parse(bytes);
    assert.equal((await document.locate(selectors[10]))!.selector, selectors[10]);
    const deeper = `${selectors[10]}/m19${'q'.repeat(400)}`;
    assert.ok(deeper.length > MAX_SELECTOR_LENGTH && deeper.length < 8192);
    assert.equal((await document.locate(deeper)), null, 'one level further the selector would be too long to cite');
    // Values and name lengths grow together (400-character names at the large size), so building a path for each value
    // would grow quadratically.
    const growth = assertLinearGrowth('long names over many values', (size) => nested(size, size / 500), (input) => jsonParser.parse(input).listSelectors(), { small: 25_000 });
    t.diagnostic(describeGrowth('long names over many values', growth));
  });

  it('refuses names just under the budget repeated over many values', { timeout: 60_000 }, (t) => {
    const nested = (values: number, pad: number): Uint8Array => {
      let value: unknown = Array.from({ length: values }, () => 0);
      for (let d = 0; d < 9; d++) value = { [`m${d}${'q'.repeat(pad)}`]: value };
      return utf8(JSON.stringify(value));
    };
    assert.throws(() => jsonParser.parse(nested(30_000, 440)), (e: unknown) => e instanceof ParseLimitError && e.limit === 'maxSelectorChars');
    // Values and name lengths grow together (440-character names at the large size), so building a path for each value
    // would grow quadratically.
    // A refusal is cheap even at the full size: forty parses per timed run lift it above the noise floor. The small
    // size is parsed, the large one refused.
    const refuse = (input: Uint8Array): void => {
      for (let i = 0; i < 40; i++) {
        try {
          jsonParser.parse(input);
        } catch {
          // The refusal is asserted above, on the full-size input.
        }
      }
    };
    const growth = assertLinearGrowth('refused selector text', (size) => nested(size, Math.round((size * 440) / 30_000)), refuse, { small: 3_750 });
    t.diagnostic(describeGrowth('refused selector text', growth));
  });

  it('lists under a prefix without walking the rest of the document', { timeout: 60_000 }, (t) => {
    const document = (values: number) => jsonParser.parse(utf8(JSON.stringify({ a: Array.from({ length: values }, (_, i) => i), b: { c: [1, 2] } })));
    assert.deepEqual(document(300_000).listSelectors('p/b'), ['p/b', 'p/b/c', 'p/b/c/0', 'p/b/c/1']);
    // The cost of a prefix listing must not grow with the rest of the document: eight times the values may cost at most
    // twice as much. Listing under the prefix is so cheap that it stays under the noise floor, where the ratio is not
    // judged; walking the rest of the document would lift it above the floor with the ratio of the sizes.
    const list = (doc: ReturnType<typeof document>): void => {
      for (let i = 0; i < 200; i++) doc.listSelectors('p/b');
    };
    const growth = assertLinearGrowth('prefix listing', document, list, { small: 37_500, maxRatio: 2 });
    t.diagnostic(describeGrowth('prefix listing', growth));
  });
});
