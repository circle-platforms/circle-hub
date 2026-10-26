import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { makeUnversionedWorld, startPostgres } from './test-support.ts';
let pg: Awaited<ReturnType<typeof startPostgres>>;
before(async () => {pg = await startPostgres();});
after(() => pg?.stop());
test('product-wide roots use product permissions, their own pointer and undeclared build provenance', async t => {
  const w = await makeUnversionedWorld(pg); t.after(() => w.close());
  const info = await w.knowledge.unversionedRoot?.('acme'); assert.ok(info);
  assert.equal(info.build,null);
  assert.equal(await w.knowledge.unversionedRoot?.('absent'),null);
  const page = await w.knowledge.getNodes({root:info.root,paths:['/docs'],depth:0},w.user);
  assert.ok(page);
  assert.equal(await w.knowledge.getNodes({root:info.root,paths:['/docs'],depth:0},w.outsider),null);
  assert.equal(await w.knowledge.getNodes({root:'f'.repeat(64),paths:['/docs'],depth:0},w.outsider),null);
  const provenance = await w.knowledge.provenanceOf(`tree:${info.root}/docs`,w.user);
  assert.ok(provenance?.length); assert.equal(provenance[0].build,'未声明');
  const reader = w.knowledge.treeReader();
  const entry = await reader.read(info.root,'/docs',null,{user:w.user.id,role:w.user.role});
  assert.ok(entry); assert.match(JSON.stringify(entry),/未声明/);
});

test('contribution admission accepts the locked product-wide composition and refuses a third root', async t => {
  const w = await makeUnversionedWorld(pg); t.after(() => w.close());
  const scope = (await w.knowledge.unversionedRoot!('acme'))!;
  const version = (await w.knowledge.currentRoot('acme','10.6'))!;
  const body = (await w.knowledge.store.composition(scope.composition))!;
  const reference = `src:${body.sources[0].sha256}`;
  const input = {kind:'assertion',statement:'合成文档的说明',root:scope.root,path:'/docs',source:{reference,quote:'<catalog/>'}};
  const locked = {root:version.root,product:'acme',composition:version.composition,additionalRoots:[{root:scope.root,composition:scope.composition}],resolve:async () => ({ok:true as const,value:{reference,text:'<catalog/>'}})};
  const prepared = await w.knowledge.layers.contributions.prepare(w.admin,input,locked);
  assert.equal(prepared.root,scope.root);
  const intoBuild = await w.knowledge.layers.contributions.prepare(w.admin,{...input,root:version.root,path:'/commands/net/ping'},locked);
  assert.equal(intoBuild.root,version.root);
  const treeReference=`tree:${scope.root}/docs`;
  const treeSource=await w.knowledge.layers.contributions.prepare(w.admin,{...input,root:version.root,path:'/commands/net/ping',source:{reference:treeReference,quote:'合成用例'}},{...locked,resolve:async()=>({ok:true as const,value:{reference:treeReference,text:'合成用例'}})});
  assert.equal(treeSource.source.reference,treeReference);
  await assert.rejects(w.knowledge.layers.contributions.prepare(w.admin,{...input,root:'d'.repeat(64)},locked),/锁定/);
});
