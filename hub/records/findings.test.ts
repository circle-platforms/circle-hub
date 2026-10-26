// Accepting the credential findings of a document (README decision 18): an admin's resource configuration
// `scan:<sha256>` bound to scanDigest of the current scan. Synthetic documents only; addresses from 192.0.2.0/24.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { labelOf } from '../../contracts/generated/vocabulary.ts';
import { startPostgres } from '../testing/postgres.ts';
import type { TemporaryPostgres } from '../testing/postgres.ts';
import { openTestRecords } from '../testing/records.ts';
import type { TestRecordsKit } from '../testing/records.ts';
import type { CredentialScan, IngestInput, Principal, SourceArtifactBody, Visibility } from './api.ts';
import { canonicalBytes, canonicalize } from './canonical.ts';
import { RECORD_SCHEMAS, WHOLE_HUB, scanAcceptanceKey } from './constants.ts';
import { sha256Hex } from './digest.ts';
import { AccessError, ConflictError, RecordsError } from './errors.ts';
import { scanDigest, scanForCredentials } from './scan.ts';

let postgres: TemporaryPostgres;
before(async () => {
  postgres = await startPostgres();
});
after(async () => {
  await postgres?.stop();
});

const UNREADABLE = labelOf('validity_status', 'credential_unreadable');

/** A password that is no placeholder, new in every run, so a search for it in the database means something. */
function password(): string {
  return `Ftp${randomBytes(5).toString('hex')}9`;
}

/** A manual-like synthetic document whose example URL carries a user name and a password. */
function manual(secret: string, extra = ''): Buffer {
  return Buffer.from(
    [
      '# 命令行手册（合成）',
      '',
      '## copy',
      '',
      '语法：copy <源地址> <目的地址>',
      '',
      '示例：',
      '',
      `    copy ftp://user:${secret}@192.0.2.10/images/system.bin flash:`,
      '',
      `说明：也可以写 tftp://192.0.2.11/system.bin。${extra}`,
      '',
    ].join('\n'),
  );
}

/** A connector read with a shared credential: admins and the users of the bound pack may read it. */
function manualRead(bytes: Uint8Array, object = 'manuals:file:cli/manual.md@1'): IngestInput {
  return {
    bytes,
    mediaType: 'text/markdown',
    origin: { read: { object, resource: 'manual-store', action: null } },
    author: { user: null },
    provenanceType: 'observed',
    visibility: { readers: [], admins: true, packs: ['case-review'], shareable: false },
    name: 'manual.md',
  };
}

function upload(by: Principal, bytes: Uint8Array, visibility?: Partial<Visibility>): IngestInput {
  return {
    bytes,
    mediaType: 'text/markdown',
    origin: { upload: { session: 'sess-synthetic-2', message: 'msg-9' } },
    author: { user: by.id },
    provenanceType: 'declared',
    visibility: { readers: [by.id], admins: true, packs: [], shareable: true, ...visibility },
    name: '上传.md',
  };
}

const asPrincipal = (user: { id: string; name: string; role: 'user' | 'admin' }): Principal => ({ id: user.id, name: user.name, role: user.role });

async function people(kit: TestRecordsKit) {
  const { user: admin } = await kit.principals.bootstrapAdmin('管理员');
  const uploader = await kit.principals.createUser(admin, '上传者');
  const packUser = await kit.principals.createUser(admin, '包用户');
  await kit.authorizations.assign(admin, packUser.id, 'case-review');
  return { admin: asPrincipal(admin), uploader: asPrincipal(uploader), packUser: asPrincipal(packUser) };
}

async function dump(kit: TestRecordsKit): Promise<string> {
  const client = new pg.Client({ ...kit.database, ssl: false });
  await client.connect();
  try {
    const parts: string[] = [];
    for (const table of ['records', 'record_index', 'objects', 'call_logs', 'call_notes']) parts.push(JSON.stringify((await client.query(`SELECT * FROM ${table}`)).rows));
    return parts.join('\n');
  } finally {
    await client.end();
  }
}

test('scanDigest is the SHA-256 of the canonical {scanner, findings: [{detector, offset}]} and of nothing else', () => {
  const scan: CredentialScan = {
    scanner: 'credential-scan@2',
    inspected: true,
    clean: false,
    findings: [
      { detector: 'basic_credential', offset: 40, line: 3, column: 5 },
      { detector: 'password_assignment', offset: 90, line: 6, column: 1 },
    ],
    truncated: false,
  };
  const expected = sha256Hex(
    canonicalize({ scanner: 'credential-scan@2', findings: [{ detector: 'basic_credential', offset: 40 }, { detector: 'password_assignment', offset: 90 }] }),
  );
  assert.equal(scanDigest(scan), expected);
  // Lines, columns, inspected, truncated, an earlier acceptance and the order the findings are listed in take no part.
  const relisted: CredentialScan = {
    ...scan,
    inspected: false,
    truncated: true,
    findings: scan.findings.map((finding) => ({ ...finding, line: 1, column: 1 })).reverse(),
    accepted: { by: 'usr_0000000000000000000000000a', at: '2026-10-22T00:00:00.000Z', authorization: 'a'.repeat(64) },
  };
  assert.equal(scanDigest(relisted), expected);
  // Another scanner version, detector or offset, or a finding more or less: another digest.
  const others: CredentialScan[] = [
    { ...scan, scanner: 'credential-scan@3' },
    { ...scan, findings: [scan.findings[0]] },
    { ...scan, findings: [...scan.findings, { detector: 'jwt', offset: 120, line: 7, column: 1 }] },
    { ...scan, findings: [{ ...scan.findings[0], offset: 41 }, scan.findings[1]] },
    { ...scan, findings: [{ ...scan.findings[0], detector: 'bearer_credential' }, scan.findings[1]] },
    { ...scan, findings: [] },
  ];
  for (const other of others) assert.notEqual(scanDigest(other), expected, JSON.stringify(other));
  // The scanner's own order is the digest's order: the digest of a real scan is the formula over its findings as listed.
  const real = scanForCredentials(manual(password()));
  assert.equal(real.findings.length, 1);
  assert.equal(scanDigest(real), sha256Hex(canonicalize({ scanner: real.scanner, findings: real.findings.map(({ detector, offset }) => ({ detector, offset })) })));
  assert.equal(scanDigest(scanForCredentials(manual('Ftp0000000009'))), scanDigest(scanForCredentials(manual('Ftp0000000009'))));
  for (const bad of [
    null,
    {},
    { scanner: '', findings: [] },
    { scanner: 'credential-scan@2', findings: [{ detector: 'jwt', offset: -1 }] },
    { scanner: 'credential-scan@2', findings: [{ detector: 'jwt', offset: 1.5 }] },
    { scanner: 'credential-scan@2', findings: [{ detector: '', offset: 1 }] },
    { scanner: 'credential-scan@2', findings: [{ offset: 1 }] },
  ]) {
    assert.throws(() => scanDigest(bad as never), TypeError, JSON.stringify(bad));
  }
  assert.equal(scanAcceptanceKey('a'.repeat(64)), `scan:${'a'.repeat(64)}`);
  for (const bad of ['', 'A'.repeat(64), 'a'.repeat(63), null]) assert.throws(() => scanAcceptanceKey(bad as never), TypeError, String(bad));
});

