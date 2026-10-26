import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
test('model and platform applicability vocabularies are empty-default deployment variables forwarded to both manual families',async()=>{
 const product=JSON.parse(await readFile(new URL('../product.json',import.meta.url),'utf8'));
 for(const [name,parameter] of [['FAMX_MODELS','models'],['FAMX_PLATFORMS','platforms']]){
  const variable=product.variables.find((row:any)=>row.name===name);assert.ok(variable,name);assert.deepEqual(variable.default,[]);assert.equal(variable.schema.type,'array');
  for(const id of ['manual-famx','manual-famy'])assert.equal(product.producers.find((row:any)=>row.id===id).params[parameter],'${var:'+name+'}');
 }
 assert.ok(!product.variables.some((row:any)=>row.name==='FAMX_APPLICABILITY_BUILDS'));
});
