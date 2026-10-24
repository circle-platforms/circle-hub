import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startPostgres } from '../testing/postgres.ts';
import type { TemporaryPostgres } from '../testing/postgres.ts';
import { openTestRecords } from '../testing/records.ts';
import type { TestRecordsKit } from '../testing/records.ts';
import type { Principal } from './api.ts';
import { WHOLE_HUB } from './constants.ts';
import { digestOf } from './digest.ts';
import { AccessError, ConflictError } from './errors.ts';

let postgres: TemporaryPostgres;
before(async () => {
  postgres = await startPostgres();
});
after(async () => {
  await postgres?.stop();
});

const asPrincipal = (user: { id: string; name: string; role: 'user' | 'admin' }): Principal => ({ id: user.id, name: user.name, role: user.role });

async function setup(kit: TestRecordsKit) {
  const admin = asPrincipal((await kit.principals.bootstrapAdmin('管理员')).user);
  const alice = asPrincipal(await kit.principals.createUser(admin, '甲'));
  const bob = asPrincipal(await kit.principals.createUser(admin, '乙'));
  return { admin, alice, bob };
}

test('pack assignment: the latest record per user and pack wins, and nothing is ever deleted', async (t) => {
  const kit = await openTestRecords({ postgres });
  t.after(() => kit.close());
  const { admin, alice, bob } = await setup(kit);
  const first = await kit.authorizations.assign(admin, alice.id, 'case-review', { note: '试用' });
  assert.equal(first.kind, 'authorization');
  assert.equal(first.schema, 'authorization@1');
  assert.equal(first.provenance, 'declared');
  assert.deepEqual({ ...first.body, decided_at: undefined }, {
    permission: 'assign',
    subject: alice.id,
    object: 'case-review',
    revoked: false,
    bound: null,
    decided_by: admin.id,
    decided_at: undefined,
    expires_at: null,
    note: '试用',
    supersedes: null,
  });
  await kit.authorizations.assign(admin, alice.id, 'other-pack');
  await kit.authorizations.assign(admin, bob.id, 'case-review');
  assert.equal(await kit.authorizations.canUse(alice.id, 'case-review'), true);
  assert.deepEqual(await kit.authorizations.packsFor(alice.id), ['case-review', 'other-pack']);
  assert.deepEqual(await kit.authorizations.usersOf('case-review'), [alice.id, bob.id].sort());
  await kit.authorizations.unassign(admin, alice.id, 'case-review', '项目结束');
  assert.equal(await kit.authorizations.canUse(alice.id, 'case-review'), false);
  assert.deepEqual(await kit.authorizations.packsFor(alice.id), ['other-pack']);
  assert.deepEqual(await kit.authorizations.usersOf('case-review'), [bob.id]);
  await kit.authorizations.assign(admin, alice.id, 'case-review');
  assert.equal(await kit.authorizations.canUse(alice.id, 'case-review'), true);
  const history = await kit.authorizations.history({ permission: 'assign', subject: alice.id, object: 'case-review' });
  assert.deepEqual(history.items.map((record) => record.body.revoked), [false, true, false]);
  assert.equal((await kit.authorizations.latest('assign', alice.id, 'case-review'))?.body.revoked, false);
  assert.equal(await kit.authorizations.canUse(alice.id, 'never-assigned'), false);
  assert.deepEqual(await kit.authorizations.packsFor(bob.id), ['case-review']);
});

test('an assignment with an expiry stops at that moment', async (t) => {
  let clock = Date.parse('2026-10-21T08:00:00.000Z');
  const kit = await openTestRecords({ postgres, now: () => new Date(clock) });
  t.after(() => kit.close());
  const { admin, alice } = await setup(kit);
  await kit.authorizations.assign(admin, alice.id, 'case-review', { expiresAt: '2026-10-21T09:00:00.000Z' });
  assert.equal(await kit.authorizations.canUse(alice.id, 'case-review'), true);
  clock = Date.parse('2026-10-21T09:00:00.000Z');
  assert.equal(await kit.authorizations.canUse(alice.id, 'case-review'), false);
  assert.deepEqual(await kit.authorizations.packsFor(alice.id), []);
  await assert.rejects(kit.authorizations.assign(admin, alice.id, 'case-review', { expiresAt: 'tomorrow' }), TypeError);
});

