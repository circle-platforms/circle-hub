import {createTestParserRegistry as createDefaultRegistry} from '../../testing/parsers.ts';
import assert from 'node:assert/strict';
import { before,after,test } from 'node:test';
import { Session } from 'node:inspector/promises';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { locatePack,writePack } from './testing/packs.ts';
import { setImmediate } from 'node:timers/promises';
import { createParserRegistry,createDocumentCache,type ParsedDocument } from '../../refs/api.ts';
import { startPostgres,type TemporaryPostgres } from '../../testing/postgres.ts';
import { createRunsService } from './service.ts';
import { openHarness,sandboxSkip } from './testing/harness.ts';
import { standardDocument,toyMap } from './testing/mindmap.ts';
let postgres:TemporaryPostgres;
before(async()=>{postgres=await startPostgres();});after(()=>postgres?.stop());
const skip=await sandboxSkip();

test('disposed document caches cannot retain models or accept late writes',()=>{
  const cache=createDocumentCache(32),document={synthetic:true} as unknown as ParsedDocument;
  cache.set('synthetic-root',document);assert.equal(cache.get('synthetic-root'),document);
  cache.dispose!();assert.equal(cache.get('synthetic-root'),undefined);
  cache.set('late',document);assert.equal(cache.get('late'),undefined);
});

test('one long-lived runs service releases parsed input documents after starts and previews', {skip,timeout:120_000},async t=>{
  const h=await openHarness(postgres);t.after(()=>h.close());
  const references:WeakRef<ParsedDocument>[]=[],counts:number[]=[];
  const parsers=createParserRegistry(createDefaultRegistry().list().map(parser=>({...parser,parse(bytes:Uint8Array,options?:Parameters<typeof parser.parse>[1]){
    const parsed=parser.parse(bytes,options);references.push(new WeakRef(parsed));return parsed;
  }})));
  const service=createRunsService({records:h.kit,workflows:h.workflows,packs:h.packs,knowledge:h.knowledge,external:h.external,parsers});
  const inspector=new Session();inspector.connect();t.after(()=>inspector.disconnect());
  const source=await h.upload(h.alice,toyMap(standardDocument()));
  for(let i=0;i<3;i++){
    const before=references.length;
    const result=await service.startRunDetailed(h.alice,{pack:'toy-locate',inputs:{map:{reference:source}}},h.call());
    assert.equal(result.answer.call_result,'ok',JSON.stringify(result.answer.errors));
    assert.equal(result.answer.run!.items.length,4);counts.push(references.length-before);
    // Repeated item locations share a parsed document within this call, while the next call owns a fresh cache.
    assert.ok(counts.at(-1)!<=3,`one source was parsed ${counts.at(-1)} times for four item locations`);
    const preview=await service.resolveReference(h.alice,{run:result.answer.run!.run,text:result.answer.run!.items[0].location,expect:'reference'},h.call());
    assert.equal(preview.call_result,'ok');
  }
  const directory=await mkdtemp(join(tmpdir(),'hub-document-refusal-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const spec=locatePack();spec.id='synthetic-document-refusal';
  spec.files['functions/project.ts']=`export default function(input){const selector=input.inputs[0].model.nodes[0].selector;return {items:[{id:'good',label:'good',location:{parser:'kityminder@1',selector},fields:{expected:['synthetic']}},{id:'bad',label:'bad',location:{parser:'kityminder@1',selector:'n/definitely-missing'},fields:{expected:['synthetic']}}],warnings:[]};}`;
  await h.workflows.add(await writePack(directory,spec));h.workflows.assign(h.alice.id,spec.id);
  const beforeRefusal=references.length;
  const refusal=await service.startRunDetailed(h.alice,{pack:spec.id,inputs:{map:{reference:source}}},h.call());
  assert.equal(refusal.answer.call_result,'error');
  assert.ok(references.length-beforeRefusal>=2,'the refusal happened after a document entered the per-call cache');
  assert.ok(references.length>=6,'starts and previews actually parsed source bytes');
  await setImmediate();await inspector.post('HeapProfiler.collectGarbage');await setImmediate();
  assert.equal(references.filter(ref=>ref.deref()!==undefined).length,0,'the service retained a ParsedDocument after its call ended');
  t.diagnostic(JSON.stringify({starts:3,parsedDocuments:references.length,parsesPerStart:counts,retained:0}));
});

test('pending parse completion cannot repopulate a disposed operation cache',async()=>{
 const cache=createDocumentCache(2),document={synthetic:true} as unknown as ParsedDocument;
 let complete!:(value:ParsedDocument)=>void;let calls=0;
 const parse=()=>{calls++;return new Promise<ParsedDocument>(resolve=>{complete=resolve;});};
 const first=cache.load!('same',parse),second=cache.load!('same',parse);
 await Promise.resolve();assert.equal(calls,1);cache.dispose!();complete(document);
 assert.equal(await first,document);assert.equal(await second,document);assert.equal(cache.get('same'),undefined);
});
