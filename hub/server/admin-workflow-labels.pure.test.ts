import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {test} from 'node:test';
import {ListTaskPacksOutput} from '../../contracts/src/tools.ts';
import type {PackSummary} from '../../contracts/src/run.ts';
import {toolText} from './text.ts';

function pack(id:string,title:string):PackSummary{return {id,pack:id+'@1.0.0',version:'1.0.0',kind:'workflow',title,description:'合成说明',digest:'a'.repeat(64),products:[],inputs:[],parameters:[],requirements:[]};}
function answer(packs:PackSummary[],unassigned=0){return {...ListTaskPacksOutput.parse({call_result:'ok',errors:[],packs,trace:'a'.repeat(32)}),member_capabilities:{unassigned_workflows_count:unassigned}};}
const assigned=pack('synthetic-assigned','合成已分配工作流'),implicit=pack('synthetic-default','合成默认工作流');
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const heading=(value:PackSummary)=>value.title+'，'+value.description;

test('ordinary member list bytes match the unchanged a8941e0bd3 renderer',()=>{
  // Captured before this text change, with the same synthetic fixture and the immutable base renderer.
  const expected='d35d6a4838fec532957e2904171dbb35bff8b7992d66a6afde5bc863127aca68';
  const value=answer([assigned],2);
  assert.equal(hash(toolText('list_task_packs',value,{packList:{offset:0}})),expected);
  assert.equal(hash(toolText('list_task_packs',value,{packList:{offset:0,adminDefaultPacks:[]}})),expected);
});
test('default workflow uses the approved full label directly after its own heading',()=>{
  const rows=toolText('list_task_packs',answer([assigned,implicit]),{packList:{offset:0,adminDefaultPacks:[implicit.pack]}}).split('\n');
  assert.equal(rows[rows.indexOf(heading(implicit))+1],'管理员默认可用（未分配给当前账户）');
});
test('assigned workflow uses the approved full label at the same position',()=>{
  const rows=toolText('list_task_packs',answer([assigned,implicit]),{packList:{offset:0,adminDefaultPacks:[implicit.pack]}}).split('\n');
  assert.equal(rows[rows.indexOf(heading(assigned))+1],'已分配');
});
test('private workflows and skills receive no default or assigned labels',()=>{
  const privatePack={...pack('synthetic-private','合成私人工作流'),space:'usr_00000000000000000000000000'};
  const skill={...pack('synthetic-skill','合成通用技能'),kind:'skill' as const};
  const value=answer([assigned,implicit,privatePack,skill]),before=structuredClone(value);
  const rows=toolText('list_task_packs',value,{packList:{offset:0,adminDefaultPacks:[implicit.pack,privatePack.pack,skill.pack]}}).split('\n');
  assert.equal(rows.filter(row=>row==='管理员默认可用（未分配给当前账户）'||row==='已分配').length,2);
  assert.notEqual(rows[rows.indexOf(heading(privatePack))+1],'管理员默认可用（未分配给当前账户）');
  assert.notEqual(rows[rows.indexOf(heading(skill))+1],'管理员默认可用（未分配给当前账户）');
  assert.deepEqual(value,before,'rendering never rewrites the authored descriptions or the answer');
});