test('only admins decide assignments, publish rights, resource configuration and shares', async (t) => {
  const kit = await openTestRecords({ postgres });
  t.after(() => kit.close());
  const { admin, alice, bob } = await setup(kit);
  const digest = digestOf({ endpoint: 'http://192.0.2.10/', environment: 'test' });
  await assert.rejects(kit.authorizations.assign(alice, bob.id, 'case-review'), AccessError);
  await assert.rejects(kit.authorizations.grantPublishRight(alice, alice.id), AccessError);
  await assert.rejects(kit.authorizations.configureResource(alice, 'plm', digest), AccessError);
  await assert.rejects(kit.authorizations.share(alice, 'run_synthetic', [bob.id]), AccessError);
  // A Principal that still says admin after a demotion or while disabled carries no power: the stored account decides.
  const second = asPrincipal(await kit.principals.setRole(admin, alice.id, 'admin'));
  await kit.principals.setRole(second, admin.id, 'user');
  await assert.rejects(kit.authorizations.assign(admin, bob.id, 'case-review'), AccessError);
  await kit.principals.setRole(second, admin.id, 'admin');
  await kit.principals.setDisabled(admin, alice.id, true);
  await assert.rejects(kit.authorizations.assign(second, bob.id, 'case-review'), AccessError);
  await assert.rejects(kit.authorizations.assign({ id: 'usr_00000000000000000000000000', name: '幽灵', role: 'admin' }, bob.id, 'case-review'), AccessError);
  await assert.rejects(kit.authorizations.assign(admin, 'usr_00000000000000000000000000', 'case-review'), ConflictError);
  await assert.rejects(kit.authorizations.assign(admin, bob.id, 'Not A Pack'), TypeError);
  await assert.rejects(kit.authorizations.grant(admin, { permission: 'approve' as never, subject: bob.id, object: 'x' }), TypeError);
  await assert.rejects(kit.authorizations.grant(admin, { permission: 'assign', subject: 'a|b', object: 'x' }), TypeError);
  assert.equal((await kit.authorizations.history({})).items.length, 0);
});

test('publish rights, publish records by the owner and withdrawal', async (t) => {
  const kit = await openTestRecords({ postgres });
  t.after(() => kit.close());
  const { admin, alice, bob } = await setup(kit);
  assert.equal(await kit.authorizations.canPublish(alice.id), false);
  await kit.authorizations.grantPublishRight(admin, alice.id);
  assert.equal(await kit.authorizations.canPublish(alice.id), true);
  assert.equal((await kit.authorizations.latest('publish_right', alice.id, WHOLE_HUB))?.body.object, WHOLE_HUB);
  const packDigest = digestOf({ files: ['pack.json'] });
  const published = await kit.authorizations.grant(alice, { permission: 'publish', subject: alice.id, object: 'case-review@1.0.0', bound: packDigest });
  assert.equal(published.body.bound, packDigest);
  assert.equal(await kit.authorizations.isActive('publish', alice.id, 'case-review@1.0.0'), true);
  // A publication now always binds its content, so these attempts carry a bound to test the decider alone.
  const nextDigest = digestOf({ files: ['pack.json', 'checks.json'] });
  await assert.rejects(kit.authorizations.grant(bob, { permission: 'publish', subject: alice.id, object: 'case-review@1.0.1', bound: nextDigest }), AccessError);
  await assert.rejects(kit.authorizations.grant(admin, { permission: 'publish', subject: alice.id, object: 'case-review@1.0.1', bound: nextDigest }), AccessError);
  await assert.rejects(kit.authorizations.revoke(bob, { permission: 'publish', subject: alice.id, object: 'case-review@1.0.0' }), AccessError);
  await kit.authorizations.revoke(admin, { permission: 'publish', subject: alice.id, object: 'case-review@1.0.0', note: '下架' });
  assert.equal(await kit.authorizations.isActive('publish', alice.id, 'case-review@1.0.0'), false);
  await kit.authorizations.revokePublishRight(admin, alice.id);
  assert.equal(await kit.authorizations.canPublish(alice.id), false);
});

