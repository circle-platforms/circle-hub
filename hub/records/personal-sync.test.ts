import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {readFile,access} from 'node:fs/promises';
import {join} from 'node:path';
import {before,after,test} from 'node:test';
import {encodePersonalSyncObject} from '../../contracts/src/sync-canonical.ts';
import {PersonalSyncReceipt,PersonalSyncSessionReply,PersonalSyncInventory,PersonalSyncTransfer} from '../../contracts/src/sync.ts';
import {SyncObjectKindSchema} from '../../contracts/generated/vocabulary.ts';
import {openTestRecords} from '../testing/records.ts';
import {startPostgres} from '../testing/postgres.ts';
import {openRecords} from './index.ts';
import {Database,createPool} from './db.ts';
import {grantRuntime} from './migrations.ts';
import {sha256Hex} from './digest.ts';
import {canonicalize} from './canonical.ts';
let postgres:Awaited<ReturnType<typeof startPostgres>>;
before(async()=>{postgres=await startPostgres();});after(()=>postgres?.stop());
const kinds=SyncObjectKindSchema.enum;
const pack=(object:unknown)=>{const bytes=encodePersonalSyncObject(object);return {id:sha256Hex(bytes),bytes_base64:Buffer.from(bytes).toString('base64')};};
const blob=(text:string)=>pack({schema:'personal-sync-object@1',kind:kinds.bytes,body:{bytes_base64:Buffer.from(text).toString('base64')}});
const batch=(epoch:string,objects:ReturnType<typeof pack>[],operation_id=randomUUID())=>({schema:'personal-sync-upload@1',epoch,operation_id,objects});
async function world(t:{after:(fn:()=>Promise<void>)=>void},options:Parameters<typeof openTestRecords>[0]={}){
 const kit=await openTestRecords({postgres,...options});t.after(()=>kit.close());
 const {user:admin}=await kit.principals.bootstrapAdmin('synthetic-sync-admin'),owner=await kit.principals.createUser(admin,'synthetic-sync-owner'),other=await kit.principals.createUser(admin,'synthetic-sync-other');
 const api=kit.personalSync!,db=new Database(createPool(kit.database));t.after(()=>db.end());
 return {kit,api,db,admin,owner,other};
}
async function session(w:Awaited<ReturnType<typeof world>>,by=w.owner){
 const state=await w.api.state(by),client_id=randomUUID();await w.api.registerClient(by,{client_id,name:'synthetic-device'});
 const opened=await w.api.openSession(by,{client_id,epoch:state.epoch,known_state:state.state_version,base_snapshot:null});PersonalSyncSessionReply.parse(opened);return opened;
}

test('heads and stable item identities survive restart, separate owners and kinds, and ignore transfer activity',async t=>{
 const w=await world(t),initial=await w.api.state(w.owner);assert.equal(initial.snapshot,null);assert.equal(initial.last_synced_at,null);assert.equal(initial.mode,'hub');assert.equal(initial.used_bytes,0);
 const ids=await Promise.all(Array.from({length:12},()=>w.api.stableItem(w.owner,kinds.directory_revision,'synthetic-directory')));assert.equal(new Set(ids).size,1);
 assert.notEqual(await w.api.stableItem(w.other,kinds.directory_revision,'synthetic-directory'),ids[0]);
 assert.notEqual(await w.api.stableItem(w.owner,kinds.memory_revision,'synthetic-directory'),ids[0]);
 const opened=await session(w);assert.equal(opened.state.state_version,initial.state_version);
 await w.api.upload(w.owner,opened.session_id,batch(initial.epoch,[blob('synthetic staged only')]));
 assert.equal((await w.api.state(w.owner)).state_version,initial.state_version);assert.equal((await w.api.state(w.owner)).last_synced_at,null);
 const reopened=await openRecords({...w.kit.config,database:w.kit.database},{migrate:false,keyProvider:w.kit.keyProvider});t.after(()=>reopened.close());
 assert.equal(await reopened.personalSync!.stableItem(w.owner,kinds.directory_revision,'synthetic-directory'),ids[0]);
 assert.equal((await reopened.personalSync!.state(w.owner)).state_version,initial.state_version);
 const native=await w.kit.store.put({kind:'knowledge_space_version',schema:'knowledge-space-version@1',provenance:'projected',body:{space:w.owner.id,used_bytes:321}});
 assert.notEqual((await w.api.state(w.owner)).state_version,initial.state_version);assert.ok(native.digest);
});

