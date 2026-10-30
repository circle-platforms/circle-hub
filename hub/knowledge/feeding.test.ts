import assert from 'node:assert/strict';
import {test} from 'node:test';
import {makeWorld,startPostgres,STATIC_PLAN_SOURCE,DEFAULT_SYNC,catalogXml,type World} from './test-support.ts';
import {SeedlingBody} from '../../contracts/src/knowledge.ts';
import {formatKnowledgeRetract, knowledgeRetract} from './api.ts';
import {newId,scanForCredentials,RECORD_SCHEMAS,type SourceArtifact,type SourceArtifactBody} from '../records/api.ts';
import {runRecord} from '../../contracts/src/fixtures.ts';
import {RunRecord} from '../../contracts/src/run.ts';
import {putRun} from '../runs/engine/store.ts';
import {seedlingName} from './seedling.ts';
// Scripted product function: the Hub admits its closed structured projection, never parses product text itself.
const PROJECT=`export default function project(input:any){const m=input.model;if(input.source.system!=='plm'||m.kind!=='bug')return {rows:[]};const fields=m.fields;return {rows:[{body:{schema:'fed-defect@1',product:input.product,root:input.root,path:null,source:{system:'plm',ticket:input.source.key,revision:null,bytes:input.source.bytes},id:m.id,status:fields.status,affected_lines:fields.affected_lines,resolved_lines:[],fix_builds:[]},identity:{id:m.id,fields},lines:fields.affected_lines,selector:'p',grammar:'synthetic-defect@1',conflict:false}]};}`;
async function setup(pg:Awaited<ReturnType<typeof startPostgres>>){const build={name:'Synthetic_zx-u_10_8_1',base:'Synthetic_zx-u_10_8_1',family:'ACME',line:'10.8',platform:'zx-u',built_at:'2026-10-01T00:00:00.000Z',released_at:'2026-10-02T00:00:00.000Z',sources:{tree:'site:tree:10_8'}};const w=await makeWorld(pg,{pack:{functions:{'feeding.ts':PROJECT,'plan.ts':STATIC_PLAN_SOURCE},declaration:{sync:{...DEFAULT_SYNC,options:{builds:[build]}},feeding:{project:{module:'functions/feeding.ts'}}}}});w.external.set('site:tree:10_8',{bytes:catalogXml({system:[{name:'show',params:[]}]}),mediaType:'application/xml'});await w.knowledge.syncProduct(w.product,{by:w.admin});return w;}
async function source(w:World,id:string,fields:Record<string,unknown>={status:'open',affected_lines:[]},readers=[w.user.id]){return w.kit.artifacts.ingest({bytes:Buffer.from(JSON.stringify({kind:'bug',id,fields})),mediaType:'application/json',origin:{read:{object:'plm:bug:'+id}},author:{user:null},provenanceType:'observed',visibility:{readers,admins:true,packs:[],shareable:false},readTier:'model_readable'});}
async function seed(w:World,line='10.8'){const root=await w.knowledge.rootOfBuild(w.product.id,'Synthetic_zx-u_10_8_1');assert.ok(root);const composition=await w.knowledge.store.composition(root.composition);assert.ok(composition);const original=composition.sources[0];const body=SeedlingBody.parse({product:w.product.id,line,root:root.root,composition:root.composition,build:root.build!.name,origin:[{role:'command-tree',producer:original.producer,slot:original.slot,external:original.external,sha256:original.sha256,revision:null}],parent:null,basis:'synthetic test seed'});const rec=await w.knowledge.store.putClaim('seedling@1','projected',body,[{key:'knowledge.seedling.root',value:w.product.id+'/'+root.root},{key:'knowledge.seedling',value:w.product.id+'/'+line}]);await w.kit.pointers.move({name:seedlingName(w.product.id,line),expected:null,next:rec.digest,by:w.admin,run:null,component:'synthetic.feeding@1'});return root;}
async function run(w:World){const id=newId('run');await putRun(w.kit.store,RunRecord.parse({...runRecord,run:id,runner:w.user.id}),new Date().toISOString());return id;}
const receiptBody=(rows:Awaited<ReturnType<NonNullable<World['knowledge']['feeding']>['entries']>>)=>rows.find(row=>row.body.schema==='fed-defect@1')!.body;
test('feeding uses content identity, appends provenance and usages, freezes a horizon outside roots, and scopes run withdrawals',async t=>{const pg=await startPostgres();t.after(()=>pg.stop());const w=await setup(pg);t.after(()=>w.close());const layer=w.knowledge.feeding!,root=await seed(w);const a=await source(w,'SYN-1'),r1=await run(w),r2=await run(w);const scope={product:w.product.id,root:root.root,line:'10.8',run:r1};
 const frozen=await layer.freeze(w.user,r1,root.root);assert.ok(frozen.offset<await layer.offset());const first=await layer.observeSource(w.user,a.body.sha256,scope);assert.equal(first.objects.length,1);assert.deepEqual(await layer.usages(w.user,r1),first.objects);assert.deepEqual(await layer.usages(w.outsider,r1),[]);assert.deepEqual(await layer.entries(w.user,w.product.id,frozen.offset),[]);assert.equal((await layer.freeze(w.user,r1,root.root)).offset,frozen.offset);
 await layer.observeSource(w.user,a.body.sha256,{...scope,run:r2});const entries=await layer.entries(w.user,w.product.id);assert.equal(new Set(entries.map(row=>row.body.object)).size,1);assert.equal(entries.length,2);assert.equal((await layer.bindingsFor(w.user,first.objects[0]))!.items[0].body.state,'undeclared');assert.equal((await layer.todos(w.admin)).length,1);await layer.observeSource(w.user,a.body.sha256,scope);assert.equal((await layer.entries(w.user,w.product.id)).length,2);assert.equal((await layer.todos(w.admin)).length,1);
 await assert.rejects(()=>layer.retract(w.user,{schema:'retraction@1',objects:first.objects,by:w.user.id,at:new Date().toISOString(),reason:'synthetic withdrawal'}));await layer.retract(w.admin,{schema:'retraction@1',runs:[r1],by:w.admin.id,at:new Date().toISOString(),reason:'synthetic withdrawal'});const after=await layer.entries(w.user,w.product.id);assert.equal(after.filter(row=>row.validity==='invalid').length,1);assert.equal(after.filter(row=>row.validity==='valid').length,1);assert.equal((await w.knowledge.rootOfBuild(w.product.id,root.build.name))!.root,root.root);
});
test('feeding refuses an entire malformed proposal batch and verifies exact quotes, classes, sources and product fields',async t=>{const pg=await startPostgres();t.after(()=>pg.stop());const w=await setup(pg);t.after(()=>w.close());const layer=w.knowledge.feeding!,a=await source(w,'SYN-2');await layer.observeSource(w.user,a.body.sha256,{product:w.product.id});const native=receiptBody(await layer.entries(w.user,w.product.id));const quote={reference:'src:'+a.body.sha256+'/json@1/p/fields/status',text:'open'};const good={...native,classification:[{value:'functional',quote}]};const scope={product:w.product.id,classifications:['functional']};const before=await layer.offset();await assert.rejects(()=>layer.admit(w.user,[good,{...good,classification:[{value:'Functional',quote}]}],scope),/闭集/);assert.equal(await layer.offset(),before);await assert.rejects(()=>layer.admit(w.user,[{...good,status:'fixed'}],scope),/程序可填字段/);await assert.rejects(()=>layer.admit(w.user,[{...good,classification:[{value:'functional',quote:{...quote,text:'OPEN'}}]}],scope),/逐字/);
 const refs=await layer.admit(w.user,[good],scope);assert.equal(refs.length,1);assert.ok(await layer.readRecord(refs[0],w.user));assert.equal(await layer.readRecord(refs[0],w.outsider),null);await assert.rejects(()=>layer.admit(w.user,[{schema:'usage@1',object:native.object,run:newId('run'),line:'10.8',at:new Date().toISOString()}],scope),/不得自报/);await assert.rejects(()=>layer.admit(w.user,[{...good,source:{...native.source,ticket:'FORGED'}}],scope),/出处/);
 await w.kit.principals.setDisabled(w.admin,w.user.id,true);const todo=await layer.todos(w.admin);assert.equal(todo.filter(row=>row.source.system==='feeding-annotation').length,1);assert.equal((await layer.todos(w.admin)).filter(row=>row.source.system==='feeding-annotation').length,1);
});
test('source changes invalidate old claims without rewriting history; bindings and document todos resolve and reopen',async t=>{const pg=await startPostgres();t.after(()=>pg.stop());const w=await setup(pg);t.after(()=>w.close());const layer=w.knowledge.feeding!,root=await seed(w),a=await source(w,'SYN-3');const scope={product:w.product.id,root:root.root,requested:'plm:bug:SYN-3'};await layer.observeSource(w.user,a.body.sha256,{...scope,sourceRecord:a.digest});const native=receiptBody(await layer.entries(w.user,w.product.id));const [claim]=await layer.admit(w.user,[{...native,classification:[{value:'functional',quote:{reference:'src:'+a.body.sha256+'/json@1/p',text:'open'}}]}],{...scope,classifications:['functional']});const old=await w.kit.store.get(claim);assert.equal((await layer.todos(w.admin)).length,1);
 const b=await source(w,'SYN-3',{status:'fixed',affected_lines:['10.8']});await layer.observeSource(w.user,b.body.sha256,{...scope,sourceRecord:b.digest});assert.equal((await layer.todos(w.admin)).length,0);assert.equal((await layer.recordState(claim,w.user))!.validity,'invalid');assert.deepEqual((await w.kit.store.get(claim))!.body,old!.body);
 const c=await source(w,'SYN-3',{status:'open',affected_lines:[],description:'revision 3'});await layer.observeSource(w.user,c.body.sha256,{...scope,sourceRecord:c.digest});assert.equal((await layer.todos(w.admin)).length,1);const unknown=await source(w,'SYN-4',{status:'fixed',affected_lines:['10.9']});const pending=await layer.observeSource(w.user,unknown.body.sha256,{product:w.product.id});assert.equal(pending.objects.length,0);assert.match(pending.pending[0].missing,/没有树苗/);
});
test('uploads remain uploader/admin-only even with identical public bytes; uploaded source cannot impersonate a defect',async t=>{const pg=await startPostgres();t.after(()=>pg.stop());const w=await setup(pg);t.after(()=>w.close());const layer=w.knowledge.feeding!;const note=await w.kit.artifacts.ingest({bytes:Buffer.from('synthetic note at 192.0.2.8'),mediaType:'text/plain',origin:{upload:{session:'synthetic',message:null}},author:{user:w.user.id},provenanceType:'declared',visibility:{readers:[w.user.id,w.outsider.id],admins:true,packs:[],shareable:true},readTier:'model_readable'});await layer.upload(w.user,note);await w.kit.artifacts.ingest({bytes:Buffer.from('synthetic note at 192.0.2.8'),mediaType:'text/plain',origin:{read:{object:'plm:bug:PUBLIC'}},author:{user:null},provenanceType:'observed',visibility:{readers:[w.user.id,w.outsider.id],admins:true,packs:[],shareable:false},readTier:'model_readable'});const row=(await layer.entries(w.user,w.user.id))[0];assert.equal(row.body.schema,'fed-note@1');assert.equal((await layer.entries(w.outsider,w.user.id)).length,0);assert.equal((await layer.entries(w.admin,w.user.id)).length,1);const proposal={...row.body,classification:[{value:'ticket',quote:{reference:'src:'+note.body.sha256+'/text@1/l/1',text:'synthetic note'}}]};await assert.rejects(()=>layer.prepare(w.outsider,proposal,{}),/上传者/);assert.ok(await layer.prepare(w.user,proposal,{}));
});

