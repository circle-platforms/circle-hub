import assert from 'node:assert/strict';
import {after,before,test} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {WorkflowFile} from '../../../contracts/src/pack.ts';
import {accepted as fixture} from '../../../contracts/src/fixtures.ts';
import {ValidationResult} from '../../../contracts/src/validation.ts';
import {digestOf} from '../../records/api.ts';
import {startPostgres,type TemporaryPostgres} from '../../testing/postgres.ts';
import {toolText} from '../../server/text.ts';
import {openRetryHarness} from './testing/retry-harness.ts';
import {sandboxSkip} from './testing/harness.ts';
import {verifyPack,writePack} from './testing/packs.ts';
import {standardDocument,toyMap} from './testing/mindmap.ts';
import {putAction,putResult,runById} from './store.ts';
let pg:TemporaryPostgres;const skip=await sandboxSkip();
before(async()=>{pg=await startPostgres();});after(async()=>{await pg?.stop();});
async function setup(options:{declared?:boolean;many?:boolean}={}){
  const h=await openRetryHarness(pg),dir=await mkdtemp(join(tmpdir(),'hub-default-'));
  const spec=verifyPack();spec.version='1.0.1';
  const workflow=(spec.files['workflow.json'] as {json:WorkflowFile}).json;
  if(options.declared!==false)workflow.inputs[0].default_from_predecessor={pack:'toy-review'};
  if(options.many)workflow.inputs[0].many=true;
  await h.workflows.add(await writePack(dir,spec));
  const map=await h.upload(h.alice,toyMap(standardDocument()));
  const start=await h.service.startRun(h.alice,{pack:'toy-review',product:'Meadow',version:'10.6.1',build:'Rel_MEADOW_10_6_1_7',inputs:{map:{reference:map}}},h.call('draft-session'));
  assert.equal(start.call_result,'ok',JSON.stringify(start.errors));const draft=start.run!;
  const body={run:draft.run,model:'synthetic-drafter',items:draft.items.map(i=>({item:i.id,handling:'handled',slots:{findings:[]}})),cross_item:[{nature:'judgment',statement:'合成初评等级',grounds:[],code:'draft_level',rank:'P4'}]};
  const submit=async(statement='合成初评等级')=>{
    const result=await h.service.submitResult(h.alice,{...body,cross_item:[{...body.cross_item[0],statement}]},h.call('draft-session'));
    assert.equal(result.acceptance,'accepted',JSON.stringify(result.errors));return(await h.service.getResult(h.alice,draft.run))!;
  };
  const input={pack:'toy-verify',predecessor:draft.run,product:'Meadow',version:'10.6.1',build:'Rel_MEADOW_10_6_1_7',inputs:{map:{reference:map}}};
  return{h,dir,map,draft,body,submit,input,close:async()=>{await h.close();await rm(dir,{recursive:true,force:true});}};
}
test('an opted-in missing slot freezes the latest accepted submitted result despite newer refusals and system deliveries',{skip},async()=>{
  const w=await setup();try{
    await w.submit();const expected=await w.submit('合成更新等级');
    const refused=await w.h.service.submitResult(w.h.alice,{run:w.draft.run,model:'synthetic-drafter',items:[{item:'absent-item',handling:'skipped',reason:'合成反例'}]},w.h.call('draft-session'));
    assert.equal(refused.acceptance,'not_accepted');
    const input={run:w.draft.run,synthetic_system_delivery:true};
    const action=await putAction(w.h.kit.store,{action:'validate',run:w.draft.run,inputs:[],startedAt:w.draft.started_at,endedAt:w.draft.started_at,acceptance:null,codes:[],detail:{input}});
    const system=await putResult(w.h.kit.store,{...expected.result,submission:digestOf(input),system_input:'rec:'+action.digest},w.draft.started_at);
    assert.equal((await w.h.service.getResult(w.h.alice,w.draft.run))!.record,system.digest,'the newer accepted system delivery really is latest before default selection');
    const args={...w.input,client_key:'synthetic-default-repeat'};
    const answer=await w.h.service.startRun(w.h.alice,args,w.h.call('verifier-session'));
    assert.equal(answer.call_result,'ok',JSON.stringify(answer.errors));const run=answer.run!;
    const defaults=[{slot:'draft',predecessor:w.draft.run,reference:'rec:'+expected.record}];
    assert.deepEqual(run.input_defaults,defaults);
    assert.equal(run.sources.find(s=>s.slot==='draft')!.reference,'rec:'+expected.record);
    assert.deepEqual((await w.h.service.getRun(w.h.alice,run.run))!.run.input_defaults,defaults);
    const text=toolText('start_run',{...answer,trace:w.h.call().traceId});
    assert.ok(text.includes(`draft 按前驱 ${w.draft.run} 的已受理结果 rec:${expected.record} 绑定`),text);
    const later=await w.submit('合成后续记录');assert.notEqual(later.record,expected.record);
    const repeated=await w.h.service.startRun(w.h.alice,args,w.h.call('verifier-session'));
    assert.equal(repeated.run!.run,run.run);assert.deepEqual(repeated.run!.input_defaults,defaults,'client-key replay retains the original selection');
    assert.ok(!Object.hasOwn(args.inputs,'draft'),'defaulting never mutates the received arguments');
  }finally{await w.close();}
});
test('no accepted submission refuses before binding and gives a concrete next submission step',{skip},async()=>{
  const w=await setup();try{
    const stored=(await runById(w.h.kit.store,w.draft.run))!;
    // A production-style result is not a submitted result, even when its body says accepted.
    await putResult(w.h.kit.store,ValidationResult.parse({...fixture,run:w.draft.run,submission:stored.digest}),w.draft.started_at);
    const before=(await w.h.kit.store.list({kind:'run',limit:100})).items.length;
    const answer=await w.h.service.startRun(w.h.alice,w.input,w.h.call('verifier-session'));
    assert.equal(answer.call_result,'error');
    const error=answer.errors.find(e=>e.path==='/inputs/draft');assert.ok(error);
    assert.equal(error.code,'SUBMISSION_SCHEMA_VIOLATION');assert.ok(error.fix?.includes('先让前驱运行按回执改正并重新提交，被受理后再开始复核'));
    assert.equal((await w.h.kit.store.list({kind:'run',limit:100})).items.length,before);
  }finally{await w.close();}
});
test('a declared default rejects a predecessor from another workflow',{skip},async()=>{
  const w=await setup();try{
    const other=(await w.h.service.startRun(w.h.alice,{pack:'toy-locate',inputs:{map:{reference:w.map}}},w.h.call('other-session'))).run!;
    const answer=await w.h.service.startRun(w.h.alice,{...w.input,predecessor:other.run},w.h.call('verifier-session'));
    assert.equal(answer.call_result,'error');assert.ok(answer.errors.some(e=>e.path==='/predecessor'&&e.code==='SUBMISSION_SCHEMA_VIOLATION'));
  }finally{await w.close();}
});
test('neither absent visibility nor read-only sharing grants predecessor authority',{skip},async()=>{
  const w=await setup();try{
    await w.submit();w.h.workflows.assign(w.h.bob.id,'toy-verify');
    for(const shared of [false,true]){
      if(shared){await w.h.kit.authorizations.share(w.h.admin,w.draft.run,[w.h.bob.id]);assert.ok(await w.h.service.getRun(w.h.bob,w.draft.run));}
      const answer=await w.h.service.startRun(w.h.bob,w.input,w.h.call('other-verifier'));
      assert.equal(answer.call_result,'error');assert.ok(answer.errors.some(e=>e.path==='/predecessor'&&e.code==='SOURCE_UNAVAILABLE'));
    }
  }finally{await w.close();}
});
test('explicit values retain the older selected result and invalid explicit bindings are never replaced',{skip},async()=>{
  const w=await setup();try{
    const first=await w.submit();await w.submit('合成更新等级');
    // The explicit full accepted record remains valid even if a newer accepted record is available.
    const answer=await w.h.service.startRun(w.h.alice,{...w.input,inputs:{...w.input.inputs,draft:{reference:'rec:'+first.record}}},w.h.call('verifier-session'));
    assert.equal(answer.call_result,'ok',JSON.stringify(answer.errors));
    assert.equal(answer.run!.sources.find(s=>s.slot==='draft')!.reference,'rec:'+first.record);assert.equal(answer.run!.input_defaults,undefined);
    const invalid=await w.h.service.startRun(w.h.alice,{...w.input,inputs:{...w.input.inputs,draft:{reference:w.map}}},w.h.call('second-verifier-session'));
    assert.equal(invalid.call_result,'error');assert.equal(invalid.run,undefined);
  }finally{await w.close();}
});
test('unopted legacy slots still require explicit values and explicit calls keep their original behavior',{skip},async()=>{
  const w=await setup({declared:false});try{
    const first=await w.submit();
    const missing=await w.h.service.startRun(w.h.alice,w.input,w.h.call('verifier-session'));assert.equal(missing.call_result,'error');
    const answer=await w.h.service.startRun(w.h.alice,{...w.input,inputs:{...w.input.inputs,draft:{reference:'rec:'+first.record}}},w.h.call('verifier-session'));
    assert.equal(answer.call_result,'ok',JSON.stringify(answer.errors));assert.equal(answer.run!.input_defaults,undefined);
  }finally{await w.close();}
});
test('many-valued declared slots get one default but an explicit empty list is not overwritten',{skip},async()=>{
  const w=await setup({many:true});try{
    const first=await w.submit();
    const empty=await w.h.service.startRun(w.h.alice,{...w.input,inputs:{...w.input.inputs,draft:[]}},w.h.call('verifier-session'));assert.equal(empty.call_result,'error');
    const answer=await w.h.service.startRun(w.h.alice,w.input,w.h.call('verifier-session'));
    assert.equal(answer.call_result,'ok',JSON.stringify(answer.errors));assert.equal(answer.run!.sources.filter(s=>s.slot==='draft').length,1);
    assert.equal(answer.run!.input_defaults![0].reference,'rec:'+first.record);
  }finally{await w.close();}
});


