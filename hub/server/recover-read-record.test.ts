// Recovery of a cached rec: read of a fed record: once the feeding record is retracted, the saved reply no longer states its
// current validity, so it must stay unknown (the missing-fact answer) instead of coming back as a snapshot. Synthetic world.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startPostgres } from '../knowledge/test-support.ts';
import { world } from '../knowledge/testing/feeding-bounds-fixture.ts';
import type { ServerDeps } from './api.ts';
import { recoverRead } from './recover-read.ts';
import { createTestServer } from './testing.ts';

type FeedingContent = { structure?: { feeding_state?: { validity?: string } } };

test('a retracted feeding record read by its rec: reference is not recovered as its current state', async t => {
  const pg = await startPostgres(); t.after(() => pg.stop());
  const w = await world(pg); t.after(() => w.close());
  const receipt = await w.knowledge.feeding!.observeSource(w.user, w.document.body.sha256, w.scope);
  assert.ok(receipt.objects.length > 0);
  const page = await w.knowledge.getNodes({ root: w.root.root, paths: ['/'], depth: 0 }, w.user);
  const fed = page?.nodes[0]?.feeding_objects?.[0];
  assert.ok(fed && fed.reference.startsWith('rec:'), JSON.stringify(fed));
  const hub = await createTestServer({ postgres: pg }); t.after(() => hub.close());
  hub.deps.records = w.kit; hub.deps.knowledge = w.knowledge;
  const token = await w.kit.principals.issueToken(w.admin, w.user.id, 'synthetic');
  const client = await hub.client(token.token, { sessionId: 'synthetic-record-session' }); t.after(() => client.close());
  const query = { reference: fed.reference };
  const original = await client.call('get_nodes', query), trace = original.structuredContent.trace as string;
  assert.equal((original.structuredContent.content as FeedingContent).structure?.feeding_state?.validity, 'valid');
  const cached = await client.call('get_nodes', { call_query: { get_nodes: query, trace } });
  assert.match(JSON.stringify(cached.structuredContent.content), /历史快照/);
  // The same check on the saved reply itself, without the transport.
  const deps = { records: w.kit, knowledge: w.knowledge, runs: {} } as unknown as ServerDeps;
  const saved = { call_result: 'ok', errors: [], trace, content: original.structuredContent.content };
  assert.ok(await recoverRead(deps, w.user, query, saved, trace, '2035-01-01T00:00:00.000Z'));
  await w.knowledge.feeding!.retract(w.admin, { schema: 'retraction@1', objects: [fed.object], by: w.admin.id, at: new Date().toISOString(), reason: 'synthetic retraction' });
  assert.equal(await recoverRead(deps, w.user, query, saved, trace, '2035-01-01T00:00:00.000Z'), null, 'a retracted feeding record is not recovered as current');
  const afterRetraction = await client.call('get_nodes', { call_query: { get_nodes: query, trace } });
  assert.equal(afterRetraction.structuredContent.content, undefined);
  assert.match(JSON.stringify(afterRetraction.structuredContent.call_status), /未能按当前权限或来源状态核对/);
  // A new read states the retraction.
  const reread = await client.call('get_nodes', query);
  assert.equal((reread.structuredContent.content as FeedingContent).structure?.feeding_state?.validity, 'invalid');
});
