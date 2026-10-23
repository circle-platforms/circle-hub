import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
test('README lists both cross-package needs under the ownership section and all declared checks in the table', () => {
  const readme = readFileSync(new URL('./README.md', import.meta.url), 'utf8');
  const needs = readme.split('## 需要别的包做的事')[1].split('\n## ')[0];
  for (const word of ['packs/system/plm', 'settings.bug_fix_field', 'content.fix_field', 'packs/product/apv', '期望原文']) assert.ok(needs.includes(word), word);
  const checks = JSON.parse(readFileSync(new URL('./checks.json', import.meta.url), 'utf8'));
  for (const check of checks.checks) assert.ok(readme.includes('| `' + check.id + '` |'), check.id);
});
