// The knowledge sync end to end over a synthetic build site of two name families (index -> hub page -> listing pages, a
// dead link, an alias by "based on", an own-tree build of the other family): plan rounds, builds and aliases, roots that
// coincide by content, current roots, idempotent reruns, resuming after failures, limits, a plan that never says done,
// one line only, dry runs, rechecks and the current-root compare-and-set race.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { TemporaryPostgres } from '../testing/postgres.ts';
import { pointerName } from './builds.ts';
import { formatSyncReport, knowledgeCliCommand, knowledgeSync, parseKnowledgeSyncArgs } from './cli.ts';
import { INDEX, SCHEMAS } from './store.ts';
import { BASE_CATALOG, DEFAULT_SYNC, ENDLESS_PLAN_SOURCE, catalogXml, linkPage, listingPage, makeWorld, standardSite, startPostgres, type World } from './test-support.ts';

let postgres: TemporaryPostgres;
before(async () => {
  postgres = await startPostgres();
});
after(() => postgres?.stop());

async function world(t: { after: (fn: () => Promise<void>) => void }, options: Parameters<typeof makeWorld>[1] = {}): Promise<World> {
  const w = await makeWorld(postgres, options);
  t.after(() => w.close());
  return w;
}

const outcomes = (report: Awaited<ReturnType<World['knowledge']['syncProduct']>>) => Object.fromEntries(report.builds.map((b) => [b.name, b.outcome]));

async function count(w: World, key: string, value: string, kind: 'action' | 'claim'): Promise<number> {
  let n = 0;
  let cursor: string | null = null;
  do {
    const page: { items: unknown[]; next: string | null } = await w.kit.store.find({ key, value, kind, limit: 500, cursor });
    n += page.items.length;
    cursor = page.next;
  } while (cursor !== null);
  return n;
}