test('an upload note records a capture time only when the client declared one (round-four review, item 5)',async t=>{
 const pg=await startPostgres();t.after(()=>pg.stop());const w=await setup(pg);t.after(()=>w.close());const layer=w.knowledge.feeding!;
 const upload=(text:string,capturedAt?:string)=>w.kit.artifacts.ingest({bytes:Buffer.from(text),mediaType:'text/plain',origin:{upload:{session:'synthetic',message:null}},author:{user:w.user.id},provenanceType:'declared',visibility:{readers:[w.user.id],admins:true,packs:[],shareable:true},readTier:'model_readable',...(capturedAt?{capturedAt}:{})});
 const undeclared=await upload('synthetic note without a capture time'),declared=await upload('synthetic note with a capture time','2026-10-27T08:00:00.000Z');
 await layer.upload(w.user,undeclared);await layer.upload(w.user,declared);
 const notes=new Map((await layer.entries(w.user,w.user.id)).map(row=>[row.body.object,row.body as Record<string,unknown>]));
 const plain=notes.get(undeclared.body.sha256)!,timed=notes.get(declared.body.sha256)!;
 assert.equal('at' in plain,false,'the upload time is not claimed as a capture time');
 assert.equal(plain.captured_at_declared,false);assert.equal(plain.received_at,undeclared.created_at);
 assert.equal(timed.at,'2026-10-27T08:00:00.000Z');assert.equal(timed.captured_at_declared,true);assert.equal(timed.received_at,declared.created_at);
 // Each note still finds its own upload and passes the check against the body the Hub generates.
 for(const body of [plain,timed])assert.ok(await layer.prepare(w.user,{...body,classification:[{value:'ticket',quote:{reference:'src:'+String(body.object)+'/text@1/l/1',text:'synthetic note'}}]} as never,{}));
});

