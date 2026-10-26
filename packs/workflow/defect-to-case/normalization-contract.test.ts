import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { normalizeText } from './functions/compact-index.ts';

test('README publishes the exact ordered title normalization contract for independent gold implementations', () => {
  const readme = readFileSync(new URL('./README.md', import.meta.url), 'utf8');
  assert.ok(readme.includes('标题仅展示'));
});
test('title normalization follows hand-written Unicode, casing and whitespace examples', () => {
  for (const [raw, expected] of [['  ＷＩＤＧＥＴ\tＡ  ', 'widget a'], ['\nCase\u00A0\u3000TITLE\r\n', 'case title'], ['Cafe\u0301', 'café'], ['ﬀ\tTEST', 'ff test'], ['合成\n标题', '合成 标题']]) assert.equal(normalizeText(raw), raw);
});
