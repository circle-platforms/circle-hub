import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stripNul, textPreview } from './text.ts';

const NUL = String.fromCharCode(0);

test('stripNul removes every NUL and nothing else', () => {
  assert.equal(stripNul(`a${NUL}b${NUL}${NUL}c`), 'abc');
  assert.equal(stripNul('无 NUL 的文本'), '无 NUL 的文本');
  assert.equal(stripNul(''), '');
});

test('textPreview decodes UTF-8, strips NUL, never splits a character, and leaves the bytes alone', () => {
  const bytes = Buffer.concat([Buffer.from('命令'), Buffer.from([0]), Buffer.from('手册')]);
  const copy = Buffer.from(bytes);
  assert.deepEqual(textPreview(bytes), { text: '命令手册', truncated: false, nulStripped: 1 });
  assert.deepEqual(bytes, copy);
  // Cutting inside the third byte of a character drops that character instead of producing U+FFFD.
  assert.deepEqual(textPreview(bytes, 5), { text: '命', truncated: true, nulStripped: 0 });
  assert.deepEqual(textPreview(bytes, 6), { text: '命令', truncated: true, nulStripped: 0 });
  assert.deepEqual(textPreview(bytes, 7), { text: '命令', truncated: true, nulStripped: 1 });
  assert.deepEqual(textPreview(bytes, 0), { text: '', truncated: true, nulStripped: 0 });
  // Invalid UTF-8 inside the preview becomes U+FFFD.
  assert.equal(textPreview(Buffer.from([0x61, 0xff, 0x62])).text, `a${String.fromCharCode(0xfffd)}b`);
  assert.throws(() => textPreview(bytes, -1), TypeError);
});
