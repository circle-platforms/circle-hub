import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startPostgres, type TemporaryPostgres } from '../../testing/postgres.ts';
import { openPackTestbed } from './testing/setup.ts';
import { workflowPack, systemPack, productPack, type PackDescription } from './testing/builder.ts';
import { mayUsePersonalPack } from '../../records/api.ts';

let postgres:TemporaryPostgres;
before(async()=>{postgres=await startPostgres();});
after(()=>postgres?.stop());
const skill=(id='synthetic-personal-skill'):PackDescription=>({id,version:'1.0.0',kind:'skill',title:'合成个人技能',description:'合成步骤，不作验收',files:{'SKILL.md':'# 合成技能\n\n按合成步骤检查。\n','skill.json':{schema:'skill@1',parsers:[]}}});

test('personal publication admits only usable skill dependencies and treats absent and private skills alike',async t=>{
 const bed=await openPackTestbed({postgres});t.after(()=>bed.close());const personal=bed.registry.personal!,privateSkill=skill('synthetic-private-dependency');
 assert.ok((await personal.publish(bed.carol,(await bed.write(privateSkill)).dir)).ok);
 const pack=workflowPack({id:'synthetic-dependent-flow'});pack.dependencies=[{pack:privateSkill.id,space:bed.carol.id,version:'1.0.0'}];
 const written=await bed.write(pack),denied=await personal.publish(bed.alice,written.dir);assert.equal(denied.ok,false);if(denied.ok)return;
 const absent=await personal.check(bed.alice,(await bed.write({...pack,dependencies:[{pack:'synthetic-absent',space:bed.carol.id}]})).dir);assert.equal(absent.ok,false);if(absent.ok)return;
 assert.deepEqual(denied.problems,absent.problems);assert.equal((await personal.versions(bed.alice.id,pack.id)).length,0);
 await personal.grant(bed.carol,privateSkill.id,{audience:'member',member:bed.alice.id});assert.ok((await personal.publish(bed.alice,written.dir)).ok);
 const own=skill('synthetic-own-dependency');assert.ok((await personal.publish(bed.alice,(await bed.write(own)).dir)).ok);
 const team=skill('synthetic-team-dependency');await bed.publish(bed.alice,team);
 const teamFlow={...pack,id:'synthetic-team-dependent',dependencies:[{pack:team.id}]};assert.equal((await personal.check(bed.alice,(await bed.write(teamFlow)).dir)).ok,false);
 await bed.registry.install(bed.admin,team.id+'@'+team.version);assert.ok((await personal.publish(bed.alice,(await bed.write(teamFlow)).dir)).ok);
 const ownedFlow={...pack,id:'synthetic-own-dependent',dependencies:[{pack:own.id}]};assert.ok((await personal.publish(bed.alice,(await bed.write(ownedFlow)).dir)).ok);
 assert.equal((await personal.precheckGrant(bed.alice,ownedFlow.id,[bed.bob])).at(-1)?.state,'violation');
 await personal.grant(bed.alice,own.id,{audience:'member',member:bed.bob.id});assert.equal((await personal.precheckGrant(bed.alice,ownedFlow.id,[bed.bob])).at(-1)?.state,'pass');
 await personal.grant(bed.alice,ownedFlow.id,{audience:'member',member:bed.bob.id});assert.ok(await personal.resolve(bed.bob,bed.alice.id,ownedFlow.id));
 assert.equal((await personal.check(bed.alice,(await bed.write({...pack,id:'synthetic-wrong-version',dependencies:[{pack:own.id,space:bed.alice.id,version:'9.0.0'}]})).dir)).ok,false);
 assert.equal((await personal.check(bed.alice,(await bed.write({...pack,id:'synthetic-wrong-kind',dependencies:[{pack:pack.id,space:bed.alice.id}]})).dir)).ok,false);
});

