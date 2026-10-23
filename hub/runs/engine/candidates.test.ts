// Real knowledge + records + run engine; all documents, model outputs and identities are synthetic.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { before, after, test, type TestContext } from 'node:test';
import type { RunSummary } from '../../../contracts/src/run.ts';
import { canonicalize, type RecordStore, type StoredRecord } from '../../records/api.ts';
import { RECORD_KINDS } from '../../../contracts/generated/protocol.ts';
import { startPostgres, type TemporaryPostgres } from '../../testing/postgres.ts';
import { makeWorld, BASE_CATALOG, catalogXml } from '../../knowledge/test-support.ts';
import { createRunsService } from './api.ts';
import { reviewPack, writePack } from './testing/packs.ts';
import { FakeWorkflowStore } from './testing/workflows.ts';
import { standardDocument, toyMap } from './testing/mindmap.ts';
import { sandboxSkip } from './testing/harness.ts';
import { actionsOf, submissionsOf } from './store.ts';
import { recordReader } from './readers.ts';
import { receivedDigest } from './util.ts';

let postgres:TemporaryPostgres;
const skip=await sandboxSkip();
before(async()=>{postgres=await startPostgres();});after(()=>postgres?.stop());
const PRIVATE='PRIVATE_CANDIDATE_TEXT_';
const TASK='TASK_OUTPUT_ONLY_MARKER';
async function allRecords(store:RecordStore):Promise<StoredRecord[]>{const records:StoredRecord[]=[];for(const kind of RECORD_KINDS){let cursor:string|null=null;do{const page=await store.list({kind,limit:500,cursor});records.push(...page.items);cursor=page.next;}while(cursor!==null);}return records;}

