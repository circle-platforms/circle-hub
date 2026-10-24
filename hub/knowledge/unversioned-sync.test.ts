import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { makeWorld, makeUnversionedWorld, startPostgres, DEFAULT_PRODUCERS, catalogXml, BASE_CATALOG } from './test-support.ts';
import { LINK_MATCH } from '../../contracts/generated/vocabulary.ts';
import { formatSyncReport } from './cli.ts';
import { pointerName } from './store.ts';
let pg: Awaited<ReturnType<typeof startPostgres>>;
before(async () => { pg = await startPostgres(); });
after(() => pg?.stop());
const build = { name: 'Synthetic_10_6', base: 'Synthetic_10_6', family: 'ACME', line: '10.6', platform: null, built_at: null, released_at: '2026-10-24T00:00:00.000Z', sources: { tree: 'site:tree:synthetic' } };
test('scope production isolates producers, preserves build bytes and reuses unchanged product-wide roots', async t => {
  const w = await makeWorld(pg, { pack: { functions: {
    'plan.ts': `export default () => ({fetch:[], builds:[${JSON.stringify(build)}], scope:{docs:'site:tree:scope'}, done:true});`,
    'scope.ts': `export default input => {if ('build' in input) throw Error('unexpected build'); return {entries:[{path:'/docs',kind:'definition',statement:JSON.stringify(input.slots.docs.model.root.attributes),data:{},fragments:[{slot:'docs',parser:'xml@1',selector:'x/catalog'}],applicability:null}],warnings:[]};}`,
  }, declaration: { producers: [...DEFAULT_PRODUCERS, {id:'docs',title:'文档',unversioned:true,function:{module:'functions/scope.ts'},inputs:{docs:{source:'docs'}}}] } } });
  t.after(() => w.close());
  w.external.set('site:tree:synthetic', {bytes:catalogXml(BASE_CATALOG),mediaType:'application/xml'});
  w.external.set('site:tree:scope', {bytes:'<catalog/>',mediaType:'application/xml'});
  const first = await w.knowledge.syncProduct(w.product);
  assert.equal(first.error,null);
  assert.match(formatSyncReport(first),/构建与不分版本：产出 2/);
  assert.match(formatSyncReport(first),/不分版本 \[产出\]：构建未声明/);
  assert.equal(first.scope?.outcome,'produced', JSON.stringify(first));
  const c = await w.knowledge.store.composition(first.scope!.composition!);
  assert.ok(c); assert.equal(c.version,null); assert.equal(c.build,null);
  assert.ok(c.sources.every(s => s.basis === 'declared' && s.decided_by === 'acme@1.0.0'));
  assert.equal(c.producer.producers.length,1);
  const again = await w.knowledge.syncProduct(w.product);
  assert.equal(again.scope?.outcome,'skipped');
  assert.equal(again.scope?.composition, first.scope?.composition);
  assert.equal(again.builds[0].composition, first.builds[0].composition);
  w.external.set('site:tree:scope',{bytes:'<catalog changed="yes"/>',mediaType:'application/xml'});
  const changed = await w.knowledge.syncProduct(w.product,{recheck:true});
  assert.equal(changed.scope?.outcome,'produced');
  assert.notEqual(changed.scope?.composition,first.scope?.composition);
  assert.equal(changed.builds[0].composition,first.builds[0].composition);
  assert.notEqual(pointerName('acme',null),pointerName('acme','unversioned'));
  assert.notEqual(pointerName('acme',null),pointerName('acme',''));
});

test('product-wide list batches omit build and memoize by their own source identity',async t=>{
 const w=await makeWorld(pg,{pack:{functions:{
  'plan.ts':`export default()=>({fetch:[],builds:[],scope:{docs:['site:tree:one','site:tree:two']},done:true});`,
  'docs.ts':`export default input=>{if('build' in input)throw Error('unexpected build');return {entries:input.lists.docs.map(source=>({path:'/docs/'+source.model.root.attributes.id,kind:'case',statement:source.model.root.attributes.id,data:{document:source.model.root.attributes.id},applicability:null,fragments:[{slot:'docs',source:source.sha256,parser:'xml@1',selector:'x/catalog'}]})),warnings:[]};};`,
 },declaration:{catalogs:[],producers:[{id:'docs',title:'文档',unversioned:true,function:{module:'functions/docs.ts'},inputs:{docs:{source:'docs',many:true,batch:1}}}]}}});t.after(()=>w.close());
 for(const id of ['one','two'])w.external.set('site:tree:'+id,{bytes:`<catalog id="${id}"/>`,mediaType:'application/xml'});
 const first=await w.knowledge.syncProduct(w.product);assert.equal(first.scope?.outcome,'produced',JSON.stringify(first));
 assert.equal(first.scope.calls?.made,2);assert.equal(first.builds.length,0);
 const body=(await w.knowledge.store.composition(first.scope.composition!))!;assert.equal(body.counts.entries,2);assert.ok(body.sources.every(s=>s.basis==='declared'));
 const again=await w.knowledge.syncProduct(w.product,{recheck:true});assert.equal(again.scope?.outcome,'skipped');assert.equal(again.scope.composition,first.scope.composition);
});

test('product-wide roots retain valid link declarations and exclude inactive producer catalogs',async t=>{
 const w=await makeUnversionedWorld(pg);t.after(()=>w.close());
 w.product.product.links=[{id:'mentions',field:'mentions',namespace:'/commands',match:LINK_MATCH[0],entry_kind:'definition',source_producers:['commands'],target_producers:['commands']}];
 w.product.digest='f'.repeat(64);
 const report=await w.knowledge.syncProduct(w.product);
 assert.equal(report.scope?.outcome,'produced',JSON.stringify(report));
 const body=(await w.knowledge.store.composition(report.scope.composition!))!;
 assert.deepEqual(body.catalogs,[]);
 assert.equal(await w.knowledge.catalog(report.scope.root!,'catalog@1'),null);
 assert.equal(body.links?.[0].id,'mentions');
 const main=(await w.knowledge.rootOfBuild('acme','Synthetic_10_6'))!;
 assert.equal((await w.knowledge.catalog(main.root,'catalog@1'))?.complete,true);
});
