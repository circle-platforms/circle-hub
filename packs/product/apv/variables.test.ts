// The actual product declarations feed the generic variable boundary; all values and reads are synthetic.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { ProductDeclaration } from '../../../contracts/src/product.ts';
import { BASE_CATALOG, DEFAULT_PRODUCERS, catalogXml, makeWorld, startPostgres } from '../../../hub/knowledge/test-support.ts';

const declaration=ProductDeclaration.parse(JSON.parse(readFileSync(new URL('./product.json',import.meta.url),'utf8')));
test('the three declared empty-default closed sets must be explicitly set before production and are frozen',async t=>{
  const params=declaration.producers.find(row=>row.id==='manual')!.params!;
  assert.deepEqual(Object.keys(params).sort(),['components','deployment_forms','licenses']);
  assert.equal(declaration.variables!.length,3);
  for(const variable of declaration.variables!)assert.deepEqual(variable.default,[]);
  const pg=await startPostgres();t.after(()=>pg.stop());
  const w=await makeWorld(pg,{pack:{declaration:{variables:declaration.variables,producers:DEFAULT_PRODUCERS.map(producer=>({...producer,params}))}}});t.after(()=>w.close());
  const build={name:'Synthetic_10_6_1',family:'ACME',line:'10.6',base:'Synthetic_10_6_1',platform:null,built_at:null,released_at:null,sources:{tree:'site:tree:synthetic-10.6'},root:null};
  const missing=await w.knowledge.produceTree({product:w.product,build});
  assert.equal(missing.ok,false);assert.equal(w.external.reads.length,0);
  for(const variable of declaration.variables!)assert.ok(missing.reason?.includes(variable.name));
  for(const variable of declaration.variables!)await w.kit.variables.setVariable(w.admin,variable.name,[],'合成空闭集设置');
  w.external.set(build.sources.tree,{bytes:catalogXml(BASE_CATALOG),mediaType:'application/xml'});
  const produced=await w.knowledge.produceTree({product:w.product,build});assert.equal(produced.ok,true,produced.reason??'');
  const page=await w.kit.store.list<any>({kind:'tree_root',limit:10});
  assert.ok(page.items.length);
  const frozen=page.items[0]!.body.variables as Array<{name:string;decision:string}>;
  assert.deepEqual(frozen.map(row=>row.name).sort(),declaration.variables!.map(row=>row.name).sort());
  assert.ok(frozen.every(row=>/^[a-f0-9]{64}$/.test(row.decision)));
});