test('third-party dependency grants never change personal workflow grant previews, including transitive dependencies',async t=>{
 const bed=await openPackTestbed({postgres});t.after(()=>bed.close());const personal=bed.registry.personal!,dependency=skill('synthetic-foreign-dependency');
 assert.ok((await personal.publish(bed.carol,(await bed.write(dependency)).dir)).ok);await personal.grant(bed.carol,dependency.id,{audience:'member',member:bed.alice.id});
 const pack=workflowPack({id:'synthetic-oracle-flow'});pack.dependencies=[{pack:dependency.id,space:bed.carol.id}];assert.ok((await personal.publish(bed.alice,(await bed.write(pack)).dir)).ok);
 const before=await bed.kit.store.watermark!(),preview=await personal.precheckGrant(bed.alice,pack.id,[bed.bob]);assert.equal(preview.at(-1)?.state,'violation');assert.equal(await bed.kit.store.watermark!(),before);
 await personal.grant(bed.carol,dependency.id,{audience:'member',member:bed.bob.id});assert.deepEqual(await personal.precheckGrant(bed.alice,pack.id,[bed.bob]),preview);
 const admin=await personal.precheckGrant(bed.alice,pack.id,[bed.admin]);await personal.grant(bed.carol,dependency.id,{audience:'administrators'});assert.deepEqual(await personal.precheckGrant(bed.alice,pack.id,[bed.admin]),admin);assert.deepEqual(admin,preview);
 await assert.rejects(personal.grant(bed.alice,pack.id,{audience:'member',member:bed.bob.id}));assert.equal(await personal.resolve(bed.bob,bed.alice.id,pack.id),null);
 const nested={...skill('synthetic-nested-dependency'),dependencies:pack.dependencies};assert.ok((await personal.publish(bed.alice,(await bed.write(nested)).dir)).ok);
 const indirect={...pack,id:'synthetic-indirect-flow',dependencies:[{pack:nested.id}]};assert.ok((await personal.publish(bed.alice,(await bed.write(indirect)).dir)).ok);
 const indirectPreview=await personal.precheckGrant(bed.alice,indirect.id,[bed.bob]);assert.deepEqual(indirectPreview,preview);
 await assert.rejects(personal.grant(bed.alice,nested.id,{audience:'member',member:bed.bob.id}));assert.deepEqual(await personal.precheckGrant(bed.alice,indirect.id,[bed.bob]),indirectPreview);
});

test('a member without team publication rights owns a separate namespace with current grants and no administrator bypass',async t=>{
  const bed=await openPackTestbed({postgres});t.after(()=>bed.close());const personal=bed.registry.personal!;
  const source=await bed.write(skill()),first=await personal.publish(bed.carol,source.dir);assert.equal(first.ok,true,JSON.stringify(first));if(!first.ok)return;
  const second=await personal.publish(bed.bob,source.dir);assert.equal(second.ok,true);assert.equal(second.ok&&second.version.digest,first.version.digest);assert.notEqual(second.ok&&second.version.record,first.version.record);
  assert.equal(await personal.resolve(bed.admin,bed.carol.id,source.manifest.id),null);assert.equal(await bed.registry.byDigest(first.version.digest),null);
  assert.equal((await personal.list(bed.carol)).length,1);assert.equal((await personal.list(bed.admin)).length,0);
  await personal.grant(bed.carol,source.manifest.id,{audience:'member',member:bed.alice.id});assert.ok(await personal.resolve(bed.alice,bed.carol.id,source.manifest.id));
  assert.equal(await mayUsePersonalPack(bed.kit.store,bed.alice,bed.carol.id,source.manifest.id),true);
  const file=first.version.manifest.files.find(file=>file.path==='SKILL.md')!;assert.ok((await personal.source(bed.alice,file.sha256))?.bytes);assert.equal(await personal.source(bed.admin,file.sha256),null);
  await personal.grant(bed.carol,source.manifest.id,{audience:'member',member:bed.alice.id,revoke:true});assert.equal(await personal.resolve(bed.alice,bed.carol.id,source.manifest.id),null);assert.equal(await personal.source(bed.alice,file.sha256),null);
  await personal.grant(bed.carol,source.manifest.id,{audience:'administrators'});assert.ok(await personal.resolve(bed.admin,bed.carol.id,source.manifest.id));
});

test('personal publication reuses validation and refuses product/system packs, credential hits and reused versions',async t=>{
  const bed=await openPackTestbed({postgres});t.after(()=>bed.close());const personal=bed.registry.personal!;
  for(const pack of [productPack(),systemPack()]){const result=await personal.publish(bed.carol,(await bed.write(pack)).dir);assert.equal(result.ok,false);assert.ok(!result.ok&&result.problems.some(problem=>problem.rule==='personal.kind'));}
  const credential=skill();credential.files['SKILL.md']='DB_PASSWORD=hunter22x';const refused=await personal.publish(bed.carol,(await bed.write(credential)).dir);assert.equal(refused.ok,false);assert.ok(!refused.ok&&refused.problems.some(problem=>problem.rule==='file.credential'));
  const pack=workflowPack(),published=await personal.publish(bed.carol,(await bed.write(pack)).dir);assert.equal(published.ok,true,JSON.stringify(published));
  pack.title='合成已修改标题';const reused=await personal.publish(bed.carol,(await bed.write(pack)).dir);assert.equal(reused.ok,false);assert.ok(!reused.ok&&reused.problems.some(problem=>problem.rule==='publish.version_reused'));
});