test('a manual whose example URL carries a password is retain_only until an admin accepts its findings; the next read keeps its tier', async (t) => {
  const kit = await openTestRecords({ postgres });
  t.after(() => kit.close());
  const { admin, packUser } = await people(kit);
  const bytes = manual(password());
  const sha = sha256Hex(bytes);
  const first = await kit.artifacts.ingest(manualRead(bytes));
  assert.equal(first.body.read_tier, 'retain_only');
  assert.deepEqual(first.body.scan.findings.map((finding) => finding.detector), ['basic_credential']);
  assert.equal(first.body.scan.accepted, undefined);
  for (const reader of [admin, packUser]) {
    const view = await kit.artifacts.text(reader, sha);
    assert.deepEqual({ readable: view?.readable, note: view?.note }, { readable: false, note: UNREADABLE });
  }

  const decision = await kit.artifacts.acceptFindings(admin, sha, '手册里的示例地址，不是真实凭据');
  const authorization = decision.authorization;
  assert.equal(authorization.kind, 'authorization');
  assert.equal(authorization.schema, RECORD_SCHEMAS.authorization);
  assert.deepEqual({ ...authorization.body, decided_at: undefined }, {
    permission: 'resource_config',
    subject: WHOLE_HUB,
    object: `scan:${sha}`,
    revoked: false,
    bound: scanDigest(first.body.scan),
    decided_by: admin.id,
    decided_at: undefined,
    expires_at: null,
    note: '手册里的示例地址，不是真实凭据',
    supersedes: null,
  });
  assert.deepEqual(decision.scan.findings, first.body.scan.findings);
  assert.equal((await kit.authorizations.resourceConfig(scanAcceptanceKey(sha)))?.digest, authorization.digest);
  // The immutable record keeps its old tier; effective reads use the current acceptance.
  assert.equal(first.body.read_tier,'retain_only');
  assert.equal((await kit.artifacts.text(admin, sha))?.readable,true);

  const second = await kit.artifacts.ingest(manualRead(bytes));
  assert.notEqual(second.digest, first.digest);
  assert.equal(second.body.read_tier, 'model_readable');
  assert.deepEqual(second.body.scan.findings, first.body.scan.findings);
  assert.deepEqual(second.body.scan.accepted, { by: admin.id, at: authorization.body.decided_at, authorization: authorization.digest });
  for (const reader of [admin, packUser]) {
    const view = await kit.artifacts.text(reader, sha);
    assert.deepEqual({ readable: view?.readable, text: view?.text, record: view?.artifact.digest }, { readable: true, text: bytes.toString('utf8'), record: second.digest });
    assert.equal((await kit.artifacts.readable(reader, sha))?.digest, second.digest);
    const source = await kit.artifacts.source(reader, sha);
    assert.equal(source?.readTier, 'model_readable');
    assert.deepEqual(Buffer.from(source?.bytes ?? []), bytes);
    // canRead answers for the record it is given; both are visible to these readers.
    assert.equal(await kit.artifacts.canRead(reader, first), true);
    assert.equal(await kit.artifacts.canRead(reader, second), true);
  }
  // Both records stay, oldest first; repeating the read returns the accepted record, not a third one.
  assert.deepEqual((await kit.artifacts.records(sha)).map((record) => record.digest), [first.digest, second.digest]);
  const again = await kit.artifacts.ingest(manualRead(bytes));
  assert.equal(again.digest, second.digest);
  const concurrent = await Promise.all([kit.artifacts.ingest(manualRead(bytes)), kit.artifacts.ingest(manualRead(bytes))]);
  assert.deepEqual(concurrent.map((record) => record.digest), [second.digest, second.digest]);
  assert.equal((await kit.artifacts.records(sha)).length, 2);
});

