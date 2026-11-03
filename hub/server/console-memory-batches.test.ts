// Physical PostgreSQL statement counts over real loopback pages, synthetic data and fresh read scopes.
import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import pg from 'pg';
import {createTestHub} from './testing-real.ts';
import {startPostgres,type TemporaryPostgres} from '../testing/postgres.ts';
import {openConsole} from '../../tests/acceptance/support/console.ts';
let postgres:TemporaryPostgres;
before(async()=>{postgres=await startPostgres();});after(()=>postgres?.stop());
test('memory list and selected detail batch 25 to 100 documents per member without losing disabled rows',async t=>{
 const hub=await createTestHub({postgres,repositoryPacks:false,stubs:false,mindmapSkill:false,workbookSkill:false,xmlSkill:false,htmlSkill:false,requireOsIsolation:false});t.after(()=>hub.close());
 const member=await hub.createUser('合成批次记忆成员'),reader=await hub.createUser('合成部分可读成员'),memory=hub.hub.knowledge.memory,by=member.principal,client=await openConsole(hub,member.token),shared=await openConsole(hub,reader.token),admin=await openConsole(hub,hub.admin.token);
 await memory.grant(by,{path:'/偏好/共享',audience:'member',member:reader.user.id});await memory.grant(by,{path:'/偏好/共享',audience:'administrators'});
 const saved:Awaited<ReturnType<typeof memory.write>>[]=[];
 for(let n=0;n<25;n++){
  saved.push(await memory.write(by,{title:'合成批次记忆 '+n,markdown:'合成正文 '+n,path:n%2?'/偏好/私人':'/偏好/共享',enabled:n<5,expected_version:null,client_key:'batch-memory-'+n}));
 }
 // A state-only version refers to original content; preflight must still read and inspect that body in a batch.
 for(const row of saved)await memory.write(by,{document:row.document,expected_version:row.version,title:'合成修订 '+row.document.slice(0,8),client_key:'rename-'+row.document});
 const original=pg.Client.prototype.query;let counting=false,calls=0;
 pg.Client.prototype.query=function(this:pg.Client,...args:unknown[]){if(counting)calls++;return Reflect.apply(original,this,args);} as typeof original;t.after(()=>{pg.Client.prototype.query=original;});
 const measure=async(viewer=client,scope='personal',document?:string)=>{calls=0;counting=true;let reply;try{reply=await viewer.get('/console/knowledge?'+new URLSearchParams({view:'memory',scope,...(document?{document}:{})}));}finally{counting=false;}assert.equal(reply.status,200);assert.doesNotMatch(reply.body,/该内容不存在或无权查看|Hub 内部错误/);return {calls,body:reply.body};};
 const read=async()=>[await measure(),await measure(client,'personal',saved[0].document),await measure(shared,'shared'),await measure(shared,'shared',saved[0].document),await measure(admin,'shared'),await measure(admin,'shared',saved[0].document)];
 const small=await read();
 for(let n=25;n<100;n++){
  const row=await memory.write(by,{title:'合成批次记忆 '+n,markdown:'合成正文 '+n,path:n%2?'/偏好/私人':'/偏好/共享',enabled:false,expected_version:null,client_key:'batch-memory-'+n});
  await memory.write(by,{document:row.document,expected_version:row.version,title:'合成修订 '+row.document.slice(0,8),client_key:'rename-'+row.document});saved.push(row);
 }
 const large=await read();
 assert.deepEqual(large.map(v=>v.calls),small.map(v=>v.calls),'list and detail SQL must not grow with documents or body indirections');
 for(const reply of large.slice(0,2))assert.ok(reply.body.includes('合成修订 '+saved[99].document.slice(0,8)),'the hundredth disabled document remains visible to its owner');
 for(const reply of large.slice(2)){assert.ok(reply.body.includes('合成修订 '+saved[0].document.slice(0,8)));assert.ok(!reply.body.includes('合成修订 '+saved[99].document.slice(0,8)),'disabled or private documents never reach a recipient');}
 t.diagnostic(`25 / 100 documents per member: owner list/detail ${small[0].calls}/${small[1].calls} → ${large[0].calls}/${large[1].calls}; grantee ${small[2].calls}/${small[3].calls} → ${large[2].calls}/${large[3].calls}; administrator recipient ${small[4].calls}/${small[5].calls} → ${large[4].calls}/${large[5].calls} SQL`);
});
