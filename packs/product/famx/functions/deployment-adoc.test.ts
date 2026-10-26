import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {ProductDeclaration} from '../../../../contracts/src/product.ts';

test('each family has an independent manual producer with only its own variable references',()=>{
 const product=ProductDeclaration.parse(JSON.parse(readFileSync(new URL('../product.json',import.meta.url),'utf8')));
 for(const family of ['FAMX','FAMY']){
   const producer=product.producers.find(p=>p.id==='manual-'+family.toLowerCase());assert.ok(producer);
   assert.equal(producer.params?.root,'${var:'+family+'_ADOC_ROOT}');
   assert.equal(producer.params?.main,'${var:'+family+'_ADOC_MAIN}');
   assert.deepEqual(producer.params?.attributes,{[family]:'${var:FAMX_ADOC_ATTRIBUTES_'+family+'}'});
   assert.ok('source' in producer.inputs.files);assert.equal(producer.inputs.files.many,true);assert.equal(producer.inputs.files.batch,200);
   assert.deepEqual(product.variables?.find(v=>v.name==='FAMX_ADOC_ATTRIBUTES_'+family)?.default,{});
   assert.equal(product.variables?.find(v=>v.name===family+'_ADOC_ROOT')?.default,null);
 }
});