test('shared canonical fixtures transfer byte-for-byte without publishing; a bad batch or database failure rolls back completely',async t=>{
 const w=await world(t),s=await session(w),epoch=s.state.epoch;
 const fixtures=JSON.parse(await readFile(new URL('../../contracts/test-fixtures/sync/v1/scenarios.json',import.meta.url),'utf8'));
 const objects=fixtures.objects.map((o:{id:string;canonical:string})=>({id:o.id,bytes_base64:Buffer.from(o.canonical).toString('base64')}));
 const receipt=await w.api.upload(w.owner,s.session_id,batch(epoch,objects));assert.equal(receipt.counts.accepted,objects.length);PersonalSyncReceipt.parse(receipt);
 const transfer=await w.api.download(w.owner,s.session_id,{epoch,objects:objects.map((o:{id:string})=>o.id)});PersonalSyncTransfer.parse(transfer);assert.deepEqual(transfer.objects,objects);
 assert.equal((await w.api.state(w.owner)).snapshot,null);
 const good=blob('synthetic atomic success'),bad=blob('synthetic bad identity'),before=(await w.api.state(w.owner)).used_bytes;
 await assert.rejects(w.api.upload(w.owner,s.session_id,batch(epoch,[good,{...bad,id:'f'.repeat(64)}])),{code:'SYNC_OBJECT_HASH_MISMATCH'});
 assert.equal(await w.api.object(w.owner,epoch,good.id),null);assert.equal((await w.api.state(w.owner)).used_bytes,before);
 const duplicate=Buffer.from('{"schema":"personal-sync-object@1","kind":"bytes","body":{"bytes_base64":"","bytes_base64":""}}');
 await assert.rejects(w.api.upload(w.owner,s.session_id,batch(epoch,[{id:sha256Hex(duplicate),bytes_base64:duplicate.toString('base64')}])),{code:'SYNC_OBJECT_INVALID'});
 await assert.rejects(w.api.upload(w.owner,s.session_id,batch(epoch,[good,good])),{code:'SYNC_OBJECT_INVALID'});
 await w.db.query("CREATE FUNCTION synthetic_sync_failure() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RAISE EXCEPTION 'synthetic insert failure'; END $f$");
 await w.db.query('CREATE TRIGGER synthetic_sync_failure BEFORE INSERT ON personal_sync_operations FOR EACH ROW EXECUTE FUNCTION synthetic_sync_failure()');
 await assert.rejects(w.api.upload(w.owner,s.session_id,batch(epoch,[good])),/synthetic insert failure/);
 await w.db.query('DROP TRIGGER synthetic_sync_failure ON personal_sync_operations');
 assert.equal(await w.api.object(w.owner,epoch,good.id),null);assert.equal((await w.api.state(w.owner)).used_bytes,before);
 assert.ok((await w.api.upload(w.owner,s.session_id,batch(epoch,[good]))).counts.accepted);
});

test('lost responses replay one durable receipt, reject operation reuse and charge same-account duplicates once',async t=>{
 const w=await world(t),s=await session(w),epoch=s.state.epoch,object=blob('synthetic receipt body'),input=batch(epoch,[object]);
 const before=(await w.api.state(w.owner)).used_bytes,first=await w.api.upload(w.owner,s.session_id,input),after=(await w.api.state(w.owner)).used_bytes;
 assert.deepEqual(await w.api.upload(w.owner,s.session_id,input),first);
 assert.deepEqual(await w.api.operation(w.owner,epoch,input.operation_id),first);
 await assert.rejects(w.api.upload(w.owner,s.session_id,{...input,objects:[blob('different synthetic body')]}),{code:'IDEMPOTENCY_MISMATCH'});
 const second=await w.api.upload(w.owner,s.session_id,batch(epoch,[object]));assert.equal(second.counts.accepted,0);assert.equal(second.counts.existing,1);assert.equal((await w.api.state(w.owner)).used_bytes,after);
 const decoded=JSON.parse(Buffer.from(object.bytes_base64,'base64').toString());
 const charge=Buffer.from(object.bytes_base64,'base64').length-decoded.body.bytes_base64.length+Buffer.from(decoded.body.bytes_base64,'base64').length;
 assert.equal(after-before,charge,'byte objects charge raw bytes plus their object metadata, not base64 expansion');
 const raw=(await w.db.query('SELECT receipt FROM personal_sync_operations WHERE owner=$1',[w.owner.id])).rows;
 assert.ok(raw.every(row=>!String(row.receipt).includes('synthetic receipt body')));
 const reopened=await openRecords({...w.kit.config,database:w.kit.database},{migrate:false,keyProvider:w.kit.keyProvider});t.after(()=>reopened.close());
 assert.deepEqual(await reopened.personalSync!.operation(w.owner,epoch,input.operation_id),first);
 assert.deepEqual(await reopened.personalSync!.download(w.owner,s.session_id,{epoch,objects:[object.id]}),{objects:[object],missing:[]});
});

