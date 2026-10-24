import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {ProductDeclaration} from '../../../contracts/src/product.ts';
import {createKnowledge} from '../../../hub/knowledge/api.ts';
import {FakeExternal,FakePacks} from '../../../hub/knowledge/test-support.ts';
import {createDefaultRegistry} from '../../../hub/refs/api.ts';
import {osIsolationAvailable} from '../../../hub/rules/api.ts';
import {startPostgres} from '../../../hub/testing/postgres.ts';
import {openTestRecords} from '../../../hub/testing/records.ts';
import type {ProductHandle} from '../../../hub/ports.ts';

test('APV synchronizes specifications into an immutable product-wide root without a build',async t=>{
 const pg=await startPostgres();t.after(()=>pg.stop());const kit=await openTestRecords({postgres:pg});t.after(()=>kit.close());
 const admin=(await kit.principals.bootstrapAdmin('合成管理员')).user;
 const product=ProductDeclaration.parse(JSON.parse(readFileSync(new URL('./product.json',import.meta.url),'utf8')));
 for(const variable of product.variables??[])await kit.variables.setVariable(admin,variable.name,variable.default,'合成部署设置');
 class Source extends FakeExternal{override async accepts(id:string){return id.startsWith('manual:')||id.startsWith('buildsite:')||super.accepts(id);}}
 const external=new Source(kit),packs=new FakePacks();
 const manifest=JSON.parse(readFileSync(new URL('./pack.json',import.meta.url),'utf8'));
 const handle:ProductHandle={id:'apv',kind:'product',version:manifest.version,digest:'b'.repeat(64),directory:fileURLToPath(new URL('./',import.meta.url)),product};packs.add(handle);
 external.set('buildsite:listing:index',{bytes:'<html><body>没有构建的合成索引</body></html>',mediaType:'text/html'});
 external.set('manual:spec-list:configured',{bytes:JSON.stringify({complete:true,folders:['spec'],files:[{name:'APV-10_7.md',path:'spec/APV-10_7.md'},{name:'Other.md',path:'spec/Other.md'}]}),mediaType:'application/json'});
 external.set('manual:file:spec/APV-10_7.md',{bytes:'# Synthetic section\n\n仅 APV 支持。执行 `demo pool add`。',mediaType:'text/markdown'});
 const knowledge=createKnowledge({records:kit,parsers:createDefaultRegistry(),packs,external,jev:null,admin,sandbox:{requireOsIsolation:await osIsolationAvailable()}});
 const first=await knowledge.syncProduct(handle,{by:admin,options:{case_index:false}});
 assert.equal(first.scope?.outcome,'produced',JSON.stringify(first));assert.ok(first.scope?.root);assert.ok(first.scope?.composition);
 const root=await knowledge.unversionedRoot!('apv');assert.equal(root?.build,null);
 assert.ok(!external.reads.includes('manual:file:spec/Other.md'));
 assert.match(first.plan.note??'',/不属于这条产品线 1/);
 const second=await knowledge.syncProduct(handle,{by:admin,options:{case_index:false}});
 assert.equal(second.scope?.root,first.scope.root);assert.equal(second.scope?.composition,first.scope.composition);assert.equal(second.scope?.outcome,'skipped');
});
