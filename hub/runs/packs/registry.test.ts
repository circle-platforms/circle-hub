import assert from 'node:assert/strict';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { AccessError, ConflictError, WHOLE_HUB, canonicalBytes, newId } from '../../records/api.ts';
import { startPostgres, type TemporaryPostgres } from '../../testing/postgres.ts';
import { PACK_VERSION_SCHEMA } from './registry.ts';
import { editJson, productPack, systemPack, withFiles, workflowPack } from './testing/builder.ts';
import { openPackTestbed, type PackTestbed } from './testing/setup.ts';
import type { PackVersionBody } from './types.ts';

let postgres: TemporaryPostgres;
before(async () => {
  postgres = await startPostgres();
});
after(() => postgres?.stop());

async function testbed(t: { after: (fn: () => Promise<void>) => void }): Promise<PackTestbed> {
  const bed = await openPackTestbed({ postgres });
  t.after(() => bed.close());
  return bed;
}

type Json = Record<string, any>;

test('a user with a publish right publishes: record, objects and a publication bound to the pack digest', async (t) => {
  const bed = await testbed(t);
  const outcome = await bed.publish(bed.alice, workflowPack());
  assert.equal(outcome.created, true);
  const v = outcome.version;
  assert.equal(v.id, 'demo-review');
  assert.equal(v.version, '1.0.0');
  assert.equal(v.kind, 'workflow');
  assert.equal(v.owner, bed.alice.id);
  assert.equal(v.publisher, bed.alice.id);
  assert.equal(v.withdrawn, false);
  assert.deepEqual(v.samples, { author: 3, returned_counterexample: 1, retained_delivery: 0 });
  assert.ok(await bed.kit.authorizations.isPublished('demo-review@1.0.0', v.digest));
  const publication = await bed.kit.authorizations.publication('demo-review@1.0.0');
  assert.equal(publication?.digest, v.publication);
  assert.equal(publication?.body.bound, v.digest);
  const record = await bed.kit.store.get<PackVersionBody>(v.record);
  assert.equal(record?.kind, 'pack_version');
  assert.equal(record?.schema, PACK_VERSION_SCHEMA);
  assert.equal(record?.body.digest, v.digest);
  assert.equal(record?.body.report.samples.passed, 4);
  for (const file of v.manifest.files) assert.ok(await bed.kit.objects.has(file.sha256), file.path);
  assert.ok(await bed.kit.objects.has(v.digest), 'the canonical manifest is an object whose name is the pack digest');
  const info = await bed.registry.getPack('demo-review');
  assert.equal(info?.owner, bed.alice.id);
  assert.equal(info?.latest, '1.0.0');
});

test('only a user with an active publish right publishes; a disabled account cannot', async (t) => {
  const bed = await testbed(t);
  const refused = await bed.attempt(bed.carol, workflowPack());
  assert.ok(!refused.ok && refused.problems[0].rule === 'publish.no_right');
  await bed.kit.authorizations.revokePublishRight(bed.admin, bed.bob.id);
  const revoked = await bed.attempt(bed.bob, workflowPack());
  assert.ok(!revoked.ok && revoked.problems[0].rule === 'publish.no_right');
  await bed.kit.principals.setDisabled(bed.admin, bed.alice.id, true);
  const disabled = await bed.attempt(bed.alice, workflowPack());
  assert.ok(!disabled.ok && disabled.problems[0].rule === 'publish.account');
  assert.equal(await bed.registry.getPack('demo-review'), null);
});

test('the owner of a pack id is its first publisher; only the owner publishes new versions', async (t) => {
  const bed = await testbed(t);
  await bed.publish(bed.alice, workflowPack());
  const stolen = await bed.attempt(bed.bob, workflowPack({ version: '1.1.0' }));
  assert.ok(!stolen.ok);
  assert.equal(stolen.problems[0].rule, 'publish.not_owner');
  assert.match(stolen.problems[0].message, /所有者/);
  const own = await bed.publish(bed.alice, workflowPack({ version: '1.1.0' }));
  assert.equal(own.version.owner, bed.alice.id);
  // Ownership outlives the publish right: a new owner cannot take the id even when alice loses the right.
  await bed.kit.authorizations.revokePublishRight(bed.admin, bed.alice.id);
  const still = await bed.attempt(bed.bob, workflowPack({ version: '2.0.0' }));
  assert.ok(!still.ok && still.problems[0].rule === 'publish.not_owner');
});