test('two uploads of the same bytes at the same declared time are each annotated through their own note and record (round five and six, item 5)',async t=>{
 const pg=await startPostgres();t.after(()=>pg.stop());const w=await setup(pg);t.after(()=>w.close());const layer=w.knowledge.feeding!;
 const capturedAt='2026-10-27T08:00:00.000Z',bytes=Buffer.from('synthetic note captured twice');
 const upload=(session:string)=>w.kit.artifacts.ingest({bytes,mediaType:'text/plain',origin:{upload:{session,message:null}},author:{user:w.user.id},provenanceType:'declared',visibility:{readers:[w.user.id],admins:true,packs:[],shareable:true},readTier:'model_readable',capturedAt});
 // No pause between them: even within one millisecond each note names its own upload record.
 const [first,second]=await Promise.all([upload('synthetic-first'),upload('synthetic-second')]);
 assert.notEqual(first.digest,second.digest,'two upload records');
 await layer.upload(w.user,first);await layer.upload(w.user,second);
 const notes=(await layer.entries(w.user,w.user.id)).map(row=>row.body as Record<string,any>).filter(body=>body.object===first.body.sha256);
 assert.deepEqual(notes.map(body=>body.source.artifact).sort(),[first.digest,second.digest].sort());
 for(const body of notes){
  const proposal={...body,classification:[{value:'ticket',quote:{reference:'src:'+first.body.sha256+'/text@1/l/1',text:'synthetic note'}}]};
  assert.ok(await layer.prepare(w.user,proposal as never,{}));
  const [ref]=await layer.admit(w.user,[proposal],{});
  const stored=JSON.stringify(await layer.readRecord(ref!,w.user));
  const other=body.source.artifact===first.digest?second.digest:first.digest;
  assert.ok(stored.includes(body.source.artifact)&&!stored.includes(other),'the annotation is bound to the upload its note names');
 }
});

