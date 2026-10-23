import assert from 'node:assert/strict';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { ChecksFile, RequirementsFile, SlotsFile, WorkflowFile } from '../../../contracts/src/pack.ts';
import { PackSummary } from '../../../contracts/src/run.ts';
import { ConflictError, IntegrityError, sha256Hex, WHOLE_HUB, type Principal } from '../../records/api.ts';
import { startPostgres, type TemporaryPostgres } from '../../testing/postgres.ts';
import { PackFileError } from './load.ts';
import { publishCheckMarks } from './marks.ts';
import { createPackCatalog, createPacksPort, createWorkflowStore } from './ports.ts';
import { corruptByte, editJson, productPack, systemPack, TITLES_TABLE, workflowPack } from './testing/builder.ts';
import { openPackTestbed, type PackTestbed } from './testing/setup.ts';

let postgres: TemporaryPostgres;
before(async () => {
  postgres = await startPostgres();
});
after(() => postgres?.stop());

type Json = Record<string, any>;

async function testbed(t: { after: (fn: () => Promise<void>) => void }): Promise<PackTestbed> {
  const bed = await openPackTestbed({ postgres });
  t.after(() => bed.close());
  return bed;
}

const ghost: Principal = { id: 'usr_01jacd5z8q3w7v9h2k4m6n8p0z', name: '不存在', role: 'admin' };

test('forUser: an assigned user gets the loaded workflow; unknown, unassigned, withdrawn, other kinds and disabled give the same null', async (t) => {
  const bed = await testbed(t);
  const { version } = await bed.publish(bed.alice, workflowPack());
  await bed.publish(bed.alice, systemPack());
  await bed.publish(bed.bob, productPack());
  await bed.registry.activate(bed.admin, 'widget');
  await bed.registry.assign(bed.admin, bed.bob.id, 'demo-review');
  // Assignments the registry would refuse, written straight through records: still never a workflow.
  await bed.kit.authorizations.assign(bed.admin, bed.bob.id, 'tracker-system');
  await bed.kit.authorizations.assign(bed.admin, bed.bob.id, 'widget');
  const store = createWorkflowStore(bed.registry);

  assert.equal(await store.ownerOf?.(version.digest), bed.alice.id);
  assert.equal(await store.publicationOf?.(version.digest), version.record);
  assert.equal(await store.ownerOf?.('e'.repeat(64)), null);
  const loaded = await store.forUser(bed.bob, 'demo-review');
  assert.ok(loaded);
  assert.deepEqual({ ...loaded.pack, directory: undefined }, { id: 'demo-review', version: '1.0.0', digest: version.digest, kind: 'workflow', directory: undefined });
  assert.equal((await lstat(loaded.pack.directory)).mode & 0o777, 0o500);
  assert.equal(loaded.manifest.id, 'demo-review');
  assert.ok(WorkflowFile.safeParse(loaded.workflow).success);
  assert.ok(RequirementsFile.safeParse({ schema: 'requirements@1', requirements: loaded.requirements }).success);
  assert.ok(ChecksFile.safeParse({ schema: 'checks@1', checks: loaded.checks }).success);
  assert.ok(SlotsFile.safeParse(loaded.slots).success);
  assert.deepEqual(loaded.requirements.map((r) => r.key), ['titles', 'findings', 'level']);
  assert.equal(loaded.knowledge?.requires[0].catalog, 'commands@1');
  const skill = await readFile(join(loaded.pack.directory, 'SKILL.md'));
  assert.equal(loaded.instructions, skill.toString('utf8'));
  assert.equal(loaded.instructionsDigest, sha256Hex(skill));
  assert.equal((await store.forUser(bed.bob, 'demo-review@1.0.0'))?.pack.digest, version.digest);
  // Each caller gets its own copy of the declarations.
  loaded.requirements.pop();
  assert.equal((await store.forUser(bed.bob, 'demo-review'))?.requirements.length, 3);

  for (const [who, ref] of [
    [bed.carol, 'demo-review'],
    [bed.bob, 'unknown-pack'],
    [bed.bob, 'demo-review@9.9.9'],
    [bed.bob, 'demo-review@1.0'],
    [bed.bob, 'tracker-system'],
    [bed.bob, 'widget'],
    [bed.bob, '../demo-review'],
    [ghost, 'demo-review'],
  ] as [Principal, string][]) {
    assert.equal(await store.forUser(who, ref), null, `${who.name} ${ref}`);
  }
  assert.equal(await store.absence?.(bed.carol, 'demo-review@1.0.0'), 'unassigned');
  assert.equal(await store.absence?.(bed.bob, 'unknown-pack@10.6.0'), 'unknown');
  assert.equal(await store.absence?.(bed.bob, 'demo-review@1.0.0'), null);
  await bed.registry.retire(bed.admin, 'demo-review', '1.0.0');
  assert.equal(await store.absence?.(bed.bob, 'demo-review@1.0.0'), 'withdrawn');
  assert.equal(await store.forUser(bed.bob, 'demo-review'), null, 'withdrawn: no latest version');
  assert.equal(await store.forUser(bed.bob, 'demo-review@1.0.0'), null, 'withdrawn: not by its version either');
  assert.equal((await store.byDigest(version.digest))?.pack.version, '1.0.0', 'a run that froze it still reads it');
  await bed.publish(bed.alice, workflowPack({ version: '1.0.1' }));
  assert.equal((await store.forUser(bed.bob, 'demo-review'))?.pack.version, '1.0.1', 'a new version is available to the assigned users at once');
  await bed.kit.principals.setDisabled(bed.admin, bed.bob.id, true);
  assert.equal(await store.absence?.(bed.bob, 'demo-review@1.0.1'), 'disabled');
  assert.equal(await store.forUser(bed.bob, 'demo-review'), null, 'a disabled account gets nothing');
});