test('a version number is never reused and a published version never changes', async (t) => {
  const bed = await testbed(t);
  const first = await bed.publish(bed.alice, workflowPack());
  const again = await bed.publish(bed.alice, workflowPack());
  assert.equal(again.created, false, 'the same content again is the same publication');
  assert.equal(again.version.digest, first.version.digest);
  const changed = await bed.attempt(bed.alice, workflowPack({ title: '改了标题' }));
  assert.ok(!changed.ok);
  assert.equal(changed.problems[0].rule, 'publish.version_reused');
  assert.equal(changed.problems[0].field, '/version');
  assert.equal((await bed.registry.getVersion('demo-review', '1.0.0'))?.digest, first.version.digest);
  await bed.registry.retire(bed.admin, 'demo-review', '1.0.0', '有问题');
  const republished = await bed.attempt(bed.alice, workflowPack());
  assert.ok(!republished.ok && republished.problems[0].rule === 'publish.version_withdrawn');
  const kind = await bed.attempt(bed.alice, { ...productPack({ pack: 'demo-review' }), version: '3.0.0' });
  assert.ok(!kind.ok && kind.problems[0].rule === 'publish.kind_changed');
});

test('a failing sample or a blocking check without samples refuses the publication and stores nothing', async (t) => {
  const bed = await testbed(t);
  const failing = editJson<Json>(workflowPack(), 'samples/negative/titles-bad.json', (s) => void (s.expect[0].code = 'core.structure.cardinality'));
  const refused = await bed.attempt(bed.alice, failing);
  assert.ok(!refused.ok);
  assert.equal(refused.problems[0].rule, 'publish.sample_failed');
  assert.equal(refused.report?.failures[0].sample, 'titles_bad');
  assert.equal(await bed.registry.getPack('demo-review'), null);
  assert.equal(await bed.kit.authorizations.ownerOf('demo-review'), null, 'a refused publication makes nobody the owner');
  const unsampled = await bed.attempt(bed.alice, withFiles(workflowPack(), { 'samples/negative/titles-bad.json': null }));
  assert.ok(!unsampled.ok && unsampled.problems.some((p) => p.rule === 'publish.unsampled'));
  const invalid = await bed.attempt(bed.alice, editJson<Json>(workflowPack(), 'requirements.json', (r) => void r.requirements[0].checks.push('ghost')));
  assert.ok(!invalid.ok && invalid.report === null && invalid.problems.some((p) => p.rule === 'requirements.unknown_check'));
  // Fixed, it publishes.
  assert.equal((await bed.publish(bed.alice, workflowPack())).created, true);
});

test('assignment is for admins, by pack id, of workflow packs only; system packs are never assigned to users', async (t) => {
  const bed = await testbed(t);
  await bed.publish(bed.alice, workflowPack());
  await bed.publish(bed.alice, systemPack());
  await bed.publish(bed.bob, productPack());
  await assert.rejects(bed.registry.assign(bed.alice, bed.bob.id, 'demo-review'), AccessError);
  await bed.registry.assign(bed.admin, bed.bob.id, 'demo-review');
  await bed.registry.assign(bed.admin, bed.carol.id, 'demo-review');
  assert.deepEqual(await bed.registry.usersOf('demo-review'), [bed.bob.id, bed.carol.id].sort());
  assert.deepEqual(await bed.registry.packsFor(bed.bob.id), ['demo-review']);
  assert.equal(await bed.registry.canUse(bed.bob.id, 'demo-review'), true);
  await assert.rejects(bed.registry.assign(bed.admin, bed.bob.id, 'tracker-system'), (e: unknown) => e instanceof ConflictError && /系统包/.test(e.message));
  await assert.rejects(bed.registry.assign(bed.admin, bed.bob.id, 'widget'), (e: unknown) => e instanceof ConflictError && /整个 Hub/.test(e.message));
  await assert.rejects(bed.registry.assign(bed.admin, bed.bob.id, 'never-published'), ConflictError);
  await assert.rejects(bed.registry.unassign(bed.bob, bed.carol.id, 'demo-review'), AccessError);
  await bed.registry.unassign(bed.admin, bed.carol.id, 'demo-review');
  assert.deepEqual(await bed.registry.usersOf('demo-review'), [bed.bob.id]);
  const all = await bed.registry.assignments(bed.admin);
  assert.deepEqual(all.map((a) => [a.user, a.pack]), [[bed.bob.id, 'demo-review']]);
  assert.equal(all[0].decided_by, bed.admin.id);
  assert.deepEqual((await bed.registry.assignments(bed.bob)).map((a) => a.user), [bed.bob.id], 'a user sees their own assignments');
  assert.deepEqual(await bed.registry.assignments(bed.carol), []);
});

