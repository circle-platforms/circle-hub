import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { keyEchoTest, redactSecret, sha256Hex } from './redact.ts';
import { KEY } from '../../../testing/synthetic.ts';

describe('redactSecret', () => {
  it('replaces a bearer credential, whatever its case and padding', () => {
    assert.equal(redactSecret('Authorization: Bearer abcdefgh12345 and more'), 'Authorization: Bearer [REDACTED] and more');
    assert.equal(redactSecret('bearer   ABCDEFGH.xyz-123_~+/=='), 'Bearer [REDACTED]');
    assert.equal(redactSecret('BEARER abcdefgh'), 'Bearer [REDACTED]');
  });

  it('leaves what is not a bearer credential', () => {
    for (const text of ['Bearer', 'Bearer short', 'a bearer of news', 'Bearerabcdefgh12345', '']) assert.equal(redactSecret(text), text);
  });

  it('replaces every occurrence of the given secrets, and ignores the ones it cannot use', () => {
    assert.equal(redactSecret(`k=${KEY}; again ${KEY}`, [KEY]), 'k=[REDACTED]; again [REDACTED]');
    assert.equal(redactSecret('four two three', ['four', 'three']), '[REDACTED] two [REDACTED]');
    assert.equal(redactSecret('abc abc', ['abc']), 'abc abc', 'a secret of 3 characters would redact ordinary text');
    assert.equal(redactSecret('one two', ['one']), 'one two');
    assert.equal(redactSecret('text', [undefined, '']), 'text');
    assert.equal(redactSecret('text with abcd', ['abcd']), 'text with [REDACTED]');
  });
});

describe('keyEchoTest', () => {
  const echoes = keyEchoTest(KEY);

  it('finds the key, a piece of 8 or more characters of it, and a run of 12 key characters', () => {
    assert.equal(echoes(`prefix ${KEY} suffix`), true);
    assert.equal(echoes(KEY), true);
    assert.equal(echoes(KEY.slice(3, 11)), true);
    assert.equal(echoes(`header: ${KEY.slice(5, 17)} tail`), true);
  });

  it('does not take ordinary text for an echo', () => {
    for (const text of ['', 'jev-latest', 'jev-1.14.0', 'jevkey_', KEY.slice(0, 7), 'x-SYNTHETIC-0-x', 'a key echo is not here', '{"error":"unauthorized"}']) assert.equal(echoes(text), false, text);
  });

  it('looks for nothing when the key is shorter than 8 characters', () => {
    const none = keyEchoTest('abcdefg');
    assert.equal(none('abcdefg abcdefg'), false);
  });
});

describe('sha256Hex', () => {
  it('is the SHA-256 of the bytes, in lower-case hexadecimal', () => {
    assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    assert.equal(sha256Hex(new TextEncoder().encode('abc')), sha256Hex('abc'));
    assert.equal(sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
});
