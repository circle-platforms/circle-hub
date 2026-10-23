// Synthetic end-to-end contribution runs: real knowledge, records, resolver and pack sandbox.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DOCUMENT_OUTPUT_KIND, TASK_OUTPUT_KIND } from '../../../contracts/generated/vocabulary.ts';
import { SubmitResultOutput } from '../../../contracts/src/tools.ts';
import { canonicalize, LimitError } from '../../records/api.ts';
import { createDefaultRegistry } from '../../refs/api.ts';
import { startPostgres, type TemporaryPostgres } from '../../testing/postgres.ts';
import { makeWorld, catalogXml, BASE_CATALOG } from '../../knowledge/test-support.ts';
import { createRunsService } from './api.ts';
import { FakeWorkflowStore } from './testing/workflows.ts';
import { toolText } from '../../server/text.ts';

let postgres: TemporaryPostgres;
before(async () => { postgres = await startPostgres(); });
after(async () => { await postgres?.stop(); });
const build = (name: string) => ({name, family:'ACME',line:'1.2',base:name,platform:null,built_at:'2026-01-02T10:00:00.000Z',released_at:'2026-01-03T10:00:00.000Z',sources:{tree:`site:tree:${name}`},root:null});
const call = {traceId:'4bf92f3577b34da6a3ce929d0e0e4736',sessionId:'integration-session'};

test('raw original and relation quotations never escape the actual reader source permissions',async t=>{
  const w=await setup(t,{hiddenOriginal:true});
  const args=w.args();const hidden='仅原件中存在的合成说明';
  args.items[0].slots.contribution[0].text=hidden;
  args.items[0].slots.contribution[0].data.source={reference:`src:${w.original}`,quote:hidden};
  args.items[3].slots.contribution[0].data.relation!.other={reference:`src:${w.original}`,quote:hidden};
  const answer=await w.service.submitResult(w.admin,args,call);
  assert.equal(answer.result?.contributions?.stored.length,4,JSON.stringify(answer.errors));
  assert.equal(await w.kit.artifacts.source(w.user,w.original),null);
  for(const index of [0,3])assert.equal(await w.knowledge.layers.contributions.read(answer.result!.contributions!.stored[index].record,w.user),null);
  const page=await w.knowledge.getNodes({root:w.root,paths:['/commands/system/show'],depth:0},w.user);
  assert.equal(page!.nodes[0].contributions?.length,2,'tree quotations stay readable, raw originals remain protected');
  assert.ok(!JSON.stringify(page).includes(hidden));
  assert.ok(!toolText('get_nodes',{call_result:'ok',errors:[],trace:call.traceId,root:w.root,nodes:page!.nodes}).includes(hidden));
});

