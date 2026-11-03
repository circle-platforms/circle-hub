// Only synthetic version-18 rows exercise the additional owner-only conversion window.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID,randomBytes} from 'node:crypto';
import {startPostgres} from '../testing/postgres.ts';
import {Database,createPool} from './db.ts';
import {MIGRATIONS,migrate} from './migrations.ts';
import {PgPrincipals} from './principals.ts';
import {PgRecordStore} from './store.ts';
import {canonicalize} from './canonical.ts';
import {envelopeDigest} from './digest.ts';
import {newId} from './ids.ts';
import {DEFAULT_LIMITS} from '../config/index.ts';
import {INITIAL_PERSONAL_EPOCH} from './personal-payloads.ts';
for(const cleared of [false,true])test(`attribution conversion preserves logical row digests and never revives a closed source epoch: ${cleared}`,async t=>{
 const pg=await startPostgres();t.after(()=>pg.stop());const db=new Database(createPool(await pg.createDatabase(undefined,{empty:true})));t.after(()=>db.end());await migrate(db,MIGRATIONS.slice(0,18));
 const at='2026-11-03T00:00:00.000Z',principals=new PgPrincipals(db,()=>new Date(at)),{user}=await principals.bootstrapAdmin('synthetic-upgrade');
 const store=new PgRecordStore(db,{maxRecordBytes:DEFAULT_LIMITS.maxRecordBytes,now:()=>new Date(at)}),hash='a'.repeat(64);
 const source=await store.put({kind:'knowledge_space_source',schema:'knowledge-space-source@1',provenance:'declared',body:{space:user.id,path:'/synthetic-private',sha256:hash,artifact:'b'.repeat(64),size:1,by:user.id,at}});
 const body={space:user.id,source:source.digest,artifact:'b'.repeat(64),sha256:hash,by:user.id,at,audience:'team'},text=cleared?canonicalize(body):JSON.stringify(body,null,2),meta={kind:'knowledge_source_attribution',schema:'knowledge-source-attribution@1',provenance:'declared',created_at:at},digest=envelopeDigest(meta,text);
 await db.query('INSERT INTO records(id,digest,kind,schema,provenance,created_at,body,size) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[newId('rcd'),digest,meta.kind,meta.schema,meta.provenance,at,text,Buffer.byteLength(text)]);
 const row=(await db.query('SELECT * FROM records WHERE digest=$1',[digest])).rows[0];
 if(!cleared){
  const rollback=new Error('synthetic owner-window rollback');
  await assert.rejects(db.transaction(async tx=>{
   await db.query(MIGRATIONS[18].sql.split('SELECT public.hub_convert_member_attributions();')[0],[],tx);
   const marker=await store.personalPayloads.bind(await store.personalPayloads.scope(user.id,tx),digest,meta,text,tx);
   const role='synthetic_window_'+randomBytes(4).toString('hex');await db.query(`CREATE ROLE ${role} NOLOGIN`,[],tx);
   await db.query(`GRANT SELECT,UPDATE(body) ON records TO ${role}`,[],tx);await db.query(`GRANT SELECT ON schema_migrations,personal_record_bindings,personal_payloads TO ${role}`,[],tx);await db.query(`GRANT EXECUTE ON FUNCTION hub_member_layout_conversion() TO ${role}`,[],tx);
   await db.query("SELECT set_config('circle_hub.member_layout_conversion','19',true)",[],tx);await db.query(`SET LOCAL ROLE ${role}`,[],tx);
   await db.query('CREATE TEMP TABLE pg_class(oid oid,relowner oid)',[],tx);await db.query("INSERT INTO pg_class VALUES('public.records'::regclass,(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user))",[],tx);await db.query('CREATE TEMP TABLE schema_migrations(version integer)',[],tx);
   assert.equal((await db.query('SELECT hub_member_layout_conversion() AS allowed',[],tx)).rows[0].allowed,false);
   await db.query('SAVEPOINT runtime_window',[],tx);await assert.rejects(db.query('UPDATE records SET body=$1 WHERE digest=$2',[marker,digest],tx),(e:any)=>e.code==='HU001');await db.query('ROLLBACK TO SAVEPOINT runtime_window',[],tx);await db.query('RESET ROLE',[],tx);
   await db.query('SAVEPOINT metadata_window',[],tx);await assert.rejects(db.query('UPDATE records SET body=$1,size=size+1 WHERE digest=$2',[marker,digest],tx),(e:any)=>e.code==='HU001');await db.query('ROLLBACK TO SAVEPOINT metadata_window',[],tx);
   assert.equal((await db.query('UPDATE records SET body=$1 WHERE digest=$2',[marker,digest],tx)).rowCount,1);await db.query('SET CONSTRAINTS personal_binding_check IMMEDIATE',[],tx);assert.deepEqual({...((await db.query('SELECT * FROM records WHERE digest=$1',[digest],tx)).rows[0]),body:row.body},row);
   throw rollback;
  }),e=>e===rollback);
 }

 if(cleared){await store.personalPayloads.purge(user,INITIAL_PERSONAL_EPOCH);await db.query('SELECT hub_resume_personal($1,$2,$3)',[user.id,INITIAL_PERSONAL_EPOCH,randomUUID()]);}
 assert.deepEqual(await migrate(db),MIGRATIONS.slice(18).map(m=>m.version));const capsule=(await db.query('SELECT * FROM records WHERE digest=$1',[digest])).rows[0];assert.deepEqual({...capsule,body:row.body},row);assert.notEqual(capsule.body,text);
 const binding=(await db.query('SELECT * FROM personal_record_bindings WHERE record=$1',[digest])).rows[0];assert.equal(binding.epoch,INITIAL_PERSONAL_EPOCH);
 if(cleared){assert.equal(await store.get(digest),null);assert.equal((await db.query('SELECT count(*)::int n FROM personal_payloads WHERE epoch=$1',[INITIAL_PERSONAL_EPOCH])).rows[0].n,0);}
 else {assert.deepEqual((await store.get(digest))?.body,body);await store.personalPayloads.purge(user,INITIAL_PERSONAL_EPOCH);assert.equal(await store.get(digest),null);}
 await db.query("SELECT set_config('circle_hub.member_layout_conversion','19',false)");assert.equal((await db.query('SELECT hub_member_layout_conversion() AS allowed')).rows[0].allowed,false);await assert.rejects(db.query('SELECT hub_convert_member_attributions()'),(e:any)=>e.code==='42501');
});