test('with a frozen clock every decision is still its own record: the last one wins (assign, share, publish)', async (t) => {
  const frozen = new Date('2026-10-21T08:00:00.000Z');
  const kit = await openTestRecords({ postgres, now: () => new Date(frozen) });
  t.after(() => kit.close());
  const { admin, alice, bob } = await setup(kit);
  const a = kit.authorizations;
  const first = await a.unassign(admin, bob.id, 'case-review');
  await a.assign(admin, bob.id, 'case-review');
  const last = await a.unassign(admin, bob.id, 'case-review');
  // Same fields and the same millisecond as the first, yet its own record (it used to come back as the first one).
  assert.notEqual(last.digest, first.digest);
  assert.equal((await a.latest('assign', bob.id, 'case-review'))?.digest, last.digest);
  assert.equal(await a.canUse(bob.id, 'case-review'), false);
  assert.deepEqual(await a.packsFor(bob.id), []);
  await a.assign(admin, alice.id, 'case-review');
  await a.unassign(admin, alice.id, 'case-review');
  await a.assign(admin, alice.id, 'case-review');
  assert.equal(await a.canUse(alice.id, 'case-review'), true);
  assert.deepEqual(await a.usersOf('case-review'), [alice.id]);
  for (const step of ['share', 'unshare', 'share', 'unshare'] as const) {
    if (step === 'share') await a.share(admin, 'run_00000000000000000000000001', [bob.id]);
    else await a.unshare(admin, 'run_00000000000000000000000001', bob.id);
  }
  assert.equal(await a.isSharedWith(bob.id, 'run_00000000000000000000000001'), false);
  await a.grantPublishRight(admin, alice.id);
  const content = digestOf({ files: ['pack.json'] });
  for (const step of ['publish', 'withdraw', 'publish', 'withdraw'] as const) {
    if (step === 'publish') await a.grant(alice, { permission: 'publish', subject: alice.id, object: 'case-review@1.0.0', bound: content });
    else await a.revoke(alice, { permission: 'publish', subject: alice.id, object: 'case-review@1.0.0' });
  }
  assert.equal(await a.isPublished('case-review@1.0.0'), false);
  // The decisions form one chain per (permission, subject, object): each names the one before it.
  const chain = (await a.history({ permission: 'assign', subject: bob.id, object: 'case-review', newestFirst: false })).items;
  assert.equal(chain.length, 3);
  assert.deepEqual(chain.map((record) => record.body.supersedes), [null, chain[0].digest, chain[1].digest]);
});

test('concurrent decisions on one triple are serialised into one chain', async (t) => {
  const kit = await openTestRecords({ postgres });
  t.after(() => kit.close());
  const { admin, bob } = await setup(kit);
  await Promise.all(Array.from({ length: 12 }, (_, index) => (index % 2 === 0 ? kit.authorizations.assign(admin, bob.id, 'case-review') : kit.authorizations.unassign(admin, bob.id, 'case-review'))));
  const chain = (await kit.authorizations.history({ permission: 'assign', subject: bob.id, object: 'case-review', newestFirst: false, limit: 100 })).items;
  assert.equal(chain.length, 12);
  chain.forEach((record, index) => assert.equal(record.body.supersedes, index === 0 ? null : chain[index - 1].digest));
  assert.equal(await kit.authorizations.canUse(bob.id, 'case-review'), !chain[11].body.revoked);
});

