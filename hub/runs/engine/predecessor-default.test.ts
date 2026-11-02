import assert from 'node:assert/strict';
import {after,before,test} from 'node:test';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {RequirementsFile,WorkflowFile} from '../../../contracts/src/pack.ts';
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
import {createKeyedLock} from './util.ts';
import {requirementSummary} from './start.ts';
let pg:TemporaryPostgres;const skip=await sandboxSkip();
before(async()=>{pg=await startPostgres();});after(async()=>{await pg?.stop();});
async function setup(options:{declared?:boolean;many?:boolean;slot?:string;runtimeTable?:boolean;copyMap?:boolean;fromRuns?:boolean}={}){
  const h=await openRetryHarness(pg),dir=await mkdtemp(join(tmpdir(),'hub-default-'));
  const spec=verifyPack();spec.version='1.0.1';
  const workflow=(spec.files['workflow.json'] as {json:WorkflowFile}).json;
  if(options.runtimeTable){
    const requirement=(spec.files['requirements.json'] as {json:RequirementsFile}).json.requirements[0];
    requirement.run_table=true;
    spec.files['ledger.json']={json:{schema:'ledger@1',shapes:[{requirement:requirement.key,interpreter:'range@1',ruled_in:spec.version}]}};
  }
  if(options.declared!==false)workflow.inputs[0].default_from_predecessor={pack:'toy-review'};
  if(options.copyMap){const map=workflow.inputs.find(slot=>slot.slot==='map');assert.ok(map);map.default_from_predecessor={pack:'toy-review',slot:'map'};}
  if(options.fromRuns)workflow.inputs.push({slot:'checks',role:'expected',description:'合成运行结果',accepts:['application/json'],required:true,many:true,from_runs:{pack:'toy-review'}});
  if(options.many)workflow.inputs[0].many=true;
  if(options.slot){
    workflow.inputs[0].slot=options.slot;
    const source=await readFile(new URL('./testing/functions/verify/project.ts',import.meta.url),'utf8');
    assert.ok(source.includes("i.slot === 'draft'"));
    spec.files['functions/project.ts']=source.replace("i.slot === 'draft'",'i.slot === '+JSON.stringify(options.slot));
  }
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
  const w=await setup({runtimeTable:true});try{
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
    const locked=(await w.h.workflows.byDigest(run.pack_digest))!;
    assert.deepEqual(run.requirements,locked.requirements.map(template=>requirementSummary(template,locked.ledger,locked.checks,run.pack)));
    assert.deepEqual(run.requirements[0].run_interpreters,['range@1']);
    assert.ok(run.requirements[0].rules.length>0);
    assert.equal(run.sources.find(s=>s.slot==='draft')!.reference,'rec:'+expected.record);
    assert.deepEqual((await w.h.service.getRun(w.h.alice,run.run))!.run.input_defaults,defaults);
    const text=toolText('start_run',{...answer,trace:w.h.call().traceId});
    assert.ok(text.includes(`draft 按前驱 ${w.draft.run} 的已受理结果 rec:${expected.record} 绑定`),text);
    const later=await w.submit('合成后续记录');assert.notEqual(later.record,expected.record);
    const repeated=await w.h.service.startRun(w.h.alice,args,w.h.call('verifier-session'));
    assert.equal(repeated.run!.run,run.run);assert.deepEqual(repeated.run!.input_defaults,defaults,'client-key replay retains the original selection');
    assert.deepEqual(repeated.run!.requirements,run.requirements,'replay preserves ruling metadata alongside the frozen input selection');
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
  const ctx={deps:{records:{store}},lock:createKeyedLock()} as unknown as import('./deps.ts').EngineContext;
  assert.equal((await latestSubmittedResult(ctx,predecessor))!.digest,submitted.digest);
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

test('an inherited object property never counts as an explicit input binding',{skip},async()=>{
  const w=await setup({slot:'constructor'});try{
    const result=await w.submit();
    assert.equal(Object.hasOwn(w.input.inputs,'constructor'),false);
    const answer=await w.h.service.startRun(w.h.alice,w.input,w.h.call('verifier-session'));
    assert.equal(answer.call_result,'ok',JSON.stringify(answer.errors));
    assert.equal(answer.run!.sources.find(s=>s.slot==='constructor')!.reference,'rec:'+result.record);
    assert.equal(answer.run!.input_defaults![0].slot,'constructor');
    assert.equal(Object.hasOwn(w.input.inputs,'constructor'),false,'the original arguments stay untouched');
    const explicit=await w.h.service.startRun(w.h.alice,{...w.input,inputs:{...w.input.inputs,constructor:{reference:'rec:'+result.record}}},w.h.call('explicit-verifier'));
    assert.equal(explicit.call_result,'ok',JSON.stringify(explicit.errors));
    assert.equal(explicit.run!.input_defaults,undefined);
  }finally{await w.close();}
});

test('a named predecessor input is copied when absent and refused when it differs',{skip},async()=>{
  const w=await setup({copyMap:true});try{
    await w.submit();
    const answer=await w.h.service.startRun(w.h.alice,{...w.input,inputs:{}},w.h.call('verifier-session'));
    assert.equal(answer.call_result,'ok',JSON.stringify(answer.errors));
    const copied=answer.run!.input_defaults!.find(row=>row.slot==='map');
    assert.deepEqual(copied,{slot:'map',predecessor:w.draft.run,reference:w.map,kind:'input'});
    assert.equal(answer.run!.sources.find(source=>source.slot==='map')!.reference,w.map);
    const text=toolText('start_run',{...answer,trace:w.h.call().traceId});
    assert.ok(text.includes(`map 按前驱 ${w.draft.run} 冻结的输入 ${w.map} 绑定`),text);
    const mismatch=await w.h.service.startRun(w.h.alice,{...w.input,inputs:{map:{reference:'src:'+'ab'.repeat(32)}}},w.h.call('other-verifier'));
    assert.equal(mismatch.call_result,'error');
    assert.match(mismatch.errors.map(error=>`${error.message} ${error.fix??''}`).join('\n'),/不一致/);
    const same=await w.h.service.startRun(w.h.alice,w.input,w.h.call('same-verifier'));
    assert.equal(same.call_result,'ok',JSON.stringify(same.errors));
    assert.equal(same.run!.input_defaults!.some(row=>row.slot==='map'),false);
  }finally{await w.close();}
});
test('a run id resolves to that run’s accepted result and an omitted slot follows the lineage',{skip},async()=>{
  const w=await setup({fromRuns:true,declared:false});try{
    const result=await w.submit();
    const draft={reference:'rec:'+result.record};
    const lineage=await w.h.service.startRun(w.h.alice,{...w.input,inputs:{map:{reference:w.map},draft}},w.h.call('verifier-session'));
    assert.equal(lineage.call_result,'ok',JSON.stringify(lineage.errors));
    assert.deepEqual(lineage.run!.input_defaults,[{slot:'checks',predecessor:w.draft.run,reference:draft.reference}]);
    const text=toolText('start_run',{...lineage,trace:w.h.call().traceId});
    assert.ok(text.includes(`checks 按前驱 ${w.draft.run} 的已受理结果 ${draft.reference} 绑定`),text);
    const absent=await w.h.service.startRun(w.h.alice,{...w.input,inputs:{map:{reference:w.map},draft,checks:[{run:'run_01m5h9zm2nhzbz2hrfjfb6azta'}]}},w.h.call('missing-run'));
    assert.equal(absent.call_result,'error');
    assert.match(absent.errors.map(error=>error.message).join('\n'),/不存在或当前用户不可见/);
    const open=await w.h.service.startRun(w.h.alice,{pack:'toy-review',product:'Meadow',version:'10.6.1',build:'Rel_MEADOW_10_6_1_7',inputs:{map:{reference:w.map}}},w.h.call('draft-session'));
    assert.equal(open.call_result,'ok',JSON.stringify(open.errors));
    const unaccepted=await w.h.service.startRun(w.h.alice,{...w.input,inputs:{map:{reference:w.map},draft,checks:[{run:open.run!.run}]}},w.h.call('unaccepted-run'));
    assert.equal(unaccepted.call_result,'error');
    assert.match(unaccepted.errors.map(error=>`${error.message} ${error.fix??''}`).join('\n'),/没有已受理提交/);
    const other=await w.h.service.startRun(w.h.alice,{pack:'toy-locate',inputs:{map:{reference:w.map}}},w.h.call('other-session'));
    assert.equal(other.call_result,'ok',JSON.stringify(other.errors));
    const wrong=await w.h.service.startRun(w.h.alice,{...w.input,inputs:{map:{reference:w.map},draft,checks:[{run:other.run!.run}]}},w.h.call('wrong-pack'));
    assert.equal(wrong.call_result,'error');
    assert.match(wrong.errors.map(error=>`${error.message} ${error.fix??''}`).join('\n'),/toy-locate/);
  }finally{await w.close();}
});
test('predecessor selection holds the submission key across every result page',async()=>{
  const {latestSubmittedResult}=await import('./predecessor-defaults.ts');
  const {runRecord}=await import('../../../contracts/src/fixtures.ts');
  const predecessor={digest:'a'.repeat(64),body:runRecord} as unknown as import('../../records/api.ts').StoredRecord<import('../../../contracts/src/run.ts').RunRecord>;
  const older={digest:'b'.repeat(64),body:{...fixture,submission:'c'.repeat(64)}};
  const newer={digest:'d'.repeat(64),body:{...fixture,submission:'e'.repeat(64)}};
  let pageRead!:()=>void,releasePage!:()=>void;
  const firstPage=new Promise<void>(resolve=>{pageRead=resolve;});
  const gate=new Promise<void>(resolve=>{releasePage=resolve;});
  let pause=true,committed=false,writerEntered=false;
  const store={find:async(query:{kind:string;cursor?:string|null})=>{
    if(query.kind==='submission')return{items:[{body:{run:runRecord.run}}],next:null};
    if(query.cursor)return{items:[older],next:null};
    if(committed)return{items:[newer],next:null};
    const page={items:Array.from({length:100},()=>({body:{...fixture,acceptance:'not_accepted'}})),next:'synthetic-next'};
    if(pause){pause=false;pageRead();await gate;}
    return page;
  }} as unknown as import('../../records/api.ts').RecordStore;
  const lock=createKeyedLock();
  const ctx={deps:{records:{store}},lock} as unknown as import('./deps.ts').EngineContext;
  const select=()=>latestSubmittedResult(ctx,predecessor);
  const selection=select();await firstPage;
  const writer=lock('submit:'+runRecord.run,async()=>{writerEntered=true;committed=true;});
  try{
    await new Promise<void>(resolve=>setImmediate(resolve));
    assert.equal(writerEntered,false,'a new accepted submission must wait until all predecessor pages have been selected');
  }finally{releasePage();}
  assert.equal((await selection)!.digest,older.digest,'the in-flight selection is consistent before the queued submission');
  await writer;
  assert.equal((await select())!.digest,newer.digest,'the next selection sees the newly accepted result');
});
