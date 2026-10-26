// Builds and current roots (K01 R[6], R[10]; B05 R[4]; W09 R[2]): a reconciliation never moves a line back over a newer
// root; a move needs an enabled admin and the completed production that made the root; an alias of an alias moves with its
// final base's production as cause; an alias listed on another line than its base; build names the store cannot index are
// reported per build; an optional source published later is read again; a changed listing or another production component
// produces again; two syncs of one product in one process run one after the other.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { TreeRootBody } from '../../contracts/src/knowledge.ts';
import type { BuildInfo, KnownBuild } from '../../contracts/src/product.ts';
import type { ActionBody } from '../records/api.ts';
import type { TemporaryPostgres } from '../testing/postgres.ts';
import { pointerName } from './builds.ts';
import { nodeDigest } from './digest.ts';
import { INDEX, buildKey, withoutLists } from './store.ts';
import { BASE_CATALOG, DEFAULT_PRODUCERS, STATIC_PLAN_SOURCE, catalogXml, linkPage, listingPage, makeWorld, standardSite, startPostgres, type World } from './test-support.ts';

let postgres: TemporaryPostgres;
before(async () => {
  postgres = await startPostgres();
});
after(() => postgres?.stop());

const XML = 'application/xml';
const HTML = 'text/html; charset=ISO-8859-1';

async function world(t: { after: (fn: () => Promise<void>) => void }, options: Parameters<typeof makeWorld>[1] = {}): Promise<World> {
  const w = await makeWorld(postgres, options);
  t.after(() => w.close());
  return w;
}

function own(name: string, line: string, released: string | null, built: string | null = null): KnownBuild {
  return { name, family: 'ACME', line, base: name, platform: null, built_at: built, released_at: released, sources: { tree: `site:tree:${name}` }, root: null };
}

function alias(name: string, base: string, line: string, released: string | null): BuildInfo {
  return { name, family: 'ZETA', line, base, platform: null, built_at: null, released_at: released, sources: {} };
}

async function putBuilds(w: World, builds: BuildInfo[]): Promise<void> {
  const pack = { id: w.product.id, version: w.product.version, digest: w.product.digest };
  // A build record keeps single roles only (these builds have no list role).
  for (const info of builds) await w.knowledge.store.putBuild({ product: 'acme', build: withoutLists(info), pack, plan: null, sync: null });
}

