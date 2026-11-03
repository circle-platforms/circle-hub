// Synthetic permanent deletion exercises the real PostgreSQL boundary, not only UI visibility.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID,randomBytes} from 'node:crypto';
import {openTestRecords} from '../testing/records.ts';
import {Database,createPool} from './db.ts';
import {grantRuntime} from './migrations.ts';
import {PgMemberDeletions} from './member-deletions.ts';
import {INITIAL_PERSONAL_EPOCH} from './api.ts';
async function world(t:any){const kit=await openTestRecords();t.after(()=>kit.close());const {user:admin}=await kit.principals.bootstrapAdmin('synthetic-admin');const member=await kit.principals.createUser(admin,'synthetic-member','user',{password:'Synthetic-member-password-71!',mustChange:false});const db=new Database(createPool(kit.database));t.after(()=>db.end());return {kit,admin,member,db,deletions:kit.memberDeletions!};}
async function prepare(w:Awaited<ReturnType<typeof world>>){const preview=await w.deletions.preview(w.admin,w.member.id);return {preview,intent:await w.deletions.prepare(w.admin,{...preview,operation_id:randomUUID()})};}
test('an irreversible tombstone invalidates passwords, sessions, tokens, invitations and epochs while preserving team and other owners',async t=>{
 const w=await world(t),{kit,member,admin,db,deletions}=w;
 const token=await kit.principals.issueToken(admin,member.id,'synthetic-client'),invitation=await kit.principals.invite(admin,member.id),credentials=await kit.principals.verifyPassword(member.name,'Synthetic-member-password-71!');assert.ok(credentials);
 const session=await kit.principals.openConsoleSession(member.id,credentials.revision);assert.ok(session);
 const put=(space:string,markdown:string)=>kit.store.put({kind:'memory_version',schema:'memory-version@1',provenance:'declared',body:{space,markdown}});
 const personal=await put(member.id,'synthetic-private-body'),team=await put('team','synthetic-team-body'),other=await put(admin.id,'synthetic-other-body');
 const attribution=await kit.store.put({kind:'knowledge_source_attribution',schema:'knowledge-source-attribution@1',provenance:'declared',body:{space:member.id,by:member.id,source:'a'.repeat(64),artifact:'b'.repeat(64),sha256:'c'.repeat(64),at:'2026-11-03T00:00:00.000Z',audience:'team'}});
 const {intent}=await prepare(w);assert.equal((await kit.principals.get(member.id))?.deleted_at,intent.at);assert.equal((await kit.principals.history(member.id)).at(-1)?.deleted_at,intent.at);
 assert.equal(await kit.principals.verifyPassword(member.name,'Synthetic-member-password-71!'),null);assert.equal(await kit.principals.authenticate('Bearer '+token.token),null);assert.equal(await kit.principals.authenticate('Bearer '+session.token),null);assert.equal(await kit.principals.openConsoleSession(member.id,credentials.revision),null);
 assert.equal((await kit.principals.checkInvitation(invitation.code)).ok,false);
 await assert.rejects(kit.principals.setDisabled(admin,member.id,false));await assert.rejects(kit.principals.setDisabled(admin,member.id,true));await assert.rejects(kit.principals.setRole(admin,member.id,'user'));await assert.rejects(kit.principals.resetPassword(admin,member.id));
 const receipt=await deletions.finish(admin,member.id,intent.operation_id);assert.equal(receipt.purge_manifest,intent.purge_manifest);assert.equal(await kit.store.get(personal.digest),null);assert.equal(await kit.store.get(attribution.digest),null);assert.ok(await kit.store.get(team.digest));assert.ok(await kit.store.get(other.digest));
 assert.equal((await db.query('SELECT count(*)::int n FROM personal_payloads WHERE owner=$1',[member.id])).rows[0].n,0);
 await assert.rejects(kit.personalPayloads!.scope(member.id));await assert.rejects(db.query('SELECT hub_resume_personal($1,$2,$3)',[member.id,INITIAL_PERSONAL_EPOCH,randomUUID()]));
 assert.deepEqual(await deletions.finish(admin,member.id,intent.operation_id),receipt);assert.equal((await kit.store.list({kind:'member_deletion'})).items.length,1);
 const fresh=await kit.principals.createUser(admin,member.name);assert.notEqual(fresh.id,member.id);assert.equal((await kit.personalSync!.state(fresh)).used_bytes,0);assert.equal(await kit.store.get(personal.digest),null);
});
test('the last active administrator and a stale pre-check cannot begin deletion',async t=>{
 const w=await world(t);await assert.rejects(w.deletions.preview(w.admin,w.admin.id));
 const old=await w.deletions.preview(w.admin,w.member.id);await w.kit.store.put({kind:'memory_version',schema:'memory-version@1',provenance:'declared',body:{space:w.member.id,markdown:'intervening-private-write'}});
 await assert.rejects(w.deletions.prepare(w.admin,{...old,operation_id:randomUUID()}));assert.equal((await w.kit.principals.get(w.member.id))?.disabled,false);assert.equal((await w.db.query('SELECT count(*)::int n FROM member_deletion_intents')).rows[0].n,0);
 await assert.rejects(w.deletions.preview(w.member,w.admin.id));
 await w.kit.principals.setDisabled(w.admin,w.member.id,true);const {intent}=await prepare(w);await w.deletions.finish(w.admin,w.member.id,intent.operation_id);assert.ok((await w.kit.principals.get(w.member.id))?.deleted_at);
});
test('failed retirement leaves a sealed account and recoverable digest-only intent without a false completion',async t=>{
 const w=await world(t);await w.kit.store.put({kind:'memory_version',schema:'memory-version@1',provenance:'declared',body:{space:w.member.id,markdown:'synthetic-resume-private'}});
 const {intent}=await prepare(w),failing=new PgMemberDeletions(w.db,w.kit.store,w.kit.personalPayloads!,async()=>{throw new Error('synthetic durable retirement failure');},()=>new Date());
 await assert.rejects(failing.finish(w.admin,w.member.id,intent.operation_id),(e:any)=>e.message.includes('存储清理未完成')&&e.cause?.message==='synthetic durable retirement failure');assert.ok((await w.kit.principals.get(w.member.id))?.deleted_at);assert.equal((await w.kit.store.list({kind:'member_deletion'})).items.length,0);assert.ok((await w.db.query('SELECT 1 FROM personal_payloads WHERE owner=$1',[w.member.id])).rowCount);
 await w.deletions.finish(w.admin,w.member.id,intent.operation_id);assert.equal((await w.db.query('SELECT count(*)::int n FROM personal_payloads WHERE owner=$1',[w.member.id])).rows[0].n,0);
});
test('a runtime role gets no tombstone or payload mutation grants and cannot reopen the conversion window',async t=>{
 const w=await world(t),role='synthetic_delete_'+randomBytes(4).toString('hex'),password=randomBytes(20).toString('hex');await w.db.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`);await w.db.query('REVOKE TEMPORARY ON DATABASE "'+w.kit.database.database+'" FROM PUBLIC');await grantRuntime(w.db,role);
 const rt=new Database(createPool({...w.kit.database,user:role,password}));t.after(()=>rt.end());
 await assert.rejects(rt.query('UPDATE users SET deleted_at=now() WHERE id=$1',[w.member.id]),(e:any)=>e.code==='42501');await assert.rejects(rt.query('DELETE FROM personal_payloads'),(e:any)=>e.code==='42501');
 await rt.query("SELECT set_config('circle_hub.member_layout_conversion','19',false)");assert.equal((await rt.query('SELECT hub_member_layout_conversion() AS yes')).rows[0].yes,false);
 const victim=await w.kit.store.put({kind:'claim',schema:'synthetic@1',provenance:'declared',body:{text:'synthetic-reviewed-history'}});await w.db.query(`GRANT UPDATE(body) ON records TO ${role}`);
 await assert.rejects(rt.query("UPDATE records SET body='{}' WHERE digest=$1",[victim.digest]),(e:any)=>e.code==='HU001');await grantRuntime(w.db,role);
 const {intent}=await prepare(w);await assert.rejects(rt.query('UPDATE users SET disabled=false WHERE id=$1',[w.member.id]),(e:any)=>e.code==='HU001');await w.deletions.finish(w.admin,w.member.id,intent.operation_id);
});

test('concurrent administrator self-deletions keep one active administrator and finish only the authorized operation',async t=>{
 const w=await world(t),other=await w.kit.principals.createUser(w.admin,'synthetic-second-admin','admin'),users=[w.admin,other],previews=await Promise.all(users.map(u=>w.deletions.preview(u,u.id)));
 const results=await Promise.allSettled(users.map((u,n)=>w.deletions.prepare(u,{...previews[n],operation_id:randomUUID()})));assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 const winner=results.findIndex(r=>r.status==='fulfilled'),intent=(results[winner] as PromiseFulfilledResult<any>).value;await w.deletions.finish(users[winner],users[winner].id,intent.operation_id);
 assert.equal((await w.kit.principals.list()).filter(u=>u.role==='admin'&&!u.disabled).length,1);assert.ok((await w.kit.principals.get(users[winner].id))?.deleted_at);
 await assert.rejects(w.deletions.preview(users[1-winner],users[1-winner].id));
});
test('a queued low-level personal write cannot append private bytes after the tombstone commits',async t=>{
 const w=await world(t),{barrier,reaches}=await import('../testing/member-freeze.ts'),entered=barrier(),release=barrier(),lock=w.kit.store.lock.bind(w.kit.store);let once=false;
 w.kit.store.lock=async(key,tx)=>{if(key==='knowledge-space:'+w.member.id&&!once){once=true;entered.release();await release.promise;}return lock(key,tx);};
 const writing=w.kit.store.put({kind:'memory_version',schema:'memory-version@1',provenance:'declared',body:{space:w.member.id,markdown:'synthetic queued bytes'}}),refused=assert.rejects(writing);void refused.catch(()=>{});
 try{await reaches(entered,writing);const {intent}=await prepare(w);await w.deletions.finish(w.admin,w.member.id,intent.operation_id);}finally{release.release();}await refused;
 assert.equal((await w.db.query('SELECT count(*)::int n FROM personal_payloads WHERE owner=$1',[w.member.id])).rows[0].n,0);assert.equal((await w.kit.store.list({kind:'memory_version'})).items.length,0);
});

test('a legacy private capture outside the purge store blocks deletion instead of leaving its bytes behind',async t=>{
 const w=await world(t),artifact=await w.kit.artifacts.ingest({bytes:Buffer.from('synthetic legacy private original'),mediaType:'text/plain',origin:{upload:{session:null}},author:{user:w.admin.id},provenanceType:'declared',visibility:{readers:[w.admin.id],admins:false,packs:[],shareable:false}});
 // Simulate a pre-upgrade inline capture through the owner connection. Current writes require owned bytes.
 const {canonicalize}=await import('./canonical.ts'),{envelopeDigest}=await import('./digest.ts'),{newId}=await import('./ids.ts');
 const body=canonicalize({...artifact.body,author:{user:w.member.id},visibility:{readers:[w.member.id],admins:false,packs:[],shareable:false}}),created_at=new Date().toISOString(),digest=envelopeDigest({kind:'source_artifact',schema:'source_artifact@1',provenance:'declared',created_at},body);
 const row=(await w.db.query("INSERT INTO records(id,digest,kind,schema,provenance,created_at,body,size) VALUES($1,$2,'source_artifact','source_artifact@1','declared',$3,$4,$5) RETURNING seq",[newId('rcd'),digest,created_at,body,Buffer.byteLength(body)])).rows[0];
 await w.db.query("INSERT INTO record_index(key,value,digest,record_seq) VALUES('artifact.author',$1,$2,$3)",[w.member.id,digest,row.seq]);
 await assert.rejects(w.deletions.preview(w.admin,w.member.id));assert.equal((await w.kit.principals.get(w.member.id))?.disabled,false);assert.equal((await w.kit.store.list({kind:'member_deletion'})).items.length,0);
});

test('a queued administrator preview rechecks the actor after deactivation before exposing private metadata',async t=>{
 const w=await world(t),other=await w.kit.principals.createUser(w.admin,'synthetic-preview-admin','admin'),{barrier,reaches}=await import('../testing/member-freeze.ts'),entered=barrier(),release=barrier(),lock=w.kit.store.lock.bind(w.kit.store);let once=false;
 w.kit.store.lock=async(key,tx)=>{if(key==='knowledge-space:'+w.member.id&&!once){once=true;entered.release();await release.promise;}return lock(key,tx);};
 const preview=w.deletions.preview(w.admin,w.member.id),refused=assert.rejects(preview,{name:'AccessError'});void refused.catch(()=>{});
 try{await reaches(entered,preview);await w.kit.principals.setDisabled(other,w.admin.id,true);}finally{release.release();}await refused;
 assert.equal((await w.db.query('SELECT count(*)::int n FROM member_deletion_intents')).rows[0].n,0);
});