async function setup(t: {after(fn:()=>Promise<void>):void}, options: {task?:boolean;declaredRoot?:boolean;wrappedDeclaration?:boolean;refute?:boolean;acceptedRoot?:boolean;hiddenOriginal?:boolean} = {}) {
  const w = await makeWorld(postgres); t.after(()=>w.close());
  const b = build('Rel_ACME_1_2_15');
  w.external.set(b.sources.tree,{bytes:new TextEncoder().encode(catalogXml(BASE_CATALOG)+(options.hiddenOriginal?'<!-- 仅原件中存在的合成说明 -->':'')),mediaType:'application/xml'});
  if(options.declaredRoot || options.wrappedDeclaration) {
    const upload = await w.kit.artifacts.ingest({bytes:new TextEncoder().encode(catalogXml(BASE_CATALOG)),mediaType:'application/xml',origin:{upload:{session:'session-only',message:null}},author:{user:w.admin.id},provenanceType:'declared',visibility:{readers:[w.admin.id],admins:true,packs:[],shareable:false}});
    const artifact = options.wrappedDeclaration ? await w.kit.artifacts.ingest({bytes:new TextEncoder().encode(catalogXml(BASE_CATALOG)),mediaType:'application/xml',origin:{generated:{generator:'synthetic-wrapper@1',inputs:[`src:${upload.body.sha256}`]}},author:{user:null},provenanceType:'projected',visibility:{readers:[],admins:true,packs:[],shareable:false}}) : upload;
    const previous = w.external.read.bind(w.external);
    w.external.read = async (id,ctx) => id === b.sources.tree ? {ok:true,id,revision:null,artifacts:[{name:'original',artifact}],manifest:'synthetic'} : previous(id,ctx);
  }
  if(options.acceptedRoot) {
    const xml=catalogXml({...BASE_CATALOG,system:[BASE_CATALOG.system[0],{name:'show',params:[],help:'show the state https://demo:synthetic-secret@192.0.2.8/path'}]});
    w.external.set(b.sources.tree,{bytes:xml,mediaType:'application/xml'});
    const artifact=await w.kit.artifacts.ingest({bytes:new TextEncoder().encode(xml),mediaType:'application/xml',origin:{read:{object:b.sources.tree}},author:{user:null},provenanceType:'observed',visibility:{readers:[],admins:true,packs:[],shareable:false}});
    await w.kit.artifacts.acceptFindings(w.admin,artifact.body.sha256,'合成演练数据');
  }
  const produced = await w.knowledge.produceTree({product:w.product,build:b});
  assert.ok(produced.ok,produced.reason ?? '');
  const root = produced.root!;
  const composition = await w.knowledge.store.composition(produced.composition!);
  const original = composition!.sources[0].sha256;
  const workflows = new FakeWorkflowStore();
  const pack = await workflows.add(fileURLToPath(new URL('../../../packs/workflow/knowledge-contribution/',import.meta.url)));
  if(options.refute) {
    const previous=pack.readJson.bind(pack);
    pack.readJson=path=>path==='tables/shape.json'?{...previous(path) as object,rules:[{fields:[{path:'/not_present',required:true}]}]}:previous(path);
  }
  if(options.task) {
    // Test a declared task output on an ordinary run; no contribution capability.
    pack.workflow = {...pack.workflow,contribution:undefined,product:{id:w.product.product.id,catalogs:[]},outputs:{tasks:TASK_OUTPUT_KIND.map(kind=>({id:kind,kind}))}};
  }
  const service = createRunsService({records:w.kit,packs:w.packs,knowledge:w.knowledge,external:w.external,workflows,parsers:createDefaultRegistry()});
  const manifest = await w.kit.artifacts.ingest({bytes:new TextEncoder().encode(JSON.stringify({items:DOCUMENT_OUTPUT_KIND.map(kind=>({id:kind,title:kind}))})),mediaType:'application/json',origin:{upload:{session:'integration-session',message:null}},author:{user:w.admin.id},visibility:{readers:[w.admin.id],admins:true,packs:[],shareable:false},provenanceType:'declared'});
  const started = await service.startRun(w.admin,{pack:'knowledge-contribution',product:'Acme',build:b.name,inputs:{subject:{reference:`src:${manifest.body.sha256}`},originals:{reference:`src:${original}`}}},call);
  assert.equal(started.call_result,'ok',JSON.stringify(started.errors));
  const run = started.run!;
  const args = () => ({run:run.run,model:'integration-synthetic@1',items:DOCUMENT_OUTPUT_KIND.map(kind=>({item:kind,handling:'handled',slots:{contribution:[{code:kind,text:`合成${kind}`,data:{root,path:'/commands/system/show',source:{reference:`tree:${root}/commands/system/show`,quote:'show'},...(kind==='relation'?{relation:{kind:'same_subject',other:{reference:`tree:${root}/commands/net/ping`,quote:'ping'}}}:{})}}]}}))});
  return {...w,root,b,run,service,args,original};
}