describe('current roots move only forward and only by a production', () => {
  test('a reconciliation that read the pointer while a newer root was made never moves the line back', async (t) => {
    const w = await world(t);
    standardSite(w.external);
    await w.knowledge.syncProduct(w.product, { by: w.admin, lines: ['1.2'] });
    const b18 = own('Rel_ACME_1_2_18', '1.2', '2026-01-21T00:00:00.000Z', '2026-01-20T10:00:00.000Z');
    w.external.set('site:tree:Rel_ACME_1_2_18', { bytes: catalogXml({ ...BASE_CATALOG, disk: [{ name: 'list', params: [] }] }), mediaType: XML });
    const name = pointerName('acme', '1.2');
    const pointers = w.kit.pointers;
    const get = pointers.get.bind(pointers);
    let newer: string | null = null;
    pointers.get = async (pointer, tx) => {
      if (newer === null && pointer === name) {
        // Another session produces a newer build of the line and reconciles it while this one is between its reads.
        const produced = await w.knowledge.produceTree({ product: w.product, build: b18 });
        assert.equal(produced.ok, true, produced.reason ?? '');
        newer = produced.root;
        assert.equal((await w.knowledge.reconcileLine('acme', '1.2', w.admin)).moved, true);
      }
      return get(pointer, tx);
    };
    t.after(() => {
      pointers.get = get;
    });
    await w.knowledge.reconcileLine('acme', '1.2', w.admin);
    pointers.get = get;
    assert.ok(newer !== null);
    assert.equal((await w.knowledge.currentRoot('acme', '1.2'))?.root, newer);
    assert.deepEqual((await w.knowledge.store.pointerMoves('acme', '1.2')).map((m) => m.build), ['Rel_ACME_1_2_18', 'Rel_ZETA_1_2_7']);
  });

  test('a move needs an enabled admin and the completed production that made the root', async (t) => {
    const w = await world(t);
    standardSite(w.external);
    await w.knowledge.syncProduct(w.product, { by: w.admin, lines: ['1.2'] });
    const from = (await w.knowledge.currentRoot('acme', '1.2'))?.root as string;
    const b16 = await w.knowledge.resolveBuild('acme', 'Rel_ACME_1_2_16');
    assert.ok(b16 !== null);
    const produced = await w.knowledge.produceTree({ product: w.product, build: { ...b16, root: null } });
    assert.equal(produced.ok, true, produced.reason ?? '');
    const to = produced.root as string;
    const other = (await w.knowledge.store.latestProduction('acme', 'Rel_ACME_1_2_15'))?.record.digest as string;
    // An alias of build 16 that the listing put on another line.
    await putBuilds(w, [alias('Rel_ZETA_1_3_9', 'Rel_ACME_1_2_16', '1.3', '2026-02-09T00:00:00.000Z')]);
    const refused: Array<[string, () => Promise<unknown>, RegExp]> = [
      ['a user', () => w.knowledge.moveRoot('acme', '1.2', from, to, produced.action, { by: w.user }), /只有管理员/],
      ['no cause', () => w.knowledge.moveRoot('acme', '1.2', from, to, null, { by: w.admin }), /生产动作/],
      ['a run id', () => w.knowledge.moveRoot('acme', '1.2', from, to, 'run_00000000000000000000000000', { by: w.admin }), /生产动作/],
      ['a digest of no record', () => w.knowledge.moveRoot('acme', '1.2', from, to, 'f'.repeat(64), { by: w.admin }), /不是产品线 acme 产出根/],
      ['the production of another root', () => w.knowledge.moveRoot('acme', '1.2', from, to, other, { by: w.admin }), /不是产品线 acme 产出根/],
      ['a build of another line', () => w.knowledge.moveRoot('acme', '1.2', from, to, produced.action, { by: w.admin, build: 'Rel_ZETA_1_3_9' }), /属于版本线 1\.3，不是 1\.2/],
      ['an unknown build', () => w.knowledge.moveRoot('acme', '1.2', from, to, produced.action, { by: w.admin, build: 'Rel_NONE_1_2_1' }), /不认识构建/],
      ['a build that uses another tree', () => w.knowledge.moveRoot('acme', '1.2', from, to, produced.action, { by: w.admin, build: 'Rel_ZETA_1_2_7' }), /不用这个生产动作的树/],
    ];
    for (const [what, move, reason] of refused) await assert.rejects(move(), reason, what);
    assert.equal((await w.kit.pointers.history(pointerName('acme', '1.2'))).items.length, 1, 'nothing moved');

    const moved = await w.knowledge.moveRoot('acme', '1.2', from, to, produced.action, { by: w.admin });
    assert.equal(moved.moved, true);
    const [last] = await w.knowledge.store.pointerMoves('acme', '1.2');
    assert.equal(last.cause, `rec:${produced.action}`);
    assert.equal(last.build, 'Rel_ACME_1_2_16');
    assert.equal(last.composition, produced.composition);
    const [action] = (await w.kit.pointers.history(pointerName('acme', '1.2'))).items;
    assert.equal((action.body.detail as { by: string | null }).by, w.admin.id, 'the move names the admin who made it');
    // Without `by` the service's own admin moves, and is named.
    const back = await w.knowledge.moveRoot('acme', '1.2', to, from, other);
    assert.equal(back.moved, true);
    const [again] = (await w.kit.pointers.history(pointerName('acme', '1.2'))).items;
    assert.equal((again.body.detail as { by: string | null }).by, w.admin.id);
  });

  test('an alias of an alias moves the line with the production of its final base as cause', async (t) => {
    const w = await world(t);
    w.external.set('site:tree:Rel_ACME_1_2_15', { bytes: catalogXml(BASE_CATALOG), mediaType: XML });
    const base = await w.knowledge.produceTree({ product: w.product, build: own('Rel_ACME_1_2_15', '1.2', '2026-01-05T00:00:00.000Z') });
    assert.equal(base.ok, true, base.reason ?? '');
    await putBuilds(w, [alias('Rel_ZETA_1_2_7', 'Rel_ACME_1_2_15', '1.2', '2026-01-07T00:00:00.000Z'), alias('Rel_ZETA_1_2_8', 'Rel_ZETA_1_2_7', '1.2', '2026-01-08T00:00:00.000Z')]);
    const reconciled = await w.knowledge.reconcileLine('acme', '1.2', w.admin);
    assert.equal(reconciled.moved, true, reconciled.reason);
    assert.equal(reconciled.build, 'Rel_ZETA_1_2_8');
    const [move] = await w.knowledge.store.pointerMoves('acme', '1.2');
    assert.equal(move.cause, `rec:${base.action}`);
    assert.equal(move.root, base.root);
  });

  test('an alias listed on another line than its base moves that line to the base root', async (t) => {
    const w = await world(t);
    w.external.set('site:tree:Rel_ACME_1_2_15', { bytes: catalogXml(BASE_CATALOG), mediaType: XML });
    const base = await w.knowledge.produceTree({ product: w.product, build: own('Rel_ACME_1_2_15', '1.2', '2026-01-05T00:00:00.000Z') });
    await putBuilds(w, [alias('Rel_ZETA_1_3_2', 'Rel_ACME_1_2_15', '1.3', '2026-02-02T00:00:00.000Z')]);
    assert.equal((await w.knowledge.builds('acme', { line: '1.3' }))[0].root, base.root);
    const reconciled = await w.knowledge.reconcileLine('acme', '1.3', w.admin);
    assert.equal(reconciled.moved, true, reconciled.reason);
    const current = await w.knowledge.currentRoot('acme', '1.3');
    assert.equal(current?.root, base.root);
    assert.equal(current?.composition, base.composition);
    const [move] = await w.knowledge.store.pointerMoves('acme', '1.3');
    assert.equal(move.build, 'Rel_ZETA_1_3_2');
    assert.equal(move.cause, `rec:${base.action}`);
  });
});