test('foreign objects and sessions look absent even to administrators; disabled accounts and a purged epoch stop every transfer',async t=>{
 const w=await world(t),a=await session(w),b=await session(w,w.other),c=await session(w,w.admin),object=blob('synthetic isolated bytes'),epoch=a.state.epoch;
 await w.api.upload(w.owner,a.session_id,batch(epoch,[object]));
 for(const [by,s]of [[w.other,b],[w.admin,c]] as const){
  assert.deepEqual(await w.api.missing(by,s.session_id,{epoch,objects:[object.id,'f'.repeat(64)]}),{missing:[object.id,'f'.repeat(64)]});
  assert.deepEqual(await w.api.download(by,s.session_id,{epoch,objects:[object.id,'f'.repeat(64)]}),{objects:[],missing:[object.id,'f'.repeat(64)]});
  await assert.rejects(w.api.inventory(by,a.session_id,epoch),{code:'SOURCE_UNAVAILABLE'});
  await assert.rejects(w.api.inventory(by,randomUUID(),epoch),{code:'SOURCE_UNAVAILABLE'});
  assert.equal(await w.api.object(by,epoch,object.id),null);
 }
 assert.equal(await w.kit.artifacts.source(w.owner,object.id),null,'transport admission confers no source or model-reader qualification');
 await assert.rejects(access(join(w.kit.dataDir,'objects',object.id.slice(0,2),object.id)));
 await w.api.upload(w.other,b.session_id,batch(epoch,[object]));
 assert.equal((await w.db.query('SELECT count(*)::int AS n FROM personal_payloads WHERE sha256=$1',[object.id])).rows[0].n,2);
 await w.kit.principals.setDisabled(w.admin,w.owner.id,true);
 await assert.rejects(w.api.state(w.owner),{code:'SOURCE_UNAVAILABLE'});await assert.rejects(w.api.download(w.owner,a.session_id,{epoch,objects:[object.id]}),{code:'SOURCE_UNAVAILABLE'});
 await w.kit.principals.setDisabled(w.admin,w.owner.id,false);
 await w.kit.personalPayloads!.purge(w.owner,epoch);
 assert.equal((await w.api.state(w.owner)).mode,'local');assert.equal((await w.api.state(w.owner)).used_bytes,0);
 await assert.rejects(w.api.upload(w.owner,a.session_id,batch(epoch,[object])),{code:'SYNC_MODE_LOCAL'});
 await assert.rejects(w.api.download(w.owner,a.session_id,{epoch,objects:[object.id]}),{code:'SYNC_MODE_LOCAL'});
 assert.deepEqual((await w.api.download(w.other,b.session_id,{epoch,objects:[object.id]})).objects,[object]);
});

