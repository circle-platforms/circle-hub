// K05: one batch read of a root's subtrees gives exactly what the paged subtree read gives, node by node, for the same reader.
// Synthetic catalog and database only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { NodesPage } from '../ports.ts';
import type { Principal } from '../records/api.ts';
import { catalogXml, BASE_CATALOG, makeWorld, startPostgres, type World } from './test-support.ts';

type Node = NodesPage['nodes'][number];
/** What only a page carries: the feeding structure text on the root of a first page and the back-references. */
const bare = ({ feeding_structure: _structure, backlinks: _backlinks, ...node }: Node & { feeding_structure?: unknown; backlinks?: unknown }): Node => node as Node;

/** Every node under `paths` through the paged read: each page by its cursor, and below the depth limit from the nodes whose children were not reached. */
async function paged(w: World, root: string, paths: string[], reader: Principal): Promise<Node[] | null> {
  const out = new Map<string, Node>(); let frontier = paths, guard = 0;
  while (frontier.length) {
    const next: string[] = [];
    for (const path of frontier) {
      let cursor: string | null = null;
      do {
        const page: NodesPage | null = await w.knowledge.getNodes({ root, paths: [path], depth: 6, cursor }, reader);
        if (page === null) return null;
        for (const node of page.nodes) {
          const seen = out.get(node.path);
          // A node split over pages comes back once per page with the next slice of its entries.
          out.set(node.path, seen ? { ...seen, entries: [...seen.entries, ...node.entries] } : bare(node));
        }
        cursor = page.next;
        assert.ok(++guard < 5000, 'paging ends');
      } while (cursor !== null);
    }
    for (const node of out.values()) for (const child of node.children) if (!out.has(child.path)) next.push(child.path);
    frontier = [...new Set(next)];
  }
  return [...out.values()];
}
const byPath = (nodes: Node[]) => [...nodes].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

test('the batch read of a root equals the paged read node by node, for the whole root and for one subtree', async (t) => {
  const pg = await startPostgres(); t.after(() => pg.stop());
  // Three nodes a page: the paged read needs many pages for what the batch read gives at once.
  const w = await makeWorld(pg, { knowledge: { limits: { pageNodes: 3 } } }); t.after(() => w.close());
  w.external.set('site:tree:synthetic-10.6', { bytes: catalogXml(BASE_CATALOG), mediaType: 'application/xml' });
  const made = await w.knowledge.produceTree({ product: w.product, build: { name: 'Synthetic_10_6_1', family: 'ACME', line: '10.6', base: 'Synthetic_10_6_1', platform: null, built_at: null, released_at: null, sources: { tree: 'site:tree:synthetic-10.6' }, root: null } });
  assert.equal(made.ok, true, JSON.stringify(made));
  const root = made.root!;

  const whole = await w.knowledge.subtree!({ root }, w.user);
  const pages = await paged(w, root, ['/'], w.user);
  assert.ok(whole && pages && whole.length > 3, 'more nodes than one page holds');
  assert.equal(whole[0].path, '/', 'pre-order from the root');
  assert.equal(new Set(whole.map((node) => node.path)).size, whole.length, 'each node once');
  assert.ok(whole.some((node) => node.entries.length > 0), 'the entries come with their nodes');
  assert.deepEqual(byPath(whole), byPath(pages));

  const top = whole.find((node) => node.children.length > 0 && node.path !== '/')!.path;
  const part = await w.knowledge.subtree!({ root, paths: [top] }, w.user);
  assert.deepEqual(byPath(part!), byPath((await paged(w, root, [top], w.user))!));
  assert.ok(part!.every((node) => node.path === top || node.path.startsWith(top + '/')));
  // Overlapping paths give each node once; a path the root does not hold gives nothing.
  assert.equal((await w.knowledge.subtree!({ root, paths: [top, top, '/'] }, w.user))!.length, whole.length);
  assert.deepEqual(await w.knowledge.subtree!({ root, paths: ['/no-such-node'] }, w.user), []);
});

test('a reader who may not read the root, an unknown root and a malformed query get what the paged read gives them', async (t) => {
  const pg = await startPostgres(); t.after(() => pg.stop());
  const w = await makeWorld(pg); t.after(() => w.close());
  w.external.set('site:tree:synthetic-10.6', { bytes: catalogXml(BASE_CATALOG), mediaType: 'application/xml' });
  const made = await w.knowledge.produceTree({ product: w.product, build: { name: 'Synthetic_10_6_1', family: 'ACME', line: '10.6', base: 'Synthetic_10_6_1', platform: null, built_at: null, released_at: null, sources: { tree: 'site:tree:synthetic-10.6' }, root: null } });
  const root = made.root!;
  assert.equal(await w.knowledge.getNodes({ root, paths: ['/'], depth: 1 }, w.outsider), null);
  assert.equal(await w.knowledge.subtree!({ root }, w.outsider), null, 'absent and forbidden alike');
  assert.equal(await w.knowledge.subtree!({ root: 'f'.repeat(64) }, w.user), null);
  assert.equal(await w.knowledge.subtree!({ root: 'not-a-digest' }, w.user), null);
  await assert.rejects(w.knowledge.subtree!({ root, paths: ['no-leading-slash'] }, w.user), /路径格式不对/);
  await assert.rejects(w.knowledge.subtree!({ root, composition: 'e'.repeat(64) }, w.user), /所给组成不属于该根/);
});