test('byDigest answers for workflow versions ever published and nothing else', async (t) => {
  const bed = await testbed(t);
  const store = createWorkflowStore(bed.registry);
  const product = await bed.publish(bed.bob, productPack());
  assert.equal(await store.byDigest(product.version.digest), null);
  assert.equal(await store.byDigest('e'.repeat(64)), null);
  assert.equal(await store.byDigest('../../etc'), null);
});

test('readJson reads only files the manifest lists, from the extracted pack, verified against their digests', async (t) => {
  const bed = await testbed(t);
  await bed.publish(bed.alice, workflowPack());
  await bed.registry.assign(bed.admin, bed.bob.id, 'demo-review');
  const store = createWorkflowStore(bed.registry);
  const loaded = await store.forUser(bed.bob, 'demo-review');
  assert.ok(loaded);
  assert.deepEqual(loaded.readJson('tables/titles.json'), TITLES_TABLE);
  assert.equal((loaded.readJson('pack.json') as Json).id, 'demo-review');
  for (const path of ['../pack.json', '/etc/hosts', 'functions/../tables/titles.json', 'tables/none.json', '', 'tables/', 'tables//titles.json', join(loaded.pack.directory, 'tables/titles.json')]) {
    assert.throws(() => loaded.readJson(path), PackFileError, path);
  }
  assert.throws(() => loaded.readJson('SKILL.md'), PackFileError, 'a listed file that is not JSON');
  await corruptByte(loaded.pack.directory, 'tables/titles.json', { offset: 5 });
  assert.throws(() => loaded.readJson('tables/titles.json'), IntegrityError, 'a changed byte after extraction is caught on read');
  const reloaded = await store.forUser(bed.bob, 'demo-review');
  assert.deepEqual(reloaded?.readJson('tables/titles.json'), TITLES_TABLE, 'the next use verifies the tree and rebuilds it');
  assert.equal(bed.tamper.length, 1);
});

