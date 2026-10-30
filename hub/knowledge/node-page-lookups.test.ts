// get_nodes beside contributions (perf-real-data). A node page must answer exactly what the per-node reads answer: the
// reference is the same service read outside any request (every permission check asks the product port again), with the
// contribution page of every node read and every node read on its own. Inside one request the product port is asked once,
// another request or another reader is decided again (decision 82), and the single-key lookups of a page do not grow with
// the number of nodes on it. Synthetic product and temporary PostgreSQL only.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import pg from 'pg';
import type { NodesPage, NodesQuery } from '../ports.ts';
import { canonicalize, newId, withRequestPermissions, type Principal } from '../records/api.ts';
import { resolveReference } from '../refs/api.ts';
import { createTestParserRegistry } from '../testing/parsers.ts';
import { catalogXml, makeWorld, startPostgres } from './test-support.ts';

let postgres: Awaited<ReturnType<typeof startPostgres>>;
before(async () => { postgres = await startPostgres(); });
after(async () => { await postgres?.stop(); });

type World = Awaited<ReturnType<typeof makeWorld>>;
interface Built { root: string; composition: string }

/** A small inline-row limit parts the compositions, as large real roots are: rows then carry their entries' content. */
const LIMITS = { inlineRows: 8 };

/** One build whose /commands/wide node has `width` commands, beside a one-command group. */
async function build(w: World, name: string, width: number): Promise<Built> {
  const wide = Array.from({ length: width }, (_, i) => ({ name: `c${String(i).padStart(2, '0')}`, help: `synthetic help ${i}` }));
  w.external.set(`site:tree:${name}`, { bytes: catalogXml({ wide, narrow: [{ name: 'only', help: 'synthetic help' }] }), mediaType: 'application/xml' });
  const produced = await w.knowledge.produceTree({ product: w.product, build: { name, family: 'ACME', line: '10.6.1', base: name, platform: null, built_at: null, released_at: null, root: null, sources: { tree: `site:tree:${name}` } } });
  assert.equal(produced.ok, true, produced.reason ?? '');
  return { root: produced.root!, composition: produced.composition! };
}

/** An admitted contribution of the reader on one command node, quoting its definition. */
async function contribute(w: World, at: Built, path: string): Promise<string> {
  const page = await w.knowledge.getNodes({ root: at.root, paths: [path], depth: 0 }, w.admin);
  const entry = page?.nodes[0]?.entries[0];
  assert.ok(entry, `the definition at ${path}`);
  const resolve = async (reference: string) => {
    const got = await resolveReference(reference, { reader: { user: w.user.id, role: 'user' }, parsers: createTestParserRegistry(), trees: w.knowledge.treeReader({ composition: at.composition }) });
    return got.resolved ? { ok: true as const, value: { reference: got.reference, text: got.text } } : { ok: false as const, message: got.message };
  };
  const layer = w.knowledge.layers.contributions;
  // A long statement makes a contribution larger than what is left of a small page, so pages split and continue.
  const prepared = await layer.prepare(w.user, { kind: 'assertion', statement: `合成回注 ${path} ${'说明'.repeat(1500)}`, root: at.root, path, source: { reference: entry.reference, quote: path.split('/').slice(2).join(' ') } }, { root: at.root, product: w.product.product.id, composition: at.composition, resolve });
  return w.kit.store.withTransaction((tx) => layer.append(prepared, { run: newId('run'), submission: 'synthetic-submission', session: null, model: 'scripted-model' }, tx));
}

/** The page as per-node reads answer it: outside any request, every node's contribution page read, every node read alone. */
async function reference(w: World, query: NodesQuery, reader: Principal): Promise<NodesPage | null> {
  const layer = w.knowledge.layers.contributions, store = w.knowledge.store;
  const paths = layer.pathsWithRecords, nodes = store.nodes;
  layer.pathsWithRecords = async (_root, list) => new Set(list);
  store.nodes = async (digests) => {
    const out = new Map<string, NonNullable<Awaited<ReturnType<typeof store.node>>>>();
    for (const digest of new Set(digests)) { const node = await store.node(digest); if (node !== null) out.set(digest, node); }
    return out;
  };
  try { return await w.knowledge.getNodes(query, reader); } finally { layer.pathsWithRecords = paths; store.nodes = nodes; }
}

