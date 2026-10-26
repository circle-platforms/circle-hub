import {osIsolationAvailable} from '../../rules/api.ts';
// Synthetic end-to-end contribution runs: real knowledge, records, resolver and pack sandbox.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DOCUMENT_OUTPUT_KIND, TASK_OUTPUT_KIND, VALIDITY_STATUS_LABEL, labelOf } from '../../../contracts/generated/vocabulary.ts';
import { GetNodesOutput, SubmitResultOutput } from '../../../contracts/src/tools.ts';
import { KnowledgeContributionBody, KnowledgeContributionView } from '../../../contracts/src/contributions.ts';
import { CORE_VIOLATION_CODES, PROTOCOL_CODES } from '../../../contracts/generated/protocol.ts';
import { canonicalBytes,canonicalize, LimitError, type FindQuery, type Transaction } from '../../records/api.ts';
import { createDefaultRegistry } from '../../refs/api.ts';
import { startPostgres, type TemporaryPostgres } from '../../testing/postgres.ts';
import { makeWorld, catalogXml, BASE_CATALOG, DEFAULT_PRODUCERS, extraProducer } from '../../knowledge/test-support.ts';
import { createRunsService } from './api.ts';
import { FakeWorkflowStore } from './testing/workflows.ts';
import { toolText } from '../../server/text.ts';

const GENERIC_OUTPUTS=DOCUMENT_OUTPUT_KIND.filter(kind=>kind!=='applicability_claim');
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

test('contribution retries return the stored receipt without actions or effects, including a second session',async t=>{
  const w=await setup(t);const args=w.args();
  const first=await w.service.submitResult(w.admin,args,call);
  const count=async()=>({results:(await w.kit.store.find({key:'runs.result.run',value:w.run.run,kind:'validation_result',limit:100})).items.length,actions:(await w.kit.store.find({key:'runs.action.run',value:w.run.run,kind:'action',limit:100})).items.length});
  const before=await count();
  assert.deepEqual(await w.service.submitResult(w.admin,args,{...call,traceId:'f'.repeat(32)}),first);
  assert.deepEqual(await count(),before);
  assert.deepEqual(await w.service.submitResult(w.admin,args,{...call,sessionId:'another-integration-session',traceId:'e'.repeat(32)}),first);
  assert.deepEqual(await count(),before);
  assert.equal((await w.knowledge.layers.contributions.list(w.root,['/commands/system/show'],w.admin)).length,4);
});

test('public contribution records omit private run links and identical content is shared across runs and models',async t=>{
  const w=await setup(t);const first=await w.service.submitResult(w.admin,w.args(),call);
  const run=await withReference(w,`src:${w.original}`);const second=await w.service.submitResult(w.admin,{...w.args(),run:run.run,model:'another-model'}, {...call,sessionId:'another-session'});
  assert.deepEqual(second.result?.contributions?.stored.map(x=>x.record),first.result?.contributions?.stored.map(x=>x.record));
  const entries=await w.knowledge.layers.contributions.list(w.root,['/commands/system/show'],w.user);assert.equal(entries.length,4);
  for(const entry of entries){
    assert.ok(!('run'in entry.contribution));assert.ok(!('submission'in entry.contribution));
    const record=await w.knowledge.layers.contributions.read(entry.record,w.user);assert.ok(record);
    assert.ok(!('run'in (record.body as object)));assert.ok(!('submission'in (record.body as object)));
  }
});

test('a refused digest stays refused after source recovery; a new submission can be verified',async t=>{
  const w=await setup(t,{acceptedRoot:true});const args=w.args();
  await w.kit.artifacts.revokeFindings(w.admin,w.original,'合成撤回');
  const first=await w.service.submitResult(w.admin,args,call);assert.equal(first.result?.contributions?.stored.length,0);assert.equal(first.result?.contributions?.not_stored.length,4);
  await w.kit.artifacts.acceptFindings(w.admin,w.original,'合成恢复');
  assert.deepEqual(await w.service.submitResult(w.admin,args,{...call,sessionId:'new-session'}),first);
  const changed=await w.service.submitResult(w.admin,{...args,notes:'读取条件已恢复，申请重新核验'},call);
  assert.equal(changed.result?.contributions?.stored.length,4,JSON.stringify(changed.errors));
});

