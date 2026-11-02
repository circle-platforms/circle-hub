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