test('only an enabled admin accepts or withdraws findings, and only for stored bytes with a hit', async (t) => {
  const kit = await openTestRecords({ postgres });
  t.after(() => kit.close());
  const { admin, uploader } = await people(kit);
  const secret = password();
  const bytes = manual(secret);
  const sha = sha256Hex(bytes);
  await kit.artifacts.ingest(manualRead(bytes));
  await assert.rejects(kit.artifacts.acceptFindings(uploader, sha), AccessError);
  await assert.rejects(kit.artifacts.revokeFindings(uploader, sha), AccessError);
  // The role is read from the account, never from the principal.
  await assert.rejects(kit.artifacts.acceptFindings({ ...uploader, role: 'admin' }, sha), AccessError);
  await assert.rejects(kit.artifacts.acceptFindings({ id: 'usr_nobody', name: '无此人', role: 'admin' }, sha), AccessError);
  const second = asPrincipal(await kit.principals.createUser(admin, '二号管理员', 'admin'));
  await kit.principals.setDisabled(admin, second.id, true);
  await assert.rejects(kit.artifacts.acceptFindings(second, sha), AccessError);
  await kit.principals.setDisabled(admin, second.id, false);
  await kit.principals.setRole(admin, second.id, 'user');
  await assert.rejects(kit.artifacts.acceptFindings(second, sha), AccessError);
  await assert.rejects(kit.artifacts.revokeFindings(second, sha), AccessError);
  // Nothing stored, a refused upload (nothing stored either) and clean bytes have nothing to accept.
  await assert.rejects(kit.artifacts.acceptFindings(admin, sha256Hex('never stored')), (error: unknown) => error instanceof ConflictError && /没有保存这份字节/.test(error.message));
  const refusedBytes = manual(password());
  await assert.rejects(kit.artifacts.ingest(upload(uploader, refusedBytes)), (error: unknown) => error instanceof RecordsError && error.code === 'CREDENTIAL_IN_UPLOAD');
  await assert.rejects(kit.artifacts.acceptFindings(admin, sha256Hex(refusedBytes)), (error: unknown) => error instanceof ConflictError && /被拒绝的上传/.test(error.message));
  const clean = await kit.artifacts.ingest(manualRead(Buffer.from('# 命令行手册（合成）\n\n这一节没有示例地址。\n'), 'manuals:file:cli/clean.md@1'));
  await assert.rejects(kit.artifacts.acceptFindings(admin, clean.body.sha256), (error: unknown) => error instanceof ConflictError && /没有命中/.test(error.message));
  await assert.rejects(kit.artifacts.acceptFindings(admin, 'not-a-digest'), TypeError);
  await assert.rejects(kit.artifacts.revokeFindings(admin, 'A'.repeat(64)), TypeError);
  // A note that repeats the matched text is refused, so the decision cannot carry it.
  await assert.rejects(kit.artifacts.acceptFindings(admin, sha, `示例 ftp://user:${secret}@192.0.2.10/ 不是凭据`), (error: unknown) => error instanceof RecordsError && /说明里有像凭据的内容/.test(error.message));
  await assert.rejects(kit.artifacts.acceptFindings(admin, sha, 'x'.repeat(501)), TypeError);
  // None of the refusals wrote a decision.
  assert.deepEqual((await kit.authorizations.history({ permission: 'resource_config' })).items, []);
  assert.equal((await kit.artifacts.text(admin, sha))?.readable, false);
});

test('an acceptance covers exactly these bytes and this finding set', async (t) => {
  const kit = await openTestRecords({ postgres });
  t.after(() => kit.close());
  const { admin } = await people(kit);
  const secret = password();
  const bytes = manual(secret);
  const sha = sha256Hex(bytes);
  const first = await kit.artifacts.ingest(manualRead(bytes));
  await kit.artifacts.acceptFindings(admin, sha);
  // Edited bytes (one more sentence, same example URL) are other bytes: not covered.
  const edited = manual(secret, '另见第 4 章。');
  const editedRecord = await kit.artifacts.ingest(manualRead(edited, 'manuals:file:cli/manual.md@2'));
  assert.notEqual(editedRecord.body.sha256, sha);
  assert.equal(editedRecord.body.read_tier, 'retain_only');
  assert.equal(editedRecord.body.scan.accepted, undefined);
  assert.equal((await kit.artifacts.text(admin, editedRecord.body.sha256))?.readable, false);
  // A configuration of these bytes bound to another finding set (another scanner version, a finding less, another
  // offset) covers nothing: new reads stay retain_only.
  const mirror = manualRead(bytes, 'manuals:file:mirror/manual.md@1');
  const otherSets: CredentialScan[] = [
    { ...first.body.scan, scanner: 'credential-scan@1' },
    { ...first.body.scan, findings: [] },
    { ...first.body.scan, findings: first.body.scan.findings.map((finding) => ({ ...finding, offset: finding.offset + 1 })) },
  ];
  for (const other of otherSets) {
    await kit.authorizations.configureResource(admin, scanAcceptanceKey(sha), scanDigest(other));
    const record = await kit.artifacts.ingest(mirror);
    assert.equal(record.body.read_tier, 'retain_only', other.scanner);
    assert.equal(record.body.scan.accepted, undefined);
    assert.deepEqual({ readable: (await kit.artifacts.text(admin, sha))?.readable, note: (await kit.artifacts.text(admin, sha))?.note }, { readable: false, note: UNREADABLE });
  }
  // Bound to exactly this scan again: covered. A generated artifact of the bytes keeps the tier asked for.
  await kit.artifacts.acceptFindings(admin, sha);
  const covered = await kit.artifacts.ingest(mirror);
  assert.equal(covered.body.read_tier, 'model_readable');
  const generated = await kit.artifacts.ingest({
    bytes,
    mediaType: 'text/markdown',
    origin: { generated: { generator: 'synthetic-renderer@1', inputs: [], read_back: null } },
    author: { user: null },
    provenanceType: 'projected',
    visibility: { readers: [], admins: true, packs: [], shareable: false },
    readTier: 'function_bytes_only',
  });
  assert.equal(generated.body.read_tier, 'function_bytes_only');
  assert.equal(generated.body.scan.accepted?.by, admin.id);
  // The generated record is the newest the admin may read: functions get the bytes, a model does not.
  assert.equal((await kit.artifacts.source(admin, sha))?.bytes, null);
  assert.deepEqual(Buffer.from((await kit.artifacts.source(admin, sha, { consumer: 'function' }))?.bytes ?? []), bytes);
});

