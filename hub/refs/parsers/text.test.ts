import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ParseEncodingError, ParseLimitError, textParser } from '../api.ts';
import { latin1, utf8 } from '../test-support.ts';

describe('text@1', () => {
  const text = '第一行\r\nsecond\rthird\n\nfifth\u0000!\n';
  const document = textParser.parse(utf8(text));

  it('splits on CRLF, CR and LF without an extra final line', () => {
    assert.deepEqual(document.model.lines, ['第一行', 'second', 'third', '', 'fifth!']);
    assert.equal(document.model.nulRemoved, 1);
    assert.deepEqual(document.listSelectors(), ['l/1', 'l/2', 'l/3', 'l/4', 'l/5']);
    assert.deepEqual(textParser.parse(utf8('')).model.lines, []);
    assert.deepEqual(textParser.parse(utf8('x')).model.lines, ['x']);
  });

  it('locates lines and line ranges with byte ranges on the original bytes', () => {
    const one = document.locate('l/1')!;
    assert.equal(one.text, '第一行');
    assert.deepEqual(one.byteRange, [0, 9]);
    const range = document.locate('l/2-3')!;
    assert.equal(range.text, 'second\nthird');
    const [from, to] = range.byteRange!;
    assert.equal(Buffer.from(utf8(text)).subarray(from, to).toString('utf8'), 'second\rthird');
    assert.equal(document.locate('l/5')!.text, 'fifth!');
  });

  it('refuses selectors outside the text or written loosely', () => {
    for (const selector of ['l/0', 'l/6', 'l/3-3', 'l/4-2', 'l/01', 'l/1-9', 'l', 'x/1', 'l/1/2']) assert.equal(document.locate(selector), null, selector);
  });

  it('decodes the declared charset', () => {
    assert.equal(textParser.parse(latin1('café'), { mediaType: 'text/plain; charset=iso-8859-1' }).model.lines[0], 'café');
    assert.throws(() => textParser.parse(latin1('café')), ParseEncodingError);
  });

  it('enforces its limits', () => {
    assert.throws(() => textParser.parse(utf8('a\n'.repeat(20)), { maxNodes: 10 }), (e: unknown) => e instanceof ParseLimitError && e.limit === 'maxNodes');
    assert.throws(() => textParser.parse(utf8('abc'), { maxBytes: 2 }), (e: unknown) => e instanceof ParseLimitError && e.limit === 'maxBytes');
  });
});
