// All captures, accounts and bytes are synthetic and use temporary PostgreSQL.
import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {makeWorld,startPostgres} from './test-support.ts';
import {runRecord} from '../../contracts/src/fixtures.ts';
import {originalWindow} from './source-archive.ts';
import type {TemporaryPostgres} from '../testing/postgres.ts';
let postgres:TemporaryPostgres;before(async()=>{postgres=await startPostgres();});after(()=>postgres?.stop());
const text=Buffer.from('合成原文：原样保留。');
const save=(artifact:string,space:string,path='/')=>({artifact,space,path,message:'archive:'+artifact});
async function ordinary(w:Awaited<ReturnType<typeof makeWorld>>,session='synthetic-old-session'){
 return w.kit.artifacts.ingest({bytes:text,mediaType:'text/plain',name:'合成原文.txt',origin:{upload:{session}},author:{user:w.user.id},provenanceType:'declared',visibility:{readers:[w.user.id],admins:false,packs:[],shareable:false}});
}
test('browsing never archives; an explicit private copy is exact, idempotent and leaves ordinary run declarations intact',async t=>{
 const w=await makeWorld(postgres);t.after(w.close);const spaces=w.knowledge.spaces!,raw=await ordinary(w),before=await w.kit.store.get(raw.digest);
 const snapshot={...runRecord,run:'run_01arzte2b0dy6pj8cd4avj118q',runner:w.user.id,sources:[{role:'subject' as const,slot:'map',reference:'src:'+raw.body.sha256,artifact:raw.digest,upload_declaration:{by:w.user.id}}]};
 const written=await w.kit.store.put({kind:'run',schema:'run@1',provenance:'declared',body:snapshot,index:[{key:'runs.id',value:snapshot.run}]});const frozen=(await w.kit.store.get(written.digest))!;assert.equal(await w.kit.artifacts.source(w.admin,raw.body.sha256),null);assert.ok((await w.kit.artifacts.sourceForRun(w.admin,raw.body.sha256,snapshot.run))?.bytes);
 assert.equal((await spaces.archive(w.user)).total,0);assert.equal((await spaces.original(w.user,{sha256:raw.body.sha256,artifact:raw.digest})).window?.text,text.toString());assert.equal(await spaces.current(w.user.id),null);
 const saved=await Promise.all(Array.from({length:3},()=>spaces.archiveSource(w.user,save(raw.digest,w.user.id))));assert.equal(new Set(saved.map(row=>row.record)).size,1);assert.notEqual(saved[0].artifact,raw.digest);
 const usage=(await spaces.current(w.user.id))!.body.used_bytes;await spaces.archiveSource(w.user,save(raw.digest,w.user.id));assert.equal((await spaces.current(w.user.id))!.body.used_bytes,usage);
 assert.equal((await spaces.archive(w.user,{scope:'personal'})).total,1);assert.equal(await w.kit.artifacts.mayDeclareUpload(w.user,raw.digest),true);assert.equal(await w.kit.artifacts.mayDeclareUpload(w.user,saved[0].artifact),false);
 assert.ok((await w.kit.artifacts.sourceForRun(w.admin,raw.body.sha256,snapshot.run,{record:raw.digest}))?.bytes);assert.deepEqual(await w.kit.store.get(frozen.digest),frozen);
 assert.equal(await spaces.source(w.admin,raw.body.sha256,undefined,'model',saved[0].artifact),null);assert.equal(await spaces.source(w.outsider,raw.body.sha256,undefined,'model',saved[0].artifact),null);assert.deepEqual(await w.kit.store.get(raw.digest),before);
 const twin=await ordinary(w,'synthetic-other-capture');const second=await spaces.archiveSource(w.user,save(twin.digest,w.user.id));assert.notEqual(second.artifact,saved[0].artifact,'equal bytes never borrow another capture or its later attribution');
});
test('long Unicode presentation pages cover every decoded character exactly once',()=>{
 const text='甲😀\r\n'.repeat(20000),parts:string[]=[];let offset:number|null=0,page=0,pages=0;
 while(offset!==null){const window=originalWindow(text,offset);assert.equal(window.page,page++);pages=window.pages;assert.ok(Buffer.byteLength(window.text)<=16384);assert.ok(!window.text.includes('�'));parts.push(window.text);offset=window.next;}
 assert.equal(parts.join(''),text);assert.equal(page,pages);
});
test('scope, folder, current grants and cursor bindings hide private names, counts and old-version originals after revocation',async t=>{
 const w=await makeWorld(postgres);t.after(w.close);const spaces=w.knowledge.spaces!;
 for(const [name,path]of [['合成公开一','/公开'],['合成公开二','/公开'],['合成私人','/私人']])await spaces.importFile(w.user,Buffer.from(name),'text/plain',name,path);
 await spaces.grant(w.user,{path:'/公开',audience:'member',member:w.outsider.id});const root=(await spaces.current(w.user.id))!.root;
 const page=await spaces.archive(w.outsider,{scope:'shared',limit:1});assert.equal(page.total,2);assert.ok(page.next);assert.ok(page.items.every(row=>row.body.path==='/公开'));assert.ok(!JSON.stringify(page).includes('合成私人'));
 assert.equal((await spaces.archive(w.admin,{scope:'shared'})).total,0);await assert.rejects(spaces.archive(w.admin,{scope:'shared',cursor:page.next!}),{code:'SPACE_VERSION_CONFLICT'});
 assert.equal((await spaces.archive(w.outsider,{scope:'shared',limit:1,cursor:page.next!})).items.length,1);
 await spaces.grant(w.user,{path:'/公开',audience:'member',member:w.outsider.id,revoke:true});assert.equal((await spaces.archive(w.outsider,{scope:'shared'})).total,0);
 await assert.rejects(spaces.archive(w.outsider,{scope:'shared',cursor:page.next!}),{code:'SPACE_VERSION_CONFLICT'});await assert.rejects(spaces.archive(w.outsider,{scope:'shared',space:w.user.id,root}),{code:'SOURCE_UNAVAILABLE'});
 await assert.rejects(spaces.original(w.outsider,{sha256:page.items[0].body.sha256,artifact:page.items[0].body.artifact}),{code:'SOURCE_UNAVAILABLE'});
});
test('personal connector captures stay private even beside equal-byte team copies, and only administrators save team reads',async t=>{
 const w=await makeWorld(postgres);t.after(w.close);const spaces=w.knowledge.spaces!;
 const input={bytes:text,mediaType:'text/plain',name:'合成业务读取',origin:{read:{object:'synthetic:record:source'}},author:{user:null},provenanceType:'observed' as const};
 const personal=await w.kit.artifacts.ingest({...input,visibility:{readers:[w.user.id],admins:false,packs:[],shareable:false}}),team=await w.kit.artifacts.ingest({...input,visibility:{readers:[],admins:true,packs:[],shareable:false}});
 await spaces.archiveSource(w.admin,save(team.digest,'team','/团队原文'));await assert.rejects(spaces.archiveSource(w.user,save(team.digest,'team')),{code:'SOURCE_UNAVAILABLE'});
 await assert.rejects(spaces.archiveSource(w.admin,save(team.digest,'team','/产品/合成')),{code:'SPACE_ENTRY_INVALID'});
 await spaces.archiveSource(w.user,save(personal.digest,w.user.id,'/私人原文'));await assert.rejects(spaces.grant(w.user,{path:'/私人原文',audience:'member',member:w.outsider.id}),{code:'SPACE_ENTRY_INVALID'});
 await spaces.directory(w.user,'/已分享');await spaces.grant(w.user,{path:'/已分享',audience:'member',member:w.outsider.id});await assert.rejects(spaces.archiveSource(w.user,save(personal.digest,w.user.id,'/已分享')),{code:'SPACE_ENTRY_INVALID'});
 assert.equal((await spaces.archive(w.outsider,{scope:'shared'})).total,0);assert.equal((await spaces.archive(w.outsider,{scope:'team'})).total,1);assert.equal((await spaces.source(w.outsider,team.body.sha256,undefined,'model',team.digest))?.artifact.digest,team.digest);
 assert.equal(await spaces.source(w.outsider,personal.body.sha256,undefined,'model',personal.digest),null);
});
test('every quotation match is paged and server-selected, with exact fragment and long-text positions',async t=>{
 const w=await makeWorld(postgres);t.after(w.close);const spaces=w.knowledge.spaces!,body='前言😀\r\n'+'合成引文\r\n'.repeat(100)+'尾部';
 const file=await spaces.importFile(w.user,Buffer.from(body),'text/plain','合成长文');const entry=await spaces.write(w.user,{kind:'observation',statement:'合成重复引用',grounds:[{reference:'src:'+file.body.sha256,quotation:'合成引文'}]});const query={sha256:file.body.sha256,artifact:file.digest,root:entry.root,path:'/',entry:entry.entry,ground:0};
 const page=await spaces.original(w.user,query);assert.equal(page.status,'ambiguous');assert.equal(page.matches?.total,100);assert.equal(page.matches?.matches.length,32);assert.equal(page.selected,undefined);
 const last=await spaces.original(w.user,{...query,match:99});assert.equal(last.selected?.ordinal,99);assert.equal(last.selected?.line,101);assert.ok(last.window?.highlight);await assert.rejects(spaces.original(w.user,{...query,match:100}),{code:'SPACE_VERSION_CONFLICT'});
 const fragment=await spaces.write(w.user,{kind:'observation',statement:'合成明确片段',grounds:[{reference:'src:'+file.body.sha256+'/text@1/l/2',quotation:'合成引文'}]});const located=await spaces.original(w.user,{...query,root:fragment.root,entry:fragment.entry});assert.equal(located.status,'resolved');assert.equal(located.parsed,true);assert.equal(located.selected?.line,1);
 const long=await spaces.importFile(w.user,Buffer.from('甲'.repeat(20000)+'合成唯一尾句'),'text/plain','合成长文尾部');const longEntry=await spaces.write(w.user,{kind:'observation',statement:'合成长文唯一位置',grounds:[{reference:'src:'+long.body.sha256,quotation:'合成唯一尾句'}]});const tail=await spaces.original(w.user,{sha256:long.body.sha256,artifact:long.digest,root:longEntry.root,path:'/',entry:longEntry.entry,ground:0});assert.equal(tail.status,'resolved');assert.ok(tail.window!.offset>0);assert.ok(tail.window!.text.includes('合成唯一尾句'));assert.ok(Buffer.byteLength(tail.window!.text)<=16384);
});
test('revocation during asynchronous resolution prevents fragments and counts from being disclosed',async t=>{
 const w=await makeWorld(postgres);t.after(w.close);const spaces=w.knowledge.spaces!,file=await spaces.importFile(w.user,text,'text/plain','合成撤权原文','/公开');
 const entry=await spaces.write(w.user,{kind:'observation',statement:'合成撤权引用',path:'/公开',grounds:[{reference:'src:'+file.body.sha256+'/text@1/l/1',quotation:'原样保留'}]});await spaces.grant(w.user,{path:'/公开',audience:'member',member:w.outsider.id});
 const source=spaces.source.bind(spaces);let reads=0;spaces.source=async (...args)=>{const value=await source(...args);if(args[0].id===w.outsider.id&&++reads===2)await spaces.grant(w.user,{path:'/公开',audience:'member',member:w.outsider.id,revoke:true});return value;};
 await assert.rejects(spaces.original(w.outsider,{sha256:file.body.sha256,artifact:file.digest,root:entry.root,path:'/公开',entry:entry.entry,ground:0}),{code:'SOURCE_UNAVAILABLE'});
});
test('revocation while archive metadata loads refuses the whole page instead of returning stale private counts',async t=>{
 const w=await makeWorld(postgres);t.after(w.close);const spaces=w.knowledge.spaces!,file=await spaces.importFile(w.user,text,'text/plain','合成不可泄露名称','/公开');await spaces.grant(w.user,{path:'/公开',audience:'member',member:w.outsider.id});
 const get=w.kit.store.get.bind(w.kit.store);let revoked=false;
 w.kit.store.get=async<B>(digest:string,tx?:import('../records/api.ts').Transaction)=>{const value=await get<B>(digest,tx);if(digest===file.digest&&!revoked){revoked=true;await spaces.grant(w.user,{path:'/公开',audience:'member',member:w.outsider.id,revoke:true});}return value;};
 await assert.rejects(spaces.archive(w.outsider,{scope:'shared'}),{code:'SPACE_VERSION_CONFLICT'});
});
test('capacity and transaction failures preserve the ordinary capture and leave no private archive copy',async t=>{
 const w=await makeWorld(postgres);t.after(w.close);const spaces=w.knowledge.spaces!,raw=await ordinary(w);await spaces.setCapacity(w.admin,w.user.id,0);
 await assert.rejects(spaces.importFile(w.user,text,'text/plain','合成首个私人原文'),{code:'SPACE_CAPACITY_EXCEEDED'});await assert.rejects(spaces.archiveSource(w.user,save(raw.digest,w.user.id)),{code:'SPACE_CAPACITY_EXCEEDED'});assert.equal((await w.kit.artifacts.records(raw.body.sha256)).length,1);
 await spaces.setCapacity(w.admin,w.user.id,1024**3);const put=w.kit.store.put.bind(w.kit.store);w.kit.store.put=async(input,tx)=>{if(input.kind==='knowledge_space_version')throw new Error('synthetic archive transaction failure');return put(input,tx);};
 await assert.rejects(spaces.archiveSource(w.user,save(raw.digest,w.user.id)),/synthetic archive transaction failure/);w.kit.store.put=put;assert.equal((await w.kit.artifacts.records(raw.body.sha256)).length,1);assert.equal(await spaces.current(w.user.id),null);assert.equal((await spaces.archive(w.user)).total,0);assert.equal(await w.kit.artifacts.mayDeclareUpload(w.user,raw.digest),true);
 assert.ok((await spaces.archiveSource(w.user,save(raw.digest,w.user.id))).record);
});
