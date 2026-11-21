import assert from 'node:assert/strict';
import {after,before,test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {startPostgres,type TemporaryPostgres} from '../testing/postgres.ts';
import {openPackTestbed,type PackTestbed} from '../runs/packs/testing/setup.ts';
import {workflowPack,type PackDescription} from '../runs/packs/testing/builder.ts';
import {createWorkflowStore,createPacksPort} from '../runs/packs/ports.ts';
import {createSkillParserRegistry} from './skills.ts';
import {createDefaultRegistry,createDocumentCache,parseDocument,resolveReference,verifyQuote} from './api.ts';
import {openHarness,type Harness} from '../runs/engine/testing/harness.ts';
import {sha256Hex} from './canonical-json.ts';
import {newId} from '../records/api.ts';
import {kityminderParser} from '../testing/parsers.ts';
import {installHtmlFixture,installWorkbookFixture,installXmlFixture,repositorySkillVersion} from '../testing/skills.ts';
import {xlsxParser} from '../../packs/skill/workbook-format/api.ts';
import {xmlParser} from '../../packs/skill/xml-format/api.ts';
import {htmlParser} from '../../packs/skill/html-format/api.ts';
import ExcelJS from 'exceljs';
import {RunRecord} from '../../contracts/src/run.ts';

let postgres:TemporaryPostgres,bed:PackTestbed,h:Harness;
let template:PackDescription;
before(async()=>{
  postgres=await startPostgres();bed=await openPackTestbed({postgres});h=await openHarness(postgres,{parsers:createSkillParserRegistry(options())});
  const root=fileURLToPath(new URL('../../packs/skill/mindmap-format/',import.meta.url));
  const m=JSON.parse(await readFile(join(root,'pack.json'),'utf8'));
  const files:PackDescription['files']={};for(const f of m.files)files[f.path]=await readFile(join(root,f.path));
  template={...m,version:'1.0.1',files};
});
after(async()=>{await h?.close();await bed?.close();await postgres?.stop();});
const options=()=>({registry:bed.registry,records:bed.kit,sandbox:{requireOsIsolation:false}});
const bytes=Buffer.from(JSON.stringify({root:{data:{id:'root',text:'合成脑图'},children:[{data:{id:'case1',text:'合成用例',resource:['function']},children:[]}]}}));
const parse=async(registry:ReturnType<typeof createSkillParserRegistry>)=>{await registry.refresh!();const p=registry.get('kityminder@1');assert.ok(p);return parseDocument(p,bytes);};
let firstDigest:string;

test('format capability requires an administrator install and rejects user assignment',async()=>{
  assert.equal(createDefaultRegistry().get('kityminder@1'),undefined);
  const declaration=JSON.parse(Buffer.from(template.files['skill.json'] as Uint8Array).toString('utf8'));declaration.parsers[0].parser='kityminder@01';
  const invalid=await bed.attempt(bed.alice,{...template,id:'invalid-parser-version',files:{...template.files,'skill.json':declaration}});
  assert.ok(!invalid.ok&&invalid.problems.some(problem=>problem.rule==='skill.shape'));
  const published=await bed.publish(bed.alice,template);firstDigest=published.version.digest;
  const registry=createSkillParserRegistry(options());
  h.review.manifest.dependencies=[{pack:'mindmap-format'}];
  const refused=await h.service.startRun(h.alice,{pack:'toy-review',product:'PASTURE',version:'3.2',inputs:{map:{reference:await h.upload(h.alice,bytes)}}},h.call());
  assert.equal(refused.call_result,'error');assert.deepEqual(refused.errors.map(e=>[e.code,e.path,e.message]),[['SOURCE_READ_FAILED','/pack','缺少已安装技能包 mindmap-format；新运行没有开始']],'T9-2: the refusal names the missing skill pack');
  assert.equal((await h.kit.store.find({kind:'run',key:'runs.user',value:h.alice.id,limit:10})).items.length,0);
  await assert.rejects(registry.freeze!([{pack:'mindmap-format'}]),/缺少已安装技能包/);
  await assert.rejects(bed.registry.install(bed.alice,'mindmap-format@1.0.1'),/管理员/);
  await assert.rejects(bed.registry.assign(bed.admin,bed.bob.id,'mindmap-format'),/不按用户分配/);
  await bed.registry.install(bed.admin,'mindmap-format@1.0.1');
  const frozen=await registry.freeze!([{pack:'mindmap-format',version:'1.0.1'}]);
  assert.deepEqual(frozen.skills,[{pack:'mindmap-format',version:'1.0.1',digest:firstDigest}]);
  const doc=await parse(registry);
  assert.equal((await doc.locate('n/case1'))?.text,'合成用例');
  assert.equal((await doc.locate('i/0'))?.text,'合成用例');
  const source=sha256Hex(bytes),reference=`src:${source}/kityminder@1/n/case1`;
  const resolved=await resolveReference(reference,{parsers:frozen.parsers,reader:{user:bed.bob.id,role:'user'},sources:{read:()=>({bytes,mediaType:'application/json',size:bytes.length,readTier:'model_readable'})}});
  assert.ok(resolved.resolved&&resolved.text==='合成用例'&&verifyQuote(resolved,'合成用例'));
  const denied=await resolveReference(reference,{parsers:frozen.parsers,reader:{user:bed.bob.id,role:'user'},sources:{read:()=>null}});
  assert.ok(!denied.resolved&&denied.message==='对你不可用');
});

test('duplicate parser declarations are refused and published skill upgrades are not implicitly installed',async()=>{
  const duplicate=await bed.publish(bed.alice,{...template,id:'other-format'});
  await assert.rejects(bed.registry.install(bed.admin,duplicate.version.id+'@'+template.version),/重复声明解析器/);
  const next={...template,version:'1.0.2'};await bed.publish(bed.alice,next);
  const registry=createSkillParserRegistry(options());
  assert.equal((await registry.freeze!([])).skills[0].version,template.version);
  const store=createWorkflowStore(bed.registry);
  assert.equal(await store.forUser(bed.bob,'mindmap-format@1.0.2'),null);
  assert.equal(await createPacksPort(bed.registry).pack('mindmap-format@1.0.2'),null);
});

test('new run records freeze skills and keep working after uninstall while unlocked runs refuse cleanly',async()=>{
  const answer=await h.service.startRun(h.alice,{pack:'toy-review',product:'PASTURE',version:'3.2',inputs:{map:{reference:await h.upload(h.alice,bytes)}}},h.call());
  assert.equal(answer.call_result,'ok',JSON.stringify(answer));assert.ok(answer.run);
  assert.deepEqual(answer.run.skills,[{pack:'mindmap-format',version:'1.0.1',digest:firstDigest}]);
  const original=await h.kit.store.find<RunRecord>({kind:'run',key:'runs.id',value:answer.run.run,limit:1});
  const old={...original.items[0].body,run:newId('run')};delete old.skills;
  await bed.kit.store.put({kind:'run',schema:'run@1',provenance:'projected',created_at:original.items[0].created_at,body:old,index:[{key:'runs.id',value:old.run}]});
  const registry=createSkillParserRegistry(options());
  const sources={read:()=>({bytes,mediaType:'application/json',size:bytes.length,readTier:'model_readable' as const})};
  const ctx={parsers:registry,reader:{user:bed.bob.id,role:'user' as const,run:old.run},sources};
  const reference=`src:${sha256Hex(bytes)}/kityminder@1/n/case1`;
  const missing=await resolveReference(reference,ctx);
  assert.ok(!missing.resolved);
  assert.equal(missing.code,'SOURCE_READ_FAILED');
  assert.match(missing.message,/没有锁定/);
  assert.doesNotMatch(missing.message,/下一步/);
  assert.ok(missing.fix.length>0);
  assert.notEqual(missing.message,missing.fix);
  assert.doesNotMatch(missing.message,/bind-legacy/);
  assert.doesNotMatch(missing.fix,/bind-legacy/);
  const modern={...original.items[0].body,run:newId('run')};
  await bed.kit.store.put({kind:'run',schema:'run@1',provenance:'projected',created_at:original.items[0].created_at,body:modern,index:[{key:'runs.id',value:modern.run}]});
  await bed.registry.uninstall(bed.admin,'mindmap-format');
  const restarted=createSkillParserRegistry({...options(),registry:bed.second()});
  assert.equal((await restarted.forRun!(modern.run)).get('kityminder@1')?.skill_digest,firstDigest);
  const resolved=await resolveReference(reference,{parsers:restarted,reader:{user:bed.bob.id,role:'user' as const,run:modern.run},sources});
  assert.ok(resolved.resolved&&resolved.text==='合成用例'&&verifyQuote(resolved,'合成用例'));
  const absentVersion=createSkillParserRegistry({...options(),registry:{...bed.second(),open:async()=>null}});
  const missingLocked=await resolveReference(reference,{parsers:absentVersion,reader:{user:bed.bob.id,role:'user' as const,run:modern.run},sources});
  assert.ok(!missingLocked.resolved);
  assert.equal(missingLocked.code,'SOURCE_RETRYABLE');
  assert.equal(missingLocked.parser_missing,'kityminder@1');
  assert.match(missingLocked.message,/不可读取/);
  assert.doesNotMatch(missingLocked.message,/下一步/);
  assert.ok(missingLocked.fix.length>0);
  assert.notEqual(missingLocked.message,missingLocked.fix);
  assert.doesNotMatch(missingLocked.message,/bind-legacy/);
  assert.doesNotMatch(missingLocked.fix,/bind-legacy/);
});

test('dependency manifests survive publication and installation grants no product entitlements',async()=>{
  const pack={...workflowPack({id:'dependent-review'}),dependencies:[{pack:'mindmap-format',version:'1.0.1'}]};
  const published=await bed.publish(bed.alice,pack);
  assert.deepEqual(published.version.manifest.dependencies,pack.dependencies);
  assert.deepEqual([...(await createPacksPort(bed.registry).readableProducts(bed.bob))],[]);
});

test('a runnable skill is available by its installed digest without per-user assignment',async()=>{
  const workflow=workflowPack({id:'shared-reading'});
  const files={...workflow.files,'skill.json':{schema:'skill@1',parsers:[]},'requirements.json':{schema:'requirements@1',requirements:[]},'checks.json':{schema:'checks@1',checks:[]},'slots.schema.json':{schema:'slots@1',item:{},run:{}}};
  for(const path of Object.keys(files))if(path.startsWith('samples/'))delete files[path as keyof typeof files];
  const description={...workflow,kind:'skill' as const,files};
  const first=await bed.publish(bed.alice,description);
  await bed.registry.install(bed.admin,'shared-reading@1.0.0');
  const store=createWorkflowStore(bed.registry);
  assert.equal((await store.forUser(bed.bob,'shared-reading'))?.pack.digest,first.version.digest);
  await bed.publish(bed.alice,{...description,version:'1.0.1'});
  assert.equal(await store.forUser(bed.bob,'shared-reading@1.0.1'),null);
  assert.equal((await store.summaries(bed.bob)).find(p=>p.id==='shared-reading')?.version,'1.0.0');
});

test('sandbox transport preserves the original format vectors and enforces declared limits',async()=>{
  await bed.registry.install(bed.admin,'mindmap-format@1.0.1');
  const registry=createSkillParserRegistry(options());await registry.refresh!();
  const parser=registry.get('kityminder@1')!;
  const fixture=await readFile(new URL('./fixtures/mindmap.km.json',import.meta.url));
  const expected=kityminderParser.parse(fixture),actual=await parseDocument(parser,fixture);
  assert.deepEqual(actual.model,expected.model);assert.deepEqual(actual.summary(),expected.summary());
  assert.deepEqual(actual.listSelectors(),expected.listSelectors());
  for(const selector of expected.listSelectors('',{properties:true}))assert.deepEqual((await actual.locate(selector)),(await expected.locate(selector)),selector);
  await assert.rejects(parseDocument(parser,bytes,{maxBytes:4}),/字节限额/);
});

test('concurrent references parse one document once per operation and release the cache afterwards',async()=>{
  let calls=0;
  const registry=createSkillParserRegistry({...options(),sandbox:{requireOsIsolation:false,onAttempt:()=>{calls++;}}});
  const documents=createDocumentCache(32),frozen=await registry.freeze!([]);
  const context={parsers:frozen.parsers,documents,reader:{user:bed.bob.id,role:'user' as const},sources:{read:()=>({bytes,mediaType:'application/json',size:bytes.length,readTier:'model_readable' as const})}};
  const reference=`src:${sha256Hex(bytes)}/kityminder@1/n/case1`;
  const resolved=await Promise.all(Array.from({length:40},()=>resolveReference(reference,context)));
  assert.ok(resolved.every(result=>result.resolved&&result.text==='合成用例'));assert.equal(calls,1);
  documents.dispose!();
  await resolveReference(reference,{...context,documents:createDocumentCache(32)});assert.equal(calls,2);
});

test('standalone forReference resolves installed skill packs without refs.legacy-parser and keeps distinct missing-parser guidance',async()=>{
  await bed.registry.uninstall(bed.admin,'mindmap-format');
  const registry=createSkillParserRegistry(options());
  const source=sha256Hex(bytes),reference=`src:${source}/kityminder@1/n/case1`;
  const read=()=>({bytes,mediaType:'application/json',size:bytes.length,readTier:'model_readable' as const});
  const missing=await resolveReference(reference,{parsers:registry,reader:{user:bed.bob.id,role:'user'},sources:{read}});
  assert.equal(missing.resolved,false);
  if(!missing.resolved){
    assert.equal(missing.code,'SOURCE_READ_FAILED');
    assert.doesNotMatch(missing.message,/下一步/);
    assert.ok(missing.fix.length>0);
    assert.notEqual(missing.message,missing.fix);
    assert.doesNotMatch(missing.message,/bind-legacy/);
    assert.doesNotMatch(missing.fix,/bind-legacy/);
  }
  await bed.registry.install(bed.admin,'mindmap-format@1.0.1');
  assert.equal((await bed.kit.store.find({kind:'action',key:'refs.legacy-parser',value:'kityminder@1',limit:10})).items.length,0);
  const fresh=createSkillParserRegistry(options());
  const resolved=await resolveReference(reference,{parsers:fresh,reader:{user:bed.bob.id,role:'user'},sources:{read}});
  assert.equal(resolved.resolved,true,JSON.stringify(resolved));
  if(resolved.resolved)assert.ok(resolved.text==='合成用例'&&verifyQuote(resolved,'合成用例'));
  const absent=await resolveReference(reference,{parsers:fresh,reader:{user:bed.bob.id,role:'user'},sources:{read:()=>null}});
  assert.equal(absent.resolved,false);
  if(!absent.resolved)assert.equal(absent.message,'对你不可用');
});

test('workbook-format sandbox transport preserves xlsx@1 vectors and enforces declared limits',async()=>{
  await installWorkbookFixture(bed.registry,bed.kit,bed.admin);
  const registry=createSkillParserRegistry(options());await registry.refresh!();
  const parser=registry.get('xlsx@1')!;
  assert.ok(parser);
  const book=new ExcelJS.Workbook();
  const sheet=book.addWorksheet('工作表一');
  sheet.addRow(['标题','数量']);
  sheet.addRow(['合成用例',42]);
  const fixture=Buffer.from(await book.xlsx.writeBuffer());
  const expected=xlsxParser.parse(fixture),actual=await parseDocument(parser,fixture);
  assert.deepEqual(actual.model,expected.model);
  assert.deepEqual(actual.summary(),expected.summary());
  assert.deepEqual(actual.listSelectors(),expected.listSelectors());
  for(const selector of expected.listSelectors('',{properties:true})){
    assert.deepEqual((await actual.locate(selector)),(await expected.locate(selector)),selector);
  }
  const source=sha256Hex(fixture),reference=`src:${source}/xlsx@1/c/工作表一/A2`;
  const frozen=await registry.freeze!([{pack:'workbook-format',version:await repositorySkillVersion('workbook-format')}]);
  const resolved=await resolveReference(reference,{
    parsers:frozen.parsers,
    reader:{user:bed.bob.id,role:'user'},
    sources:{read:()=>({bytes:fixture,mediaType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',size:fixture.length,readTier:'model_readable'})},
  });
  assert.ok(resolved.resolved&&resolved.text==='合成用例'&&verifyQuote(resolved,'合成用例'));
  await assert.rejects(parseDocument(parser,fixture,{maxBytes:4}),/字节限额/);
});

test('xml-format sandbox transport preserves xml@1 vectors and enforces declared limits',async()=>{
  await installXmlFixture(bed.registry,bed.kit,bed.admin);
  const registry=createSkillParserRegistry(options());await registry.refresh!();
  const parser=registry.get('xml@1')!;
  assert.ok(parser);
  const fixture=Buffer.from('<commands><scope name="global"><menu name="system"><item name="ping"><arguments><arg name="host" help="IP or hostname"/></arguments></item></menu></scope></commands>');
  const expected=xmlParser.parse(fixture),actual=await parseDocument(parser,fixture);
  assert.deepEqual(actual.model,expected.model);
  assert.deepEqual(actual.summary(),expected.summary());
  assert.deepEqual(actual.listSelectors(),expected.listSelectors());
  for(const selector of expected.listSelectors('',{properties:true})){
    assert.deepEqual((await actual.locate(selector)),(await expected.locate(selector)),selector);
  }
  const source=sha256Hex(fixture),reference=`src:${source}/xml@1/x/commands/scope/menu/item/arguments/arg/@help`;
  const frozen=await registry.freeze!([{pack:'xml-format',version:await repositorySkillVersion('xml-format')}]);
  const resolved=await resolveReference(reference,{
    parsers:frozen.parsers,
    reader:{user:bed.bob.id,role:'user'},
    sources:{read:()=>({bytes:fixture,mediaType:'application/xml',size:fixture.length,readTier:'model_readable'})},
  });
  assert.ok(resolved.resolved&&verifyQuote(resolved,'IP or hostname'));
  await assert.rejects(parseDocument(parser,fixture,{maxBytes:4}),/字节限额/);
});

test('html-format sandbox transport preserves html@1 vectors and enforces declared limits',async()=>{
  await installHtmlFixture(bed.registry,bed.kit,bed.admin);
  const registry=createSkillParserRegistry(options());await registry.refresh!();
  const parser=registry.get('html@1')!;
  assert.ok(parser);
  const fixture=Buffer.from('<html><head><title>Test</title></head><body><h2>Heading</h2><p>Paragraph with <a href="https://192.0.2.1/item">link text</a></p></body></html>');
  const expected=htmlParser.parse(fixture),actual=await parseDocument(parser,fixture);
  assert.deepEqual(actual.model,expected.model);
  assert.deepEqual(actual.summary(),expected.summary());
  assert.deepEqual(actual.listSelectors(),expected.listSelectors());
  for(const selector of expected.listSelectors('',{properties:true})){
    assert.deepEqual((await actual.locate(selector)),(await expected.locate(selector)),selector);
  }
  const source=sha256Hex(fixture),reference=`src:${source}/html@1/a/0`;
  const frozen=await registry.freeze!([{pack:'html-format',version:await repositorySkillVersion('html-format')}]);
  const resolved=await resolveReference(reference,{
    parsers:frozen.parsers,
    reader:{user:bed.bob.id,role:'user'},
    sources:{read:()=>({bytes:fixture,mediaType:'text/html',size:fixture.length,readTier:'model_readable'})},
  });
  assert.ok(resolved.resolved&&verifyQuote(resolved,'link text'));
  await assert.rejects(parseDocument(parser,fixture,{maxBytes:4}),/字节限额/);
});
