import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { artifactShareKey, requestRead, withRequestPermissions } from './api.ts';
import { openTestRecords } from '../testing/records.ts';
import { sourceReader } from '../runs/engine/readers.ts';

test('two sources use the start-of-request shares even when both are revoked before their first read', async () => {
  const kit = await openTestRecords();
  try {
    const admin = (await kit.principals.bootstrapAdmin('synthetic-admin')).user;
    const owner = await kit.principals.createUser(admin, 'synthetic-owner');
    const reader = await kit.principals.createUser(admin, 'synthetic-reader');
    const make = async (text: string) => kit.artifacts.ingest({ bytes: Buffer.from(text), mediaType: 'text/plain', origin: { upload: { session: 'synthetic' } }, author: { user: owner.id }, provenanceType: 'declared', visibility: { readers: [owner.id], admins: true, packs: [], shareable: true } });
    const a = await make('synthetic first'), b = await make('synthetic second');
    for (const artifact of [a,b]) await kit.authorizations.share(admin, artifactShareKey(artifact), [reader.id]);
    let accesses = 0;
    const original = kit.artifacts.source.bind(kit.artifacts);
    const proxy = new Proxy(kit.artifacts, { get(target, key) { if (key === 'source') return async (...args: Parameters<typeof original>) => { accesses++; return original(...args); }; const value = Reflect.get(target,key,target); return typeof value === 'function' ? value.bind(target) : value; } });
    let continueBackground!: () => void; let background!: Promise<unknown>;
    await withRequestPermissions(kit.artifacts,reader,async () => {
      const sources = sourceReader(proxy,'model'), identity = { user: reader.id, role: reader.role };
      background = new Promise<void>(resolve => { continueBackground = resolve; }).then(() => sources.read(a.body.sha256,identity));
      for (const artifact of [a,b]) await kit.authorizations.unshare(admin, artifactShareKey(artifact), reader.id);
      assert.equal(Buffer.from((await sources.read(b.body.sha256,identity))!.bytes!).toString(), 'synthetic second');
      assert.equal(Buffer.from((await sources.read(a.body.sha256,identity))!.bytes!).toString(), 'synthetic first');
      assert.ok(await sources.read(a.body.sha256,identity)); assert.equal(accesses,2,'the source read is shared inside this request');
      const next = await withRequestPermissions(kit.artifacts,owner,async () => kit.artifacts.source(owner,a.body.sha256,{consumer:'model'}));
      assert.ok(next?.bytes, 'another principal never uses this reader snapshot');
    });
    continueBackground(); assert.equal(await background,null,'detached work does not retain a finished request permission');
    await withRequestPermissions(kit.artifacts,reader,async () => {
      const sources = sourceReader(kit.artifacts,'model'), identity = { user: reader.id, role: reader.role };
      assert.equal(await sources.read(a.body.sha256,identity),null);
      assert.equal(await sources.read(b.body.sha256,identity),null);
    });
  } finally { await kit.close(); }
});

test('pack-audience sharing and account disable are frozen only for the current request', async () => {
  const kit = await openTestRecords();
  try {
    const admin = (await kit.principals.bootstrapAdmin('synthetic-admin')).user;
    const owner = await kit.principals.createUser(admin, 'synthetic-owner');
    const reader = await kit.principals.createUser(admin, 'synthetic-reader');
    const artifact = await kit.artifacts.ingest({ bytes: Buffer.from('synthetic source'), mediaType: 'text/plain', origin: { upload: { session: 'synthetic' } }, author: { user: owner.id }, provenanceType: 'declared', visibility: { readers: [owner.id], admins: true, packs: [], shareable: true } });
    await kit.authorizations.assign(admin,reader.id,'synthetic-pack');
    await kit.authorizations.share(admin,artifactShareKey(artifact),{kind:'pack_users',pack:'synthetic-pack'});
    await withRequestPermissions(kit.artifacts,reader,async () => {
      await kit.authorizations.unassign(admin,reader.id,'synthetic-pack');
      await kit.principals.setDisabled(admin,reader.id,true);
      assert.ok((await kit.artifacts.source(reader,artifact.body.sha256,{consumer:'model'}))?.bytes);
      assert.equal((await kit.principals.get(reader.id))?.disabled,false);
    });
    assert.equal((await kit.principals.get(reader.id))?.disabled,true);
    await withRequestPermissions(kit.artifacts,reader,async () => assert.equal(await kit.artifacts.source(reader,artifact.body.sha256,{consumer:'model'}),null));
  } finally { await kit.close(); }
});