test('an upload with a credential hit is refused even while an acceptance covers the same bytes', async (t) => {
  const kit = await openTestRecords({ postgres });
  t.after(() => kit.close());
  const { admin, uploader } = await people(kit);
  const bytes = manual(password());
  const sha = sha256Hex(bytes);
  await kit.artifacts.ingest(manualRead(bytes));
  await kit.artifacts.acceptFindings(admin, sha);
  for (const by of [uploader, admin]) {
    await assert.rejects(kit.artifacts.ingest(upload(by, bytes)), (error: unknown) => error instanceof RecordsError && error.code === 'CREDENTIAL_IN_UPLOAD');
  }
  assert.equal((await kit.store.find({ key: 'artifact.refused', value: sha, kind: 'action' })).items.length, 2);
  assert.equal((await kit.artifacts.records(sha)).every((record) => 'read' in record.body.origin), true);
  assert.equal(await kit.artifacts.readable(uploader, sha), null);
});

test('an acceptance never lifts an upload: an earlier upload of bytes a newer scan flags stays retain_only for its uploader', async (t) => {
  const kit = await openTestRecords({ postgres });
  t.after(() => kit.close());
  const { admin, uploader } = await people(kit);
  const bytes = manual(password());
  const sha = sha256Hex(bytes);
  // An upload accepted by an older scanner that missed the URL (written directly, as in the scanner-version test).
  await kit.objects.put(bytes, 'text/markdown');
  const oldUpload: SourceArtifactBody = {
    sha256: sha,
    size: bytes.byteLength,
    media_type: 'text/markdown',
    name: null,
    origin: { upload: { session: 'sess-old', message: null } },
    author: { user: uploader.id, declared: null },
    captured_at: '2026-10-01T00:00:00.000Z',
    provenance_type: 'declared',
    read_tier: 'model_readable',
    visibility: { readers: [uploader.id], admins: true, packs: [], shareable: true },
    scan: { scanner: 'credential-scan@1', inspected: true, clean: true, findings: [], truncated: false },
  };
  await kit.store.put({ kind: 'source_artifact', schema: RECORD_SCHEMAS.source_artifact, provenance: 'declared', body: oldUpload, index: [{ key: 'artifact.sha256', value: sha }] });
  assert.equal((await kit.artifacts.text(uploader, sha))?.readable, true);
  // The current scanner flags the bytes when a connector reads them: every view turns retain_only.
  await kit.artifacts.ingest(manualRead(bytes));
  assert.equal((await kit.artifacts.text(uploader, sha))?.readable, false);
  await kit.artifacts.acceptFindings(admin, sha);
  const accepted = await kit.artifacts.ingest(manualRead(bytes));
  assert.equal(accepted.body.read_tier, 'model_readable');
  assert.equal((await kit.artifacts.text(admin, sha))?.readable, true);
  // The uploader may read only the upload record, and an acceptance never covers what a person uploaded (B02 R[4]).
  const view = await kit.artifacts.text(uploader, sha);
  assert.deepEqual({ readable: view?.readable, note: view?.note, upload: view === null ? null : 'upload' in view.artifact.body.origin }, { readable: false, note: UNREADABLE, upload: true });
  assert.equal((await kit.artifacts.source(uploader, sha, { consumer: 'function' }))?.bytes, null);
});

test('withdrawing an acceptance makes the bytes retain_only again at once and for new reads; the chain of decisions stays', async (t) => {
  const kit = await openTestRecords({ postgres });
  t.after(() => kit.close());
  const { admin, packUser } = await people(kit);
  const bytes = manual(password());
  const sha = sha256Hex(bytes);
  const first = await kit.artifacts.ingest(manualRead(bytes));
  const { authorization: accepted } = await kit.artifacts.acceptFindings(admin, sha, '示例地址');
  const second = await kit.artifacts.ingest(manualRead(bytes));
  assert.equal((await kit.artifacts.text(packUser, sha))?.readable, true);

  const withdrawal = await kit.artifacts.revokeFindings(admin, sha, '复核后撤回');
  assert.deepEqual(
    { revoked: withdrawal.body.revoked, supersedes: withdrawal.body.supersedes, object: withdrawal.body.object, bound: withdrawal.body.bound, by: withdrawal.body.decided_by },
    { revoked: true, supersedes: accepted.digest, object: scanAcceptanceKey(sha), bound: null, by: admin.id },
  );
  assert.equal(await kit.authorizations.resourceConfig(scanAcceptanceKey(sha)), null);
  // Reads check the acceptance again (B04 R[1]): the accepted record reads as retain_only at once.
  for (const reader of [admin, packUser]) {
    const view = await kit.artifacts.text(reader, sha);
    assert.deepEqual({ readable: view?.readable, note: view?.note, record: view?.artifact.digest }, { readable: false, note: UNREADABLE, record: second.digest });
    const source = await kit.artifacts.source(reader, sha, { consumer: 'function' });
    assert.deepEqual({ bytes: source?.bytes, readTier: source?.readTier }, { bytes: null, readTier: 'retain_only' });
  }
  // New reads are retain_only again: the same read returns the retain_only record already stored, another one is new.
  const repeated = await kit.artifacts.ingest(manualRead(bytes));
  assert.equal(repeated.digest, first.digest);
  const elsewhere = await kit.artifacts.ingest(manualRead(bytes, 'manuals:file:mirror/manual.md@1'));
  assert.equal(elsewhere.body.read_tier, 'retain_only');
  assert.equal(elsewhere.body.scan.accepted, undefined);
  // The chain of decisions stays, newest first.
  const chain = await kit.authorizations.history({ permission: 'resource_config', subject: WHOLE_HUB, object: scanAcceptanceKey(sha) });
  assert.deepEqual(chain.items.map((record) => record.digest), [withdrawal.digest, accepted.digest]);
  // Accepting again is a new decision; the next read names it and becomes the newest record.
  const { authorization: renewed } = await kit.artifacts.acceptFindings(admin, sha);
  assert.equal(renewed.body.supersedes, withdrawal.digest);
  const third = await kit.artifacts.ingest(manualRead(bytes));
  assert.notEqual(third.digest, second.digest);
  assert.equal(third.body.scan.accepted?.authorization, renewed.digest);
  assert.equal((await kit.artifacts.text(packUser, sha))?.artifact.digest, third.digest);
  assert.equal((await kit.artifacts.text(packUser, sha))?.readable, true);
});