test('a product pack is inert until an admin activates it for the whole Hub; colliding names are refused with a fix', async (t) => {
  const bed = await testbed(t);
  await bed.publish(bed.bob, productPack({ id: 'widget', names: ['Widget', 'Gadget'] }));
  assert.deepEqual(await bed.registry.activeProducts(), []);
  assert.equal(await bed.registry.isActive('widget'), false);
  await assert.rejects(bed.registry.activate(bed.bob, 'widget'), AccessError);
  await bed.registry.activate(bed.admin, 'widget');
  assert.equal(await bed.registry.isActive('widget'), true);
  assert.equal(await bed.kit.authorizations.isActive('assign', WHOLE_HUB, 'widget'), true);
  assert.deepEqual((await bed.registry.activeProducts()).map((a) => a.product.id), ['widget']);

  await bed.publish(bed.alice, productPack({ id: 'sprocket', names: ['Sprocket', 'GADGET'] }));
  await assert.rejects(bed.registry.activate(bed.admin, 'sprocket'), (e: unknown) => {
    assert.ok(e instanceof ConflictError);
    assert.match(e.message, /GADGET/);
    assert.match(e.message, /widget/);
    assert.match(e.fix ?? '', /停用/);
    return true;
  });
  await bed.publish(bed.alice, productPack({ pack: 'widget-copy', id: 'widget', names: ['Thing'] }));
  await assert.rejects(bed.registry.activate(bed.admin, 'widget-copy'), (e: unknown) => e instanceof ConflictError && /产品线号 widget/.test(e.message));
  await bed.registry.deactivate(bed.admin, 'widget');
  assert.equal(await bed.registry.isActive('widget'), false);
  await bed.registry.activate(bed.admin, 'sprocket');
  assert.deepEqual((await bed.registry.activeProducts()).map((a) => a.product.id), ['sprocket']);
  // assign to WHOLE_HUB is activation; workflow and system packs are never activated.
  await bed.publish(bed.alice, workflowPack());
  await assert.rejects(bed.registry.assign(bed.admin, WHOLE_HUB, 'demo-review'), (e: unknown) => e instanceof ConflictError && /只有产品包/.test(e.message));
});

test('a new version of an active product pack may not take a name another active product pack has', async (t) => {
  const bed = await testbed(t);
  await bed.publish(bed.bob, productPack({ id: 'widget', names: ['Widget'] }));
  await bed.publish(bed.alice, productPack({ id: 'sprocket', names: ['Sprocket'] }));
  await bed.registry.activate(bed.admin, 'widget');
  await bed.registry.activate(bed.admin, 'sprocket');
  const clash = await bed.attempt(bed.alice, productPack({ id: 'sprocket', names: ['Sprocket', 'widget'], version: '1.1.0' }));
  assert.ok(!clash.ok);
  assert.equal(clash.problems[0].rule, 'product.name_collision');
  assert.equal(clash.problems[0].field, '/names/1');
  assert.equal((await bed.registry.latestVersion('sprocket'))?.version, '1.0.0');
  // An inactive product pack may publish any names; activation decides.
  await bed.registry.deactivate(bed.admin, 'sprocket');
  assert.ok((await bed.attempt(bed.alice, productPack({ id: 'sprocket', names: ['Sprocket', 'widget'], version: '1.1.0' }))).ok);
});