const build=(name:string)=>({name,family:'ACME',line:'1.2',base:name,platform:null,built_at:null,released_at:null,sources:{tree:`site:tree:${name}`},root:null});
async function fixture(t:TestContext){
  const w=await makeWorld(postgres);t.after(()=>w.close());
  const b=build('Rel_ACME_1_2_15');w.external.set(b.sources.tree,{bytes:catalogXml(BASE_CATALOG),mediaType:'application/xml'});
  const produced=await w.knowledge.produceTree({product:w.product,build:b});assert.equal(produced.ok,true);
  const root=produced.root!;
  const workflows=new FakeWorkflowStore(),spec=reviewPack({findingsData:{type:'object',properties:{bad:{type:'boolean'}},additionalProperties:false}});
  spec.id='toy-candidates';
  const wf=(spec.files['workflow.json'] as {json:any}).json;
  wf.product={catalogs:w.product.product.catalogs.map(c=>c.id)};
  wf.inputs.push({slot:'material',role:'expected',description:'synthetic record document',accepts:['application/json'],required:false,many:false});
  wf.outputs={documents:[
    {id:'classify',input:'map',kind:'classification'}, {id:'place',input:'map',kind:'placement_proposal'},
    {id:'assert',input:'map',kind:'assertion'}, {id:'relate',input:'map',kind:'relation'},
    {id:'tree_note',kind:'assertion'}, {id:'record_note',input:'material',kind:'assertion'},
  ],tasks:[{id:'rank',kind:'ranking'},{id:'choose',kind:'selection'},{id:'score',kind:'score'}]};
  spec.files['requirements.json']={json:{schema:'requirements@1',requirements:[
    {key:'findings',name:'model output',description:'synthetic',target:'item',required:true,done_rule:'bookkeeping',accepted_producer:'judgment',layers:['static'],checks:[],error_handling:[]},
    {key:'shape',name:'artifact shape',description:'synthetic',target:'item',required:true,done_rule:'bookkeeping',accepted_producer:'fact',layers:['static'],checks:['shape'],error_handling:[{code:'toy-candidates.bad',action:'repair',max_rounds:2}]},
  ]}};
  spec.files['checks.json']={json:{schema:'checks@1',checks:[{id:'shape',function:{module:'functions/shape.ts'},table:'tables/shape.json',applies:'item',judges:'artifact_under_verification',tier:'blocking',basis:'synthetic field rule'}]}};
  spec.files['tables/shape.json']={json:{synthetic:true}};
  spec.files['functions/shape.ts']=`export default (input:any)=>[{item:input.subject.item,verdict:input.subject.slots.findings[0]?.data?.bad?'refute':'support',...(input.subject.slots.findings[0]?.data?.bad?{code:'toy-candidates.bad'}:{}),statement:'synthetic check',grounds:[],tier:'blocking'}];`;
  const workflow=await workflows.add(await writePack(join(w.dir,'workflows'),spec));workflows.assign(w.user.id,spec.id);
  const logs:string[]=[];
  const service=createRunsService({records:w.kit,workflows,packs:w.packs,knowledge:w.knowledge,external:w.external,adminLog:entry=>logs.push(JSON.stringify(entry))});
  const doc=standardDocument();doc.groups=[{...doc.groups[0],cases:doc.groups[0].cases.slice(0,2)}];
  const artifact=await w.kit.artifacts.ingest({bytes:toyMap(doc),mediaType:'application/json',origin:{upload:{session:'candidate-session',message:null}},author:{user:w.user.id},provenanceType:'declared',visibility:{readers:[w.user.id],admins:true,packs:[],shareable:true},name:'ordinary-document.json'});
  const call=()=>({traceId:'a'.repeat(32),sessionId:'candidate-session'});
  const start=async(material?:string)=>{
    const answer=await service.startRun(w.user,{pack:spec.id,product:w.product.product.names[0],version:'1.2',inputs:{map:{reference:`src:${artifact.body.sha256}`},...(material?{material:{reference:material}}:{})}},call());
    assert.ok(answer.run,JSON.stringify(answer.errors));return answer.run;
  };
  const run=await start();
  assert.deepEqual(run.outputs?.documents.map(d=>d.kind),['classification','placement_proposal','assertion','relation','assertion','assertion']);
  let checks=0;const read=workflow.readJson.bind(workflow);
  t.mock.method(workflow,'readJson',(path:string)=>{if(path==='tables/shape.json')checks++;return read(path);});
  const body=(r:RunSummary=run,bad=false)=>({run:r.run,model:'scripted@exact-1',items:r.items.map(it=>({item:it.id,handling:'handled',slots:{findings:bad?[{text:'ordinary checked statement',code:'literal_issue',rank:'minor',quotes:[{reference:it.location,text:it.label}],data:{bad:true}}]:[]}})),task_outputs:[{output:'rank',value:[TASK]},{output:'choose',value:{selected:true}},{output:'score',value:0.8}]});
  const proposal=(output='assert',statement=PRIVATE+output)=>({output,statement,source:{reference:run.items[0].location,quote:run.items[0].label},binding:{root,path:'/commands/system/show'}});
  return {w,root,service,workflow,run,logs,call,start,body,proposal,checks:()=>checks};
}

