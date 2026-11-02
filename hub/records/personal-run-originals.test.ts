// Personal links are removable; a run's independent original preserves its exact capture and bytes.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {openTestRecords} from '../testing/records.ts';
import {Database,createPool} from './db.ts';
import {newId} from './ids.ts';
import {INITIAL_PERSONAL_EPOCH} from './api.ts';

async function setup(t:{after:(fn:()=>Promise<void>)=>void}){
 const kit=await openTestRecords();t.after(()=>kit.close());const {user:owner}=await kit.principals.bootstrapAdmin('synthetic-holder'),other=await kit.principals.createUser(owner,'synthetic-other');
 const capture=(text:string)=>kit.store.withTransaction(async tx=>{const bytes=Buffer.from(text),artifact=await kit.artifacts.ingest({personalOwner:owner.id,bytes,mediaType:'text/plain',name:'synthetic.txt',origin:{upload:{session:null,message:null}},author:{user:owner.id},provenanceType:'declared',visibility:{readers:[owner.id],admins:false,packs:[],shareable:false}},tx);
 const link=await kit.store.put({kind:'knowledge_space_source',schema:'knowledge-space-source@1',provenance:'declared',body:{space:owner.id,path:'/',sha256:artifact.body.sha256,artifact:artifact.digest,size:bytes.length,by:owner.id,at:artifact.created_at},index:[{key:'knowledge.space.source_hash',value:artifact.body.sha256}]},tx);return {bytes,artifact,link};});
 const run=(artifact:string,sha256:string)=>kit.store.put({kind:'run',schema:'run@1',provenance:'observed',body:{run:newId('run'),runner:owner.id,sources:[{reference:'src:'+sha256,artifact,upload_declaration:{by:owner.id}}]}});
 return {kit,owner,other,capture,run};
}

test('a run-bound personal upload survives purge while its personal link and an unbound original disappear',async t=>{
 const w=await setup(t),held=await w.capture('synthetic run-held original'),unheld=await w.capture('synthetic unbound original');
 const db=new Database(createPool(w.kit.database));t.after(()=>db.end());const physical=async()=>(await db.query<{body:string}>('SELECT body FROM records WHERE digest=$1',[held.artifact.digest])).rows[0].body,before=await physical();
 await w.run(held.artifact.digest,held.artifact.body.sha256);await w.kit.personalPayloads!.purge(w.owner,INITIAL_PERSONAL_EPOCH);
 assert.deepEqual((await w.kit.store.get(held.artifact.digest))?.body,held.artifact.body,'the independent run keeps the original logical capture');assert.equal(await physical(),before,'no append-only row is rewritten');
 assert.deepEqual(Buffer.from((await w.kit.objects.get(held.artifact.body.sha256))!),held.bytes);assert.equal(await w.kit.store.get(held.link.digest),null);assert.equal(await w.kit.store.get(unheld.artifact.digest),null);assert.equal(await w.kit.objects.get(unheld.artifact.body.sha256),null);
 assert.equal(await w.kit.artifacts.source(w.other,held.artifact.body.sha256,{record:held.artifact.digest}),null);assert.equal(await w.kit.artifacts.mayDeclareUpload(w.owner,held.artifact.digest),false,'retention does not turn a personal original into an ordinary team-import declaration');
 assert.equal((await w.kit.personalSync!.state(w.owner)).used_bytes,0);
});

test('an aborted run append does not create an independent original holder',async t=>{
 const w=await setup(t),source=await w.capture('synthetic aborted run bytes'),db=new Database(createPool(w.kit.database));t.after(()=>db.end());
 await db.query("CREATE FUNCTION synthetic_hold_failure() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'synthetic holder failure';END$$");await db.query('CREATE TRIGGER synthetic_hold_failure BEFORE INSERT ON run_originals FOR EACH ROW EXECUTE FUNCTION synthetic_hold_failure()');
 await assert.rejects(w.run(source.artifact.digest,source.artifact.body.sha256),/synthetic holder failure/);
 assert.equal((await db.query('SELECT 1 FROM run_originals')).rowCount,0);assert.equal((await w.kit.store.list({kind:'run',limit:10})).items.length,0);
 await db.query('DROP TRIGGER synthetic_hold_failure ON run_originals');await w.kit.personalPayloads!.purge(w.owner,INITIAL_PERSONAL_EPOCH);assert.equal(await w.kit.objects.get(source.artifact.body.sha256),null);
});

test('the migration backfill preserves a pre-existing run holder and exact source digest',async t=>{
 const w=await setup(t),source=await w.capture('synthetic older run bytes'),db=new Database(createPool(w.kit.database));t.after(()=>db.end());
 // Simulate the pre-17 insertion boundary without disabling any append-only protection.
 await db.query('ALTER TABLE records DISABLE TRIGGER records_run_originals');const run=await w.run(source.artifact.digest,source.artifact.body.sha256);await db.query('ALTER TABLE records ENABLE TRIGGER records_run_originals');assert.equal((await db.query('SELECT 1 FROM run_originals')).rowCount,0);
 await db.query('SELECT public.hub_keep_run_originals($1,false)',[run.digest]);await w.kit.personalPayloads!.purge(w.owner,INITIAL_PERSONAL_EPOCH);assert.deepEqual((await w.kit.store.get(source.artifact.digest))?.body,source.artifact.body);assert.deepEqual(Buffer.from((await w.kit.objects.get(source.artifact.body.sha256))!),source.bytes);
});

test('a runtime run append can retain its original only through the owner-defined trigger',async t=>{
 const w=await setup(t),source=await w.capture('synthetic restricted run bytes'),db=new Database(createPool(w.kit.database));t.after(()=>db.end());
 const {randomBytes}=await import('node:crypto'),{grantRuntime}=await import('./migrations.ts'),{PgRecordStore}=await import('./store.ts'),role='synthetic_run_holder_'+randomBytes(4).toString('hex'),password=randomBytes(16).toString('hex');
 await db.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`);await db.query(`REVOKE TEMPORARY ON DATABASE "${w.kit.database.database}" FROM PUBLIC`);await grantRuntime(db,role);
 const rt=new Database(createPool({...w.kit.database,user:role,password}));t.after(()=>rt.end());await assert.rejects(rt.query('SELECT hub_keep_run_originals($1,false)',['0'.repeat(64)]),(e:unknown)=>(e as {code:string}).code==='42501');await assert.rejects(rt.query('INSERT INTO run_originals(artifact) VALUES($1)',[source.artifact.digest]),(e:unknown)=>(e as {code:string}).code==='42501');
 const store=new PgRecordStore(rt,{maxRecordBytes:w.kit.config.limits.maxRecordBytes,now:()=>new Date()});await store.put({kind:'run',schema:'run@1',provenance:'observed',body:{run:newId('run'),runner:w.owner.id,sources:[{reference:'src:'+source.artifact.body.sha256,artifact:source.artifact.digest,upload_declaration:{by:w.owner.id}}]}});
 await w.kit.personalPayloads!.purge(w.owner,INITIAL_PERSONAL_EPOCH);assert.deepEqual((await store.get(source.artifact.digest))?.body,source.artifact.body);await assert.rejects(rt.query('UPDATE run_originals SET body=$1',['{}']),(e:unknown)=>(e as {code:string}).code==='42501');
});
