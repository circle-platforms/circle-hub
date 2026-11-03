// An old run without an exact private-version holder must block deletion, never acquire a fabricated replacement.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {openTestRecords} from '../testing/records.ts';
import {Database,createPool} from './db.ts';
import {runRecord} from '../../contracts/src/fixtures.ts';
for(const dependency of [false,true])test(`a missing legacy frozen private ${dependency?'dependency':'workflow'} blocks the deletion pre-check`,async t=>{
 const kit=await openTestRecords();t.after(()=>kit.close());const {user:admin}=await kit.principals.bootstrapAdmin('synthetic-holder-admin'),member=await kit.principals.createUser(admin,'synthetic-holder-member'),db=new Database(createPool(kit.database));t.after(()=>db.end());
 await db.query('ALTER TABLE records DISABLE TRIGGER records_private_run');
 try{await kit.store.put({kind:'run',schema:'run@1',provenance:'declared',body:{...runRecord,runner:admin.id,...(dependency?{skills:[{space:member.id,pack:'synthetic-unknown-skill',version:'1.0.0',digest:'0'.repeat(64)}]}:{pack_space:member.id,pack_digest:'0'.repeat(64)})}});}finally{await db.query('ALTER TABLE records ENABLE TRIGGER records_private_run');}
 await assert.rejects(kit.memberDeletions!.preview(admin,member.id),/冻结副本无法核对/);const counts={records:0,payloads:0,objects:0,attributions:0,archives:0,private_versions:0};await assert.rejects(db.query('SELECT hub_begin_member_deletion($1,$2,$3,$4,$5,$6,now(),$7)',[admin.id,member.id,'00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','1'.repeat(64),JSON.stringify(counts),member.updated_at]),/frozen private version cannot be verified/);assert.equal((await kit.principals.get(member.id))?.disabled,false);assert.equal((await db.query('SELECT count(*)::int n FROM member_deletion_intents')).rows[0].n,0);
});
