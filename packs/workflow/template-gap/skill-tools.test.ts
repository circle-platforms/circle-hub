import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('the skill uses available Hub tools and requests the command-tree identity', () => {
  const text = readFileSync(new URL('./SKILL.md', import.meta.url), 'utf8');
  assert.ok(text.includes('list_task_packs'));
  assert.ok(!text.includes('get_workflow'));
  assert.ok(text.includes('start_run'));
  const fields = 'fields=document,node,commands,command_identities,title,path_labels,object,command_tree_root';
  assert.equal(text.split(fields).length - 1, 2);
  assert.ok(text.includes('投影可能在后台继续'));
});
