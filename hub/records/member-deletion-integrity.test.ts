// Runtime-role probes for permanent identity, revocation history and database-derived purge receipts.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID,randomBytes} from 'node:crypto';
import {openTestRecords} from '../testing/records.ts';
import {Database,createPool} from './db.ts';
import {grantRuntime} from './migrations.ts';
async function world(t:any){
 const kit=await openTestRecords();t.after(()=>kit.close());const {user:admin}=await kit.principals.bootstrapAdmin('synthetic-integrity-admin'),member=await kit.principals.createUser(admin,'synthetic-integrity-member'),db=new Database(createPool(kit.database));t.after(()=>db.end());
 const role='synthetic_integrity_'+randomBytes(4).toString('hex'),password=randomBytes(20).toString('hex');await db.query('CREATE ROLE '+role+" LOGIN PASSWORD '"+password+"'");await db.query('REVOKE TEMPORARY ON DATABASE "'+kit.database.database+'" FROM PUBLIC');await grantRuntime(db,role);const rt=new Database(createPool({...kit.database,user:role,password}));t.after(()=>rt.end());return{kit,admin,member,db,rt};
}
test('every tombstone column is frozen and the runtime cannot alter its password flags or timestamps',async t=>{
 const w=await world(t),token=await w.kit.principals.issueToken(w.admin,w.member.id,'synthetic-deleted-token'),preview=await w.kit.memberDeletions!.preview(w.admin,w.member.id);await w.kit.memberDeletions!.prepare(w.admin,{...preview,operation_id:randomUUID()});const before=(await w.db.query('SELECT * FROM users WHERE id=$1',[w.member.id])).rows[0];
 for(const [sql,values]of [['UPDATE users SET password_must_change=true WHERE id=$1',[w.member.id]],["UPDATE users SET updated_at=updated_at+interval '1 second' WHERE id=$1",[w.member.id]]]as const)await assert.rejects(w.rt.query(sql,[...values]),(error:any)=>error.code==='HU001');
 // Owner probes cover even columns absent from today's runtime grants; future grants cannot reopen the tombstone.
 for(const column of Object.keys(before)){
  const changed=column==='disabled'?'false':column==='password_must_change'?'true':column==='password_revision'?'password_revision+1':column.endsWith('_at')?column+"+interval '1 second'":column==='password_hash'?"'synthetic-new-hash'":column==='role'?"'admin'":column+"||'x'";
  await assert.rejects(w.db.query('UPDATE users SET '+column+'='+changed+' WHERE id=$1',[w.member.id]),(error:any)=>error.code==='HU001',column);
 }
 assert.deepEqual((await w.db.query('SELECT * FROM users WHERE id=$1',[w.member.id])).rows[0],before);await assert.rejects(w.rt.query('UPDATE tokens SET revoked_at=NULL WHERE id=$1',[token.id]),(error:any)=>error.code==='HU001');assert.equal(await w.kit.principals.authenticate('Bearer '+token.token),null);
});
test('token revocation is one-way for every account and its original actor and time remain unchanged',async t=>{
 const w=await world(t),token=await w.kit.principals.issueToken(w.admin,w.member.id,'synthetic-revocation');await w.rt.query('UPDATE tokens SET revoked_at=now(),revoked_by=$1 WHERE id=$2',[w.admin.id,token.id]);const before=(await w.db.query('SELECT * FROM tokens WHERE id=$1',[token.id])).rows[0];
 for(const change of ['revoked_at=NULL',"revoked_at=revoked_at+interval '1 second'",'revoked_by=NULL'])await assert.rejects(w.rt.query('UPDATE tokens SET '+change+' WHERE id=$1',[token.id]),(error:any)=>error.code==='HU001');
 await w.kit.principals.revokeToken(w.admin,token.id);assert.deepEqual((await w.db.query('SELECT * FROM tokens WHERE id=$1',[token.id])).rows[0],before);assert.equal(await w.kit.principals.authenticate('Bearer '+token.token),null);
});
test('the owner deletion function refuses forged manifests and every forged count before sealing an account',async t=>{
 const w=await world(t);await w.kit.store.put({kind:'memory_version',schema:'memory-version@1',provenance:'declared',body:{space:w.member.id,markdown:'synthetic private audit scope'}});await w.kit.artifacts.ingest({bytes:Buffer.from('synthetic audit original'),mediaType:'text/plain',origin:{upload:{session:null}},author:{user:w.member.id},provenanceType:'declared',visibility:{readers:[w.member.id],admins:false,packs:[],shareable:false}});await w.db.query('INSERT INTO personal_cache_installs(owner,digest) VALUES($1,$2)',[w.member.id,'b'.repeat(64)]);
 const preview=await w.kit.memberDeletions!.preview(w.admin,w.member.id),actual=(await w.db.query('SELECT * FROM hub_member_deletion_snapshot($1)',[w.member.id])).rows[0];assert.equal(actual.purge_manifest,preview.purge_manifest);assert.deepEqual(actual.counts,preview.counts);await assert.rejects(w.rt.query('SELECT * FROM hub_member_deletion_snapshot($1)',[w.member.id]),(error:any)=>error.code==='42501');
 const begin=(manifest:string,counts:typeof preview.counts)=>w.rt.query('SELECT hub_begin_member_deletion($1,$2,$3,$4,$5,$6,now(),$7)',[w.admin.id,w.member.id,preview.epoch,randomUUID(),manifest,JSON.stringify(counts),w.member.updated_at]);
 await assert.rejects(begin('0'.repeat(64),preview.counts),/deletion manifest or counts changed/);for(const key of Object.keys(preview.counts)as(keyof typeof preview.counts)[])await assert.rejects(begin(preview.purge_manifest,{...preview.counts,[key]:preview.counts[key]+1}),/deletion manifest or counts changed/);
 assert.equal((await w.kit.principals.get(w.member.id))?.deleted_at,undefined);assert.equal((await w.db.query('SELECT count(*)::int n FROM member_deletion_intents')).rows[0].n,0);await begin(preview.purge_manifest,preview.counts);assert.ok((await w.kit.principals.get(w.member.id))?.deleted_at);
});

