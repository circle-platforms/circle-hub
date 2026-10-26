// Actual FAMX producer modules, Hub production, real temporary PostgreSQL; only synthetic source bytes.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {test} from 'node:test';
import {ProductDeclaration,type KnownBuild} from '../../../../contracts/src/product.ts';
import {createKnowledge,createKnowledgeReader} from '../../../../hub/knowledge/api.ts';
import {FakeExternal,FakePacks} from '../../../../hub/knowledge/test-support.ts';
import {createDefaultRegistry} from '../../../../hub/refs/api.ts';
import {osIsolationAvailable} from '../../../../hub/rules/api.ts';
import {startPostgres} from '../../../../hub/testing/postgres.ts';
import {openTestRecords} from '../../../../hub/testing/records.ts';
import type {ProductHandle} from '../../../../hub/ports.ts';
class External extends FakeExternal {override async accepts(id:string){return await super.accepts(id)||id.startsWith('manual:');}}
for(const format of ['html','json'])test('missing '+format+' release status preserves the command/manual root and declares the defect unknown',async t=>{
 const postgres=await startPostgres();t.after(()=>postgres.stop());const kit=await openTestRecords({postgres});t.after(()=>kit.close());const {user:admin}=await kit.principals.bootstrapAdmin('合成管理员');
 const directory=fileURLToPath(new URL('..',import.meta.url)),bytes=readFileSync(new URL('../pack.json',import.meta.url));const manifest=JSON.parse(bytes.toString()),product=ProductDeclaration.parse(JSON.parse(readFileSync(new URL('../product.json',import.meta.url),'utf8')));
 for(const variable of product.variables??[])await kit.variables.setVariable(admin,variable.name,variable.default,'合成声明');
 const handle:ProductHandle={id:'famx',version:manifest.version,digest:createHash('sha256').update(bytes).digest('hex'),kind:'product',directory,product};const packs=new FakePacks();packs.add(handle);const external=new External(kit);
 external.set('site:tree:synthetic',{bytes:'<commands><scope type="global"><menu name="synthetic"><item name="show"><arguments></arguments></item></menu></scope></commands>',mediaType:'application/xml'});
 external.set('manual:cli:10.8.9',{bytes:'# 合成手册\n\n这是独立的合成手册原文。',mediaType:'text/markdown'});
 const knowledge=createKnowledge({records:kit,parsers:createDefaultRegistry(),packs,external,jev:null,sandbox:{requireOsIsolation:await osIsolationAvailable()},admin});
 const build:KnownBuild={name:format==='html'?'Rel_FAMX_10_8_9_42_main_zx-u':'Rel_FAMX_10_8_9_43_main_zx-u',family:'FAMX',line:'10.8.9',base:format==='html'?'Rel_FAMX_10_8_9_42_main_zx-u':'Rel_FAMX_10_8_9_43_main_zx-u',platform:null,built_at:'2026-01-01T00:00:00.000Z',released_at:null,sources:{tree:'site:tree:synthetic'},root:null};
 const before=await knowledge.produceTree({product:handle,build,by:admin});assert.equal(before.ok,true,JSON.stringify(before));
 const subtree=async(root:string,name:string)=>(await knowledge.store.node(root))?.children.find(child=>child.name===name)?.digest;
 const commands=await subtree(before.root!,'commands'),manual=await subtree(before.root!,'manual');assert.ok(commands);assert.ok(manual);
 external.set('site:notes:synthetic',{bytes:format==='html'?'<html><body><a href="https://tracker.example.invalid/index.php?m=bug&amp;f=view&amp;id=SYN-1">看似已经修复的合成文字</a></body></html>':JSON.stringify({schema:'release-notes@2',complete:true,product:'FAMX',build:build.name,defects:[{bug:'SYN-1',text:'看似已经修复的合成文字'}]}),mediaType:format==='html'?'text/html':'application/json'});
 const after=await knowledge.produceTree({product:handle,build:{...build,sources:{...build.sources,fixed_bugs:'site:notes:synthetic'}},by:admin});assert.equal(after.ok,true,JSON.stringify(after));assert.ok(after.root);const currentCommands=await subtree(after.root,'commands'),currentManual=await subtree(after.root,'manual');assert.ok(currentCommands);assert.ok(currentManual);assert.deepEqual((await knowledge.store.node(currentCommands))!.children.map(child=>child.name),(await knowledge.store.node(commands))!.children.map(child=>child.name));assert.deepEqual((await knowledge.store.node(currentManual))!.children.map(child=>child.name),(await knowledge.store.node(manual))!.children.map(child=>child.name));let node=await knowledge.store.node(currentCommands);for(const name of ['synthetic','show']){const child=node!.children.find(child=>child.name===name);assert.ok(child);node=await knowledge.store.node(child.digest);}assert.ok(node!.entries.length>0);
 const read=await createKnowledgeReader(knowledge).read(`knowledge:index:famx:${build.name}?kind=defect&key=bug`,{principal:admin,run:null,purpose:'合成状态缺口验收'});assert.ok(read.ok,JSON.stringify(read));const original=read.artifacts.find(artifact=>artifact.name==='original')!;const stored=await kit.artifacts.source(admin,original.artifact.body.sha256,{consumer:'function'});assert.ok(stored?.bytes);const view=JSON.parse(Buffer.from(stored.bytes).toString());const entries=Object.values(view.entries) as Array<{data:Record<string,unknown>}>;assert.equal(entries.length,1);assert.equal(entries[0].data.bug,'SYN-1');assert.equal(entries[0].data.status,null);assert.equal(entries[0].data.declaration_status,'undeclared');assert.ok(entries[0].data.missing);assert.ok(entries[0].data.next_action);
});
