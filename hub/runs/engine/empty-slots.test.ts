// Synthetic admitted submissions distinguish missing artifacts from the target itself.
// Table reads count actual executions; persisted claims, repair actions and partitions are checked separately.
import assert from 'node:assert/strict';
import { dirname } from 'node:path';
import type { ItemSubmission } from '../../../contracts/src/submission.ts';
import { after, before, test, type TestContext } from 'node:test';
import { startPostgres, type TemporaryPostgres } from '../../testing/postgres.ts';
import { openHarness, sandboxSkip } from './testing/harness.ts';
import { reviewPack, writePack } from './testing/packs.ts';
import { standardDocument, toyMap } from './testing/mindmap.ts';
import { actionsOf } from './store.ts';

let postgres: TemporaryPostgres;
const skip = await sandboxSkip();
before(async () => { postgres = await startPostgres(); });
after(() => postgres?.stop());

type Applies = 'item' | 'run';
type Missing = 'skipped' | 'not_covered';
async function fixture(t: TestContext, applies: Applies, itemJudgment: boolean, runArtifact=false) {
  const h = await openHarness(postgres); t.after(() => h.close());
  const spec = reviewPack({findingsData:{type:'object',properties:{valid:{type:'boolean'}},required:['valid'],additionalProperties:false}});
  spec.id='toy-empty';
  const base={description:'合成核对',required:true,done_rule:'bookkeeping',accepted_producer:'fact',layers:['static']};
  spec.files['requirements.json']={json:{schema:'requirements@1',requirements:[
    {...base,key:'plan_shape',name:'产物',target:runArtifact?'run':'item',checks:['artifact'],layers:['static','dynamic'],observation:'synthetic-observation@1',error_handling:[{code:'toy-empty.artifact_invalid',action:'repair',max_rounds:2}]},
    {...base,key:'target',name:'对象',target:'item',checks:['target'],error_handling:[{code:'*',action:'repair',max_rounds:2}]},
    ...(itemJudgment?[{...base,key:'findings',name:'模型产物',target:'item',accepted_producer:'judgment',checks:[],error_handling:[{code:'toy-empty.model_issue',action:'repair',max_rounds:2}]}]:[]),
    {...base,key:'level',name:'等级',target:'run',accepted_producer:'judgment',checks:[],error_handling:[]},
  ]}};
  spec.files['checks.json']={json:{schema:'checks@1',checks:['artifact','target'].map(id=>({
    id,function:{module:'functions/check.ts'},table:`tables/${id}.json`,applies,
    judges:id==='artifact'?'artifact_under_verification':'subject',tier:'blocking',basis:'合成检查各自判定的对象',
  }))}};
  for(const id of ['artifact','target']) spec.files[`tables/${id}.json`]={json:{kind:id,global:runArtifact && id==='artifact'}};
  spec.files['functions/check.ts']=`export default function(input:any) {
    const list=Array.isArray(input.subject.items)?input.subject.items:[input.subject];
    if(input.table.global) return [{verdict:list.some((it:any)=>it.slots===null)?'refute':'support',
      ...(list.some((it:any)=>it.slots===null)?{code:'toy-empty.artifact_invalid'}:{}),
      statement:'整次结论仍须核对每个条目的覆盖情况',grounds:[],tier:'blocking',pointer:'/cross_item/0',
      data:{seen:list.map((it:any)=>it.id??it.item),absent:list.filter((it:any)=>!Object.hasOwn(it,'slots')).map((it:any)=>it.id??it.item)}}];
    return list.map((it:any)=>{
      const artifact=input.table.kind==='artifact',valid=artifact && it.slots?.findings?.[0]?.data?.valid===true;
      return {item:it.id??it.item,verdict:valid?'support':'refute',...(valid?{}:{code:artifact?'toy-empty.artifact_invalid':'toy-empty.target_invalid'}),
        statement:artifact?(it.slots===null?'空槽位造成的假驳回':'真实产物检查'):'对象本身不通过',grounds:[],tier:'blocking'};
    });
  }`;
  const workflow=await h.workflows.add(await writePack(dirname(h.review.pack.directory),spec));
  h.workflows.assign(h.alice.id,spec.id);
  const doc=standardDocument();doc.groups=[{...doc.groups[0],cases:doc.groups[0].cases.slice(0,2)}];
  const map=await h.upload(h.alice,toyMap(doc));
  const started=await h.service.startRun(h.alice,{pack:spec.id,product:'Meadow',version:'3.2',inputs:{map:{reference:map}}},h.call());
  assert.ok(started.run);const run=started.run;assert.equal(run.items.length,2);
  const calls={artifact:0,target:0},read=workflow.readJson.bind(workflow);
  t.mock.method(workflow,'readJson',(path:string)=>{if(path==='tables/artifact.json')calls.artifact++;if(path==='tables/target.json')calls.target++;return read(path);});
  const submit=async(mode:Missing|'handled',allMissing=false,valid=true)=>h.service.submitResult(h.alice,{
    run:run.run,model:'synthetic-drafter',items:run.items.flatMap<ItemSubmission>((it,i)=>{
      if(mode!=='handled' && (i===0||allMissing)) return mode==='not_covered'?[]:[{item:it.id,handling:'skipped',reason:'合成声明跳过'}];
      return [{item:it.id,handling:'handled',slots:{findings:[{text:'合成产物',code:'literal_issue',rank:'minor',location:it.location,quotes:[{reference:it.location,text:it.label}],data:{valid}}]}}];
    }),cross_item:[{nature:'judgment',statement:'合成等级',grounds:[],code:'draft_level',rank:'P4'}],
  },h.call());
  const repair=async()=>{const actions=(await actionsOf(h.kit.store,run.run)).filter(a=>a.body.action==='validate');return actions.at(-1)!.body.detail.repair;};
  return {h,run,calls,submit,repair};
}