test('four document formats enter the owner layer while task results and ordinary checks remain separate',{skip},async t=>{
  const f=await fixture(t),{w,run}=f;
  const proposals=['classify','place','assert','relate'].map(output=>({...f.proposal(output),...(output==='relate'?{relation:{name:'same_subject',other:{reference:`tree:${f.root}/commands/system/show`,quote:'system show'}}}:{})}));
  const main=f.body();const first=await f.service.submitResult(w.user,{...main,candidates:proposals},f.call());
  assert.equal(first.acceptance,'accepted');assert.equal(first.candidate_receipt?.accepted,4);assert.deepEqual(first.candidate_receipt?.errors,[]);
  assert.equal(first.result?.submission,receivedDigest(main).digest);
  const count=f.checks();assert.equal(count,2);
  const initial=await w.knowledge.layers.candidates.list(w.user,f.root);assert.equal(initial.length,4);
  assert.deepEqual(initial.map(c=>c.candidate.kind),['classification','placement_proposal','assertion','relation']);
  assert.ok(initial.every(c=>c.candidate.source?.provenance==='declared'&&c.candidate.basis_rank==='judgment'));
  assert.equal(initial[3].candidate.relation?.other.provenance,'projected');
  assert.ok(!JSON.stringify(initial).includes(TASK));
  assert.deepEqual(await w.knowledge.layers.candidates.list(w.admin),[]);assert.deepEqual(await w.knowledge.layers.candidates.list(w.outsider),[]);
  for(const row of initial){
    assert.equal(await recordReader(w.kit.store).read(row.record,{user:w.admin.id,role:'admin'}),null);
    assert.equal(await recordReader(w.kit.store).read(row.record,{user:w.outsider.id,role:'user'}),null);
    assert.ok(await recordReader(w.kit.store).read(row.record,{user:w.user.id,role:'user'}));
  }
  const second=await f.service.submitResult(w.user,{...main,candidates:[f.proposal('assert',PRIVATE+'new assertion')]},f.call());
  assert.deepEqual(second.result,first.result);assert.equal(second.candidate_receipt?.accepted,1);assert.equal(f.checks(),count);
  const repeated=await f.service.submitResult(w.user,{...main,candidates:proposals},f.call());
  assert.deepEqual(repeated.result,first.result);assert.equal(repeated.candidate_receipt?.accepted,0);assert.equal(repeated.candidate_receipt?.deduplicated,4);
  const sameNormalized={...proposals[2],statement:proposals[2].statement+'  \n',source:{...proposals[2].source,quote:'  '+proposals[2].source.quote+'  '}};
  const normalized=await f.service.submitResult(w.user,{...main,candidates:[sameNormalized]},f.call());assert.equal(normalized.candidate_receipt?.accepted,0);assert.equal(normalized.candidate_receipt?.deduplicated,1);
  assert.equal((await w.knowledge.layers.candidates.list(w.user)).length,5);
  const submissions=await submissionsOf(w.kit.store,run.run);assert.equal(submissions.length,1);
  assert.deepEqual((submissions[0].body as any).candidate_summary,{count:4,sha256:receivedDigest(proposals).digest});
  assert.ok(JSON.stringify(submissions[0].body).includes(TASK));
  const actions=await actionsOf(w.kit.store,run.run);
  assert.equal(actions.filter(a=>a.body.action==='validate'&&typeof a.body.detail.submission==='string').length,1);
  assert.ok(actions.filter(a=>a.body.component==='knowledge.candidates@1').every(a=>a.body.detail.submission===undefined&&a.body.detail.repair===undefined));
  const all=await allRecords(w.kit.store);
  assert.ok(all.filter(record=>record.schema!=='knowledge-candidate@1').every(record=>!JSON.stringify(record).includes(PRIVATE)));
  assert.ok(!f.logs.join('\n').includes(PRIVATE));
  // Node text changes only in a new root; neither candidate admission nor the relation mutates the old tree.
  const next=build('Rel_ACME_1_2_16');
  w.external.set(next.sources.tree,{bytes:catalogXml({...BASE_CATALOG,system:[BASE_CATALOG.system[0],{...BASE_CATALOG.system[1],params:[{name:'mode',type:'string'}]}]}),mediaType:'application/xml'});
  const produced=await w.knowledge.produceTree({product:w.product,build:next});assert.ok(produced.root&&produced.root!==f.root);
  assert.ok((await w.knowledge.layers.candidates.list(w.user,produced.root)).every(row=>row.status==='cited_fragment_changed'&&row.note?.includes('根')));
  assert.ok((await w.knowledge.layers.candidates.list(w.user,f.root)).every(row=>row.status==='valid'));
});

