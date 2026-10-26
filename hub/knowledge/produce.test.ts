// Producing roots from synthetic producers (temporary PostgreSQL, real sandboxed pack functions): nodes, composition,
// digest stability, sharing of unchanged subtrees, refusal of entries that fail verification, credential-hit sources,
// catalogs and spans left unplaced without a typed-judgment model.
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { after, before, describe, test } from 'node:test';
import type { KnownBuild } from '../../contracts/src/product.ts';
import { TreeRootBody } from '../../contracts/src/knowledge.ts';
import { SANDBOX_ERRORS } from '../rules/api.ts';
import { BASE_CATALOG, DEFAULT_PRODUCERS, catalogXml, makeWorld, startPostgres, type World } from './test-support.ts';
import type { TemporaryPostgres } from '../testing/postgres.ts';
import { INDEX } from './store.ts';

let postgres: TemporaryPostgres;
before(async () => {
  postgres = await startPostgres();
});
after(() => postgres?.stop());

const XML = 'application/xml';

function build(name: string, extra: Partial<KnownBuild> = {}): KnownBuild {
  return {
    name,
    family: 'ACME',
    line: '1.2',
    base: name,
    platform: null,
    built_at: '2026-01-02T10:00:00.000Z',
    released_at: '2026-01-05T00:00:00.000Z',
    sources: { tree: `site:tree:${name}` },
    root: null,
    ...extra,
  };
}

async function world(t: { after: (fn: () => Promise<void>) => void }, options: Parameters<typeof makeWorld>[1] = {}): Promise<World> {
  const w = await makeWorld(postgres, options);
  t.after(() => w.close());
  return w;
}

async function composition(w: World, digest: string) {
  const record = await w.kit.store.get(digest);
  assert.ok(record !== null);
  return TreeRootBody.parse(record.body);
}