test('an older note that two uploads wrote alike is refused rather than bound to a guessed upload (round six, item 5)',async t=>{
 const pg=await startPostgres();t.after(()=>pg.stop());const w=await setup(pg);t.after(()=>w.close());const layer=w.knowledge.feeding!;
 const bytes=Buffer.from('synthetic note uploaded twice before notes named their upload');
 const upload=(session:string)=>w.kit.artifacts.ingest({bytes,mediaType:'text/plain',origin:{upload:{session,message:null}},author:{user:w.user.id},provenanceType:'declared',visibility:{readers:[w.user.id],admins:true,packs:[],shareable:true},readTier:'model_readable'});
 const uploads=[await upload('synthetic-older-1'),await upload('synthetic-older-2')];
 // The notes an older Hub wrote: the same body for both, with `at` and without the upload record.
 const older={schema:'fed-note@1',object:uploads[0]!.body.sha256,product:null,root:null,path:null,source:{system:'upload',bytes:uploads[0]!.body.sha256},by:w.user.id,run:null,at:'2026-10-27T08:00:00.000Z'};
 const write=(layer as unknown as {put(...args:unknown[]):Promise<unknown>}).put.bind(layer);
 await w.kit.store.withTransaction(async tx=>{for(const artifact of uploads)await write(older,w.user,'hub.upload@1',['src:'+older.object],[older.object,artifact.digest],'note:'+artifact.digest,[{key:'knowledge.feeding.object',value:older.object},{key:'knowledge.feeding.product',value:w.user.id}],tx,false,null);});
 const proposal={...older,classification:[{value:'ticket',quote:{reference:'src:'+older.object+'/text@1/l/1',text:'synthetic note'}}]};
 await assert.rejects(()=>layer.prepare(w.user,proposal as never,{}),/无法确定是哪一次上传/);
});

