// A held answer is read without what the scanner matched, or not at all: the copy is clean by the scan that holds the original.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { maskedJson } from './mask.ts';
import { scanForCredentials } from './scan.ts';

const secret = ['Lab-', 'Account-', 'Default-42'].join('');
const assignment = ['pass', 'word=', secret].join('');
const json = (value: unknown): Uint8Array => Buffer.from(JSON.stringify(value));
const text = (bytes: Uint8Array | null): string => Buffer.from(bytes!).toString('utf8');

test('the matched value leaves every string it is in, and all else stays', () => {
  const bytes = json({ id: 7, title: '登录失败', steps: `账号 ${assignment} 登录失败`, notes: [{ text: `再试 ${assignment}` }], other: null });
  assert.ok(scanForCredentials(bytes).findings.length > 0);
  const masked = maskedJson(bytes);
  assert.notEqual(masked, null);
  assert.equal(scanForCredentials(masked!).findings.length, 0);
  assert.equal(text(masked).includes(secret), false);
  const value = JSON.parse(text(masked));
  assert.deepEqual([value.id, value.title, value.other], [7, '登录失败', null]);
  assert.match(value.steps, /^账号 .*\[已隐去\].* 登录失败$/);
  assert.match(value.notes[0].text, /\[已隐去\]/);
});

test('bytes with nothing to take out come back as they are', () => {
  const bytes = json({ steps: '没有什么可隐去的' });
  assert.equal(maskedJson(bytes), bytes);
});

test('what cannot be shown clean stays held: no JSON, and a hit no string holds as text', () => {
  assert.equal(maskedJson(Buffer.from(`账号 ${assignment}`)), null, 'not JSON');
  const encoded = Buffer.from(`账号 ${assignment} 登录失败，这段文字长到足够被当作编码内容读出来`).toString('base64');
  const bytes = json({ steps: encoded });
  if (scanForCredentials(bytes).findings.length > 0) assert.equal(maskedJson(bytes), null, 'a value inside an encoding cannot be taken out');
  assert.equal(maskedJson(json({ [assignment]: 1 })), null, 'nor one in a member name');
});