for(const permanent of [false,true])test('the append-only index exception removes only purged private object lookups: '+permanent,async t=>{
 const w=await world(t),artifact=await w.kit.store.withTransaction(async tx=>{const scope=await w.kit.personalPayloads!.scope(w.member.id,tx),capture=await w.kit.artifacts.ingest({personalOwner:w.member.id,bytes:Buffer.from('synthetic purge index exception'),mediaType:'text/plain',origin:{read:{object:'synthetic:private:index'}},author:{user:null},provenanceType:'observed',visibility:{readers:[w.member.id],admins:false,packs:[],shareable:false}},tx);await w.kit.store.put({kind:'knowledge_space_source',schema:'knowledge-space-source@1',provenance:'declared',body:{space:w.member.id,personal_epoch:scope.epoch,path:'/',artifact:capture.digest,sha256:capture.body.sha256,size:capture.body.size,by:w.member.id,at:new Date().toISOString()}},tx);return capture;}),row=(await w.db.query('SELECT seq FROM records WHERE digest=$1',[artifact.digest])).rows[0];await w.db.query("INSERT INTO record_index(key,value,digest,record_seq) VALUES('synthetic.keep','digest-only',$1,$2)",[artifact.digest,row.seq]);
 await assert.rejects(w.rt.query('DELETE FROM record_index WHERE digest=$1',[artifact.digest]),(error:any)=>error.code==='42501');await assert.rejects(w.db.query("DELETE FROM record_index WHERE digest=$1 AND key='artifact.object'",[artifact.digest]),(error:any)=>error.code==='HU001');
 if(permanent){const preview=await w.kit.memberDeletions!.preview(w.admin,w.member.id),intent=await w.kit.memberDeletions!.prepare(w.admin,{...preview,operation_id:randomUUID()});await w.kit.memberDeletions!.finish(w.admin,w.member.id,intent.operation_id);}else{const scope=await w.kit.personalPayloads!.inspect(artifact.digest);assert.ok(scope);await w.kit.personalPayloads!.purge(w.member,scope.epoch);}
 assert.equal((await w.db.query("SELECT 1 FROM record_index WHERE digest=$1 AND key='artifact.object'",[artifact.digest])).rowCount,0);assert.equal((await w.db.query("SELECT 1 FROM record_index WHERE digest=$1 AND key='synthetic.keep'",[artifact.digest])).rowCount,1);await assert.rejects(w.db.query("DELETE FROM record_index WHERE digest=$1 AND key='synthetic.keep'",[artifact.digest]),(error:any)=>error.code==='HU001');
});
