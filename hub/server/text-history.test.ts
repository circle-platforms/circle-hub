// Read-only historical result rendering; no engine or unknown producer is executed.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { accepted, TRACE } from '../../contracts/src/fixtures.ts';
import { GetNodesOutput } from '../../contracts/src/tools.ts';
import { readStoredValidationResult, ValidationResult } from '../../contracts/src/validation.ts';
import { canonicalJson } from '../refs/api.ts';
import { toolText } from './text.ts';

const reference='rec:'+'a'.repeat(64);
function legacy(){
  const value=structuredClone(accepted) as any;
  for(const items of Object.values(value.partitions) as any[][])for(const item of items)for(const requirement of item.requirements)for(const layer of requirement.layers){delete layer.exit;delete layer.missing;}
  assert.equal(ValidationResult.safeParse(value).success,false);
  assert.ok(readStoredValidationResult(value).notices.length);
  return value;
}
function render(ref:string,value:unknown,cursor?:string){
  const answer=GetNodesOutput.parse({call_result:'ok',errors:[],content:{reference:ref,read_tier:'model_readable',readable:true,text:canonicalJson(value)},trace:TRACE});
  return toolText('get_nodes',answer,{paging:true,...(cursor?{cursor}:{})});
}

test('historical results retain each original case conclusion and its unknown state',()=>{
  const value=legacy();const original=canonicalJson(value);
  const text=render(reference,value);
  assert.match(text,/^原始用例 端口越界，.*状态未确认；判断错误；原因生产者错误/m);
  assert.match(text,/^原始用例 未改动的用例，还没有确认结论；状态未知；原因缺资料；下一步使用者核对资料后重新交给 Hub 检查；决定者程序$/m);
  assert.match(text,/^原始用例 已废弃，.*状态未知；原因还没查清/m);
  assert.doesNotMatch(text,/doc-1:n9|rec:|要求项（|问题与未知|出口未写|缺失事实未写/);
  assert.equal(canonicalJson(value),original);
});

for(const [suffix,select] of [
  ['#/partitions/delivered',(v:any)=>v.partitions.delivered],
  ['#/partitions/delivered/1',(v:any)=>v.partitions.delivered[1]],
] as const)test('historical partition pointer keeps item layout '+suffix,()=>{
  const value=select(legacy());const text=render(reference+suffix,value);
  assert.match(text,/^原始用例 未改动的用例：还没有确认结论；状态未知；原因缺资料；下一步使用者核对资料后重新交给 Hub 检查；决定者程序$/m);
  assert.doesNotMatch(text,/doc-1:n9|catalog|出口未写|缺失事实未写/);
});

 test('a large historical result gives every original case conclusion without truncation',()=>{
  const value=legacy();const item=value.partitions.delivered[1];
  value.partitions.delivered=Array.from({length:500},(_,i)=>({...structuredClone(item),item:'legacy:'+i,label:'合成历史条目'+i+'很'.repeat(200)}));
  const text=render(reference,value);
  const lines=text.split('\n').filter(line=>line.startsWith('原始用例 合成历史条目'));
  assert.equal(lines.length,500);
  assert.ok(lines.every(line=>line.includes('状态未知；原因缺资料；下一步使用者核对资料后重新交给 Hub 检查；决定者程序')));
  assert.ok(lines[0].startsWith('原始用例 合成历史条目0很'));
  assert.ok(lines[499].startsWith('原始用例 合成历史条目499很'));
  assert.doesNotMatch(text,/legacy:|出口未写|缺失事实未写|下一页|个字符为限/);
});
