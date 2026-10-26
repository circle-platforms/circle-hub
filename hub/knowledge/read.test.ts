// The reading side: the permission matrix (admin, a reader with the product's pack, an outsider, a disabled or demoted
// account, an unknown root: absent and forbidden are the same null), get_nodes pages and coverage, the shape get_nodes
// returns, tree and entry references resolved through hub/refs, provenance and the diff of two roots.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { GetNodesOutput } from '../../contracts/src/tools.ts';
import type { PermissionRole } from '../../contracts/generated/vocabulary.ts';
import type { KnownBuild } from '../../contracts/src/product.ts';
import { createDefaultRegistry, resolveReference } from '../refs/api.ts';
import type { TemporaryPostgres } from '../testing/postgres.ts';
import { BASE_CATALOG, catalogXml, makeWorld, startPostgres, type World } from './test-support.ts';

let postgres: TemporaryPostgres;
before(async () => {
  postgres = await startPostgres();
});
after(() => postgres?.stop());

const build = (name: string): KnownBuild => ({
  name,
  family: 'ACME',
  line: '1.2',
  base: name,
  platform: null,
  built_at: '2026-01-02T10:00:00.000Z',
  released_at: '2026-01-05T00:00:00.000Z',
  sources: { tree: `site:tree:${name}` },
  root: null,
});

async function produced(t: { after: (fn: () => Promise<void>) => void }, options: Parameters<typeof makeWorld>[1] = {}): Promise<World & { root: string }> {
  const w = await makeWorld(postgres, options);
  t.after(() => w.close());
  w.external.set('site:tree:Rel_ACME_1_2_15', { bytes: catalogXml(BASE_CATALOG), mediaType: 'application/xml' });
  const result = await w.knowledge.produceTree({ product: w.product, build: build('Rel_ACME_1_2_15') });
  assert.equal(result.ok, true, result.reason ?? '');
  return Object.assign(w, { root: result.root as string });
}

describe('permission (R02, D05 R[3])', () => {
  test('admins and readers with the product read; outsiders, disabled and demoted accounts and unknown roots get null', async (t) => {
    const w = await produced(t);
    const disabled = await w.kit.principals.createUser(w.admin, 'gone');
    w.packs.readers.set(disabled.id, new Set(['acme']));
    await w.kit.principals.setDisabled(w.admin, disabled.id, true);
    const formerAdmin = await w.kit.principals.createUser(w.admin, 'former', 'admin');
    await w.kit.principals.setRole(w.admin, formerAdmin.id, 'user');
    const query = { root: w.root, paths: ['/commands'], depth: 1 };
    const unknown = { ...query, root: 'c'.repeat(64) };
    const reader = (user: { id: string; role: PermissionRole }) => ({ user: user.id, role: user.role });
    const reboot = (await w.knowledge.getNodes({ root: w.root, paths: ['/commands/system/reboot'], depth: 0 }, w.admin))?.nodes[0];
    const entry = reboot?.entries[0].entry as string;
    const allowed = [w.admin, w.user];
    const refused = [w.outsider, disabled, { ...formerAdmin, role: 'admin' as const }, { id: 'usr_00000000000000000000000000', name: 'x', role: 'admin' as const }];
    for (const principal of allowed) {
      assert.ok(await w.knowledge.getNodes(query, principal), principal.name);
      assert.ok(await w.knowledge.treeReader().read(w.root, '/commands/system/reboot', entry, reader(principal)));
      assert.ok(await w.knowledge.treeReader().readEntry(entry, reader(principal)));
      assert.ok(await w.knowledge.provenanceOf(`tree:${w.root}/commands/system/reboot@${entry}`, principal));
    }
    for (const principal of refused) {
      assert.equal(await w.knowledge.getNodes(query, principal), null, principal.name);
      assert.equal(await w.knowledge.treeReader().read(w.root, '/commands/system/reboot', entry, reader(principal)), null);
      assert.equal(await w.knowledge.treeReader().readEntry(entry, reader(principal)), null);
      assert.equal(await w.knowledge.provenanceOf(`tree:${w.root}/commands/system/reboot@${entry}`, principal), null);
    }
    // Absent looks exactly like forbidden, for an admin too.
    assert.equal(await w.knowledge.getNodes(unknown, w.admin), null);
    assert.equal(await w.knowledge.treeReader().read(unknown.root, '/', null, reader(w.admin)), null);
    assert.equal(await w.knowledge.treeReader().read(w.root, '/commands/nothing', null, reader(w.admin)), null);
    assert.equal(await w.knowledge.treeReader().read(w.root, '/commands/system/reboot', 'd'.repeat(64), reader(w.admin)), null);
    assert.equal(await w.knowledge.treeReader().readEntry('d'.repeat(64), reader(w.admin)), null);
  });
});

