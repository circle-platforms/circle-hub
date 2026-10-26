import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { jsonParser, parseReference } from '../../../hub/refs/api.ts';
import { SYNTHETIC_BUG_74001 } from './testing/fixtures.ts';

const bytes = new TextEncoder().encode(JSON.stringify(SYNTHETIC_BUG_74001));
const sha = createHash('sha256').update(bytes).digest('hex');
function references(value: unknown): string[] {
  if (typeof value === 'string' && value.startsWith('src:')) return [value];
  if (Array.isArray(value)) return value.flatMap(references);
  if (value && typeof value === 'object') return Object.values(value).flatMap(references);
  return [];
}
test('PLM fixture uses plain fields and an html_fields name list', () => {
  assert.ok(Array.isArray(SYNTHETIC_BUG_74001.html_fields));
  const parsed = jsonParser.parse(bytes);
  assert.equal(parsed.locate('p/html_fields/fix'), null);
  assert.match(parsed.locate('p/fields/fix')!.text!, /健康检查间隔设置成功/);
});
test('concrete submission and SKILL references resolve into the synthetic PLM fix field', () => {
  const submission = JSON.parse(readFileSync(new URL('./examples/submit-result.json', import.meta.url), 'utf8'));
  const skill = readFileSync(new URL('./SKILL.md', import.meta.url), 'utf8');
  const block = /```json\n([\s\S]*?)\n```/.exec(skill)!;
  for (const ref of [...references(submission), ...references(JSON.parse(block[1]))]) {
    const parsed = parseReference(ref); assert.equal(parsed.scheme, 'src');
    if (parsed.scheme !== 'src') throw new Error('expected source');
    assert.equal(parsed.sha256, sha);
    assert.equal(parsed.parser, 'json@1'); assert.equal(parsed.selector, 'p/fields/fix');
    assert.ok(jsonParser.parse(bytes).locate(parsed.selector));
  }
});