/** A get_nodes request as the server makes it: inside the reader's request permissions. */
const inRequest = (w: World, query: NodesQuery, reader: Principal): Promise<NodesPage | null> =>
  withRequestPermissions(w.kit.artifacts, reader, () => w.knowledge.getNodes(query, reader));

/** Every page of a query, following `next`. */
async function allPages(read: (query: NodesQuery) => Promise<NodesPage | null>, query: NodesQuery): Promise<Array<NodesPage | null>> {
  const out: Array<NodesPage | null> = [];
  let cursor: string | null = null;
  do {
    const page: NodesPage | null = await read({ ...query, cursor });
    out.push(page);
    cursor = page?.next ?? null;
    assert.ok(out.length <= 60, 'paging ends');
  } while (cursor !== null);
  return out;
}

/** SQL executions while `body` runs, and those that read one record by digest or one index value. */
async function counted<T>(body: () => Promise<T>): Promise<{ value: T; total: number; single: number }> {
  const original = pg.Client.prototype.query;
  let total = 0, single = 0;
  pg.Client.prototype.query = function (this: pg.Client, ...args: unknown[]) {
    const text = typeof args[0] === 'string' ? args[0] : String((args[0] as { text?: string })?.text ?? '');
    total++;
    if (/WHERE digest = \$1/.test(text) || /i\.key = \$1 AND i\.value = \$2/.test(text)) single++;
    return Reflect.apply(original, this, args);
  } as typeof original;
  try { return { value: await body(), total, single }; } finally { pg.Client.prototype.query = original; }
}

/** Counts the product port's answers. */
function countPort(w: World): { calls: () => number; reset: () => void } {
  let calls = 0;
  const port = w.packs.readableProducts.bind(w.packs);
  w.packs.readableProducts = async (user: Principal) => { calls++; return port(user); };
  return { calls: () => calls, reset: () => { calls = 0; } };
}

test('a node page beside contributions answers as the per-node reads do, for every reader and page', { timeout: 300_000 }, async (t) => {
  const w = await makeWorld(postgres, { knowledge: { limits: LIMITS } });
  t.after(() => w.close());
  const small = await build(w, 'Rel_ACME_10_6_1_10', 12), large = await build(w, 'Rel_ACME_10_6_1_11', 48);
  for (const at of [small, large]) for (const path of ['/commands/wide/c03', '/commands/wide/c07']) await contribute(w, at, path);
  const port = countPort(w);
  const shapes = (at: Built): NodesQuery[] => [
    { root: at.root, paths: ['/commands/wide'], depth: 1 },
    { root: at.root, paths: ['/', '/commands/wide/c03'], depth: 2 },
    { root: at.root, paths: ['/commands/narrow', '/commands/missing'], depth: 1 },
  ];
  for (const at of [small, large]) for (const query of shapes(at)) for (const reader of [w.user, w.admin, w.outsider]) {
    const expected = await reference(w, query, reader);
    port.reset();
    const answered = await inRequest(w, query, reader);
    assert.equal(canonicalize(answered), canonicalize(expected), `${reader.name} ${JSON.stringify(query.paths)} depth ${query.depth}`);
    if (reader === w.user) {
      assert.ok(answered?.nodes.some((node) => node.contributions !== undefined) || !query.paths?.includes('/commands/wide'), 'the contributions are shown');
      assert.equal(port.calls(), 1, 'one product decision per request');
    }
    if (reader === w.outsider) assert.equal(answered, null);
  }
  // Small pages: tree cursors, split contribution pages and their kc1. continuations follow the same path.
  Object.assign(w.knowledge.__context.limits, { pageNodes: 5, pageBytes: 24_000 });
  for (const at of [small, large]) for (const query of shapes(at).slice(0, 2)) {
    const expected = await allPages((q) => reference(w, q, w.user), query);
    const answered = await allPages((q) => inRequest(w, q, w.user), query);
    assert.ok(expected.length > 1, 'the query spans several pages');
    assert.ok(expected.some((page) => page?.next?.startsWith('kc1.')), 'a contribution page continues on the next page');
    assert.equal(canonicalize(answered), canonicalize(expected), `pages of ${JSON.stringify(query.paths)}`);
  }
});