describe('get_nodes', () => {
  test('pages with cursors, coverage complete only on the last page, the tool shape, missing paths noted', async (t) => {
    const w = await produced(t, { knowledge: { limits: { pageNodes: 3 } } });
    const pages = [];
    let cursor: string | null = null;
    do {
      const page = await w.knowledge.getNodes({ root: w.root, paths: ['/'], depth: 6, cursor }, w.user);
      assert.ok(page !== null);
      pages.push(page);
      cursor = page.next;
    } while (cursor !== null);
    assert.deepEqual(pages.map((p) => p.nodes.length), [3, 3, 2]);
    assert.deepEqual(pages.map((p) => p.coverage), [
      { complete: false, examined: 3 },
      { complete: false, examined: 6 },
      { complete: true, examined: 8, total: 8 },
    ]);
    const all = pages.flatMap((p) => p.nodes);
    assert.equal(new Set(all.map((n) => n.path)).size, 8);
    const output = GetNodesOutput.safeParse({ call_result: 'ok', errors: [], trace: '0af7651916cd43dd8448eb211c80319c', root: w.root, nodes: all, coverage: pages[2].coverage });
    assert.equal(output.success, true, output.success ? '' : JSON.stringify(output.error.issues.slice(0, 3)));

    // Once read permission is established, cursor diagnostics are explicit.
    const first = await w.knowledge.getNodes({ root: w.root, paths: ['/'], depth: 6 }, w.user);
    await assert.rejects(w.knowledge.getNodes({ root: w.root, paths: ['/commands'], depth: 6, cursor: first?.next }, w.user), /游标.*首页/);
    await assert.rejects(w.knowledge.getNodes({ root: w.root, paths: ['/'], depth: 6, cursor: 'not a cursor' }, w.user), /游标.*首页/);
    assert.equal(await w.knowledge.getNodes({ root: w.root, paths:['/'], depth:6, cursor: 'not a cursor' }, w.outsider), null);
    await assert.rejects(w.knowledge.getNodes({ root: w.root, paths: ['/'], depth: 7 }, w.user), /depth/);
    await assert.rejects(w.knowledge.getNodes({ root: w.root, paths: ['commands'], depth: 1 }, w.user), /路径/);

    const partial = await w.knowledge.getNodes({ root: w.root, paths: ['/commands/net', '/commands/none'], depth: 0 }, w.user);
    assert.deepEqual(partial?.nodes.map((n) => n.path), ['/commands/net']);
    assert.equal(partial?.coverage.complete, false);
    assert.match(partial?.coverage.note ?? '', /\/commands\/none/);
    // Overlapping paths list each node once.
    const overlap = await w.knowledge.getNodes({ root: w.root, paths: ['/commands/net', '/commands/net/ping'], depth: 1 }, w.user);
    assert.deepEqual(overlap?.nodes.map((n) => n.path), ['/commands/net', '/commands/net/ping', '/commands/net/trace']);
  });
});

