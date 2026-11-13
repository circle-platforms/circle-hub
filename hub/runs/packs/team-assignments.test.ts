import assert from 'node:assert/strict';
import {after,before,test} from 'node:test';
import {AccessError,ConflictError} from '../../records/api.ts';
import {startPostgres,type TemporaryPostgres} from '../../testing/postgres.ts';
import {createPackCatalog} from './ports.ts';
import {openPackTestbed} from './testing/setup.ts';
import {productPack,systemPack,workflowPack} from './testing/builder.ts';

let postgres:TemporaryPostgres;
before(async()=>{postgres=await startPostgres();});
after(()=>postgres?.stop());

test('team assignment uses pack admission and preserves direct and inherited decision sources',async t=>{
  const bed=await openPackTestbed({postgres});t.after(()=>bed.close());
  await bed.publish(bed.alice,workflowPack());
  await bed.publish(bed.alice,systemPack());
  await bed.publish(bed.bob,productPack());
  const team=await bed.kit.teams.create(bed.admin,'合成运行团队');
  await bed.kit.teams.add(bed.admin,team.id,bed.bob.id);
  await assert.rejects(bed.registry.assignTeam(bed.alice,team.id,'demo-review'),AccessError);
  for(const pack of ['never-published','tracker-system','widget']){
    await assert.rejects(bed.registry.assignTeam(bed.admin,team.id,pack),ConflictError);
  }
  const grant=await bed.registry.assignTeam(bed.admin,team.id,'demo-review',{note:'合成团队授权'});
  assert.equal(grant.body.subject,team.id);
  assert.equal(grant.body.note,'合成团队授权');
  assert.equal(await bed.registry.canUse(bed.bob.id,'demo-review'),true);
  assert.deepEqual(await bed.registry.packSources(bed.admin,bed.bob.id),[{pack:'demo-review',via:{team:team.id}}]);
  await assert.rejects(bed.registry.packSources(bed.bob,bed.bob.id),AccessError);
  assert.deepEqual(await bed.registry.assignments(bed.admin),[]);
  await bed.registry.assign(bed.admin,bed.bob.id,'demo-review');
  assert.equal((await bed.registry.assignments(bed.admin)).length,1);
  await bed.registry.unassign(bed.admin,bed.bob.id,'demo-review');
  assert.equal(await bed.registry.canUse(bed.bob.id,'demo-review'),true);
  assert.deepEqual(await bed.registry.assignments(bed.admin),[]);
  await assert.rejects(bed.registry.unassignTeam(bed.bob,team.id,'demo-review'),AccessError);
  const revoked=await bed.registry.unassignTeam(bed.admin,team.id,'demo-review','合成撤回');
  assert.equal(revoked.body.revoked,true);
  assert.equal(await bed.registry.canUse(bed.bob.id,'demo-review'),false);
});

test('only an administrator listing discloses the actual assigned team ids',async t=>{
  const bed=await openPackTestbed({postgres});t.after(()=>bed.close());
  await bed.publish(bed.alice,workflowPack());
  const team=await bed.kit.teams.create(bed.admin,'合成列表团队');
  await bed.kit.teams.add(bed.admin,team.id,bed.bob.id);
  await bed.registry.assignTeam(bed.admin,team.id,'demo-review');
  const catalog=createPackCatalog(bed.registry);
  const admin=(await catalog.list(bed.admin)).find(pack=>pack.id==='demo-review');
  assert.deepEqual(admin?.assigned_teams,[team.id]);
  const member=(await catalog.list(bed.bob)).find(pack=>pack.id==='demo-review');
  assert.ok(member);
  assert.equal(Object.hasOwn(member,'assigned_teams'),false);
  await assert.rejects(bed.registry.assignedTeams(bed.bob,'demo-review'),AccessError);
});