test('a record of a newer scanner version is not covered by an acceptance of an older scan, also for records it covered', async (t) => {
  const kit = await openTestRecords({ postgres });
  t.after(() => kit.close());
  const { admin, packUser } = await people(kit);
  const bytes = manual(password());
  const sha = sha256Hex(bytes);
  await kit.artifacts.ingest(manualRead(bytes));
  await kit.artifacts.acceptFindings(admin, sha);
  const accepted = await kit.artifacts.ingest(manualRead(bytes));
  assert.equal((await kit.artifacts.text(packUser, sha))?.readable, true);
  // A newer scanner reports the same positions (simulated: a record written directly, visible to admins only). Its scanner
  // id is part of the digest, so the acceptance does not cover it, and the hit of the newest version decides for every record.
  const newer: SourceArtifactBody = {
    ...accepted.body,
    visibility: { readers: [], admins: true, packs: [], shareable: false },
    read_tier: 'retain_only',
    scan: { scanner: 'credential-scan@3', inspected: true, clean: false, findings: accepted.body.scan.findings, truncated: false },
  };
  await kit.store.put({ kind: 'source_artifact', schema: RECORD_SCHEMAS.source_artifact, provenance: 'observed', body: newer, index: [{ key: 'artifact.sha256', value: sha }] });
  const view = await kit.artifacts.text(packUser, sha);
  assert.deepEqual({ readable: view?.readable, note: view?.note, record: view?.artifact.digest }, { readable: false, note: UNREADABLE, record: accepted.digest });
  assert.equal((await kit.artifacts.source(admin, sha))?.readTier, 'retain_only');
});

test('the acceptance and the accepted artifact keep positions and detector ids only, never the matched text', async (t) => {
  const kit = await openTestRecords({ postgres });
  t.after(() => kit.close());
  const { admin } = await people(kit);
  const secret = password();
  const bytes = manual(secret);
  const sha = sha256Hex(bytes);
  await kit.artifacts.ingest(manualRead(bytes));
  const { authorization, scan } = await kit.artifacts.acceptFindings(admin, sha, '手册示例');
  const accepted = await kit.artifacts.ingest(manualRead(bytes));
  await kit.artifacts.revokeFindings(admin, sha, '撤回');
  assert.deepEqual(Object.keys(authorization.body).sort(), ['bound', 'decided_at', 'decided_by', 'expires_at', 'note', 'object', 'permission', 'revoked', 'subject', 'supersedes']);
  assert.equal(authorization.body.bound, scanDigest(scan));
  assert.deepEqual(Object.keys(accepted.body.scan.accepted ?? {}).sort(), ['at', 'authorization', 'by']);
  for (const finding of [...scan.findings, ...accepted.body.scan.findings]) assert.deepEqual(Object.keys(finding).sort(), ['column', 'detector', 'line', 'offset']);
  // Nothing in the database holds the password, the URL or any other text of the document; the bytes are only on disk.
  const everything = await dump(kit);
  for (const fragment of [secret, 'ftp://', '192.0.2.10', '命令行手册']) assert.equal(everything.includes(fragment), false, fragment);
});

test('the newest record a reader may read decides readable(), text() and source(); another person\'s upload never outranks the rest', async (t) => {
  const kit = await openTestRecords({ postgres });
  t.after(() => kit.close());
  const { admin, uploader, packUser } = await people(kit);
  const bytes = Buffer.from('# 合成的产品说明\n\n第一节。\n');
  const sha = sha256Hex(bytes);
  const own = await kit.artifacts.ingest(upload(admin, bytes));
  const restricted = await kit.artifacts.ingest({ ...manualRead(bytes, 'manuals:file:spec/product.md@1'), readTier: 'function_bytes_only' });
  // The admin may read both: the newer record decides (functions get the bytes, a model does not).
  assert.equal((await kit.artifacts.readable(admin, sha))?.digest, restricted.digest);
  const view = await kit.artifacts.text(admin, sha);
  assert.deepEqual({ readable: view?.readable, note: view?.note }, { readable: false, note: labelOf('read_tier', 'function_bytes_only') });
  assert.equal((await kit.artifacts.source(admin, sha))?.bytes, null);
  assert.deepEqual(Buffer.from((await kit.artifacts.source(admin, sha, { consumer: 'function' }))?.bytes ?? []), bytes);
  assert.equal((await kit.artifacts.readable(packUser, sha))?.digest, restricted.digest);
  // A later upload of the same bytes by another person decides for that person only: for the admin it never outranks the
  // Hub's read or the admin's own upload, so a user cannot change which record governs someone else's reads.
  const later = await kit.artifacts.ingest(upload(uploader, bytes));
  assert.equal((await kit.artifacts.readable(admin, sha))?.digest, restricted.digest);
  assert.equal((await kit.artifacts.text(admin, sha))?.readable, false);
  assert.equal((await kit.artifacts.source(admin, sha))?.artifact.digest, restricted.digest);
  assert.equal((await kit.artifacts.readable(uploader, sha))?.digest, later.digest);
  assert.equal((await kit.artifacts.readable(packUser, sha))?.digest, restricted.digest);
  // The admin's own newer upload ranks with the Hub's records: the newest of them decides.
  const mine = await kit.artifacts.ingest({ ...upload(admin, bytes), name: '我的副本.md' });
  assert.equal((await kit.artifacts.readable(admin, sha))?.digest, mine.digest);
  assert.equal((await kit.artifacts.text(admin, sha))?.readable, true);
  assert.deepEqual((await kit.artifacts.records(sha)).map((record) => record.digest), [own.digest, restricted.digest, later.digest, mine.digest]);
});

