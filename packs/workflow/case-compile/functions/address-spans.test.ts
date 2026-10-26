// R5 mechanical operation only: no text token is an address unless a verified typed binding selected its span.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { replacedQuote } from './addresses.ts';
const replacements = [{ case: '192.0.2.1', bed: '192.0.2.90' }];
const replace = replacedQuote as (text: string, mappings: typeof replacements, spans?: Array<{ start: number; end: number; literal: string }>) => string;
test('text with no declared address span is never rewritten from its appearance', () => {
  for (const text of ['192.0.2.1', 'version 192.0.2.1', '0.1 2130706433 10.6.1', 'expected literal 192.0.2.1']) assert.equal(replace(text, replacements), text);
});
test('only a declared exact span changes when the same literal appears twice', () => {
  const text = '192.0.2.1 | 192.0.2.1';
  assert.equal(replace(text, replacements, [{ start: 0, end: 9, literal: '192.0.2.1' }]), '192.0.2.90 | 192.0.2.1');
});
test('stale, overlapping or out-of-range structural spans are refused rather than rescanned', () => {
  for (const spans of [[{ start: 0, end: 9, literal: '192.0.2.2' }], [{ start: 0, end: 90, literal: '192.0.2.1' }], [{ start: 0, end: 9, literal: '192.0.2.1' }, { start: 0, end: 9, literal: '192.0.2.1' }]]) assert.throws(() => replace('192.0.2.1', replacements, spans));
});
test('a selected span must parse as a complete numeric address and cannot change families', () => {
  assert.throws(() => replace('release 10.6.1', replacements, [{ start: 8, end: 14, literal: '10.6.1' }]));
  assert.throws(() => replace('192.0.2.1', [{ case: '192.0.2.1', bed: '2001:db8::1' }], [{ start: 0, end: 9, literal: '192.0.2.1' }]));
});
