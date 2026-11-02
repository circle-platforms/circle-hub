// Personal workflow/skill publication must share the user's committing account boundary with deactivation.
import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {startPostgres} from '../../testing/postgres.ts';
import {barrier,reaches,waitForUserUpdateLock} from '../../testing/member-freeze.ts';
import {openPackTestbed} from './testing/setup.ts';
import {workflowPack,type PackDescription} from './testing/builder.ts';
let postgres:Awaited<ReturnType<typeof startPostgres>>;
before(async()=>{postgres=await startPostgres();});after(()=>postgres?.stop());
const skill:PackDescription={id:'synthetic-freeze-skill',version:'1.0.0',kind:'skill',title:'合成冻结技能',description:'合成步骤',files:{'SKILL.md':'# 合成技能\n\n合成步骤。','skill.json':{schema:'skill@1',parsers:[]}}};
for(const pack of [workflowPack({id:'synthetic-freeze-workflow'}),skill]){
 test(`deactivation refuses queued personal ${pack.kind} publication and leaves no publication or file captures`,async t=>{
  const bed=await openPackTestbed({postgres});t.after(()=>bed.close());const written=await bed.write(pack),personal=bed.registry.personal!,entered=barrier(),release=barrier(),lock=bed.kit.store.lock.bind(bed.kit.store),mark=await bed.kit.store.watermark!();
  bed.kit.store.lock=async(key,tx)=>{if(key==='personal-pack:'+bed.carol.id+'/'+pack.id){entered.release();await release.promise;}return lock(key,tx);};
  const writing=personal.publish(bed.carol,written.dir),refused=assert.rejects(writing,{name:'AccessError'});void refused.catch(()=>{});
  try{await reaches(entered,writing);await bed.kit.principals.setDisabled(bed.admin,bed.carol.id,true);}finally{release.release();}
  await refused;assert.equal(await bed.kit.store.watermark!(),mark);assert.equal((await personal.versions(bed.carol.id,pack.id)).length,0);
  for(const file of written.manifest.files){assert.equal((await bed.kit.artifacts.records(file.sha256)).length,0);assert.equal(await bed.kit.objects.get(file.sha256),null);}
 });
 test(`a locked personal ${pack.kind} publication commits before deactivation and resumes unchanged`,async t=>{
  const bed=await openPackTestbed({postgres});t.after(()=>bed.close());const written=await bed.write(pack),personal=bed.registry.personal!,entered=barrier(),release=barrier(),active=bed.kit.principals.lockActive.bind(bed.kit.principals);let once=false;
  bed.kit.principals.lockActive=async(...args)=>{const result=await active(...args);if(args[0].id===bed.carol.id&&!once){once=true;entered.release();await release.promise;}return result;};
  const writing=personal.publish(bed.carol,written.dir);await reaches(entered,writing);const disabling=bed.kit.principals.setDisabled(bed.admin,bed.carol.id,true);
  try{await waitForUserUpdateLock(bed.kit);}finally{release.release();}
  const outcome=await writing;assert.equal(outcome.ok,true,JSON.stringify(outcome));await disabling;
  await assert.rejects(personal.resolve(bed.carol,bed.carol.id,pack.id),{name:'AccessError'});const versions=await personal.versions(bed.carol.id,pack.id);
  await bed.kit.principals.setDisabled(bed.admin,bed.carol.id,false);assert.deepEqual(await personal.versions(bed.carol.id,pack.id),versions);assert.ok(await personal.resolve(bed.carol,bed.carol.id,pack.id));
 });
}
test('personal workflow and skill sharing pause for a disabled owner, restore current grants and preserve independent team publications',async t=>{
 const bed=await openPackTestbed({postgres});t.after(()=>bed.close());const personal=bed.registry.personal!,packs=[workflowPack({id:'synthetic-restored-workflow'}),{...skill,id:'synthetic-restored-skill'}];
 await bed.kit.authorizations.grantPublishRight(bed.admin,bed.carol.id);
 for(const pack of packs){assert.ok((await personal.publish(bed.carol,(await bed.write(pack)).dir)).ok);await personal.grant(bed.carol,pack.id,{audience:'member',member:bed.bob.id});await personal.grant(bed.carol,pack.id,{audience:'administrators'});assert.ok((await personal.promote(bed.carol,pack.id)).ok);}
 const versions=await Promise.all(packs.map(pack=>personal.versions(bed.carol.id,pack.id))),mark=await bed.kit.store.watermark!();
 await bed.kit.principals.setDisabled(bed.admin,bed.carol.id,true);
 for(const [i,pack]of packs.entries()){
  assert.equal(await personal.resolve(bed.bob,bed.carol.id,pack.id),null);assert.equal(await personal.resolve(bed.admin,bed.carol.id,pack.id),null);assert.ok(await bed.registry.resolve(pack.id));
  assert.equal(await personal.source(bed.bob,versions[i][0].manifest.files[0].sha256),null);
  await assert.rejects(personal.grant(bed.carol,pack.id,{audience:'member',member:bed.bob.id,revoke:true}),{name:'AccessError'});
  await assert.rejects(personal.retire(bed.carol,pack.id,'1.0.0'),{name:'AccessError'});
 }
 assert.equal((await personal.list(bed.bob)).length,0);assert.equal(await bed.kit.store.watermark!(),mark);
 await bed.kit.principals.setDisabled(bed.admin,bed.carol.id,false);
 for(const [i,pack]of packs.entries()){assert.ok(await personal.resolve(bed.bob,bed.carol.id,pack.id));assert.ok(await personal.resolve(bed.admin,bed.carol.id,pack.id));assert.deepEqual(await personal.versions(bed.carol.id,pack.id),versions[i]);}
 await bed.kit.principals.setDisabled(bed.admin,bed.bob.id,true);for(const pack of packs)await personal.grant(bed.carol,pack.id,{audience:'member',member:bed.bob.id,revoke:true});
 await bed.kit.principals.setDisabled(bed.admin,bed.bob.id,false);for(const pack of packs){assert.equal(await personal.resolve(bed.bob,bed.carol.id,pack.id),null);assert.ok(await personal.resolve(bed.admin,bed.carol.id,pack.id));}
});
