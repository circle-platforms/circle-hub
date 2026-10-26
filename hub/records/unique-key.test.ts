import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openTestRecords } from '../testing/records.ts';
import type { RecordInput } from './api.ts';

test('unique business keys select one verified record atomically and keep kind namespaces apart', async t => {
  const kit = await openTestRecords(); t.after(() => kit.close());
  const input: RecordInput = { kind: 'action', schema: 'action@1', provenance: 'observed', body: { candidate: 1 }, unique_key: 'synthetic.operation' };
  const results = await Promise.all(Array.from({ length: 20 }, (_, candidate) => kit.store.put({ ...input, body: { candidate } })));
  assert.equal(results.filter(r => r.created).length, 1);
  assert.equal(new Set(results.map(r => r.digest)).size, 1);
  assert.ok(results.every(r => JSON.stringify(r.body) === JSON.stringify(results[0].body)));
  assert.equal((await kit.store.getByKey('action', input.unique_key!))?.digest, results[0].digest);
  assert.equal((await kit.store.put({ ...input, kind: 'claim' })).created, true);
});

test('a failed outer transaction rolls back the record, index and key together', async t => {
  const kit = await openTestRecords(); t.after(() => kit.close());
  const input: RecordInput = { kind: 'action', schema: 'action@1', provenance: 'observed', body: {}, unique_key: 'synthetic.rollback', index: [{ key: 'test.key', value: 'rollback' }] };
  await assert.rejects(kit.store.withTransaction(async tx => { await kit.store.put(input, tx); throw new Error('synthetic storage failure'); }));
  assert.equal(await kit.store.getByKey('action', input.unique_key!), null);
  assert.equal((await kit.store.find({ key: 'test.key', value: 'rollback' })).items.length, 0);
  assert.equal((await kit.store.put(input)).created, true);
  for (const key of ['', '\0', 'x'.repeat(1001)]) await assert.rejects(kit.store.put({ ...input, unique_key: key }));
});
