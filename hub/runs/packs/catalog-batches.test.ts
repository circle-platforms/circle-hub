// Real registry and synthetic published packs, never a business system or model.
import assert from 'node:assert/strict';
import {after,before,test} from 'node:test';
import {startPostgres} from '../../testing/postgres.ts';
import {Database} from '../../records/db.ts';
import {openPackTestbed} from './testing/setup.ts';
import {workflowPack} from './testing/builder.ts';
import {createPackCatalog} from './ports.ts';
let postgres:Awaited<ReturnType<typeof startPostgres>>;
before(async()=>{postgres=await startPostgres();});after(()=>postgres?.stop());
test('catalog metadata batches grow neither admin nor member queries with workflows and recheck withdrawal, grants and disabled accounts',async t=>{
 const bed=await openPackTestbed({postgres});t.after(bed.close);const catalog=createPackCatalog(bed.registry);
 const add=async(n:number)=>{const id='synthetic-review-'+n;await bed.publish(bed.alice,workflowPack({id}));await bed.registry.assign(bed.admin,bed.bob.id,id);};
 for(let n=0;n<3;n++)await add(n);
 const skills=bed.registry.installedSkills;bed.registry.installedSkills=async()=>{throw new Error('unrelated skill metadata must not affect a workflow-only administrator catalog');};
 try{assert.equal((await catalog.list(bed.admin)).length,3);}finally{bed.registry.installedSkills=skills;}
 const original=Database.prototype.query;let calls=0;Database.prototype.query=(async function(this:Database,...args:Parameters<typeof original>){calls++;return original.apply(this,args);}) as typeof original;t.after(()=>{Database.prototype.query=original;});
 await catalog.list(bed.admin);await catalog.list(bed.bob);calls=0;const firstAdmin=await catalog.list(bed.admin),adminCalls=calls;calls=0;const firstUser=await catalog.list(bed.bob),userCalls=calls;assert.equal(firstAdmin.length,3);assert.equal(firstUser.length,3);
 for(let n=3;n<8;n++)await add(n);await catalog.list(bed.admin);await catalog.list(bed.bob);
 calls=0;const admin=await catalog.list(bed.admin);assert.equal(admin.length,8);assert.equal(calls,adminCalls);calls=0;const user=await catalog.list(bed.bob);assert.equal(user.length,8);assert.equal(calls,userCalls);assert.ok(admin.every(pack=>pack.assigned_to?.includes(bed.bob.id)));assert.ok(user.every(pack=>pack.assigned_to===undefined));
 await bed.registry.unassign(bed.admin,bed.bob.id,'synthetic-review-0');assert.ok(!(await catalog.list(bed.bob)).some(pack=>pack.id==='synthetic-review-0'));
 await bed.registry.retire(bed.admin,'synthetic-review-1','1.0.0');assert.equal((await catalog.list(bed.admin)).find(pack=>pack.id==='synthetic-review-1')?.withdrawn,true);assert.ok(!(await catalog.list(bed.bob)).some(pack=>pack.id==='synthetic-review-1'));
 await bed.kit.principals.setDisabled(bed.admin,bed.bob.id,true);assert.deepEqual(await catalog.list(bed.bob),[]);
});
