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

test('simultaneous object reads isolate mutable bytes and a corrupt sibling cannot poison a healthy read',async t=>{
 const kit=await openTestRecords({postgres});t.after(()=>kit.close());
 const good=await kit.objects.put(Buffer.from('synthetic healthy concurrent bytes'),'text/plain'),bad=await kit.objects.put(Buffer.from('synthetic corrupted concurrent bytes'),'text/plain');
 const [first,second]=await Promise.all([kit.objects.get(good.sha256),kit.objects.get(good.sha256)]);first![0]=0;assert.equal(Buffer.from(second!).toString(),'synthetic healthy concurrent bytes');
 const path=join(kit.dataDir,'objects',bad.sha256.slice(0,2),bad.sha256);await chmod(path,0o600);await writeFile(path,'synthetic altered bytes');
 const results=await Promise.allSettled([kit.objects.get(good.sha256),kit.objects.get(bad.sha256)]);assert.equal(results[0].status,'fulfilled');assert.equal(results[1].status,'rejected');
 assert.equal(Buffer.from(await kit.objects.get(good.sha256)??[]).toString(),'synthetic healthy concurrent bytes');
});

test('personal byte batches recheck purge and payload hashes on every read and keep healthy siblings available',async t=>{
 const kit=await openTestRecords({postgres});t.after(()=>kit.close());
 const {Database,createPool}=await import('./db.ts');const db=new Database(createPool(kit.database));t.after(()=>db.end());
 const {user:admin}=await kit.principals.bootstrapAdmin('synthetic-object-admin'),owner=await kit.principals.createUser(admin,'synthetic-object-owner'),other=await kit.principals.createUser(admin,'synthetic-object-other');
 const bytes=Buffer.from('synthetic private batched bytes'),healthy=Buffer.from('synthetic other private bytes');
 const a=await kit.objects.put(bytes,'text/plain',undefined,owner.id),b=await kit.objects.put(healthy,'text/plain',undefined,other.id);
 const first=await Promise.all([kit.objects.get(a.sha256),kit.objects.get(b.sha256)]);assert.deepEqual(Buffer.from(first[0]!),bytes);assert.deepEqual(Buffer.from(first[1]!),healthy);
 // Privileged offline corruption in this disposable database, never an application-role write.
 await db.query('ALTER TABLE personal_payloads DISABLE TRIGGER personal_payloads_immutable');
 await db.query('ALTER TABLE personal_payloads DROP CONSTRAINT personal_payloads_check');
 try{await db.query('UPDATE personal_payloads SET data=$3 WHERE owner=$1 AND sha256=$2',[owner.id,a.sha256,Buffer.from('synthetic changed payload')]);}finally{await db.query("ALTER TABLE personal_payloads ADD CONSTRAINT personal_payloads_check CHECK(encode(sha256(data),'hex')=sha256) NOT VALID");await db.query('ALTER TABLE personal_payloads ENABLE TRIGGER personal_payloads_immutable');}
 const reads=await Promise.allSettled([kit.objects.get(a.sha256),kit.objects.get(b.sha256)]);assert.equal(reads[0].status,'rejected');assert.ok(reads[0].status==='rejected'&&reads[0].reason instanceof IntegrityError);assert.equal(reads[1].status,'fulfilled');
 const epoch=(await kit.personalPayloads!.scope(owner.id)).epoch;await kit.personalPayloads!.purge(owner,epoch);
 assert.equal(await kit.objects.get(a.sha256),null);assert.deepEqual(Buffer.from(await kit.objects.get(b.sha256)??[]),healthy);
 await db.query('ALTER TABLE personal_payloads VALIDATE CONSTRAINT personal_payloads_check');
 const local=await kit.personalSync!.state(owner);await kit.personalSync!.resume(owner,local.epoch,local.state_version);
 assert.equal(await kit.objects.get(a.sha256),null);await kit.objects.put(bytes,'text/plain',undefined,owner.id);assert.deepEqual(Buffer.from(await kit.objects.get(a.sha256)??[]),bytes);
});
