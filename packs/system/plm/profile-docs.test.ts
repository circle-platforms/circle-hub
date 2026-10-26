import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
test('signed profile names both build key forms and README distinguishes the two possible originals', () => {
  const profile = JSON.parse(readFileSync(new URL('./system.json', import.meta.url), 'utf8'));
  assert.match(profile.description, /构建列表.*编号.*名字/);
  const readme = readFileSync(new URL('./README.md', import.meta.url), 'utf8');
  const row = readme.split('\n').find(line => line.startsWith('| `plm:builds:'))!;
  assert.match(row, /original.*build array.*product list/);
});
