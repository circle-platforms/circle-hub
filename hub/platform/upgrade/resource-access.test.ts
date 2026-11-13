import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalize, recordDigest, sha256Hex } from '../../records/api.ts';
import { previousResourceAccess } from './resource-access.ts';
import { buildOld33Fixture } from './testing/fixtures.ts';
import type { OldRecord } from './state.ts';

const fixture = () => {
  const f = buildOld33Fixture();
  const records: OldRecord[] = f.records.map((record, index) => ({ ...record, seq: String(index + 1) }));
  const objects = new Map(f.objects.map(object => [object.sha256, object.bytes]));
  return { f, records, objects, read: async (hash: string) => objects.get(hash) ?? null };
};
test('only enabled predecessor resources without an explicit scope need the one-time all-members conversion', async () => {
  const { f, records, read } = fixture();
  const plan = await previousResourceAccess(records, read, new Date());
  assert.deepEqual(plan.issues, []);
  assert.deepEqual(plan.resources, [f.handles.resource.id]);
});
test('an explicit source assignment is preserved instead of widening it to all members', async () => {
  const { f, records, read } = fixture();
  const body = { permission: 'resource_assign', subject: 'tm_' + '0'.repeat(26), object: f.handles.resource.id, revoked: false };
  const row = { kind: 'authorization', schema: 'authorization@1', provenance: 'declared', created_at: f.at, body };
  records.push({ ...row, seq: '9999', id: 'rcd_' + '0'.repeat(26), digest: recordDigest(row) });
  assert.deepEqual(await previousResourceAccess(records, read, new Date()), { resources: [], issues: [] });
});
test('unknown private scope fields are not discarded to make a resource appear public', async () => {
  const { f, records, objects, read } = fixture();
  const definition = JSON.parse(Buffer.from(objects.get(f.handles.resource.object)!).toString('utf8')) as object;
  const bytes = Buffer.from(canonicalize({ ...definition, private_scope: f.member })), hash = sha256Hex(bytes);
  objects.set(hash, bytes);
  const grant = records.find(record => record.digest === f.handles.resource.decision)!;
  grant.body = { ...grant.body as object, bound: hash };
  const plan = await previousResourceAccess(records, read, new Date());
  assert.equal(plan.resources.length, 0); assert.equal(plan.issues.length, 1);
});
