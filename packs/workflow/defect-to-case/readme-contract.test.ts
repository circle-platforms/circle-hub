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

test('the dynamic dedup read dependency names the missing interface and an executable client recovery',()=>{
 const readme=readFileSync(new URL('./README.md',import.meta.url),'utf8'),skill=readFileSync(new URL('./SKILL.md',import.meta.url),'utf8');
 assert.match(readme,/CheckReads.*roles.*types.*max_bytes/);assert.match(readme,/动态.*接口.*待/);assert.match(skill,/only=.*fields=commands,document,node,title,negative/);assert.match(skill,/不能.*旧运行.*刷新/);assert.doesNotMatch(skill,/核心的缺口，另有任务修它|唯一正确的写法/);
});