test('the latest version follows semantic version order among versions not withdrawn', async (t) => {
  const bed = await testbed(t);
  for (const version of ['1.0.0', '1.10.0', '1.2.0']) await bed.publish(bed.alice, workflowPack({ version }));
  assert.equal((await bed.registry.latestVersion('demo-review'))?.version, '1.10.0');
  const newest = await bed.registry.getVersion('demo-review', '1.10.0');
  await bed.registry.retire(bed.admin, 'demo-review', '1.10.0');
  assert.equal((await bed.registry.latestVersion('demo-review'))?.version, '1.2.0');
  assert.equal((await bed.registry.resolve('demo-review'))?.version, '1.2.0');
  assert.equal(await bed.registry.resolve('demo-review@1.10.0'), null, 'a withdrawn version cannot be used');
  assert.equal((await bed.registry.resolve('demo-review@1.0.0'))?.version, '1.0.0', 'an older version can still be named');
  const withdrawn = await bed.registry.getVersion('demo-review', '1.10.0');
  assert.equal(withdrawn?.withdrawn, true);
  assert.ok(withdrawn?.withdrawn_at);
  assert.equal((await bed.registry.byDigest(newest?.digest as string))?.withdrawn, true, 'a withdrawn version stays readable by digest');
  const info = await bed.registry.getPack('demo-review');
  assert.deepEqual(info?.versions.map((v) => [v.version, v.withdrawn]), [['1.10.0', true], ['1.2.0', false], ['1.0.0', false]]);
  await assert.rejects(bed.registry.retire(bed.admin, 'demo-review', '1.10.0'), ConflictError, 'withdrawn once');
  await assert.rejects(bed.registry.retire(bed.bob, 'demo-review', '1.2.0'), AccessError, 'not the owner and not an admin');
  await bed.registry.retire(bed.admin, 'demo-review', '1.2.0');
  await bed.registry.retire(bed.admin, 'demo-review', '1.0.0');
  assert.equal(await bed.registry.latestVersion('demo-review'), null);
  assert.equal(await bed.registry.resolve('demo-review'), null);
});

test('only an admin withdraws (R01 R[1], T02 R[4]); to anyone else absent and forbidden look the same', async (t) => {
  const bed = await testbed(t);
  await bed.publish(bed.alice, workflowPack());
  const refusals: string[] = [];
  for (const [who, version] of [
    [bed.alice, '1.0.0'],
    [bed.alice, '9.9.9'],
    [bed.carol, '1.0.0'],
    [bed.carol, '9.9.9'],
    [bed.bob, '1.0.0'],
  ] as const) {
    await assert.rejects(bed.registry.retire(who, 'demo-review', version), (e: unknown) => {
      assert.ok(e instanceof AccessError, `${who.name} ${version}: ${String(e)}`);
      refusals.push(e.message);
      return true;
    });
  }
  assert.equal(new Set(refusals).size, 1, 'one neutral refusal whatever exists');
  assert.equal((await bed.registry.getVersion('demo-review', '1.0.0'))?.withdrawn, false, 'the owner did not withdraw it');
  await assert.rejects(bed.registry.retire(bed.admin, 'demo-review', '9.9.9'), ConflictError, 'an admin learns that the version does not exist');
  const record = await bed.registry.retire(bed.admin, 'demo-review', '1.0.0', '有问题');
  assert.equal(record.body.decided_by, bed.admin.id);
  assert.equal(record.body.revoked, true);
});

test('a version too long to be named is refused before anything is written', async (t) => {
  const bed = await testbed(t);
  const outcome = await bed.attempt(bed.bob, workflowPack({ version: `1.0.${'7'.repeat(95)}` }));
  assert.ok(!outcome.ok);
  assert.deepEqual(outcome.problems.map((p) => [p.rule, p.field]), [['manifest.version', '/version']]);
  assert.equal(await bed.kit.authorizations.ownerOf('demo-review'), null, 'nobody became the owner');
  assert.equal((await bed.kit.store.list({ kind: 'pack_version', limit: 10 })).items.length, 0, 'no pack_version record');
  // Alice can still take the id with a normal version.
  assert.equal((await bed.publish(bed.alice, workflowPack())).version.owner, bed.alice.id);
});

test('activation compares every version not withdrawn: an older version may become the version in use', async (t) => {
  const bed = await testbed(t);
  // The reviewers' case: zline is active; aline 1.0.0 claims its line id and a name, aline 2.0.0 claims neither.
  await bed.publish(bed.bob, productPack({ id: 'zline', names: ['Zeta', 'Zed'] }));
  await bed.registry.activate(bed.admin, 'zline');
  await bed.publish(bed.alice, productPack({ pack: 'aline', id: 'zline', names: ['Zeta'], version: '1.0.0' }));
  await bed.publish(bed.alice, productPack({ pack: 'aline', id: 'decoy', names: ['Decoy'], version: '2.0.0' }));
  await assert.rejects(bed.registry.activate(bed.admin, 'aline'), (e: unknown) => {
    assert.ok(e instanceof ConflictError);
    assert.match(e.message, /aline@1\.0\.0/);
    assert.match(e.message, /产品线号 zline/);
    assert.match(e.message, /Zeta/);
    assert.match(e.fix ?? '', /停用 zline/);
    return true;
  });
  assert.equal(await bed.registry.isActive('aline'), false);
  // Withdrawing the colliding old version (an admin decision) clears the way.
  await bed.registry.retire(bed.admin, 'aline', '1.0.0');
  await bed.registry.activate(bed.admin, 'aline');
  assert.deepEqual((await bed.registry.activeProducts()).map((a) => a.info.id).sort(), ['aline', 'zline']);
});