describe('references through hub/refs', () => {
  test('a tree address with an entry resolves to the statement with its source fragments as grounds; an entry alone is not a ground', async (t) => {
    const w = await produced(t);
    const node = (await w.knowledge.getNodes({ root: w.root, paths: ['/commands/net/ping'], depth: 0 }, w.admin))?.nodes[0];
    const entry = node?.entries[0];
    assert.ok(entry);
    const ctx = (user: { id: string; role: PermissionRole }) => ({ reader: { user: user.id, role: user.role }, parsers: createDefaultRegistry(), trees: w.knowledge.treeReader() });
    const resolved = await resolveReference(entry.reference, ctx(w.user));
    assert.equal(resolved.resolved, true);
    if (!resolved.resolved) return;
    assert.equal(resolved.text, 'net ping <host:string>\n  send echo requests');
    assert.equal(resolved.groundable, true);
    assert.equal(resolved.grounds.length, 1);
    assert.match(resolved.grounds[0], /^src:[0-9a-f]{64}\/xml@1\/x\/catalog\/group\[2\]\/command\[1\]$/);
    const bare = await resolveReference(`entry:${entry.entry}`, ctx(w.user));
    assert.equal(bare.resolved && bare.groundable, false);
    const nodeRef = await resolveReference(`tree:${w.root}/commands/net`, ctx(w.user));
    assert.equal(nodeRef.resolved && nodeRef.text, 'ping\ntrace');
    const outsider = await resolveReference(entry.reference, ctx(w.outsider));
    assert.equal(outsider.resolved, false);
    assert.equal(!outsider.resolved && outsider.code, 'SOURCE_UNAVAILABLE');
  });

  test('provenance of an entry: the composition rows, fragments and the sources with their external identity and basis', async (t) => {
    const w = await produced(t);
    const node = (await w.knowledge.getNodes({ root: w.root, paths: ['/commands/system/show'], depth: 0 }, w.admin))?.nodes[0];
    const rows = await w.knowledge.provenanceOf(node?.entries[0].reference as string, w.admin);
    assert.equal(rows?.length, 1);
    const row = rows?.[0];
    assert.equal(row?.build, 'Rel_ACME_1_2_15');
    assert.equal(row?.basis, 'release_record');
    assert.equal(row?.decided_by, 'acme@1.0.0');
    assert.deepEqual(row?.producers, ['commands']);
    assert.deepEqual(row?.sources.map((s) => [s.external, s.basis, s.read_tier]), [['site:tree:Rel_ACME_1_2_15', 'release_record', 'model_readable']]);
    assert.equal(await w.knowledge.provenanceOf('not a reference', w.admin), null);
    assert.equal(await w.knowledge.provenanceOf(`tree:${w.root}/commands/none`, w.admin), null);
  });
});

describe('diff of two roots', () => {
  test('added, removed and modified paths; shared subtrees are not walked; equal roots differ nowhere', async (t) => {
    const w = await produced(t);
    w.external.set('site:tree:Rel_ACME_1_2_16', {
      bytes: catalogXml({
        system: [BASE_CATALOG.system[0], { name: 'show', params: [{ name: 'detail', type: 'string' }], help: 'show the state' }],
        net: [BASE_CATALOG.net[0], { name: 'arp', params: [] }],
        disk: [{ name: 'list', params: [] }],
      }),
      mediaType: 'application/xml',
    });
    const next = await w.knowledge.produceTree({ product: w.product, build: build('Rel_ACME_1_2_16') });
    assert.equal(next.ok, true, next.reason ?? '');
    const ping = (await w.knowledge.getNodes({ root: w.root, paths: ['/commands/net/ping'], depth: 0 }, w.admin))?.nodes[0].digest;
    const store = w.knowledge.store;
    const read: string[] = [];
    const original = store.node.bind(store);
    store.node = (digest, tx) => {
      read.push(digest);
      return original(digest, tx);
    };
    const diff = await w.knowledge.diffRoots(w.root, next.root as string);
    store.node = original;
    assert.ok(ping !== undefined && !read.includes(ping), 'the unchanged leaf shared by both roots is not read');
    assert.deepEqual(diff, {
      from: w.root,
      to: next.root,
      added: ['/commands/disk', '/commands/disk/list', '/commands/net/arp'],
      removed: ['/commands/net/trace'],
      modified: ['/commands/system/show'],
    });
    const reverse = await w.knowledge.diffRoots(next.root as string, w.root);
    assert.deepEqual(reverse?.added, ['/commands/net/trace']);
    assert.deepEqual(reverse?.removed, ['/commands/disk', '/commands/disk/list', '/commands/net/arp']);
    assert.deepEqual(await w.knowledge.diffRoots(w.root, w.root), { from: w.root, to: w.root, added: [], removed: [], modified: [] });
    assert.equal(await w.knowledge.diffRoots(w.root, 'b'.repeat(64)), null);
  });
});
