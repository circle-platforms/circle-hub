import {createTestParserRegistry as createDefaultRegistry} from '../testing/parsers.ts';
// The reading side under load and misuse (D05 R[3], B01 R[5], K02 R[2]): get_nodes checks the reader before it reads the
// paths, removes duplicates and examines a bounded number of paths; a page holds about pageBytes of statements and data and
// a node with more is split over pages by an entry cursor; a cursor beyond the walk is refused; a mistyped path in a readable
// root is REFERENCE_UNRESOLVED; a root two builds share is grounded in both compositions, or in the one a reader is bound
// to; provenance needs a reader.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { TreeRootBody } from '../../contracts/src/knowledge.ts';
import type { PermissionRole } from '../../contracts/generated/vocabulary.ts';
import type { KnownBuild } from '../../contracts/src/product.ts';
import { resolveReference } from '../refs/api.ts';
import type { TemporaryPostgres } from '../testing/postgres.ts';
import type { NodesPage } from '../ports.ts';
import { BASE_CATALOG, DEFAULT_PRODUCERS, catalogXml, makeWorld, standardSite, startPostgres, type World } from './test-support.ts';

let postgres: TemporaryPostgres;
before(async () => {
  postgres = await startPostgres();
});
after(() => postgres?.stop());

const TREE = 'site:tree:Rel_ACME_1_2_15';
const build: KnownBuild = {
  name: 'Rel_ACME_1_2_15',
  family: 'ACME',
  line: '1.2',
  base: 'Rel_ACME_1_2_15',
  platform: null,
  built_at: '2026-01-02T10:00:00.000Z',
  released_at: '2026-01-05T00:00:00.000Z',
  sources: { tree: TREE },
  root: null,
};

async function produced(t: { after: (fn: () => Promise<void>) => void }, options: Parameters<typeof makeWorld>[1] = {}): Promise<World & { root: string }> {
  const w = await makeWorld(postgres, options);
  t.after(() => w.close());
  w.external.set(TREE, { bytes: catalogXml(BASE_CATALOG), mediaType: 'application/xml' });
  const result = await w.knowledge.produceTree({ product: w.product, build });
  assert.equal(result.ok, true, result.reason ?? '');
  return Object.assign(w, { root: result.root as string });
}

async function walk(w: World, root: string, paths: string[], depth: number): Promise<NodesPage[]> {
  const pages: NodesPage[] = [];
  let cursor: string | null = null;
  do {
    const page = await w.knowledge.getNodes({ root, paths, depth, cursor }, w.user);
    assert.ok(page !== null, `page ${pages.length + 1}`);
    pages.push(page);
    cursor = page.next;
    assert.ok(pages.length < 100, 'paging ends');
  } while (cursor !== null);
  return pages;
}

const pageSize = (page: NodesPage): number =>
  page.nodes.reduce((sum, node) => sum + node.entries.reduce((s, e) => s + Buffer.byteLength(e.statement, 'utf8') + Buffer.byteLength(JSON.stringify(e.data ?? {}), 'utf8'), 0), 0);