test('a new version of an active product pack may not claim a name an older version of another active one still has', async (t) => {
  const bed = await testbed(t);
  await bed.publish(bed.bob, productPack({ id: 'widget', names: ['Widget'], version: '1.0.0' }));
  await bed.publish(bed.bob, productPack({ id: 'widget', names: ['Gizmo'], version: '2.0.0' }));
  await bed.publish(bed.alice, productPack({ id: 'sprocket', names: ['Sprocket'] }));
  await bed.registry.activate(bed.admin, 'widget');
  await bed.registry.activate(bed.admin, 'sprocket');
  const clash = await bed.attempt(bed.alice, productPack({ id: 'sprocket', names: ['Sprocket', 'WIDGET'], version: '1.1.0' }));
  assert.ok(!clash.ok);
  assert.deepEqual(clash.problems.map((p) => [p.rule, p.field]), [['product.name_collision', '/names/1']]);
  assert.match(clash.problems[0].message, /widget@1\.0\.0（未下架的旧版本/);
  // A lower number is no way around it: every version not withdrawn can become the version in use.
  const lower = await bed.attempt(bed.alice, productPack({ id: 'sprocket', names: ['Gizmo'], version: '0.9.0' }));
  assert.ok(!lower.ok && lower.problems[0].rule === 'product.name_collision');
  assert.deepEqual((await bed.registry.getPack('sprocket'))?.versions.map((v) => v.version), ['1.0.0']);
});

test('withdrawing the version in use is refused when the version taking its place would collide; the fix says what to do', async (t) => {
  const bed = await testbed(t);
  await bed.publish(bed.bob, productPack({ id: 'widget', names: ['Widget'], version: '1.0.0' }));
  await bed.publish(bed.bob, productPack({ id: 'widget', names: ['Gizmo'], version: '2.0.0' }));
  await bed.publish(bed.alice, productPack({ id: 'sprocket', names: ['Widget'] }));
  await bed.registry.activate(bed.admin, 'widget');
  await assert.rejects(bed.registry.activate(bed.admin, 'sprocket'), ConflictError, 'widget@1.0.0 can become the version in use');
  // The state the registry refuses, reached around it (straight through records, or by an earlier Hub): both active.
  await bed.kit.authorizations.grant(bed.admin, { permission: 'assign', subject: WHOLE_HUB, object: 'sprocket' });
  await assert.rejects(bed.registry.retire(bed.admin, 'widget', '2.0.0'), (e: unknown) => {
    assert.ok(e instanceof ConflictError);
    assert.match(e.message, /widget@1\.0\.0 会成为在用版本/);
    assert.match(e.fix ?? '', /先停用 widget 或 sprocket，再下架这一版/);
    return true;
  });
  assert.equal((await bed.registry.getVersion('widget', '2.0.0'))?.withdrawn, false);
  // Following the fix: once one of the two is deactivated, the version in use can be withdrawn.
  await bed.registry.deactivate(bed.admin, 'sprocket');
  await bed.registry.retire(bed.admin, 'widget', '2.0.0');
  assert.equal((await bed.registry.latestVersion('widget'))?.version, '1.0.0');
});

/** Pairs of active product packs that claim one line id or name in versions not withdrawn, from what the registry shows. */
async function clashes(bed: PackTestbed): Promise<string[]> {
  const claims: { id: string; product: string; names: string[] }[] = [];
  for (const pack of await bed.registry.listPacks()) {
    if (pack.kind !== 'product' || !(await bed.registry.isActive(pack.id))) continue;
    for (const v of pack.versions.filter((x) => !x.withdrawn)) {
      const d = await bed.registry.declarations(v.digest);
      if (d?.kind === 'product') claims.push({ id: pack.id, product: d.product.id, names: d.product.names.map((n) => n.toLowerCase()) });
    }
  }
  const out: string[] = [];
  for (const a of claims) for (const b of claims) if (a.id < b.id && (a.product === b.product || a.names.some((n) => b.names.includes(n)))) out.push(`${a.id}/${b.id}`);
  return out;
}

