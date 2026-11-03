// Synthetic regression adapted from the independent review: a temporary domain must never run as the definer.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomBytes} from 'node:crypto';
import {openTestRecords} from '../testing/records.ts';
import {Database,createPool} from './db.ts';
import {grantRuntime} from './migrations.ts';
import {INITIAL_PERSONAL_EPOCH} from './api.ts';
import {SyncObjectKindSchema} from '../../contracts/generated/vocabulary.ts';

test('every definer pins pg_temp last and a malicious temporary text domain cannot rewrite history',async t=>{
 const kit=await openTestRecords();t.after(()=>kit.close());const db=new Database(createPool(kit.database));t.after(()=>db.end());const {user}=await kit.principals.bootstrapAdmin('synthetic-owner');
 const role='synthetic_domain_'+randomBytes(4).toString('hex'),password=randomBytes(16).toString('hex');await db.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`);await db.query('REVOKE TEMPORARY ON DATABASE "'+kit.database.database+'" FROM PUBLIC');await grantRuntime(db,role);
 const rt=new Database(createPool({...kit.database,user:role,password},1));t.after(()=>rt.end());
 const victim=await kit.store.put({kind:'claim',schema:'synthetic-claim@1',provenance:'declared',body:{text:'synthetic immutable history'}});
 await assert.rejects(rt.query('ALTER TABLE public.records DISABLE TRIGGER records_append_only'),(e:unknown)=>(e as {code:string}).code==='42501');
 // Deliberately grant the unsafe database privilege after application authorization: the SQL boundary must still hold.
 await db.query('GRANT TEMPORARY ON DATABASE "'+kit.database.database+'" TO "'+role+'"');
 await rt.query(`CREATE FUNCTION pg_temp.probe(v pg_catalog.text) RETURNS pg_catalog.bool LANGUAGE plpgsql AS $f$
 BEGIN
 EXECUTE 'ALTER TABLE public.records DISABLE TRIGGER records_append_only';
 EXECUTE pg_catalog.format('UPDATE public.records SET body=%L WHERE digest=%L','{"text":"rewritten"}','${victim.digest}');
 EXECUTE 'ALTER TABLE public.records ENABLE TRIGGER records_append_only';RETURN true;
 END $f$`);
 await rt.query('CREATE DOMAIN pg_temp.text AS pg_catalog.text CHECK (pg_temp.probe(VALUE))');
 await kit.personalPayloads!.scope(user.id);
 await rt.query('INSERT INTO personal_sync_objects VALUES($1,$2,$3,$4,1,1)',[user.id,INITIAL_PERSONAL_EPOCH,'synthetic-object',SyncObjectKindSchema.enum.bytes]);
 await rt.query('SELECT hub_collect_personal_sync($1,$2,now())',[user.id,INITIAL_PERSONAL_EPOCH]);
 await rt.query('SELECT hub_account_scope($1,$2)',[user.id,'00000000-0000-4000-8000-000000000004']);
 await rt.query('SELECT hub_finish_independent_objects($1)',[user.id]);
 await assert.rejects(rt.query('SELECT hub_restore_legacy_object($1,$2,$3)',[victim.digest,'b'.repeat(64),Buffer.from('synthetic')]),(error:unknown)=>(error as {code:string}).code==='P0001');
 const counts={records:0,payloads:0,objects:0,attributions:0,archives:0,private_versions:0};
 await assert.rejects(rt.query('SELECT hub_begin_member_deletion($1,$1,$2,$3,$4,$5,now(),$6)',[user.id,INITIAL_PERSONAL_EPOCH,'00000000-0000-4000-8000-000000000003','a'.repeat(64),JSON.stringify(counts),user.updated_at]),(error:unknown)=>(error as {code:string}).code==='P0001');
 await assert.rejects(rt.query('SELECT hub_finish_member_deletion($1,$2)',[user.id,'00000000-0000-4000-8000-000000000003']),(error:unknown)=>(error as {code:string}).code==='P0001');

 assert.deepEqual(JSON.parse((await db.query<{body:string}>('SELECT body FROM public.records WHERE digest=$1',[victim.digest])).rows[0].body),{text:'synthetic immutable history'});
 assert.ok(await kit.store.get(victim.digest));
 const functions=(await db.query<{proname:string;proconfig:string[]}>("SELECT proname,proconfig FROM pg_proc WHERE pronamespace='public'::regnamespace AND prosecdef")).rows;assert.ok(functions.length>=9);
 for(const fn of functions)assert.ok((fn.proconfig as string[]).some(value=>/^search_path=pg_catalog, public, pg_temp$/.test(value)),fn.proname);
});
