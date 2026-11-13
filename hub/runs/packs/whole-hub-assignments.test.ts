import assert from 'node:assert/strict';
import {after,before,test} from 'node:test';
import {WHOLE_HUB,withRequestPermissions} from '../../records/api.ts';
import {startPostgres,type TemporaryPostgres} from '../../testing/postgres.ts';
import {createPackCatalog,createPacksPort,createWorkflowStore} from './ports.ts';
import {openPackTestbed} from './testing/setup.ts';
import {productPack,type PackDescription} from './testing/builder.ts';

let postgres:TemporaryPostgres;
before(async()=>{postgres=await startPostgres();});
after(()=>postgres?.stop());

const skill=(version:string):PackDescription=>({
  id:'synthetic-global-skill',version,kind:'skill',title:'合成全局技能',description:'合成安装回读',
  files:{'SKILL.md':'# 合成技能\n\n仅用于合成安装测试。\n','skill.json':{schema:'skill@1',parsers:[]}},
});

test('activation is visible through global product discovery and a fresh registry, and disappears after deactivation',async t=>{
  const bed=await openPackTestbed({postgres});t.after(()=>bed.close());
  const published=await bed.publish(bed.alice,productPack());
  const registry=bed.registry,other=bed.second(),packs=createPacksPort(other);
  assert.deepEqual(await registry.activeProducts(),[]);
  await registry.activate(bed.admin,'widget');
  assert.equal(await registry.isActive('widget'),true);
  assert.deepEqual((await registry.activeProducts()).map(row=>row.info.digest),[published.version.digest]);
  assert.equal((await other.productNamed('Gadget'))?.info.digest,published.version.digest);
  assert.equal((await other.productWithId('widget'))?.info.digest,published.version.digest);
  assert.deepEqual((await packs.products()).map(row=>row.digest),[published.version.digest]);
  assert.equal((await packs.productByName('Widget'))?.digest,published.version.digest);
  assert.equal((await packs.productById('widget'))?.digest,published.version.digest);
  await withRequestPermissions(bed.kit.artifacts,bed.bob,async()=>{
    assert.equal((await other.activeProducts())[0]?.info.digest,published.version.digest);
    const batch=await bed.kit.authorizations.packsForMany!([WHOLE_HUB,bed.bob.id,'invalid-reader']);
    assert.deepEqual(batch.get(WHOLE_HUB),['widget']);
    assert.deepEqual(batch.get(bed.bob.id),[]);
    assert.deepEqual(batch.get('invalid-reader'),[]);
  });
  assert.equal((await createPackCatalog(other).list(bed.admin)).find(row=>row.id==='widget')?.active,true);
  await registry.deactivate(bed.admin,'widget');
  assert.equal(await other.isActive('widget'),false);
  assert.deepEqual(await other.activeProducts(),[]);
  assert.equal(await packs.productByName('Widget'),null);
  assert.deepEqual(await packs.products(),[]);
});

test('installation is read back at its bound version for members and a fresh registry, then disappears after uninstall',async t=>{
  const bed=await openPackTestbed({postgres});t.after(()=>bed.close());
  const first=await bed.publish(bed.alice,skill('1.0.0'));
  const registry=bed.registry,other=bed.second(),workflows=createWorkflowStore(other),catalog=createPackCatalog(other),packs=createPacksPort(other);
  const grant=await registry.install(bed.admin,'synthetic-global-skill@1.0.0');
  assert.equal(grant.body.bound,first.version.digest);
  assert.deepEqual((await registry.installedSkills()).map(row=>row.info.digest),[first.version.digest]);
  assert.deepEqual((await other.installedSkills()).map(row=>row.info.digest),[first.version.digest]);
  assert.equal((await workflows.skillForTools!(bed.bob,'synthetic-global-skill@1.0.0'))?.pack.digest,first.version.digest);
  assert.equal((await packs.pack('synthetic-global-skill@1.0.0'))?.digest,first.version.digest);
  await withRequestPermissions(bed.kit.artifacts,bed.bob,async()=>{
    assert.deepEqual((await other.installedSkills()).map(row=>row.info.digest),[first.version.digest]);
    assert.equal((await catalog.list(bed.bob)).find(row=>row.id==='synthetic-global-skill')?.digest,first.version.digest);
  });
  const second=await bed.publish(bed.alice,skill('1.1.0'));
  assert.deepEqual((await other.installedSkills()).map(row=>row.info.digest),[first.version.digest]);
  assert.equal(await workflows.skillForTools!(bed.bob,'synthetic-global-skill@1.1.0'),null);
  await registry.install(bed.admin,'synthetic-global-skill@1.1.0');
  assert.deepEqual((await other.installedSkills()).map(row=>row.info.digest),[second.version.digest]);
  assert.equal((await workflows.skillForTools!(bed.bob,'synthetic-global-skill@1.1.0'))?.pack.digest,second.version.digest);
  await registry.uninstall(bed.admin,'synthetic-global-skill');
  assert.deepEqual(await other.installedSkills(),[]);
  assert.equal(await workflows.skillForTools!(bed.bob,'synthetic-global-skill@1.1.0'),null);
  assert.equal(await packs.pack('synthetic-global-skill@1.1.0'),null);
  assert.equal((await catalog.list(bed.bob)).some(row=>row.id==='synthetic-global-skill'),false);
});
