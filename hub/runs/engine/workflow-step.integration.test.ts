import {RunRecord} from '../../../contracts/src/run.ts';
import {runRecord,H,TRACE} from '../../../contracts/src/fixtures.ts';
import type {Submission} from '../../../contracts/src/submission.ts';
import type {LoadedWorkflow} from '../../ports.ts';
import {evaluate} from './evaluate.ts';
import {createEngineContext} from './deps.ts';
import {stepNameForScope} from './workflow-step.ts';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after, before, test} from 'node:test';
import {WorkflowFile, RequirementsFile, RequirementTemplate} from '../../../contracts/src/pack.ts';
import {SubmitResultOutput} from '../../../contracts/src/tools.ts';
import {startPostgres, type TemporaryPostgres} from '../../testing/postgres.ts';
import {openHarness, sandboxSkip, type Harness} from './testing/harness.ts';
import {reviewPack, writePack} from './testing/packs.ts';
import {standardDocument, toyMap} from './testing/mindmap.ts';

const skip = await sandboxSkip();
let pg: TemporaryPostgres | undefined;
before(async () => { if (!skip) pg = await startPostgres(); });
after(async () => { await pg?.stop(); });

async function addVersion(h: Harness, root: string, version: string, mode: 'one' | 'multiple' | 'unmapped', name = '合成阶段甲') {
  const spec = reviewPack({version});
  const workflow = spec.files['workflow.json'], requirements = spec.files['requirements.json'];
  assert.ok(typeof workflow === 'object' && 'json' in workflow);
  assert.ok(typeof requirements === 'object' && 'json' in requirements);
  const declared = WorkflowFile.parse(workflow.json);
  const templates = RequirementsFile.parse(requirements.json);
  spec.files['workflow.json'] = {json: {...declared, steps: [{id:'first',name},{id:'second',name}]}};
  spec.files['requirements.json'] = {json: {...templates, requirements: templates.requirements.map((r,index) => ({
    ...r,
    ...(mode === 'unmapped' && index === 0 ? {} : {step: mode === 'multiple' && index === 0 ? 'second' : 'first'}),
  }))}};
  return h.workflows.add(await writePack(root,spec));
}

async function fixture(t: {after(fn: () => Promise<void>): void}) {
  assert.ok(pg);
  const h = await openHarness(pg);
  const root = await mkdtemp(join(tmpdir(),'circle-hub-step-'));
  t.after(async () => { await h.close(); await rm(root,{recursive:true,force:true}); });
  const map = await h.upload(h.alice,toyMap(standardDocument()));
  return {h,root,map};
}
async function begin(h: Harness, map: string) {
  const reply = await h.service.startRun(h.alice,{pack:'toy-review',product:'Meadow',version:'3.2',inputs:{map:{reference:map}}},h.call('synthetic-step'));
  assert.equal(reply.call_result,'ok',JSON.stringify(reply.errors));
  assert.ok(reply.run);
  return reply.run;
}
function input(run: Awaited<ReturnType<typeof begin>>) {
  return {
    run:run.run,model:'scripted-model temperature=0',
    items:run.items.map(item=>({item:item.id,handling:'handled',slots:{findings:[]}})),
    cross_item:[{nature:'judgment',statement:'合成覆盖判断',grounds:[],code:'draft_level',rank:'P4'}],
  };
}

test('actual evaluation supplies a uniquely declared step without replacing verified result facts', {skip,timeout:120000}, async t => {
  const {h,root,map}=await fixture(t);
  await addVersion(h,root,'20.0.1','one');
  const run=await begin(h,map);
  const reply=await h.service.submitResult(h.alice,input(run),h.call('synthetic-step'));
  assert.equal(reply.acceptance,'accepted',JSON.stringify(reply.errors));
  assert.equal(reply.step_name,'合成阶段甲');
  assert.ok(reply.result);
  assert.equal(Object.values(reply.result.partitions).flat().length,run.items.length);
  assert.ok(SubmitResultOutput.safeParse({...reply,trace:'b'.repeat(32)}).success);
});

test('actual evaluation across two ids remains neutral even when their declared names are identical', {skip,timeout:120000}, async t => {
  const {h,root,map}=await fixture(t);
  await addVersion(h,root,'20.0.2','multiple');
  const run=await begin(h,map);
  const reply=await h.service.submitResult(h.alice,input(run),h.call('synthetic-step'));
  assert.equal(reply.acceptance,'accepted',JSON.stringify(reply.errors));
  assert.equal(reply.step_name,undefined);
  assert.ok(reply.result);
});

test('an actually checked unmapped requirement keeps the response neutral', {skip,timeout:120000}, async t => {
  const {h,root,map}=await fixture(t);
  await addVersion(h,root,'20.0.3','unmapped');
  const run=await begin(h,map);
  const reply=await h.service.submitResult(h.alice,input(run),h.call('synthetic-step'));
  assert.equal(reply.acceptance,'accepted',JSON.stringify(reply.errors));
  assert.equal(reply.step_name,undefined);
});