test('invalid candidates and document outputs in the task channel never alter primary outcomes, budgets or stored text',{skip},async t=>{
  const f=await fixture(t),{w}=f;const main=f.body(f.run,true);
  const first=await f.service.submitResult(w.user,main,f.call());assert.equal(first.acceptance,'accepted');
  assert.equal(first.errors.filter(e=>e.code==='toy-candidates.bad').length,2);
  const source=f.proposal().source;
  const unrelated=await w.kit.artifacts.ingest({bytes:Buffer.from('unrelated readable document'),mediaType:'text/plain',origin:{read:{object:'manuals:synthetic:unbound'}},author:{user:null},provenanceType:'observed',visibility:{readers:[w.user.id],admins:true,packs:[],shareable:false}});
  const invalid=[
    {...f.proposal('classify'),source:{...source,quote:'not in the source'}},
    {...f.proposal('place'),binding:{root:f.root,path:'/commands/no-such-node'}},
    {...f.proposal('assert'),applicability:{platforms:['invented']}},
    {...f.proposal('assert'),basis_rank:'rule_over_observation'},
    {...f.proposal('assert'),source_provenance:'observed'},
    {...f.proposal('relate'),relation:{name:'contradicts',other:{reference:`tree:${f.root}/commands/system/show`,quote:'not in the other endpoint'}}},
    {...f.proposal('assert'),source:{reference:`src:${unrelated.body.sha256}`,quote:'unrelated readable'}},
    {...f.proposal('tree_note'),source:{reference:`entry:${'a'.repeat(64)}`,quote:'unknown'}},
  ];
  const second=await f.service.submitResult(w.user,{...main,candidates:invalid},f.call());
  assert.deepEqual(second.result,first.result);assert.equal(second.candidate_receipt?.rejected,invalid.length);assert.equal(second.candidate_receipt?.accepted,0);
  assert.ok(second.candidate_receipt!.errors.every(e=>e.path?.startsWith('/candidates/')&&!JSON.stringify(e).includes(PRIVATE)));
  assert.deepEqual(await w.knowledge.layers.candidates.list(w.user),[]);
  const wrong=await f.service.submitResult(w.user,{...main,task_outputs:[...main.task_outputs,{output:'assert',value:{statement:PRIVATE+'wrong channel'}}]},f.call());
  assert.deepEqual(wrong.result,first.result);assert.equal(wrong.candidate_receipt?.rejected,1);
  const fixed=await f.service.submitResult(w.user,f.body(),f.call());assert.equal(fixed.result?.rounds.used,1,'candidate-only repeats never count another repair round');
  const records=await allRecords(w.kit.store);
  assert.ok(records.filter(r=>r.schema!=='knowledge-candidate@1').every(r=>!canonicalize(r).includes(PRIVATE)));
});

test('private session grounds are accepted only when private; rec and tree sources follow the boundary scope',{skip},async t=>{
  const f=await fixture(t),{w}=f;
  const input={bytes:Buffer.from('synthetic session excerpt proposes this assertion'),mediaType:'text/plain',origin:{upload:{session:'candidate-session',message:null}},author:{user:w.user.id},provenanceType:'declared' as const,visibility:{readers:[w.user.id],admins:false,packs:[],shareable:false}};
  const privateGround=await w.kit.artifacts.ingest(input),sharedGround=await w.kit.artifacts.ingest({...input,bytes:Buffer.from('shared session excerpt'),visibility:{...input.visibility,admins:true,shareable:true}});
  const own=f.proposal('assert',PRIVATE+'session');
  const good=await f.service.submitResult(w.user,{...f.body(),candidates:[{...own,ground:{reference:`src:${privateGround.body.sha256}`,quote:'session excerpt proposes'}}]},f.call());assert.equal(good.candidate_receipt?.accepted,1);
  const bad=await f.service.submitResult(w.user,{...f.body(),candidates:[{...f.proposal('assert',PRIVATE+'shared session'),ground:{reference:`src:${sharedGround.body.sha256}`,quote:'shared session excerpt'}}]},f.call());assert.equal(bad.candidate_receipt?.rejected,1);assert.deepEqual(bad.result,good.result);
  const record=await w.kit.store.put({kind:'action',schema:'action@1',provenance:'declared',body:{run:f.run.run,text:'ordinary record passage'}});
  const rec={output:'tree_note',statement:PRIVATE+'record',source:{reference:`rec:${record.digest}#/text`,quote:'record passage'}};
  const unbound=await f.service.submitResult(w.user,{...f.body(),candidates:[rec]},f.call());assert.equal(unbound.candidate_receipt?.rejected,1);
  const secondRun=await f.start(`rec:${record.digest}`);
  const bound=await f.service.submitResult(w.user,{...f.body(secondRun),candidates:[{...rec,output:'record_note'},{output:'tree_note',statement:PRIVATE+'tree',source:{reference:`tree:${f.root}/commands/system/show`,quote:'system show'}}]},f.call());
  assert.equal(bound.candidate_receipt?.accepted,2,JSON.stringify(bound.candidate_receipt));
  const mine=await w.knowledge.layers.candidates.list(w.user);
  const relay=mine.find(c=>c.candidate.statement===PRIVATE+'record')!;assert.equal(relay.candidate.basis_rank,'relay');assert.equal(relay.candidate.source?.provenance,'declared');
  assert.equal(mine.find(c=>c.candidate.statement===PRIVATE+'tree')?.candidate.source?.provenance,'projected');
});