test('summaries: the packs a user may use, with the names of the bound product lines, inputs, parameters and requirements', async (t) => {
  const bed = await testbed(t);
  await bed.publish(bed.alice, workflowPack());
  await bed.publish(bed.bob, productPack({ id: 'widget', names: ['Widget', 'Gadget'], catalogs: ['commands@1'] }));
  await bed.publish(bed.bob, productPack({ id: 'sprocket', names: ['Sprocket'], catalogs: ['parts@1'] }));
  await bed.registry.assign(bed.admin, bed.bob.id, 'demo-review');
  const store = createWorkflowStore(bed.registry);

  const inactive = await store.summaries(bed.bob);
  assert.deepEqual(inactive.map((s) => s.products), [[]], 'no active product line binds yet');
  await bed.registry.activate(bed.admin, 'widget');
  await bed.registry.activate(bed.admin, 'sprocket');
  const [summary] = await store.summaries(bed.bob);
  assert.ok(PackSummary.safeParse(summary).success, JSON.stringify(PackSummary.safeParse(summary).error?.issues));
  assert.equal(summary.pack, 'demo-review@1.0.0');
  assert.deepEqual(summary.products, ['Widget', 'Gadget'], 'the line whose catalogs include the required ones, by every name');
  assert.deepEqual(summary.inputs, [{ slot: 'target', role: 'subject', description: '被判的文档', accepts: ['application/json'], required: true, many: false }]);
  assert.deepEqual(summary.parameters, [{ name: 'strict', description: '严格模式', required: false, schema: { type: 'boolean' } }], 'each parameter is listed with its name, description and value schema');
  assert.deepEqual(summary.requirements.map((r) => [r.key, r.repair_rounds, r.accepted_producer]), [['titles', 2, 'fact'], ['findings', 0, 'judgment'], ['level', 0, 'judgment']]);
  assert.deepEqual(await store.summaries(bed.carol), []);
  assert.deepEqual(await store.summaries(ghost), []);

  await bed.publish(bed.alice, editJson<Json>(workflowPack({ version: '2.0.0' }), 'workflow.json', (w) => void (w.product = { id: 'sprocket', catalogs: [] })));
  const [bound] = await store.summaries(bed.bob);
  assert.equal(bound.version, '2.0.0');
  assert.deepEqual(bound.products, ['Sprocket'], 'a workflow with product.id binds that line only');
});

test('PacksPort: packs by reference, active product lines only, readable products follow assignments', async (t) => {
  const bed = await testbed(t);
  await bed.publish(bed.alice, workflowPack());
  await bed.publish(bed.alice, systemPack());
  await bed.publish(bed.bob, productPack({ id: 'widget', names: ['Widget', 'Gadget'] }));
  await bed.publish(bed.bob, productPack({ id: 'sprocket', names: ['Sprocket'], catalogs: ['parts@1'] }));
  const port = createPacksPort(bed.registry);

  assert.equal((await port.pack('demo-review'))?.kind, 'workflow');
  assert.equal((await port.pack('tracker-system@1.0.0'))?.kind, 'system');
  assert.equal(await port.pack('widget'), null, 'an inactive product pack is not visible');
  assert.equal(await port.productByName('Gadget'), null);
  assert.equal(await port.productById('widget'), null);
  assert.deepEqual(await port.products(), []);

  await bed.registry.activate(bed.admin, 'widget');
  const byName = await port.productByName('gADGET');
  assert.equal(byName?.product.id, 'widget');
  assert.equal(byName?.kind, 'product');
  assert.equal((await lstat(byName?.directory as string)).mode & 0o777, 0o500);
  assert.equal((await port.productById('widget'))?.id, 'widget');
  assert.equal(await port.productByName('Sprocket'), null);
  assert.deepEqual((await port.products()).map((p) => p.product.id), ['widget']);
  assert.equal((await port.pack('widget'))?.kind, 'product');
  assert.equal(await port.productByName(''), null);

  await bed.registry.activate(bed.admin, 'sprocket');
  await bed.registry.assign(bed.admin, bed.bob.id, 'demo-review');
  assert.deepEqual([...(await port.readableProducts(bed.bob))], ['widget'], 'bound by the catalogs the workflow requires');
  assert.deepEqual([...(await port.readableProducts(bed.carol))], []);
  assert.deepEqual([...(await port.readableProducts(bed.admin))].sort(), ['sprocket', 'widget']);
  assert.deepEqual([...(await port.readableProducts(ghost))], [], 'an account that does not exist reads nothing, whatever role it claims');
  await bed.registry.deactivate(bed.admin, 'widget');
  assert.deepEqual([...(await port.readableProducts(bed.bob))], []);

  await bed.registry.retire(bed.admin, 'demo-review', '1.0.0');
  assert.equal(await port.pack('demo-review'), null);
  assert.equal(await port.pack('demo-review@1.0.0'), null);
});