test('the single-key lookups of a node page do not grow with its nodes', { timeout: 300_000 }, async (t) => {
  const w = await makeWorld(postgres, { knowledge: { limits: LIMITS } });
  t.after(() => w.close());
  const small = await build(w, 'Rel_ACME_10_6_1_10', 12), large = await build(w, 'Rel_ACME_10_6_1_11', 48);
  for (const at of [small, large]) for (const path of ['/commands/wide/c03', '/commands/wide/c07']) await contribute(w, at, path);
  const port = countPort(w);
  const query = (at: Built): NodesQuery => ({ root: at.root, paths: ['/commands/wide'], depth: 1 });
  // A first request of each root warms nothing across requests (caches live for one operation); it is measured anyway.
  const a = await counted(() => inRequest(w, query(small), w.user)), b = await counted(() => inRequest(w, query(large), w.user));
  assert.equal(a.value?.nodes.length, 13);
  assert.equal(b.value?.nodes.length, 49);
  assert.equal(b.single, a.single, `single-key lookups ${a.single} -> ${b.single}`);
  assert.ok(b.total <= a.total + 2, `total SQL ${a.total} -> ${b.total}`);
  // The per-node reads grow with the nodes, which is what the bound above detects.
  port.reset();
  const ra = await counted(() => reference(w, query(small), w.user));
  const asked = port.calls();
  const rb = await counted(() => reference(w, query(large), w.user));
  assert.ok(rb.single >= ra.single + 2 * 36, `reference single-key lookups ${ra.single} -> ${rb.single}`);
  assert.ok(asked > 13, `the reference asks the product port per check (${asked})`);
});

test('the product decision holds for one request and one reader only', { timeout: 300_000 }, async (t) => {
  const w = await makeWorld(postgres, { knowledge: { limits: LIMITS } });
  t.after(() => w.close());
  const at = await build(w, 'Rel_ACME_10_6_1_10', 12);
  await contribute(w, at, '/commands/wide/c03');
  const query: NodesQuery = { root: at.root, paths: ['/commands/wide'], depth: 1 };
  const port = countPort(w);
  const before = await inRequest(w, query, w.user);
  assert.ok(before);
  // Another request is decided again.
  port.reset();
  await inRequest(w, query, w.user);
  await inRequest(w, query, w.user);
  assert.equal(port.calls(), 2);
  // A revocation while a request runs applies from the next request on; the running request keeps its start-time decision.
  const product = w.product.product.id;
  const answer = w.packs.readableProducts;
  w.packs.readableProducts = async (user: Principal) => { const readable = await answer(user); w.packs.readers.set(w.user.id, new Set()); return readable; };
  const during = await inRequest(w, query, w.user);
  w.packs.readableProducts = answer;
  assert.equal(canonicalize(during), canonicalize(before));
  assert.equal(await inRequest(w, query, w.user), null);
  w.packs.readers.set(w.user.id, new Set([product]));
  // Inside one reader's request another reader is decided on their own; outside any request every check asks the port.
  port.reset();
  await withRequestPermissions(w.kit.artifacts, w.user, async () => {
    assert.ok(await w.knowledge.getNodes(query, w.user));
    assert.equal(await w.knowledge.getNodes(query, w.outsider), null);
    assert.ok(await w.knowledge.getNodes(query, w.user));
  });
  assert.equal(port.calls(), 2, 'the reader once, the other reader once');
  port.reset();
  assert.ok(await w.knowledge.getNodes(query, w.user));
  assert.ok(port.calls() > 1, `outside a request every check asks (${port.calls()})`);
});
