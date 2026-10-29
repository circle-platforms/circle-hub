import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startPostgres } from '../knowledge/test-support.ts';
import { world } from '../knowledge/testing/feeding-bounds-fixture.ts';
import type { ServerDeps } from './api.ts';
import { recoverRead } from './recover-read.ts';
import { createTestServer } from './testing.ts';

test('a synthetic tree page with 40 fed cases can be recovered and a later retraction blocks the old snapshot',async t=>{
  const pg=await startPostgres();t.after(()=>pg.stop());const w=await world(pg);t.after(()=>w.close());
  const receipt=await w.knowledge.feeding!.observeSource(w.user,w.document.body.sha256,w.scope);assert.equal(receipt.objects.length,40);
  const query={root:w.root.root,paths:['/'],depth:0},page=await w.knowledge.getNodes(query,w.user);assert.ok(page);
  assert.equal(page.nodes[0]?.feeding_objects?.length,40);
  const trace='1'.repeat(32),answer={call_result:'ok',errors:[],trace,root:w.root.root,nodes:page.nodes,coverage:page.coverage,next:page.next};
  const deps={records:w.kit,knowledge:w.knowledge,runs:{}} as unknown as ServerDeps,reads=w.external.reads.length;
  const recovered=await recoverRead(deps,w.user,query,answer,trace,'2035-01-01T00:00:00.000Z');
  assert.equal(recovered?.nodes?.[0].feeding_objects?.length,40);assert.match(recovered!.coverage!.note!,/历史快照/);
  assert.equal(w.external.reads.length,reads,'recovery does not contact the external source');
  // Exercise the real MCP/cache route with the same knowledge service and its own records.
  const hub=await createTestServer({postgres:pg});t.after(()=>hub.close());
  hub.deps.records=w.kit;hub.deps.knowledge=w.knowledge;
  const token=await w.kit.principals.issueToken(w.admin,w.user.id,'synthetic');
  const client=await hub.client(token.token,{sessionId:'synthetic-tree-session'});t.after(()=>client.close());
  const original=await client.call('get_nodes',query),originalTrace=original.structuredContent.trace as string;
  const cached=await client.call('get_nodes',{call_query:{get_nodes:query,trace:originalTrace}});
  assert.equal((cached.structuredContent.nodes as {feeding_objects:unknown[]}[])[0].feeding_objects.length,40);
  assert.match(JSON.stringify(cached.structuredContent.coverage),/历史快照/);
  await w.knowledge.feeding!.retract(w.admin,{schema:'retraction@1',objects:[receipt.objects[0]],by:w.admin.id,at:new Date().toISOString(),reason:'synthetic retraction'});
  assert.equal(await recoverRead(deps,w.user,query,answer,trace,'2035-01-01T00:00:00.000Z'),null);
  const afterRetraction=await client.call('get_nodes',{call_query:{get_nodes:query,trace:originalTrace}});
  assert.equal(afterRetraction.structuredContent.nodes,undefined);
  assert.match(JSON.stringify(afterRetraction.structuredContent.call_status),/未能按当前权限/);
});
