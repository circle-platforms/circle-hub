import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('the skill says when it applies, gives the index form the pack binds, and promises no interface the Hub does not have', () => {
  const skill = readFileSync(new URL('./SKILL.md', import.meta.url), 'utf8');
  assert.match(skill, /^---\nname: story-traceability\ndescription: [^\n]*时使用[^\n]*\n---\n/);
  assert.ok(skill.includes('`knowledge:index:ORBIT:Rel_ORBIT_7_1_0_30?kind=case&key=stories`'));
  assert.ok(!skill.includes('等待核心') && !skill.includes('旧视图'));
});
