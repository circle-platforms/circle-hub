// Mode changes share the purge transaction and keep only content-free, owner-scoped replay receipts.
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {test} from 'node:test';
import {openTestRecords} from '../testing/records.ts';
import {Database,createPool} from './db.ts';
import {PgRecordStore} from './store.ts';
import {PgPersonalSync} from './personal-sync.ts';
import {grantRuntime} from './migrations.ts';
import {DEFAULT_LIMITS} from '../config/index.ts';
import {encodePersonalSyncObject} from '../../contracts/src/sync-canonical.ts';
import {sha256Hex} from './digest.ts';

async function setup(t:import('node:test').TestContext){
 const kit=await openTestRecords();t.after(()=>kit.close());const {user:admin}=await kit.principals.bootstrapAdmin('synthetic-mode-admin'),owner=await kit.principals.createUser(admin,'synthetic-mode-owner'),other=await kit.principals.createUser(admin,'synthetic-mode-other');
 const db=new Database(createPool(kit.database));t.after(()=>db.end());return {kit,api:kit.personalSync!,admin,owner,other,db};
}

test('a mode proof binds staged batches and grants even without a content head change',async t=>{
 const w=await setup(t),state=await w.api.state(w.owner),client_id=randomUUID();await w.api.registerClient(w.owner,{client_id,name:'synthetic mode device'});const session=await w.api.openSession(w.owner,{client_id,epoch:state.epoch,known_state:null,base_snapshot:null});
 const check=await w.api.modeCheck(w.owner,{mode:'local'}),bytes=encodePersonalSyncObject({schema:'personal-sync-object@1',kind:'bytes',body:{bytes_base64:Buffer.from('synthetic staged').toString('base64')}});
 await w.api.upload(w.owner,session.session_id,{schema:'personal-sync-upload@1',epoch:state.epoch,operation_id:randomUUID(),objects:[{id:sha256Hex(bytes),bytes_base64:Buffer.from(bytes).toString('base64')}]});
 assert.equal((await w.api.state(w.owner)).state_version,check.expected_state);
 const request={epoch:state.epoch,expected_state:check.expected_state,mode:'local',operation_id:randomUUID(),check:check.check,confirm_purge:true};
 await assert.rejects(w.api.changeMode(w.owner,request),{code:'SYNC_VERSION_CONFLICT'});assert.equal((await w.api.state(w.owner)).mode,'hub');
 const current=await w.api.modeCheck(w.owner,{mode:'local'});assert.equal(current.pending_shares,null,'read-only share checks are not invented as a count');
 await w.kit.store.put({kind:'knowledge_space_grant',schema:'knowledge-space-grant@1',provenance:'declared',body:{space:w.owner.id,path:'/',audience:'member',member:w.other.id,action:'grant',by:w.owner.id,at:new Date().toISOString()},index:[{key:'knowledge.space.grant',value:w.owner.id}]});
 assert.equal((await w.api.modeCheck(w.owner,{mode:'local'})).directory_grants,1);
 await assert.rejects(w.api.changeMode(w.owner,{...request,check:current.check}),{code:'SYNC_VERSION_CONFLICT'});
 const fresh=await w.api.modeCheck(w.owner,{mode:'local'});await assert.rejects(async()=>w.api.changeMode(w.owner,{...request,check:fresh.check,confirm_purge:false}),{code:'SYNC_OBJECT_INVALID'});
 const done=await w.api.changeMode(w.owner,{...request,expected_state:fresh.expected_state,check:fresh.check});assert.equal(done.state.used_bytes,0);assert.equal(done.state.mode,'local');
});

