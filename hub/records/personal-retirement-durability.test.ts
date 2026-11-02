// A failed directory fsync after unlink must not mark retirement complete or permit purge.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Database,createPool} from './db.ts';
import {migrate,MIGRATIONS} from './migrations.ts';
import {canonicalize} from './canonical.ts';
import {recordDigest} from './digest.ts';
import {newId} from './ids.ts';
import {PgPrincipals} from './principals.ts';
import {PgRecordStore} from './store.ts';
import {FileObjectStore} from './objects.ts';
import {DEFAULT_LIMITS} from '../config/index.ts';
import {startPostgres} from '../testing/postgres.ts';
import {INITIAL_PERSONAL_EPOCH} from './personal-payloads.ts';

test('failed retirement directory sync leaves a durable pending journal and resumes after restart',async t=>{
 const pg=await startPostgres();t.after(()=>pg.stop());const database=await pg.createDatabase(undefined,{empty:true});
 const db=new Database(createPool(database));t.after(()=>db.end());const dir=await mkdtemp(join(tmpdir(),'synthetic-retirement-sync-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 await migrate(db,MIGRATIONS.slice(0,13));const at='2026-11-03T00:00:00.000Z',clock=()=>new Date(at),{user}=await new PgPrincipals(db,clock).bootstrapAdmin('synthetic-owner');
 const old=new FileObjectStore(join(dir,'objects'),db,{maxBytes:DEFAULT_LIMITS.maxUploadBytes,now:clock});
 const root=await old.put(Buffer.from(canonicalize({name:'',children:[],entries:[]})),'application/json');
 const body={space:user.id,parent:null,tree:root.sha256,sources:[],products:[],directories:['/'],entries:[],by:user.id,at,reason:'synthetic-upgrade',used_bytes:0},text=canonicalize(body),digest=recordDigest({kind:'knowledge_space_version',schema:'knowledge-space-version@1',provenance:'projected',created_at:at,body});
 await db.query('INSERT INTO records(id,digest,kind,schema,provenance,created_at,body,size) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[newId('rcd'),digest,'knowledge_space_version','knowledge-space-version@1','projected',at,text,Buffer.byteLength(text)]);
 await migrate(db);const store=new PgRecordStore(db,{maxRecordBytes:DEFAULT_LIMITS.maxRecordBytes,now:clock}),options={maxBytes:DEFAULT_LIMITS.maxUploadBytes,now:clock,personalPayloads:store.personalPayloads};
 let syncs=0;
 class FailingSyncStore extends FileObjectStore {
  protected override async syncRetirementDirectory(directory:string){syncs++;assert.equal(directory,join(dir,'objects',root.sha256.slice(0,2)));throw new Error('synthetic directory fsync failed');}
 }
 await assert.rejects(new FailingSyncStore(join(dir,'objects'),db,options).materializePersonalObjects(),/synthetic directory fsync failed/);
 assert.equal(syncs,1);await assert.rejects(access(old.path(root.sha256)),{code:'ENOENT'});
 assert.equal((await db.query('SELECT 1 FROM personal_legacy_retired WHERE sha256=$1',[root.sha256])).rowCount,0);
 assert.equal((await db.query('SELECT 1 FROM personal_legacy_retire WHERE sha256=$1',[root.sha256])).rowCount,1);
 await assert.rejects(store.personalPayloads.purge(user,INITIAL_PERSONAL_EPOCH),/materialization incomplete/);
 class ObservedSyncStore extends FileObjectStore {
  protected override async syncRetirementDirectory(directory:string){assert.equal((await db.query('SELECT 1 FROM personal_legacy_retired WHERE sha256=$1',[root.sha256])).rowCount,0);await super.syncRetirementDirectory(directory);syncs++;}
 }
 await new ObservedSyncStore(join(dir,'objects'),db,options).materializePersonalObjects();assert.equal(syncs,2);
 assert.equal((await db.query('SELECT 1 FROM personal_legacy_retired WHERE sha256=$1',[root.sha256])).rowCount,1);
 await store.personalPayloads.purge(user,INITIAL_PERSONAL_EPOCH);assert.equal(await store.get(digest),null);
});