test('a newer published declaration does not rename the frozen run and cached reads do not invent an execution scope', {skip,timeout:120000}, async t => {
  const {h,root,map}=await fixture(t);
  const first=await addVersion(h,root,'20.0.4','one','合成阶段甲');
  const run=await begin(h,map);
  assert.equal(run.pack_digest,first.pack.digest);
  const newer=await addVersion(h,root,'20.0.5','one','合成阶段乙');
  assert.notEqual(first.pack.digest,newer.pack.digest);
  const submitted=input(run);
  const reply=await h.service.submitResult(h.alice,submitted,h.call('synthetic-step'));
  assert.equal(reply.acceptance,'accepted',JSON.stringify(reply.errors));
  assert.equal(reply.step_name,'合成阶段甲');
  const repeated=await h.service.submitResult(h.alice,submitted,h.call('synthetic-step'));
  assert.equal(repeated.acceptance,'accepted');
  assert.equal(repeated.record,reply.record);
  assert.equal(repeated.step_name,undefined,'a cached result has no witnessed new checked scope');
});

test('runtime sample admission is part of the checked stage scope even without handled items', {skip,timeout:120000}, async t => {
  const {h}=await fixture(t);
  const source=await h.kit.artifacts.ingest({
    bytes:new TextEncoder().encode('{"positive":1,"negative":9}'),mediaType:'application/json',
    origin:{read:{object:'synthetic:document:sample@1'}},author:{user:null},provenanceType:'observed',
    visibility:{readers:[h.alice.id],admins:true,packs:[],shareable:false},
  });
  const reference='src:'+source.body.sha256;
  const table={schema:'range@1',origin:'synthetic',checks:[{values:'$.fields.value',range:{minimum:1,maximum:3}}]};
  const first = RequirementTemplate.parse({key:'first_check',name:'合成目标事实',description:'Synthetic target check',target:'item',required:true,done_rule:'bookkeeping',layers:['static'],accepted_producer:'fact',checks:['base'],error_handling:[],step:'first'});
  const second = RequirementTemplate.parse({key:'sample_check',name:'合成样例准入',description:'Synthetic sample admission',target:'run',required:true,done_rule:'bookkeeping',layers:['static'],accepted_producer:'judgment',checks:[],error_handling:[],run_table:true,step:'second'});
  const workflow: LoadedWorkflow = {
    ...h.review,
    workflow:{...h.review.workflow,steps:[{id:'first',name:'合成阶段甲'},{id:'second',name:'合成阶段乙'}]},
    requirements:[first,second],
    checks:[{id:'base',interpreter:'range@1',table:'tables/base.json',applies:'item',judges:'subject'}],
    slots:{...h.review.slots,item:{},run:{}},
    ledger:{schema:'ledger@1',shapes:[{requirement:second.key,interpreter:'range@1',ruled_in:'10.6.0'}]},
    readJson:path=>path==='tables/base.json'?{...table,checks:[{values:'$.fields.value',range:{minimum:0,maximum:100}}]}:h.review.readJson(path),
  };
  const run=RunRecord.parse({...runRecord,runner:h.alice.id,sources:[{reference,role:'subject'}],requirements:[],items:[
    {id:'positive',label:'合成正例',location:reference,fields:{value:1}},
    {id:'negative',label:'合成反例',location:reference,fields:{value:9}},
  ]});
  const submission: Submission={run:run.run,model:'scripted-model',items:[],checks:[
    {requirement:second.key,interpreter:'range@1',table,samples:[
      {item:'positive',expect:[{verdict:'support'}]},
      {item:'negative',expect:[{verdict:'refute'}]},
    ]},
  ]};
  const ctx=createEngineContext({records:h.kit,workflows:h.workflows,packs:h.packs,knowledge:h.knowledge,external:h.external,sandbox:{requireOsIsolation:false}});
  const checked=await evaluate(ctx,{run,workflow,submission,submissionDigest:H,exact:null,carried:new Map(),roundsUsed:new Map(),origin:{sessions:['synthetic'],model:'scripted-model'},author:null,traceId:TRACE});
  assert.equal(checked.runtimeAdmission.length,1);
  assert.equal(checked.runtimeAdmission[0].samples.length,2);
  assert.deepEqual(checked.runtimeAdmission[0].samples.map(sample=>sample.outcome[0].verdict),['support','refute'],'both sample checks really ran');
  assert.equal(checked.runtimeAdmission[0].admitted,true);
  assert.equal(checked.checkedScope.complete,true);
  assert.equal(stepNameForScope(workflow,checked.checkedScope),undefined,'two actually checked stages must remain neutral');
  assert.deepEqual([...checked.checkedScope.requirements].sort(),[first.key,second.key].sort());
});