test('purge, mode receipt and audit roll back together and old receipts cannot clear a new epoch',async t=>{
 const w=await setup(t),privateRecord=await w.kit.store.put({kind:'memory_version',schema:'memory-version@1',provenance:'declared',body:{space:w.owner.id,markdown:'synthetic private purge body'}}),initial=await w.api.state(w.owner),check=await w.api.modeCheck(w.owner,{mode:'local'});
 const request={epoch:initial.epoch,expected_state:check.expected_state,mode:'local',operation_id:randomUUID(),check:check.check,confirm_purge:true};
 await w.db.query("CREATE FUNCTION synthetic_purge_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.schema='personal-sync-mode@1' THEN RAISE EXCEPTION 'synthetic mode audit failure';END IF;RETURN NEW;END$$");await w.db.query('CREATE TRIGGER synthetic_purge_audit_failure BEFORE INSERT ON records FOR EACH ROW EXECUTE FUNCTION synthetic_purge_audit_failure()');
 await assert.rejects(w.api.changeMode(w.owner,request),/synthetic mode audit failure/);assert.equal((await w.api.state(w.owner)).mode,'hub');assert.ok(await w.kit.store.get(privateRecord.digest));assert.equal(await w.api.modeOperation(w.owner,initial.epoch,request.operation_id),null);
 await w.db.query('DROP TRIGGER synthetic_purge_audit_failure ON records');const result=await w.api.changeMode(w.owner,request);assert.equal(await w.kit.store.get(privateRecord.digest),null);assert.equal(await w.api.modeOperation(w.other,initial.epoch,request.operation_id),null);assert.deepEqual(await w.api.changeMode(w.owner,request),result);
 await assert.rejects(w.api.changeMode(w.owner,{...request,check:'0'.repeat(64)}),{code:'IDEMPOTENCY_MISMATCH'});
 const fresh=await w.api.changeMode(w.owner,{epoch:initial.epoch,expected_state:result.state.state_version,mode:'hub',operation_id:randomUUID(),check:null,confirm_purge:false});assert.notEqual(fresh.state.epoch,initial.epoch);
 const newRecord=await w.kit.store.put({kind:'memory_version',schema:'memory-version@1',provenance:'declared',body:{space:w.owner.id,markdown:'synthetic fresh epoch body'}});
 assert.deepEqual(await w.api.changeMode(w.owner,request),result);assert.ok(await w.kit.store.get(newRecord.digest));assert.deepEqual(await w.api.modeOperation(w.owner,initial.epoch,request.operation_id),result);
 const audits=await w.kit.store.findMany({kind:'action',key:'personal.sync.mode.by',values:[w.owner.id]});assert.doesNotMatch(JSON.stringify(audits),/synthetic private purge body|synthetic fresh epoch body/);
 await w.kit.principals.setDisabled(w.admin,w.owner.id,true);await assert.rejects(w.api.changeMode(w.owner,request),{code:'SOURCE_UNAVAILABLE'});
});

test('runtime mode changes use the owner-defined switch without UPDATE or mutable receipt grants',async t=>{
 const w=await setup(t),state=await w.api.state(w.owner),role='synthetic_mode_'+randomBytes(4).toString('hex'),password=randomBytes(16).toString('hex');await w.db.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`);await w.db.query(`REVOKE TEMPORARY ON DATABASE "${w.kit.database.database}" FROM PUBLIC`);await grantRuntime(w.db,role);
 const db=new Database(createPool({...w.kit.database,user:role,password}));t.after(()=>db.end());const store=new PgRecordStore(db,{maxRecordBytes:DEFAULT_LIMITS.maxRecordBytes,now:()=>new Date()}),api=new PgPersonalSync(db,store,store.personalPayloads,DEFAULT_LIMITS,()=>new Date());
 const check=await api.modeCheck(w.owner,{mode:'local'}),result=await api.changeMode(w.owner,{epoch:state.epoch,expected_state:check.expected_state,mode:'local',operation_id:randomUUID(),check:check.check,confirm_purge:true});
 await assert.rejects(db.query("UPDATE personal_spaces SET mode='hub' WHERE owner=$1",[w.owner.id]),(e:unknown)=>(e as {code:string}).code==='42501');await assert.rejects(db.query("UPDATE personal_sync_mode_operations SET result='{}'"),(e:unknown)=>(e as {code:string}).code==='42501');
 const request={epoch:state.epoch,expected_state:result.state.state_version,mode:'hub',operation_id:randomUUID(),check:null,confirm_purge:false};const [one,two]=await Promise.all([api.changeMode(w.owner,request),api.changeMode(w.owner,request)]);assert.deepEqual(one,two);assert.notEqual(one.state.epoch,state.epoch);assert.equal(one.state.mode,'hub');
 const unchanged=await api.changeMode(w.owner,{...request,epoch:one.state.epoch,expected_state:one.state.state_version,operation_id:randomUUID()});assert.equal(unchanged.state.epoch,one.state.epoch);
 assert.equal(await api.memberMetadata(w.other,w.owner.id),null);assert.deepEqual(await api.memberMetadata(w.admin,w.owner.id),{mode:'hub',last_synced_at:null});
});
