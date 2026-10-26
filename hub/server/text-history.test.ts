// Read-only historical result rendering; no engine or unknown producer is executed.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { accepted, TRACE } from '../../contracts/src/fixtures.ts';
import { GetNodesOutput } from '../../contracts/src/tools.ts';
import { readStoredValidationResult, ValidationResult } from '../../contracts/src/validation.ts';
import { canonicalJson } from '../refs/api.ts';
import { toolText } from './text.ts';
import { TEXT_BUDGET } from './budget.ts';

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

test('historical results retain counts, requirement states, problem lists and item blocks',()=>{
  const value=legacy();const original=canonicalJson(value);
  const text=render(reference,value);
  assert.match(text,/^结果 rec:/m);assert.match(text,/未知 1/);
  assert.match(text,/要求项（满足状态与各层终态的条目数）/);
  assert.match(text,/问题与未知/);assert.match(text,/- doc-1:n9 \|/);
  assert.match(text,/出口未写/);assert.match(text,/缺失事实未写/);
  assert.equal(canonicalJson(value),original);
});

for(const [suffix,select] of [
  ['#/partitions/delivered',(v:any)=>v.partitions.delivered],
  ['#/partitions/delivered/1',(v:any)=>v.partitions.delivered[1]],
] as const)test('historical partition pointer keeps item layout '+suffix,()=>{
  const value=select(legacy());const text=render(reference+suffix,value);
  assert.match(text,/^结果的已交付部分/m);assert.match(text,/- doc-1:n9 \|/);
  assert.match(text,/catalog/);assert.match(text,/出口未写/);assert.match(text,/缺失事实未写/);
});

 test('historical notices obey paging without replacing the structured result with a dump',()=>{
  const value=legacy();const item=value.partitions.delivered[1];
  value.partitions.delivered=Array.from({length:500},(_,i)=>({...structuredClone(item),item:'legacy:'+i,label:'合成历史条目'+i+'很'.repeat(200)}));
  const text=render(reference,value);
  assert.ok(text.length<=TEXT_BUDGET);
  assert.match(text,/未知 500/);assert.match(text,/出口未写/);assert.match(text,/缺失事实未写/);assert.match(text,/下一页/);
});