test('native logical bytes are rederived rather than trusting legacy counters and concurrent staged batches cannot exceed capacity',async t=>{
 const w=await world(t),s=await session(w),epoch=s.state.epoch,at='2026-11-03T00:00:00.000Z';
 const before=(await w.api.state(w.owner)).used_bytes;
 const leaf=await w.kit.objects.put(Buffer.from(canonicalize({name:'synthetic',children:[],entries:[]})),'application/json',undefined,w.owner.id),tree=await w.kit.objects.put(Buffer.from(canonicalize({name:'',children:[{name:'synthetic',digest:leaf.sha256}],entries:[]})),'application/json',undefined,w.owner.id);
 const knowledge=await w.kit.store.put({kind:'knowledge_space_version',schema:'knowledge-space-version@1',provenance:'projected',body:{space:w.owner.id,used_bytes:321,parent:null,tree:tree.sha256,sources:[],products:[],entries:[],directories:['/','/synthetic'],by:w.owner.id,at,reason:'synthetic legacy counter'},index:[{key:'knowledge.space.version',value:w.owner.id}]});
 const document=await w.kit.store.put({kind:'memory_document',schema:'memory-document@1',provenance:'declared',body:{space:w.owner.id,by:w.owner.id,at,intent:'1'.repeat(64)},index:[{key:'memory.document.space',value:w.owner.id}]});
 const version=await w.kit.store.put({kind:'memory_version',schema:'memory-version@1',provenance:'declared',body:{space:w.owner.id,document:document.digest,parent:null,title:'synthetic',path:'/',state:'enabled',bytes:9,markdown:'synthetic',content_version:null,by:w.owner.id,at,intent:'2'.repeat(64),payload:'3'.repeat(64)},index:[{key:'memory.version.space',value:w.owner.id}]});
 await w.kit.store.withTransaction(tx=>w.kit.memoryIndex!.apply({document:document.digest,space:w.owner.id,version:version.digest,path:'/',state:'enabled',bytes:1,contextBytes:1},123,tx));
 const actual=[knowledge,document,version].reduce((n,row)=>n+Buffer.byteLength(canonicalize(row.body)),0);assert.notEqual(actual,444);assert.equal((await w.api.state(w.owner)).used_bytes,before+actual);
 const objects=[blob('x'.repeat(1200)),blob('y'.repeat(1200))],current=(await w.api.state(w.owner)).used_bytes;
 await w.kit.store.put({kind:'knowledge_space_quota',schema:'knowledge-space-quota@1',provenance:'declared',body:{space:w.owner.id,bytes:current+1800,by:w.admin.id,at:new Date().toISOString()},index:[{key:'knowledge.space.quota',value:w.owner.id}]});
 const results=await Promise.allSettled(objects.map(o=>w.api.upload(w.owner,s.session_id,batch(epoch,[o]))));
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);const rejected=results.find(r=>r.status==='rejected');assert.equal(rejected?.status==='rejected'&&rejected.reason.code,'SPACE_CAPACITY_EXCEEDED');
 assert.ok((await w.api.state(w.owner)).used_bytes<=(await w.api.state(w.owner)).capacity_bytes);
});


test('aborts and expiry collect only unretained bytes with no other live session; independent originals and pinned history survive',async t=>{
 let now=new Date('2026-11-03T00:00:00.000Z');const w=await world(t,{now:()=>now}),a=await session(w),b=await session(w),epoch=a.state.epoch;
 const shared=blob('synthetic shared staging'),independent=blob('synthetic independently captured'),pinned=blob('synthetic pinned history');
 await w.api.upload(w.owner,a.session_id,batch(epoch,[shared,independent,pinned]));
 await w.kit.objects.put(Buffer.from(independent.bytes_base64,'base64'),'application/json',undefined,w.owner.id);
 await w.db.query('INSERT INTO personal_sync_retained VALUES($1,$2,$3)',[w.owner.id,epoch,pinned.id]);
 assert.deepEqual(await w.api.missing(w.owner,b.session_id,{epoch,objects:[shared.id]}),{missing:[]});
 const input={epoch,operation_id:randomUUID()},receipt=await w.api.abort(w.owner,a.session_id,input);assert.deepEqual(await w.api.abort(w.owner,a.session_id,input),receipt);
 assert.deepEqual((await w.api.download(w.owner,b.session_id,{epoch,objects:[shared.id]})).objects,[shared]);
 assert.equal(await w.api.object(w.owner,epoch,independent.id),null);assert.ok(await w.kit.objects.get(independent.id));assert.ok(await w.api.object(w.owner,epoch,pinned.id));
 now=new Date(now.getTime()+86400*1000+1);
 await assert.rejects(w.api.download(w.owner,b.session_id,{epoch,objects:[shared.id]}),{code:'SYNC_SESSION_EXPIRED'});
 await w.api.collect(w.owner,epoch);await w.api.collect(w.owner,epoch);
 assert.equal(await w.api.object(w.owner,epoch,shared.id),null);assert.ok(await w.api.object(w.owner,epoch,pinned.id));
 assert.equal((await w.db.query('SELECT 1 FROM personal_payloads WHERE owner=$1 AND sha256=$2',[w.owner.id,shared.id])).rowCount,0);
 assert.deepEqual(await w.api.operation(w.owner,epoch,input.operation_id),receipt);
});