test('two Hub processes activating colliding product packs at the same moment never leave both active', async (t) => {
  const bed = await testbed(t);
  await bed.publish(bed.bob, productPack({ id: 'widget', names: ['Name0'] }));
  await bed.publish(bed.alice, productPack({ id: 'sprocket', names: ['NAME0'] }));
  const other = bed.second();
  for (let round = 0; round < 10; round++) {
    const results = await Promise.allSettled([bed.registry.activate(bed.admin, 'widget'), other.activate(bed.admin, 'sprocket')]);
    assert.ok(results.some((r) => r.status === 'rejected'), `round ${round}: both activations succeeded`);
    for (const r of results) if (r.status === 'rejected') assert.ok(r.reason instanceof ConflictError, String(r.reason));
    assert.deepEqual(await clashes(bed), [], `round ${round}`);
    for (const pack of ['widget', 'sprocket']) if (await bed.registry.isActive(pack)) await bed.registry.deactivate(bed.admin, pack);
  }
});

test('a version published in one process while another activates a colliding pack never leaves both in effect', async (t) => {
  const bed = await testbed(t);
  await bed.publish(bed.bob, productPack({ id: 'widget', names: ['Widget'] }));
  await bed.registry.activate(bed.admin, 'widget');
  const other = bed.second();
  for (let round = 0; round < 6; round++) {
    await bed.publish(bed.alice, productPack({ id: `gadget-${round}`, names: [`GIZMO${round}`] }));
    const [published, activated] = await Promise.allSettled([bed.attempt(bed.bob, productPack({ id: 'widget', names: ['Widget', `Gizmo${round}`], version: `2.${round}.0` })), other.activate(bed.admin, `gadget-${round}`)]);
    const publishedOk = published.status === 'fulfilled' && published.value.ok;
    assert.ok(!(publishedOk && activated.status === 'fulfilled'), `round ${round}: the publication and the activation both took effect`);
    if (published.status === 'fulfilled' && !published.value.ok) {
      assert.ok(published.value.problems.some((p) => p.rule === 'product.name_collision'), JSON.stringify(published.value.problems));
    }
    assert.deepEqual(await clashes(bed), [], `round ${round}`);
  }
});

test('publications list every version with its sample counts; malformed references have no answer', async (t) => {
  const bed = await testbed(t);
  await bed.publish(bed.alice, workflowPack());
  await bed.publish(bed.bob, productPack());
  const all = await bed.registry.publications();
  assert.deepEqual(all.map((p) => p.id).sort(), ['demo-review', 'widget']);
  assert.deepEqual(all.find((p) => p.id === 'demo-review')?.samples, { author: 3, returned_counterexample: 1, retained_delivery: 0 });
  assert.deepEqual(all.find((p) => p.id === 'widget')?.samples, { author: 0, returned_counterexample: 0, retained_delivery: 0 });
  assert.equal((await bed.registry.publications('widget')).length, 1);
  assert.deepEqual((await bed.registry.listPacks()).map((p) => [p.id, p.kind, p.latest]), [['demo-review', 'workflow', '1.0.0'], ['widget', 'product', '1.0.0']]);
  for (const ref of ['', 'Demo', 'demo-review@1', 'demo-review@01.0.0', '../x', 'demo-review@1.0.0@1.0.0']) assert.equal(await bed.registry.resolve(ref), null, ref);
  assert.equal(await bed.registry.byDigest('0'.repeat(64)), null);
  assert.equal(await bed.registry.byDigest('not a digest'), null);
});

test('a version is extracted read-only once published, and a second registry over the same records sees it', async (t) => {
  const bed = await testbed(t);
  const { version } = await bed.publish(bed.alice, workflowPack());
  const directory = await bed.registry.extractPack(version.digest);
  assert.equal(directory, join(bed.extractDir, version.digest));
  assert.equal((await lstat(directory)).mode & 0o777, 0o500);
  const other = bed.second();
  assert.equal((await other.latestVersion('demo-review'))?.digest, version.digest);
  assert.equal(await other.extractPack(version.digest), directory);
  await assert.rejects(bed.registry.extractPack('f'.repeat(64)), ConflictError);
  await assert.rejects(bed.registry.extractPack('../../etc'), ConflictError);
});

