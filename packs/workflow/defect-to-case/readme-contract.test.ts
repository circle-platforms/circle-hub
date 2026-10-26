import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
test('README lists both cross-package needs under the ownership section and all declared checks in the table', () => {
  const readme = readFileSync(new URL('./README.md', import.meta.url), 'utf8');
  const needs = readme.split('## 需要别的包做的事')[1].split('\n## ')[0];
  for (const word of ['packs/system/plm', 'settings.bug_fix_field', 'content.fix_field', 'packs/product/famx', '期望原文']) assert.ok(needs.includes(word), word);
  const checks = JSON.parse(readFileSync(new URL('./checks.json', import.meta.url), 'utf8'));
  for (const check of checks.checks) assert.ok(readme.includes('| `' + check.id + '` |'), check.id);
});

test('the dynamic dedup declaration documents engine reads and bounded recovery', () => {
  const readme = readFileSync(new URL('./README.md', import.meta.url), 'utf8');
  const skill = readFileSync(new URL('./SKILL.md', import.meta.url), 'utf8');
  const checks = JSON.parse(readFileSync(new URL('./checks.json', import.meta.url), 'utf8'));
  const check = checks.checks.find((entry: { id: string }) => entry.id === 'duplicate_check');
  assert.deepEqual(check.reads.narrow, { slot: 'indexed_cases', key_path: '/read_keys', into: '/indexed_cases', max_keys: 100, max_entries: 5000, rebind: true });
  for (const word of ['key_path', 'max_keys', 'max_entries', '读取清单', '同一修订']) assert.ok(readme.includes(word), word);
  assert.match(skill, /only=.*fields=commands,document,node,title,negative,case_structure/);
  assert.doesNotMatch(readme + skill, /动态.*接口.*待|当前包不能在检查中派生新读取|ItemSubjectInput 没有动态查询/);
});
