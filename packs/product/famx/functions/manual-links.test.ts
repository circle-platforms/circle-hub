// The actual product producer and the generic reader use one frozen declaration, including literals beyond the former cap.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { after,before,test } from 'node:test';
import { ProductDeclaration, type KnownBuild } from '../../../../contracts/src/product.ts';
import { LinksView } from '../../../../contracts/src/views.ts';
import { createKnowledge,createKnowledgeReader,type Knowledge } from '../../../../hub/knowledge/api.ts';
import { FakeExternal,FakePacks } from '../../../../hub/knowledge/test-support.ts';
import { createDefaultRegistry } from '../../../../hub/refs/api.ts';
import { osIsolationAvailable } from '../../../../hub/rules/api.ts';
import { openTestRecords,type TestRecordsKit } from '../../../../hub/testing/records.ts';
import { startPostgres,type TemporaryPostgres } from '../../../../hub/testing/postgres.ts';
import type { ProductHandle } from '../../../../hub/ports.ts';
let postgres:TemporaryPostgres;
before(async()=>{postgres=await startPostgres();});after(async()=>{await postgres?.stop();});
class Manuals extends FakeExternal{override async accepts(id:string){return id.startsWith('manual:')||super.accepts(id);}}
const tree='<commands><scope type="global"><menu name="demo"><menu name="pool"><item name="add"><arguments><arg name="value" type="STRING"/></arguments></item></menu></menu></scope></commands>';
test('production and paged reading agree on all 150 drift literals, while ordinary trailing arguments link',async t=>{
  const kit=await openTestRecords({postgres});t.after(()=>kit.close());const admin=(await kit.principals.bootstrapAdmin('合成管理员')).user;
  const external=new Manuals(kit),packs=new FakePacks(),directory=fileURLToPath(new URL('../',import.meta.url));
  const product=ProductDeclaration.parse(JSON.parse(readFileSync(new URL('../product.json',import.meta.url),'utf8')));
  for(const variable of product.variables??[])await kit.variables.setVariable(admin,variable.name,variable.default,'合成关系测试显式部署设置');
  const handle:ProductHandle={id:'famx',version:JSON.parse(readFileSync(new URL('../pack.json',import.meta.url),'utf8')).version,digest:createHash('sha256').update(readFileSync(new URL('../pack.json',import.meta.url))).digest('hex'),kind:'product',directory,product};packs.add(handle);
  const literals=Array.from({length:150},(_,i)=>`demo missing${i}`);
  const manual=['# 合成章节','', '正文提及 `demo pool add` 与 `demo pool add HostName`。', '', '```', 'demo pool add HostName', ...literals, '```'].join('\n');
  external.set('site:tree:links',{bytes:tree,mediaType:'application/xml'});external.set('manual:cli:10.8.1',{bytes:manual,mediaType:'text/markdown'});
  const knowledge=createKnowledge({records:kit,parsers:createDefaultRegistry(),packs,external,jev:null,admin,sandbox:{requireOsIsolation:await osIsolationAvailable()}});
  const build:KnownBuild={name:'Rel_FAMX_10_8_1_99',family:'FAMX',line:'10.8.1',base:'Rel_FAMX_10_8_1_99',platform:null,built_at:null,released_at:null,sources:{tree:'site:tree:links'},root:null};
  const produced=await knowledge.produceTree({product:handle,build,by:admin});assert.ok(produced.ok,produced.reason??'');
  const warning=produced.warnings.find(text=>text.startsWith('链接声明 manual-literals'));
  assert.ok(warning);assert.match(warning,/有 150 个字面/);assert.ok(!warning.includes('HostName'));
  const reader=createKnowledgeReader(knowledge),drift:string[]=[];let cursor:string|null=null,linked=0,pages=0;
  do{
    const result=await reader.read('knowledge:links:famx:10.8.1?limit=20'+(cursor?'&cursor='+cursor:''),{principal:admin,run:null,purpose:'synthetic',composition:produced.composition});assert.ok(result.ok,result.ok?'':result.reason);
    const bytes=await kit.objects.get(result.artifacts[0].artifact.body.sha256);assert.ok(bytes);
    const view=LinksView.parse(JSON.parse(Buffer.from(bytes).toString('utf8')));assert.equal(view.totals?.drift_literals,150);assert.equal(view.totals?.links,2);
    drift.push(...view.drift.map(group=>group.literal));linked+=view.links.length;cursor=view.next;pages++;
  }while(cursor);
  assert.ok(pages>1);assert.equal(linked,2);assert.deepEqual(drift.sort(),literals.sort());
});


