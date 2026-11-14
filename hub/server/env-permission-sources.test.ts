import test from 'node:test';
import assert from 'node:assert/strict';
import { PackManifest } from '../../contracts/src/pack.ts';
import { canonicalBytes, sha256Hex, newId, type AuthorizationRecord, type StoredRecord, type TestEnvironmentInheritanceContext, type Transaction } from '../records/api.ts';
import { workflowPack, bytesOf } from '../runs/packs/testing/builder.ts';
import { collectEnvironmentPermissionSources } from './env-permission-sources.ts';

const now = '2026-11-14T00:00:00.000Z';
function fixture(leases = true) {
  const tx = {} as Transaction;
  const objects = new Map<string, Uint8Array>();
  const declared = workflowPack({ id: 'synthetic-booking' });
  const workflow = declared.files['workflow.json'] as Record<string, unknown>;
  workflow.context = ['leases'];
  if (leases) workflow.leases = { prefix: 'synthetic/' };
  const files = Object.entries(declared.files).map(([path, value]) => {
    const bytes = bytesOf(value), sha256 = sha256Hex(bytes); objects.set(sha256, bytes);
    return { path, size: bytes.byteLength, sha256 };
  });
  files.sort((a,b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const manifest = PackManifest.parse({ schema: 'pack@1', id: declared.id, version: declared.version, kind: 'workflow', title: '合成声明', description: '合成事务事实', files });
  const digest = sha256Hex(canonicalBytes(manifest));
  const publisher = newId('usr');
  const rows: StoredRecord[] = [{ id: newId('rcd'), kind: 'pack_version', schema: 'pack_version@1', provenance: 'observed', digest: 'a'.repeat(64), created_at: now,
    body: { pack: manifest.id, version: manifest.version, kind: manifest.kind, digest, manifest } }];
  const authorizations: AuthorizationRecord[] = [];
  const decision = (permission: AuthorizationRecord['body']['permission'], subject: string, object: string, bound: string | null, revoked = false): AuthorizationRecord => {
    const row: AuthorizationRecord = { id: newId('rcd'), kind: 'authorization', schema: 'authorization@1', provenance: 'observed', digest: sha256Hex(canonicalBytes([permission, subject, object, bound, revoked, authorizations.length])), created_at: now,
      body: { permission, subject, object, bound, revoked, decided_by: publisher, decided_at: now, expires_at: null, note: null, supersedes: null } };
    authorizations.push(row); return row;
  };
  decision('publish', publisher, manifest.id + '@' + manifest.version, digest);
  decision('assign', '*', manifest.id, null);
  let reads = 0;
  const context: TestEnvironmentInheritanceContext = {
    tx, at: now, authorizations,
    store: {
      get: async () => null,
      list: async <B>(_query: unknown, actual?: Transaction) => { assert.equal(actual, tx); reads++; return { items: rows as StoredRecord<B>[], next: null }; },
      find: async <B>(_query: unknown, actual?: Transaction) => { assert.equal(actual, tx); reads++; return { items: rows as StoredRecord<B>[], next: null }; },
    },
    objects: { get: async (hash, actual) => { assert.equal(actual, tx); reads++; return objects.get(hash) ?? null; } },
  };
  return { context, rows, objects, manifest, decision, publisher, reads: () => reads };
}

test('formal reservation declaration is read with the supplied transaction, without lease-holder history', async () => {
  const f = fixture();
  const result = await collectEnvironmentPermissionSources(f.context);
  assert.equal(result.workflows.length, 1);
  assert.equal(result.workflows[0].id, 'synthetic-booking');
  assert.equal(result.workflows[0].prefix, 'synthetic/');
  assert.equal(result.workflows[0].installedMethod, false);
  assert.deepEqual(result.executors, []);
  assert.ok(f.reads() >= 2);
});

test('context access alone is not reservation authority and withdrawn publications are excluded', async () => {
  const contextOnly = fixture(false);
  assert.deepEqual((await collectEnvironmentPermissionSources(contextOnly.context)).workflows, []);
  const withdrawn = fixture();
  withdrawn.decision('publish', withdrawn.publisher, withdrawn.manifest.id + '@' + withdrawn.manifest.version, null, true);
  assert.deepEqual((await collectEnvironmentPermissionSources(withdrawn.context)).workflows, []);
});

test('missing or tampered workflow bytes do not silently produce an empty permission source', async () => {
  for (const tamper of [false, true]) {
    const f = fixture(), file = f.manifest.files.find(file => file.path === 'workflow.json')!;
    if (tamper) f.objects.set(file.sha256, Buffer.from('synthetic tamper'));
    else f.objects.delete(file.sha256);
    await assert.rejects(collectEnvironmentPermissionSources(f.context), /原件缺失或摘要不符/);
  }
});

test('a valid assignment with a missing published record remains a missing fact', async () => {
  const f = fixture(); f.rows.length = 0;
  await assert.rejects(collectEnvironmentPermissionSources(f.context), /发布原件缺失或不符/);
});

test('manifest mismatch is refused before interpreting authored declarations', async () => {
  const f = fixture();
  (f.rows[0].body as {digest: string}).digest = 'f'.repeat(64);
  await assert.rejects(collectEnvironmentPermissionSources(f.context), /记录与清单不一致/);
});
