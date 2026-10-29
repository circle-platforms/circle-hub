import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Builds } from './builds.ts';
import type { KnowledgeContext } from './context.ts';
import { INDEX, buildKey, type ProduceAction } from './store.ts';
import { BASE_CATALOG, catalogXml, makeWorld, startPostgres } from './test-support.ts';
import pg from 'pg';

test('thousands of empty production indexes are batched while newest valid productions stay exact', async t => {
  const pg = await startPostgres();
  const w = await makeWorld(pg);
  t.after(async () => { await w.close(); await pg.stop(); });
  const first = 'Synthetic_ACME_10_8_0';
  const bases = Array.from({ length: 3180 }, (_, i) => i === 0 ? first : `Synthetic_ACME_10_8_${i}`);
  w.external.set('site:tree:synthetic', { bytes: catalogXml(BASE_CATALOG), mediaType: 'application/xml' });
  const result = await w.knowledge.produceTree({ product: w.product, build: { name: first, base: first, family: 'ACME', line: '10.8', platform: null, built_at: null, released_at: null, root: null, sources: { tree: 'site:tree:synthetic' } } });
  assert.ok(result.ok, result.reason ?? '');
  const store = w.knowledge.store;
  const original = await store.latestProduction('acme', first); assert.ok(original?.detail.build);
  for (const name of bases.slice(1, 102)) {
    await store.putAction({ ...original.record.body, detail: { ...original.record.body.detail, build: { ...original.detail.build, name, base: name } } }, [{ key: INDEX.produce, value: buildKey('acme', name) }]);
  }
  for (let i = 0; i < 5; i++) {
    await store.putAction({ ...original.record.body, result: 'error', detail: { ...original.record.body.detail, reason: `synthetic failure ${i}` } }, [{ key: INDEX.produce, value: buildKey('acme', first) }]);
  }
  const expected = await store.latestProduction('acme', first); assert.ok(expected);
  assert.equal(expected.record.digest, original.record.digest);
  assert.equal(await store.latestProduction('acme', first.toLowerCase()), null, 'case-folded index does not change exact base identity');

  let batches = 0, lookups = 0, active = 0, peak = 0;
  const findFirstMany = store.records.findFirstMany.bind(store.records);
  const latestProduction = store.latestProduction.bind(store);
  t.mock.method(store.records, 'findFirstMany', async (...args: Parameters<typeof findFirstMany>) => {
    batches++; active++; peak = Math.max(peak, active);
    try { return await findFirstMany(...args); } finally { active--; }
  });
  t.mock.method(store, 'latestProduction', async (...args: Parameters<typeof latestProduction>) => { lookups++; return latestProduction(...args); });
  const roots = await new Builds(w.knowledge.__context).roots('acme', [...bases, first, first.toLowerCase()]);
  assert.equal(roots.size, 102);
  assert.equal(roots.get(first)?.record.digest, expected.record.digest);
  for (const name of bases.slice(0, 102)) assert.equal(roots.get(name)?.detail.build?.name, name);
  assert.equal(roots.has(first.toLowerCase()), false);
  assert.ok(batches > 0 && batches <= Math.ceil((bases.length + 1) / 16));
  assert.ok(lookups <= 103, `empty bases caused ${lookups} per-base lookups`);
  assert.ok(peak <= 2);
  t.diagnostic(JSON.stringify({ bases: bases.length + 1, batches, per_base_lookups: lookups, peak_batches: peak }));
});

test('failed batch discovery falls back to the original per-base reads', async () => {
  const sentinel = { detail: { root: 'a'.repeat(64) } } as ProduceAction;
  let batches = 0, lookups = 0;
  const store = {
    records: { async findFirstMany() { batches++; throw new Error('synthetic discovery failure'); } },
    async latestProduction(_product: string, base: string) { lookups++; return base === 'Synthetic_10_8_A' ? sentinel : null; },
  };
  const roots = await new Builds({ store } as unknown as KnowledgeContext).roots('meridian', ['Synthetic_10_8_A', 'Synthetic_10_8_B']);
  assert.equal(roots.get('Synthetic_10_8_A'), sentinel);
  assert.equal(roots.size, 1);
  assert.equal(batches, 1);
  assert.equal(lookups, 2);
});

test('an unread old index entry falls back without hiding a bad newest entry', async t => {
  const postgres = await startPostgres();
  const w = await makeWorld(postgres);
  const client = new pg.Client({ ...w.kit.database, ssl: false });
  t.after(async () => { await client.end().catch(() => {}); await w.close(); await postgres.stop(); });
  const name = 'Synthetic_ACME_10_8_old';
  w.external.set('site:tree:synthetic', { bytes: catalogXml(BASE_CATALOG), mediaType: 'application/xml' });
  const result = await w.knowledge.produceTree({ product: w.product, build: { name, base: name, family: 'ACME', line: '10.8', platform: null, built_at: null, released_at: null, root: null, sources: { tree: 'site:tree:synthetic' } } });
  assert.ok(result.ok, result.reason ?? '');
  const store = w.knowledge.store;
  const oldest = await store.latestProduction('acme', name); assert.ok(oldest);
  let newest = oldest.record.digest;
  for (let i = 0; i < 5; i++) {
    const saved = await store.putAction({ ...oldest.record.body, detail: { ...oldest.record.body.detail, reason: `synthetic completed ${i}` } }, [{ key: INDEX.produce, value: buildKey('acme', name) }]);
    newest = saved.digest;
  }
  await client.connect();
  await client.query("SET session_replication_role = 'replica'");
  await client.query('UPDATE records SET body=$1 WHERE digest=$2', ['{}', oldest.record.digest]);
  await client.query("SET session_replication_role = 'origin'");
  assert.equal((await store.latestProduction('acme', name))?.record.digest, newest);
  assert.equal((await new Builds(w.knowledge.__context).roots('acme', [name])).get(name)?.record.digest, newest);
  await client.query("SET session_replication_role = 'replica'");
  await client.query('UPDATE records SET body=$1 WHERE digest=$2', ['{}', newest]);
  await client.query("SET session_replication_role = 'origin'");
  await assert.rejects(new Builds(w.knowledge.__context).roots('acme', [name]), { name: 'IntegrityError' });
});