/** Uploads of the same bytes by one user, each its own record, and the note an older Hub wrote for one of them. */
async function olderUploads(w:World,user:World['user'],count:number,label:string){
 const bytes=Buffer.from('synthetic note '+label);
 const uploads:SourceArtifact[]=[];
 for(let index=0;index<count;index++)uploads.push(await w.kit.artifacts.ingest({bytes,mediaType:'text/plain',origin:{upload:{session:`synthetic-${label}-${index}`,message:null}},author:{user:user.id},provenanceType:'declared',visibility:{readers:[user.id],admins:true,packs:[],shareable:true},readTier:'model_readable'}));
 const older={schema:'fed-note@1',object:uploads[0]!.body.sha256,product:null,root:null,path:null,source:{system:'upload',bytes:uploads[0]!.body.sha256},by:user.id,run:null,at:'2026-10-27T08:00:00.000Z'};
 const layer=w.knowledge.feeding!,write=(layer as unknown as {put(...args:unknown[]):Promise<unknown>}).put.bind(layer);
 await w.kit.store.withTransaction(async tx=>{await write(older,user,'hub.upload@1',['src:'+older.object],[older.object,uploads[0]!.digest],'note:'+uploads[0]!.digest,[{key:'knowledge.feeding.object',value:older.object},{key:'knowledge.feeding.product',value:user.id}],tx,false,null);});
 return {uploads,proposal:{...older,classification:[{value:'ticket',quote:{reference:'src:'+older.object+'/text@1/l/1',text:'synthetic note'}}]}};
}

test('who may annotate an upload is checked before the uploader\'s uploads are counted (round-seven review, item 5)',async t=>{
 const pg=await startPostgres();t.after(()=>pg.stop());const w=await setup(pg);t.after(()=>w.close());const layer=w.knowledge.feeding!;
 // Another user names the uploader in an older note: the answer is the same whether the uploader has one upload of the
 // bytes or more than the bound.
 for(const [count,label] of [[1,'probed-once'],[65,'probed-often']] as const){
  const {proposal}=await olderUploads(w,w.user,count,label);
  await assert.rejects(()=>layer.prepare(w.outsider,proposal as never,{}),(error:Error)=>/上传者和管理员/.test(error.message)&&!/超过/.test(error.message),`${count} uploads`);
 }
});