test('a publication needs the publish right, a SHA-256 bound and the pack owner; a version keeps its content', async (t) => {
  const kit = await openTestRecords({ postgres });
  t.after(() => kit.close());
  const { admin, alice, bob } = await setup(kit);
  const carol = asPrincipal(await kit.principals.createUser(admin, '丙'));
  const a = kit.authorizations;
  const v1 = digestOf({ files: ['pack.json'], version: '1.0.0' });
  const v2 = digestOf({ files: ['pack.json'], version: '1.1.0' });
  const publish = (by: Principal, object: string, bound: string | null) => a.grant(by, { permission: 'publish', subject: by.id, object, bound });
  // Without the publish right, also for one's own name (the earlier check only compared the decider and the subject).
  await assert.rejects(publish(carol, 'case-review@9.9.9', v1), AccessError);
  await a.grantPublishRight(admin, alice.id);
  await a.grantPublishRight(admin, bob.id);
  await assert.rejects(publish(alice, 'case-review@1.0.0', null), TypeError);
  for (const object of ['case-review', 'case-review@1.0', 'Case@1.0.0', 'case-review@1.0.0-beta']) await assert.rejects(publish(alice, object, v1), TypeError, object);
  assert.equal(await a.ownerOf('case-review'), null);
  await publish(alice, 'case-review@1.0.0', v1);
  assert.equal(await a.ownerOf('case-review'), alice.id);
  // Another account with the publish right cannot publish versions of a pack that has an owner.
  await assert.rejects(publish(bob, 'case-review@1.0.0', v1), AccessError);
  await assert.rejects(publish(bob, 'case-review@2.0.0', v2), AccessError);
  await publish(bob, 'other-pack@1.0.0', v2);
  assert.equal(await a.ownerOf('other-pack'), bob.id);
  // A published version names one content; the owner publishes new content as a new version.
  await assert.rejects(publish(alice, 'case-review@1.0.0', v2), ConflictError);
  await publish(alice, 'case-review@1.1.0', v2);
  assert.equal((await a.publication('case-review@1.0.0'))?.body.bound, v1);
  assert.equal(await a.isPublished('case-review@1.0.0'), true);
  assert.equal(await a.isPublished('case-review@1.0.0', v1), true);
  assert.equal(await a.isPublished('case-review@1.0.0', v2), false);
  assert.equal(await a.isPublished('case-review@3.0.0'), false);
  assert.equal(await a.isPublished('not a version'), false);
  // Withdrawn by an admin: not published, and an admin's withdrawal under another subject changes nothing for the owner.
  await a.revoke(admin, { permission: 'publish', subject: alice.id, object: 'case-review@1.0.0', note: '下架' });
  assert.equal(await a.publication('case-review@1.0.0'), null);
  await a.revoke(admin, { permission: 'publish', subject: bob.id, object: 'case-review@1.1.0' });
  assert.equal(await a.isPublished('case-review@1.1.0', v2), true);
  // The owner may list the withdrawn version again with the same content; ownership outlives a revoked publish right.
  await publish(alice, 'case-review@1.0.0', v1);
  assert.equal(await a.isPublished('case-review@1.0.0', v1), true);
  await a.revokePublishRight(admin, alice.id);
  await assert.rejects(publish(alice, 'case-review@1.2.0', v2), AccessError);
  assert.equal(await a.ownerOf('case-review'), alice.id);
  assert.equal(await a.isPublished('case-review@1.0.0'), true);
});

test('two first publications of one new pack race: exactly one account becomes its owner', async (t) => {
  const kit = await openTestRecords({ postgres });
  t.after(() => kit.close());
  const { admin, alice, bob } = await setup(kit);
  await kit.authorizations.grantPublishRight(admin, alice.id);
  await kit.authorizations.grantPublishRight(admin, bob.id);
  const results = await Promise.allSettled(
    [alice, bob, alice, bob].map((by, index) =>
      kit.authorizations.grant(by, { permission: 'publish', subject: by.id, object: `new-pack@1.0.${index}`, bound: digestOf({ index }) }),
    ),
  );
  const owner = await kit.authorizations.ownerOf('new-pack');
  assert.ok(owner === alice.id || owner === bob.id);
  for (const result of results) {
    if (result.status === 'fulfilled') assert.equal(result.value.body.subject, owner);
    else assert.ok(result.reason instanceof AccessError);
  }
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 2);
});