describe('get_nodes under load', () => {
  test('the reader is checked before the paths are read; duplicates are removed; at most 256 paths are examined', async (t) => {
    const w = await produced(t);
    const many = Array.from({ length: 50_000 }, (_, i) => `/p${i}`);
    const started = performance.now();
    assert.equal(await w.knowledge.getNodes({ root: w.root, paths: many, depth: 6 }, w.outsider), null);
    assert.ok(performance.now() - started < 1000, `refused before the paths are read (${Math.round(performance.now() - started)} ms)`);

    const paths = ['/commands', '/commands', ...Array.from({ length: 300 }, (_, i) => `/none${i}`)];
    const page = await w.knowledge.getNodes({ root: w.root, paths, depth: 0 }, w.user);
    assert.ok(page !== null);
    assert.deepEqual(page.nodes.map((n) => n.path), ['/commands']);
    assert.equal(page.coverage.complete, false);
    assert.match(page.coverage.note ?? '', /最多读 256 个路径/);
    assert.match(page.coverage.note ?? '', /\/none0/);
  });

  test('overlapping paths do not walk the same subtree again', async (t) => {
    const w = await makeWorld(postgres);
    t.after(() => w.close());
    const commands = Array.from({ length: 80 }, (_, i) => ({ name: `cmd${i}`, params: [] }));
    w.external.set(TREE, { bytes: catalogXml({ grp0: commands }), mediaType: 'application/xml' });
    const result = await w.knowledge.produceTree({ product: w.product, build });
    assert.equal(result.ok, true, result.reason ?? '');
    const root = result.root as string;
    const store = w.knowledge.store;
    const original = store.node.bind(store);
    let reads = 0;
    store.node = (digest, tx) => {
      reads++;
      return original(digest, tx);
    };
    t.after(() => {
      store.node = original;
    });
    const page = await w.knowledge.getNodes({ root, paths: ['/', '/commands', '/commands/grp0'], depth: 6 }, w.user);
    store.node = original;
    assert.equal(page?.nodes.length, 83);
    // One read per node of the walk and a few for the paths themselves; walking every path's subtree again would read
    // the 80 leaves three times.
    assert.ok(reads < 100, `${reads} node reads`);
  });

  test('a page holds about pageBytes of statements and data; a node with more is split over pages by an entry cursor', async (t) => {
    const bulk = { id: 'bulk', title: '大条目', function: { module: 'functions/bulk.ts' }, inputs: { tree: { source: 'tree' } }, params: { wide: 40, data: 256 * 1024, deep: 30, statement: 200 * 1024 } };
    const w = await produced(t, { pack: { declaration: { producers: [DEFAULT_PRODUCERS[0], bulk] } } });
    const budget = 2 * 1024 * 1024;
    const largest = 300 * 1024;

    const wide = await walk(w, w.root, ['/wide'], 1);
    assert.ok(wide.length >= 5, `${wide.length} pages`);
    for (const page of wide) assert.ok(pageSize(page) <= budget + largest, `${pageSize(page)} bytes`);
    const paths = wide.flatMap((page) => page.nodes.map((n) => n.path));
    assert.equal(paths.length, 41);
    assert.equal(new Set(paths).size, 41, 'each node once');
    assert.ok(wide.slice(0, -1).every((page) => !page.coverage.complete));
    assert.deepEqual(wide[wide.length - 1].coverage, { complete: true, examined: 41, total: 41 });

    const big = await walk(w, w.root, ['/big'], 0);
    assert.ok(big.length >= 3, `${big.length} pages`);
    for (const page of big) {
      assert.deepEqual(page.nodes.map((n) => n.path), ['/big'], 'every page is a part of the one node');
      assert.ok(pageSize(page) <= budget + largest, `${pageSize(page)} bytes`);
    }
    const entries = big.flatMap((page) => page.nodes[0].entries.map((e) => e.entry));
    assert.equal(entries.length, 30);
    assert.equal(new Set(entries).size, 30, 'each entry once');
    assert.ok(big.slice(0, -1).every((page) => !page.coverage.complete && /\/big/.test(page.coverage.note ?? '')));
    assert.deepEqual(big[big.length - 1].coverage, { complete: true, examined: 1, total: 1 });
  });

  test('an authorized cursor beyond the walk has a determined remedy', async (t) => {
    const w = await produced(t, { knowledge: { limits: { pageNodes: 3 } } });
    const first = await w.knowledge.getNodes({ root: w.root, paths: ['/'], depth: 6 }, w.user);
    assert.ok(first?.next);
    const decoded = JSON.parse(Buffer.from(first.next, 'base64url').toString('utf8')) as Record<string, unknown>;
    const forged = Buffer.from(JSON.stringify({ ...decoded, o: 1_000_000 }), 'utf8').toString('base64url');
    await assert.rejects(w.knowledge.getNodes({ root: w.root, paths: ['/'], depth: 6, cursor: forged }, w.user), /游标.*首页/);
    const second = await w.knowledge.getNodes({ root: w.root, paths: ['/'], depth: 6, cursor: first.next }, w.user);
    assert.equal(second?.nodes.length, 3);
  });
});