test('all four document outputs enter only after requirements pass, remain outside the root and are product-readable',async t=>{
  const w = await setup(t);
  const args = w.args();
  const answer = await w.service.submitResult(w.admin,args,call);
  assert.equal(answer.acceptance,'accepted',JSON.stringify(answer.errors));
  assert.equal(answer.counts?.delivered,4,JSON.stringify(answer.result));
  assert.ok(SubmitResultOutput.safeParse({...answer,trace:call.traceId}).success);
  const receipt = answer.result!.contributions!;
  assert.equal(receipt.stored.length,4,JSON.stringify(answer.result)); assert.equal(receipt.not_stored.length,0);
  const page = await w.knowledge.getNodes({root:w.root,paths:['/commands/system/show'],depth:0},w.user);
  const entries = page!.nodes[0].contributions!;
  assert.match(toolText('submit_result',{...answer,trace:call.traceId}),/回注：提交 4 条，入层 4 条，未入层 0 条/);
  const rendered=toolText('get_nodes',{call_result:'ok',errors:[],trace:call.traceId,root:w.root,nodes:page!.nodes});
  assert.match(rendered,/回注层/);assert.match(rendered,/提交人/);assert.match(rendered,/依据/);assert.match(rendered,new RegExp(receipt.stored[0].record));
  assert.deepEqual(entries.map(v=>v.contribution.kind),DOCUMENT_OUTPUT_KIND);
  for(const v of entries) {
    assert.equal(v.contribution.submitted_by,w.admin.id);assert.equal(v.contribution.session,'integration-session');
    assert.equal(v.contribution.source.provenance,'projected');assert.equal(v.contribution.basis_rank,'judgment');
    assert.equal(v.contribution.applicability,null); assert.equal(v.status,'valid');
    assert.ok(v.contribution.submitted_at); assert.ok(await w.knowledge.layers.contributions.read(v.record,w.user));
    assert.equal(await w.knowledge.layers.contributions.read(v.record,w.outsider),null);
  }
  assert.equal(await w.knowledge.getNodes({root:w.root,paths:['/commands/system/show'],depth:0},w.outsider),null);
  assert.deepEqual(await w.service.submitResult(w.admin,args,call),answer,'repeat has the same stored receipt');
  assert.equal((await w.knowledge.layers.contributions.list(w.root,['/commands/system/show'],w.user)).length,4);
  assert.equal((await w.knowledge.produceTree({product:w.product,build:w.b})).root,w.root);
  const submission = (await w.kit.store.find({key:'runs.submission.run',value:w.run.run,kind:'submission'})).items[0];
  assert.deepEqual(submission.body,args,'contribution submissions are stored in full');
});

for(const kind of DOCUMENT_OUTPUT_KIND) test(`${kind}: a non-verbatim quotation refuses admission`,async t=>{
  const w=await setup(t);const args=w.args();
  const entry=args.items.find(i=>i.item===kind)!;entry.slots.contribution[0].data.source.quote='NEVER IN THE ORIGINAL';
  const result=await w.service.submitResult(w.admin,args,call);
  assert.equal(result.acceptance,'not_accepted');assert.ok(result.errors.some(e=>e.code==='QUOTE_MISMATCH'));
  assert.equal(result.result?.contributions?.not_stored.length,4);
  assert.match(toolText('submit_result',{...result,trace:call.traceId}),/回注：提交 4 条，入层 0 条，未入层 4 条/);
  assert.equal((await w.knowledge.layers.contributions.list(w.root,['/commands/system/show'],w.user)).length,0);
});

test('missing path, an invented applicability/provenance, wrong root and a missing relation endpoint refuse admission',async t=>{
  const w=await setup(t);
  for(const patch of [{path:'/absent'},{applicability:{models:['fiction']}},{provenance:'observed'},{root:'f'.repeat(64)},{relation:{kind:'contradicts'}}]){
    const args=w.args();Object.assign(args.items[0].slots.contribution[0].data,patch);
    const answer=await w.service.submitResult(w.admin,args,call);
    assert.equal(answer.acceptance,'not_accepted',JSON.stringify(patch));
  }
  assert.equal((await w.knowledge.layers.contributions.list(w.root,['/commands/system/show'],w.user)).length,0);
});