test('resource configuration binds a content digest; the latest one is current', async (t) => {
  const kit = await openTestRecords({ postgres });
  t.after(() => kit.close());
  const { admin } = await setup(kit);
  assert.equal(await kit.authorizations.resourceConfig('plm-main'), null);
  const first = digestOf({ endpoint: 'http://192.0.2.10/', environment: 'test' });
  const second = digestOf({ endpoint: 'http://192.0.2.11/', environment: 'test' });
  await kit.authorizations.configureResource(admin, 'plm-main', first, '初次配置');
  assert.equal((await kit.authorizations.resourceConfig('plm-main'))?.body.bound, first);
  await kit.authorizations.configureResource(admin, 'plm-main', second);
  assert.equal((await kit.authorizations.resourceConfig('plm-main'))?.body.bound, second);
  await kit.authorizations.revoke(admin, { permission: 'resource_config', subject: WHOLE_HUB, object: 'plm-main' });
  assert.equal(await kit.authorizations.resourceConfig('plm-main'), null);
  await assert.rejects(kit.authorizations.configureResource(admin, 'plm-main', 'not-a-digest'), TypeError);
  assert.equal((await kit.authorizations.history({ object: 'plm-main' })).items.length, 3);
});

test('queries with malformed terms answer nothing instead of failing', async (t) => {
  const kit = await openTestRecords({ postgres });
  t.after(() => kit.close());
  const { admin, alice } = await setup(kit);
  await kit.authorizations.assign(admin, alice.id, 'case-review');
  assert.equal(await kit.authorizations.canUse(`${alice.id}|x`, 'case-review'), false);
  assert.equal(await kit.authorizations.canUse(alice.id, 'case review'), false);
  assert.equal(await kit.authorizations.isActive('approve' as never, alice.id, 'case-review'), false);
  assert.equal(await kit.authorizations.isSharedWith('', 'x'), false);
  assert.equal(await kit.authorizations.canPublish('x'.repeat(400)), false);
  assert.deepEqual(await kit.authorizations.packsFor('bad value'), []);
  assert.deepEqual(await kit.authorizations.usersOf(`pack${String.fromCharCode(0)}`), []);
  assert.equal(await kit.authorizations.resourceConfig('bad id!'), null);
  assert.deepEqual(await kit.authorizations.history({ subject: 'bad value' }), { items: [], next: null });
  assert.equal(await kit.authorizations.canUse(alice.id, 'case-review'), true);
});

test('sharing writes one record per audience member and can be taken back per member', async (t) => {
  const kit = await openTestRecords({ postgres });
  t.after(() => kit.close());
  const { admin, alice, bob } = await setup(kit);
  const records = await kit.authorizations.share(admin, 'run_00000000000000000000000001', [alice.id, bob.id, alice.id]);
  assert.equal(records.length, 2);
  assert.equal(await kit.authorizations.isSharedWith(alice.id, 'run_00000000000000000000000001'), true);
  assert.equal(await kit.authorizations.isSharedWith(bob.id, 'run_00000000000000000000000001'), true);
  await kit.authorizations.unshare(admin, 'run_00000000000000000000000001', bob.id);
  assert.equal(await kit.authorizations.isSharedWith(bob.id, 'run_00000000000000000000000001'), false);
  assert.equal(await kit.authorizations.isSharedWith(alice.id, 'run_00000000000000000000000001'), true);
  await assert.rejects(kit.authorizations.share(admin, 'x', []), TypeError);
  await assert.rejects(kit.authorizations.share(admin, 'x', ['usr_00000000000000000000000000']), ConflictError);
  const bySubject = await kit.authorizations.history({ subject: bob.id });
  assert.deepEqual(bySubject.items.map((record) => [record.body.permission, record.body.revoked]), [['share', true], ['share', false]]);
  const byPermission = await kit.authorizations.history({ permission: 'share', newestFirst: false });
  assert.equal(byPermission.items.length, 3);
  assert.equal(byPermission.items[0].body.subject, alice.id);
});
test('bulk resource configurations select latest active decisions and honor withdrawal', async t => {
  const kit=await openTestRecords({postgres});t.after(()=>kit.close());
  const {user:admin}=await kit.principals.bootstrapAdmin('合成管理员');
  const a=await kit.authorizations.configureResource(admin,'synthetic-one','a'.repeat(64));
  await kit.authorizations.configureResource(admin,'synthetic-two','b'.repeat(64));
  const found=await kit.authorizations.resourceConfigs(['synthetic-one','synthetic-two','missing','bad|term','synthetic-one']);
  assert.equal(found.size,2);assert.equal(found.get('synthetic-one')?.digest,a.digest);
  await kit.authorizations.revoke(admin,{permission:'resource_config',subject:WHOLE_HUB,object:'synthetic-one'});
  const current=await kit.authorizations.resourceConfigs(['synthetic-one','synthetic-two']);
  assert.equal(current.has('synthetic-one'),false);assert.equal(current.has('synthetic-two'),true);
});

