import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sha256Hex } from '../records/api.ts';
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
test('a source with credential findings is recheckable only while an acceptance in force lifts it', async () => {
  const user = { id: 'usr_01hzzzzzzzzzzzzzzzzzzzzzza', name: 'synthetic', role: 'user' as const };
  const bytes = new TextEncoder().encode('synthetic manual with an example password');
  const sha256 = sha256Hex(bytes);
  const scan = (over: Record<string, unknown> = {}) => ({ inspected: true, truncated: false, findings: [] as unknown[], ...over });
  const finding = { kind: 'basic_credential' };
  const answer = (over: Record<string, unknown>) => ({ readTier: 'model_readable', bytes, size: bytes.length, artifact: { body: { scan: scan() } }, ...over });
  const check = async (current: unknown) => {
    const knowledge = {
      __context: { admin: user, records: { artifacts: { source: async () => current } } },
      treeReader: () => ({ hasRoot: async () => true }),
      rootSources: async () => [{ sha256, artifact: 'a'.repeat(64) }],
    } as unknown as KnowledgePort;
    return recoverySourcesReadable(knowledge, user, 'a'.repeat(64));
  };
  assert.equal(await check(answer({})), true, 'a clean capture');
  assert.equal(await check(answer({ artifact: { body: { scan: scan({ findings: [finding] }) } }, acceptance: { decision: 'synthetic' } })), true, 'findings lifted by an acceptance in force');
  assert.equal(await check(answer({ artifact: { body: { scan: scan({ findings: [finding] }) } }, readTier: 'retain_only' })), false, 'findings nothing lifts');
  assert.equal(await check(answer({ artifact: { body: { scan: scan({ findings: [finding] }) } } })), false, 'findings without an acceptance, whatever the tier says');
  assert.equal(await check(answer({ artifact: { body: { scan: scan({ truncated: true }) } } })), false, 'a scan that did not cover the bytes');
  assert.equal(await check(answer({ bytes: new TextEncoder().encode('changed') })), false, 'bytes that no longer hash to the source');
  assert.equal(await check(null), false, 'a source the reader cannot read');
});