test('a grant added after the request begins applies only to the next request', async () => {
  const kit = await openTestRecords();
  try {
    const admin = (await kit.principals.bootstrapAdmin('synthetic-admin')).user;
    const owner = await kit.principals.createUser(admin, 'synthetic-owner'), reader = await kit.principals.createUser(admin, 'synthetic-reader');
    const artifact = await kit.artifacts.ingest({ bytes: Buffer.from('synthetic source'), mediaType: 'text/plain', origin: { upload: { session: 'synthetic' } }, author: { user: owner.id }, provenanceType: 'declared', visibility: { readers: [owner.id], admins: true, packs: [], shareable: true } });
    await withRequestPermissions(kit.artifacts,reader,async () => {
      await kit.authorizations.share(admin,artifactShareKey(artifact),[reader.id]);
      assert.equal(await kit.artifacts.source(reader,artifact.body.sha256,{consumer:'model'}),null);
    });
    await withRequestPermissions(kit.artifacts,reader,async () => assert.ok((await kit.artifacts.source(reader,artifact.body.sha256,{consumer:'model'}))?.bytes));
  } finally { await kit.close(); }
});

test('overlapping requests retain independent permission snapshots', async () => {
  const kit = await openTestRecords();
  try {
    const admin = (await kit.principals.bootstrapAdmin('synthetic-admin')).user;
    const owner = await kit.principals.createUser(admin, 'synthetic-owner'), reader = await kit.principals.createUser(admin, 'synthetic-reader');
    const artifact = await kit.artifacts.ingest({ bytes: Buffer.from('synthetic source'), mediaType: 'text/plain', origin: { upload: { session: 'synthetic' } }, author: { user: owner.id }, provenanceType: 'declared', visibility: { readers: [owner.id], admins: true, packs: [], shareable: true } });
    await kit.authorizations.share(admin,artifactShareKey(artifact),[reader.id]);
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered=resolve; }), gate = new Promise<void>(resolve => { release=resolve; });
    const first = withRequestPermissions(kit.artifacts,reader,async () => { entered(); await gate; return kit.artifacts.source(reader,artifact.body.sha256,{consumer:'model'}); });
    await started; await kit.authorizations.unshare(admin,artifactShareKey(artifact),reader.id);
    const second = await withRequestPermissions(kit.artifacts,reader,async () => kit.artifacts.source(reader,artifact.body.sha256,{consumer:'model'}));
    release(); assert.ok((await first)?.bytes); assert.equal(second,null);
  } finally { await kit.close(); }
});

test('a failed source read is not cached as absence', async () => {
  const kit = await openTestRecords();
  try {
    const admin = (await kit.principals.bootstrapAdmin('synthetic-admin')).user; let attempts = 0;
    await withRequestPermissions(kit.artifacts,admin,async () => {
      const load = async () => { if (++attempts === 1) throw new Error('synthetic transient'); return { bytes: Buffer.from('synthetic') }; };
      await assert.rejects(requestRead(admin.id,'synthetic',load,value=>value.bytes.length));
      assert.ok(await requestRead(admin.id,'synthetic',load,value=>value.bytes.length));
      assert.ok(await requestRead(admin.id,'synthetic',load,value=>value.bytes.length)); assert.equal(attempts,2);
    });
  } finally { await kit.close(); }
});

test('a newly withheld credential finding is not exposed through the request source cache', async () => {
  const kit = await openTestRecords();
  try {
    const admin = (await kit.principals.bootstrapAdmin('synthetic-admin')).user;
    const reader = await kit.principals.createUser(admin, 'synthetic-reader');
    const secret = randomBytes(8).toString('hex');
    const artifact = await kit.artifacts.ingest({ bytes: Buffer.from(`ftp://synthetic:${secret}@192.0.2.10/file`), mediaType: 'text/plain', origin: { read: { object: 'synthetic:manual:1', resource: 'synthetic' } }, author: { user: null }, provenanceType: 'observed', visibility: { readers: [], admins: true, packs: ['synthetic-pack'], shareable: false } });
    await kit.authorizations.assign(admin,reader.id,'synthetic-pack'); await kit.artifacts.acceptFindings(admin,artifact.body.sha256);
    await withRequestPermissions(kit.artifacts,reader,async () => {
      const sources=sourceReader(kit.artifacts,'model'), identity={user:reader.id,role:reader.role};
      assert.ok((await sources.read(artifact.body.sha256,identity))?.bytes);
      await kit.artifacts.revokeFindings(admin,artifact.body.sha256);
      const withheld=await sources.read(artifact.body.sha256,identity);
      assert.ok(withheld === null || withheld.bytes === null);
    });
  } finally { await kit.close(); }
});