describe('producing a root', () => {
  test('entries become nodes bottom-up with a composition that names every fragment, its basis and its decider', async (t) => {
    const w = await world(t);
    w.external.set('site:tree:Rel_ACME_1_2_15', { bytes: catalogXml(BASE_CATALOG), mediaType: XML });
    const result = await w.knowledge.produceTree({ product: w.product, build: build('Rel_ACME_1_2_15') });
    assert.equal(result.ok, true, result.reason ?? '');
    assert.equal(result.nodes, 8);
    assert.equal(result.created, 8);
    assert.equal(result.entries, 4);
    assert.equal(result.refusedCount, 0);
    const root = result.root as string;

    const page = await w.knowledge.getNodes({ root, paths: ['/'], depth: 6 }, w.admin);
    assert.ok(page !== null);
    assert.deepEqual(
      page.nodes.map((n) => [n.path, n.level]),
      [
        ['/', 'trunk'],
        ['/commands', 'trunk'],
        ['/commands/net', 'branch'],
        ['/commands/net/ping', 'leaf'],
        ['/commands/net/trace', 'leaf'],
        ['/commands/system', 'branch'],
        ['/commands/system/reboot', 'leaf'],
        ['/commands/system/show', 'leaf'],
      ],
    );
    assert.deepEqual(page.coverage, { complete: true, examined: 8, total: 8 });
    const reboot = page.nodes.find((n) => n.path === '/commands/system/reboot');
    assert.equal(reboot?.entries.length, 1);
    assert.equal(reboot?.entries[0].statement, 'system reboot <delay:int>\n  restart the unit');
    assert.equal(reboot?.entries[0].applicability, '未声明');
    assert.equal(reboot?.entries[0].reference, `tree:${root}/commands/system/reboot@${reboot?.entries[0].entry}`);

    const body = await composition(w, result.composition as string);
    assert.equal(body.root, root);
    assert.deepEqual(body.version, { line: '1.2', build: 'Rel_ACME_1_2_15', family: 'ACME', platform: null });
    assert.equal(body.producer.id, 'acme@1.0.0');
    assert.equal(body.sources.length, 1);
    assert.equal(body.sources[0].basis, 'release_record');
    assert.equal(body.sources[0].read_tier, 'model_readable');
    const row = body.composition.find((r) => r.path === '/commands/system/reboot');
    assert.deepEqual(row?.fragments, [`src:${body.sources[0].sha256}/xml@1/x/catalog/group[1]/command[1]`]);
    assert.equal(row?.basis, 'release_record');
    assert.equal(row?.decided_by, 'acme@1.0.0');
    assert.deepEqual(body.catalogs.map((c) => [c.id, c.complete, c.members]), [['catalog@1', true, 4]]);

    const infos = await w.knowledge.rootInfo(root);
    assert.equal(infos.length, 1);
    assert.equal(infos[0].build!.name, 'Rel_ACME_1_2_15');
    assert.equal(infos[0].composition, result.composition);
    const action = await w.kit.store.get(result.action as string);
    assert.equal((action?.body as { action: string; result: string }).action, 'generate');
    assert.equal((action?.body as { result: string }).result, 'completed');
  });

  test('the same content gives the same root and writes no node again; a changed command rewrites only its path', async (t) => {
    const w = await world(t);
    w.external.set('site:tree:Rel_ACME_1_2_15', { bytes: catalogXml(BASE_CATALOG), mediaType: XML });
    w.external.set('site:tree:Rel_ACME_1_2_17', { bytes: `${catalogXml(BASE_CATALOG)}\n`, mediaType: XML });
    w.external.set('site:tree:Rel_ACME_1_2_16', { bytes: catalogXml({ ...BASE_CATALOG, net: [...BASE_CATALOG.net, { name: 'arp', params: [] }] }), mediaType: XML });
    const first = await w.knowledge.produceTree({ product: w.product, build: build('Rel_ACME_1_2_15') });
    const again = await w.knowledge.produceTree({ product: w.product, build: build('Rel_ACME_1_2_15') });
    assert.equal(again.root, first.root);
    assert.equal(again.created, 0);
    // Other bytes (a trailing newline), same content: the same root, sources differ.
    const other = await w.knowledge.produceTree({ product: w.product, build: build('Rel_ACME_1_2_17') });
    assert.equal(other.root, first.root);
    assert.equal(other.created, 0);
    assert.notEqual(other.sources[0].sha256, first.sources[0].sha256);
    // One command more under /commands/net: the leaf and its three ancestors are new; /commands/system is shared.
    const changed = await w.knowledge.produceTree({ product: w.product, build: build('Rel_ACME_1_2_16') });
    assert.notEqual(changed.root, first.root);
    assert.equal(changed.created, 4);
    const nodes = await w.kit.store.find({ key: INDEX.node, value: (await w.knowledge.getNodes({ root: changed.root as string, paths: ['/commands/system'], depth: 0 }, w.admin))?.nodes[0].digest ?? '', kind: 'tree_node' });
    assert.equal(nodes.items.length, 1, 'the shared subtree has one node record');
    assert.equal((await w.knowledge.rootInfo(first.root as string)).length, 3, 'three productions gave the first root');
  });

  test('entries whose fragment does not exist, whose path is malformed or whose slot is unknown are refused and reported', async (t) => {
    const extra = [
      { kind: 'definition', path: '/commands/ghost', statement: 'ghost', data: { words: ['ghost'], signatures: [] }, fragments: [{ parser: 'xml@1', selector: 'x/catalog/group[9]/command[1]' }], applicability: null },
      { kind: 'definition', path: '/commands/a b', statement: 'a b', data: { words: ['a', 'b'], signatures: [] }, fragments: [{ parser: 'xml@1', selector: 'x/catalog' }], applicability: null },
      { kind: 'definition', path: '/commands/c', statement: 'c', data: { words: ['c'], signatures: [] }, fragments: [{ slot: 'nope', parser: 'xml@1', selector: 'x/catalog' }], applicability: null },
      { kind: 'behaviour', path: '/commands/d', statement: 'd', data: {}, fragments: [{ parser: 'nosuch@1', selector: 'x/catalog' }], applicability: null },
      { kind: 'behaviour', path: '/commands/e', statement: 'e', data: {}, fragments: [{ parser: 'xml@1', selector: 'x/catalog', range: [0, 99999] }], applicability: null },
      { kind: 'behaviour', path: '/notes', statement: 'a valid note on the catalog', data: {}, fragments: [{ parser: 'xml@1', selector: 'x/catalog/group[2]' }], applicability: { builds: ['Rel_ACME_1_2_15'] } },
    ];
    const w = await world(t, { pack: { declaration: { producers: [{ ...DEFAULT_PRODUCERS[0], params: { extra } }] } } });
    w.external.set('site:tree:Rel_ACME_1_2_15', { bytes: catalogXml(BASE_CATALOG), mediaType: XML });
    const result = await w.knowledge.produceTree({ product: w.product, build: build('Rel_ACME_1_2_15') });
    assert.equal(result.ok, true, result.reason ?? '');
    assert.equal(result.refusedCount, 5);
    assert.deepEqual(
      result.refused.map((r) => [r.index, r.kind, /找不到|不是规范|没有声明|没有登记|字节范围/.test(r.reason)]),
      [
        [4, 'definition', true],
        [5, 'definition', true],
        [6, 'definition', true],
        [7, 'behaviour', true],
        [8, 'behaviour', true],
      ],
    );
    assert.match(result.refused[0].reason, /x\/catalog\/group\[9\]\/command\[1\] 在源文件 [0-9a-f]{64} 里找不到/);
    assert.equal(result.entries, 5, 'four commands and the valid note');
    const body = await composition(w, result.composition as string);
    assert.equal(body.refused_count, 5);
    // Members of the declared-complete catalog were lost: the root's catalog is no longer complete.
    assert.equal(body.catalogs[0].complete, false);
    assert.equal(body.catalogs[0].declared_complete, true);
    assert.match(body.catalogs[0].incomplete_reason ?? '', /3 个条目没有通过核对/);
    const catalog = await w.knowledge.catalog(result.root as string, 'catalog@1');
    assert.equal(catalog?.complete, false);
    const note = await w.knowledge.getNodes({ root: result.root as string, paths: ['/notes'], depth: 0 }, w.admin);
    assert.equal(note?.nodes[0].entries[0].applicability, '起止构建 Rel_ACME_1_2_15');
  });

  test('a source whose credential scan found something is never parsed into the tree; the reason names its digest', async (t) => {
    const w = await world(t);
    const secret = catalogXml({ system: [{ name: 'login', help: 'password = Xy7#kq9Lm2' }] });
    w.external.set('site:tree:Rel_ACME_1_2_15', { bytes: secret, mediaType: XML });
    const result = await w.knowledge.produceTree({ product: w.product, build: build('Rel_ACME_1_2_15') });
    assert.equal(result.ok, false);
    assert.equal(result.root, null);
    const [artifact] = await w.kit.artifacts.records((await w.kit.store.find<{ sha256: string }>({ key: 'artifact.object', value: 'site:tree:Rel_ACME_1_2_15', kind: 'source_artifact' })).items[0].body.sha256);
    assert.equal(artifact.body.read_tier, 'retain_only');
    assert.ok(result.reason?.includes(artifact.body.sha256), result.reason ?? '');
    assert.match(result.reason ?? '', /凭据扫描有命中/);
    assert.match(result.reason ?? '', /管理员.*接受这份文件.*扫描命中项.*重新运行同步/);
    const failed = await w.kit.store.get(result.action as string);
    assert.equal((failed?.body as { result: string }).result, 'error');
    assert.equal(await w.knowledge.rootOfBuild('acme', 'Rel_ACME_1_2_15'), null);

    // An administrator accepts the findings of exactly this document; the next read stores it readable and the build produces.
    await w.kit.artifacts.acceptFindings(w.admin, artifact.body.sha256, '合成目录里的示例写法，不是真实凭据');
    const retried = await w.knowledge.produceTree({ product: w.product, build: build('Rel_ACME_1_2_15') });
    assert.equal(retried.ok, true, retried.reason ?? '');
    assert.equal(retried.sources[0].sha256, artifact.body.sha256);
  });

  test('the catalog of a root is the closed view over its command entries (C07)', async (t) => {
    const w = await world(t);
    w.external.set('site:tree:Rel_ACME_1_2_15', { bytes: catalogXml(BASE_CATALOG), mediaType: XML });
    const result = await w.knowledge.produceTree({ product: w.product, build: build('Rel_ACME_1_2_15') });
    const root = result.root as string;
    const catalog = await w.knowledge.catalog(root, 'catalog@1');
    assert.ok(catalog !== null);
    assert.equal(catalog.size, 4);
    assert.equal(catalog.complete, true);
    assert.equal(catalog.caseSensitive, false);
    assert.equal(catalog.reference, `tree:${root}/commands`);
    const match = catalog.lookup(['SYSTEM', 'reboot', '30']);
    assert.equal(match?.length, 2);
    assert.deepEqual(match?.entry.signatures[0].params, [{ name: 'delay', type: 'int', minimum: 0, maximum: 600 }]);
    assert.match(match?.entry.reference ?? '', new RegExp(`^tree:${root}/commands/system/reboot@[0-9a-f]{64}$`));
    assert.equal(catalog.get(['net', 'nope']), undefined);
    assert.equal(await w.knowledge.catalog(root, 'other@1'), null);
    assert.equal(await w.knowledge.catalog('f'.repeat(64), 'catalog@1'), null);
  });

  test('an alias has no tree of its own; a producer output outside the contract fails the build', async (t) => {
    const w = await world(t, { pack: { functions: { 'commands.ts': 'export default function (input: unknown): unknown { return { entries: [{ kind: 1 }], warnings: [] }; }' } } });
    w.external.set('site:tree:Rel_ACME_1_2_15', { bytes: catalogXml(BASE_CATALOG), mediaType: XML });
    const alias = await w.knowledge.produceTree({ product: w.product, build: build('Rel_ZETA_1_2_7', { family: 'ZETA', base: 'Rel_ACME_1_2_15', sources: {} }) });
    assert.equal(alias.ok, false);
    assert.match(alias.reason ?? '', /别名/);
    const broken = await w.knowledge.produceTree({ product: w.product, build: build('Rel_ACME_1_2_15') });
    assert.equal(broken.ok, false);
    assert.match(broken.reason ?? '', /producer-output@1/);
  });

  test('a missing required source fails the build; an unreadable optional one is skipped with a warning', async (t) => {
    const producers = [
      DEFAULT_PRODUCERS[0],
      { id: 'manual', title: '手册', function: { module: 'functions/manual.ts' }, inputs: { manual: { external: 'store:manual:{product}-{line}', optional: true } } },
    ];
    const w = await world(t, { pack: { declaration: { producers } } });
    const missing = await w.knowledge.produceTree({ product: w.product, build: build('Rel_ACME_1_2_15') });
    assert.equal(missing.ok, false);
    assert.match(missing.reason ?? '', /HTTP 404/);
    w.external.set('site:tree:Rel_ACME_1_2_15', { bytes: catalogXml(BASE_CATALOG), mediaType: XML });
    const produced = await w.knowledge.produceTree({ product: w.product, build: build('Rel_ACME_1_2_15') });
    assert.equal(produced.ok, true, produced.reason ?? '');
    assert.ok(produced.warnings.some((warning) => warning.includes('store:manual:acme-1.2') && warning.includes('可选')));
  });

  test('function-only bytes, a personal-credential read and bytes the scanner cannot inspect never enter the tree', async (t) => {
    const w = await world(t);
    const cases: Array<[string, Parameters<World['external']['set']>[1], RegExp]> = [
      ['Rel_ACME_1_2_1', { bytes: catalogXml(BASE_CATALOG), mediaType: XML, readTier: 'function_bytes_only' }, /读取档位是“只许函数按引用读字节”/],
      ['Rel_ACME_1_2_2', { bytes: catalogXml(BASE_CATALOG), mediaType: XML, personal: true }, /个人凭据读到的源文件不进知识树/],
      ['Rel_ACME_1_2_3', { bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]), mediaType: 'image/png' }, /不是凭据扫描能检查的文本/],
      ['Rel_ACME_1_2_4', { bytes: 'plain words, no structure', mediaType: 'application/x-unknown' }, /没有支持此媒体类型的核心解析器/],
    ];
    for (const [name, object, reason] of cases) {
      w.external.set(`site:tree:${name}`, object);
      const result = await w.knowledge.produceTree({ product: w.product, build: build(name) });
      assert.equal(result.ok, false, name);
      assert.match(result.reason ?? '', reason, name);
      assert.match(result.reason ?? '', /[0-9a-f]{64}/, 'the reason names the digest');
    }
  });

  test('with two input slots every fragment names its slot; statements over the limit are refused', async (t) => {
    const two = [{ ...DEFAULT_PRODUCERS[0], inputs: { tree: { source: 'tree' }, also: { source: 'tree' } } }];
    const w = await world(t, { pack: { declaration: { producers: two } }, knowledge: { limits: { maxStatementBytes: 30 } } });
    w.external.set('site:tree:Rel_ACME_1_2_15', { bytes: catalogXml(BASE_CATALOG), mediaType: XML });
    const result = await w.knowledge.produceTree({ product: w.product, build: build('Rel_ACME_1_2_15') });
    assert.equal(result.ok, false);
    assert.match(result.reason ?? '', /4 个条目都没有通过核对/);
    // The longest statements fail on size, the others on the missing slot.
    assert.ok(result.refused.some((r) => /陈述超过 30 字节/.test(r.reason)));
    assert.ok(result.refused.some((r) => /必须写明 slot/.test(r.reason)));
  });

  test('a producer that reaches for a listening loopback server fails the build, and the server sees no connection', async (t) => {
    let connections = 0;
    const server = createServer((socket) => {
      connections += 1;
      socket.on('error', () => {});
      socket.end('hello');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const address = server.address();
    assert.ok(address !== null && typeof address === 'object');
    const hostile = `export default async function (input: unknown): Promise<unknown> { const r = await fetch('http://127.0.0.1:${address.port}/'); return { entries: [], warnings: [String(r.status)] }; }`;
    const w = await world(t, { pack: { functions: { 'commands.ts': hostile } } });
    w.external.set('site:tree:Rel_ACME_1_2_15', { bytes: catalogXml(BASE_CATALOG), mediaType: XML });
    const result = await w.knowledge.produceTree({ product: w.product, build: build('Rel_ACME_1_2_15') });
    assert.equal(result.ok, false);
    assert.equal(result.reason, `生产器 commands 运行失败：${SANDBOX_ERRORS.SANDBOX_VIOLATION}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(connections, 0);
  });

  test('without a placer, spans the code cannot place are stored and citable but not hung (K01 R[4])', async (t) => {
    const producers = [
      DEFAULT_PRODUCERS[0],
      { id: 'manual', title: '手册', function: { module: 'functions/manual.ts' }, inputs: { manual: { external: 'store:manual:{product}-{line}' } }, placement: 'judgment_allowed' as const },
    ];
    const w = await world(t, { pack: { declaration: { producers } } });
    w.external.set('site:tree:Rel_ACME_1_2_15', { bytes: catalogXml(BASE_CATALOG), mediaType: XML });
    w.external.set('store:manual:acme-1.2', { bytes: '# Manual\n\n## Reboot\n\nThe reboot command restarts the unit after a delay.\n\n## Ping\n\nPing sends echo requests to a host.\n', mediaType: 'text/markdown' });
    const result = await w.knowledge.produceTree({ product: w.product, build: build('Rel_ACME_1_2_15') });
    assert.equal(result.ok, true, result.reason ?? '');
    assert.equal(result.unplaced, 2);
    assert.equal(result.entries, 4);
    const body = await composition(w, result.composition as string);
    assert.equal(body.unplaced.length, 2);
    for (const row of body.unplaced) {
      assert.equal(row.stopped_at, '/');
      assert.equal(row.candidate, null);
      assert.match(row.note, /未归位，留在根下/);
      assert.match(row.fragments[0], /^src:[0-9a-f]{64}\/markdown@1\/b\/0\//);
      // Stored and citable: the entry resolves by its digest for a reader of the product.
      const read = await w.knowledge.treeReader().readEntry(row.entry, { user: w.user.id, role: 'user' });
      assert.ok(read !== null && /reboot|Ping/.test(read.text));
    }
    assert.equal(body.sources.find((s) => s.slot === 'manual')?.basis, 'declared');
  });
});
