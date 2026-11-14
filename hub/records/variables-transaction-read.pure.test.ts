import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RecordVariables, type VariablePorts } from './variables.ts';
import { canonicalBytes, canonicalize } from './canonical.ts';
import { envelopeDigest, sha256Hex } from './digest.ts';
import { newId } from './ids.ts';
import type { AuthorizationRecord, Transaction } from './api.ts';

function fixture() {
  const tx: Transaction = { transactionId: 1 }, at = '2026-11-14T00:00:00.000Z';
  const bytes = canonicalBytes({ schema: 'variable@1', name: 'SYNTHETIC_TARGET', value: 'synthetic-bed' });
  const body: AuthorizationRecord['body'] = { permission: 'resource_config', subject: '*', object: 'var:SYNTHETIC_TARGET', bound: sha256Hex(bytes), revoked: false, decided_by: newId('usr'), decided_at: at, expires_at: null, note: null, supersedes: null };
  const meta = { kind: 'authorization' as const, schema: 'authorization@1', provenance: 'declared' as const, created_at: at };
  const digest = envelopeDigest(meta, canonicalize(body));
  const record: AuthorizationRecord = { ...meta, id: newId('rcd'), digest, body };
  const events: string[] = [];
  const ports = {
    database: { query: async (_sql: string, _args: unknown[], supplied: Transaction) => {
      assert.equal(supplied, tx, 'snapshot must not borrow another connection'); events.push('snapshot');
      return { rows: [{ ...record, seq: '1', body: canonicalize(body) }] };
    } },
    store: { get: async (requested: string, supplied: Transaction) => {
      assert.equal(supplied, tx, 'valueAt must retain the same transaction'); assert.equal(requested, digest); events.push('decision'); return record;
    } },
    objects: { get: async (requested: string, supplied: Transaction) => {
      assert.equal(supplied, tx, 'the definition object must retain the same transaction'); assert.equal(requested, body.bound); events.push('object'); return bytes;
    } },
    vault: new Proxy({}, { get() { throw new Error('ordinary variable resolution must not access the vault'); } }),
  } as unknown as VariablePorts;
  return { tx, record, events, variables: new RecordVariables(ports) };
}

test('snapshot, historical value and automatic target resolution all pass the exact transaction to database, store and objects', async () => {
  const f = fixture();
  const snapshot = await f.variables.snapshot(f.tx);
  assert.equal(snapshot.get('SYNTHETIC_TARGET'), f.record.digest);
  assert.equal(await f.variables.valueAt('SYNTHETIC_TARGET', f.record.digest, f.tx), 'synthetic-bed');
  const resolved = await f.variables.resolveVariables({ target: '${var:SYNTHETIC_TARGET}' }, 'synthetic-executor', undefined, f.tx);
  assert.deepEqual(resolved.value, { target: 'synthetic-bed' });
  assert.deepEqual(resolved.uses, [{ kind: 'var', at: 'synthetic-executor#/target', name: 'SYNTHETIC_TARGET', decision: f.record.digest }]);
  assert.ok(f.events.includes('snapshot') && f.events.includes('decision') && f.events.includes('object'));
});

test('a supplied variable snapshot also retains the transaction through valueAt and definition bytes', async () => {
  const f = fixture();
  const snapshot = new Map([['SYNTHETIC_TARGET', f.record.digest]]);
  const resolved = await f.variables.resolveVariables({ target: '${var:SYNTHETIC_TARGET}' }, 'synthetic-executor', snapshot, f.tx);
  assert.equal(f.events.includes('snapshot'), false);
  assert.deepEqual(resolved.value, { target: 'synthetic-bed' });
  assert.deepEqual(f.events, ['decision', 'object']);
});
