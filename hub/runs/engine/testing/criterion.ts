// Shared synthetic W10 fixture: generic source bindings, no product line, device or model service.
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import assert from 'node:assert/strict';
import type {TemporaryPostgres} from '../../../testing/postgres.ts';
import {openHarness} from './harness.ts';
import {writePack} from './packs.ts';
export async function criterionHarness(pg:TemporaryPostgres,options:{leases?:boolean}={}){
 const h=await openHarness(pg,{leases:options.leases});const dir=await mkdtemp(join(tmpdir(),'criterion-fixture-'));
 const spec={id:'criterion-draft',version:'1.0.0',kind:'workflow' as const,title:'合成判据草稿',description:'合成声明边界',files:{
  'workflow.json':{json:{schema:'workflow@1',inputs:[{slot:'subject',role:'subject',description:'合成对象',accepts:['application/json'],required:true,many:false},{slot:'expected',role:'expected',description:'合成期望',accepts:['text/plain'],required:true,many:false}],parameters:[],product:{catalogs:[]},subject:'subject',projection:{module:'functions/project.ts'}}},
  'requirements.json':{json:{schema:'requirements@1',requirements:[{key:'criterion',name:'原判据',description:'合成原判据',target:'item',required:true,done_rule:'bookkeeping',layers:['static'],accepted_producer:'fact',checks:['original'],error_handling:[]}]}},
  'checks.json':{json:{schema:'checks@1',checks:[{id:'original',function:{module:'functions/check.ts'},subject:{module:'functions/subject.ts'},applies:'item',judges:'subject',tier:'blocking',basis:'合成判据的期望合同'}]}},
  'slots.schema.json':{json:{schema:'slots@1',item:{},run:{}}},'SKILL.md':'# 合成声明\n提供原件与声明，Hub 只核验。\n',
  'functions/project.ts':`export default function(input:any){return {items:[{id:'one',label:'合成对象',location:{slot:'subject',parser:'json@1',selector:'p/value'},fields:{expected:'旧判据'}}],warnings:[]}}`,
  'functions/subject.ts':`export default function(input:any){return {...input.item,context:input.context,slots:input.slots}}`,
  'functions/check.ts':`export default function(input:any){const item=input.subject;const changed=item.context?.accepted_criteria?.find((change:any)=>change.item===item.id);const expected=changed?.new??item.fields.expected;return [{verdict:expected==='新判据'?'support':'refute',...(expected==='新判据'?{}:{code:'criterion-draft.original'}),statement:'合成判据核验',grounds:[],tier:'blocking',data:{used_criterion:expected}}]}`,

 }};
 const workflow=await h.workflows.add(await writePack(dir,spec));h.workflows.assign(h.alice.id,workflow.pack.id);
 const subject=await h.upload(h.alice,Buffer.from(JSON.stringify({value:'旧判据；依据'})),'application/json');
 const expected=await h.upload(h.alice,Buffer.from('旧判据；依据\n另一判据；第二依据'),'text/plain');
 const start=async()=>{const answer=await h.service.startRun(h.alice,{pack:workflow.pack.id,inputs:{subject:{reference:subject},expected:{reference:expected}}},h.call('criterion-author'));assert.equal(answer.call_result,'ok',JSON.stringify(answer.errors));return answer.run!;};
 const proposal={item:'one',criterion:expected,assertion:'合成判据更正',old:'旧判据',new:'新判据',grounds:[{reference:expected,quote:'依据'}]};
 const submit=(run:string,changes:unknown[],by=h.alice,session='criterion-author')=>h.service.submitResult(by,{run,model:'Scripted',items:[{item:'one',handling:'handled',slots:{}}],criterion_changes:changes},h.call(session));
 return {...h,start,proposal,subject,expected,submit,async close(){await h.close();await rm(dir,{recursive:true,force:true});}};
}
