import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { canonicalize, recordDigest } from '../../records/api.ts';
import { exportSecretMetadata, type MetadataSource } from './metadata.ts';
import type { OldRecord } from './state.ts';

const user = 'usr_' + '0'.repeat(26), at = '2026-01-01T00:00:00.000Z';
function inputs(revoked = false) {
  const object = Buffer.from(canonicalize({ schema: 'secret@1', name: 'DEMO_KEY', entry: 'secret.demo_key.' + 'a'.repeat(24), digest_rule: 'plain', length: 16, consumers: [] }));
  const hash = createHash('sha256').update(object).digest('hex');
  const body = { permission: 'resource_config', subject: '*', object: 'secret:DEMO_KEY', revoked: false, bound: hash, supersedes: null, decided_by: user, decided_at: at };
  const row = (body: unknown, seq: string): OldRecord => {
    const meta = { kind: 'authorization', schema: 'authorization@1', provenance: 'declared', created_at: at, body };
    return { ...meta, id: 'rcd_' + '0'.repeat(26), seq, digest: recordDigest(meta) };
  };
  const first = row(body, '1');
  const rows = [first];
  if (revoked) rows.push(row({ ...body, revoked: true, supersedes: first.digest }, '2'));
  let definitions = 0, fingerprints = 0;
  const source: MetadataSource = {
    async definition() { definitions++; return object; },
    async sealedFingerprint() { fingerprints++; return 'b'.repeat(64); },
  };
  return { rows, source, counts: () => ({ definitions, fingerprints }) };
}
test('old metadata export uses verified decisions and ciphertext fingerprints only', async () => {
  const f = inputs();
  const result = await exportSecretMetadata(f.rows, f.source);
  assert.deepEqual(result.issues, []);
  assert.equal(result.files[0]!.versions[0]!.metadata.version, 1);
  assert.equal(result.files[0]!.versions[0]!.metadata.set_by, user);
  assert.equal(result.files[0]!.versions[0]!.metadata.set_at, at);
  assert.equal(result.files[0]!.versions[0]!.metadata.entry, 'secret.demo_key');
  assert.equal(result.files[0]!.versions[0]!.current, true);
  assert.equal(Object.hasOwn(result.files[0]!.versions[0]!.metadata, 'consumers'), false);
  assert.deepEqual(f.counts(), { definitions: 1, fingerprints: 1 });
});
test('withdrawal preserves the last value version, setter and time', async () => {
  const f = inputs(true), result = await exportSecretMetadata(f.rows, f.source);
  assert.deepEqual(result.issues, []);
  assert.equal(result.files[0]!.versions.length, 1);
  assert.equal(result.files[0]!.versions[0]!.metadata.revoked, true);
  assert.equal(result.files[0]!.versions[0]!.metadata.version, 1);
});
test('missing current ciphertext is a per-row failure without an invented value', async () => {
  const f = inputs(); f.source.sealedFingerprint = async () => null;
  const result = await exportSecretMetadata(f.rows, f.source);
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0]!.reason, '现行密钥原密文文件缺失');
});
test('a missing chain or setting facts fails instead of guessing mtime or the exporter identity', async () => {
  const f = inputs();
  const original = f.rows[0]!;
  const body = { ...original.body as object, supersedes: 'c'.repeat(64) };
  f.rows[0] = { ...original, body, digest: recordDigest({ ...original, body }) };
  const result = await exportSecretMetadata(f.rows, f.source);
  assert.equal(result.issues.length, 1);
  assert.deepEqual(result.files, []);
});
test('underlying file errors and object content never become output', async () => {
  const f = inputs(); f.source.definition = async () => { throw new Error('SyntheticOpaquePrivate837'); };
  const result = await exportSecretMetadata(f.rows, f.source);
  assert.equal(result.issues.length, 1);
  assert.doesNotMatch(JSON.stringify(result), /SyntheticOpaquePrivate837/);
});