test('team promotion requires the existing publish right and never changes the personal publication',async t=>{
  const bed=await openPackTestbed({postgres});t.after(()=>bed.close());const personal=bed.registry.personal!,pack=workflowPack();
  const published=await personal.publish(bed.carol,(await bed.write(pack)).dir);assert.ok(published.ok);
  const denied=await personal.promote(bed.carol,pack.id);assert.equal(denied.ok,false);assert.ok(!denied.ok&&denied.problems.some(problem=>problem.rule==='publish.no_right'));
  await bed.kit.authorizations.grantPublishRight(bed.admin,bed.carol.id);
  const promoted=await personal.promote(bed.carol,pack.id);assert.ok(promoted.ok,JSON.stringify(promoted));assert.equal(await personal.transferred(published.version.digest),true);
  assert.ok(await personal.resolve(bed.carol,bed.carol.id,pack.id));assert.ok(await bed.registry.resolve(pack.id));
  await personal.retire(bed.carol,pack.id,pack.version);assert.equal(await personal.resolve(bed.carol,bed.carol.id,pack.id),null);assert.ok(await personal.open(bed.carol.id,published.version.digest));assert.ok(await bed.registry.resolve(pack.id));
});

test('two registry instances serialize the same personal version without nesting artifact transactions',async t=>{
  const bed=await openPackTestbed({postgres});t.after(()=>bed.close());const written=await bed.write(skill('synthetic-concurrent-personal'));
  const other=bed.second();
  const outcomes=await Promise.all([bed.registry.personal!.publish(bed.carol,written.dir),other.personal!.publish(bed.carol,written.dir)]);
  assert.ok(outcomes.every(row=>row.ok),JSON.stringify(outcomes));
  assert.equal(outcomes.filter(row=>row.ok&&row.created).length,1);
  assert.equal((await bed.registry.personal!.versions(bed.carol.id,written.manifest.id)).length,1);
});

for(const [id,type] of [['named-document','doc:doc'],['business-system','synthetic:case']] as const)test(`personal workflows and skill methods refuse ${id} declarations before publication`,async t=>{
  const bed=await openPackTestbed({postgres});t.after(()=>bed.close());
  for(const method of [false,true]){
    const pack=workflowPack({id:`unsafe-${id}-${method?'skill':'workflow'}`});
    (pack.files['workflow.json'] as any).inputs[0].accepts=[type];
    if(method){pack.kind='skill';pack.files['skill.json']={schema:'skill@1',parsers:[]};}
    const outcome=await bed.registry.personal!.publish(bed.carol,(await bed.write(pack)).dir);
    assert.equal(outcome.ok,false,JSON.stringify(outcome));assert.ok(!outcome.ok&&outcome.problems.some(problem=>problem.rule==='PACK_PERSONAL_CAPABILITY_DENIED'));
    assert.equal((await bed.registry.personal!.versions(bed.carol.id,pack.id)).length,0);
  }
});

test('personal publication refuses a shared lease namespace without acquiring or registering it',async t=>{
  const bed=await openPackTestbed({postgres});t.after(()=>bed.close());const pack=workflowPack({id:'unsafe-personal-lease'});
  Object.assign(pack.files['workflow.json'] as object,{context:['leases'],leases:{prefix:'bed/'}});
  const outcome=await bed.registry.personal!.publish(bed.carol,(await bed.write(pack)).dir);
  assert.equal(outcome.ok,false,JSON.stringify(outcome));assert.ok(!outcome.ok&&outcome.problems.some(problem=>problem.rule==='PACK_PERSONAL_CAPABILITY_DENIED'));
});

test('promotion previews stop at permission, store nothing, and confirmation checks permission again',async t=>{
 const bed=await openPackTestbed({postgres});t.after(()=>bed.close());const personal=bed.registry.personal!,pack=skill('synthetic-preview');
 assert.equal((await personal.publish(bed.carol,(await bed.write(pack)).dir)).ok,true);
 const before=await bed.kit.store.watermark!();const denied=await personal.precheckPromotion(bed.carol,pack.id);
 assert.deepEqual(denied.checks.map(c=>c.state),['violation','unchecked','unchecked','unchecked','unchecked']);assert.equal(await bed.kit.store.watermark!(),before);
 await bed.kit.authorizations.grantPublishRight(bed.admin,bed.carol.id);
 const ready=await personal.precheckPromotion(bed.carol,pack.id);assert.equal(ready.ok,true,JSON.stringify(ready));assert.equal(await bed.registry.resolve(pack.id),null);
 await bed.kit.authorizations.revokePublishRight(bed.admin,bed.carol.id);
 assert.equal((await personal.promote(bed.carol,pack.id)).ok,false);assert.equal(await bed.registry.resolve(pack.id),null);
});