test('default lookup pages beyond refusals and never accepts an orphan validation without its submission',async()=>{
  const {latestSubmittedResult}=await import('./predecessor-defaults.ts');
  const {runRecord}=await import('../../../contracts/src/fixtures.ts');
  const rejected={body:{...fixture,acceptance:'not_accepted'}};
  const orphan={digest:'d'.repeat(64),body:{...fixture,submission:'e'.repeat(64)}};
  const submitted={digest:'b'.repeat(64),body:{...fixture,submission:'c'.repeat(64)}};
  const cursors:Array<string|null>=[];
  const store={find:async(query:{kind:string;cursor?:string|null;value:string;newestFirst?:boolean})=>{
    if(query.kind==='submission')return{items:query.value.endsWith(submitted.body.submission)?[{body:{run:runRecord.run}}]:[],next:null};
    assert.equal(query.newestFirst,true);cursors.push(query.cursor??null);
    return query.cursor?{items:[submitted],next:null}:{items:[...Array.from({length:99},()=>rejected),orphan],next:'synthetic-next'};
  }} as unknown as import('../../records/api.ts').RecordStore;
  const predecessor={digest:'a'.repeat(64),body:runRecord} as unknown as import('../../records/api.ts').StoredRecord<import('../../../contracts/src/run.ts').RunRecord>;
  assert.equal((await latestSubmittedResult(store,predecessor))!.digest,submitted.digest);
  assert.deepEqual(cursors,[null,'synthetic-next']);
});

test('an opted-in required slot without a predecessor names both available binding actions',{skip},async()=>{
  const w=await setup();try{
    const {predecessor:_,...input}=w.input;
    const answer=await w.h.service.startRun(w.h.alice,input,w.h.call('verifier-session'));
    assert.equal(answer.call_result,'error');
    const error=answer.errors.find(e=>e.path==='/inputs/draft');assert.ok(error);
    assert.ok(error.fix?.includes('predecessor')&&error.fix.includes('rec:'),'request the missing predecessor or explicit record, not an unrelated upload');
  }finally{await w.close();}
});