test('a frozen inventory paginates a complete graph and never absorbs later staged objects or a new head',async t=>{
 const w=await world(t),a=await session(w),epoch=a.state.epoch;
 const directory=randomUUID(),source=randomUUID(),chunks=Array.from({length:505},(_,n)=>blob('synthetic chunk '+n));
 for(let n=0;n<chunks.length;n+=64)await w.api.upload(w.owner,a.session_id,batch(epoch,chunks.slice(n,n+64)));
 const dir=pack({schema:'personal-sync-object@1',kind:kinds.directory_revision,body:{item_id:directory,parents:[],parent_directory:null,name:''}});
 const raw=Buffer.from(Array.from({length:505},(_,n)=>'synthetic chunk '+n).join(''));
 const src=pack({schema:'personal-sync-object@1',kind:kinds.source_revision,body:{item_id:source,parents:[],directory_id:directory,name:'synthetic.txt',media_type:'text/plain',raw_sha256:sha256Hex(raw),size:raw.length,chunks:chunks.map(c=>c.id)}});
 const page=pack({schema:'personal-sync-object@1',kind:kinds.inventory_page,body:{items:[{kind:kinds.directory_revision,item_id:directory,heads:[dir.id]},{kind:kinds.source_revision,item_id:source,heads:[src.id]}]}});
 const snap=pack({schema:'personal-sync-object@1',kind:kinds.snapshot,body:{parents:[],pages:[page.id]}});
 await w.api.upload(w.owner,a.session_id,batch(epoch,[dir,src,page,snap]));
 // Synthetic committed head fixture. Step 4 supplies the verified CAS writer; transport never promotes uploads.
 await w.db.query('INSERT INTO personal_sync_retained VALUES($1,$2,$3)',[w.owner.id,epoch,snap.id]);
 await w.db.query('UPDATE personal_sync_heads SET snapshot=$3 WHERE owner=$1 AND epoch=$2',[w.owner.id,epoch,snap.id]);
 const b=await session(w),later=blob('synthetic later object');await w.api.upload(w.owner,b.session_id,batch(epoch,[later]));
 const first=await w.api.inventory(w.owner,b.session_id,epoch,b.inventory_cursor);PersonalSyncInventory.parse(first);assert.equal(first.objects.length,500);assert.ok(first.next);
 await w.db.query('UPDATE personal_sync_heads SET snapshot=NULL WHERE owner=$1 AND epoch=$2',[w.owner.id,epoch]);
 const second=await w.api.inventory(w.owner,b.session_id,epoch,first.next);assert.equal(second.snapshot,snap.id);assert.equal(second.next,null);
 const ids=[...first.objects,...second.objects].map(o=>o.id);assert.equal(ids.length,509);assert.equal(new Set(ids).size,509);assert.ok(!ids.includes(later.id));
 await assert.rejects(w.api.inventory(w.owner,a.session_id,epoch,first.next),{code:'SOURCE_UNAVAILABLE'});
 const retained=chunks[0];assert.deepEqual((await w.api.download(w.owner,b.session_id,{epoch,objects:[retained.id]})).objects,[retained]);
 await w.api.abort(w.owner,a.session_id,{epoch,operation_id:randomUUID()});
 await w.api.abort(w.owner,b.session_id,{epoch,operation_id:randomUUID()});
 assert.ok(await w.api.object(w.owner,epoch,retained.id),'retaining a snapshot protects its complete history graph');
 assert.equal(await w.api.object(w.owner,epoch,later.id),null);
});

test('batch limits and memory credential scans refuse without retaining plaintext, while binary originals stay staged only',async t=>{
 const w=await world(t,{limits:{maxSyncBatchBytes:1024}}),s=await session(w),epoch=s.state.epoch;
 await assert.rejects(w.api.upload(w.owner,s.session_id,batch(epoch,[blob('s'.repeat(1200))])),{code:'SYNC_BATCH_LIMIT'});
 const memory={schema:'personal-sync-object@1',kind:kinds.memory_revision,body:{item_id:randomUUID(),parents:[],directory_id:randomUUID(),title:'synthetic',markdown:'Authorization: Bearer '+'s1'.repeat(20),state:'enabled'}};
 const object=pack(memory);await assert.rejects(w.api.upload(w.owner,s.session_id,batch(epoch,[object])),{code:'MEMORY_CREDENTIALS_DETECTED'});
 assert.equal((await w.db.query('SELECT 1 FROM personal_payloads WHERE sha256=$1',[object.id])).rowCount,0);
 const binary=pack({schema:'personal-sync-object@1',kind:kinds.bytes,body:{bytes_base64:Buffer.from([0,255,128,1,2]).toString('base64')}});
 await w.api.upload(w.owner,s.session_id,batch(epoch,[binary]));assert.ok(await w.api.object(w.owner,epoch,binary.id));assert.equal(await w.kit.artifacts.source(w.owner,binary.id),null);
});

