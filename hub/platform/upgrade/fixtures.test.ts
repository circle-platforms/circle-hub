import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { RecordEnvelope } from '../../../contracts/src/records.ts';
import { RunRecord } from '../../../contracts/src/run.ts';
import { Submission } from '../../../contracts/src/submission.ts';
import { ValidationResult } from '../../../contracts/src/validation.ts';
import { RequestRecord } from '../../../contracts/src/request.ts';
import { canonicalize, digestOf, recordDigest, sha256Hex } from '../../records/api.ts';
import type { CallLogEntry } from '../../records/api.ts';
import { OLD33_MIGRATIONS, old33Checksum } from './testing/old33.ts';
import { buildOld33Fixture, writeOld33Objects } from './testing/fixtures.ts';

test('old33 SQL retains all 33 previous-release migration identities and checksums', () => {
  assert.equal(OLD33_MIGRATIONS.length, 33);
  const manifest = OLD33_MIGRATIONS.map(migration => [migration.version, migration.name, old33Checksum(migration)]);
  assert.deepEqual(OLD33_MIGRATIONS.map(migration => migration.version), Array.from({ length: 33 }, (_, n) => n + 1));
  assert.equal(createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
    '7641d1ab4d2529ed6f14265695356890a2edea662233cfd8f9cbdd0629bcc4b8');
});

test('synthetic retained state has intact logical record, object and content-addressed references', () => {
  const fixture = buildOld33Fixture();
  const records = new Map(fixture.records.map(record => [record.digest, record]));
  const objects = new Map(fixture.objects.map(object => [object.sha256, object]));
  assert.equal(records.size, fixture.records.length);
  assert.equal(new Set([...fixture.retained, ...fixture.archived]).size, fixture.records.length);
  assert.equal(fixture.retained.length + fixture.archived.length, fixture.records.length);
  for (const record of fixture.records) {
    const { index: _index, scope: _scope, uniqueKey: _uniqueKey, ...envelope } = record;
    RecordEnvelope.parse(envelope);
    assert.equal(recordDigest(record), record.digest);
  }
  for (const object of fixture.objects) assert.equal(sha256Hex(object.bytes), object.sha256);
  for (const pack of fixture.handles.packs) {
    const body = records.get(pack.record)!.body as { digest: string; manifest: { files: { sha256: string; size: number }[] } };
    assert.equal(body.digest, pack.digest);
    assert.equal(digestOf(body.manifest), pack.digest);
    assert.equal(Buffer.from(objects.get(pack.digest)!.bytes).toString(), canonicalize(body.manifest));
    for (const file of body.manifest.files) assert.equal(objects.get(file.sha256)!.bytes.byteLength, file.size);
  }
  for (const handle of [fixture.handles.resource, fixture.handles.executor, fixture.handles.variable, ...fixture.handles.secrets]) {
    const decision = records.get(handle.decision)!.body as { bound: string };
    assert.equal(decision.bound, handle.object);
    assert.ok(objects.has(handle.object));
  }
  const composition = records.get(fixture.handles.product.composition)!.body as { root: string; sources: { artifact: string; sha256: string }[] };
  assert.equal(composition.root, fixture.handles.product.root);
  for (const source of composition.sources) {
    assert.ok(records.has(source.artifact));
    assert.ok(objects.has(source.sha256));
  }
  for (const space of fixture.handles.spaces) {
    const version = records.get(space.version)!.body as { space: string; tree: string; entries: { record: string }[]; sources: string[] };
    assert.equal(version.space, space.space);
    assert.ok(objects.has(version.tree));
    assert.equal(version.entries[0]!.record, space.entry);
    assert.deepEqual(version.sources, [space.source]);
    assert.ok(records.has(space.memory));
    assert.ok(records.has(space.memoryVersion));
  }
});

