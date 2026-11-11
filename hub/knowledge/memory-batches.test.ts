// Batched memory reads preserve scalar authorization, state and personal-payload integrity rules.
import { credentialDetectorsFor } from '../testing/records.ts';
import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {makeWorld,startPostgres} from './test-support.ts';
import {Database,createPool} from '../records/db.ts';
import {IntegrityError,withReadScope} from '../records/api.ts';
let postgres:Awaited<ReturnType<typeof startPostgres>>;
before(async()=>{postgres=await startPostgres();});after(()=>postgres?.stop());
const input=(key:string,path='/shared',enabled=true)=>({title:'合成批次偏好 '+key,markdown:'合成正文 '+key,path,enabled,expected_version:null,client_key:key});
test('memory batches retain independent grants, disabled visibility, owner freeze, revocation and fresh epochs',async t=>{
 const w=await makeWorld(postgres);t.after(w.close);const memory=w.knowledge.memory;
 const shared=await memory.write(w.user,input('shared')),privateDoc=await memory.write(w.user,input('private','/private')),disabled=await memory.write(w.user,input('disabled','/shared',false));
 const team=await memory.write(w.admin,{...input('team-disabled','/',false),space:'team'});
 await memory.grant(w.user,{path:'/shared',audience:'member',member:w.outsider.id});await memory.grant(w.user,{path:'/shared',audience:'administrators'});
 assert.equal((await memory.items(w.user,'personal')).length,3);
 for(const reader of [w.outsider,w.admin]){
  assert.deepEqual((await memory.items(reader,'shared')).map(row=>row.document),[shared.document]);
  assert.equal((await memory.read(reader,shared.document)).markdown,'合成正文 shared');
  for(const hidden of [privateDoc,disabled])await assert.rejects(memory.read(reader,hidden.document),{code:'SOURCE_UNAVAILABLE'});
 }
 assert.equal((await memory.items(w.outsider,'shared',true)).length,0);
 assert.deepEqual((await memory.items(w.admin,'team')).map(row=>row.document),[team.document]);assert.deepEqual(await memory.items(w.outsider,'team'),[]);
 await w.kit.principals.setDisabled(w.admin,w.user.id,true);
 assert.deepEqual(await memory.items(w.outsider,'shared'),[]);await assert.rejects(memory.read(w.outsider,shared.document),{code:'SOURCE_UNAVAILABLE'});await assert.rejects(memory.items(w.user),{code:'SOURCE_UNAVAILABLE'});
 await w.kit.principals.setDisabled(w.admin,w.user.id,false);
 assert.equal((await memory.items(w.outsider,'shared')).length,1);
 await memory.grant(w.user,{path:'/shared',audience:'member',member:w.outsider.id,revoke:true});assert.deepEqual(await memory.items(w.outsider,'shared'),[]);
 await memory.grant(w.user,{path:'/shared',audience:'member',member:w.outsider.id});
 const epoch=(await w.kit.personalPayloads!.scope(w.user.id)).epoch;await w.kit.personalPayloads!.purge(w.user,epoch);
 assert.deepEqual(await memory.items(w.user,'personal'),[]);assert.deepEqual(await memory.items(w.outsider,'shared'),[]);await assert.rejects(memory.read(w.user,shared.document,shared.version),{code:'SOURCE_UNAVAILABLE'});
 const state=await w.kit.personalSync!.state(w.user);await w.kit.personalSync!.resume(w.user,state.epoch,state.state_version);
 const fresh=await memory.write(w.user,input('fresh'));assert.deepEqual((await memory.items(w.user,'personal')).map(row=>row.document),[fresh.document]);assert.deepEqual(await memory.items(w.outsider,'shared'),[]);
 assert.equal((await memory.read(w.admin,team.document)).state,'disabled','personal purge never affects the team copy');
});
test('memory batches reject wrong document bindings and missing active personal payloads rather than treating them as purged',async t=>{
 const w=await makeWorld(postgres);t.after(w.close);const memory=w.knowledge.memory;
 const a=await memory.write(w.user,input('a')),b=await memory.write(w.user,input('b'));
 const heads=w.kit.memoryIndex!.heads.bind(w.kit.memoryIndex),values=await heads(w.user.id);
 w.kit.memoryIndex!.heads=async(...args)=>args[0]===w.user.id?values.map(head=>head.document===a.document?{...head,version:b.version}:head):heads(...args);
 await assert.rejects(memory.items(w.user,'personal'),{code:'SOURCE_UNAVAILABLE'});w.kit.memoryIndex!.heads=heads;
 const db=new Database(createPool(w.kit.database));t.after(()=>db.end());
 await db.query('DELETE FROM personal_payloads WHERE owner=$1 AND sha256=(SELECT sha256 FROM personal_record_bindings WHERE record=$2)',[w.user.id,a.version]);
 await assert.rejects(memory.items(w.user,'personal'),IntegrityError);
 await assert.rejects(withReadScope(()=>memory.read(w.user,a.document)),IntegrityError);
 assert.equal((await memory.precheckGrant(w.user,'/shared'))[0].code,'SOURCE_UNAVAILABLE');
});

test('batched grant preflight preserves scalar first-failure order and scans referenced original text',async t=>{ credentialDetectorsFor(t);
 const w=await makeWorld(postgres);t.after(w.close);const memory=w.knowledge.memory;
 for(const key of ['first','second'])await memory.write(w.user,input(key));
 const heads=await w.kit.memoryIndex!.heads(w.user.id),first=heads[0],last=heads[1];
 const original=(await w.kit.store.get<any>(first.version))!;
 const markdown='DB_PASSWORD='+['Synth3tic','!2498'].join('');
 const dirty=await w.kit.store.put({kind:'memory_version',schema:'memory-version@1',provenance:'declared',body:{...original.body,markdown,bytes:Buffer.byteLength(markdown)}});
 const wrapper=await w.kit.store.put({kind:'memory_version',schema:'memory-version@1',provenance:'declared',body:{...original.body,markdown:null,content_version:dirty.digest,bytes:Buffer.byteLength(markdown)}});
 await w.kit.store.withTransaction(tx=>w.kit.memoryIndex!.apply({...first,version:wrapper.digest},0,tx));
 const db=new Database(createPool(w.kit.database));t.after(()=>db.end());
 await db.query('DELETE FROM personal_payloads WHERE owner=$1 AND sha256=(SELECT sha256 FROM personal_record_bindings WHERE record=$2)',[w.user.id,last.version]);
 const checks=await memory.precheckGrant(w.user,'/shared');
 assert.equal(checks[0].code,'MEMORY_CREDENTIALS_DETECTED','an earlier credential scan still wins over a later missing payload');
 assert.equal(checks[0].state,'violation');assert.ok(!JSON.stringify(checks).includes(markdown));
});
