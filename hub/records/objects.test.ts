import assert from 'node:assert/strict';
import { chmod, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { startPostgres } from '../testing/postgres.ts';
import type { TemporaryPostgres } from '../testing/postgres.ts';
import { openTestRecords } from '../testing/records.ts';
import { sha256Hex } from './digest.ts';
import { IntegrityError, LimitError } from './errors.ts';

let postgres: TemporaryPostgres;
before(async () => {
  postgres = await startPostgres();
});
after(async () => {
  await postgres?.stop();
});

test('bytes are stored once under objects/ab/<sha256>, read-only, and read back verified', async (t) => {
  const kit = await openTestRecords({ postgres });
  t.after(() => kit.close());
  const bytes = Buffer.from('合成的原件字节\n', 'utf8');
  const sha = sha256Hex(bytes);
  const first = await kit.objects.put(bytes, 'text/markdown; charset=utf-8');
  assert.deepEqual({ ...first, created_at: undefined }, { sha256: sha, size: bytes.byteLength, media_type: 'text/markdown; charset=utf-8', created: true, created_at: undefined });
  const path = join(kit.dataDir, 'objects', sha.slice(0, 2), sha);
  assert.deepEqual(await readFile(path), bytes);
  assert.equal((await stat(path)).mode & 0o777, 0o400);
  assert.equal((await stat(join(kit.dataDir, 'objects', sha.slice(0, 2)))).mode & 0o777, 0o700);
  const again = await kit.objects.put(bytes, 'text/plain');
  assert.equal(again.created, false);
  assert.equal(again.media_type, 'text/markdown; charset=utf-8');
  assert.deepEqual(Buffer.from((await kit.objects.get(sha)) ?? []), bytes);
  assert.equal(await kit.objects.has(sha), true);
  assert.deepEqual(await readdir(join(kit.dataDir, 'objects', sha.slice(0, 2))), [sha]);
  assert.equal(await kit.objects.get('0'.repeat(64)), null);
  assert.equal(await kit.objects.get('../../etc/passwd'), null);
  assert.equal(await kit.objects.stat('nope'), null);
});

test('an altered object is detected on every read and never overwritten', async (t) => {
  const kit = await openTestRecords({ postgres });
  t.after(() => kit.close());
  const bytes = Buffer.from('original bytes');
  const { sha256 } = await kit.objects.put(bytes, 'application/octet-stream');
  const path = join(kit.dataDir, 'objects', sha256.slice(0, 2), sha256);
  await chmod(path, 0o600);
  await writeFile(path, 'altered bytes');
  await assert.rejects(kit.objects.get(sha256), IntegrityError);
  // Storing the original again does not repair it silently: the corruption is reported and the file is kept for inspection.
  await assert.rejects(kit.objects.put(bytes, 'application/octet-stream'), IntegrityError);
  assert.equal(await readFile(path, 'utf8'), 'altered bytes');
  assert.deepEqual(await readdir(join(kit.dataDir, 'objects', sha256.slice(0, 2))), [sha256]);
});

test('the size cap refuses the whole object, and media types are validated', async (t) => {
  const kit = await openTestRecords({ postgres, limits: { maxUploadBytes: 1024 } });
  t.after(() => kit.close());
  await assert.rejects(kit.objects.put(Buffer.alloc(1025, 1), 'application/octet-stream'), LimitError);
  assert.ok((await kit.objects.put(Buffer.alloc(1024, 1), 'application/octet-stream')).created);
  for (const mediaType of ['', 'text', 'text/', '/plain', 'text/plain\nX: y', 'a'.repeat(201) + '/b']) {
    await assert.rejects(kit.objects.put(Buffer.from('x'), mediaType), TypeError, mediaType);
  }
  assert.deepEqual(await readdir(join(kit.dataDir, 'objects')).then((entries) => entries.length), 1);
});
