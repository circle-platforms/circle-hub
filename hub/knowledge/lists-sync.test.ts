// The sync over a build whose plan lists 500 documents in one role: nothing special in the core for listing them. The
// first sync reads them all and calls the list producer once per batch; a rerun reads nothing again (the documents are
// summarised in the generate action), tries again only the documents that could not be loaded, and produces again once
// one of them loads; recheck reads every document again and produces when one changed.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { BuildInfo } from '../../contracts/src/product.ts';
import type { TemporaryPostgres } from '../testing/postgres.ts';
import { formatSyncReport } from './cli.ts';
import { INDEX } from './store.ts';
import { BASE_CATALOG, DEFAULT_PRODUCERS, DEFAULT_SYNC, STATIC_PLAN_SOURCE, casesProducer, catalogXml, linkPage, makeWorld, mindMap, startPostgres, type World } from './test-support.ts';

let postgres: TemporaryPostgres;
before(async () => {
  postgres = await startPostgres();
});
after(() => postgres?.stop());

const COUNT = 500;
const ids = Array.from({ length: COUNT }, (_, i) => `store:mindmap:d${i + 1}`);
const listed: BuildInfo = {
  name: 'Rel_ACME_1_2_15',
  family: 'ACME',
  line: '1.2',
  base: 'Rel_ACME_1_2_15',
  platform: null,
  built_at: '2026-01-02T10:00:00.000Z',
  released_at: '2026-01-05T00:00:00.000Z',
  sources: { tree: 'site:tree:Rel_ACME_1_2_15', cases: ids },
};

function setDocument(w: World, i: number, variant = ''): void {
  w.external.set(ids[i - 1], {
    bytes: mindMap({ id: `d${i}`, module: `M${i % 5}` }, [{ id: `d${i}-c1`, text: `[cmd: ${i % 2 === 0 ? 'system reboot' : 'net ping'}] 用例 ${i}${variant}`, expected: [`期望 ${i}`] }]),
    mediaType: 'application/json',
  });
}

const docReads = (w: World): number => w.external.reads.filter((id) => id.startsWith('store:mindmap:')).length;

/** Load records of list sources (read actions of knowledge.sources@1). */
async function readActions(w: World): Promise<number> {
  let n = 0;
  let cursor: string | null = null;
  do {
    const page: { items: Array<{ body: { component: string } }>; next: string | null } = await w.kit.store.find({ key: 'action.kind', value: 'read', kind: 'action', limit: 500, cursor });
    n += page.items.filter((r) => r.body.component === 'knowledge.sources@1').length;
    cursor = page.next;
  } while (cursor !== null);
  return n;
}

describe('a plan that lists 500 documents for a build', () => {
  test('first sync reads and produces them in batches; reruns read nothing again, retry what failed, recheck finds a change', async (t) => {
    const w = await makeWorld(postgres, {
      pack: { functions: { 'plan.ts': STATIC_PLAN_SOURCE }, declaration: { sync: { ...DEFAULT_SYNC, options: { builds: [listed] } }, producers: [DEFAULT_PRODUCERS[0], casesProducer()] } },
    });
    t.after(() => w.close());
    w.external.set('site:page:index', { bytes: linkPage('index', []), mediaType: 'text/html' });
    w.external.set('site:tree:Rel_ACME_1_2_15', { bytes: catalogXml(BASE_CATALOG), mediaType: 'application/xml' });
    for (let i = 1; i <= COUNT; i++) if (i !== 17) setDocument(w, i);

    const first = await w.knowledge.syncProduct(w.product, { by: w.admin });
    assert.equal(first.error, null);
    const report = first.builds.find((b) => b.name === listed.name);
    assert.equal(report?.outcome, 'produced', report?.reason);
    assert.equal(report?.skipped, 1, 'd17 could not be read');
    assert.deepEqual(report?.calls, { made: 11, reused: 0 }, 'the command producer and ten batches of fifty');
    assert.match(report?.reason ?? '', /跳过 1 份列出的来源/);
    assert.equal(docReads(w), COUNT);
    // The build record names the list role; the production keeps the list the plan gave, by reference.
    const records = await w.kit.store.find<{ build: BuildInfo; lists?: string[] }>({ key: INDEX.build, value: 'acme/rel_acme_1_2_15', kind: 'claim', limit: 5 });
    assert.deepEqual(records.items[0].body.lists, ['cases']);
    assert.equal(records.items[0].body.build!.sources.cases, undefined);
    const production = await w.knowledge.store.latestProduction('acme', listed.name);
    assert.equal((production?.detail.build!.sources.cases as { count: number }).count, COUNT);
    const root = report?.root as string;
    const page = await w.knowledge.getNodes({ root, paths: ['/commands/system/reboot', '/commands/net/ping'], depth: 0 }, w.admin);
    assert.deepEqual(page?.nodes.map((n) => n.entries.length), [1 + 250, 1 + 249]);

    // A rerun: nothing changed, only the document that could not be loaded is tried again.
    const second = await w.knowledge.syncProduct(w.product, { by: w.admin });
    assert.equal(second.builds[0].outcome, 'produced');
    assert.deepEqual(second.builds[0].calls,{made:1,reused:10},'all skipped sources are retried while successful calls remain reusable');
    assert.match(second.builds[0].reason, /上次跳过 1 份来源，本次全部重试/);
    assert.equal(docReads(w), COUNT + 1);

    // The document appears. A dry run says it would produce again and stores no load of its own.
    setDocument(w, 17);
    const loadsBefore = await readActions(w);
    const dry = await w.knowledge.syncProduct(w.product, { by: w.admin, dryRun: true });
    assert.equal(dry.builds[0].would_produce, true);
    assert.match(dry.builds[0].reason, /试运行：列表里跳过的来源 store:mindmap:d17 现在能用了/);
    assert.equal(await readActions(w), loadsBefore);
    assert.equal(docReads(w), COUNT + 2);
    // The next sync produces again, reading only it and calling only its batch.
    const third = await w.knowledge.syncProduct(w.product, { by: w.admin });
    assert.equal(third.builds[0].outcome, 'produced', third.builds[0].reason);
    assert.match(third.builds[0].reason, /列表里跳过的来源 store:mindmap:d17 现在能用了/);
    assert.deepEqual(third.builds[0].calls, { made: 2, reused: 9 });
    assert.equal(third.builds[0].skipped, 0);
    assert.equal(docReads(w), COUNT + 3);
    assert.equal(await readActions(w), loadsBefore + 1);
    assert.match(formatSyncReport(third), /生产器调用 2 次，复用 9 次/);

    // A document changes behind the same id: a plain sync does not notice, a recheck reads all again and produces.
    setDocument(w, 42, '（改）');
    const plain = await w.knowledge.syncProduct(w.product, { by: w.admin });
    assert.equal(plain.builds[0].outcome, 'skipped');
    assert.equal(docReads(w), COUNT + 3);
    const rechecked = await w.knowledge.syncProduct(w.product, { by: w.admin, recheck: true });
    assert.equal(rechecked.builds[0].outcome, 'produced', rechecked.builds[0].reason);
    assert.deepEqual(rechecked.builds[0].calls, { made: 2, reused: 9 });
    assert.equal(docReads(w), 2 * COUNT + 3, 'every document read once by the recheck, none again by the production');
    const unchanged = await w.knowledge.syncProduct(w.product, { by: w.admin, recheck: true });
    assert.equal(unchanged.builds[0].outcome, 'skipped');
    assert.match(unchanged.builds[0].reason, /重读后来源摘要没有变/);
  });
});
