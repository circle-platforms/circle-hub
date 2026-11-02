// Defense in depth also covers publications retained before the personal capability restrictions were added.
import assert from 'node:assert/strict';
import {after,before,test} from 'node:test';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {startPostgres} from '../../testing/postgres.ts';
import {openHarness,sandboxSkip} from './testing/harness.ts';
import {toyMap,standardDocument} from './testing/mindmap.ts';
let pg:Awaited<ReturnType<typeof startPostgres>>;
const skip=await sandboxSkip();
before(async()=>{pg=await startPostgres();});after(()=>pg?.stop());
async function setup(){const h=await openHarness(pg);h.review.pack.space=h.alice.id;for(const slot of h.review.workflow.inputs)slot.accepts=['application/json'];delete h.review.workflow.expected_sources;const map=await h.upload(h.alice,toyMap(standardDocument()));return {h,args:{pack:'toy-review',pack_space:h.alice.id,product:'Meadow',version:'3.2',inputs:{map:{reference:map}}}};}

test('a personal workflow retains ordinary upload inputs',{skip},async t=>{const {h,args}=await setup();t.after(()=>h.close());const result=await h.service.startRun(h.alice,args,h.call());assert.equal(result.call_result,'ok',JSON.stringify(result.errors));assert.equal(result.run?.pack_space,h.alice.id);});

for(const type of ['doc:doc','synthetic:case'])test(`old personal declarations cannot read ${type} at start_run`,{skip},async t=>{
  const {h,args}=await setup();t.after(()=>h.close());h.review.workflow.inputs[0].accepts.push(type);
  t.mock.method(h.external,'accepts',async()=>{assert.fail('personal declarations must be refused before routing to a team resource');});
  const result=await h.service.startRun(h.alice,args,h.call());assert.equal(result.errors[0]?.code,'PACK_PERSONAL_CAPABILITY_DENIED');assert.equal(result.run,undefined);
});

test('a personal expected-source function cannot borrow team credentials or named documents',{skip},async t=>{
  const {h,args}=await setup();t.after(()=>h.close());
  await writeFile(join(h.review.pack.directory,'functions/personal-expected.ts'),"export default()=>({sources:[{external:'doc:doc:synthetic-admin-only',role:'expected',reason:'合成来源'},{external:'synthetic:case:team',role:'expected',reason:'合成来源'}],warnings:[]});");
  h.review.workflow.expected_sources={module:'functions/personal-expected.ts'};
  t.mock.method(h.external,'accepts',async()=>{assert.fail('no team resource may be routed');});
  const result=await h.service.startRun(h.alice,args,h.call());assert.equal(result.errors[0]?.code,'PACK_PERSONAL_CAPABILITY_DENIED');assert.equal(result.run,undefined);
});

test('a personal projection cannot request a lease even without declaring its namespace',{skip},async t=>{
  const {h,args}=await setup();t.after(()=>h.close());
  await writeFile(join(h.review.pack.directory,'functions/personal-project.ts'),"export default()=>({items:[],warnings:[],lease_requests:[{keys:['bed/synthetic'],op:'acquire'}]});");
  h.review.workflow.projection={module:'functions/personal-project.ts'};
  const result=await h.service.startRun(h.alice,args,h.call());assert.equal(result.errors[0]?.code,'PACK_PERSONAL_CAPABILITY_DENIED');assert.equal(result.run,undefined);
});

test('a personal workflow cannot bind a raw business-system capture without a knowledge-space grant',{skip},async t=>{
  const {h,args}=await setup();t.after(()=>h.close());
  const source=await h.kit.artifacts.ingest({bytes:toyMap(standardDocument()),mediaType:'application/json',origin:{read:{object:'synthetic:case:team'}},author:{user:null},provenanceType:'observed',visibility:{readers:[h.alice.id],admins:true,packs:[],shareable:false}});
  args.inputs.map.reference='src:'+source.body.sha256;
  Object.assign(args.inputs.map,{artifact:source.digest});
  const result=await h.service.startRun(h.alice,args,h.call());assert.equal(result.errors[0]?.code,'PACK_PERSONAL_CAPABILITY_DENIED');assert.equal(result.run,undefined);
});

test('old personal leases and dispatch effects are refused before starting a run',{skip},async t=>{
  const {h,args}=await setup();t.after(()=>h.close());h.review.workflow.context=['leases'];h.review.workflow.leases={prefix:'bed/'};
  let result=await h.service.startRun(h.alice,args,h.call());assert.equal(result.errors[0]?.code,'PACK_PERSONAL_CAPABILITY_DENIED');
  delete h.review.workflow.leases;delete h.review.workflow.context;
  h.review.effects=[{id:'synthetic',resource_kind:'executor',action:'submit',effect_class:'job',parameters:{values:{kind:['synthetic']}},release:{requirements:['findings'],artifact:'findings'},trigger:'runner_session',budget:{count:1,duration_ms:1000},deadline_ms:1000,optional:false,policy_checks:['synthetic']}];
  result=await h.service.startRun(h.alice,args,h.call());assert.equal(result.errors[0]?.code,'PACK_PERSONAL_CAPABILITY_DENIED');assert.equal(result.run,undefined);
});
