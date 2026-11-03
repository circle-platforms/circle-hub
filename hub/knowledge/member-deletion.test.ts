// Permanent deletion and local-only mode exercise the same payload boundary with synthetic exact captures.
import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {makeWorld,startPostgres} from './test-support.ts';
import {Database,createPool} from '../records/db.ts';
let postgres:Awaited<ReturnType<typeof startPostgres>>;before(async()=>{postgres=await startPostgres();});after(()=>postgres?.stop());
for(const permanent of [false,true])test(`team declarations survive exact private payload removal without retaining paths: ${permanent}`,async t=>{
 const w=await makeWorld(postgres);t.after(w.close);const spaces=w.knowledge.spaces!,text=Buffer.from('合成成员删除署名原文，精确保留。'),file=await spaces.importFile(w.user,text,'text/plain','合成私人文件.txt','/合成私人路径');
 const source=(await w.kit.store.findMany({kind:'knowledge_space_source',key:'knowledge.space.source_hash',values:[file.body.sha256]})).find(row=>(row.body as any).artifact===file.digest)!;
 const signed=await spaces.attributeSource(w.user,source.digest,file.digest),entry=await spaces.write(w.user,{kind:'observation',statement:'合成团队独立知识',grounds:[{reference:'src:'+file.body.sha256,quotation:'精确保留'}]}),shared=await spaces.share(w.user,{root:entry.root,path:'/',entry:entry.entry});assert.ok(shared.team_root);
 const before=await spaces.entryAttributions(w.outsider,shared.team_root,'/',entry.entry);assert.equal(before.length,1);
 if(permanent){const preview=await w.kit.memberDeletions!.preview(w.admin,w.user.id),intent=await w.kit.memberDeletions!.prepare(w.admin,{...preview,operation_id:randomUUID()});await w.kit.memberDeletions!.finish(w.admin,w.user.id,intent.operation_id);}
 else {const epoch=(await w.kit.personalPayloads!.inspect(file.digest))!.epoch;await w.kit.personalPayloads!.purge(w.user,epoch);}
 for(const digest of [source.digest,file.digest,signed.record,entry.root])assert.equal(await w.kit.store.get(digest),null);
 assert.deepEqual(await spaces.entryAttributions(w.outsider,shared.team_root,'/',entry.entry),before);const original=await spaces.source(w.outsider,file.body.sha256,undefined,'model',before[0].artifact);assert.ok(original?.bytes);assert.deepEqual(Buffer.from(original.bytes),text);
 const held=(await w.kit.store.list({kind:'knowledge_team_source_attribution'})).items;assert.equal(held.length,1);assert.ok(!JSON.stringify(held).includes('合成私人路径'));assert.ok(!JSON.stringify(held).includes('合成私人文件'));assert.ok(!JSON.stringify(held).includes(text.toString()));
 const db=new Database(createPool(w.kit.database));t.after(()=>db.end());assert.equal((await db.query('SELECT count(*)::int n FROM personal_payloads WHERE owner=$1',[w.user.id])).rows[0].n,0);
 assert.equal(await spaces.source(w.outsider,file.body.sha256,undefined,'model',file.digest),null);
});
test('an exact private upload, private read, imports, archives and histories disappear while independent equal-byte captures remain',async t=>{
 const w=await makeWorld(postgres);t.after(w.close);const spaces=w.knowledge.spaces!,bytes=Buffer.from('合成成员专属非团队正文');
 const upload=await w.kit.artifacts.ingest({bytes,mediaType:'text/plain',name:'合成私人上传',origin:{upload:{session:'synthetic-delete'}},author:{user:w.user.id},provenanceType:'declared',visibility:{readers:[w.user.id],admins:false,packs:[],shareable:false}});
 const read=await w.kit.artifacts.ingest({bytes,mediaType:'text/plain',origin:{read:{object:'synthetic:record:private'}},author:{user:null},provenanceType:'observed',visibility:{readers:[w.user.id],admins:false,packs:[],shareable:false}});
 await spaces.archiveSource(w.user,{artifact:upload.digest,space:w.user.id,path:'/上传',message:'archive:'+upload.digest});await spaces.archiveSource(w.user,{artifact:read.digest,space:w.user.id,path:'/读取',message:'archive:'+read.digest});await spaces.importFile(w.user,bytes,'text/plain','合成导入','/导入');
 const other=await spaces.importFile(w.outsider,bytes,'text/plain','合成独立采集');await w.knowledge.memory!.write(w.user,{client_key:'synthetic-delete-memory',expected_version:null,title:'合成私人偏好',path:'/',markdown:'合成私人记忆正文'});
 const db=new Database(createPool(w.kit.database));t.after(()=>db.end());const bindings=(await db.query('SELECT record FROM personal_record_bindings WHERE owner=$1',[w.user.id])).rows;assert.ok(bindings.length>8);
 const preview=await w.kit.memberDeletions!.preview(w.admin,w.user.id);assert.ok(preview.counts.archives>=3);const intent=await w.kit.memberDeletions!.prepare(w.admin,{...preview,operation_id:randomUUID()});await w.kit.memberDeletions!.finish(w.admin,w.user.id,intent.operation_id);
 for(const {record}of bindings)assert.equal(await w.kit.store.get(String(record)),null);assert.equal((await db.query('SELECT count(*)::int n FROM personal_payloads WHERE owner=$1',[w.user.id])).rows[0].n,0);assert.ok((await spaces.source(w.outsider,other.body.sha256,undefined,'model',other.digest))?.bytes);assert.equal((await w.kit.memoryIndex!.heads(w.user.id)).length,0);assert.equal((await db.query("SELECT count(*)::int n FROM record_index i JOIN personal_record_bindings b ON b.record=i.digest WHERE b.owner=$1 AND i.key='artifact.object'",[w.user.id])).rows[0].n,0);
});
