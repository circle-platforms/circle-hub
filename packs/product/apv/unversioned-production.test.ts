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
 class Source extends FakeExternal{override async accepts(id:string){return id.startsWith('agile:')||id.startsWith('manual:')||id.startsWith('buildsite:')||super.accepts(id);}}
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
 const documents=[{id:'83001',root:'root',ancestors:['APV','未定版本']},{id:'83002',root:'root',ancestors:['APV','10.8','10.8-main-2026/3']}];
 external.set('agile:tree:roots',{bytes:JSON.stringify({complete:true,roots:[{id:'root',title:'APV'}],documents}),mediaType:'application/json'});
 for(const doc of documents)external.set('agile:case:'+doc.id,{bytes:JSON.stringify({root:{data:{id:'root',text:'合成文档'},children:[{data:{id:'synthetic-case',text:'验证 `demo pool  add`',resource:['Functional']}}]}}),mediaType:'application/json'});
 const combined=await knowledge.syncProduct(handle,{by:admin,options:{case_index:true,min_line:null}});
 assert.equal(combined.scope?.outcome,'produced',JSON.stringify(combined));assert.ok(combined.scope?.root);
 assert.match(combined.plan.note??'',/没有版本线 1.*没有覆盖构建 1/);
 assert.equal(combined.scope.unplaced,2);
 const composition=(await kit.store.get(combined.scope.composition!))!.body as {unplaced:Array<{entry:string}>};
 assert.equal(composition.unplaced.length,2);
 for(const row of composition.unplaced){
  const entry=await knowledge.treeReader({compositions:[combined.scope.composition!]}).read(combined.scope.root,'/',row.entry,{user:admin.id,role:admin.role});
  assert.ok(entry);assert.ok(JSON.stringify(entry).includes('demo pool  add'));
 }
 const repeat=await knowledge.syncProduct(handle,{by:admin,options:{case_index:true,min_line:null}});
 assert.equal(repeat.scope?.root,combined.scope.root);assert.equal(repeat.scope?.composition,combined.scope.composition);assert.equal(repeat.scope?.outcome,'skipped');
 external.set('manual:spec-list:configured',{bytes:JSON.stringify({complete:true,folders:['spec'],files:[{name:'Other.md',path:'spec/Other.md'}]}),mediaType:'application/json'});
 external.set('agile:tree:roots',{bytes:JSON.stringify({complete:true,roots:[{id:'root',title:'APV'}],documents:[]}),mediaType:'application/json'});
 const empty=await knowledge.syncProduct(handle,{by:admin,recheck:true,options:{case_index:true,min_line:null}});
 const note='不分版本的根为空（清单完整，规格 0 份、未覆盖用例 0 份）';assert.equal(empty.scope?.outcome,'produced',JSON.stringify(empty));assert.equal(empty.counts.failed,0);assert.ok(empty.scope?.reason.includes(note));
 const body:any=(await kit.store.get(empty.scope!.composition!))!.body;
 assert.deepEqual(body.empty_scope.sources.map((row:any)=>[row.label,row.total,row.selected]),[['规格',1,0],['未覆盖用例',0,0]]);
 const emptyRead=await knowledge.getNodes({root:empty.scope!.root!,paths:['/'],depth:0},admin);assert.deepEqual(emptyRead?.nodes,[]);assert.equal(emptyRead?.coverage.note,note);
});
