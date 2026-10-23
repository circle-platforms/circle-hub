import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { openHarness, type Harness } from './testing/harness.ts';
import { startPostgres } from '../../testing/postgres.ts';
import { scopeProblem, buildScope } from './exact.ts';
import { toyMap, standardDocument, ITEM } from './testing/mindmap.ts';
import { parseReference } from '../../refs/api.ts';
let pg: Awaited<ReturnType<typeof startPostgres>>;
let h: Harness;
before(async () => {pg = await startPostgres();h = await openHarness(pg,{dataQuotes:true});
 const builds=h.knowledge.builds.bind(h.knowledge),resolve=h.knowledge.resolveBuild.bind(h.knowledge);
 h.knowledge.builds=async product => (await builds(product)).map(b=>({...b,line:'10.6'}));
 h.knowledge.resolveBuild=async (product,name) => {const b=await resolve(product,name);return b?{...b,line:'10.6'}:null;};
 const trees=h.knowledge.treeReader.bind(h.knowledge);
 h.knowledge.treeReader=()=>({...trees(),read:(r,p,e,u)=>r===root?{text:'合成用例',mediaType:'text/plain',readTier:'model_readable',grounds:[]}:trees().read(r,p,e,u)});});
after(async () => {await h?.close();await pg?.stop();});
const root = 'b'.repeat(64), composition = 'c'.repeat(64);
test('start locks the product-wide root and boundary accepts exactly the locked root set', async () => {
  const map = await h.upload(h.alice,toyMap(standardDocument()),'application/json');
  Object.assign(h.knowledge,{unversionedRoot:async () => ({root,composition,product:'meadow',build:null,source_count:0,produced_at:'2026-10-24T00:00:00.000Z'})});
  const answer = await h.service.startRun(h.alice,{pack:'toy-review',product:'Meadow',version:'10.6',inputs:{map:{reference:map}}},h.call());
  assert.ok(answer.run,JSON.stringify(answer.errors));
  assert.equal(answer.run.unversioned_root,root);
  const basis = answer.run.target_basis.find(c => c.statement.data?.field === 'unversioned_root');
  assert.equal(basis?.qualifier.provenance,'projected');
  assert.equal(basis?.statement.data?.composition,composition);
  // The public scope builder uses the persisted lock rather than the moving pointer.
  const scope = await buildScope({deps:{knowledge:h.knowledge,records:h.kit}} as never, answer.run as never,h.review,h.alice,'function');
  assert.equal(scopeProblem(parseReference(`tree:${root}/docs`),scope),null);
  assert.match(scopeProblem(parseReference(`tree:${'d'.repeat(64)}/docs`),scope)!,/锁定/);
  const submitted = await h.service.submitResult(h.alice,{
    run:answer.run.run,model:'synthetic@1',items:answer.run.items.map(item=>({item:item.id,handling:'handled',context:'f'.repeat(64),slots:{findings:item.id===ITEM.c1?[{text:'合成发现',code:'edge_case_gap',rank:'major',quotes:[{reference:`tree:${root}/docs`,text:'合成用例'}],data:{expected_quote:{reference:`tree:${root}/docs`,text:'合成用例'}}}]:[]}})),
    cross_item:[{nature:'judgment',statement:'一般',grounds:[],code:'draft_level',rank:'P4'}],
  },h.call());
  assert.equal(submitted.acceptance,'accepted',JSON.stringify(submitted.errors));
  assert.equal(submitted.result?.locks.unversioned_root,root);
  const findings=Object.values(submitted.result!.partitions).flat().find(i=>i.item===ITEM.c1)!.requirements.find(r=>r.requirement==='findings')!;
  assert.equal(findings.claims.filter(c=>c.statement.verdict==='support'&&c.statement.text.includes('逐字一致')).length,2,JSON.stringify(findings));
  const successor = await h.service.startRun(h.alice,{pack:'toy-review',product:'Meadow',version:'10.6',inputs:{map:{reference:map}},predecessor:answer.run.run},h.call());
  assert.ok(successor.run);
  assert.ok(successor.run.items.find(i=>i.id===ITEM.c1)?.reuse,'unchanged product-wide evidence is reusable');
  Object.assign(h.knowledge,{unversionedRoot:async () => ({root:'e'.repeat(64),composition:'d'.repeat(64),product:'meadow',build:null,source_count:0,produced_at:'2026-10-24T00:00:00.000Z'})});
  const changed = await h.service.startRun(h.alice,{pack:'toy-review',product:'Meadow',version:'10.6',inputs:{map:{reference:map}},predecessor:answer.run.run},h.call());
  assert.ok(changed.run);assert.notEqual(changed.run.run,answer.run.run);
  assert.equal(changed.run.unversioned_root,'e'.repeat(64));
  assert.ok(changed.run.items.every(i=>i.reuse===undefined));
  Object.assign(h.knowledge,{unversionedRoot:async () => null});
  const absent = await h.service.startRun(h.alice,{pack:'toy-review',product:'Meadow',version:'10.6',inputs:{map:{reference:map}}},h.call());
  assert.ok(absent.run);
  assert.equal(absent.run.unversioned_root,undefined);
  assert.match(JSON.stringify(absent.run.target_basis),/这条产品线还没有不分版本的根/);
  assert.match(JSON.stringify(absent.run.target_basis),/同步这条产品线/);
});
