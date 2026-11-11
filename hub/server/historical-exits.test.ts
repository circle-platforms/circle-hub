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
  assert.match(text,/原始用例 未改动的用例，还没有确认结论；状态未知；原因缺资料；下一步使用者核对资料后重新交给 Hub 检查/);
  assert.doesNotMatch(text,/出口未写|缺失事实未写|usr_|2026-11-01/);
  assert.equal(answer.content?.text,original);
  assert.equal(canonicalJson(old),original);
});
test('system delivery text identifies the reproducible system input instead of a user submission receipt',()=>{
  const result={...structuredClone(accepted),system_input:`rec:${'b'.repeat(64)}`};
  const answer=GetNodesOutput.parse({call_result:'ok',errors:[],content:{reference:`rec:${'a'.repeat(64)}`,read_tier:'model_readable',readable:true,text:canonicalJson(result)},trace:TRACE});
  const text=toolText('get_nodes',answer);
  const stored=JSON.parse(answer.content!.text!);
  assert.equal(stored.submission,result.submission);
  assert.equal(stored.system_input,result.system_input);
  assert.doesNotMatch(text,/系统交付输入摘要|rec:|[0-9a-f]{64}/);
  assert.match(text,/原始用例 未改动的用例，.*状态未知/);
});
