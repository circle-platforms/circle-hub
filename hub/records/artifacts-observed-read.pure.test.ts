import assert from 'node:assert/strict';
import {test} from 'node:test';
import {RecordArtifacts} from './artifacts.ts';
import {LimitError} from './errors.ts';
import {sha256Hex} from './digest.ts';
import type {Database} from './db.ts';
import type {Artifacts, Authorizations, IngestInput, ObjectStore, RecordStore, RecordInput, PutResult, Transaction} from './api.ts';

// In-memory ports exercise admission and transaction forwarding, never a database or commit implementation.
function port<T extends object>(members: Partial<T>): T {
  return new Proxy(members, {get(target, key) {
    if (key in target) return Reflect.get(target, key);
    return () => { throw new Error(`unexpected port use: ${String(key)}`); };
  }}) as T;
}
function fixture(maxBytes = 1024) {
  const tx: Transaction = {transactionId: 7};
  const calls: Array<{op: string; tx?: Transaction}> = [];
  const written: Uint8Array[] = [];
  const envelopes: RecordInput<unknown>[] = [];
  let scans = 0;
  const objects = port<ObjectStore>({put: async (bytes, mediaType, outer, owner, accountOwned) => {
    calls.push({op: 'objects.put', tx: outer});
    assert.equal(owner, undefined); assert.equal(accountOwned, undefined);
    written.push(Uint8Array.from(bytes));
    return {sha256: sha256Hex(bytes), size: bytes.byteLength, media_type: mediaType, created_at: '2026-11-15T00:00:00.000Z', created: true};
  }});
  const store = port<RecordStore>({
    withTransaction: async (run, outer) => {calls.push({op: 'transaction', tx: outer}); return run(outer ?? tx);},
    find: async (_query, outer) => {calls.push({op: 'find', tx: outer}); return {items: [], next: null};},
    put: async <B>(input: RecordInput<B>, outer?: Transaction): Promise<PutResult<B>> => {
      calls.push({op: 'record.put', tx: outer}); envelopes.push(input);
      return {id: 'synthetic-record', digest: 'a'.repeat(64), kind: input.kind, schema: input.schema,
        provenance: input.provenance, body: input.body, created_at: input.created_at ?? '2026-11-15T00:00:00.000Z', created: true};
    },
  });
  const db = port<Database>({query: async (sql, _values, outer) => {
    assert.equal(sql, 'SELECT pg_advisory_xact_lock($1, hashtext($2))');
    calls.push({op: 'advisory.lock', tx: outer});
    return {rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: []};
  }});
  const api: Artifacts = new RecordArtifacts(db, store, objects, port<Authorizations>({}), {
    maxBytes, now: () => new Date('2026-11-15T00:00:00.000Z'), onCredentialScan: () => {scans++;},
  });
  return {api, tx, calls, written, envelopes, get scans() {return scans;}};
}
function input(): IngestInput {
  return {bytes: new TextEncoder().encode('synthetic observed response'), mediaType: 'application/json',
    origin: {read: {object: 'synthetic:probe:response'}}, author: {user: null}, provenanceType: 'observed',
    visibility: {readers: [], admins: true, packs: [], shareable: false}, readTier: 'function_bytes_only'};
}

test('observed service read uses the supplied transaction and normal artifact body index and scan pipeline', async () => {
  const f = fixture(), value = input();
  const record = await f.api.ingestObservedRead(value, f.tx);
  assert.equal(record.kind, 'source_artifact'); assert.equal(record.body.provenance_type, 'observed');
  assert.equal(record.body.author.user, null); assert.equal(record.body.read_tier, 'function_bytes_only');
  assert.equal(record.body.visibility.admins, true); assert.equal(record.body.visibility.shareable, false);
  assert.equal(record.body.sha256, sha256Hex(value.bytes)); assert.equal(record.body.size, value.bytes.length);
  assert.equal(f.scans, 1); assert.ok(record.body.scan);
  assert.deepEqual(f.calls.map(call => call.op), ['objects.put', 'transaction', 'advisory.lock', 'find', 'record.put']);
  assert.ok(f.calls.every(call => call.tx === f.tx));
  assert.ok(f.envelopes[0].index?.some(row => row.key === 'artifact.object' && row.value === 'synthetic:probe:response'));
  assert.equal(f.envelopes[0].personalOwner, undefined); assert.equal(f.envelopes[0].accountOwned, undefined);
});