test('another person\'s upload of the same bytes never changes the record, media type or provenance a reader of the Hub\'s read gets', async (t) => {
  const kit = await openTestRecords({ postgres });
  t.after(() => kit.close());
  const { admin, uploader, packUser } = await people(kit);
  const bytes = Buffer.from('# 合成的公开手册\n\n## show version\n\n显示版本。\n');
  const sha = sha256Hex(bytes);
  const read = await kit.artifacts.ingest(manualRead(bytes, 'manuals:file:cli/public.md@1'));
  // An ordinary user uploads the same bytes (from an anonymous mirror) and declares another media type.
  const uploaded = await kit.artifacts.ingest({ ...upload(uploader, bytes), mediaType: 'text/plain' });
  // The next connector read of the object returns its first record (same dedupe key), so the upload stays the newest.
  assert.equal((await kit.artifacts.ingest(manualRead(bytes, 'manuals:file:cli/public.md@1'))).digest, read.digest);
  assert.deepEqual((await kit.artifacts.records(sha)).map((record) => record.digest), [read.digest, uploaded.digest]);
  for (const reader of [admin, packUser]) {
    const source = await kit.artifacts.source(reader, sha, { consumer: 'function' });
    assert.deepEqual(
      { record: source?.artifact.digest, mediaType: source?.mediaType, provenance: source?.artifact.body.provenance_type, origin: Object.keys(source?.artifact.body.origin ?? {}) },
      { record: read.digest, mediaType: 'text/markdown', provenance: 'observed', origin: ['read'] },
    );
    assert.equal((await kit.artifacts.readable(reader, sha))?.digest, read.digest);
    assert.equal((await kit.artifacts.text(reader, sha))?.artifact.digest, read.digest);
  }
  // The uploader reads their own upload, with the media type they declared.
  assert.equal((await kit.artifacts.source(uploader, sha))?.mediaType, 'text/plain');
  // Another person's upload still decides when the reader may read nothing else of the bytes.
  const elsewhere = Buffer.from('# 只有上传的合成说明\n');
  const only = await kit.artifacts.ingest(upload(uploader, elsewhere));
  assert.equal((await kit.artifacts.readable(admin, sha256Hex(elsewhere)))?.digest, only.digest);
});

test('source() and text() pinned to one record: that record decides when the reader may read it, else null', async (t) => {
  const kit = await openTestRecords({ postgres });
  t.after(() => kit.close());
  const { admin, uploader, packUser } = await people(kit);
  const bytes = Buffer.from('# 合成的产品说明\n\n第二节。\n');
  const sha = sha256Hex(bytes);
  const read = await kit.artifacts.ingest(manualRead(bytes, 'manuals:file:spec/second.md@1'));
  const mine = await kit.artifacts.ingest({ ...upload(admin, bytes), mediaType: 'text/plain' });
  // Unpinned, the admin's own newer upload decides for the admin; pinned, the record a connector returned decides.
  assert.equal((await kit.artifacts.source(admin, sha))?.artifact.digest, mine.digest);
  const pinned = await kit.artifacts.source(admin, sha, { consumer: 'model', record: read.digest });
  assert.deepEqual(
    { record: pinned?.artifact.digest, mediaType: pinned?.mediaType, readTier: pinned?.readTier, same: Buffer.from(pinned?.bytes ?? []).equals(bytes) },
    { record: read.digest, mediaType: 'text/markdown', readTier: 'model_readable', same: true },
  );
  const text = await kit.artifacts.text(admin, sha, { record: read.digest });
  assert.deepEqual({ record: text?.artifact.digest, text: text?.text }, { record: read.digest, text: bytes.toString('utf8') });
  // A record the reader may not read, a record of other bytes and an unknown digest: null, like absent bytes.
  assert.equal(await kit.artifacts.source(packUser, sha, { record: mine.digest }), null);
  assert.equal(await kit.artifacts.text(uploader, sha, { record: read.digest }), null);
  const other = await kit.artifacts.ingest(manualRead(Buffer.from('另一份合成说明\n'), 'manuals:file:spec/other.md@1'));
  assert.equal(await kit.artifacts.source(admin, sha, { record: other.digest }), null);
  assert.equal(await kit.artifacts.source(admin, sha, { record: sha256Hex('no such record') }), null);
  await assert.rejects(kit.artifacts.source(admin, sha, { record: 'not-a-digest' }), TypeError);
  await assert.rejects(kit.artifacts.text(admin, sha, { record: 42 as never }), TypeError);
  // The credential rule holds for a pinned record too: current acceptance lifts a historical scan hold.
  const secretBytes = manual(password());
  const secretSha = sha256Hex(secretBytes);
  const before = await kit.artifacts.ingest(manualRead(secretBytes));
  await kit.artifacts.acceptFindings(admin, secretSha);
  const after = await kit.artifacts.ingest(manualRead(secretBytes));
  assert.equal((await kit.artifacts.source(admin, secretSha, { record: before.digest }))?.readTier, 'model_readable');
  assert.equal((await kit.artifacts.source(admin, secretSha, { record: after.digest }))?.readTier, 'model_readable');
  await kit.artifacts.revokeFindings(admin, secretSha);
  const withdrawn = await kit.artifacts.text(admin, secretSha, { record: after.digest });
  assert.deepEqual({ readable: withdrawn?.readable, note: withdrawn?.note }, { readable: false, note: UNREADABLE });
});