test('declared signature matching rejects extending signatures and retains positive no variants',async()=>{
  const {produceManualEntries}=await import('./manual.ts');
  const {commandCatalog}=await import('./cases-commands.ts');
  const {manualRelations}=await import('../testing/relations.ts');
  const {markdown,xml}=await import('../testing/test-support.ts');
  const catalog=commandCatalog(xml(tree)).catalog;
  const result=produceManualEntries(markdown('```\ndemo pool add extra HostName\n```\n\n| command_signature@2 |\n|---|\n| **[no] demo pool add** *\\<name\\>* |\n'),null,{catalog});
  const facts=manualRelations(result,catalog);
  assert.deepEqual(facts.drift.map(group=>group.literal),['demo pool add extra HostName']);
  assert.deepEqual(facts.links.map(link=>link.literal),['demo pool add']);
});

test('the fixed manual fixture has identical declared production drift and paged read drift',async t=>{
  const {fixtureBytes}=await import('../testing/test-support.ts');
  const kit=await openTestRecords({postgres});t.after(()=>kit.close());const admin=(await kit.principals.bootstrapAdmin('合成管理员')).user;
  const external=new Manuals(kit),packs=new FakePacks(),directory=fileURLToPath(new URL('../',import.meta.url));
  const product=ProductDeclaration.parse(JSON.parse(readFileSync(new URL('../product.json',import.meta.url),'utf8')));
  for(const variable of product.variables??[])await kit.variables.setVariable(admin,variable.name,variable.default,'合成关系测试显式部署设置');
  const handle:ProductHandle={id:'famx',version:JSON.parse(readFileSync(new URL('../pack.json',import.meta.url),'utf8')).version,digest:createHash('sha256').update(readFileSync(new URL('../pack.json',import.meta.url))).digest('hex'),kind:'product',directory,product};packs.add(handle);
  external.set('site:tree:links',{bytes:fixtureBytes('command-tree.xml'),mediaType:'application/xml'});external.set('manual:cli:10.8.1',{bytes:fixtureBytes('manual.md'),mediaType:'text/markdown'});
  const knowledge=createKnowledge({records:kit,parsers:createDefaultRegistry(),packs,external,jev:null,admin,sandbox:{requireOsIsolation:await osIsolationAvailable()}});
  const build:KnownBuild={name:'Rel_FAMX_10_8_1_99',family:'FAMX',line:'10.8.1',base:'Rel_FAMX_10_8_1_99',platform:null,built_at:null,released_at:null,sources:{tree:'site:tree:links'},root:null};
  const produced=await knowledge.produceTree({product:handle,build,by:admin});assert.ok(produced.ok,produced.reason??'');
  assert.deepEqual(produced.warnings.filter(warning=>warning.startsWith('链接声明 ')),[
    '链接声明 manual-literals：有 1 个字面在此根没有可匹配目标（漂移事实）：Box(config)#demo route static 192.0.2.0 255.255.255.0 192.0.2.1 permanent',
  ]);
  const reader=createKnowledgeReader(knowledge),drift:string[][]=[];let cursor:string|null=null;
  do{
    const id='knowledge:links:famx:10.8.1?limit=3'+(cursor?'&cursor='+cursor:'');
    const result=await reader.read(id,{principal:admin,run:null,purpose:'synthetic',composition:produced.composition});assert.ok(result.ok,result.ok?'':result.reason);
    const bytes=await kit.objects.get(result.artifacts[0].artifact.body.sha256);assert.ok(bytes);
    const again=await reader.read(id,{principal:admin,run:null,purpose:'synthetic',composition:produced.composition});assert.ok(again.ok);assert.equal(result.artifacts[0].artifact.body.sha256,again.artifacts[0].artifact.body.sha256);
    const view=LinksView.parse(JSON.parse(Buffer.from(bytes).toString('utf8')));assert.equal(view.totals?.drift_literals,1);
    drift.push(...view.drift.map(group=>[group.rule,group.literal]));cursor=view.next;
  }while(cursor);
  assert.deepEqual([...new Map(drift.map(pair=>[JSON.stringify(pair),pair])).values()],[['manual-literals','Box(config)#demo route static 192.0.2.0 255.255.255.0 192.0.2.1 permanent']]);
});