test('PacksPort: a name or line id several active product packs claim answers null and is reported, never picked', async (t) => {
  const errors: [unknown, string][] = [];
  const bed = await openPackTestbed({ postgres, registry: { onError: (error, context) => errors.push([error, context]) } });
  t.after(() => bed.close());
  await bed.publish(bed.bob, productPack({ id: 'widget', names: ['Widget', 'Gadget'] }));
  await bed.publish(bed.alice, productPack({ pack: 'aline', id: 'widget', names: ['GADGET'] }));
  await bed.registry.activate(bed.admin, 'widget');
  await assert.rejects(bed.registry.activate(bed.admin, 'aline'), ConflictError);
  // The state the registry refuses, reached around it: both active.
  await bed.kit.authorizations.grant(bed.admin, { permission: 'assign', subject: WHOLE_HUB, object: 'aline' });
  const port = createPacksPort(bed.registry);
  assert.equal(await port.productByName('gadget'), null);
  assert.equal(await port.productById('widget'), null);
  assert.equal((await port.productByName('Widget'))?.id, 'widget', 'a name only one of them claims still answers');
  assert.deepEqual(errors.map(([, context]) => context), ['packs.product_ambiguous', 'packs.product_ambiguous']);
  assert.match(String((errors[0][0] as Error).message), /aline@1\.0\.0/);
});

test('publishCheckMarks gives a run the marks of the stored publish report (T02 R[1]); a withdrawal shows through the ports (T02 R[6])', async (t) => {
  const bed = await testbed(t);
  const { version } = await bed.publish(bed.alice, workflowPack());
  await bed.registry.assign(bed.admin, bed.bob.id, 'demo-review');
  const store = createWorkflowStore(bed.registry);
  const loaded = await store.forUser(bed.bob, 'demo-review');
  assert.ok(loaded);
  const marks = publishCheckMarks(loaded);
  assert.deepEqual(marks, { titles: [], codes: ['author_samples_only'] });
  assert.deepEqual(marks, Object.fromEntries(version.report.checks.map((c) => [c.check, c.marks])), 'the same marks as the stored report');
  // Withdrawn: the frozen version still loads by digest while the reference names nothing usable.
  await bed.registry.retire(bed.admin, 'demo-review', '1.0.0');
  assert.equal(await createPacksPort(bed.registry).pack('demo-review@1.0.0'), null);
  assert.ok(await store.byDigest(version.digest));
  assert.equal((await bed.registry.byDigest(version.digest))?.withdrawn, true);
});

test('PackCatalogPort: a user lists the packs assigned to them, an admin every version with owner, digest, withdrawal, activation, samples and assignments', async (t) => {
  const bed = await testbed(t);
  const first = await bed.publish(bed.alice, workflowPack());
  await bed.publish(bed.alice, workflowPack({ version: '1.1.0' }));
  await bed.publish(bed.bob, productPack());
  await bed.registry.activate(bed.admin, 'widget');
  await bed.registry.assign(bed.admin, bed.bob.id, 'demo-review');
  await bed.registry.retire(bed.admin, 'demo-review', '1.1.0');
  const catalog = createPackCatalog(bed.registry);

  const mine = await catalog.list(bed.bob);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].version, '1.0.0', 'the newest version that is not withdrawn');
  assert.equal(mine[0].assigned_to, undefined, 'assignments are for admins');
  assert.deepEqual(await catalog.list(bed.carol), []);
  assert.deepEqual(await catalog.list(ghost), []);

  const everything = await catalog.list(bed.admin);
  const row = (id: string, version: string) => everything.find((l) => l.id === id && l.version === version);
  assert.deepEqual(row('demo-review', '1.0.0'), {
    id: 'demo-review',
    version: '1.0.0',
    kind: 'workflow',
    title: '合成评审',
    owner: bed.alice.id,
    digest: first.version.digest,
    published_at: first.version.published_at,
    withdrawn: false,
    active: false,
    samples: { author: 3, returned_counterexample: 1, retained_delivery: 0 },
    assigned_to: [bed.bob.id],
  });
  assert.equal(row('demo-review', '1.1.0')?.withdrawn, true);
  assert.equal(row('widget', '1.0.0')?.active, true);
  assert.equal(row('widget', '1.0.0')?.owner, bed.bob.id);
  assert.deepEqual(row('widget', '1.0.0')?.assigned_to, []);
});