test('a scan with more findings than it keeps cannot be accepted, and no configuration lifts it', async (t) => {
  const kit = await openTestRecords({ postgres });
  t.after(() => kit.close());
  const { admin, packUser } = await people(kit);
  // 120 example URLs, then a line nobody would be shown: past the 100 kept findings and past the 101 hits a pattern looks for.
  const examples = Array.from({ length: 120 }, (_, index) => `    copy ftp://user:${password()}@192.0.2.10/images/system-${index}.bin flash:`);
  const bytes = Buffer.from(['# 命令行手册（合成）', '', ...examples, '', `password = ${password()}`, ''].join('\n'));
  const sha = sha256Hex(bytes);
  const first = await kit.artifacts.ingest(manualRead(bytes));
  assert.deepEqual({ tier: first.body.read_tier, truncated: first.body.scan.truncated, kept: first.body.scan.findings.length }, { tier: 'retain_only', truncated: true, kept: 100 });
  const late = bytes.indexOf('password = ');
  assert.equal(first.body.scan.findings.some((finding) => finding.offset >= late), false);
  await assert.rejects(kit.artifacts.acceptFindings(admin, sha, '手册里的示例地址'), (error: unknown) => error instanceof ConflictError && /上限/.test(error.message));
  assert.deepEqual((await kit.authorizations.history({ permission: 'resource_config' })).items, []);
  // A configuration bound to the truncated scan (written past acceptFindings) lifts nothing, at ingest or at read.
  const configuration = await kit.authorizations.configureResource(admin, scanAcceptanceKey(sha), scanDigest(first.body.scan));
  const again = await kit.artifacts.ingest(manualRead(bytes, 'manuals:file:mirror/manual.md@1'));
  assert.deepEqual({ tier: again.body.read_tier, accepted: again.body.scan.accepted }, { tier: 'retain_only', accepted: undefined });
  const forged: SourceArtifactBody = {
    ...first.body,
    read_tier: 'model_readable',
    scan: { ...first.body.scan, accepted: { by: admin.id, at: configuration.body.decided_at, authorization: configuration.digest } },
  };
  await kit.store.put({ kind: 'source_artifact', schema: RECORD_SCHEMAS.source_artifact, provenance: 'observed', body: forged, index: [{ key: 'artifact.sha256', value: sha }] });
  for (const reader of [admin, packUser]) {
    const view = await kit.artifacts.text(reader, sha);
    assert.deepEqual({ readable: view?.readable, note: view?.note, tier: view?.artifact.body.read_tier }, { readable: false, note: UNREADABLE, tier: 'model_readable' });
    assert.equal((await kit.artifacts.source(reader, sha, { consumer: 'function' }))?.bytes, null);
  }
});

test('an acceptance never lifts what a person supplied: a generated record with a person as author stays retain_only', async (t) => {
  const kit = await openTestRecords({ postgres });
  t.after(() => kit.close());
  const { admin, uploader } = await people(kit);
  // The canonical JSON of a value from the user's own record, as hub/runs ingests a rec: input (synthetic).
  const bytes = canonicalBytes({ kind: 'submission', note: `ftp://user:${password()}@192.0.2.10/a.bin` });
  const sha = sha256Hex(bytes);
  const personal = (): IngestInput => ({
    bytes,
    mediaType: 'application/json',
    origin: { generated: { generator: 'runs.record@1', inputs: [`rec:${'a'.repeat(64)}`] } },
    author: { user: uploader.id },
    provenanceType: 'declared',
    visibility: { readers: [uploader.id], admins: true, packs: [], shareable: false },
  });
  const first = await kit.artifacts.ingest(personal());
  assert.equal(first.body.read_tier, 'retain_only');
  // Bytes only a person supplied have nothing an acceptance could lift.
  await assert.rejects(kit.artifacts.acceptFindings(admin, sha, '用户说是示例'), (error: unknown) => error instanceof ConflictError && /个人/.test(error.message));
  assert.deepEqual((await kit.authorizations.history({ permission: 'resource_config' })).items, []);
  // Even while an acceptance is in force (the Hub read the same bytes and an admin accepted them), the person's record is
  // not lifted: not at ingest, not at read.
  await kit.artifacts.ingest({ ...manualRead(bytes, 'agile:mindmap:doc-1@1'), mediaType: 'application/json' });
  await kit.artifacts.acceptFindings(admin, sha);
  const second = await kit.artifacts.ingest(personal());
  assert.deepEqual({ record: second.digest, tier: second.body.read_tier, accepted: second.body.scan.accepted }, { record: first.digest, tier: 'retain_only', accepted: undefined });
  const view = await kit.artifacts.text(uploader, sha);
  assert.deepEqual({ readable: view?.readable, note: view?.note, record: view?.artifact.digest }, { readable: false, note: UNREADABLE, record: first.digest });
  assert.equal((await kit.artifacts.source(uploader, sha, { consumer: 'function' }))?.bytes, null);
  // The Hub's next read is lifted, and it decides for the admin over the person's record.
  const accepted = await kit.artifacts.ingest({ ...manualRead(bytes, 'agile:mindmap:doc-1@1'), mediaType: 'application/json' });
  assert.equal(accepted.body.read_tier, 'model_readable');
  const adminView = await kit.artifacts.text(admin, sha);
  assert.deepEqual({ readable: adminView?.readable, record: adminView?.artifact.digest }, { readable: true, record: accepted.digest });
  assert.equal((await kit.artifacts.text(uploader, sha))?.readable, false);
});