test('publication answers only explicit repair requests bound to the same pack and named publisher',async t=>{
  const bed=await testbed(t);
  const old=await bed.publish(bed.alice,workflowPack());
  const {createRequestService}=await import('../../requests/api.ts');
  const requests=createRequestService(bed.kit);
  const request=await requests.write({pack_digest:old.version.digest,kind:'repair',audience:bed.alice.id,due:'2026-10-26T00:00:00.000Z',missing:'合成检查缺少逐条结果',next_action:'发布修复版本并明确回答本请求',source:old.version.record,code:'check_error'});
  const unrelated=await bed.publish(bed.alice,workflowPack({version:'1.0.1'}));
  assert.equal((await requests.inspect(request.digest))?.answered_by,null,'an unrelated publication never answers a request');
  const correction=await bed.write(workflowPack({version:'1.0.2'}));
  const answered=await bed.registry.publish(bed.alice,correction.dir,{answerRequests:[request.digest,request.digest]});
  assert.ok(answered.ok,JSON.stringify(!answered.ok&&answered.problems));
  assert.equal((await requests.inspect(request.digest))?.answered_by,answered.version.record);
  const repeated=await bed.registry.publish(bed.alice,correction.dir,{answerRequests:[request.digest]});
  assert.ok(repeated.ok);assert.equal(repeated.created,false);
  assert.notEqual(unrelated.version.record,answered.version.record);
});
test('a publication cannot answer another publisher or pack request and refuses before publishing bytes',async t=>{
  const bed=await testbed(t);
  const old=await bed.publish(bed.alice,workflowPack());
  const {createRequestService}=await import('../../requests/api.ts');const requests=createRequestService(bed.kit);
  const request=await requests.write({pack_digest:old.version.digest,kind:'repair',audience:bed.alice.id,due:'2026-10-26T00:00:00.000Z',missing:'合成声明缺口',next_action:'发布修复版本',source:old.version.record,code:'check_error'});
  const other=await bed.write(workflowPack({id:'other-review'}));
  const denied=await bed.registry.publish(bed.bob,other.dir,{answerRequests:[request.digest]});
  assert.equal(denied.ok,false);
  assert.equal(await bed.registry.getPack('other-review'),null);
  assert.equal((await requests.inspect(request.digest))?.answered_by,null);
});

test('a committed publication with an interrupted request answer accepts an exact retry',async t=>{
  const bed=await testbed(t);
  const old=await bed.publish(bed.alice,workflowPack());
  const {createRequestService}=await import('../../requests/api.ts');const requests=createRequestService(bed.kit);
  const question=await requests.write({pack_digest:old.version.digest,kind:'repair',audience:bed.alice.id,due:'2026-10-26T00:00:00.000Z',missing:'合成恢复验证',next_action:'发布并回答',source:old.version.record,code:'check_error'});
  const next=await bed.write(workflowPack({version:'1.0.1'}));
  const put=bed.kit.store.put.bind(bed.kit.store);let fail=true;
  t.mock.method(bed.kit.store,'put',async(...args:Parameters<typeof put>)=>{const input=args[0];if(fail&&input.kind==='action'&&(input.body as {detail?:{request?:string}}).detail?.request===question.digest){fail=false;throw new Error('SyntheticAnswerStoreFailure');}return put(...args);});
  await assert.rejects(bed.registry.publish(bed.alice,next.dir,{answerRequests:[question.digest]}),/包版本已发布，但请求作答尚未全部保存/);
  assert.ok(await bed.registry.getVersion('demo-review','1.0.1'));
  assert.equal((await requests.inspect(question.digest))?.answered_by,null);
  const retried=await bed.registry.publish(bed.alice,next.dir,{answerRequests:[question.digest]});
  assert.ok(retried.ok);assert.equal(retried.created,false);
  assert.equal((await requests.inspect(question.digest))?.answered_by,retried.version.record);
});

