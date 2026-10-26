import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { sha256Hex, type IngestInput } from './api.ts';
import { openTestRecords } from '../testing/records.ts';
import { startPostgres, type TemporaryPostgres } from '../testing/postgres.ts';
let postgres: TemporaryPostgres;
before(async () => { postgres = await startPostgres(); }); after(() => postgres?.stop());
const input = (bytes: Uint8Array): IngestInput => ({ bytes, mediaType: 'text/plain', origin: { read: { object: 'synthetic:text:owned' } }, author: { user: null }, provenanceType: 'observed', visibility: { readers: [], admins: true, packs: [], shareable: false } });

test('consuming a whole buffer detaches every caller alias and stores the exact immutable bytes', async t => {
  const kit = await openTestRecords({ postgres }); t.after(() => kit.close());
  const bytes = Buffer.alloc(2 * 1024 * 1024, 0x61), alias = bytes.subarray(20, 40), digest = sha256Hex(bytes);
  const pending = kit.artifacts.ingestTransferred(input(bytes));
  assert.equal(bytes.byteLength, 0); assert.equal(alias.byteLength, 0);
  const artifact = await pending; assert.equal(artifact.body.sha256, digest); assert.equal(artifact.body.size, 2 * 1024 * 1024);
  const stored = await kit.objects.get(digest); assert.ok(stored); assert.equal(sha256Hex(stored), digest);
});

test('nontransferable slices are snapshotted before asynchronous work', async t => {
  const kit = await openTestRecords({ postgres }); t.after(() => kit.close());
  const bytes = Buffer.from('synthetic immutable bytes'), expected = Uint8Array.from(bytes);
  const pending = kit.artifacts.ingestTransferred(input(bytes)); bytes.fill(0x62);
  const artifact = await pending; assert.deepEqual(await kit.objects.get(artifact.body.sha256), Buffer.from(expected));
});