test('an HTML tree source leaves manual literals unchecked in both production and the read view',async t=>{
  const kit=await openTestRecords({postgres});t.after(()=>kit.close());const admin=(await kit.principals.bootstrapAdmin('合成管理员')).user;
  const external=new Manuals(kit),packs=new FakePacks(),directory=fileURLToPath(new URL('../',import.meta.url));
  const product=ProductDeclaration.parse(JSON.parse(readFileSync(new URL('../product.json',import.meta.url),'utf8')));
  for(const variable of product.variables??[])await kit.variables.setVariable(admin,variable.name,variable.default,'合成关系测试显式部署设置');
  const handle:ProductHandle={id:'famx',version:JSON.parse(readFileSync(new URL('../pack.json',import.meta.url),'utf8')).version,digest:createHash('sha256').update(readFileSync(new URL('../pack.json',import.meta.url))).digest('hex'),kind:'product',directory,product};packs.add(handle);
  external.set('site:tree:links',{bytes:'<html><body>synthetic unavailable tree</body></html>',mediaType:'text/html'});
  external.set('manual:cli:10.8.1',{bytes:'**demo pool add** *<name>*\n\n参考 `demo pool create` 和 `demo probe`。\n',mediaType:'text/markdown'});
  const knowledge=createKnowledge({records:kit,parsers:createDefaultRegistry(),packs,external,jev:null,admin,sandbox:{requireOsIsolation:await osIsolationAvailable()}});
  const build:KnownBuild={name:'Rel_FAMX_10_8_1_99',family:'FAMX',line:'10.8.1',base:'Rel_FAMX_10_8_1_99',platform:null,built_at:null,released_at:null,sources:{tree:'site:tree:links'},root:null};
  const produced=await knowledge.produceTree({product:handle,build,by:admin});assert.ok(produced.ok,produced.reason??'');
  assert.ok(!produced.warnings.some(warning=>warning.includes('漂移事实')),produced.warnings.join('\n'));
  const reader=createKnowledgeReader(knowledge),result=await reader.read('knowledge:links:famx:10.8.1',{principal:admin,run:null,purpose:'synthetic',composition:produced.composition});assert.ok(result.ok,result.ok?'':result.reason);
  const bytes=await kit.objects.get(result.artifacts[0].artifact.body.sha256);assert.ok(bytes);const view=LinksView.parse(JSON.parse(Buffer.from(bytes).toString('utf8')));
  assert.deepEqual(view.drift,[]);assert.equal(view.totals?.unchecked_literals,3);assert.equal(view.rule_diagnostics?.length,3);assert.equal(view.totals?.literals,3);
});

test('literal-link documentation names every declaration, normalizer and producer scope',()=>{
  const text=readFileSync(new URL('../README.md',import.meta.url),'utf8'),section=text.split('## Literal links (1.3.0)')[1];assert.ok(section);
  const product=ProductDeclaration.parse(JSON.parse(readFileSync(new URL('../product.json',import.meta.url),'utf8')));
  for(const rule of product.links??[]){
    for(const value of [rule.id,rule.field??rule.alternatives_field!,rule.match,rule.entry_kind!,...Object.keys(rule.normalize??{}),...(rule.source_producers??[]),...(rule.target_producers??[])])assert.ok(section.includes('`'+value+'`'),value);
  }
  for(const field of ['source_producers','target_producers'])assert.ok(section.includes('`'+field+'`'));
});
test('knowledge relation documentation has no stray escaped newline at a line end',()=>{
  const text=readFileSync(new URL('../../../../hub/knowledge/README.md',import.meta.url),'utf8');
  assert.ok(!text.split('\n').some(line=>line.endsWith(String.fromCharCode(92)+'n')));
});