test('the runtime role uses transport and owner-defined collection without UPDATE on personal_spaces or DELETE on payloads',async t=>{
 const w=await world(t),role='synthetic_sync_'+randomBytes(4).toString('hex'),password=randomBytes(16).toString('hex');
 await w.db.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`);await w.db.query(`REVOKE TEMPORARY ON DATABASE "${w.kit.database.database}" FROM PUBLIC`);await grantRuntime(w.db,role);
 const config={...w.kit.config,database:{...w.kit.database,user:role,password}},kit=await openRecords(config,{migrate:false,keyProvider:w.kit.keyProvider});t.after(()=>kit.close());
 const restricted=new Database(createPool(config.database));t.after(()=>restricted.end());
 const api=kit.personalSync!,state=await api.state(w.owner),client_id=randomUUID();await api.registerClient(w.owner,{client_id,name:'synthetic runtime'});
 const opened=await api.openSession(w.owner,{client_id,epoch:state.epoch,known_state:null,base_snapshot:null}),object=blob('synthetic runtime payload');
 await api.upload(w.owner,opened.session_id,batch(state.epoch,[object]));
 await assert.rejects(restricted.query('UPDATE personal_spaces SET epoch=$1 WHERE owner=$2',[randomUUID(),w.owner.id]),(e:unknown)=>(e as {code:string}).code==='42501');
 await assert.rejects(restricted.query('DELETE FROM personal_payloads'),(e:unknown)=>(e as {code:string}).code==='42501');
 await assert.rejects(restricted.query('DELETE FROM personal_sync_objects'),(e:unknown)=>(e as {code:string}).code==='42501');
 await api.abort(w.owner,opened.session_id,{epoch:state.epoch,operation_id:randomUUID()});assert.equal(await api.object(w.owner,state.epoch,object.id),null);
});

test('migration 15 preserves an already applied personal layout and the exact prior migration journal',async t=>{
 const {migrate,MIGRATIONS}=await import('./migrations.ts'),{PgRecordStore}=await import('./store.ts'),{PgPrincipals}=await import('./principals.ts');
 const database=await postgres.createDatabase(undefined,{empty:true});t.after(()=>postgres.dropDatabase(database.database));
 const db=new Database(createPool(database));t.after(()=>db.end());await migrate(db,MIGRATIONS.slice(0,14));
 const clock=()=>new Date('2026-11-03T00:00:00.000Z'),{user}=await new PgPrincipals(db,clock).bootstrapAdmin('synthetic-upgrade');
 const store=new PgRecordStore(db,{maxRecordBytes:16*1024*1024,now:clock});
 const record=await store.put({kind:'memory_version',schema:'memory-version@1',provenance:'declared',body:{space:user.id,markdown:'synthetic pre-transport personal body'}});
 const baseline=await store.get(record.digest);
 const journal=(await db.query('SELECT version,name,sha256 FROM schema_migrations ORDER BY version')).rows;
 assert.deepEqual(await migrate(db),MIGRATIONS.slice(14).map(m=>m.version));
 assert.deepEqual((await db.query('SELECT version,name,sha256 FROM schema_migrations WHERE version<=14 ORDER BY version')).rows,journal);
 assert.deepEqual(await store.get(record.digest),baseline);
 assert.equal((await store.get<{markdown:string}>(record.digest))?.body.markdown,'synthetic pre-transport personal body');
 assert.equal((await store.personalPayloads.inspect(record.digest))?.cleared,false);
});

test('a small HTTP budget negotiates transferable object limits and private device names must stay nonempty after normalization',async t=>{
 const w=await world(t,{limits:{maxRequestBytes:2048}}),s=await session(w);
 assert.ok(s.state.limits.batch_bytes<2048);assert.ok(s.state.limits.batch_objects<64);
 const object=blob('synthetic small budget');await w.api.upload(w.owner,s.session_id,batch(s.state.epoch,[object]));
 assert.deepEqual((await w.api.download(w.owner,s.session_id,{epoch:s.state.epoch,objects:[object.id]})).objects,[object]);
 await assert.rejects(w.api.registerClient(w.owner,{client_id:randomUUID(),name:'\ufeff'}),{code:'SYNC_OBJECT_INVALID'});
});