test('a bound Hub source outside the locked root is rejected with the version boundary, an unbound source never escapes scope',async t=>{
  const w=await setup(t);
  const extra=await w.kit.artifacts.ingest({bytes:new TextEncoder().encode('show outside root'),mediaType:'text/plain',origin:{read:{object:'site:document:outside'}},author:{user:null},provenanceType:'observed',visibility:{readers:[],admins:true,packs:[],shareable:false}});
  const args=w.args();args.items[0].slots.contribution[0].data.source.reference=`src:${extra.body.sha256}`;
  const unbound=await w.service.submitResult(w.admin,args,call);
  assert.equal(unbound.acceptance,'not_accepted');assert.match(JSON.stringify(unbound.errors),/没有绑定/);
  // Bind another run, but the root remains unchanged.
  const stored=await w.service.getRun(w.admin,w.run.run);assert.ok(stored);
  const manifest=(await w.kit.store.find({key:'runs.id',value:w.run.run,kind:'run'})).items[0].body as {sources:Array<{slot?:string;reference:string}>};
  const start=await w.service.startRun(w.admin,{pack:'knowledge-contribution',product:'Acme',build:w.b.name,inputs:{subject:{reference:manifest.sources.find(s=>s.slot==='subject')!.reference},originals:[{reference:`src:${w.original}`},{reference:`src:${extra.body.sha256}`}] }},call);
  assert.equal(start.call_result,'ok',JSON.stringify(start.errors));
  const outside=await w.service.submitResult(w.admin,{...args,run:start.run!.run},call);
  assert.equal(outside.acceptance,'not_accepted');assert.match(JSON.stringify(outside.errors),/来源不在锁定的根里，这一版不收/);
});

test('new root annotates changed fragments, while the contribution remains valid at its original root',async t=>{
  const w=await setup(t);await w.service.submitResult(w.admin,w.args(),call);
  const b=build('Rel_ACME_1_2_16');w.external.set(b.sources.tree,{bytes:catalogXml({...BASE_CATALOG,system:[BASE_CATALOG.system[0],{name:'show',params:[],help:'show the full state'}]}),mediaType:'application/xml'});
  const next=await w.knowledge.produceTree({product:w.product,build:b});assert.ok(next.ok);
  const changed=await w.knowledge.layers.contributions.list(next.root!,['/commands/system/show'],w.user);
  assert.equal(changed.length,4);assert.ok(changed.every(v=>v.status==='cited_fragment_changed'&&v.note?.includes('被引片段已变')));
  assert.ok((await w.knowledge.layers.contributions.list(w.root,['/commands/system/show'],w.user)).every(v=>v.status==='valid'));
});

test('declared task outputs remain in ordinary run records and never populate the contribution layer',async t=>{
  const w=await setup(t,{task:true});
  const args={...w.args(),task_outputs:TASK_OUTPUT_KIND.map(output=>({output,value:{synthetic:output}}))};
  const result=await w.service.submitResult(w.admin,args,call);
  assert.equal(result.acceptance,'accepted',JSON.stringify(result.errors));assert.equal(result.result?.contributions,undefined);
  assert.equal((await w.knowledge.layers.contributions.list(w.root,['/commands/system/show'],w.user)).length,0);
  const stored=(await w.kit.store.find({key:'runs.submission.run',value:w.run.run,kind:'submission'})).items[0];
  assert.equal(canonicalize(stored.body),canonicalize(args));
});

test('session declarations, including a generated wrapper, require a signature and never enter the layer',async t=>{
  for (const options of [{declaredRoot:true},{wrappedDeclaration:true}]) {
    const w=await setup(t,options);
    const answer=await w.service.submitResult(w.admin,w.args(),call);
    assert.equal(answer.acceptance,'not_accepted',JSON.stringify(answer));
    assert.match(JSON.stringify(answer.errors),/需要负责人署名，署名流程以后做/);
    assert.equal((await w.knowledge.layers.contributions.list(w.root,['/commands/system/show'],w.user)).length,0);
  }
});

