import assert from 'node:assert/strict';
import {after,before,test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {startPostgres,type TemporaryPostgres} from '../testing/postgres.ts';
import {openPackTestbed,type PackTestbed} from '../runs/packs/testing/setup.ts';
import {workflowPack,type PackDescription} from '../runs/packs/testing/builder.ts';
import {createWorkflowStore,createPacksPort} from '../runs/packs/ports.ts';
import {createSkillParserRegistry,bindLegacySkills,bindLegacyParser} from './skills.ts';
import {createDefaultRegistry,createDocumentCache,parseDocument,resolveReference,verifyQuote} from './api.ts';
import {openHarness,type Harness} from '../runs/engine/testing/harness.ts';
import {sha256Hex} from './canonical-json.ts';
import {newId} from '../records/api.ts';
import {kityminderParser} from '../testing/parsers.ts';
import {RunRecord} from '../../contracts/src/run.ts';

let postgres:TemporaryPostgres,bed:PackTestbed,h:Harness;
let template:PackDescription;
before(async()=>{
  postgres=await startPostgres();bed=await openPackTestbed({postgres});h=await openHarness(postgres,{parsers:createSkillParserRegistry(options())});
  const root=fileURLToPath(new URL('../../packs/skill/mindmap-format/',import.meta.url));
  const m=JSON.parse(await readFile(join(root,'pack.json'),'utf8'));
  const files:PackDescription['files']={};for(const f of m.files)files[f.path]=await readFile(join(root,f.path));
  template={...m,files};
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
  assert.equal(refused.call_result,'error');assert.ok(JSON.stringify(refused).includes('安装'));
  assert.equal((await h.kit.store.find({kind:'run',key:'runs.user',value:h.alice.id,limit:10})).items.length,0);
  await assert.rejects(registry.freeze!([{pack:'mindmap-format'}]),/缺少已安装技能包/);
  await assert.rejects(bed.registry.install(bed.alice,'mindmap-format@1.0.0'),/管理员/);
  await assert.rejects(bed.registry.assign(bed.admin,bed.bob.id,'mindmap-format'),/不按用户分配/);
  await bed.registry.install(bed.admin,'mindmap-format@1.0.0');
  const frozen=await registry.freeze!([{pack:'mindmap-format',version:'1.0.0'}]);
  assert.deepEqual(frozen.skills,[{pack:'mindmap-format',version:'1.0.0',digest:firstDigest}]);
  const doc=await parse(registry);
  assert.equal(doc.locate('n/case1')?.text,'合成用例');
  assert.equal(doc.locate('i/0')?.text,'合成用例');
  const source=sha256Hex(bytes),reference=`src:${source}/kityminder@1/n/case1`;
  const resolved=await resolveReference(reference,{parsers:frozen.parsers,reader:{user:bed.bob.id,role:'user'},sources:{read:()=>({bytes,mediaType:'application/json',size:bytes.length,readTier:'model_readable'})}});
  assert.ok(resolved.resolved&&verifyQuote(resolved,'合成用例'));
  const denied=await resolveReference(reference,{parsers:frozen.parsers,reader:{user:bed.bob.id,role:'user'},sources:{read:()=>null}});
  assert.ok(!denied.resolved&&denied.message==='对你不可用');
});

test('duplicate parser declarations are refused and published skill upgrades are not implicitly installed',async()=>{
  const duplicate=await bed.publish(bed.alice,{...template,id:'other-format'});
  await assert.rejects(bed.registry.install(bed.admin,duplicate.version.id+'@1.0.0'),/重复声明解析器/);
  const next={...template,version:'1.0.1'};await bed.publish(bed.alice,next);
  const registry=createSkillParserRegistry(options());
  assert.equal((await registry.freeze!([])).skills[0].version,'1.0.0');
  const store=createWorkflowStore(bed.registry);
  assert.equal(await store.forUser(bed.bob,'mindmap-format@1.0.1'),null);
  assert.equal(await createPacksPort(bed.registry).pack('mindmap-format@1.0.1'),null);
});

test('new run records freeze skills and historical explicit bindings never modify the old record',async()=>{
  const answer=await h.service.startRun(h.alice,{pack:'toy-review',product:'PASTURE',version:'3.2',inputs:{map:{reference:await h.upload(h.alice,bytes)}}},h.call());
  assert.equal(answer.call_result,'ok',JSON.stringify(answer));assert.ok(answer.run);
  assert.deepEqual(answer.run.skills,[{pack:'mindmap-format',version:'1.0.0',digest:firstDigest}]);
  const original=await h.kit.store.find<RunRecord>({kind:'run',key:'runs.id',value:answer.run.run,limit:1});
  const old={...original.items[0].body,run:newId('run')};delete old.skills;
  // Copy synthetic historical structure into this registry's store, without manufacturing a historical skill lock.
  const saved=await bed.kit.store.put({kind:'run',schema:'run@1',provenance:'projected',created_at:original.items[0].created_at,body:old,index:[{key:'runs.id',value:old.run}]});
  const registry=createSkillParserRegistry(options());
  const sources={read:()=>({bytes,mediaType:'application/json',size:bytes.length,readTier:'model_readable' as const})};
  const ctx={parsers:registry,reader:{user:bed.bob.id,role:'user' as const,run:old.run},sources};
  const reference=`src:${sha256Hex(bytes)}/kityminder@1/n/case1`;
  const missing=await resolveReference(reference,ctx);assert.ok(!missing.resolved&&missing.fix.includes('bind-legacy'));
  await assert.rejects(bindLegacySkills(options(),bed.bob,old.run,['mindmap-format@1.0.0'],'合成历史声明'),/管理员/);
  const binding=await bindLegacySkills(options(),bed.admin,old.run,['mindmap-format@1.0.0'],'合成历史声明');
  const resolved=await resolveReference(reference,ctx);assert.ok(resolved.resolved&&resolved.note?.includes('事后声明')&&resolved.note.includes(binding));
  assert.equal((await bed.kit.store.find({kind:'run',key:'runs.id',value:old.run,limit:1})).items[0].digest,saved.digest);
  await assert.rejects(bindLegacySkills(options(),bed.admin,old.run,['mindmap-format@1.0.1'],'重绑'),/不接受改绑/);
  const modern={...original.items[0].body,run:newId('run')};
  await bed.kit.store.put({kind:'run',schema:'run@1',provenance:'projected',created_at:original.items[0].created_at,body:modern,index:[{key:'runs.id',value:modern.run}]});
  await assert.rejects(bindLegacySkills(options(),bed.admin,modern.run,['mindmap-format@1.0.1'],'重绑'),/已有冻结/);
  await bed.registry.install(bed.admin,'mindmap-format@1.0.1');
  await bed.registry.uninstall(bed.admin,'mindmap-format');
  const restarted=createSkillParserRegistry({...options(),registry:bed.second()});
  assert.equal((await restarted.forRun!(modern.run)).get('kityminder@1')?.skill_digest,firstDigest);
  const locked=await restarted.forRun!(old.run);assert.equal(locked.get('kityminder@1')?.skill_digest,firstDigest);
  assert.equal(locked.bindingRecord,binding);assert.deepEqual(locked.skills,[{pack:'mindmap-format',version:'1.0.0',digest:firstDigest}]);
  assert.equal((await parseDocument(locked.get('kityminder@1')!,bytes)).locate('n/case1')?.text,'合成用例');
});

test('dependency manifests survive publication and installation grants no product entitlements',async()=>{
  const pack={...workflowPack({id:'dependent-review'}),dependencies:[{pack:'mindmap-format',version:'1.0.0'}]};
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
  await bed.registry.install(bed.admin,'mindmap-format@1.0.0');
  const registry=createSkillParserRegistry(options());await registry.refresh!();
  const parser=registry.get('kityminder@1')!;
  const fixture=await readFile(new URL('./fixtures/mindmap.km.json',import.meta.url));
  const expected=kityminderParser.parse(fixture),actual=await parseDocument(parser,fixture);
  assert.deepEqual(actual.model,expected.model);assert.deepEqual(actual.summary(),expected.summary());
  assert.deepEqual(actual.listSelectors(),expected.listSelectors());
  for(const selector of expected.listSelectors('',{properties:true}))assert.deepEqual(actual.locate(selector),expected.locate(selector),selector);
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

test('an explicit historical binding can name a retired published skill without installing it',async()=>{
 const published=await bed.publish(bed.alice,{...template,version:'2.0.0'});
 await bed.registry.retire(bed.admin,'mindmap-format','2.0.0');
 await assert.rejects(bed.registry.install(bed.admin,'mindmap-format@2.0.0'),/没有可安装/);
 const source=(await h.kit.store.find<RunRecord>({kind:'run',key:'runs.user',value:h.alice.id,limit:1})).items[0];
 const old={...source.body,run:newId('run')};delete old.skills;
 await bed.kit.store.put({kind:'run',schema:'run@1',provenance:'projected',created_at:source.created_at,body:old,index:[{key:'runs.id',value:old.run}]});
 await bindLegacySkills(options(),bed.admin,old.run,['mindmap-format@2.0.0'],'合成旧版归档声明');
 const locked=await createSkillParserRegistry(options()).forRun!(old.run);
 assert.equal(locked.get('kityminder@1')?.skill_digest,published.version.digest);
 assert.equal((await parseDocument(locked.get('kityminder@1')!,bytes)).locate('n/case1')?.text,'合成用例');
});

test('migration-point binding freezes old references, records the administrator and test, and leaves old records unchanged',async()=>{
 const source=(await h.kit.store.find<RunRecord>({kind:'run',key:'runs.user',value:h.alice.id,limit:1})).items[0];
 const old={...source.body,run:newId('run')};delete old.skills;
 const saved=await bed.kit.store.put({kind:'run',schema:'run@1',provenance:'projected',created_at:source.created_at,body:old,index:[{key:'runs.id',value:old.run}]});
 const oldResult={schema:'validation@1',run:old.run,submission:'a'.repeat(64),acceptance:'accepted',errors:[],rounds:{used:0,max:0},partitions:{delivered:[],rejected:[],quarantined:[],incomplete:[],unknown:[]},cross_item:[],coverage:{complete:true,examined:0,total:0},locks:{pack:old.pack,pack_digest:old.pack_digest},trace:'4bf92f3577b34da6a3ce929d0e0e4736'};
 const result=await bed.kit.store.put({kind:'validation_result',schema:'validation@1',provenance:'projected',body:oldResult});
 const registry=createSkillParserRegistry(options()),reference=`src:${sha256Hex(bytes)}/kityminder@1/n/case1`;
 const context={parsers:registry,reader:{user:bed.bob.id,role:'user' as const,run:old.run},sources:{read:()=>({bytes,mediaType:'application/json',size:bytes.length,readTier:'model_readable' as const})}};
 const absent=await resolveReference(reference,context);assert.ok(!absent.resolved&&absent.fix.includes('skill bind-legacy'));
 await assert.rejects(bindLegacyParser(options(),bed.bob,'kityminder@1','mindmap-format@1.0.0'),/管理员/);
 const bound=await bindLegacyParser(options(),bed.admin,'kityminder@1','mindmap-format@1.0.0');
 assert.equal(bound.skill.digest,firstDigest);assert.equal(bound.decided_by,bed.admin.id);assert.equal(bound.test,'mindmap-format migration equivalence across repository documents');assert.equal(bound.label,'迁移时点事后声明');assert.ok(!Number.isNaN(Date.parse(bound.at)));
 await bed.registry.install(bed.admin,'mindmap-format@1.0.1');
 const resolved=await resolveReference(reference,{...context,parsers:createSkillParserRegistry({...options(),registry:bed.second()})});assert.ok(resolved.resolved&&resolved.text==='合成用例'&&resolved.note?.includes('迁移时点事后声明'));
 const locked=await registry.forRun!(old.run);assert.equal(locked.get('kityminder@1')?.skill_digest,firstDigest);assert.deepEqual(locked.bindingRecords,[bound.record]);
 const bare=await resolveReference(reference,{...context,reader:{user:bed.bob.id,role:'user' as const}});assert.ok(bare.resolved&&bare.note?.includes('迁移时点事后声明'));
 assert.deepEqual((await bed.kit.store.get(saved.digest))?.body,old);assert.deepEqual((await bed.kit.store.get(result.digest))?.body,oldResult);
 const later={...old,run:newId('run')};await bed.kit.store.put({kind:'run',schema:'run@1',provenance:'projected',body:later,index:[{key:'runs.id',value:later.run}]});
 assert.equal((await registry.forRun!(later.run)).get('kityminder@1'),undefined,'a migration declaration never supplies an invented lock to a later run');
 await assert.rejects(bindLegacyParser(options(),bed.admin,'kityminder@1','mindmap-format@1.0.1'),/不能改绑/);
});