test('an older note is matched among at most 64 of the uploader\'s own uploads, read without every record of the bytes (round-seven review, item 5)',async t=>{
 const pg=await startPostgres();t.after(()=>pg.stop());const w=await setup(pg);t.after(()=>w.close());const layer=w.knowledge.feeding!;
 // Reading the chosen upload's bytes looks at every record of them, as every source read does; finding which upload an older
 // note belongs to adds no such read.
 const all=t.mock.method(w.kit.artifacts,'records');
 const named=await w.kit.artifacts.ingest({bytes:Buffer.from('synthetic note named'),mediaType:'text/plain',origin:{upload:{session:'synthetic-named',message:null}},author:{user:w.user.id},provenanceType:'declared',visibility:{readers:[w.user.id],admins:true,packs:[],shareable:true},readTier:'model_readable'});
 await layer.upload(w.user,named);
 const note=(await layer.entries(w.user,w.user.id)).map(row=>row.body as Record<string,any>).find(body=>body.object===named.body.sha256)!;
 let before=all.mock.calls.length;
 assert.ok(await layer.prepare(w.user,{...note,classification:[{value:'ticket',quote:{reference:'src:'+named.body.sha256+'/text@1/l/1',text:'synthetic note'}}]} as never,{}));
 const byName=all.mock.calls.length-before;
 const {proposal}=await olderUploads(w,w.user,64,'sixty-four');
 before=all.mock.calls.length;
 assert.ok(await layer.prepare(w.user,proposal as never,{}),'64 uploads are compared');
 assert.equal(all.mock.calls.length-before,byName,'the search adds no read of every record of the bytes');
 const over=await olderUploads(w,w.user,65,'sixty-five');
 await assert.rejects(()=>layer.prepare(w.user,over.proposal as never,{}),/超过 64 份相同字节/);
});

test('an older note is refused, not guessed, once the uploader\'s records exceed the bounded read (round-seven review, item 5)',async t=>{
 const pg=await startPostgres();t.after(()=>pg.stop());const w=await setup(pg);t.after(()=>w.close());const layer=w.knowledge.feeding!;
 const {proposal}=await olderUploads(w,w.user,1,'among-many');
 // Later records of other bytes by the same uploader; only their index entries and bodies are read.
 await w.kit.store.withTransaction(async tx=>{for(let index=0;index<2000;index++){const sha=index.toString(16).padStart(64,'0');await w.kit.store.put({kind:'source_artifact',schema:RECORD_SCHEMAS.source_artifact,provenance:'declared',body:{sha256:sha,origin:{upload:{session:'synthetic-many',message:null}},author:{user:w.user.id,declared:null}},index:[{key:'artifact.sha256',value:sha},{key:'artifact.author',value:w.user.id}]},tx);}});
 await assert.rejects(()=>layer.prepare(w.user,proposal as never,{}),/超过 2000 份/);
});

test('a new note that names another person\'s upload of the same bytes is refused (round-seven review, item 5)',async t=>{
 const pg=await startPostgres();t.after(()=>pg.stop());const w=await setup(pg);t.after(()=>w.close());const layer=w.knowledge.feeding!;
 const bytes=Buffer.from('synthetic note uploaded by two people');
 const upload=(user:World['user'])=>w.kit.artifacts.ingest({bytes,mediaType:'text/plain',origin:{upload:{session:'synthetic-'+user.id,message:null}},author:{user:user.id},provenanceType:'declared',visibility:{readers:[w.user.id,w.outsider.id],admins:true,packs:[],shareable:true},readTier:'model_readable'});
 const mine=await upload(w.user),theirs=await upload(w.outsider);
 await layer.upload(w.user,mine);await layer.upload(w.outsider,theirs);
 const note=(await layer.entries(w.user,w.user.id)).map(row=>row.body as Record<string,any>).find(body=>body.object===mine.body.sha256)!;
 const quoted={classification:[{value:'ticket',quote:{reference:'src:'+mine.body.sha256+'/text@1/l/1',text:'synthetic note'}}]};
 assert.ok(await layer.prepare(w.user,{...note,...quoted} as never,{}),'the uploader annotates their own upload');
 await assert.rejects(()=>layer.prepare(w.user,{...note,source:{...note.source,artifact:theirs.digest},...quoted} as never,{}),/上传原件|上传者/);
 await assert.rejects(()=>layer.prepare(w.user,{...note,by:w.outsider.id,source:{...note.source,artifact:theirs.digest},...quoted} as never,{}),/上传者和管理员/);
});