test('an acceptance never lifts a record with a person as author that an older scanner passed', async (t) => {
  const kit = await openTestRecords({ postgres });
  t.after(() => kit.close());
  const { admin, uploader } = await people(kit);
  const bytes = canonicalBytes({ kind: 'submission', note: `ftp://user:${password()}@192.0.2.10/b.bin` });
  const sha = sha256Hex(bytes);
  // Generated from the user's own record and stored model_readable by a scanner that missed the URL (written directly).
  await kit.objects.put(bytes, 'application/json');
  const old: SourceArtifactBody = {
    sha256: sha,
    size: bytes.byteLength,
    media_type: 'application/json',
    name: null,
    origin: { generated: { generator: 'runs.record@1', inputs: [`rec:${'b'.repeat(64)}`], read_back: null } },
    author: { user: uploader.id, declared: null },
    captured_at: '2026-10-01T00:00:00.000Z',
    provenance_type: 'declared',
    read_tier: 'model_readable',
    visibility: { readers: [uploader.id], admins: true, packs: [], shareable: false },
    scan: { scanner: 'credential-scan@1', inspected: true, clean: true, findings: [], truncated: false },
  };
  await kit.store.put({ kind: 'source_artifact', schema: RECORD_SCHEMAS.source_artifact, provenance: 'declared', body: old, index: [{ key: 'artifact.sha256', value: sha }] });
  assert.equal((await kit.artifacts.text(uploader, sha))?.readable, true);
  // The current scanner flags the bytes when the Hub reads them; an admin accepts, and the Hub's next read is lifted.
  await kit.artifacts.ingest({ ...manualRead(bytes, 'agile:mindmap:doc-2@1'), mediaType: 'application/json' });
  await kit.artifacts.acceptFindings(admin, sha);
  const accepted = await kit.artifacts.ingest({ ...manualRead(bytes, 'agile:mindmap:doc-2@1'), mediaType: 'application/json' });
  assert.equal((await kit.artifacts.text(admin, sha))?.artifact.digest, accepted.digest);
  // The person's own record is never lifted: for its author it reads as retain_only, models and functions alike.
  const view = await kit.artifacts.text(uploader, sha);
  assert.deepEqual({ readable: view?.readable, note: view?.note, origin: view === null ? null : Object.keys(view.artifact.body.origin) }, { readable: false, note: UNREADABLE, origin: ['generated'] });
  assert.equal((await kit.artifacts.source(uploader, sha, { consumer: 'function' }))?.bytes, null);
});

test('a note that copies text from where a finding is is refused, for every form a finding takes; the decision keeps no matched text', async (t) => {
  const kit = await openTestRecords({ postgres });
  t.after(() => kit.close());
  const { admin } = await people(kit);
  const urlSecret = password();
  const yamlSecret = password();
  const jsonSecret = password();
  const keyLines = randomBytes(192).toString('base64').match(/.{1,64}/g) ?? [];
  // A double-encoded mind-map answer whose encoder escapes every non-ASCII character: the scanner finds the hit only two
  // levels of escapes down and reports it at the opening quote of the outer string, thousands of characters before it.
  const asciiJson = (value: unknown) => JSON.stringify(value).replace(/[\u0080-￿]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
  const nodes: unknown[] = Array.from({ length: 40 }, (_, index) => ({ data: { id: `n${index}`, text: `合成节点 ${index}：说明文字说明文字说明文字` } }));
  nodes.push({ data: { id: 'n99', text: '登录说明', note: `口令：${jsonSecret}` } });
  const answer = Buffer.from(asciiJson({ code: 1000, msg: 'ok', data: asciiJson({ root: { data: { id: 'n0', text: '合成导图' }, children: nodes } }) }));
  const documents: Array<{ name: string; bytes: Buffer; copies: string[] }> = [
    { name: 'url', bytes: manual(urlSecret), copies: [urlSecret, `第 9 行的 ${urlSecret} 是手册里的示例`, `user:${urlSecret}@192.0.2.10`, urlSecret.slice(0, 6)] },
    // YAML with the value on the next line: the hit is at the key, the value one line further.
    { name: 'yaml', bytes: Buffer.from(['# 合成的配置样例', 'database:', '  host: 192.0.2.20', '  password:', `    ${yamlSecret}`, ''].join('\n')), copies: [yamlSecret] },
    { name: 'json', bytes: answer, copies: [`示例值 ${jsonSecret.slice(2)}`] },
    // A private key: the key material follows the header over several lines.
    { name: 'key', bytes: Buffer.from(['# 合成的部署说明', '', ['-----BEGIN ', 'PRIVATE KEY-----'].join(''), ...keyLines, ['-----END ', 'PRIVATE KEY-----'].join(''), ''].join('\n')), copies: [`第三行 ${keyLines[2].slice(10, 22)} 是示例数据`] },
  ];
  for (const document of documents) {
    const sha = sha256Hex(document.bytes);
    const stored = await kit.artifacts.ingest(manualRead(document.bytes, `manuals:file:notes/${document.name}.md@1`));
    assert.equal(stored.body.read_tier, 'retain_only', document.name);
    if (document.name === 'json') {
      assert.equal(document.bytes.includes(Buffer.from('口令')), false);
      assert.ok(stored.body.scan.findings.length > 0 && stored.body.scan.findings.every((finding) => finding.offset + 2048 < document.bytes.indexOf(jsonSecret)));
    }
    for (const note of document.copies) {
      await assert.rejects(kit.artifacts.acceptFindings(admin, sha, note), (error: unknown) => error instanceof RecordsError && /说明里抄写了命中处的原文/.test(error.message), `${document.name}: ${note}`);
    }
    assert.deepEqual((await kit.authorizations.history({ permission: 'resource_config', object: scanAcceptanceKey(sha) })).items, [], document.name);
    // A note in the admin's own words is kept; so is a withdrawal in own words, while one that copies is refused.
    const { authorization } = await kit.artifacts.acceptFindings(admin, sha, '核对过原系统：是手册里的示例，不是真实凭据');
    assert.equal(authorization.body.note, '核对过原系统：是手册里的示例，不是真实凭据');
    await assert.rejects(kit.artifacts.revokeFindings(admin, sha, document.copies[0]), (error: unknown) => error instanceof RecordsError && /说明里抄写了命中处的原文/.test(error.message), document.name);
    assert.equal((await kit.artifacts.revokeFindings(admin, sha, '复核后撤回')).body.note, '复核后撤回');
  }
  // What the scanner flags on its own stays refused with its own message.
  const urlSha = sha256Hex(documents[0].bytes);
  for (const note of [`示例 ftp://user:${urlSecret}@192.0.2.10/ 不是凭据`, `口令 ${urlSecret} 是示例`]) {
    await assert.rejects(kit.artifacts.acceptFindings(admin, urlSha, note), (error: unknown) => error instanceof RecordsError && /说明里有像凭据的内容/.test(error.message), note);
  }
  const everything = await dump(kit);
  for (const fragment of [urlSecret, yamlSecret, jsonSecret, ...keyLines.slice(0, 3)]) assert.equal(everything.includes(fragment), false, fragment);
});