test('published variable names belong permanently to one pack and keep their schema', async t => {
  const bed=await testbed(t);
  const registry=bed.second({variableNameAvailable:async()=>true});
  const source=(id:string,version:string, schema:unknown={type:'array',items:{type:'string'}}, fallback:unknown=[])=>editJson<Json>(productPack({id,version}),'product.json',p=>{
    p.variables=[{name:'DEMO_OPTIONS',description:'Synthetic options',schema,default:fallback}];
    p.producers[0].params={options:'${var:DEMO_OPTIONS}'};
  });
  const publish=async(pack:ReturnType<typeof source>)=>registry.publish(bed.alice,(await bed.write(pack)).dir);
  assert.equal((await publish(source('demo-first','1.0.0'))).ok,true);
  const other=await publish(source('demo-second','1.0.0'));
  assert.equal(other.ok,false); if(!other.ok)assert.equal(other.problems[0].message,'名字不可用');
  const changed=await publish(source('demo-first','1.1.0',{type:'string'},'demo'));
  assert.equal(changed.ok,false);
  assert.equal((await publish(source('demo-first','1.2.0',undefined,['demo']))).ok,true);
  await registry.retire(bed.admin,'demo-first','1.0.0');
  await registry.retire(bed.admin,'demo-first','1.2.0');
  assert.equal((await publish(source('demo-second','1.1.0'))).ok,false);
});

test('two registries racing for one variable name grant exactly one publication',async t=>{
 const bed=await testbed(t);
 const dirs=await Promise.all(['demo-left','demo-right'].map(id=>bed.write(editJson<Json>(productPack({id}),'product.json',p=>{
   p.variables=[{name:'DEMO_RACING',description:'Synthetic',schema:{type:'integer'},default:1}];p.producers[0].params={n:'${var:DEMO_RACING}'};
 }))));
 const outcomes=await Promise.all(dirs.map(d=>bed.second({variableNameAvailable:async()=>true}).publish(bed.alice,d.dir)));
 assert.equal(outcomes.filter(o=>o.ok).length,1);
});

test('an absent deployment-name port reports the missing assembly fact and its repair',async t=>{
 const bed=await testbed(t);
 const source=editJson<Json>(productPack(),'product.json',p=>{p.variables=[{name:'DEMO_PORT_CHECK',description:'Synthetic',schema:{type:'integer'},default:1}];p.producers[0].params={n:'${var:DEMO_PORT_CHECK}'};});
 const outcome=await bed.attempt(bed.alice,source);assert.equal(outcome.ok,false);
 if(!outcome.ok){assert.match(outcome.problems[0].message,/端口/);assert.match(outcome.problems[0].fix,/装配.*重新发布/);}
});


test('an owning pack can publish after deployment starts using its variable while schema changes still refuse',async t=>{
 const bed=await testbed(t);
 const {productVariableNameAvailable}=await import('../../server/variables.ts');
 const registry=bed.second({variableNameAvailable:(name,tx)=>productVariableNameAvailable(bed.kit,name,tx)});
 const source=(version:string,schema:unknown={type:'string'},fallback:unknown='synthetic')=>editJson<Json>(productPack({id:'demo-owner',version}),'product.json',p=>{
   p.variables=[{name:'DEMO_OWNER_NAME',description:'Synthetic setting',schema,default:fallback}];
   p.producers[0].params={option:'${var:DEMO_OWNER_NAME}'};
 });
 const publish=async(version:string,schema?:unknown,fallback?:unknown)=>registry.publish(bed.alice,(await bed.write(source(version,schema,fallback))).dir);
 assert.equal((await publish('1.0.0')).ok,true);
 const id=newId('res');
 const object=await bed.kit.objects.put(canonicalBytes({schema:'resource@1',id,system_pack:'demo-system@1.0.0',system_pack_digest:'b'.repeat(64),enabled:true,origins:{api:'https://service.example.invalid'},allow_plaintext:[],credentials:{},credential_digests:{},settings:{option:'${var:DEMO_OWNER_NAME}'}}),'application/json');
 await bed.kit.authorizations.configureResource(bed.admin,id,object.sha256,'合成部署引用');
 assert.equal(await bed.kit.store.withTransaction(tx=>productVariableNameAvailable(bed.kit,'DEMO_OWNER_NAME',tx)),false);
 const next=await publish('1.1.0',undefined,'synthetic changed');
 assert.equal(next.ok,true,JSON.stringify(!next.ok&&next.problems));
 const changed=await publish('1.2.0',{type:'integer'},1);
 assert.equal(changed.ok,false);if(!changed.ok)assert.equal(changed.problems[0].rule,'variables.schema_changed');
});
