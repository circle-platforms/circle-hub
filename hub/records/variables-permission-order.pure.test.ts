import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RecordVariables, type VariablePorts } from './variables.ts';
import { newId } from './ids.ts';
import { sha256Hex } from './digest.ts';
import type { AuthorizationRecord, Principal, Transaction } from './api.ts';

function fixture(failCommit = false) {
  const admin: Principal = { id: newId('usr'), name: 'synthetic-admin', role: 'admin' };
  const tx: Transaction = { transactionId: 1 }, events: string[] = [];
  let inTransaction = false;
  const history = new Map<string, AuthorizationRecord[]>();
  const objects = new Map<string, Uint8Array>();
  // Deliberately minimal scripted ports: no PostgreSQL, network, credential file or real vault is used.
  const ports = {
    validateEnvironmentWrite: async () => {},
    database: { query: async (_sql: string, _args: unknown[], supplied: Transaction) => {
      assert.equal(supplied, tx); events.push('actor-row');
      return { rows: [{ ...admin, disabled: false, deleted_at: null }] };
    } },
    store: {
      withTransaction: async <T>(fn: (tx: Transaction) => Promise<T>) => {
        inTransaction = true;
        try { const value = await fn(tx); if (failCommit) throw new Error('synthetic commit failure'); return value; }
        finally { inTransaction = false; }
      },
      lock: async (key: string, supplied: Transaction) => { assert.equal(supplied, tx); events.push(key); },
      find: async (query: { value: string }, supplied: Transaction) => { assert.equal(supplied, tx); return { items: history.get(query.value.split('|').at(-1)!) ?? [], next: null }; },
    },
    principals: { get: async () => { assert.equal(inTransaction, false, 'a held transaction never borrows a second principal connection'); return admin; } },
    objects: { put: async (bytes: Uint8Array, _mediaType: string, supplied: Transaction) => {
      assert.equal(supplied, tx, 'formal object metadata joins the same transaction'); events.push('object-row');
      const sha256 = sha256Hex(bytes); objects.set(sha256, bytes); return { sha256, created: true };
    }, get: async (digest: string) => objects.get(digest) ?? null },
    authorizations: { configureResourceInTransaction: async (by: Principal, object: string, bound: string | null, note: string, supplied: Transaction, revoked = false): Promise<AuthorizationRecord> => {
      assert.equal(supplied, tx); events.push('authorization');
      const decision: AuthorizationRecord = { id: newId('rcd'), digest: 'a'.repeat(64), kind: 'authorization', schema: 'authorization@1', provenance: 'declared', created_at: '2026-11-14T00:00:00.000Z', body: { permission: 'resource_config', subject: '*', object, bound, note, revoked, decided_by: by.id, decided_at: '2026-11-14T00:00:00.000Z', expires_at: null, supersedes: null } };
      history.set(object, [decision, ...(history.get(object) ?? [])]); return decision;
    } },
    vault: {
      secretHistory: async () => [], recentSecrets: async () => [],
      putSecret: async (input: { name: string }) => { events.push('vault-write'); return { name: input.name, revoked: false }; },
      unsetSecret: async (name: string) => { events.push('vault-unset'); return { name, revoked: true }; },
    },
    now: () => new Date('2026-11-14T00:00:00.000Z'),
  } as unknown as VariablePorts;
  return { variables: new RecordVariables(ports), admin, tx, events };
}
function ordered(events: string[], effect?: string) {
  const boundary = events.indexOf('test-environment.permissions');
  const user = events.indexOf('actor-row');
  const variable = events.findIndex(value => value.startsWith('variable-name:'));
  assert.ok(boundary >= 0 && boundary < user && user < variable);
  assert.ok(events.indexOf('authorization') > variable);
  if (effect) assert.ok(events.indexOf(effect) > variable);
}

test('variable set and unset enter the source boundary before actor/name locks and authorization append', async () => {
  const f = fixture();
  await f.variables.setVariable(f.admin, 'SYNTHETIC_VALUE', 'synthetic value', 'synthetic change', { notSecret: true });
  ordered(f.events);
  f.events.length = 0;
  await f.variables.unset(f.admin, 'var', 'SYNTHETIC_VALUE', 'synthetic withdrawal');
  ordered(f.events);
});

test('secret commit enters the boundary before names, vault mutation and audit authorization', async () => {
  const f = fixture();
  await f.variables.setSecrets(f.admin, [{ name: 'SYNTHETIC_SECRET', value: 'synthetic-value', short: true }], 'owner-approved rotation');
  ordered(f.events, 'vault-write');
});

test('secret unset enters the boundary before vault mutation and same-connection audit', async () => {
  const f = fixture();
  await f.variables.unsetSecret(f.admin, 'SYNTHETIC_SECRET', 'synthetic withdrawal');
  ordered(f.events, 'vault-unset');
});

test('read-only name pinning does not serialize all business on the environment mutation boundary', async () => {
  const f = fixture();
  await f.variables.lockNames(['SYNTHETIC_VALUE'], f.tx);
  assert.deepEqual(f.events, ['variable-name:SYNTHETIC_VALUE']);
});

test('a failed database commit after vault unset discloses the already occurred vault effect', async () => {
  const f = fixture(true);
  await assert.rejects(f.variables.unsetSecret(f.admin, 'SYNTHETIC_SECRET', 'synthetic withdrawal'), /密钥库已撤回，审计记录未完成/);
  assert.ok(f.events.includes('vault-unset'));
});
