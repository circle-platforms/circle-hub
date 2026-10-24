import assert from 'node:assert/strict';
import { test } from 'node:test';
import { accepted, TRACE } from '../../contracts/src/fixtures.ts';
import type { ValidationResult } from '../../contracts/src/validation.ts';
import { GetNodesOutput } from '../../contracts/src/tools.ts';
import { canonicalJson } from '../refs/api.ts';
import { toolText } from './text.ts';
test('historical result reads explicitly report unwritten exits without inventing actors or deadlines',()=>{
  const old=structuredClone(accepted) as unknown as ValidationResult;
  for(const items of Object.values(old.partitions))for(const item of items)for(const r of item.requirements)for(const layer of r.layers){delete layer.exit;delete layer.missing;}
  const original=canonicalJson(old);
  const answer=GetNodesOutput.parse({call_result:'ok',errors:[],content:{reference:`rec:${'a'.repeat(64)}`,read_tier:'model_readable',readable:true,text:original},trace:TRACE});
  const text=toolText('get_nodes',answer);
  assert.ok(text.includes('出口未写'));
  assert.ok(text.includes('缺失事实未写'));
  assert.equal(canonicalJson(old),original);
});
test('system delivery text identifies the reproducible system input instead of a user submission receipt',()=>{
  const result={...structuredClone(accepted),system_input:`rec:${'b'.repeat(64)}`};
  const answer=GetNodesOutput.parse({call_result:'ok',errors:[],content:{reference:`rec:${'a'.repeat(64)}`,read_tier:'model_readable',readable:true,text:canonicalJson(result)},trace:TRACE});
  const text=toolText('get_nodes',answer);
  assert.ok(text.includes('系统交付输入摘要 '+result.submission));
  assert.ok(text.includes(result.system_input));
});