test('ordinary read remains outside the new transaction capability', async () => {
  const f = fixture();
  await assert.rejects(f.api.ingest(input(), f.tx), /transactional ingestion requires an upload/);
  assert.deepEqual(f.calls, []); assert.equal(f.scans, 0);
  await f.api.ingest(input());
  assert.equal(f.written.length, 1); assert.equal(f.scans, 1);
});

test('read upload and generated ownership author provenance visibility and tier restrictions reject before writes', async () => {
  const changes: Array<(value: IngestInput) => void> = [
    value => {value.origin = {upload: {session: 'synthetic'}};},
    value => {value.origin = {generated: {generator: 'synthetic@1', inputs: []}};},
    value => {value.author = {user: 'usr_' + '1'.repeat(26)};},
    value => {value.provenanceType = 'projected';},
    value => {value.visibility.admins = false;},
    value => {value.visibility.shareable = true;},
    value => {value.readTier = 'model_readable';},
    value => {value.readTier = 'retain_only';},
    value => {delete value.readTier;},
    value => {value.personalOwner = 'usr_' + '1'.repeat(26);},
    value => {value.personalOwner = '';},
    value => {value.accountOwned = true;},
    value => {value.accountOwned = false;},
  ];
  for (const change of changes) {
    const f = fixture(), value = input(); change(value);
    await assert.rejects(f.api.ingestObservedRead(value, f.tx), TypeError);
    assert.deepEqual(f.calls, []); assert.equal(f.scans, 0);
  }
});

test('an existing transaction is mandatory even at the untyped call boundary', async () => {
  const f = fixture();
  for (const tx of [undefined, null, {}, {transactionId: NaN}]) {
    await assert.rejects(Reflect.apply(f.api.ingestObservedRead, f.api, [input(), tx]), /existing store transaction/);
  }
  assert.deepEqual(f.calls, []);
});

test('normal byte limit origin author visibility masking and derived coverage validation are retained', async () => {
  const large = fixture(2); await assert.rejects(large.api.ingestObservedRead(input(), large.tx), LimitError);
  assert.deepEqual(large.calls, []);
  const bad: unknown[] = [
    {...input(), bytes: 'not bytes'},
    {...input(), mediaType: 'not a media type'},
    {...input(), origin: {read: {object: ''}}},
    {...input(), origin: {read: {object: 'synthetic:probe:response'}, upload: {session: 'synthetic'}}},
    {...input(), author: {user: null, declared: 1}},
    {...input(), visibility: {readers: ['not-a-user'], admins: true, packs: [], shareable: false}},
    {...input(), masking: {dictionary: 'not-a-reference', rules: []}},
    {...input(), derivedCoverage: {}},
  ];
  for (const value of bad) {
    const f = fixture();
    await assert.rejects(Reflect.apply(f.api.ingestObservedRead, f.api, [value, f.tx]), TypeError);
    assert.deepEqual(f.calls, []);
  }
});

test('caller byte and metadata mutation cannot alter the admitted snapshot', async () => {
  const f = fixture(), value = input(), bytes = Uint8Array.from(value.bytes);
  const pending = f.api.ingestObservedRead(value, f.tx);
  value.bytes.fill(0); value.visibility.admins = false; value.origin = {upload: {session: 'changed'}};
  const record = await pending;
  assert.deepEqual(f.written[0], bytes); assert.equal(record.body.sha256, sha256Hex(bytes));
  assert.equal(record.body.visibility.admins, true); assert.ok('read' in record.body.origin);
});
