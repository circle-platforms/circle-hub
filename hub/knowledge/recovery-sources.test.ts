import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startPostgres } from './test-support.ts';
import { world } from './testing/feeding-bounds-fixture.ts';
import { recoverySourcesReadable } from './recovery-sources.ts';
import type { KnowledgePort } from '../ports.ts';

test('a root reader can recheck clean synchronizer captures without acquiring their raw access',async t=>{
  const pg=await startPostgres();t.after(()=>pg.stop());const w=await world(pg);t.after(()=>w.close());
  const sources=await w.knowledge.rootSources!(w.root.root);assert.ok(sources.length>0);
  assert.equal(await w.kit.artifacts.source(w.user,sources[0].sha256,{consumer:'model',record:sources[0].artifact}),null);
  const reads=w.external.reads.length;
  assert.equal(await recoverySourcesReadable(w.knowledge,w.user,w.root.root),true);
  assert.equal(w.external.reads.length,reads,'the check reads retained captures, never the external source');
  w.packs.readers.set(w.user.id,new Set());assert.equal(await recoverySourcesReadable(w.knowledge,w.user,w.root.root),false);
});
test('an excessive source list stops before fetching source bytes',async()=>{
  let reads=0;const user={id:'usr_01hzzzzzzzzzzzzzzzzzzzzzza',name:'synthetic',role:'user' as const};
  const knowledge={__context:{admin:user,records:{artifacts:{source:async()=>{reads++;return null;}}}},treeReader:()=>({hasRoot:async()=>true}),rootSources:async()=>Array.from({length:513},(_,i)=>({sha256:String(i),artifact:String(i)}))} as unknown as KnowledgePort;
  assert.equal(await recoverySourcesReadable(knowledge,user,'a'.repeat(64)),false);assert.equal(reads,0);
});