describe('the sync reports every build and notices what changed', () => {
  test('build names the store cannot index are failed builds in the report; the others are produced and reconciled', async (t) => {
    const w = await world(t, { pack: { functions: { 'plan.ts': STATIC_PLAN_SOURCE } } });
    w.external.set('site:page:index', { bytes: linkPage('index', []), mediaType: HTML });
    w.external.set('site:tree:Rel_ACME_1_2_15', { bytes: catalogXml(BASE_CATALOG), mediaType: XML });
    const good = { ...own('Rel_ACME_1_2_15', '1.2', '2026-01-05T00:00:00.000Z') } as Partial<KnownBuild>;
    delete good.root;
    const wide = { ...good, name: '构'.repeat(400), base: '构'.repeat(400), sources: {} };
    const nul = { ...good, name: 'Rel_ACME_1_2_9\u0000x', base: 'Rel_ACME_1_2_9\u0000x', sources: {} };
    const report = await w.knowledge.syncProduct(w.product, { by: w.admin, options: { builds: [good, wide, nul] } });
    assert.equal(report.error, null);
    assert.equal(report.builds.find((b) => b.name === good.name)?.outcome, 'produced');
    for (const bad of [wide, nul]) {
      const row = report.builds.find((b) => b.name === bad.name);
      assert.equal(row?.outcome, 'failed', bad.name.slice(0, 20));
      assert.match(row?.reason ?? '', /构建名/);
    }
    assert.equal(report.pointers.find((p) => p.line === '1.2')?.moved, true);
    assert.deepEqual(report.counts, { produced: 1, registered: 0, skipped: 0, failed: 2 });
  });

  test('a plan note the store cannot keep is made storable instead of failing the sync', async (t) => {
    const w = await world(t, { pack: { functions: { 'plan.ts': STATIC_PLAN_SOURCE } } });
    w.external.set('site:page:index', { bytes: linkPage('index', []), mediaType: HTML });
    w.external.set('site:tree:Rel_ACME_1_2_15', { bytes: catalogXml(BASE_CATALOG), mediaType: XML });
    const good = { ...own('Rel_ACME_1_2_15', '1.2', '2026-01-05T00:00:00.000Z') } as Partial<KnownBuild>;
    delete good.root;
    const report = await w.knowledge.syncProduct(w.product, { by: w.admin, options: { builds: [good], note: 'plan \ud83d note' } });
    assert.equal(report.error, null);
    assert.equal(report.plan.note, 'plan � note');
    assert.equal(report.counts.produced, 1);
    // An administrator's labelled samples are checked the same way.
    await assert.rejects(
      w.knowledge.calibration.addLabelled(w.admin, { kind: 'placement.choice', model: 'm-1', samples: [{ input: 'a'.repeat(64), expected: 'x\ud800', chosen: 'x', probability: 0.9 }] }),
      /第 1 个校准样例不合格/,
    );
  });

  test('an optional source that was missing is read again by a plain sync, which produces once it appears', async (t) => {
    const producers = [DEFAULT_PRODUCERS[0], { id: 'manual', title: '手册', function: { module: 'functions/manual.ts' }, inputs: { manual: { external: 'store:manual:{product}-{line}', optional: true } } }];
    const w = await world(t, { pack: { declaration: { producers } } });
    standardSite(w.external);
    const outcome = (report: Awaited<ReturnType<World['knowledge']['syncProduct']>>) => report.builds.find((b) => b.name === 'Rel_ACME_1_2_15');
    assert.equal(outcome(await w.knowledge.syncProduct(w.product, { by: w.admin, lines: ['1.2'] }))?.outcome, 'produced');
    assert.equal(outcome(await w.knowledge.syncProduct(w.product, { by: w.admin, lines: ['1.2'] }))?.outcome, 'skipped', 'still missing');
    w.external.set('store:manual:acme-1.2', { bytes: '# Manual\n\n## Reboot\n\nThe reboot command restarts the unit.\n', mediaType: 'text/markdown' });
    const third = outcome(await w.knowledge.syncProduct(w.product, { by: w.admin, lines: ['1.2'] }));
    assert.equal(third?.outcome, 'produced');
    assert.match(third?.reason ?? '', /可选来源.*能读到了/);
    assert.equal(third?.unplaced, 1);
  });

  test('a build the listing now shows as released is produced again: its record and basis follow the release record', async (t) => {
    const w = await world(t);
    standardSite(w.external);
    const first = await w.knowledge.syncProduct(w.product, { by: w.admin, lines: ['1.2'], includeUnreleased: true });
    assert.equal(first.builds.find((b) => b.name === 'Rel_ACME_1_2_16')?.outcome, 'produced');
    assert.equal((await w.knowledge.rootOfBuild('acme', 'Rel_ACME_1_2_16'))?.build.released_at, null);
    w.external.set('site:page:rel_acme_1_2', {
      bytes: listingPage('rel_acme_1_2', [
        { name: 'Rel_ACME_1_2_15', built: '2026-01-02 10:00:00', released: '2026-01-05', tree: true },
        { name: 'Rel_ACME_1_2_16', built: '2026-01-09 10:00:00', released: '2026-01-12', tree: true },
      ]),
      mediaType: HTML,
    });
    const second = await w.knowledge.syncProduct(w.product, { by: w.admin, lines: ['1.2'] });
    const row = second.builds.find((b) => b.name === 'Rel_ACME_1_2_16');
    assert.equal(row?.outcome, 'produced');
    assert.match(row?.reason ?? '', /构建信息变了/);
    const info = await w.knowledge.rootOfBuild('acme', 'Rel_ACME_1_2_16');
    assert.equal(info?.build.released_at, '2026-01-12T00:00:00.000Z');
    const record = await w.kit.store.get(info?.composition as string);
    assert.equal(TreeRootBody.parse(record?.body).sources[0].basis, 'release_record');
    const current = await w.knowledge.currentRoot('acme', '1.2');
    assert.equal(current?.build.name, 'Rel_ACME_1_2_16');
    assert.equal(current?.build.released_at, '2026-01-12T00:00:00.000Z');
  });

  test('a build last produced by another version of the production component is produced again', async (t) => {
    const w = await world(t);
    standardSite(w.external);
    await w.knowledge.syncProduct(w.product, { by: w.admin, lines: ['1.2'] });
    const latest = await w.knowledge.store.latestProduction('acme', 'Rel_ACME_1_2_15');
    assert.ok(latest !== null);
    // The newest production of the build was made by an earlier version of the component (as after a Hub upgrade).
    const body: ActionBody = { ...latest.record.body, component: 'knowledge.produce@0', ended_at: new Date(Date.now() + 1000).toISOString() };
    await w.knowledge.store.putAction(body, [
      { key: INDEX.produce, value: buildKey('acme', 'Rel_ACME_1_2_15') },
      { key: INDEX.produceProduct, value: 'acme' },
      { key: INDEX.produceRoot, value: latest.detail.root as string },
    ]);
    const again = await w.knowledge.syncProduct(w.product, { by: w.admin, lines: ['1.2'] });
    const row = again.builds.find((b) => b.name === 'Rel_ACME_1_2_15');
    assert.equal(row?.outcome, 'produced');
    assert.match(row?.reason ?? '', /生产组件/);
    assert.match(row?.reason ?? '', /内容与上次相同/);
  });

  test('two syncs of one product in one process run one after the other: nothing is produced or written twice', async (t) => {
    const w = await world(t);
    standardSite(w.external);
    const [a, b] = await Promise.all([w.knowledge.syncProduct(w.product, { by: w.admin }), w.knowledge.syncProduct(w.product, { by: w.admin })]);
    assert.equal(a.counts.produced + b.counts.produced, 3);
    const seen = new Map<string, number>();
    let cursor: string | null = null;
    do {
      const page: { items: Array<{ schema: string; body: unknown }>; next: string | null } = await w.kit.store.list({ kind: 'tree_node', limit: 500, cursor });
      for (const record of page.items) {
        if (record.schema !== 'tree_node@1') continue;
        const digest = nodeDigest(record.body as Parameters<typeof nodeDigest>[0]);
        seen.set(digest, (seen.get(digest) ?? 0) + 1);
      }
      cursor = page.next;
    } while (cursor !== null);
    assert.ok(seen.size > 0);
    assert.deepEqual([...seen.values()].filter((n) => n > 1), [], 'every node has one record');
  });
});
