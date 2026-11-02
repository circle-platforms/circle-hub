// Audit views disclose safe personal summaries and only the grants in which the viewer participates.
import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {startPostgres,type TemporaryPostgres} from '../../testing/postgres.ts';
import {openTestRecords} from '../../testing/records.ts';
import {spaceRecords} from './space-records.ts';
import type {PageContext} from './pages.ts';
import type {Principal} from '../../records/api.ts';

let postgres:TemporaryPostgres;
before(async()=>{postgres=await startPostgres();});after(()=>postgres?.stop());
async function world(){
 const kit=await openTestRecords({postgres}),admin=(await kit.principals.bootstrapAdmin('合成管理员')).user,owner=await kit.principals.createUser(admin,'合成作者'),other=await kit.principals.createUser(admin,'合成成员');
 const ctx=(principal:Principal,query='')=>({principal,admin:principal.role==='admin',url:new URL('http://127.0.0.1/console/records'+query),deps:{records:kit},userName:async(id:string)=>(await kit.principals.get(id))?.name??'—'}) as unknown as PageContext;
 return {kit,admin,owner,other,ctx};
}
test('administrators see participant grants for knowledge, workflows and memory without seeing unrelated grants',async t=>{
 const w=await world();t.after(()=>w.kit.close());const at='2026-11-02T00:00:00.000Z';
 for(const [kind,schema,ownerKey,granteeKey] of [['knowledge_space_grant','knowledge-space-grant@1','knowledge.space.grant','knowledge.space.grantee'],['personal_pack_grant','personal-pack-grant@1','personal.pack.grant_owner','personal.pack.grantee'],['memory_grant','memory-grant@1','memory.grant.owner','memory.grant.grantee']] as const){
  for(const [tag,actor,member,audience] of [['sent',w.admin,w.owner,'member'],['received',w.owner,w.admin,'member'],['unrelated',w.owner,w.other,'member'],['all-admins',w.other,null,'administrators']] as const){
   const body={space:actor.id,by:actor.id,at,action:'grant',audience,member:member?.id??null,...(kind==='personal_pack_grant'?{pack:'synthetic-'+tag}:{path:'/synthetic-'+tag}),...(kind==='memory_grant'?{intent:'a'.repeat(64)}:{})};
   await w.kit.store.put({kind,schema,provenance:'declared',body,index:[{key:ownerKey,value:actor.id},{key:granteeKey,value:member?.id??'administrators'}]});
   if(tag==='unrelated')await w.kit.store.put({kind,schema,provenance:'declared',body:{...body,...(kind==='personal_pack_grant'?{pack:'synthetic-forged'}:{path:'/synthetic-forged'})},index:[{key:granteeKey,value:w.admin.id}]});
  }
 }
 const page=String(await spaceRecords(w.ctx(w.admin),'/console/records'));
 for(const tag of ['sent','received','all-admins'])assert.ok(page.includes('synthetic-'+tag));
 for(const tag of ['unrelated','forged'])assert.ok(!page.includes('synthetic-'+tag));
});
test('refusal summaries show only owner codes and field lines while administrators get counts only',async t=>{
 const w=await world();t.after(()=>w.kit.close());const at='2026-11-02T00:00:00.000Z';
 for(const [by,code,line] of [[w.owner,'MEMORY_CREDENTIALS_DETECTED',3],[w.other,'MEMORY_DOCUMENT_LIMIT',4]] as const)await w.kit.store.put({kind:'action',schema:'memory-refusal@1',provenance:'observed',created_at:at,body:{kind:'validate',by:by.id,at,code,positions:[{field:'markdown',line,detector:'password_assignment'}],message:'PRIVATE-NOTE',intent:'a'.repeat(64),payload:'b'.repeat(64)},index:[{key:'memory.refusal.by',value:by.id}]});
 await w.kit.store.put({kind:'action',schema:'memory-refusal@1',provenance:'observed',created_at:at,body:{kind:'validate',by:w.other.id,at,code:'MEMORY_SPACE_LIMIT',positions:[{field:'title',line:9}]},index:[{key:'memory.refusal.by',value:w.owner.id}]});
 const own=String(await spaceRecords(w.ctx(w.owner),'/console/records'));
 assert.match(own,/MEMORY_CREDENTIALS_DETECTED/);assert.match(own,/Markdown 正文/);assert.match(own,/第 3 行/);assert.doesNotMatch(own,/MEMORY_DOCUMENT_LIMIT|MEMORY_SPACE_LIMIT|PRIVATE-NOTE|aaaaaa|bbbbbb/);
 const other=String(await spaceRecords(w.ctx(w.other),'/console/records'));assert.match(other,/MEMORY_DOCUMENT_LIMIT/);assert.doesNotMatch(other,/MEMORY_CREDENTIALS_DETECTED/);
 const admin=String(await spaceRecords(w.ctx(w.admin),'/console/records'));assert.match(admin,/3 次/);assert.doesNotMatch(admin,/MEMORY_CREDENTIALS_DETECTED|MEMORY_DOCUMENT_LIMIT|MEMORY_SPACE_LIMIT|PRIVATE-NOTE|Markdown 正文|第 3 行|aaaaaa|bbbbbb/);
 const filtered=String(await spaceRecords(w.ctx(w.admin),'\/console/records',w.owner.id,at,at));assert.match(filtered,/2 次/);
 const later=String(await spaceRecords(w.ctx(w.admin),'\/console/records',undefined,'2026-11-03T00:00:00.000Z'));assert.match(later,/0 次/);
});

test('cleared personal folders disappear from administrator and owner receipt views while public destinations and safe facts remain',async t=>{
 const w=await world();t.after(()=>w.kit.close());const root=await w.kit.store.put({kind:'knowledge_space_version',schema:'knowledge-space-version@1',provenance:'projected',body:{space:w.owner.id,used_bytes:0}});
 const privatePath='/synthetic-private-folder',at=new Date().toISOString(),records=[];
 for(const status of ['merged','rejected'] as const){
  const merged=status==='merged';records.push(await w.kit.store.put({kind:'knowledge_share',schema:'knowledge-share@1',provenance:'declared',body:{source:{space:w.owner.id,root:root.digest,path:privatePath,entry:'a'.repeat(64)},by:w.owner.id,at,session:null,status,code:merged?null:'SHARE_UNVERIFIED',message:merged?'':'synthetic-private-folder',...(merged?{target_path:'/synthetic-public'}:{}),team_root:merged?'b'.repeat(64):null,reference:merged?'tree:'+'b'.repeat(64)+'/synthetic-public@'+'a'.repeat(64):null},index:[{key:'knowledge.share.by',value:w.owner.id}]}));
 }
 const before=String(await spaceRecords(w.ctx(w.admin),'/console/records'));assert.match(before,/synthetic-private-folder/);
 const epoch=(await w.kit.personalPayloads!.inspect(root.digest))!.epoch;await w.kit.personalPayloads!.purge(w.owner,epoch);
 for(const by of [w.admin,w.owner]){
  const page=String(await spaceRecords(w.ctx(by),'/console/records'));assert.doesNotMatch(page,/synthetic-private-folder/);assert.match(page,/synthetic-public/);assert.match(page,/已清除的个人文件夹/);assert.match(page,/SHARE_UNVERIFIED/);
 }
 for(const record of records)assert.deepEqual((await w.kit.store.get(record.digest))?.body,record.body,'immutable receipt bodies stay intact');
 assert.equal(await w.kit.personalPayloads!.cleared(root.digest),true);assert.equal(await w.kit.personalPayloads!.cleared('f'.repeat(64)),false);
});