test('a new note for an upload recorded before capture times could be declared says the time was not declared (round-five review, item 5)',async t=>{
 const pg=await startPostgres();t.after(()=>pg.stop());const w=await setup(pg);t.after(()=>w.close());const layer=w.knowledge.feeding!;
 // The record main wrote: an upload never named a capture time, so its captured_at was the Hub's own, and it has no marker.
 const bytes=Buffer.from('synthetic note from before the marker');
 const body:SourceArtifactBody={sha256:'',size:bytes.byteLength,media_type:'text/plain',name:'note.txt',origin:{upload:{session:'synthetic-main',message:null}},author:{user:w.user.id,declared:null},captured_at:'2026-10-27T08:00:00.000Z',provenance_type:'declared',read_tier:'model_readable',requested_read_tier:'model_readable',visibility:{readers:[w.user.id],admins:true,packs:[],shareable:true},scan:scanForCredentials(bytes)};
 body.sha256=(await w.kit.objects.put(bytes,'text/plain')).sha256;
 const legacy=await w.kit.store.put({kind:'source_artifact',schema:RECORD_SCHEMAS.source_artifact,provenance:'declared',created_at:'2026-10-27T08:00:00.004Z',body,index:[{key:'artifact.sha256',value:body.sha256},{key:'artifact.reader',value:w.user.id},{key:'artifact.author',value:w.user.id}]});
 assert.equal('captured_at_declared' in legacy.body,false);
 await layer.upload(w.user,legacy as unknown as SourceArtifact);
 const note=(await layer.entries(w.user,w.user.id)).map(row=>row.body as Record<string,unknown>).find(row=>row.object===body.sha256)!;
 assert.equal('at' in note,false,'the Hub time of an old upload is not claimed as a capture time');
 assert.equal(note.captured_at_declared,false);assert.equal(note.received_at,legacy.created_at);
 assert.ok(await layer.prepare(w.user,{...note,classification:[{value:'ticket',quote:{reference:'src:'+body.sha256+'/text@1/l/1',text:'synthetic note'}}]} as never,{}));
});

test('a current pointer naming a content root selects its own line record when two lines share tree bytes',async t=>{const pg=await startPostgres();t.after(()=>pg.stop());const w=await setup(pg);t.after(()=>w.close());const root=await seed(w,'10.8');await seed(w,'10.9');for(const line of ['10.8','10.9']){const old=await w.kit.pointers.get(seedlingName(w.product.id,line));assert.ok(old);await w.kit.pointers.move({name:old.name,expected:old.target,next:root.root,by:w.admin,run:null,component:'synthetic.feeding@1'});}assert.equal((await w.knowledge.feeding!.seedFor(w.product.id,'10.8'))!.line,'10.8');assert.equal((await w.knowledge.feeding!.seedFor(w.product.id,'10.9'))!.line,'10.9');});

