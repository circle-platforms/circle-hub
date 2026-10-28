import assert from 'node:assert/strict';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {startPostgres} from './test-support.ts';
import {FeedingLayer,FEEDING_BOUNDS} from './feeding.ts';
import {createRunsService} from '../runs/api.ts';
import {FakeWorkflowStore} from '../runs/engine/testing/workflows.ts';
import {createTestParserRegistry as createDefaultRegistry} from '../testing/parsers.ts';
import {installedMindmapFixture,mapBytes,readCapture,workingPackage,world} from './feeding-bounds-fixture.ts';

test('40 case-body layouts retain their authored step lines and resolve only exact locked-tree commands',async t=>{
 const xml='<commands><menu name="system"><item name="show"><arguments/></item></menu><menu name="net"><item name="ping"><arguments><arg name="host" type="DOTTEDIP"/></arguments></item></menu></commands>';const pg=await startPostgres();t.after(()=>pg.stop());const w=await world(pg,false,undefined,xml);const layer=w.knowledge.feeding!;t.after(async()=>{await layer.drain();await w.close();});
 const input=JSON.parse(mapBytes.toString());for(const [i,node]of input.root.children.entries()){node.data.text=i===0?'system show\nnet ping 192.0.2.8':'1.在设备上配置 xxx [check1]\n2.从主机发起 yyy [check2]';node.children=[{data:{id:'expected-'+i,text:'[check1] 合成期望一\n[check2] 合成期望二'}}];}
 const capture=await readCapture(w,'agile:mindmap:SYN-DOC',Buffer.from(JSON.stringify(input)));const receipt=await layer.observeSource(w.user,capture.content.body.sha256,capture.scope);assert.equal(receipt.objects.length,40);assert.equal(w.calls(),3,'step parsing stays inside whole-document product calls');const entries=await layer.entries(w.user,'famx');assert.equal(entries.length,40);for(const entry of entries){assert.equal(entry.body.steps.length,2);assert.equal(entry.body.expects.length,1);if(entry.body.source.element==='case-0'){assert.equal(entry.body.commands.length,2);assert.equal(entry.body.unparsed_steps,0);assert.equal(entry.body.commands[1].parameters[0].raw,'192.0.2.8');}else{assert.deepEqual(entry.body.steps,[{text:'1.在设备上配置 xxx [check1]'},{text:'2.从主机发起 yyy [check2]'}]);assert.deepEqual(entry.body.commands,[]);assert.equal(entry.body.unparsed_steps,2);}}
});

test('40 projected case selectors are batched before the feeding transaction without metadata',async t=>{
 const pg=await startPostgres();t.after(()=>pg.stop());const w=await world(pg);t.after(()=>w.close());
 const registry=w.knowledge.__context.parsers,originalGet=registry.get.bind(registry),base=originalGet('kityminder@1');assert.ok(base);
 const batches:string[][]=[];let singles=0,underLock=false;
 const originalLock=w.kit.store.lock.bind(w.kit.store);
 w.kit.store.lock=async(key,tx)=>{if(key==='knowledge.feeding.log')underLock=true;return originalLock(key,tx);};
 const decorate=(document:ReturnType<typeof base.parse>)=>{const loaded=new Set<string>();return {...document,
  prefetch:async(selectors:string[])=>{assert.equal(underLock,false,'document locate must precede the feeding append lock');const wanted=[...new Set(selectors)].filter(selector=>!loaded.has(selector));if(wanted.length){batches.push(wanted);for(const selector of wanted)loaded.add(selector);}},
  locate:async(selector:string)=>{if(!loaded.has(selector)){singles++;loaded.add(selector);}return document.locate(selector);}};};
 const counting={...base,parse:(bytes:Uint8Array,options?:Parameters<typeof base.parse>[1])=>decorate(base.parse(bytes,options))};
 registry.get=(key:string)=>key==='kityminder@1'?counting:originalGet(key);
 const {metaSource:_metaSource,...scope}=w.scope;
 const receipt=await w.knowledge.feeding!.observeSource(w.user,w.document.body.sha256,scope);
 assert.equal(receipt.objects.length,40);
 assert.equal(batches.length,1);
 assert.equal(batches[0].length,40);
 assert.equal(singles,0);
});

test('feeding rechecks the exact source grant after prefetch and rolls back on revocation',async t=>{
 const pg=await startPostgres();t.after(()=>pg.stop());const w=await world(pg);t.after(()=>w.close());
 const registry=w.knowledge.__context.parsers,originalGet=registry.get.bind(registry),base=originalGet('kityminder@1');assert.ok(base);
 let revoked=false,prefetches=0;const originalSource=w.kit.artifacts.source.bind(w.kit.artifacts);
 w.kit.artifacts.source=async(principal,sha,options)=>revoked&&sha===w.document.body.sha256?null:originalSource(principal,sha,options);
 registry.get=(key:string)=>key==='kityminder@1'?{...base,parse:(bytes,options)=>{const doc=base.parse(bytes,options);return {...doc,prefetch:async()=>{prefetches++;revoked=true;}};}}:originalGet(key);
 const {metaSource:_metaSource,...scope}=w.scope;
 const receipt=await w.knowledge.feeding!.observeSource(w.user,w.document.body.sha256,scope);
 assert.equal(prefetches,1);assert.deepEqual(receipt.objects,[]);assert.ok(receipt.pending.some(value=>value.missing.includes('SOURCE_UNAVAILABLE')&&value.next_action.length>0));
 assert.equal((await w.knowledge.feeding!.entries(w.admin,'famx')).length,0,'no partial object or binding commits after the source becomes unreadable');
});

test('feeding discards a projection when the package changes during document prefetch',async t=>{
 const pg=await startPostgres();t.after(()=>pg.stop());const w=await world(pg);t.after(()=>w.close());
 const registry=w.knowledge.__context.parsers,originalGet=registry.get.bind(registry),base=originalGet('kityminder@1');assert.ok(base);
 let superseded=false,prefetches=0;const packs=w.knowledge.__context.packs,originalProduct=packs.productById.bind(packs);
 packs.productById=async id=>{const pack=await originalProduct(id);return superseded&&pack?{...pack,digest:'a'.repeat(64)}:pack;};
 registry.get=(key:string)=>key==='kityminder@1'?{...base,parse:(bytes,options)=>{const doc=base.parse(bytes,options);return {...doc,prefetch:async()=>{prefetches++;superseded=true;}};}}:originalGet(key);
 const {metaSource:_metaSource,...scope}=w.scope;
 const receipt=await w.knowledge.feeding!.observeSource(w.user,w.document.body.sha256,scope);
 assert.equal(prefetches,1);assert.deepEqual(receipt.objects,[]);assert.ok(receipt.pending.some(value=>value.missing.includes('包已被新摘要替代')&&value.next_action.length>0));
 assert.equal((await w.knowledge.feeding!.entries(w.admin,'famx')).length,0,'superseded projections do not enter the feeding log');
});