test('previous-release authentication hashes, secret versions, reservations and archived classes are distinct', () => {
  const hash = '9'.repeat(64), passwordHash = 'synthetic-prehashed-password';
  const fixture = buildOld33Fixture({ tokenSha256: hash, passwordHash });
  const activeToken = fixture.rows.find(row => row.table === 'tokens' && row.values.id === fixture.tokenId)!.values;
  assert.equal(activeToken.sha256, hash);
  assert.equal(activeToken.client_id, fixture.oauthClient);
  assert.equal(activeToken.revoked_at, null);
  assert.equal(fixture.rows.find(row => row.table === 'users' && row.values.id === fixture.admin)!.values.password_hash, passwordHash);
  assert.deepEqual(fixture.handles.secrets.map(secret => secret.version), [1, 2]);
  assert.equal(fixture.handles.secrets[0]!.name, fixture.handles.secrets[1]!.name);
  assert.notEqual(fixture.handles.secrets[0]!.entry, fixture.handles.secrets[1]!.entry);
  const secretObjects = fixture.handles.secrets.map(secret => JSON.parse(Buffer.from(fixture.objects.find(object => object.sha256 === secret.object)!.bytes).toString()));
  for (const object of secretObjects) {
    assert.equal(object.digest_rule, 'plain');
    assert.equal(Object.hasOwn(object, 'value'), false);
    assert.equal(Object.hasOwn(object, 'sha256'), false);
  }
  const reservation = fixture.rows.find(row => row.table === 'leases')!.values;
  assert.equal(reservation.run_id, fixture.handles.reservation.run);
  assert.equal(reservation.token, 7);
  assert.equal(reservation.released_at, null);
  const leases = fixture.rows.filter(row => row.table === 'leases').map(row => row.values);
  assert.equal(leases.length, 4);
  const timed = leases.find(row => row.key === 'synthetic/device/timed')!;
  assert.equal(timed.expires_at, '2099-01-01T00:00:00.000Z');
  assert.equal(timed.released_at, null);
  assert.equal(fixture.records.some(record => record.kind === 'run' &&
    (record.body as { run: string }).run === timed.run_id), false, 'a lease identity does not require a task record');
  const archived = new Set(fixture.archived);
  const history = fixture.records.filter(record => archived.has(record.digest));
  assert.deepEqual(history.map(record => record.kind),
    ['run', 'submission', 'validation_result', 'request', 'call_log']);
  assert.deepEqual(history.map(record => record.schema),
    ['run@1', 'submission@1', 'validation@1', 'request@1', 'call_log@1']);
  const run = RunRecord.parse(history[0]!.body), submission = Submission.parse(history[1]!.body);
  const validation = ValidationResult.parse(history[2]!.body), request = RequestRecord.parse(history[3]!.body);
  assert.equal(run.run, submission.run);
  assert.equal(validation.submission, history[1]!.digest);
  assert.equal(validation.run, run.run);
  assert.equal(request.source, history[2]!.digest);
  assert.deepEqual(history.map(record => record.provenance), ['observed', 'declared', 'projected', 'observed', 'observed']);
  const pack = fixture.records.find(record => record.kind === 'pack_version' &&
    (record.body as { digest: string }).digest === run.pack_digest)!;
  assert.equal((pack.body as { kind: string }).kind, 'workflow');
  assert.deepEqual(submission.items.map(item => item.item), run.items.map(item => item.id));
  assert.deepEqual(validation.partitions.delivered.map(item => item.item), run.items.map(item => item.id));
  const call = history[4]!.body as CallLogEntry;
  assert.equal(call.run, run.run);
  assert.equal(call.tool, 'submit_result');
  assert.equal(call.args_digest, digestOf(submission));
  assert.equal(call.args_size, Buffer.byteLength(canonicalize(submission)));
  const physical = fixture.rows.find(row => row.table === 'call_logs')!.values;
  for (const [field, value] of Object.entries(call)) {
    const column = field === 'user' ? 'user_id' : field === 'session' ? 'session_id' : field === 'run' ? 'run_id' : field;
    assert.deepEqual(physical[column], value);
  }
  assert.equal(fixture.rows.filter(row => row.table === 'trace_spans').length, 1);
  assert.equal(fixture.rows.filter(row => row.table === 'memory_heads').length, 2);
  const personal = fixture.records.filter(record => record.scope);
  assert.ok(personal.length > 0);
  for (const record of personal) assert.equal(record.scope!.owner, fixture.member);
});

test('shared object files preserve exact bytes and personal originals stay in scoped payloads', async t => {
  const root = await mkdtemp(join(tmpdir(), 'hub-upgrade-fixture-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = buildOld33Fixture();
  await writeOld33Objects(root, fixture);
  for (const object of fixture.objects) {
    const path = join(root, object.sha256.slice(0, 2), object.sha256);
    if (object.scope) await assert.rejects(stat(path), { code: 'ENOENT' });
    else assert.deepEqual(await readFile(path), Buffer.from(object.bytes));
  }
});
