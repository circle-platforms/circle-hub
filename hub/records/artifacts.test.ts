import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { chmod, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { gzipSync } from 'node:zlib';
import pg from 'pg';
import { PROTOCOL_CODES } from '../../contracts/generated/protocol.ts';
import { labelOf } from '../../contracts/generated/vocabulary.ts';
import { startPostgres } from '../testing/postgres.ts';
import type { TemporaryPostgres } from '../testing/postgres.ts';
import { openTestRecords } from '../testing/records.ts';
import type { TestRecordsKit } from '../testing/records.ts';
import type { ActionBody, IngestInput, Principal, Visibility } from './api.ts';
import { artifactShareKey } from './constants.ts';
import { sha256Hex } from './digest.ts';
import { IntegrityError, LimitError, RecordsError } from './errors.ts';

let postgres: TemporaryPostgres;
before(async () => {
  postgres = await startPostgres();
});
after(async () => {
  await postgres?.stop();
});

async function dump(kit: TestRecordsKit): Promise<string> {
  const client = new pg.Client({ ...kit.database, ssl: false });
  await client.connect();
  try {
    const tables = ['records', 'record_index', 'objects', 'call_logs'];
    const parts: string[] = [];
    for (const table of tables) parts.push(JSON.stringify((await client.query(`SELECT * FROM ${table}`)).rows));
    return parts.join('\n');
  } finally {
    await client.end();
  }
}

async function people(kit: TestRecordsKit) {
  const { user: admin } = await kit.principals.bootstrapAdmin('管理员');
  const uploader = await kit.principals.createUser(admin, '上传者');
  const other = await kit.principals.createUser(admin, '旁人');
  const packUser = await kit.principals.createUser(admin, '包用户');
  const shared = await kit.principals.createUser(admin, '受众');
  const p = (user: { id: string; name: string; role: 'user' | 'admin' }): Principal => ({ id: user.id, name: user.name, role: user.role });
  return { admin: p(admin), uploader: p(uploader), other: p(other), packUser: p(packUser), shared: p(shared) };
}

function upload(by: Principal, bytes: Uint8Array, visibility?: Partial<Visibility>): IngestInput {
  return {
    bytes,
    mediaType: 'text/markdown',
    origin: { upload: { session: 'sess-synthetic-1', message: 'msg-7' } },
    author: { user: by.id, declared: '合成作者' },
    provenanceType: 'declared',
    visibility: { readers: [by.id], admins: true, packs: [], shareable: true, ...visibility },
    name: '用例说明.md',
  };
}

test('a clean upload stores the bytes and a source_artifact record; repeating it returns the same record', async (t) => {
  const kit = await openTestRecords({ postgres });
  t.after(() => kit.close());
  const { uploader, admin } = await people(kit);
  const bytes = Buffer.from('# 用例\n\n预期：返回成功。\n');
  const artifact = await kit.artifacts.ingest(upload(uploader, bytes));
  assert.equal(artifact.kind, 'source_artifact');
  assert.equal(artifact.schema, 'source_artifact@1');
  assert.equal(artifact.provenance, 'declared');
  const body = artifact.body;
  assert.equal(body.sha256, sha256Hex(bytes));
  assert.equal(body.size, bytes.byteLength);
  assert.equal(body.media_type, 'text/markdown');
  assert.equal(body.read_tier, 'model_readable');
  assert.equal(body.provenance_type, 'declared');
  assert.deepEqual(body.origin, { upload: { session: 'sess-synthetic-1', message: 'msg-7' } });
  assert.deepEqual(body.author, { user: uploader.id, declared: '合成作者' });
  assert.deepEqual(body.scan, { scanner: 'credential-scan@2', inspected: true, clean: true, findings: [], truncated: false });
  assert.deepEqual(Buffer.from((await kit.artifacts.source(uploader, body.sha256))?.bytes ?? []), bytes);
  assert.deepEqual(Buffer.from((await kit.artifacts.trustedBytes(body.sha256)) ?? []), bytes);
  const again = await kit.artifacts.ingest(upload(uploader, bytes));
  assert.equal(again.digest, artifact.digest);
  // The same bytes uploaded by an admin are another record of the same object.
  const second = await kit.artifacts.ingest(upload(admin, bytes));
  assert.notEqual(second.digest, artifact.digest);
  assert.equal((await kit.artifacts.records(body.sha256)).length, 2);
  assert.deepEqual(await readdir(join(kit.dataDir, 'objects', body.sha256.slice(0, 2))), [body.sha256]);
});

test('an upload with a plaintext credential is refused: no bytes kept, only the digest and the scan conclusion', async (t) => {
  const kit = await openTestRecords({ postgres });
  t.after(() => kit.close());
  const { uploader } = await people(kit);
  const secret = `Synth${randomBytes(6).toString('hex')}!9`;
  const bytes = Buffer.from(`# 测试床\n\n登录用户：synthetic\npassword: ${secret}\n`);
  const sha = sha256Hex(bytes);
  await assert.rejects(kit.artifacts.ingest({ ...upload(uploader, bytes), run: null }), (error: unknown) => {
    assert.ok(error instanceof RecordsError);
    assert.equal(error.code, 'CREDENTIAL_IN_UPLOAD');
    assert.equal(error.fix, PROTOCOL_CODES.CREDENTIAL_IN_UPLOAD.fix);
    assert.match(error.message, /第 4 行第 1 列（password_assignment）/);
    assert.equal(error.message.includes(secret), false);
    assert.equal(error.detail.sha256, sha);
    assert.deepEqual(error.detail.findings, [{ detector: 'password_assignment', offset: bytes.indexOf('password'), line: 4, column: 1 }]);
    return true;
  });
  assert.equal(await kit.objects.has(sha), false);
  assert.equal(await kit.artifacts.trustedBytes(sha), null);
  assert.equal(await kit.artifacts.source(uploader, sha), null);
  assert.deepEqual(await kit.artifacts.records(sha), []);
  assert.deepEqual(await readdir(join(kit.dataDir, 'objects')), []);
  const refusals = await kit.store.find<ActionBody>({ key: 'artifact.refused', value: sha, kind: 'action' });
  assert.equal(refusals.items.length, 1);
  const action = refusals.items[0].body;
  assert.equal(action.action, 'validate');
  assert.equal(action.acceptance, 'not_accepted');
  assert.deepEqual(action.codes, ['CREDENTIAL_IN_UPLOAD']);
  assert.deepEqual(action.detail.subject, { sha256: sha, size: bytes.byteLength, media_type: 'text/markdown' });
  assert.equal((action.detail.scan as { clean: boolean }).clean, false);
  const everything = await dump(kit);
  assert.equal(everything.includes(secret), false);
  assert.equal(everything.includes('登录用户'), false);
});

test('a connector read with a credential is kept at read tier retain_only and its text is not returned', async (t) => {
  const kit = await openTestRecords({ postgres });
  t.after(() => kit.close());
  const { admin } = await people(kit);
  const bytes = Buffer.from(["config",":\n  ap","i_key ","= 'abc","123def","456ghi","'\n"].join(''));
  const artifact = await kit.artifacts.ingest({
    bytes,
    mediaType: 'text/plain',
    origin: { read: { object: 'manuals:file:spec/config.md@3', resource: 'manual-store', action: null } },
    author: { user: null },
    provenanceType: 'observed',
    visibility: { readers: [], admins: true, packs: [], shareable: false },
  });
  assert.equal(artifact.body.read_tier, 'retain_only');
  assert.equal(artifact.body.scan.clean, false);
  assert.equal(artifact.provenance, 'observed');
  const view = await kit.artifacts.text(admin, artifact.body.sha256);
  assert.deepEqual({ readable: view?.readable, text: view?.text, note: view?.note }, { readable: false, text: undefined, note: labelOf('validity_status', 'credential_unreadable') });
  // A read by reference never returns the original of a credential hit (B02 R[4]), to models and functions alike.
  for (const consumer of ['model', 'function', 'human'] as const) {
    const source = await kit.artifacts.source(admin, artifact.body.sha256, { consumer });
    assert.deepEqual(
      { bytes: source?.bytes, readTier: source?.readTier, note: source?.note, size: source?.size },
      { bytes: null, readTier: 'retain_only', note: labelOf('validity_status', 'credential_unreadable'), size: bytes.byteLength },
      consumer,
    );
  }
  // The bytes are still kept, for trusted maintenance only (backup verification, re-scanning).
  assert.deepEqual(Buffer.from((await kit.artifacts.trustedBytes(artifact.body.sha256)) ?? []), bytes);
  const restrictedBytes = Buffer.from('函数才能读的字节');
  const restricted = await kit.artifacts.ingest({ ...upload(admin, restrictedBytes), readTier: 'function_bytes_only' });
  assert.equal((await kit.artifacts.text(admin, restricted.body.sha256))?.note, labelOf('read_tier', 'function_bytes_only'));
  // function_bytes_only: bytes for functions only (B02 F[5]).
  assert.equal((await kit.artifacts.source(admin, restricted.body.sha256))?.bytes, null);
  assert.deepEqual(Buffer.from((await kit.artifacts.source(admin, restricted.body.sha256, { consumer: 'function' }))?.bytes ?? []), restrictedBytes);
  await assert.rejects(kit.artifacts.source(admin, restricted.body.sha256, { consumer: 'pack' as never }), TypeError);
  // The same bytes in a later record a model may read: that record decides every view, the same one for all of them.
  const later = await kit.artifacts.ingest({ ...upload(admin, restrictedBytes), name: '另一份.md' });
  const view2 = await kit.artifacts.text(admin, restricted.body.sha256);
  assert.equal(view2?.readable, true);
  assert.equal(view2?.text, '函数才能读的字节');
  assert.equal(view2?.artifact.digest, later.digest);
  assert.equal((await kit.artifacts.readable(admin, restricted.body.sha256))?.digest, later.digest);
  assert.equal((await kit.artifacts.source(admin, restricted.body.sha256))?.artifact.digest, later.digest);
});

test('a credential hit by the newest scanner makes the bytes retain_only for every record of them', async (t) => {
  const kit = await openTestRecords({ postgres });
  t.after(() => kit.close());
  const { admin } = await people(kit);
  const bytes = Buffer.from('settings\nDB_PASS=Synth3tic9x\n');
  const sha = sha256Hex(bytes);
  // A record written by an older scanner that missed the credential (simulated directly in the store).
  await kit.objects.put(bytes, 'text/plain');
  const old = {
    sha256: sha,
    size: bytes.byteLength,
    media_type: 'text/plain',
    name: null,
    origin: { generated: { generator: 'synthetic-exporter@1', inputs: [], read_back: null } },
    author: { user: null, declared: null },
    captured_at: '2026-10-01T00:00:00.000Z',
    provenance_type: 'observed',
    read_tier: 'model_readable',
    visibility: { readers: [], admins: true, packs: [], shareable: false },
    scan: { scanner: 'credential-scan@1', inspected: true, clean: true, findings: [], truncated: false },
  };
  await kit.store.put({ kind: 'source_artifact', schema: 'source_artifact@1', provenance: 'observed', body: old, index: [{ key: 'artifact.sha256', value: sha }] });
  assert.equal((await kit.artifacts.text(admin, sha))?.readable, true);
  // The current scanner finds it: a new record of the same bytes, and every view turns to retain_only.
  const rescanned = await kit.artifacts.ingest({ bytes, mediaType: 'text/plain', origin: { read: { object: 'manuals:file:settings@2' } }, author: { user: null }, provenanceType: 'observed', visibility: { readers: [], admins: true, packs: [], shareable: false } });
  assert.equal(rescanned.body.scan.findings.length, 1);
  assert.deepEqual({ readable: (await kit.artifacts.text(admin, sha))?.readable, tier: (await kit.artifacts.source(admin, sha))?.readTier }, { readable: false, tier: 'retain_only' });
  assert.equal((await kit.artifacts.source(admin, sha, { consumer: 'function' }))?.bytes, null);
});

test('a share covers the shared record only: other uploads of the same bytes stay private (B02 R[3], B04 R[3])', async (t) => {
  const kit = await openTestRecords({ postgres });
  t.after(() => kit.close());
  const { admin, uploader: dave, other: bob, shared: carol } = await people(kit);
  const same = Buffer.from('shared synthetic bytes');
  const daveUpload = await kit.artifacts.ingest({ ...upload(dave, same), name: 'dave-private-name.txt', origin: { upload: { session: 'dave-session' } } });
  const bobUpload = await kit.artifacts.ingest({ ...upload(bob, same), name: 'bob.txt', origin: { upload: { session: 'bob-session' } } });
  await kit.authorizations.share(admin, artifactShareKey(bobUpload), [carol.id]);
  assert.equal(await kit.artifacts.canRead(carol, bobUpload), true);
  assert.equal(await kit.artifacts.canRead(carol, daveUpload), false);
  const seen = await kit.artifacts.readable(carol, sha256Hex(same));
  assert.equal(seen?.digest, bobUpload.digest);
  assert.equal((await kit.artifacts.text(carol, sha256Hex(same)))?.artifact.body.name, 'bob.txt');
  assert.equal(JSON.stringify(await kit.artifacts.source(carol, sha256Hex(same))).includes('dave'), false);
  assert.throws(() => artifactShareKey({ kind: 'run', digest: bobUpload.digest }), TypeError);
});

test('reads re-read the account: a disabled or demoted admin loses access at once', async (t) => {
  const kit = await openTestRecords({ postgres });
  t.after(() => kit.close());
  const { admin, uploader } = await people(kit);
  const artifact = await kit.artifacts.ingest(upload(uploader, Buffer.from('synthetic upload for admins')));
  const second = await kit.principals.createUser(admin, '二号管理员', 'admin');
  const stale: Principal = { id: second.id, name: second.name, role: 'admin' };
  assert.equal(await kit.artifacts.canRead(stale, artifact), true);
  await kit.principals.setDisabled(admin, second.id, true);
  assert.equal(await kit.artifacts.canRead(stale, artifact), false);
  assert.equal(await kit.artifacts.readable(stale, artifact.body.sha256), null);
  assert.equal(await kit.artifacts.text(stale, artifact.body.sha256), null);
  assert.equal(await kit.artifacts.source(stale, artifact.body.sha256), null);
  await kit.principals.setDisabled(admin, second.id, false);
  await kit.principals.setRole(admin, second.id, 'user');
  assert.equal(await kit.artifacts.canRead(stale, artifact), false);
  // A user who claims the admin role is still a user.
  const claimed = await kit.principals.createUser(admin, '自称管理员');
  assert.equal(await kit.artifacts.canRead({ id: claimed.id, name: claimed.name, role: 'admin' }, artifact), false);
});

test('recorded bytes that went missing are reported as data loss, not as absent', async (t) => {
  const kit = await openTestRecords({ postgres });
  t.after(() => kit.close());
  const { uploader } = await people(kit);
  const bytes = Buffer.from('合成的原件');
  const artifact = await kit.artifacts.ingest(upload(uploader, bytes));
  const sha = artifact.body.sha256;
  const directory = join(kit.dataDir, 'objects', sha.slice(0, 2));
  await chmod(directory, 0o700);
  await rm(join(directory, sha), { force: true });
  await assert.rejects(kit.artifacts.source(uploader, sha), IntegrityError);
  await assert.rejects(kit.artifacts.text(uploader, sha), IntegrityError);
  await assert.rejects(kit.artifacts.trustedBytes(sha), IntegrityError);
  await assert.rejects(kit.objects.get(sha), IntegrityError);
  assert.equal(await kit.objects.get(sha256Hex('never stored')), null);
});

test('bytes the scanner cannot read are accepted and recorded as not inspected', async (t) => {
  const kit = await openTestRecords({ postgres });
  t.after(() => kit.close());
  const { uploader } = await people(kit);
  const archive = gzipSync(Buffer.from('notes\npassword=Synth3tic9x\n'));
  const artifact = await kit.artifacts.ingest({ ...upload(uploader, archive), mediaType: 'application/gzip' });
  assert.deepEqual(artifact.body.scan, { scanner: 'credential-scan@2', inspected: false, clean: false, findings: [], truncated: false });
  assert.equal(artifact.body.read_tier, 'model_readable');
});

test('visibility matrix (B02 R[3]); absent and forbidden are indistinguishable', async (t) => {
  const kit = await openTestRecords({ postgres });
  t.after(() => kit.close());
  const who = await people(kit);
  const { admin, uploader, other, packUser, shared } = who;
  await kit.authorizations.assign(admin, packUser.id, 'case-review');
  const bytes = () => Buffer.from(`synthetic ${randomBytes(8).toString('hex')}`);
  const runUpload = await kit.artifacts.ingest(upload(uploader, bytes()));
  const excerpt = await kit.artifacts.ingest(upload(uploader, bytes(), { admins: false, shareable: false }));
  const personalRead = await kit.artifacts.ingest({
    bytes: bytes(),
    mediaType: 'text/plain',
    origin: { read: { object: 'plm:story:9001@2', resource: 'plm-personal' } },
    author: { user: null },
    provenanceType: 'observed',
    visibility: { readers: [uploader.id], admins: false, packs: [], shareable: false },
  });
  const packRead = await kit.artifacts.ingest({
    bytes: bytes(),
    mediaType: 'text/plain',
    origin: { read: { object: 'build:catalog:synthetic-build@1', resource: 'build-site' } },
    author: { user: null },
    provenanceType: 'observed',
    visibility: { readers: [], admins: true, packs: ['case-review'], shareable: false },
  });
  // An admin share widens a shareable upload; a share of a connector read changes nothing.
  await kit.authorizations.share(admin, artifactShareKey(runUpload), [shared.id]);
  await kit.authorizations.share(admin, artifactShareKey(packRead), [shared.id]);
  const expected: Record<string, Record<string, boolean>> = {
    runUpload: { admin: true, uploader: true, other: false, packUser: false, shared: true },
    excerpt: { admin: false, uploader: true, other: false, packUser: false, shared: false },
    personalRead: { admin: false, uploader: true, other: false, packUser: false, shared: false },
    packRead: { admin: true, uploader: false, other: false, packUser: true, shared: false },
  };
  const artifacts = { runUpload, excerpt, personalRead, packRead };
  for (const [artifactName, row] of Object.entries(expected)) {
    for (const [personName, allowed] of Object.entries(row)) {
      const person = who[personName as keyof typeof who];
      const artifact = artifacts[artifactName as keyof typeof artifacts];
      assert.equal(await kit.artifacts.canRead(person, artifact), allowed, `${personName} reading ${artifactName}`);
      assert.equal((await kit.artifacts.readable(person, artifact.body.sha256))?.digest ?? null, allowed ? artifact.digest : null, `${personName} readable ${artifactName}`);
    }
  }
  // Removing the share or the assignment takes the access away again.
  await kit.authorizations.unshare(admin, artifactShareKey(runUpload), shared.id);
  await kit.authorizations.unassign(admin, packUser.id, 'case-review');
  assert.equal(await kit.artifacts.canRead(shared, runUpload), false);
  assert.equal(await kit.artifacts.canRead(packUser, packRead), false);
  // Forbidden and absent: the same null for readable() and text().
  const absent = sha256Hex('never stored');
  assert.equal(await kit.artifacts.readable(other, runUpload.body.sha256), null);
  assert.equal(await kit.artifacts.readable(other, absent), null);
  assert.equal(await kit.artifacts.text(other, runUpload.body.sha256), null);
  assert.equal(await kit.artifacts.text(other, absent), null);
  assert.equal(await kit.artifacts.readable(other, 'not-a-digest'), null);
});

test('text views strip NUL while the stored bytes stay intact', async (t) => {
  const kit = await openTestRecords({ postgres });
  t.after(() => kit.close());
  const { uploader } = await people(kit);
  const bytes = Buffer.concat([Buffer.from('命令手册'), Buffer.from([0, 0]), Buffer.from(' 第二节'), Buffer.from([0])]);
  const artifact = await kit.artifacts.ingest(upload(uploader, bytes));
  const view = await kit.artifacts.text(uploader, artifact.body.sha256);
  assert.equal(view?.readable, true);
  assert.equal(view?.text, '命令手册 第二节');
  assert.equal(view?.truncated, false);
  const stored = Buffer.from((await kit.artifacts.source(uploader, artifact.body.sha256))?.bytes ?? []);
  assert.deepEqual(stored, bytes);
  assert.equal(stored.includes(0), true);
  const cut = await kit.artifacts.text(uploader, artifact.body.sha256, { maxBytes: 4 });
  assert.equal(cut?.text, '命');
  assert.equal(cut?.truncated, true);
});

test('ingest validates provenance, visibility rules and the size cap', async (t) => {
  const kit = await openTestRecords({ postgres, limits: { maxUploadBytes: 2048 } });
  t.after(() => kit.close());
  const { uploader } = await people(kit);
  const good = upload(uploader, Buffer.from('ok'));
  await assert.rejects(kit.artifacts.ingest({ ...good, bytes: Buffer.alloc(2049, 0x61) }), LimitError);
  await assert.rejects(kit.artifacts.ingest({ ...good, mediaType: 'not a type' }), TypeError);
  await assert.rejects(kit.artifacts.ingest({ ...good, provenanceType: 'trusted' as never }), TypeError);
  await assert.rejects(kit.artifacts.ingest({ ...good, readTier: 'public' as never }), TypeError);
  await assert.rejects(kit.artifacts.ingest({ ...good, origin: {} as never }), TypeError);
  await assert.rejects(kit.artifacts.ingest({ ...good, origin: { upload: { session: null }, read: { object: 'a:b:c' } } as never }), TypeError);
  await assert.rejects(kit.artifacts.ingest({ ...good, origin: { read: { object: 'not an object id' } } }), TypeError);
  // generator@major as contracts Versioned: no leading-zero major, no upper case.
  for (const generator of ['renderer@01', 'Renderer@1', 'renderer', '@1']) {
    await assert.rejects(kit.artifacts.ingest({ ...good, origin: { generated: { generator, inputs: [] } } }), TypeError, generator);
  }
  await assert.rejects(
    kit.artifacts.ingest({ ...good, origin: { read: { object: 'plm:bug:1@1' } }, visibility: { readers: [], admins: true, packs: [], shareable: true } }),
    /never shareable/,
  );
  await assert.rejects(kit.artifacts.ingest({ ...good, visibility: { readers: [uploader.id], admins: false, packs: [], shareable: true } }), /admins may read/);
  await assert.rejects(kit.artifacts.ingest({ ...good, visibility: { readers: ['someone'], admins: true, packs: [], shareable: false } }), TypeError);
  await assert.rejects(kit.artifacts.ingest({ ...good, visibility: { readers: [], admins: true, packs: ['Bad Pack'], shareable: false } }), TypeError);
  await assert.rejects(kit.artifacts.ingest({ ...good, author: { user: 'nobody' } }), TypeError);
  await assert.rejects(kit.artifacts.ingest({ ...good, name: `bad${String.fromCharCode(10)}name` }), TypeError);
  await assert.rejects(kit.artifacts.ingest({ ...good, capturedAt: 'yesterday' }), TypeError);
  await assert.rejects(kit.artifacts.ingest({ ...good, capturedAt: '+010000-01-01T00:00:00.000Z' }), TypeError);
  // An object id longer than an index value is refused before any byte is written (objects are never deleted).
  const read = { ...good, origin: { read: { object: `sys:doc:${'x'.repeat(1000)}` } }, visibility: { readers: [], admins: true, packs: [], shareable: false } };
  await assert.rejects(kit.artifacts.ingest(read), TypeError);
  const many = Array.from({ length: 65 }, (_, index) => `pack-${index}`);
  await assert.rejects(kit.artifacts.ingest({ ...good, visibility: { readers: [uploader.id], admins: true, packs: many, shareable: false } }), TypeError);
  assert.deepEqual(await readdir(join(kit.dataDir, 'objects')), []);
  assert.equal((await kit.store.list({ kind: 'source_artifact' })).items.length, 0);
});