test('grant participates in the caller transaction and rolls back with it', async t => {
  const kit=await openTestRecords({postgres}); t.after(()=>kit.close());
  const {admin,alice}=await setup(kit);
  await assert.rejects(kit.store.withTransaction(async tx=>{
    await kit.authorizations.grant(admin,{permission:'assign',subject:alice.id,object:'demo-pack'},tx);
    throw new Error('synthetic rollback');
  }),/synthetic rollback/);
  assert.equal(await kit.authorizations.latest('assign',alice.id,'demo-pack'),null);
});

test('resource configuration participates in an optional caller transaction while legacy calls commit',async t=>{
 const kit=await openTestRecords({postgres});t.after(()=>kit.close());const {admin}=await setup(kit);
 const resource='synthetic-transaction-resource',bound=digestOf({synthetic:true});
 const rollback=new Error('synthetic rollback');
 await assert.rejects(kit.store.withTransaction(async tx=>{
   const record=await kit.authorizations.configureResource(admin,resource,bound,null,tx);
   assert.ok(await kit.store.get(record.digest,tx));throw rollback;
 }),error=>error===rollback);
 assert.equal(await kit.authorizations.resourceConfig(resource),null);
 await kit.authorizations.configureResource(admin,resource,bound);
 assert.equal((await kit.authorizations.resourceConfig(resource))?.body.bound,bound);
});

test('pack audiences follow current assignments with one append-only share decision', async t => {
  const kit = await openTestRecords({ postgres }); t.after(() => kit.close());
  const { admin, alice, bob } = await setup(kit);
  const object = 'run_00000000000000000000000001';
  const audience = { kind: 'pack_users' as const, pack: 'synthetic-task' };
  const decisions = await kit.authorizations.share(admin, object, audience, '合成分享');
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].body.share_audience, 'pack_users');
  assert.equal(await kit.authorizations.isSharedWith(bob.id, object), false);
  await kit.authorizations.assign(admin, bob.id, audience.pack);
  assert.equal(await kit.authorizations.isSharedWith(bob.id, object), true);
  await kit.authorizations.unassign(admin, bob.id, audience.pack);
  assert.equal(await kit.authorizations.isSharedWith(bob.id, object), false);
  await kit.authorizations.assign(admin, bob.id, audience.pack);
  await kit.authorizations.unshare(admin, object, audience);
  assert.equal(await kit.authorizations.isSharedWith(bob.id, object), false);
  await assert.rejects(kit.authorizations.share(alice, object, audience), AccessError);
  await assert.rejects(kit.authorizations.shares(alice, object), AccessError);
  await kit.authorizations.share(admin, object, [alice.id]);
  assert.deepEqual((await kit.authorizations.shares(admin, object)).map(r => r.body.subject), [alice.id]);
});