async function setup(t: {after(fn:()=>Promise<void>):void}, options: {ordinary?:boolean;task?:boolean;declaredRoot?:boolean;wrappedDeclaration?:boolean;refute?:boolean;acceptedRoot?:boolean;hiddenOriginal?:boolean;pageBytes?:number;treeEntries?:number;nodePath?:string;modern?:boolean} = {}) {
  const w = await makeWorld(postgres,{knowledge:{limits:{pageBytes:options.pageBytes??2*1024*1024}},pack:{declaration:{producers:[...DEFAULT_PRODUCERS.map(p=>({...p,placement:'judgment_allowed'})),...((options.treeEntries||options.nodePath)?[extraProducer('large_tree',{entries:Array.from({length:options.treeEntries??1},(_,i)=>({kind:'behaviour',path:options.nodePath??'/commands/system/show',statement:'合成树条目 '+i+' '+ 'tree '.repeat(400),data:{i},fragments:[{parser:'xml@1',selector:'x/catalog/group[1]'}],applicability:null}))},undefined,'judgment_allowed')]:[])]}}}); t.after(()=>w.close());
  const b = options.modern?{...build('rel_acme_10_6_1'),line:'10.6'}:build('Rel_ACME_1_2_15');
  w.external.set(b.sources.tree,{bytes:new TextEncoder().encode(catalogXml(BASE_CATALOG)+(options.hiddenOriginal?'<!-- 仅原件中存在的合成说明 -->':'')),mediaType:'application/xml'});
  if(options.declaredRoot || options.wrappedDeclaration) {
    const upload = await w.kit.artifacts.ingest({bytes:new TextEncoder().encode(catalogXml(BASE_CATALOG)),mediaType:'application/xml',origin:{upload:{session:'session-only',message:null}},author:{user:w.admin.id},provenanceType:'declared',visibility:{readers:[w.admin.id],admins:true,packs:[],shareable:false}});
    const artifact = options.wrappedDeclaration ? await w.kit.artifacts.ingest({bytes:new TextEncoder().encode(catalogXml(BASE_CATALOG)),mediaType:'application/xml',origin:{generated:{generator:'synthetic-wrapper@1',inputs:[`src:${upload.body.sha256}`]}},author:{user:null},provenanceType:'projected',visibility:{readers:[],admins:true,packs:[],shareable:false}}) : upload;
    const previous = w.external.read.bind(w.external);
    w.external.read = async (id,ctx) => id === b.sources.tree ? {ok:true,id,revision:null,artifacts:[{name:'original',artifact}],manifest:'synthetic'} : previous(id,ctx);
  }
  if(options.acceptedRoot) {
    const xml=catalogXml({...BASE_CATALOG,system:[BASE_CATALOG.system[0],{name:'show',params:[],help:["show t","he sta","te htt","ps://d","emo:sy","ntheti","c-secr","et@192",".0.2.8","/path"].join('')}]});
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
  if(options.ordinary) {
    const { contribution: _contribution, ...ordinary } = pack.workflow; pack.workflow = {...ordinary,product:{id:w.product.product.id,catalogs:[]}};
    pack.requirements.push(...['first','second'].map(key => ({...pack.requirements[0], key, target:'run' as const, required:false, error_handling:[{code:'*',action:'repair' as const,max_rounds:3}]})));
    pack.slots.run = { first: {min:0,max:1,codes:[{code:'first_code',label:'合成第一项'}]}, second:{min:0,max:1,codes:[{code:'second_code',label:'合成第二项'}]} };
  }
  if(options.refute) {
    const previous=pack.readJson.bind(pack);
    pack.readJson=path=>path==='tables/shape.json'?{...previous(path) as object,rules:[{fields:[{path:'/not_present',required:true}]}]}:previous(path);
  }
  if(options.task) {
    // Per-task outputs coexist with document contributions, but must never enter the knowledge layer.
    pack.workflow = {...pack.workflow,product:{id:w.product.product.id,catalogs:[]},outputs:{tasks:TASK_OUTPUT_KIND.map(kind=>({id:kind,kind}))}};
  }
  const service = createRunsService({sandbox:{requireOsIsolation:await osIsolationAvailable()},records:w.kit,packs:w.packs,knowledge:w.knowledge,external:w.external,workflows,parsers:createDefaultRegistry()});
  const manifest = await w.kit.artifacts.ingest({bytes:new TextEncoder().encode(JSON.stringify({items:GENERIC_OUTPUTS.map(kind=>({id:kind,title:kind}))})),mediaType:'application/json',origin:{upload:{session:'integration-session',message:null}},author:{user:w.admin.id},visibility:{readers:[w.admin.id],admins:true,packs:[],shareable:false},provenanceType:'declared'});
  const started = await service.startRun(w.admin,{pack:'knowledge-contribution',product:'Acme',build:b.name,inputs:{subject:{reference:`src:${manifest.body.sha256}`},originals:{reference:`src:${original}`}}},call);
  assert.equal(started.call_result,'ok',JSON.stringify(started.errors));
  const run = started.run!;
  const args = () => ({run:run.run,model:'integration-synthetic@1',items:GENERIC_OUTPUTS.map(kind=>({item:kind,handling:'handled',slots:{contribution:[{code:kind,text:`合成${kind}`,data:{root,path:options.nodePath??'/commands/system/show',source:{reference:`tree:${root}/commands/system/show`,quote:'show'},...(kind==='relation'?{relation:{kind:'same_subject',other:{reference:`tree:${root}/commands/net/ping`,quote:'ping'}}}:{})}}]}}))});
  return {...w,root,b,run,service,args,original,workflows};
}

async function withOriginal(w:Awaited<ReturnType<typeof setup>>,sha256:string){
  return withReference(w,`src:${sha256}`);
}
async function withReference(w:Awaited<ReturnType<typeof setup>>,reference:string){
  const started=await w.service.startRun(w.admin,{pack:'knowledge-contribution',product:'Acme',build:w.b.name,inputs:{subject:{reference:w.run.sources.find(s=>s.slot==='subject')!.reference},originals:[{reference:`src:${w.original}`},{reference}] }},call);
  assert.equal(started.call_result,'ok',JSON.stringify(started.errors));return started.run!;
}

test('branch listings and bound records name the missing original rather than claiming outside-root membership',async t=>{
  const w=await setup(t);const args=w.args();args.items[0].slots.contribution[0].data.source={reference:`tree:${w.root}/commands/system`,quote:'reboot'};
  const branch=await w.service.submitResult(w.admin,args,call);
  assert.ok(branch.errors.some(e=>e.code==='core.contribution.source_not_original'&&e.message.includes('子节点名单')));
  const record=(await w.kit.store.find({key:'runs.id',value:w.run.run,kind:'run'})).items[0];
  const run=await withReference(w,`rec:${record.digest}#/pack`);const quoted={...w.args(),run:run.run};
  quoted.items[0].slots.contribution[0].data.source={reference:`rec:${record.digest}#/pack`,quote:'knowledge-contribution'};
  const relay=await w.service.submitResult(w.admin,quoted,call);
  assert.equal(relay.acceptance,'accepted');assert.equal(relay.result?.contributions?.stored.length,3);
  assert.ok(relay.errors.some(e=>e.code==='core.contribution.record_not_original'&&e.message.includes('原文片段')));
  await w.service.submitResult(w.admin,w.args(),call);
  const submission=(await w.kit.store.find({key:'runs.submission.run',value:w.run.run,kind:'submission'})).items[0];
  const human=await withReference(w,`rec:${submission.digest}#/model`);const humanArgs={...w.args(),run:human.run};
  humanArgs.items[0].slots.contribution[0].data.source={reference:`rec:${submission.digest}#/model`,quote:'integration-synthetic'};
  const declared=await w.service.submitResult(w.admin,humanArgs,call);
  assert.ok(declared.errors.some(e=>e.code==='core.contribution.signature_required'));
});

test('one outside-root source refutes only its verified requirement and leaves other entries admissible',async t=>{
  const w=await setup(t);
  const extra=await w.kit.artifacts.ingest({bytes:new TextEncoder().encode('show outside'),mediaType:'text/plain',origin:{read:{object:'site:document:outside'}},author:{user:null},provenanceType:'observed',visibility:{readers:[],admins:true,packs:[],shareable:false}});
  const run=await withOriginal(w,extra.body.sha256);const args={...w.args(),run:run.run};
  args.items[0].slots.contribution[0].data.source={reference:`src:${extra.body.sha256}`,quote:'show'};
  const result=await w.service.submitResult(w.admin,args,call);
  assert.equal(result.acceptance,'accepted',JSON.stringify(result.errors));
  assert.equal(result.result?.contributions?.stored.length,3);assert.equal(result.result?.contributions?.not_stored.length,1);
  const refusal=result.errors.find(e=>e.item==='classification')!;
  assert.equal(refusal.code,'core.contribution.source_outside_root');assert.equal(refusal.requirement,'verified');assert.match(refusal.fix??'',/skipped/);
});

test('membership uses the run locked composition when a later build shares the root with different source bytes',async t=>{
  const w=await setup(t);const secondBuild=build('Rel_ACME_1_2_16');
  w.external.set(secondBuild.sources.tree,{bytes:catalogXml(BASE_CATALOG)+'\n',mediaType:'application/xml'});
  const later=await w.knowledge.produceTree({product:w.product,build:secondBuild});
  assert.ok(later.ok);assert.equal(later.root,w.root);
  const args=w.args();for(const item of args.items)item.slots.contribution[0].data.source={reference:`src:${w.original}`,quote:'show'};
  const result=await w.service.submitResult(w.admin,args,call);
  assert.equal(result.result?.contributions?.stored.length,4,JSON.stringify(result.errors));
  for(const entry of await w.knowledge.layers.contributions.list(w.root,['/commands/system/show'],w.admin))assert.deepEqual(entry.contribution.source.sources,[w.original]);
});

test('a run-bound session excerpt needs a signature before root membership is considered',async t=>{
  const w=await setup(t);
  const extra=await w.kit.artifacts.ingest({bytes:new TextEncoder().encode('show session statement'),mediaType:'text/plain',origin:{upload:{session:'session-only',message:null}},author:{user:w.admin.id},provenanceType:'declared',visibility:{readers:[w.admin.id],admins:true,packs:[],shareable:false}});
  const run=await withOriginal(w,extra.body.sha256);const args={...w.args(),run:run.run};
  args.items[0].slots.contribution[0].data.source={reference:`src:${extra.body.sha256}`,quote:'show'};
  const result=await w.service.submitResult(w.admin,args,call);
  assert.equal(result.acceptance,'accepted');assert.equal(result.result?.contributions?.stored.length,3);
  assert.ok(result.errors.some(e=>e.code==='core.contribution.signature_required'&&e.message.includes('需要负责人署名')));
});

test('sensitive contribution text is refused before it reaches the product layer',async t=>{
  const w=await setup(t);const args=w.args();const secret=["https:","//demo",":synth","etic-s","ecret@","192.0.","2.8/pa","th"].join('');args.items[0].slots.contribution[0].text=secret;
  const result=await w.service.submitResult(w.admin,args,call);
  assert.equal(result.result?.contributions?.stored.length,3);
  assert.ok(result.errors.some(e=>e.code==='CREDENTIAL_IN_UPLOAD'));
  const page=await w.knowledge.getNodes({root:w.root,paths:['/commands/system/show'],depth:0},w.user);
  assert.ok(!JSON.stringify(page).includes(secret));
});

test('credential scanning also covers both quote fields and prevents self relations',async t=>{
  const secret=["https:","//demo",":synth","etic-s","ecret@","192.0.","2.8/pa","th"].join('');
  for(const other of [false,true]){
    const w=await setup(t,{acceptedRoot:true});const args=w.args();
    const quote={reference:`src:${w.original}`,quote:secret};
    if(other)args.items[3].slots.contribution[0].data.relation!.other=quote;else args.items[0].slots.contribution[0].data.source=quote;
    const result=await w.service.submitResult(w.admin,args,call);
    assert.equal(result.result?.contributions?.stored.length,3,JSON.stringify(result.errors));
    assert.ok(result.errors.some(e=>e.code==='CREDENTIAL_IN_UPLOAD'));
    assert.ok(!JSON.stringify(await w.knowledge.layers.contributions.list(w.root,['/commands/system/show'],w.admin)).includes(secret));
  }
  const w=await setup(t);const args=w.args();args.items[3].slots.contribution[0].data.relation!.other={...args.items[3].slots.contribution[0].data.source};
  const result=await w.service.submitResult(w.admin,args,call);
  assert.equal(result.result?.contributions?.stored.length,3);assert.ok(result.errors.some(e=>e.code==='core.contribution.self_relation'));
});

test('a noncanonical target path still receives a stored boundary receipt with a repair action',async t=>{
  const w=await setup(t);const args=w.args();args.items[0].slots.contribution[0].data.path='/commands/system/sh%6Fw';
  const result=await w.service.submitResult(w.admin,args,call);
  assert.equal(result.acceptance,'not_accepted');assert.ok(result.errors.some(e=>e.code==='REFERENCE_UNRESOLVED'&&e.message.includes('规范写法')&&e.item==='classification'));
  assert.ok((await w.service.getRun(w.admin,w.run.run))?.latest===null);
  assert.equal((await w.kit.store.find({key:'runs.result.run',value:w.run.run,kind:'validation_result'})).items.length,1);
});

test('layer boundary errors consume the verified diagnostic budget and expose zero rounds after two repairs',async t=>{
  const w=await setup(t);
  for(let i=0;i<3;i++){
    const args=w.args();args.items[0].slots.contribution[0].data.source.quote=`not present ${i}`;
    const result=await w.service.submitResult(w.admin,args,call);const error=result.errors.find(e=>e.code==='QUOTE_MISMATCH')!;
    assert.equal(error.requirement,'verified');assert.equal(error.rounds_left,Math.max(0,2-i));
  }
});

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
  assert.ok(GetNodesOutput.safeParse({call_result:'ok',errors:[],trace:call.traceId,root:w.root,...page}).success);
  const entries = page!.nodes[0].contributions!.map(view=>KnowledgeContributionView.parse(view));
  assert.match(toolText('submit_result',{...answer,trace:call.traceId}),/回注：提交 4 条，入层 4 条，未入层 0 条/);
  const rendered=toolText('get_nodes',{call_result:'ok',errors:[],trace:call.traceId,root:w.root,nodes:page!.nodes});
  assert.match(rendered,/回注层/);assert.match(rendered,/提交人/);assert.match(rendered,/依据/);assert.match(rendered,new RegExp(receipt.stored[0].record));
  assert.match(rendered.split('\n').find(line=>line.includes(`rec:${receipt.stored[0].record}`))!,/适用 未声明/);
  assert.deepEqual(entries.map(v=>v.contribution.kind).sort(),[...GENERIC_OUTPUTS].sort());
  assert.deepEqual(entries.map(v=>v.contribution.submitted_at),entries.map(v=>v.contribution.submitted_at).sort().reverse(),'node contribution pages are newest first');
  const storedRelation=entries.find(v=>v.contribution.kind==='relation')!.contribution.relation!;
  assert.equal(storedRelation.kind,'same_subject');assert.equal(storedRelation.other.reference,`tree:${w.root}/commands/net/ping`);
  assert.equal(storedRelation.other.provenance,'projected');assert.ok(storedRelation.other.records.length>0);assert.ok(storedRelation.other.sources.length>0);
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

test('a stored contradiction records its endpoints without editing the second node',async t=>{
  const w=await setup(t);const before=await w.knowledge.getNodes({root:w.root,paths:['/commands/net/ping'],depth:0},w.user);
  const args=w.args();args.items[3].slots.contribution[0].data.relation!.kind='contradicts';
  const result=await w.service.submitResult(w.admin,args,call);assert.equal(result.result?.contributions?.stored.length,4);
  const page=await w.knowledge.getNodes({root:w.root,paths:['/commands/system/show'],depth:0},w.user);
  const relation=page!.nodes[0].contributions!.map(view=>KnowledgeContributionView.parse(view)).find(v=>v.contribution.kind==='relation')!.contribution.relation!;
  assert.equal(relation.kind,'contradicts');assert.equal(relation.other.reference,`tree:${w.root}/commands/net/ping`);
  assert.deepEqual((await w.knowledge.getNodes({root:w.root,paths:['/commands/net/ping'],depth:0},w.user))!.nodes,before!.nodes);
  assert.match(toolText('get_nodes',{call_result:'ok',errors:[],trace:call.traceId,root:w.root,nodes:page!.nodes}),new RegExp(`关系 ${labelOf('relation_kind','contradicts')} →`));
});

test('every kind reports its own path rule, and quotes use the boundary whitespace comparator',async t=>{
  const w=await setup(t);
  for(const kind of GENERIC_OUTPUTS){
    const args=w.args();args.items.find(x=>x.item===kind)!.slots.contribution[0].data.path='/absent';
    const result=await w.service.submitResult(w.admin,args,call);
    assert.ok(result.errors.some(e=>e.item===kind&&e.code==='REFERENCE_UNRESOLVED'&&e.message.includes('归位路径在锁定的根里解析不出')));
    const root=w.args();root.items.find(x=>x.item===kind)!.slots.contribution[0].data.root='f'.repeat(64);
    const wrong=await w.service.submitResult(w.admin,root,call);assert.ok(wrong.errors.some(e=>e.item===kind&&e.code==='REFERENCE_UNRESOLVED'&&e.message.includes('锁定的产品和根')));
  }
  const args=w.args();args.items[0].slots.contribution[0].data.source={reference:`src:${w.original}`,quote:'show   the\n state'};
  const ok=await w.service.submitResult(w.admin,args,call);assert.equal(ok.result?.contributions?.stored.length,4,JSON.stringify(ok.errors));
  args.items[0].slots.contribution[0].data.source.quote='show   the\n staXe';const no=await w.service.submitResult(w.admin,args,call);
  assert.ok(no.errors.some(e=>e.code==='QUOTE_MISMATCH'&&e.message.includes('引文没有逐字')));
});

test('a nonadmin writes tree-grounded contributions but cannot bind an admin-only original',async t=>{
  const w=await setup(t);w.workflows.assign(w.user.id,'knowledge-contribution');
  const manifest=await w.kit.artifacts.ingest({bytes:new TextEncoder().encode(JSON.stringify({items:GENERIC_OUTPUTS.map(id=>({id,title:id}))})),mediaType:'application/json',origin:{upload:{session:'user-session',message:null}},author:{user:w.user.id},provenanceType:'declared',visibility:{readers:[w.user.id],admins:true,packs:[],shareable:false}});
  const input={pack:'knowledge-contribution',product:'Acme',build:w.b.name,inputs:{subject:{reference:`src:${manifest.body.sha256}`}}};
  const started=await w.service.startRun(w.user,input,{...call,sessionId:'user-session'});assert.equal(started.call_result,'ok',JSON.stringify(started.errors));
  const originalPage=await w.knowledge.getNodes({root:w.root,paths:['/commands/system/show'],depth:0},w.user);assert.ok(originalPage?.nodes[0].reference);
  const submitted=w.args();for(const item of submitted.items)item.slots.contribution[0].data.source.reference=originalPage.nodes[0].reference;
  const result=await w.service.submitResult(w.user,{...submitted,run:started.run!.run},{...call,sessionId:'user-session'});assert.equal(result.result?.contributions?.stored.length,4,JSON.stringify(result.errors));
  const page=await w.knowledge.getNodes({root:w.root,paths:['/commands/system/show'],depth:0},w.user);
  assert.ok(page!.nodes[0].contributions!.map(view=>KnowledgeContributionView.parse(view)).every(v=>v.contribution.submitted_by===w.user.id));
  assert.ok(GetNodesOutput.safeParse({call_result:'ok',errors:[],trace:call.traceId,root:w.root,...page}).success);
  const denied=await w.service.startRun(w.user,{...input,inputs:{...input.inputs,originals:{reference:`src:${w.original}`}}},call);
  assert.equal(denied.call_result,'error');const neutral=denied.errors.find(e=>e.code==='SOURCE_UNAVAILABLE');assert.equal(neutral?.fix,PROTOCOL_CODES.SOURCE_UNAVAILABLE.fix);
  const published=(await w.workflows.byDigest(started.run!.pack_digest))!;const skill=published.instructions;
  assert.ok(!Object.hasOwn((published.readJson('examples/start-run.json') as {inputs:object}).inputs,'originals'));
  for(const number of ['1.','3.']) {const step=skill.split('\n').find(line=>line.startsWith(number));assert.match(step??'',/非管理员.*tree:.*不绑定 originals/);}
});

test('node contribution pages are bounded, use limited index queries and resume without loss or duplication',async t=>{
  const w=await setup(t);const result=await w.service.submitResult(w.admin,w.args(),call);
  const stored=await w.knowledge.layers.contributions.read(result.result!.contributions!.stored[0].record,w.admin);
  const {submitted_at:_at,model:_model,session:_session,...prepared}=KnowledgeContributionBody.parse(stored!.body);
  await w.kit.store.withTransaction(async tx=>{for(let i=0;i<121;i++)await w.knowledge.layers.contributions.append({...prepared,statement:`分页事实 ${i}`},{run:w.run.run,submission:'a'.repeat(64),session:null,model:'synthetic'},tx);});
  const find=w.kit.store.find.bind(w.kit.store);let queries=0;
  w.kit.store.find=async(query,tx)=>{if(query.key==='knowledge.contribution.node'){queries++;assert.ok((query.limit??1000)<=100,'a page must not load the entire index');}return find(query,tx);};
  const all=new Set<string>();let cursor:string|null=null;let pages=0;
  do{
    const page=await w.knowledge.getNodes({root:w.root,paths:['/commands/system/show'],depth:0,cursor},w.user);assert.ok(page);
    assert.ok(GetNodesOutput.safeParse({call_result:'ok',errors:[],trace:call.traceId,root:w.root,...page}).success);
    assert.ok(Buffer.byteLength(JSON.stringify(page.nodes),'utf8')<=2*1024*1024);
    for(const node of page.nodes){assert.ok((node.contributions?.length??0)<=100);for(const view of node.contributions??[]){assert.ok(!all.has(view.record),'record repeated across pages');all.add(view.record);}}
    if(page.next!==null){assert.equal(page.coverage.complete,false);assert.match(page.coverage.note??'',/回注/);}
    if(pages===0&&page.next!==null)await assert.rejects(w.knowledge.getNodes({root:w.root,paths:['/commands/net/ping'],depth:0,cursor:page.next},w.user),/游标/);
    cursor=page.next;assert.ok(++pages<10,'paging must advance');
  }while(cursor!==null);
  assert.equal(all.size,125);assert.ok(pages>1);assert.ok(queries<400);
});

test('large contribution bodies use bounded references and split tree pages do not repeat overlays',async t=>{
  const large=await setup(t,{pageBytes:8192});const args=large.args();for(const item of args.items)item.slots.contribution[0].text+='安全内容'.repeat(2000);
  const result=await large.service.submitResult(large.admin,args,call);assert.equal(result.result?.contributions?.stored.length,4);
  const page=await large.knowledge.getNodes({root:large.root,paths:['/commands/system/show'],depth:0},large.user);assert.ok(page);
  assert.ok(Buffer.byteLength(JSON.stringify(page.nodes))<=8192);
  assert.ok(page.nodes.flatMap(n=>n.contributions??[]).every(view=>view.contribution===undefined&&view.note?.includes('get_nodes')));
  assert.equal(page.coverage.complete,false);assert.match(page.coverage.note??'',/正文|引用/);
  const w=await setup(t,{pageBytes:6000,treeEntries:7});const submitted=await w.service.submitResult(w.admin,w.args(),call);assert.equal(submitted.result?.contributions?.stored.length,4);
  const records=new Set<string>(),entries=new Set<string>();let cursor:string|null=null,count=0;
  do{
    const read=await w.knowledge.getNodes({root:w.root,paths:['/commands/system/show'],depth:0,cursor},w.user);assert.ok(read);
    for(const node of read.nodes){for(const entry of node.entries){assert.ok(!entries.has(entry.entry));entries.add(entry.entry);}for(const view of node.contributions??[]){assert.ok(!records.has(view.record));records.add(view.record);}}
    cursor=read.next;assert.ok(++count<20);
  }while(cursor!==null);
  assert.equal(records.size,4);assert.ok(entries.size>=8);assert.ok(count>1);
});

for(const kind of GENERIC_OUTPUTS) test(`${kind}: a non-verbatim quotation refuses admission`,async t=>{
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
  assert.equal(outside.acceptance,'accepted');assert.equal(outside.result?.contributions?.stored.length,3);assert.match(JSON.stringify(outside.errors),/来源不在锁定的根里，这一版不收/);
});

test('new root annotates changed fragments, while the contribution remains valid at its original root',async t=>{
  const w=await setup(t);await w.service.submitResult(w.admin,w.args(),call);
  const b=build('Rel_ACME_1_2_16');w.external.set(b.sources.tree,{bytes:catalogXml({...BASE_CATALOG,system:[BASE_CATALOG.system[0],{name:'show',params:[],help:'show the full state'}]}),mediaType:'application/xml'});
  const next=await w.knowledge.produceTree({product:w.product,build:b});assert.ok(next.ok);
  const changed=await w.knowledge.layers.contributions.list(next.root!,['/commands/system/show'],w.user);
  assert.equal(changed.length,4);assert.ok(changed.every(v=>v.status==='cited_fragment_changed'&&v.note?.includes('被引片段已变')));
  assert.ok((await w.knowledge.layers.contributions.list(w.root,['/commands/system/show'],w.user)).every(v=>v.status==='valid'));
});

test('a changed relation endpoint is reported even when its target node did not change',async t=>{
  const w=await setup(t);await w.service.submitResult(w.admin,w.args(),call);
  const b=build('Rel_ACME_1_2_16');w.external.set(b.sources.tree,{bytes:catalogXml({...BASE_CATALOG,net:[{...BASE_CATALOG.net[0],help:'never sends echo requests'},BASE_CATALOG.net[1]]}),mediaType:'application/xml'});
  const next=await w.knowledge.produceTree({product:w.product,build:b});assert.ok(next.ok);
  const entries=await w.knowledge.layers.contributions.list(next.root!,['/commands/system/show'],w.user);
  const relation=entries.find(entry=>entry.contribution.kind==='relation')!;
  assert.equal(relation.status,'cited_fragment_changed');assert.match(relation.note??'',/关系另一端/);
  assert.ok(entries.filter(entry=>entry!==relation).every(entry=>entry.status==='valid'));
});

test('changed-fragment notes take their label from the generated vocabulary',async t=>{
  const w=await setup(t);await w.service.submitResult(w.admin,w.args(),call);
  const b=build('Rel_ACME_1_2_16');w.external.set(b.sources.tree,{bytes:catalogXml({...BASE_CATALOG,system:[BASE_CATALOG.system[0],{name:'show',params:[],help:'changed state'}]}),mediaType:'application/xml'});
  const next=await w.knowledge.produceTree({product:w.product,build:b});assert.ok(next.ok);
  const labels=VALIDITY_STATUS_LABEL as Record<string,string>;const old=labels.cited_fragment_changed;
  try{labels.cited_fragment_changed='合成的新标签';const entries=await w.knowledge.layers.contributions.list(next.root!,['/commands/system/show'],w.user);assert.ok(entries.every(entry=>entry.note?.startsWith('合成的新标签')));}
  finally{labels.cited_fragment_changed=old;}
});

test('declared task outputs stay out of an actual contribution run layer',async t=>{
  const w=await setup(t,{task:true});
  const args={...w.args(),task_outputs:TASK_OUTPUT_KIND.map(output=>({output,value:'only-task-'+output}))};
  const result=await w.service.submitResult(w.admin,args,call);
  assert.equal(result.acceptance,'accepted',JSON.stringify(result.errors));assert.equal(result.result?.contributions?.stored.length,4);
  const entries=await w.knowledge.layers.contributions.list(w.root,['/commands/system/show'],w.user);
  assert.equal(entries.length,4);for(const output of TASK_OUTPUT_KIND)assert.ok(!JSON.stringify(entries).includes('only-task-'+output));
  const rejected=await w.service.submitResult(w.admin,{...args,task_outputs:[{output:'not_declared',value:'only-task-invalid'}]},call);
  assert.equal(rejected.acceptance,'not_accepted');assert.ok(rejected.errors.some(e=>(e.fix??'').includes('workflow.outputs.tasks')));
  const stored=(await w.kit.store.find({key:'runs.submission.run',value:w.run.run,kind:'submission'})).items[0];
  assert.equal(canonicalize(stored.body),canonicalize(args));
});

test('session declarations, including a generated wrapper, require a signature and never enter the layer',async t=>{
  for (const options of [{declaredRoot:true},{wrappedDeclaration:true}]) {
    const w=await setup(t,options);
    const answer=await w.service.submitResult(w.admin,w.args(),call);
    assert.equal(answer.acceptance,'accepted',JSON.stringify(answer));assert.equal(answer.result?.contributions?.stored.length,0);
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

test('administrators pass the product rule too; revocation changes reads rather than the stored receipt',async t=>{
  const w=await setup(t);const answer=await w.service.submitResult(w.admin,w.args(),call);
  const digest=answer.result!.contributions!.stored[0].record;
  const previous=w.packs.readableProducts.bind(w.packs);
  w.packs.readableProducts=async user=>user.id===w.admin.id ? new Set() : previous(user);
  assert.equal(await w.knowledge.layers.contributions.read(digest,w.admin),null);
  assert.deepEqual(await w.knowledge.layers.contributions.list(w.root,['/commands/system/show'],w.admin),[]);
  assert.deepEqual(await w.service.submitResult(w.admin,w.args(),call),answer,'a repeat returns the historical receipt without another effect');
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


test('a revoked source acceptance returns safe markers without changing original records or receipts',async t=>{
  const w=await setup(t,{acceptedRoot:true});const result=await w.service.submitResult(w.admin,w.args(),call);
  assert.equal(result.result?.contributions?.stored.length,4,JSON.stringify(result.errors));
  const digest=result.result!.contributions!.stored[0].record;
  assert.ok(await w.knowledge.layers.contributions.read(digest,w.user));
  await w.kit.artifacts.revokeFindings(w.admin,w.original,'结束合成演练');
  assert.equal(await w.knowledge.layers.contributions.read(digest,w.user),null);
  const views=await w.knowledge.layers.contributions.list(w.root,['/commands/system/show'],w.user);
  assert.equal(views.length,4);
  for(const view of views){
    assert.equal(view.status,'credential_unreadable');assert.match(view.note??'',/管理员/);
    assert.ok(!('statement'in view.contribution));assert.ok(!('quote'in view.contribution.source));
    if(view.contribution.relation)assert.ok(!('quote'in view.contribution.relation.other));
  }
  const node=await w.knowledge.getNodes({root:w.root,paths:['/commands/system/show'],depth:0},w.user);
  const text=toolText('get_nodes',{call_result:'ok',errors:[],trace:call.traceId,root:w.root,nodes:node!.nodes});
  assert.match(text,/含凭据，原文不可读/);assert.match(text,/管理员/);
  const raw=await w.kit.store.get(digest);assert.ok('statement'in (raw!.body as object));
  assert.deepEqual(await w.service.submitResult(w.admin,w.args(),call),result);
});

test('credential-bearing model declarations never enter product-readable contributions',async t=>{
  const w=await setup(t);const args={...w.args(),model:["synthe","tic-mo","del ht","tps://","demo:s","ynthet","ic-sec","ret@19","2.0.2.","8/v1"].join('')};
  const result=await w.service.submitResult(w.admin,args,call);
  assert.equal(result.result?.contributions?.stored.length,0);
  assert.equal(result.result?.contributions?.not_stored.length,4);
  assert.ok(result.errors.some(error=>error.code==='CREDENTIAL_IN_UPLOAD'));
  assert.deepEqual(await w.knowledge.layers.contributions.list(w.root,['/commands/system/show'],w.user),[]);
  const page=await w.knowledge.getNodes({root:w.root,paths:['/commands/system/show'],depth:0},w.user);
  assert.ok(!JSON.stringify(page).includes('synthetic-secret'));
});


test('ordinary partial cross item errors keep original indexes and do not charge another requirement',async t=>{
  const w=await setup(t,{ordinary:true});
  const args={...w.args(),cross_item:[{nature:'judgment',statement:'合成无编号项',grounds:[],unexpected:true},{nature:'judgment',statement:'合成第二项',grounds:[],code:'second_code'}]};
  const result=await w.service.submitResult(w.admin,args,call);
  const error=result.errors.find(e=>e.path==='/cross_item/0/unexpected'); assert.ok(error,JSON.stringify(result.errors));
  assert.equal(error.requirement,undefined); assert.equal(error.rounds_left,undefined);
  const actions=await w.kit.store.find({key:'runs.action.run',value:w.run.run,kind:'action',limit:100});
  for(const action of actions.items) {const repair=(action.body as {detail?:{repair?:string[]}}).detail?.repair; if(repair) assert.ok(!repair.includes('second'));}
});

test('the minimum accepted node budget cannot repeat a contribution cursor without progress',async t=>{
  const w=await setup(t,{pageBytes:1024});await w.service.submitResult(w.admin,w.args(),call);
  let cursor:string|null=null;const seen=new Set<string>();let complete=false;
  for(let count=0;count<16;count++){
    const page=await w.knowledge.getNodes({root:w.root,paths:['/commands/system/show'],depth:0,cursor},w.user);assert.ok(page);
    for(const node of page.nodes)for(const contribution of node.contributions??[])seen.add(contribution.record);
    if(page.next===null){complete=true;break;}
    assert.notEqual(page.next,cursor,'an empty page must not point back to itself');cursor=page.next;
  }
  assert.ok(complete);assert.equal(seen.size,4);
});

test('six overlapping equal content submissions share exactly one entry per identity',async t=>{
  const w=await setup(t);const other=await withReference(w,`src:${w.original}`);
  const find=w.kit.store.find.bind(w.kit.store);const waits=new Map<string,{count:number;release:()=>void;wait:Promise<void>}>();
  w.kit.store.find=async <B>(query:FindQuery,tx?:Transaction)=>{
    const result=await find<B>(query,tx);
    if(query.key==='knowledge.contribution.identity'&&result.items.length===0){
      let gate=waits.get(query.value);
      if(!gate){let release!:()=>void;const wait=new Promise<void>(done=>release=done);gate={count:0,release,wait};waits.set(query.value,gate);setTimeout(release,100);}
      gate.count++;if(gate.count>=2)gate.release();await gate.wait;
    }
    return result;
  };
  for(let round=0;round<6;round++){
    const first=w.args();for(const item of first.items)item.slots.contribution[0].text+=` 合成并发轮 ${round}`;
    const second={...structuredClone(first),run:other.run,model:'synthetic-other-model'};
    const results=await Promise.all([w.service.submitResult(w.admin,first,call),w.service.submitResult(w.admin,second,{...call,sessionId:'synthetic-second-session'})]);
    const references=results.map(result=>result.result?.contributions?.stored.map(value=>value.record).sort());
    assert.equal(references[0]?.length,4);assert.deepEqual(references[0],references[1],`round ${round}`);
  }
  assert.equal((await w.knowledge.layers.contributions.list(w.root,['/commands/system/show'],w.user)).length,24);
});

test('whole rejection retains each contribution policy refusal and its skip action',async t=>{
  const w=await setup(t);
  const uploaded=await w.kit.artifacts.ingest({bytes:new TextEncoder().encode('synthetic session statement'),mediaType:'text/plain',origin:{upload:{session:'synthetic-private-session',message:null}},author:{user:w.admin.id},provenanceType:'declared',visibility:{readers:[w.admin.id],admins:true,packs:[],shareable:false}});
  const run=await withOriginal(w,uploaded.body.sha256);const args={...w.args(),run:run.run};
  args.items[0].slots.contribution[0].data.source={reference:`src:${uploaded.body.sha256}`,quote:'synthetic session statement'};
  args.items[1].slots.contribution[0].data.source.quote='synthetic nonmatching quote';
  const result=await w.service.submitResult(w.admin,args,call);assert.equal(result.acceptance,'not_accepted');assert.ok(result.errors.some(error=>error.code==='QUOTE_MISMATCH'));
  const policy=result.errors.find(error=>error.item==='classification'&&error.code==='core.contribution.signature_required');assert.ok(policy);
  const receipt=result.result?.contributions?.not_stored.find(row=>row.item==='classification');assert.ok(receipt);assert.match(receipt.reason,/署名.*skipped/);assert.ok(!receipt.reason.includes('按边界修正说明'));
});


test('admission refusal codes and fixes come from the core registry rather than the declaring pack name',async t=>{
  const w=await setup(t);const args=w.args();args.items[0].slots.contribution[0].data.source={reference:`tree:${w.root}/commands/system`,quote:'reboot'};
  const result=await w.service.submitResult(w.admin,args,call);const error=result.errors.find(error=>error.item==='classification'&&error.code==='core.contribution.source_not_original');
  assert.ok(error,JSON.stringify(result.errors));assert.equal(error.fix,CORE_VIOLATION_CODES['core.contribution.source_not_original'].fix);
});

test('credential-bearing session headers are refused before append and never reach public node or record reads',async t=>{
  const w=await setup(t),layer=w.knowledge.layers.contributions;
  const secret='synthetic-session-secret',session=['https:','//probe:',secret,'@192.0.2.44/v1'].join('');
  const append=layer.append.bind(layer);let calls=0;
  t.mock.method(layer,'append',async(...args:Parameters<typeof append>)=>{calls++;return append(...args);});
  const result=await w.service.submitResult(w.admin,w.args(),{...call,sessionId:session});
  assert.equal(result.result?.contributions?.stored.length,0);assert.equal(calls,0);
  assert.equal(result.result?.contributions?.not_stored.length,4);assert.ok(result.errors.some(error=>error.code==='CREDENTIAL_IN_UPLOAD'));
  const records=await w.kit.store.find({key:'knowledge.contribution.product',value:w.product.product.id,kind:'claim',limit:100});assert.equal(records.items.length,0);
  const page=await w.knowledge.getNodes({root:w.root,paths:['/commands/system/show'],depth:0},w.user);assert.ok(!JSON.stringify(page).includes(secret));
  const safe=await w.service.submitResult(w.admin,{...w.args(),notes:'safe session control'},call);assert.equal(safe.result?.contributions?.stored.length,4);
  for(const item of safe.result!.contributions!.stored){const record=await layer.read(item.record,w.user);assert.ok(record);assert.ok(!JSON.stringify(record).includes(secret));assert.equal((record.body as {session:string}).session,call.sessionId);}
});

test('append scans the actual session again before an identity can reuse a public record',async t=>{
  const w=await setup(t),layer=w.knowledge.layers.contributions,append=layer.append.bind(layer);
  t.mock.method(layer,'append',async(...[prepared,origin,tx]:Parameters<typeof append>)=>append(prepared,{...origin,session:["https:","//prob","e:synt","hetic-","append","-secre","t@192.","0.2.44","/v1"].join('')},tx));
  const interrupted=await w.service.submitResult(w.admin,w.args(),call);
  assert.equal(interrupted.acceptance,'not_accepted');
  assert.ok(interrupted.errors.some(e=>e.code==='check_error'));
  assert.ok(!JSON.stringify(interrupted).includes('synthetic-append-secret'));
  assert.deepEqual(await layer.list(w.root,['/commands/system/show'],w.user),[]);
});


for(const budget of [16384,2*1024*1024])test('contribution continuation progresses in the large-node size window at budget '+budget,async t=>{
  const path='/notes/'+'n'.repeat(220),w=await setup(t,{pageBytes:budget,nodePath:path});
  const base=await w.knowledge.getNodes({root:w.root,paths:[path],depth:0},w.user);assert.ok(base);
  const bare={...base.nodes[0],entries:[],children:[]};
  const room=budget-512-canonicalBytes([bare]).length;assert.ok(room<budget-1024);
  const probe=w.args();probe.model='m';for(const item of probe.items)item.slots.contribution[0].text+=' size probe';
  const control=await w.service.submitResult(w.admin,probe,call);assert.equal(control.result?.contributions?.stored.length,4);
  const view=await w.knowledge.layers.contributions.readView(control.result!.contributions!.stored[0].record,w.user);assert.ok(view);
  const target=Math.floor((room+budget-1024)/2),length=target-canonicalBytes(view).length+1;assert.ok(length>0);
  const args=w.args();args.model='m'.repeat(length);for(const item of args.items)item.slots.contribution[0].text+=' size other';
  const result=await w.service.submitResult(w.admin,args,call);assert.equal(result.result?.contributions?.stored.length,4,JSON.stringify(result.errors));
  const full=await w.knowledge.layers.contributions.readView(result.result!.contributions!.stored[0].record,w.user);assert.ok(full);
  const size=canonicalBytes(full).length;assert.ok(size>room&&size<=budget-1024,'the old deferral threshold has no room for this view');
  const seen=new Set<string>();let cursor:string|null=null,complete=false,markers=0;
  for(let count=0;count<24;count++){
    const page=await w.knowledge.getNodes({root:w.root,paths:[path],depth:0,cursor},w.user);assert.ok(page);
    for(const node of page.nodes)for(const item of node.contributions??[]){assert.ok(!seen.has(item.record));seen.add(item.record);if(item.contribution===undefined)markers++;}
    if(page.next===null){complete=true;break;}assert.notEqual(page.next,cursor);cursor=page.next;
  }
  assert.ok(complete);assert.equal(seen.size,8);assert.ok(markers>=4);
});

test('a missing-session refusal does not become a cached contribution receipt for the corrected observer',async t=>{
  const w=await setup(t,{modern:true});
  const pack=(await w.workflows.byDigest(w.run.pack_digest))!;
  pack.requirements.push({key:'independent',name:'合成独立复核',description:'合成会话边界',target:'run',required:false,done_rule:'bookkeeping',layers:['static'],accepted_producer:'independent_judgment',independent_of:'predecessor',accepts_declared_independence:true,checks:[],error_handling:[]});
  pack.slots.run={independent:{codes:[{code:'synthetic',label:'合成判断'}],min:0,max:1}};
  const inputs={subject:{reference:w.run.sources.find(s=>s.slot==='subject')!.reference},originals:{reference:w.run.sources.find(s=>s.slot==='originals')!.reference}};
  const start=await w.service.startRun(w.admin,{pack:'knowledge-contribution',product:'Acme',build:w.b.name,inputs},call);
  assert.equal(start.call_result,'ok',JSON.stringify(start.errors));
  const args={...w.args(),run:start.run!.run,cross_item:[{nature:'judgment',statement:'合成独立判断',grounds:[],code:'synthetic'}]};
  const missing=await w.service.submitResult(w.admin,args,{...call,sessionId:null});
  assert.equal(missing.acceptance,'not_accepted');
  const corrected=await w.service.submitResult(w.admin,args,call);
  assert.equal(corrected.acceptance,'accepted',JSON.stringify(corrected.errors));
  assert.equal(corrected.result!.contributions?.stored.length,4);
  const missingAgain=await w.service.submitResult(w.admin,args,{...call,sessionId:null});
  assert.equal(missingAgain.acceptance,'not_accepted','an accepted contribution cache cannot replace the required session check');
  assert.equal(missingAgain.errors[0].code,'SUBMISSION_SCHEMA_VIOLATION');
  assert.deepEqual(await w.service.submitResult(w.admin,args,call),corrected,'a missing-session refusal does not duplicate a later valid contribution');
  const freshArgs={...args,model:'synthetic-first-accepted'};
  assert.equal((await w.service.submitResult(w.admin,freshArgs,call)).acceptance,'accepted');
  const freshMissing=await w.service.submitResult(w.admin,freshArgs,{...call,sessionId:null});
  assert.equal(freshMissing.acceptance,'not_accepted','a first accepted receipt cannot supply a missing caller session');
});