test('knowledge retract appends one record per target kind and leaves a covered target unwritten',async t=>{
 const pg=await startPostgres();t.after(()=>pg.stop());const w=await setup(pg);t.after(()=>w.close());const layer=w.knowledge.feeding!,root=await seed(w),a=await source(w,'SYN-R1'),r1=await run(w);
 const scope={product:w.product.id,root:root.root,line:'10.8',run:r1};const first=await layer.observeSource(w.user,a.body.sha256,scope);
 const entry=(await layer.entries(w.admin,w.product.id)).find(row=>row.body.object===first.objects[0]);assert.ok(entry);
 const at='2026-10-27T09:00:00.000Z';const count=async()=>(await w.kit.store.find({key:'knowledge.feeding.retraction',value:'1',kind:'claim',limit:20})).items.length;
 await assert.rejects(()=>knowledgeRetract(layer,w.user,{entries:[entry.record],runs:[],objects:[],reason:'合成撤回',at}),/只有管理员/);
 const missing='b'.repeat(64),absent=newId('run');
 await assert.rejects(()=>knowledgeRetract(layer,w.admin,{entries:[],runs:[],objects:[missing],reason:'合成撤回',at}),/撤回对象不存在/);
 await assert.rejects(()=>knowledgeRetract(layer,w.admin,{entries:[missing],runs:[],objects:[],reason:'合成撤回',at}),/撤回目标不是已登记的喂入或回注条目/);
 await assert.rejects(()=>knowledgeRetract(layer,w.admin,{entries:[],runs:[absent],objects:[],reason:'合成撤回',at}),/撤回运行不存在/);
 await assert.rejects(()=>knowledgeRetract(layer,w.admin,{entries:[entry.record],runs:[],objects:[],reason:'两行\n原因',at}),/一行/);
 await assert.rejects(()=>knowledgeRetract(layer,w.admin,{entries:[],runs:[],objects:[],reason:'合成撤回',at}),/至少要一个/);
 assert.equal(await count(),0);
 const mixed=await knowledgeRetract(layer,w.admin,{entries:[entry.record],runs:[r1],objects:[first.objects[0]],reason:'合成撤回',at});
 assert.equal(mixed.appended.length,3);assert.equal(await count(),3);
 const lines=formatKnowledgeRetract(mixed);
 assert.match(lines[0],/撤回记录 [0-9a-f]{12}：条目 1 个，原因 合成撤回/);
 assert.match(lines[1],/运行 1 个，原因 合成撤回/);
 assert.match(lines[2],/对象 1 个，原因 合成撤回/);
 assert.equal(lines.at(-1),'原记录未改动；读侧将显示根据已撤回');
 const again=await knowledgeRetract(layer,w.admin,{entries:[entry.record],runs:[r1],objects:[first.objects[0]],reason:'合成撤回',at});
 assert.deepEqual(again.appended,[]);assert.equal(await count(),3);
 assert.match(formatKnowledgeRetract(again)[0],/^这些目标已撤回（撤回记录 [0-9a-f]{12}(、[0-9a-f]{12})*），没有追加$/);
 const r2=await run(w);const partial=await knowledgeRetract(layer,w.admin,{entries:[],runs:[r2],objects:[first.objects[0]],reason:'再撤回一条运行',at});
 assert.equal(partial.appended.length,1);assert.equal(partial.appended[0].kind,'runs');assert.equal(partial.skipped.length,1);assert.equal(await count(),4);
 const partialLines=formatKnowledgeRetract(partial);
 assert.match(partialLines.join('\n'),/已跳过对象 [0-9a-f]{12}：已有撤回记录 /);
 assert.equal(partialLines.at(-1),'原记录未改动；读侧将显示根据已撤回');
});

test('legacy src ranges slice quotation fragments at UTF-8 byte boundaries',async t=>{const pg=await startPostgres();t.after(()=>pg.stop());const w=await setup(pg);t.after(()=>w.close());const layer=w.knowledge.feeding!;const a=await source(w,'SYN-R',{status:'open',affected_lines:[],description:'甲open'});const reference=`src:${a.body.sha256}/json@1/p/fields/description`;
 await layer.quote(w.user,{reference:reference+':3-7',text:'open'});
 await assert.rejects(()=>layer.quote(w.user,{reference:reference+':1-5',text:'open'}),/逐字/);
 await assert.rejects(()=>layer.quote(w.user,{reference:reference+':2-7',text:'open'}),/逐字/);
});
