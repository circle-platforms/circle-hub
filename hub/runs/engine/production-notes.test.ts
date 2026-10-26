// Real synthetic production runs: projection notes are opt-in facts over run-bound sources, never arbitrary warnings.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { ValidationResult } from '../../../contracts/src/validation.ts';
import { startPostgres, type TemporaryPostgres } from '../../testing/postgres.ts';
import { toolText } from '../../server/text.ts';
import { openHarness, sandboxSkip, type Harness } from './testing/harness.ts';
import { locatePack, writePack } from './testing/packs.ts';

let postgres:TemporaryPostgres;
let h:Harness;
let directory:string;
let source:string;
const skip=await sandboxSkip();
before(async()=>{
  postgres=await startPostgres();if(skip)return;
  h=await openHarness(postgres);directory=await mkdtemp(join(tmpdir(),'hub-production-notes-'));
  source=await h.upload(h.alice,new TextEncoder().encode(JSON.stringify({cases:[{id:'one',commands:[]},{id:'two',commands:[]},{id:'three',commands:['status']}]})));
});
after(async()=>{await h?.close();if(directory)await rm(directory,{recursive:true,force:true});await postgres?.stop();});
let next=0;

async function pack(options:{override?:Record<string,unknown>;unmarked?:boolean;empty?:boolean;judgment?:boolean;metadataOnly?:boolean}={}){
  const spec=locatePack();spec.id=`synthetic-notes-${++next}`;
  spec.files['functions/project.ts']=`export default function(input:any) {
    const source=input.inputs.find((s:any)=>s.slot==='map');
    const n=source.model.cases.filter((c:any)=>c.commands.length===0).length;
    const note={nature:'fact',verdict:'support',message:'有 '+n+' 个用例解析不出命令',grounds:['src:'+source.sha256+'/json@1/p/cases'],${options.metadataOnly?"considered:n,details:['合成细节'],":"data:{empty:n},"}...${JSON.stringify(options.override??{})}};
    return {items:${options.empty?'[]':"source.model.cases.map((c:any,i:number)=>({id:c.id,label:c.id,location:{parser:'json@1',selector:'p/cases/'+i},fields:{document:'synthetic',path:['root'],expected:['state']}}))"},
      groups:[${options.unmarked?"{message:'未标记的投影说明'},{nature:'unknown',verdict:'unknown',message:'不能直接当事实的说明'}":'note'}],warnings:[{code:'${spec.id}.hint',message:'可能有遗漏的普通 warning'}]};
  }`;
  if(options.judgment){
    const file=spec.files['requirements.json'];assert.ok(typeof file==='object'&&'json'in file);
    const requirements=(file.json as {requirements:Array<Record<string,unknown>>}).requirements;requirements[0].accepted_producer='judgment';
    spec.files['slots.schema.json']={json:{schema:'slots@1',item:{located:{}},run:{}}};
  }
  await h.workflows.add(await writePack(directory,spec));h.workflows.assign(h.alice.id,spec.id);
  return spec.id;
}
const noteOf=(result:ValidationResult)=>result.cross_item.find(c=>c.pointer==='/groups/0');

test('a nonempty production run persists grounded projection facts and renders projection and check explanations', {skip},async()=>{
  const id=await pack();const args={pack:id,inputs:{map:{reference:source}},client_key:'notes-once'};
  const detail=await h.service.startRunDetailed(h.alice,args,h.call('notes-session'));
  assert.equal(detail.answer.call_result,'ok',JSON.stringify(detail.answer.errors));
  assert.equal(detail.answer.run!.items.length,3);
  const result=detail.production!.result;const note=noteOf(result)!;
  assert.equal(note.statement.text,'有 2 个用例解析不出命令');assert.deepEqual(note.statement.data,{empty:2});
  assert.deepEqual([note.qualifier.nature,note.statement.verdict,note.warrant.producer],['fact','support','function']);
  assert.deepEqual(note.grounds,[`${source}/json@1/p/cases`]);assert.ok(note.validity.bound.includes(source.slice(4)));
  assert.ok(ValidationResult.safeParse(result).success);
  assert.deepEqual((await h.service.getResult(h.alice,detail.answer.run!.run))!.result,result);
  const text=toolText('start_run',{...detail.answer,trace:result.trace},{production:result,record:`rec:${detail.runRecord}`,paging:true});
  assert.match(text,/有 2 个用例解析不出命令/);assert.match(text,/共 3 个用例/);assert.match(text,/生产运行说明/);
  assert.ok(!text.includes('可能有遗漏的普通 warning'));
  const repeated=await h.service.startRunDetailed(h.alice,args,h.call('notes-session'));
  assert.deepEqual(repeated.production,detail.production);
});