test('tree original and relation endpoints resolve at the locked root, both quotations are checked',async t=>{
  const w=await setup(t);const args=w.args();
  const source=args.items[0].slots.contribution[0].data.source;
  source.reference=`tree:${w.root}/commands/system/show`;source.quote='show';
  const accepted=await w.service.submitResult(w.admin,args,call);
  assert.equal(accepted.result?.contributions?.stored.length,4,JSON.stringify(accepted.errors));
  assert.equal((await w.knowledge.layers.contributions.list(w.root,['/commands/system/show'],w.user))[0].contribution.source.provenance,'projected');
  args.items[3].slots.contribution[0].data.relation!.other.quote='no such original';
  const rejected=await w.service.submitResult(w.admin,args,call);
  assert.equal(rejected.acceptance,'not_accepted');assert.ok(rejected.errors.some(e=>e.item==='relation'&&e.code==='QUOTE_MISMATCH'));
});

test('administrators pass the product rule too; re-submission observes permission revocation',async t=>{
  const w=await setup(t);const answer=await w.service.submitResult(w.admin,w.args(),call);
  const digest=answer.result!.contributions!.stored[0].record;
  const previous=w.packs.readableProducts.bind(w.packs);
  w.packs.readableProducts=async user=>user.id===w.admin.id ? new Set() : previous(user);
  assert.equal(await w.knowledge.layers.contributions.read(digest,w.admin),null);
  assert.deepEqual(await w.knowledge.layers.contributions.list(w.root,['/commands/system/show'],w.admin),[]);
  assert.equal((await w.service.submitResult(w.admin,w.args(),call)).acceptance,'not_accepted','does not replay a stale successful admission');
});

test('a handled artifact with a refuted requirement is not admitted',async t=>{
  const w=await setup(t,{refute:true});
  const result=await w.service.submitResult(w.admin,w.args(),call);
  assert.equal(result.acceptance,'accepted');
  assert.equal(result.result?.contributions?.stored.length,0);
  assert.equal(result.result?.contributions?.not_stored.length,4);
  assert.match(toolText('submit_result',{...result,trace:call.traceId}),/未入层条目 classification：要求项尚未全部满足/);
  assert.equal((await w.knowledge.layers.contributions.list(w.root,['/commands/system/show'],w.user)).length,0);
});

test('a layer write failure rolls back every contribution before the not-accepted receipt is stored',async t=>{
  const w=await setup(t);
  const layer=w.knowledge.layers.contributions;const append=layer.append.bind(layer);let writes=0;
  layer.append=async (...args)=>{if(++writes===2)throw new LimitError('synthetic layer size failure');return append(...args);};
  const result=await w.service.submitResult(w.admin,w.args(),call);
  assert.equal(result.acceptance,'not_accepted');assert.ok(result.errors.some(e=>e.code==='SUBMISSION_SCHEMA_VIOLATION'));
  assert.equal((await w.knowledge.layers.contributions.list(w.root,['/commands/system/show'],w.user)).length,0);
});


test('a revoked source acceptance withholds contribution copies and re-submission rechecks it',async t=>{
  const w=await setup(t,{acceptedRoot:true});const result=await w.service.submitResult(w.admin,w.args(),call);
  assert.equal(result.result?.contributions?.stored.length,4,JSON.stringify(result.errors));
  const digest=result.result!.contributions!.stored[0].record;
  assert.ok(await w.knowledge.layers.contributions.read(digest,w.user));
  await w.kit.artifacts.revokeFindings(w.admin,w.original,'结束合成演练');
  assert.equal(await w.knowledge.layers.contributions.read(digest,w.user),null);
  assert.deepEqual(await w.knowledge.layers.contributions.list(w.root,['/commands/system/show'],w.user),[]);
  assert.equal((await w.service.submitResult(w.admin,w.args(),call)).acceptance,'not_accepted');
});