describe('knowledge sync', () => {
  test('end to end: both families, aliases resolved, own trees of either family, roots coincide by content, current roots', async (t) => {
    const w = await world(t);
    standardSite(w.external);
    const report = await w.knowledge.syncProduct(w.product, { by: w.admin });
    assert.equal(report.error, null);
    assert.equal(report.plan.rounds, 3);
    assert.equal(report.plan.done, true);
    assert.equal(report.plan.reads, 7);
    assert.deepEqual(report.plan.failed_reads.map((f) => f.id), ['site:page:rel_acme_1_3_special']);
    assert.deepEqual(report.plan.limits, { rounds: false, reads: false, max_rounds: 6, max_reads: 50 });
    assert.deepEqual(outcomes(report), {
      Rel_ACME_1_2_15: 'produced',
      Rel_ACME_1_2_16: 'skipped',
      Rel_ZETA_1_2_7: 'skipped',
      Rel_ACME_1_3_20: 'produced',
      Rel_ZETA_1_3_20: 'produced',
    });
    assert.deepEqual(report.counts, { produced: 3, registered: 0, skipped: 2, failed: 0 });
    const reasons = Object.fromEntries(report.builds.map((b) => [b.name, b.reason]));
    assert.match(reasons.Rel_ACME_1_2_16, /未发布/);
    assert.match(reasons.Rel_ZETA_1_2_7, /别名，使用 Rel_ACME_1_2_15 的树/);

    // An alias of either family resolves through its base to the same root; names compare without case.
    const root12 = (await w.knowledge.rootOfBuild('acme', 'Rel_ACME_1_2_15'))?.root;
    assert.ok(root12);
    assert.equal((await w.knowledge.rootOfBuild('acme', 'Rel_ZETA_1_2_7'))?.root, root12);
    const resolved = await w.knowledge.resolveBuild('acme', 'rel_zeta_1_2_7');
    assert.equal(resolved?.name, 'Rel_ACME_1_2_15');
    assert.equal(resolved?.root, root12);
    assert.equal(await w.knowledge.resolveBuild('acme', 'Rel_NONE_1_2_3'), null);
    assert.equal(await w.knowledge.rootOfBuild('acme', 'Rel_ACME_1_2_16'), null, 'an unreleased build without a root');

    // The other family's own tree of the newest line: other bytes, equal content, so the roots coincide.
    const acme13 = await w.knowledge.rootOfBuild('acme', 'Rel_ACME_1_3_20');
    const zeta13 = await w.knowledge.rootOfBuild('acme', 'Rel_ZETA_1_3_20');
    assert.ok(acme13 && zeta13);
    assert.equal(zeta13.root, acme13.root);
    assert.notEqual(zeta13.composition, acme13.composition);
    assert.equal(zeta13.build!.name, 'Rel_ZETA_1_3_20');
    const infos = await w.knowledge.rootInfo(acme13.root);
    assert.deepEqual(infos.map((i) => i.build!.name).sort(), ['Rel_ACME_1_3_20', 'Rel_ZETA_1_3_20']);
    assert.notEqual(acme13.root, root12);

    // Current roots: per line, the newest build that has a root (release date, then build time), any family.
    assert.equal((await w.knowledge.currentRoot('acme', '1.2'))?.root, root12);
    assert.equal((await w.knowledge.currentRoot('acme', '1.3'))?.root, acme13.root);
    assert.equal(await w.knowledge.currentRoot('acme', '9.9'), null);
    assert.deepEqual(
      report.pointers.map((p) => [p.line, p.moved, p.build]),
      [
        ['1.2', true, 'Rel_ZETA_1_2_7'],
        ['1.3', true, 'Rel_ZETA_1_3_20'],
      ],
    );
    const moves = await w.knowledge.store.pointerMoves('acme', '1.2');
    assert.equal(moves.length, 1);
    assert.equal(moves[0].root, root12);
    assert.equal(moves[0].build, 'Rel_ZETA_1_2_7');
    assert.match(moves[0].cause ?? '', /^rec:[0-9a-f]{64}$/);
    assert.equal((await w.kit.pointers.history(pointerName('acme', '1.2'))).items.length, 1);
    assert.deepEqual(await w.knowledge.lockRoot('acme', { line: '1.3' }), await w.knowledge.currentRoot('acme', '1.3'));
    assert.equal((await w.knowledge.lockRoot('acme', { build: 'Rel_ZETA_1_2_7' }))?.root, root12);

    // Every build of both families, newest first; filters by line and release.
    const all = await w.knowledge.builds('acme');
    assert.deepEqual(all.map((b) => b.name), ['Rel_ZETA_1_3_20', 'Rel_ACME_1_3_20', 'Rel_ZETA_1_2_7', 'Rel_ACME_1_2_15', 'Rel_ACME_1_2_16']);
    assert.deepEqual(all.map((b) => b.root === null), [false, false, false, false, true]);
    assert.deepEqual((await w.knowledge.builds('acme', { line: '1.2', released: true })).map((b) => b.name), ['Rel_ZETA_1_2_7', 'Rel_ACME_1_2_15']);
    assert.match(formatSyncReport(report), /\[产出\] Rel_ACME_1_2_15/);
  });

  test('a build without a readable source is registered by name only: no root, not a failure, a separate count', async (t) => {
    const w = await world(t);
    standardSite(w.external);
    // Two more builds on the 1.2 listing page: one unreleased without a tree, one released without a tree.
    w.external.set('site:page:rel_acme_1_2', {
      bytes: listingPage('rel_acme_1_2', [
        { name: 'Rel_ACME_1_2_15', built: '2026-01-02 10:00:00', released: '2026-01-05', tree: true },
        { name: 'Rel_ACME_1_2_16', built: '2026-01-09 10:00:00', tree: true },
        { name: 'Rel_ACME_1_2_17', built: '2026-01-10 10:00:00' },
        { name: 'Rel_ZETA_1_2_8', built: '2026-01-11 10:00:00', released: '2026-01-12' },
      ]),
      mediaType: 'text/html; charset=ISO-8859-1',
    });
    const report = await w.knowledge.syncProduct(w.product, { by: w.admin });
    assert.equal(report.error, null);
    assert.equal(report.counts.failed, 0);
    // The outcome word of a name-only registration, and the separate count of the report.
    assert.equal(report.builds.find((b) => b.name === 'Rel_ACME_1_2_17')?.outcome, 'registered');
    assert.equal(report.builds.find((b) => b.name === 'Rel_ZETA_1_2_8')?.outcome, 'registered');
    assert.equal(report.counts.registered, 2);
    assert.match(report.builds.find((b) => b.name === 'Rel_ACME_1_2_17')?.reason ?? '', /^没有可读的来源，只登记名字$/);
    // The report text says the two numbers apart.
    assert.match(formatSyncReport(report), /构建：产出 3，只登记名字 2，跳过 [0-9]+，失败 0/);
    // builds() knows them, root empty; resolveBuild returns the build itself with root null.
    const all = await w.knowledge.builds('acme');
    assert.ok(all.some((b) => b.name === 'Rel_ACME_1_2_17' && b.root === null));
    const resolved = await w.knowledge.resolveBuild('acme', 'Rel_ACME_1_2_17');
    assert.equal(resolved?.name, 'Rel_ACME_1_2_17');
    assert.equal(resolved?.root, null);
    assert.equal(resolved?.base, 'Rel_ACME_1_2_17');
    // The line pointer still names a build that has a root, never a name-only build.
    const current = await w.knowledge.currentRoot('acme', '1.2');
    assert.ok(current !== null && current.root !== null);
    assert.notEqual(current.build!.name, 'Rel_ACME_1_2_17');
    assert.notEqual(current.build!.name, 'Rel_ZETA_1_2_8');
    // A rerun registers them again without producing anything.
    const again = await w.knowledge.syncProduct(w.product, { by: w.admin });
    assert.equal(again.counts.registered, 2);
    assert.equal(again.counts.produced, 0);
    assert.equal(again.counts.failed, 0);
  });

  test('a rerun is idempotent: nothing is produced again, no build record repeated, no pointer moved', async (t) => {
    const w = await world(t);
    standardSite(w.external);
    await w.knowledge.syncProduct(w.product, { by: w.admin });
    const generated = await count(w, INDEX.produceProduct, 'acme', 'action');
    const buildRecords = await count(w, INDEX.buildProduct, 'acme', 'claim');
    const again = await w.knowledge.syncProduct(w.product, { by: w.admin });
    assert.equal(again.counts.produced, 0);
    assert.equal(again.counts.failed, 0);
    for (const name of ['Rel_ACME_1_2_15', 'Rel_ACME_1_3_20', 'Rel_ZETA_1_3_20']) {
      assert.match(again.builds.find((b) => b.name === name)?.reason ?? '', /已有根，来源和生产器都没有变/);
    }
    assert.equal(await count(w, INDEX.produceProduct, 'acme', 'action'), generated);
    assert.equal(await count(w, INDEX.buildProduct, 'acme', 'claim'), buildRecords);
    assert.deepEqual(again.pointers.map((p) => p.moved), [false, false]);
    assert.equal((await w.kit.pointers.history(pointerName('acme', '1.2'))).items.length, 1);
  });

  test('resumes after failures in the middle: the failed build is retried, the others are skipped', async (t) => {
    const w = await world(t);
    standardSite(w.external);
    const tree = w.external.objects.get('site:tree:Rel_ACME_1_2_15');
    w.external.set('site:tree:Rel_ACME_1_2_15', { fail: 'HTTP 503' });
    w.external.throwing.add('site:tree:Rel_ACME_1_3_20');
    const first = await w.knowledge.syncProduct(w.product, { by: w.admin });
    assert.deepEqual(outcomes(first), {
      Rel_ACME_1_2_15: 'failed',
      Rel_ACME_1_2_16: 'skipped',
      Rel_ZETA_1_2_7: 'failed',
      Rel_ACME_1_3_20: 'failed',
      Rel_ZETA_1_3_20: 'produced',
    });
    assert.match(first.builds.find((b) => b.name === 'Rel_ACME_1_2_15')?.reason ?? '', /HTTP 503/);
    assert.match(first.builds.find((b) => b.name === 'Rel_ACME_1_3_20')?.reason ?? '', /连接器出错/);
    // Line 1.2 has no root yet: its alias resolves to a base without one.
    assert.equal(await w.knowledge.currentRoot('acme', '1.2'), null);
    assert.match(first.pointers.find((p) => p.line === '1.2')?.reason ?? '', /还没有根/);
    // The failure is recorded as a generate action with its reason (progress per build).
    const failures = (await w.knowledge.store.productions('acme')).filter((p) => !p.completed);
    assert.deepEqual(failures.map((p) => p.detail.build!.name).sort(), ['Rel_ACME_1_2_15', 'Rel_ACME_1_3_20']);

    w.external.set('site:tree:Rel_ACME_1_2_15', tree as { bytes: string; mediaType: string });
    w.external.throwing.clear();
    const second = await w.knowledge.syncProduct(w.product, { by: w.admin });
    assert.deepEqual(outcomes(second), {
      Rel_ACME_1_2_15: 'produced',
      Rel_ACME_1_2_16: 'skipped',
      Rel_ZETA_1_2_7: 'skipped',
      Rel_ACME_1_3_20: 'produced',
      Rel_ZETA_1_3_20: 'skipped',
    });
    assert.equal((await w.knowledge.currentRoot('acme', '1.2'))?.root, (await w.knowledge.rootOfBuild('acme', 'Rel_ZETA_1_2_7'))?.root);
  });

  test('an aborted sync reports the builds it did not process, and the rerun finishes them', async (t) => {
    const w = await world(t);
    standardSite(w.external);
    const controller = new AbortController();
    controller.abort();
    const aborted = await w.knowledge.syncProduct(w.product, { by: w.admin, signal: controller.signal });
    assert.deepEqual(
      aborted.builds.filter((b) => b.outcome === 'failed').map((b) => b.reason),
      ['同步被中止，这个构建没有处理', '同步被中止，这个构建没有处理', '同步被中止，这个构建没有处理'],
    );
    const rerun = await w.knowledge.syncProduct(w.product, { by: w.admin });
    assert.equal(rerun.counts.produced, 3);
  });

  test('limits are reported, never silent: reads, rounds, and a plan that never says done', async (t) => {
    const reads = await world(t, { pack: { declaration: { sync: { ...DEFAULT_SYNC, max_reads: 3 } } } });
    standardSite(reads.external);
    const limited = await reads.knowledge.syncProduct(reads.product, { by: reads.admin });
    assert.equal(limited.plan.limits.reads, true);
    assert.equal(limited.plan.reads, 3);
    assert.equal(limited.plan.done, false);
    assert.ok(limited.warnings.some((w) => w.includes('读页数达到上限 3')));
    assert.equal(limited.error, null);

    const rounds = await world(t, { pack: { declaration: { sync: { ...DEFAULT_SYNC, max_rounds: 2 } } } });
    standardSite(rounds.external);
    const short = await rounds.knowledge.syncProduct(rounds.product, { by: rounds.admin });
    assert.equal(short.plan.limits.rounds, true);
    assert.equal(short.plan.rounds, 2);
    assert.equal(short.plan.done, false);
    assert.ok(short.warnings.some((w) => w.includes('2 轮后仍未完成')));
    // What the last round listed is still the plan: the builds of line 1.2 were found.
    assert.equal(short.builds.find((b) => b.name === 'Rel_ACME_1_2_15')?.outcome, 'produced');

    const endless = await world(t, { pack: { functions: { 'plan.ts': ENDLESS_PLAN_SOURCE }, declaration: { sync: { ...DEFAULT_SYNC, max_rounds: 4 } } } });
    endless.external.set('site:page:index', { bytes: linkPage('index', []), mediaType: 'text/html' });
    const forever = await endless.knowledge.syncProduct(endless.product, { by: endless.admin });
    assert.equal(forever.plan.rounds, 4);
    assert.equal(forever.plan.done, false);
    assert.equal(forever.plan.limits.rounds, true);
    assert.deepEqual(forever.builds, []);
    assert.ok(forever.plan.failed_reads.length > 0, 'the pages it asked for do not exist');
  });

  test('one line only: the line goes to the plan function, which does not walk the others', async (t) => {
    const w = await world(t);
    standardSite(w.external);
    const report = await w.knowledge.syncProduct(w.product, { by: w.admin, lines: ['1.3'] });
    assert.deepEqual(Object.keys(outcomes(report)).sort(), ['Rel_ACME_1_3_20', 'Rel_ZETA_1_3_20']);
    assert.ok(!w.external.reads.some((id) => /_1_2$/.test(id)), w.external.reads.join(' '));
    assert.equal(await w.knowledge.currentRoot('acme', '1.2'), null);
    assert.ok(await w.knowledge.currentRoot('acme', '1.3'));
  });

  test('the CLI entry: any name of the product, one line, a dry run that stores nothing', async (t) => {
    const w = await world(t);
    standardSite(w.external);
    const dry = await knowledgeSync(w.knowledge, w.packs, w.admin, parseKnowledgeSyncArgs(['--product', 'zeta', '--line', '1.2', '--dry-run']));
    assert.equal(dry.dry_run, true);
    assert.deepEqual(outcomes(dry), { Rel_ACME_1_2_15: 'skipped', Rel_ACME_1_2_16: 'skipped', Rel_ZETA_1_2_7: 'skipped' });
    assert.equal(dry.builds.find((b) => b.name === 'Rel_ACME_1_2_15')?.would_produce, true);
    assert.equal(await count(w, INDEX.buildProduct, 'acme', 'claim'), 0);
    assert.equal(await count(w, INDEX.produceProduct, 'acme', 'action'), 0);
    assert.deepEqual(dry.pointers, []);
    const real = await knowledgeSync(w.knowledge, w.packs, w.admin, parseKnowledgeSyncArgs(['--product=ACME', '--line=1.2']));
    assert.equal(real.counts.produced, 1);
    await assert.rejects(knowledgeSync(w.knowledge, w.packs, w.admin, parseKnowledgeSyncArgs(['--product', 'nothing'])), /没有叫 nothing 的已发布产品包/);
    await assert.rejects(w.knowledge.syncProduct(w.product, { by: w.user }), /只有管理员/);
  });

  test('the knowledge command for the server CLI: exit 0 when nothing failed, 1 on a failed build, 2 on a usage error', async (t) => {
    const w = await world(t);
    standardSite(w.external);
    const command = knowledgeCliCommand(async () => ({ knowledge: w.knowledge, packs: w.packs }));
    const out: string[] = [];
    const err: string[] = [];
    const asked: Array<string | undefined> = [];
    const context = {
      io: { stdout: (line: string) => void out.push(line), stderr: (line: string) => void err.push(line) },
      actingAdmin: async (as?: string) => {
        asked.push(as);
        return w.admin;
      },
    };
    assert.equal(await command.run(['sync', '--product', 'ACME', '--line', '1.3', '--as', 'admin'], context), 0);
    assert.deepEqual(asked, ['admin']);
    assert.ok(out.some((line) => line.includes('[产出] Rel_ACME_1_3_20')), out.join('\n'));
    assert.equal(await command.run(['sync'], context), 2);
    assert.equal(await command.run(['other'], context), 2);
    assert.equal(await command.run(['sync', '--product', 'ACME', '--as'], context), 2);
    w.external.set('site:tree:Rel_ACME_1_2_15', { fail: 'HTTP 500' });
    assert.equal(await command.run(['sync', '--product=ZETA', '--line=1.2'], context), 1);
    assert.ok(err.length >= 3);
  });

  test('recheck re-reads the sources: a changed source gives a new root and moves the line', async (t) => {
    const w = await world(t);
    standardSite(w.external);
    await w.knowledge.syncProduct(w.product, { by: w.admin });
    const before12 = (await w.knowledge.currentRoot('acme', '1.2'))?.root;
    w.external.set('site:tree:Rel_ACME_1_2_15', { bytes: catalogXml({ ...BASE_CATALOG, net: [{ name: 'ping', params: [] }] }), mediaType: 'application/xml' });
    const plain = await w.knowledge.syncProduct(w.product, { by: w.admin });
    assert.equal(plain.counts.produced, 0, 'without recheck an unchanged external id is not read again');
    const rechecked = await w.knowledge.syncProduct(w.product, { by: w.admin, recheck: true });
    assert.deepEqual(rechecked.builds.filter((b) => b.outcome === 'produced').map((b) => b.name), ['Rel_ACME_1_2_15']);
    const after12 = (await w.knowledge.currentRoot('acme', '1.2'))?.root;
    assert.ok(after12 && after12 !== before12);
    assert.equal(rechecked.pointers.find((p) => p.line === '1.2')?.moved, true);
    const diff = await w.knowledge.diffRoots(before12 as string, after12);
    assert.deepEqual(diff?.removed, ['/commands/net/trace']);
    assert.deepEqual(diff?.modified, ['/commands/net/ping']);
    // The old root is still there (old roots are never deleted).
    assert.ok((await w.knowledge.getNodes({ root: before12 as string, paths: ['/commands/net/trace'], depth: 0 }, w.admin))?.nodes.length === 1);
  });

  test('a build of a family that is not a name of the product is refused; a new pack version produces again', async (t) => {
    const w = await world(t);
    w.external.set('site:page:index', { bytes: linkPage('index', ['rel_acme_1_2.html']), mediaType: 'text/html' });
    w.external.set('site:page:rel_acme_1_2', {
      bytes: listingPage('rel_acme_1_2', [
        { name: 'Rel_ACME_1_2_15', built: '2026-01-02 10:00:00', released: '2026-01-05', tree: true },
        { name: 'Rel_OTHER_1_2_3', built: '2026-01-03 10:00:00', released: '2026-01-06', tree: true },
      ]),
      mediaType: 'text/html',
    });
    w.external.set('site:tree:Rel_ACME_1_2_15', { bytes: catalogXml(BASE_CATALOG), mediaType: 'application/xml' });
    const report = await w.knowledge.syncProduct(w.product, { by: w.admin });
    assert.equal(report.builds.find((b) => b.name === 'Rel_OTHER_1_2_3')?.outcome, 'failed');
    assert.match(report.builds.find((b) => b.name === 'Rel_OTHER_1_2_3')?.reason ?? '', /名称族 OTHER 不是产品 acme 的名称/);
    const newer = { ...w.product, version: '1.0.1', digest: 'e'.repeat(64) };
    const rerun = await w.knowledge.syncProduct(newer, { by: w.admin });
    assert.equal(rerun.builds.find((b) => b.name === 'Rel_ACME_1_2_15')?.outcome, 'produced', 'another producer version produces the root again');
    assert.match(rerun.builds.find((b) => b.name === 'Rel_ACME_1_2_15')?.reason ?? '', /内容与上次相同/);
  });

  test('a plan function that throws or answers outside the contract stops the sync with the reason; no build is stored', async (t) => {
    const throwing = await world(t, { pack: { functions: { 'plan.ts': 'export default function (input: unknown): unknown { throw new Error("broken plan"); }' } } });
    standardSite(throwing.external);
    const failed = await throwing.knowledge.syncProduct(throwing.product, { by: throwing.admin });
    assert.match(failed.error ?? '', /计划函数第 1 轮运行失败：broken plan/);
    assert.deepEqual(failed.builds, []);
    // A build that is not build-info@1 fails alone (a failed build of the report); an answer outside the envelope stops the sync.
    const invalid = await world(t, { pack: { functions: { 'plan.ts': 'export default function (input: unknown): unknown { return { fetch: [], builds: [{ name: "x" }], done: true }; }' } } });
    standardSite(invalid.external);
    const wrong = await invalid.knowledge.syncProduct(invalid.product, { by: invalid.admin });
    assert.equal(wrong.error, null);
    assert.deepEqual(wrong.builds.map((b) => [b.name, b.outcome]), [['x', 'failed']]);
    assert.match(wrong.builds[0].reason, /第 1 个构建不符合 build-info@1/);
    assert.equal(await count(invalid, INDEX.buildProduct, 'acme', 'claim'), 0);
    const envelope = await world(t, { pack: { functions: { 'plan.ts': 'export default function (input: unknown): unknown { return { fetch: "site:page:index", builds: [], done: true }; }' } } });
    standardSite(envelope.external);
    const broken = await envelope.knowledge.syncProduct(envelope.product, { by: envelope.admin });
    assert.match(broken.error ?? '', /sync-plan-output@1/);
    assert.deepEqual(broken.builds, []);
    const none = await world(t, { pack: { declaration: { sync: undefined } } });
    assert.match((await none.knowledge.syncProduct(none.product, { by: none.admin })).error ?? '', /没有声明 sync/);
  });

  test('alias chains are followed and cycles stop', async (t) => {
    const w = await world(t);
    const pack = { id: 'acme', version: '1.0.0', digest: 'a'.repeat(64) };
    const info = (name: string, base: string) => ({ name, family: 'ZETA', line: '1.2', base, platform: null, built_at: null, released_at: null, sources: {} });
    for (const [name, base] of [
      ['Rel_ZETA_1_2_1', 'Rel_ZETA_1_2_2'],
      ['Rel_ZETA_1_2_2', 'Rel_ZETA_1_2_1'],
      ['Rel_ZETA_1_2_3', 'Rel_ZETA_1_2_4'],
      ['Rel_ZETA_1_2_4', 'Rel_ZETA_1_2_5'],
    ]) {
      await w.knowledge.store.putBuild({ product: 'acme', build: info(name, base), pack, plan: null, sync: null });
    }
    const cycle = await w.knowledge.resolveBuild('acme', 'Rel_ZETA_1_2_1');
    assert.ok(cycle !== null && cycle.root === null);
    const chain = await w.knowledge.resolveBuild('acme', 'Rel_ZETA_1_2_3');
    assert.equal(chain?.name, 'Rel_ZETA_1_2_4', 'followed one hop to the last known build');
    assert.equal(chain?.base, 'Rel_ZETA_1_2_5');
    assert.equal((await w.knowledge.builds('acme')).length, 4);
  });

  test('the current root moves only by compare-and-set: of two racing moves exactly one wins', async (t) => {
    const w = await world(t);
    standardSite(w.external);
    await w.knowledge.syncProduct(w.product, { by: w.admin, lines: ['1.2'] });
    const current = (await w.knowledge.currentRoot('acme', '1.2'))?.root as string;
    // Produce two more roots of line 1.2 to race to.
    w.external.set('site:tree:Rel_ACME_1_2_16', { bytes: catalogXml({ system: BASE_CATALOG.system }), mediaType: 'application/xml' });
    const a = await w.knowledge.produceTree({ product: w.product, build: { ...(await w.knowledge.resolveBuild('acme', 'Rel_ACME_1_2_16'))!, root: null } });
    assert.equal(a.ok, true, a.reason ?? '');
    assert.notEqual(a.root, current);
    const race = await Promise.all([
      w.knowledge.moveRoot('acme', '1.2', current, a.root as string, a.action, { by: w.admin }),
      w.knowledge.moveRoot('acme', '1.2', current, a.root as string, a.action, { by: w.admin }),
    ]);
    assert.deepEqual(race.map((r) => r.moved).sort(), [false, true]);
    const loser = race.find((r) => !r.moved);
    assert.ok(loser && !loser.moved && loser.current?.target === a.root);
    // A stale expectation is refused and writes nothing.
    const stale = await w.knowledge.moveRoot('acme', '1.2', current, a.root as string, a.action, { by: w.admin });
    assert.equal(stale.moved, false);
    assert.equal(!stale.moved && stale.current?.target, a.root);
    assert.equal((await w.kit.pointers.history(pointerName('acme', '1.2'))).items.length, 2);
    assert.equal((await w.knowledge.store.pointerMoves('acme', '1.2')).length, 2);
    // A root that the named production did not make cannot become the current root.
    await assert.rejects(w.knowledge.moveRoot('acme', '1.2', a.root, 'd'.repeat(64), a.action), /不是产品线 acme 产出根 d{64} 的已完成生产动作/);
    // The sync's reconciliation moves it back to the newest build of the line.
    const reconciled = await w.knowledge.reconcileLine('acme', '1.2', w.admin);
    assert.equal(reconciled.moved, true);
    assert.equal(reconciled.to, current);
    void SCHEMAS;
  });
});
