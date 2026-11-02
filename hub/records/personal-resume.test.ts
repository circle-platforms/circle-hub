// Returning to Hub storage creates a new empty epoch through an owner-defined function, never table UPDATE grants.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {openTestRecords} from '../testing/records.ts';
import {Database,createPool} from './db.ts';
import {grantRuntime} from './migrations.ts';
import {PgRecordStore} from './store.ts';
import {PgPersonalSync} from './personal-sync.ts';
import {DEFAULT_LIMITS} from '../config/index.ts';

test('local resume rechecks status and state, rolls back failures, and uses a fresh epoch with no runtime UPDATE privilege',async t=>{
 const kit=await openTestRecords();t.after(()=>kit.close());const {user:admin}=await kit.principals.bootstrapAdmin('synthetic-admin'),owner=await kit.principals.createUser(admin,'synthetic-owner');
 const api=kit.personalSync!,before=await api.state(owner),client_id=randomUUID();await api.registerClient(owner,{client_id,name:'synthetic-old-client'});
 const session=await api.openSession(owner,{client_id,epoch:before.epoch,known_state:null,base_snapshot:null});
 const old=await kit.store.put({kind:'memory_version',schema:'memory-version@1',provenance:'declared',body:{space:owner.id,markdown:'synthetic-private'}});
 await kit.personalPayloads!.purge(owner,before.epoch);const local=await api.state(owner);assert.equal(local.mode,'local');
 await assert.rejects(api.resume(owner,local.epoch,'0'.repeat(64)),{code:'SYNC_VERSION_CONFLICT'});
 const db=new Database(createPool(kit.database));t.after(()=>db.end());
 // Fail the audit to prove the mode and new head are in the same transaction.
 await db.query("CREATE FUNCTION synthetic_mode_failure() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.schema='personal-sync-mode@1' THEN RAISE EXCEPTION 'synthetic audit failure';END IF;RETURN NEW;END$$");
 await db.query('CREATE TRIGGER synthetic_mode_failure BEFORE INSERT ON records FOR EACH ROW EXECUTE FUNCTION synthetic_mode_failure()');
 await assert.rejects(api.resume(owner,local.epoch,local.state_version),/synthetic audit failure/);assert.equal((await api.state(owner)).mode,'local');
 await db.query('DROP TRIGGER synthetic_mode_failure ON records');
 const role='synthetic_resume_'+randomBytes(4).toString('hex'),password=randomBytes(16).toString('hex');await db.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`);await db.query(`REVOKE TEMPORARY ON DATABASE "${kit.database.database}" FROM PUBLIC`);await grantRuntime(db,role);
 const runtime=new Database(createPool({...kit.database,user:role,password}));t.after(()=>runtime.end());
 await assert.rejects(runtime.query("UPDATE personal_spaces SET mode='hub' WHERE owner=$1",[owner.id]),(e:unknown)=>(e as {code:string}).code==='42501');
 await assert.rejects(runtime.query('SELECT hub_resume_personal($1,$2,$3)',[owner.id,local.epoch,local.epoch]),/unavailable/);
 await assert.rejects(runtime.query('SELECT hub_resume_personal($1,$2,$3)',[owner.id,local.epoch,'not-an-epoch']),/unavailable/);
 const store=new PgRecordStore(runtime,{maxRecordBytes:DEFAULT_LIMITS.maxRecordBytes,now:()=>new Date()}),restricted=new PgPersonalSync(runtime,store,store.personalPayloads,DEFAULT_LIMITS,()=>new Date());
 const results=await Promise.allSettled([restricted.resume(owner,local.epoch,local.state_version),restricted.resume(owner,local.epoch,local.state_version)]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);const hub=await api.state(owner);assert.equal(hub.mode,'hub');assert.notEqual(hub.epoch,local.epoch);assert.equal(hub.snapshot,null);assert.equal(hub.used_bytes,0);
 assert.equal(await kit.store.get(old.digest),null);assert.equal(await kit.personalPayloads!.mode(owner.id),'hub');
 await assert.rejects(api.resume(owner,local.epoch,local.state_version),{code:'SYNC_EPOCH_CHANGED'});
 await assert.rejects(api.download(owner,session.session_id,{epoch:local.epoch,objects:[]}),{code:'SYNC_EPOCH_CHANGED'});
 const records=await kit.store.find({kind:'action',key:'personal.sync.mode.by',value:owner.id});assert.equal(records.items.length,1);assert.ok(!JSON.stringify(records.items).includes('synthetic-private'));
 const scope=await kit.personalPayloads!.scope(owner.id);assert.equal(scope.epoch,hub.epoch);const data=Buffer.from('synthetic fresh payload');await kit.personalPayloads!.put(scope,data);
 const hash=createHash('sha256').update(data).digest('hex');assert.equal(await kit.personalPayloads!.get({owner:owner.id,epoch:local.epoch},hash),null);
 await kit.personalPayloads!.purge(owner,hub.epoch);const latest=await api.state(owner);await kit.principals.setDisabled(admin,owner.id,true);
 await assert.rejects(api.resume(owner,latest.epoch,latest.state_version),{code:'SOURCE_UNAVAILABLE'});
});
