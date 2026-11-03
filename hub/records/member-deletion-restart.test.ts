// A sealed deletion survives a real records-kit shutdown and resumes the same operation after storage repair.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {startPostgres} from '../testing/postgres.ts';
import {DEFAULT_LIMITS} from '../config/index.ts';
import {openRecords} from './index.ts';
import {Database,createPool} from './db.ts';
import {PgMemberDeletions} from './member-deletions.ts';
test('storage failure leaves no completion and a restarted kit finishes exactly the sealed operation',async t=>{
 const pg=await startPostgres();t.after(()=>pg.stop());const database=await pg.createDatabase(),dataDir=await mkdtemp(join(tmpdir(),'synthetic-member-restart-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));const config={database,dataDir,logDir:join(dataDir,'logs'),limits:{...DEFAULT_LIMITS}},first=await openRecords(config);t.after(()=>first.close());
 const {user:admin}=await first.principals.bootstrapAdmin('synthetic-restart-admin'),member=await first.principals.createUser(admin,'synthetic-restart-member'),token=await first.principals.issueToken(admin,member.id,'synthetic-old-token'),privateRecord=await first.store.put({kind:'memory_version',schema:'memory-version@1',provenance:'declared',body:{space:member.id,markdown:'synthetic restart private text'}}),db=new Database(createPool(database));t.after(()=>db.end());
 const preview=await first.memberDeletions!.preview(admin,member.id),intent=await first.memberDeletions!.prepare(admin,{...preview,operation_id:randomUUID()}),broken=new PgMemberDeletions(db,first.store,first.personalPayloads!,async()=>{throw new Error('synthetic durable storage outage');},()=>new Date());
 await assert.rejects(broken.finish(admin,member.id,intent.operation_id),/存储清理未完成/);assert.equal((await first.store.list({kind:'member_deletion'})).items.length,0);assert.ok((await first.principals.get(member.id))?.deleted_at);await first.close();
 const second=await openRecords(config,{migrate:false});t.after(()=>second.close());assert.equal(await second.principals.authenticate('Bearer '+token.token),null);const progress=await second.memberDeletions!.status(admin,member.id);assert.equal(progress?.intent.operation_id,intent.operation_id);assert.equal(progress?.result,null);assert.ok(await second.store.get(privateRecord.digest));
 const done=await second.memberDeletions!.finish(admin,member.id,intent.operation_id);assert.equal(await second.store.get(privateRecord.digest),null);assert.deepEqual(await second.memberDeletions!.finish(admin,member.id,intent.operation_id),done);assert.equal((await second.store.list({kind:'member_deletion'})).items.length,1);assert.equal((await db.query('SELECT count(*)::int n FROM personal_payloads WHERE owner=$1',[member.id])).rows[0].n,0);await assert.rejects(second.principals.setDisabled(admin,member.id,false));
});
