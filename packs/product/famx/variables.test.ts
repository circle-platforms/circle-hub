// The actual product declarations feed the generic variable boundary; all values and reads are synthetic.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { ProductDeclaration } from '../../../contracts/src/product.ts';
import { BASE_CATALOG, DEFAULT_PRODUCERS, catalogXml, makeWorld, startPostgres } from '../../../hub/knowledge/test-support.ts';

const declaration=ProductDeclaration.parse(JSON.parse(readFileSync(new URL('./product.json',import.meta.url),'utf8')));
test('the three declared empty-default closed sets must be explicitly set before production and are frozen',async t=>{
  const names=['FAMX_COMPONENTS','FAMX_LICENSES','FAMX_DEPLOYMENT_FORMS'];
  const variables=declaration.variables!.filter(variable=>names.includes(variable.name));
  const params=Object.fromEntries(['components','licenses','deployment_forms'].map(key=>[key,declaration.producers.find(row=>row.id==='manual-famx')!.params![key]]));
  for(const producer of declaration.producers.filter(row=>row.id.startsWith('manual-')))for(const [key,value] of Object.entries(params))assert.equal(producer.params![key],value);
  assert.equal(variables.length,3);
  for(const variable of variables)assert.deepEqual(variable.default,[]);
  const pg=await startPostgres();t.after(()=>pg.stop());
  const w=await makeWorld(pg,{pack:{declaration:{variables,producers:DEFAULT_PRODUCERS.map(producer=>({...producer,params}))}}});t.after(()=>w.close());
  const build={name:'Synthetic_10_6_1',family:'ACME',line:'10.6',base:'Synthetic_10_6_1',platform:null,built_at:null,released_at:null,sources:{tree:'site:tree:synthetic-10.6'},root:null};
  const missing=await w.knowledge.produceTree({product:w.product,build});
  assert.equal(missing.ok,false);assert.equal(w.external.reads.length,0);
  for(const variable of variables)assert.ok(missing.reason?.includes(variable.name));
  for(const variable of variables)await w.kit.variables.setVariable(w.admin,variable.name,[],'合成空闭集设置');
  w.external.set(build.sources.tree,{bytes:catalogXml(BASE_CATALOG),mediaType:'application/xml'});
  const produced=await w.knowledge.produceTree({product:w.product,build});assert.equal(produced.ok,true,produced.reason??'');
  const page=await w.kit.store.list<any>({kind:'tree_root',limit:10});
  assert.ok(page.items.length);
  const frozen=page.items[0]!.body.variables as Array<{name:string;decision:string}>;
  assert.deepEqual(frozen.map(row=>row.name).sort(),variables.map(row=>row.name).sort());
  assert.ok(frozen.every(row=>/^[a-f0-9]{64}$/.test(row.decision)));
});

test('new closed-set declarations stay compact without reformatting the existing product declaration',()=>{
  const lines=readFileSync(new URL('./product.json',import.meta.url),'utf8').split('\n');
  for(const name of ['FAMX_COMPONENTS','FAMX_LICENSES','FAMX_DEPLOYMENT_FORMS']){
    const line=lines.find(row=>row.includes('"name": "'+name+'"'))!;
    assert.ok(line.includes('"schema":')&&line.includes('"default": []'),name);
  }
});