describe('tree references', () => {
  test('a mistyped path or entry in a root the reader may read is REFERENCE_UNRESOLVED; for an outsider SOURCE_UNAVAILABLE', async (t) => {
    const w = await produced(t);
    const ctx = (user: { id: string; role: PermissionRole }) => ({ reader: { user: user.id, role: user.role }, parsers: createDefaultRegistry(), trees: w.knowledge.treeReader() });
    const cases = [`tree:${w.root}/commands/system/rebot`, `tree:${w.root}/commands/system/reboot@${'d'.repeat(64)}`];
    for (const reference of cases) {
      const mine = await resolveReference(reference, ctx(w.user));
      assert.equal(!mine.resolved && mine.code, 'REFERENCE_UNRESOLVED', reference);
      const theirs = await resolveReference(reference, ctx(w.outsider));
      assert.equal(!theirs.resolved && theirs.code, 'SOURCE_UNAVAILABLE', reference);
    }
    const unknown = await resolveReference(`tree:${'c'.repeat(64)}/commands`, ctx(w.admin));
    assert.equal(!unknown.resolved && unknown.code, 'SOURCE_UNAVAILABLE');
  });

  test('a root two builds share is grounded in both compositions; a reader bound to one composition gets its sources only', async (t) => {
    const w = await makeWorld(postgres);
    t.after(() => w.close());
    standardSite(w.external);
    await w.knowledge.syncProduct(w.product, { by: w.admin, lines: ['1.3'] });
    const acme = await w.knowledge.rootOfBuild('acme', 'Rel_ACME_1_3_20');
    const zeta = await w.knowledge.rootOfBuild('acme', 'Rel_ZETA_1_3_20');
    assert.ok(acme && zeta && acme.root === zeta.root && acme.composition !== zeta.composition);
    const sourceOf = async (composition: string) => TreeRootBody.parse((await w.kit.store.get(composition))?.body).sources[0].sha256;
    const shaA = await sourceOf(acme.composition);
    const shaZ = await sourceOf(zeta.composition);
    assert.notEqual(shaA, shaZ);
    const node = (await w.knowledge.getNodes({ root: acme.root, paths: ['/commands/net/ping'], depth: 0 }, w.admin))?.nodes[0];
    const entry = node?.entries[0].entry as string;
    const reader = { user: w.user.id, role: 'user' as const };
    const shas = (grounds: string[] | undefined) => new Set((grounds ?? []).map((g) => g.slice(4, 68)));

    const read = await w.knowledge.treeReader().read(acme.root, '/commands/net/ping', entry, reader);
    assert.deepEqual(shas(read?.grounds), new Set([shaA, shaZ]));
    const validity = read?.validity as { compositions?: Array<{ composition: string; build: string; grounds: string[] }> };
    assert.deepEqual(validity.compositions?.map((c) => [c.build, [...shas(c.grounds)]]).sort(), [
      ['Rel_ACME_1_3_20', [shaA]],
      ['Rel_ZETA_1_3_20', [shaZ]],
    ]);
    for (const [info, sha] of [[acme, shaA], [zeta, shaZ]] as const) {
      const bound = await w.knowledge.treeReader({ composition: info.composition }).read(acme.root, '/commands/net/ping', entry, reader);
      assert.deepEqual([...shas(bound?.grounds)], [sha], info.build!.name);
      assert.deepEqual((bound?.validity as { premises: string[] }).premises.slice(0, 1), [`rec:${info.composition}`]);
    }
  });

  test('provenance needs a reader: without one it is refused like an absent reference', async (t) => {
    const w = await produced(t);
    const node = (await w.knowledge.getNodes({ root: w.root, paths: ['/commands/system/show'], depth: 0 }, w.admin))?.nodes[0];
    const reference = node?.entries[0].reference as string;
    const unchecked = w.knowledge.provenanceOf as unknown as (reference: string, reader?: unknown) => Promise<unknown>;
    assert.equal(await unchecked(reference), null);
    assert.equal(await unchecked(reference, null), null);
    assert.equal((await w.knowledge.provenanceOf(reference, w.admin))?.length, 1);
    assert.equal(await w.knowledge.provenanceOf(reference, w.outsider), null);
  });
});
