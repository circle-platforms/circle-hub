// Real application role probes adapted from the security review, using only synthetic accounts and temporary storage.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomBytes,randomUUID} from 'node:crypto';
import {openTestRecords} from '../testing/records.ts';
import {Database,createPool,iso} from './db.ts';
import {grantRuntime} from './migrations.ts';
import {sha256Hex} from './digest.ts';
import {INITIAL_PERSONAL_EPOCH} from './personal-payloads.ts';

async function world(t:{after:(fn:()=>Promise<void>)=>void}){
 const kit=await openTestRecords();t.after(()=>kit.close());const {user:admin}=await kit.principals.bootstrapAdmin('synthetic-admin'),owner=await kit.principals.createUser(admin,'synthetic-owner');
 const db=new Database(createPool(kit.database));t.after(()=>db.end());const role='synthetic_scope_'+randomBytes(4).toString('hex'),password=randomBytes(16).toString('hex');
 await db.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`);await grantRuntime(db,role);
 const runtime=new Database(createPool({...kit.database,user:role,password}));t.after(()=>runtime.end());
 await kit.personalPayloads!.scope(owner.id);return {kit,db,runtime,admin,owner};
}
test('a runtime binding cannot turn an ordinary independent upload into a personal capsule',async t=>{
 const w=await world(t),bytes=Buffer.from('synthetic independent pack file');
 const artifact=await w.kit.artifacts.ingest({bytes,mediaType:'text/plain',name:'SKILL.md',origin:{upload:{session:null,message:null}},author:{user:w.owner.id,declared:null},provenanceType:'declared',visibility:{readers:[w.owner.id],admins:false,packs:[],shareable:false}});
 const row=(await w.db.query('SELECT * FROM records WHERE digest=$1',[artifact.digest])).rows[0],body=String(row.body),hash=sha256Hex(Buffer.from(body)),size=Buffer.byteLength(body);
 const proof=sha256Hex([artifact.digest,hash,w.owner.id,INITIAL_PERSONAL_EPOCH,size,iso(row.created_at),row.kind,row.provenance,row.schema].join(':'));
 await assert.rejects(w.runtime.transaction(async tx=>{
  await w.runtime.query('INSERT INTO personal_payloads VALUES($1,$2,$3,$4)',[w.owner.id,INITIAL_PERSONAL_EPOCH,hash,Buffer.from(body)],tx);
  await w.runtime.query('INSERT INTO personal_record_bindings VALUES($1,$2,$3,$4,$5,$6,$7)',[artifact.digest,w.owner.id,INITIAL_PERSONAL_EPOCH,hash,size,body,proof],tx);
 }),/invalid personal capsule/);
 assert.equal(await w.kit.personalPayloads!.inspect(artifact.digest),null);await w.kit.personalPayloads!.purge(w.owner,INITIAL_PERSONAL_EPOCH);
 assert.ok(await w.kit.store.get(artifact.digest));assert.deepEqual(Buffer.from((await w.kit.objects.get(artifact.body.sha256))!),bytes);
});
test('personal artifacts need a knowledge-source binding of the same owner',async t=>{
 const w=await world(t),input={personalOwner:w.owner.id,bytes:Buffer.from('synthetic private original'),mediaType:'text/plain',origin:{upload:{session:'synthetic'}},author:{user:w.owner.id},provenanceType:'declared' as const,visibility:{readers:[w.owner.id],admins:false,packs:[],shareable:false}};
 await assert.rejects(w.kit.artifacts.ingest(input),/owning knowledge source/);
 await assert.rejects(w.kit.store.withTransaction(async tx=>{
  const a=await w.kit.artifacts.ingest(input,tx);
  await w.kit.store.put({kind:'knowledge_space_source',schema:'knowledge-space-source@1',provenance:'declared',body:{space:w.admin.id,path:'/',sha256:a.body.sha256,artifact:a.digest,size:a.body.size,by:w.admin.id,at:a.created_at}},tx);
 }),/owning knowledge source/);
 assert.equal((await w.db.query('SELECT 1 FROM personal_payloads WHERE owner=$1',[w.owner.id])).rowCount,0);
});
test('runtime cannot insert completion markers or write payloads and objects after purge or into another epoch',async t=>{
 const w=await world(t),record=await w.kit.store.put({kind:'memory_version',schema:'memory-version@1',provenance:'declared',body:{space:w.owner.id,markdown:'synthetic'}}),bytes=Buffer.from('synthetic late insert'),hash=sha256Hex(bytes);
 const denied=(e:unknown)=>(e as {code:string}).code==='42501';
 await assert.rejects(w.runtime.query('INSERT INTO personal_legacy_ready VALUES($1)',[record.digest]),denied);
 await assert.rejects(w.runtime.query('INSERT INTO personal_legacy_retired VALUES($1)',[hash]),denied);
 await assert.rejects(w.runtime.query('INSERT INTO personal_legacy_retire VALUES($1)',[hash]),denied);
 await assert.rejects(w.runtime.query('SELECT hub_finish_personal_retirement($1)',[hash]),/transfer incomplete/);
 await assert.rejects(w.runtime.query('INSERT INTO personal_payloads VALUES($1,$2,$3,$4)',[w.owner.id,randomUUID(),hash,bytes]),/inactive personal scope/);
 await w.kit.personalPayloads!.purge(w.owner,INITIAL_PERSONAL_EPOCH);
 await assert.rejects(w.runtime.query('INSERT INTO personal_payloads VALUES($1,$2,$3,$4)',[w.owner.id,INITIAL_PERSONAL_EPOCH,hash,bytes]),/inactive personal scope/);
 await assert.rejects(w.runtime.query('INSERT INTO personal_objects VALUES($1,$2,$3)',[w.owner.id,INITIAL_PERSONAL_EPOCH,hash]),/inactive personal scope/);
 assert.equal((await w.db.query('SELECT 1 FROM personal_payloads WHERE owner=$1',[w.owner.id])).rowCount,0);
});
test('purge serializes with a direct runtime insert and leaves no late plaintext',async t=>{
 const w=await world(t),bytes=Buffer.from('synthetic concurrent insert'),hash=sha256Hex(bytes);let purge:Promise<void>|undefined;
 await w.runtime.transaction(async tx=>{
  await w.runtime.query('INSERT INTO personal_payloads VALUES($1,$2,$3,$4)',[w.owner.id,INITIAL_PERSONAL_EPOCH,hash,bytes],tx);
  purge=w.kit.personalPayloads!.purge(w.owner,INITIAL_PERSONAL_EPOCH);
  for(let n=0;n<1000;n++){
   const waiting=await w.db.query("SELECT 1 FROM pg_stat_activity WHERE query LIKE 'SELECT hub_purge_personal%' AND wait_event_type='Lock'");
   if(waiting.rowCount)break;if(n===999)assert.fail('purge did not wait for the inserting scope lock');
   await new Promise(resolve=>setTimeout(resolve,5));
  }
 });
 await purge;assert.equal((await w.db.query('SELECT 1 FROM personal_payloads WHERE owner=$1',[w.owner.id])).rowCount,0);
});
