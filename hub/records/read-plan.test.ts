// Regression for SQL-function inlining: digest predicates must reach the records index.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { openTestRecords } from '../testing/records.ts';
import { Database, createPool } from './db.ts';
import { envelopeDigest } from './digest.ts';
import { newId } from './ids.ts';
import { grantRuntime } from './migrations.ts';

interface PlanNode {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  'Index Cond'?: string;
  'Actual Rows'?: number;
  Plans?: PlanNode[];
}

function nodes(plan: PlanNode): PlanNode[] {
  return [plan, ...(plan.Plans ?? []).flatMap(nodes)];
}

test('digest reads inline the logical record view and use its index at 50,000 records', async t => {
  const kit = await openTestRecords();
  t.after(() => kit.close());
  const db = new Database(createPool(kit.database));
  t.after(() => db.end());
  const meta = { kind: 'claim', schema: 'synthetic-claim@1', provenance: 'declared', created_at: '2026-11-03T00:00:00.000Z' };
  // Seed valid synthetic envelopes in one batch instead of 50,000 application transactions.
  const rows = Array.from({ length: 50_000 }, (_, n) => {
    const body = JSON.stringify({ n });
    return { id: newId('rcd'), digest: envelopeDigest(meta, body), body, size: Buffer.byteLength(body) };
  });
  await db.query(`INSERT INTO public.records(id,digest,kind,schema,provenance,created_at,body,size)
    SELECT id,digest,$2,$3,$4,$5,body,size
    FROM jsonb_to_recordset($1::jsonb) AS r(id text,digest text,body text,size integer)`,
  [JSON.stringify(rows), meta.kind, meta.schema, meta.provenance, meta.created_at]);
  await db.query('ANALYZE public.records');
  const role = 'synthetic_read_plan_' + randomBytes(4).toString('hex');
  const password = randomBytes(16).toString('hex');
  await db.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`);
  await db.query(`REVOKE TEMPORARY ON DATABASE "${kit.database.database}" FROM PUBLIC`);
  await grantRuntime(db, role);
  const runtime = new Database(createPool({ ...kit.database, user: role, password }));
  t.after(() => runtime.end());

  for (const connection of [db, runtime]) {
    for (const digest of [rows[25_000].digest, '0'.repeat(64)]) {
      const result = await connection.query<{ 'QUERY PLAN': { Plan: PlanNode }[] }>(
        'EXPLAIN (ANALYZE, FORMAT JSON, COSTS OFF, TIMING OFF) SELECT * FROM public.hub_read_records() WHERE digest=$1', [digest]);
      const plan = result.rows[0]['QUERY PLAN'][0].Plan;
      const scans = nodes(plan);
      const detail = JSON.stringify(plan);
      assert.ok(!scans.some(node => node['Node Type'] === 'Function Scan'), detail);
      assert.ok(!scans.some(node => node['Relation Name'] === 'records' && node['Node Type'] === 'Seq Scan'), detail);
      const indexed = scans.find(node => node['Relation Name'] === 'records'
        && node['Node Type'] === 'Index Scan' && node['Index Name'] === 'records_digest_key');
      assert.ok(indexed, detail);
      assert.match(indexed['Index Cond'] ?? '', /digest/);
      assert.ok((indexed['Actual Rows'] ?? Infinity) <= 1, detail);
    }
  }
  assert.deepEqual((await kit.store.get(rows[25_000].digest))?.body, { n: 25_000 });
  assert.equal(await kit.store.get('0'.repeat(64)), null);
});