for(const applies of ['item','run'] as const) for(const itemJudgment of [false,true]) for(const mode of ['skipped','not_covered'] as const) {
  test(`${applies} ${mode} itemJudgment=${itemJudgment}: no artifact checks, target checks continue`,{skip},async t=>{
    const f=await fixture(t,applies,itemJudgment),answer=await f.submit(mode);
    assert.equal(answer.acceptance,'accepted',JSON.stringify(answer.errors));
    const row=answer.result!.partitions.incomplete.find(item=>item.item===f.run.items[0].id);
    assert.ok(row, 'the absent artifact is incomplete, never delivered or rejected');
    const artifact=row.requirements.find(r=>r.requirement==='plan_shape')!;
    assert.equal(f.calls.artifact,1,'only the handled second item is checked');
    assert.deepEqual(artifact.claims,[]);
    assert.ok(artifact.layers.every(layer=>layer.terminal==='incomplete' && layer.reason===(mode==='skipped'?'declared_skip':'not_covered')));
    const target=row.requirements.find(r=>r.requirement==='target')!;
    assert.ok(target.claims.some(c=>c.statement.code==='toy-empty.target_invalid'),'the target itself is still judged');
    assert.equal(f.calls.target,applies==='item'?2:1);
    assert.ok(!answer.errors.some(e=>e.code==='toy-empty.artifact_invalid'));
    assert.deepEqual(await f.repair(),itemJudgment?['findings','plan_shape']:['plan_shape'],'missing work consumes a requirement round without invoking absent-artifact checks');
    if(mode==='not_covered') assert.ok(answer.errors.some(e=>e.code==='core.coverage.shortfall' && e.item===f.run.items[0].id));
    const normal=answer.result!.partitions.delivered.find(item=>item.item===f.run.items[1].id)!;
    assert.ok(normal.requirements.find(r=>r.requirement==='plan_shape')!.claims.some(c=>c.statement.verdict==='support'));
    const checked=await f.submit('handled',false,false);
    const genuine=checked.errors.filter(e=>e.code==='toy-empty.artifact_invalid');
    assert.equal(genuine.length,2);
    assert.ok(genuine.every(e=>e.rounds_left===1),'missing work consumed one shared requirement round');
  });
}
for(const applies of ['item','run'] as const) for(const mode of ['skipped','not_covered'] as const) {
  test(`${applies}: all ${mode} skips every item-artifact check but still judges targets`,{skip},async t=>{
    const f=await fixture(t,applies,false),answer=await f.submit(mode,true);
    assert.equal(answer.acceptance,'accepted');
    assert.equal(f.calls.artifact,0);
    assert.equal(f.calls.target,applies==='item'?2:1);
    assert.equal(answer.result!.partitions.incomplete.length,2);
    assert.ok(answer.result!.partitions.incomplete.every(it=>it.requirements.find(r=>r.requirement==='plan_shape')!.claims.length===0));
    assert.ok(!answer.errors.some(e=>e.code==='toy-empty.artifact_invalid'));
    assert.ok((await f.repair() as string[]).includes('plan_shape'));
  });
}
for(const mode of ['skipped','not_covered'] as const) {
  test(`a genuine bad artifact still consumes its repair round beside a ${mode} item`,{skip},async t=>{
    const f=await fixture(t,'item',true),answer=await f.submit(mode,false,false);
    assert.equal(answer.acceptance,'accepted');
    assert.deepEqual(answer.errors.filter(e=>e.code==='toy-empty.artifact_invalid').map(e=>e.item),[f.run.items[1].id]);
    assert.equal(f.calls.artifact,1);
    const next=await f.submit('handled',false,false);
    assert.ok(next.errors.filter(e=>e.code==='toy-empty.artifact_invalid').every(e=>e.rounds_left===1));
  });
}

for(const mode of ['skipped','not_covered'] as const) {
  test(`a run-level artifact keeps ${mode} target metadata without passing null slots`,{skip},async t=>{
    const f=await fixture(t,'run',true,true),answer=await f.submit(mode);
    assert.equal(answer.acceptance,'accepted');
    assert.equal(f.calls.artifact,1,'the submitted run-level conclusion still has to be checked');
    const fact=answer.result!.cross_item.find(c=>c.requirement==='plan_shape' && c.statement.verdict==='support');
    assert.ok(fact);
    assert.deepEqual(fact.statement.data?.seen,f.run.items.map(it=>it.id));
    assert.deepEqual(fact.statement.data?.absent,[f.run.items[0].id]);
    assert.ok(!answer.errors.some(e=>e.code==='toy-empty.artifact_invalid'));
  });
}