test('an empty production run also preserves its explicit grounded explanation',{skip},async()=>{
  const id=await pack({empty:true});const detail=await h.service.startRunDetailed(h.alice,{pack:id,inputs:{map:{reference:source}}},h.call());
  assert.equal(detail.answer.call_result,'ok',JSON.stringify(detail.answer.errors));assert.equal(detail.answer.run!.items.length,0);
  const result=detail.production!.result;
  assert.match(toolText('start_run',{...detail.answer,trace:result.trace},{production:result}),/有 2 个用例解析不出命令/);
});

test('unmarked groups, unknown notes and ordinary warnings are not promoted into facts',{skip},async()=>{
  const id=await pack({unmarked:true});const detail=await h.service.startRunDetailed(h.alice,{pack:id,inputs:{map:{reference:source}}},h.call());
  assert.equal(detail.answer.call_result,'ok');const result=detail.production!.result;
  assert.equal(noteOf(result),undefined);
  const text=toolText('start_run',{...detail.answer,trace:result.trace},{production:result});
  for(const message of ['未标记的投影说明','不能直接当事实的说明','可能有遗漏的普通 warning'])assert.ok(!text.includes(message));
});

for(const override of [{grounds:[]},{grounds:[`src:${'f'.repeat(64)}`]},{grounds:[`${'PLACEHOLDER'}`]}])test(`invalid or out-of-scope note grounds refuse production: ${JSON.stringify(override)}`,{skip},async()=>{
  const id=await pack({override});const detail=await h.service.startRunDetailed(h.alice,{pack:id,inputs:{map:{reference:source}}},h.call());
  assert.equal(detail.answer.call_result,'error');assert.equal(detail.production,null);assert.ok(detail.answer.errors[0].fix);
});

test('a missing fragment in a bound source is a definite refusal, and notes of a judgment workflow are not production facts',{skip},async()=>{
  const id=await pack({override:{grounds:[`${source}/json@1/p/not_present`]}});
  const rejected=await h.service.startRunDetailed(h.alice,{pack:id,inputs:{map:{reference:source}}},h.call());
  assert.equal(rejected.answer.call_result,'error');assert.equal(rejected.answer.errors[0].code,'REFERENCE_UNRESOLVED');
  const judgment=await pack({judgment:true});const normal=await h.service.startRunDetailed(h.alice,{pack:judgment,inputs:{map:{reference:source}}},h.call());
  assert.equal(normal.answer.call_result,'ok');assert.equal(normal.production,null);
});

// Each refusal concerns projection output, not a location in the caller arguments.
for(const mode of ['shape','ground'])test(`projection ${mode} errors never invent a call-argument path`,{skip},async()=>{
  const override=mode==='shape'?{grounds:[]}:{grounds:[`${source}/json@1/p/not_present`]};
  const id=await pack({override});const detail=await h.service.startRunDetailed(h.alice,{pack:id,inputs:{map:{reference:source}}},h.call());
  assert.equal(detail.answer.call_result,'error');assert.equal(detail.answer.errors[0].path,undefined);
  assert.match(detail.answer.errors[0].message,/groups\/0/);assert.ok(detail.answer.errors[0].fix);
});

test('projection note metadata must be explicitly carried in data rather than silently discarded',{skip},async()=>{
  const id=await pack({metadataOnly:true});const detail=await h.service.startRunDetailed(h.alice,{pack:id,inputs:{map:{reference:source}}},h.call());
  assert.equal(detail.answer.call_result,'error');assert.match(detail.answer.errors[0].message,/data/);assert.match(detail.answer.errors[0].fix!,/data/);
});

test('explicit projection note data preserves all declared metadata',{skip},async()=>{
  const metadata={empty:2,considered:3,details:['合成细节'],view:'synthetic-view'};
  const id=await pack({override:{data:metadata}});const detail=await h.service.startRunDetailed(h.alice,{pack:id,inputs:{map:{reference:source}}},h.call());
  assert.equal(detail.answer.call_result,'ok');assert.deepEqual(noteOf(detail.production!.result)!.statement.data,metadata);
});

test('projection facts disclose their advisory cross-item scope instead of pretending to satisfy requirements',{skip},async()=>{
  const id=await pack();const detail=await h.service.startRunDetailed(h.alice,{pack:id,inputs:{map:{reference:source}}},h.call());
  assert.equal(detail.answer.call_result,'ok');const result=detail.production!.result;const note=noteOf(result)!;
  assert.equal(note.requirement,undefined);
  for(const item of Object.values(result.partitions).flat())for(const requirement of item.requirements)assert.ok(!requirement.claims.some(c=>c.pointer==='/groups/0'));
  const text=toolText('start_run',{...detail.answer,trace:result.trace},{production:result});
  assert.match(text,/投影说明（提示，不参与要求项）/);
});
