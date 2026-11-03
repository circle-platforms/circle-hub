// Integrated sync guards add fixed queries; off-page knowledge must not add per-entry SQL.
import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import pg from 'pg';
import {createTestHub} from './testing-real.ts';
import {startPostgres,type TemporaryPostgres} from '../testing/postgres.ts';
import {openConsole} from '../../tests/acceptance/support/console.ts';
let postgres:TemporaryPostgres;
before(async()=>{postgres=await startPostgres();});after(()=>postgres?.stop());
test('integrated knowledge home and selected entry keep bounded SQL after the visible page is full',async t=>{
 const hub=await createTestHub({postgres,repositoryPacks:false,stubs:false,mindmapSkill:false,workbookSkill:false,xmlSkill:false,htmlSkill:false,requireOsIsolation:false});t.after(()=>hub.close());
 const by=hub.admin.principal,spaces=hub.hub.knowledge.spaces!,client=await openConsole(hub,hub.admin.token);let entry='';
 const add=async(start:number,end:number)=>{for(let n=start;n<end;n++){const saved=await spaces.write(by,{kind:'observation',statement:'合成增长条目 '+n,path:'/notes'});entry||=saved.entry;}};
 await add(0,125);
 const original=pg.Client.prototype.query;let counting=false,calls=0;
 pg.Client.prototype.query=function(this:pg.Client,...args:unknown[]){if(counting)calls++;return Reflect.apply(original,this,args);} as typeof original;t.after(()=>{pg.Client.prototype.query=original;});
 const paths=['/console/knowledge','/console/knowledge/space?'+new URLSearchParams({space:by.id,path:'/notes',entry})];
 const measure=async(path:string)=>{calls=0;counting=true;let reply;try{reply=await client.get(path);}finally{counting=false;}assert.equal(reply.status,200);assert.doesNotMatch(reply.body,/该内容不存在或无权查看|Hub 内部错误/);assert.ok(reply.body.includes('合成增长条目'));return calls;};
 const small=[];for(const path of paths)small.push(await measure(path));
 await add(125,500);
 const large=[];for(const path of paths)large.push(await measure(path));
 assert.deepEqual(large,small,'home and entry detail must keep the same statements when only off-page data grows');
 t.diagnostic(`125 / 500 personal entries: home ${small[0]} / ${large[0]}, entry ${small[1]} / ${large[1]} SQL`);
});
