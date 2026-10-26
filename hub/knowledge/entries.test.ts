// What may enter a root (K02 R[0], R[3]; C07): a catalog limited to one producer takes only that producer's entries; entries
// and spans whose kind is not an entry kind, or whose text cannot be stored, are refused one by one while the rest of the
// build is produced and every record written reads back; equal spans keep every fragment; a write the store refuses records
// a failed generate action; the per-build byte cap; the source record a connector read returned decides the read.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { TreeRootBody } from '../../contracts/src/knowledge.ts';
import type { KnownBuild } from '../../contracts/src/product.ts';
import type { ActionBody } from '../records/api.ts';
import type { TemporaryPostgres } from '../testing/postgres.ts';
import { BASE_CATALOG, DEFAULT_PRODUCERS, catalogXml, extraProducer, makeWorld, startPostgres, type World } from './test-support.ts';

let postgres: TemporaryPostgres;
before(async () => {
  postgres = await startPostgres();
});
after(() => postgres?.stop());

const XML = 'application/xml';
const TREE = 'site:tree:Rel_ACME_1_2_15';
const MANUAL = { id: 'manual', title: '手册', function: { module: 'functions/manual.ts' }, inputs: { manual: { external: 'store:manual:{product}-{line}' } } };

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

async function world(t: { after: (fn: () => Promise<void>) => void }, options: Parameters<typeof makeWorld>[1] = {}): Promise<World> {
  const w = await makeWorld(postgres, options);
  t.after(() => w.close());
  w.external.set(TREE, { bytes: catalogXml(BASE_CATALOG), mediaType: XML });
  return w;
}

async function composition(w: World, digest: string | null) {
  assert.ok(digest !== null);
  const record = await w.kit.store.get(digest);
  assert.ok(record !== null);
  return TreeRootBody.parse(record.body);
}

/** An entry of the other producer whose fragment verifies in the command tree. */
const ghost = {
  kind: 'definition',
  path: '/manual/ghost/cmd',
  statement: 'ghost cmd',
  data: { words: ['ghost', 'cmd'], signatures: [] },
  fragments: [{ parser: 'xml@1', selector: 'x/catalog/group[1]' }],
  applicability: null,
};

describe('catalogs limited to one producer (C07, product@1 catalogs[].producer)', () => {
  test('only the named producer gives members; the other producer neither adds members nor withdraws complete', async (t) => {
    // The very entry the command producer gives at /commands/net/ping, from the other producer: one row, both producers.
    const twin = {
      kind: 'definition',
      path: '/commands/net/ping',
      statement: 'net ping <host:string>\n  send echo requests',
      data: { words: ['net', 'ping'], signatures: [{ id: '1', params: [{ name: 'host', type: 'string' }] }], summary: 'send echo requests' },
      fragments: [{ parser: 'xml@1', selector: 'x/catalog/group[2]' }],
      applicability: null,
    };
    const refusedOther = { ...ghost, path: '/manual/bad', fragments: [{ parser: 'xml@1', selector: 'x/catalog/group[9]' }] };
    const unplacedOther = { fragment: { parser: 'xml@1', selector: 'x/catalog/group[2]' }, section: 'net', kind: 'definition', text: 'a span of the other producer that nothing places' };
    const producers = [DEFAULT_PRODUCERS[0], extraProducer('other', { entries: [ghost, twin, refusedOther], unplaced: [unplacedOther] })];
    const w = await world(t, { pack: { declaration: { producers } } });
    const result = await w.knowledge.produceTree({ product: w.product, build });
    assert.equal(result.ok, true, result.reason ?? '');
    assert.equal(result.refusedCount, 1);
    assert.equal(result.unplaced, 1);

    const body = await composition(w, result.composition);
    const ping = body.composition.find((row) => row.path === '/commands/net/ping');
    assert.deepEqual(ping?.producers, ['commands', 'other']);
    assert.equal(ping?.fragments.length, 2, 'the fragments of both producers are kept');
    assert.deepEqual(body.composition.find((row) => row.path === '/manual/ghost/cmd')?.producers, ['other']);
    assert.deepEqual(body.unplaced.map((row) => row.producers), [['other']]);
    assert.deepEqual(
      body.catalogs.map((c) => [c.id, c.producer, c.complete, c.members, c.incomplete_reason]),
      [['catalog@1', 'commands', true, 4, null]],
    );

    const catalog = await w.knowledge.catalog(result.root as string, 'catalog@1');
    assert.ok(catalog !== null);
    assert.equal(catalog.size, 4);
    assert.equal(catalog.complete, true);
    assert.equal(catalog.get(['ghost', 'cmd']), undefined);
    assert.equal(catalog.lookup(['ghost', 'cmd']), undefined);
    assert.equal(catalog.reference, `tree:${result.root}/commands`, 'the view stays on the commands subtree');
  });

  test('a refusal or a lost span of the named producer still withdraws complete', async (t) => {
    const lost = { ...ghost, path: '/commands/lost', fragments: [{ parser: 'xml@1', selector: 'x/catalog/group[9]' }] };
    const w = await world(t, { pack: { declaration: { producers: [{ ...DEFAULT_PRODUCERS[0], params: { extra: [lost] } }] } } });
    const result = await w.knowledge.produceTree({ product: w.product, build });
    assert.equal(result.ok, true, result.reason ?? '');
    const [catalog] = (await composition(w, result.composition)).catalogs;
    assert.equal(catalog.complete, false);
    assert.match(catalog.incomplete_reason ?? '', /1 个条目没有通过核对/);
  });
});

describe('what cannot be stored is refused entry by entry (K02 R[0], R[3])', () => {
  test('a kind outside the entry kinds is refused with the kind as declared; every record written reads back', async (t) => {
    const entries = [
      { ...ghost, kind: 'command' },
      { ...ghost, path: '/manual/long', kind: 'k'.repeat(201) },
    ];
    const unplaced = [{ fragment: { parser: 'xml@1', selector: 'x/catalog/group[2]' }, section: 'net', kind: '', text: 'a span without a kind' }];
    const w = await world(t, { pack: { declaration: { producers: [DEFAULT_PRODUCERS[0], extraProducer('other', { entries, unplaced })] } } });
    const result = await w.knowledge.produceTree({ product: w.product, build });
    assert.equal(result.ok, true, result.reason ?? '');
    assert.deepEqual(
      result.refused.map((r) => [r.producer, r.index, r.unplaced, r.kind.length]),
      [
        ['other', 0, false, 7],
        ['other', 1, false, 200],
        ['other', 0, true, 0],
      ],
    );
    for (const refused of result.refused) assert.match(refused.reason, /不是知识条目种类/);

    // Nodes, entries, the composition and the catalog all read back.
    const root = result.root as string;
    const page = await w.knowledge.getNodes({ root, paths: ['/'], depth: 6 }, w.admin);
    assert.ok(page !== null);
    assert.equal(page.coverage.complete, true);
    assert.ok(page.nodes.every((node) => node.entries.every((entry) => entry.kind === 'definition')));
    assert.ok(await w.knowledge.catalog(root, 'catalog@1'));
    await composition(w, result.composition);
  });

  test('lone surrogates are refused per entry; warnings and refused paths are made storable', async (t) => {
    const lone = '\ud83d';
    const entries = [
      { ...ghost, path: '/manual/cut', statement: `cut ${lone}` },
      { ...ghost, path: `/manual/a${lone}` },
      { ...ghost, path: '/manual/app', applicability: { builds: [`b${lone}`] } },
      { ...ghost, path: '/manual/data', data: { words: ['x'], signatures: [], note: `n${lone}` } },
      { ...ghost, path: '/manual/selector', fragments: [{ parser: 'xml@1', selector: `x/catalog/group${lone}` }] },
    ];
    const unplaced = [{ fragment: { parser: 'xml@1', selector: 'x/catalog/group[2]' }, section: `s${lone}`, kind: 'definition', text: 'a span in a broken section' }];
    const w = await world(t, { pack: { declaration: { producers: [DEFAULT_PRODUCERS[0], extraProducer('other', { entries, unplaced, warnings: [`warning ${lone}`] })] } } });
    const result = await w.knowledge.produceTree({ product: w.product, build });
    assert.equal(result.ok, true, result.reason ?? '');
    assert.equal(result.refusedCount, 6);
    assert.equal(result.entries, 4, 'the four commands');
    const body = await composition(w, result.composition);
    const texts = [...body.warnings, ...body.refused.flatMap((r) => [r.kind, r.path ?? '', r.reason])];
    for (const text of texts) assert.ok(text.isWellFormed(), JSON.stringify(text));
    assert.ok(body.warnings.includes('other：warning �'), JSON.stringify(body.warnings));
    assert.ok(body.refused.some((r) => r.path === '/manual/a�'));
    const page = await w.knowledge.getNodes({ root: result.root as string, paths: ['/'], depth: 6 }, w.admin);
    assert.equal(page?.coverage.complete, true);
  });

  test('a composition the store refuses fails the build and leaves a failed generate action', async (t) => {
    const warnings = Array.from({ length: 200 }, (_, i) => `${i} ${'w'.repeat(2000)}`);
    const w = await world(t, {
      records: { limits: { maxRecordBytes: 64 * 1024 } },
      pack: { declaration: { producers: [DEFAULT_PRODUCERS[0], extraProducer('other', { warnings })] } },
    });
    const result = await w.knowledge.produceTree({ product: w.product, build });
    assert.equal(result.ok, false);
    assert.match(result.reason ?? '', /写入知识树时出错/);
    assert.ok(result.action !== null, 'the failure is recorded');
    const action = await w.kit.store.get<ActionBody>(result.action as string);
    assert.equal(action?.body.action, 'generate');
    assert.equal(action?.body.result, 'error');
    assert.equal(await w.knowledge.rootOfBuild('acme', 'Rel_ACME_1_2_15'), null);
    // Nothing of the failed transaction stays: no composition was written.
    assert.equal((await w.knowledge.store.productions('acme')).filter((p) => p.completed).length, 0);
  });
});

describe('spans and sources', () => {
  test('unplaced spans with equal content keep every fragment in one row', async (t) => {
    const w = await world(t, { pack: { declaration: { producers: [DEFAULT_PRODUCERS[0], MANUAL] } } });
    w.external.set('store:manual:acme-1.2', { bytes: '# Manual\n\n## Notes\n\nSame sentence twice.\n\nSame sentence twice.\n', mediaType: 'text/markdown' });
    const result = await w.knowledge.produceTree({ product: w.product, build });
    assert.equal(result.ok, true, result.reason ?? '');
    const body = await composition(w, result.composition);
    assert.equal(body.unplaced.length, 1);
    assert.equal(body.unplaced[0].fragments.length, 2);
    assert.notEqual(body.unplaced[0].fragments[0], body.unplaced[0].fragments[1]);
    assert.deepEqual(body.unplaced[0].producers, ['manual']);
  });

  test('the sources of one build are capped together (maxBuildBytes)', async (t) => {
    const size = Buffer.byteLength(catalogXml(BASE_CATALOG), 'utf8');
    const manual = '# Manual\n\n## A\n\nA paragraph that is longer than the ten bytes left of the cap.\n';
    const tight = await world(t, { pack: { declaration: { producers: [DEFAULT_PRODUCERS[0], MANUAL] } }, knowledge: { limits: { maxBuildBytes: size + 10 } } });
    tight.external.set('store:manual:acme-1.2', { bytes: manual, mediaType: 'text/markdown' });
    const refused = await tight.knowledge.produceTree({ product: tight.product, build });
    assert.equal(refused.ok, false);
    assert.match(refused.reason ?? '', new RegExp(`超过每个构建 ${size + 10} 字节的上限`));
    assert.ok(refused.action !== null);

    const roomy = await world(t, { pack: { declaration: { producers: [DEFAULT_PRODUCERS[0], MANUAL] } }, knowledge: { limits: { maxBuildBytes: size + Buffer.byteLength(manual) } } });
    roomy.external.set('store:manual:acme-1.2', { bytes: manual, mediaType: 'text/markdown' });
    const produced = await roomy.knowledge.produceTree({ product: roomy.product, build });
    assert.equal(produced.ok, true, produced.reason ?? '');
  });

  test('the record the connector read returned decides the read, not a newer personal-credential record of the same bytes', async (t) => {
    const w = await world(t);
    const first = await w.knowledge.produceTree({ product: w.product, build });
    assert.equal(first.ok, true, first.reason ?? '');
    const shared = (await composition(w, first.composition)).sources[0].artifact;
    // The admin reads the same bytes with a personal credential: a newer record of the bytes only they may read.
    const personal = await w.kit.artifacts.ingest({
      bytes: new TextEncoder().encode(catalogXml(BASE_CATALOG)),
      mediaType: XML,
      origin: { read: { object: TREE } },
      author: { user: null },
      provenanceType: 'observed',
      visibility: { readers: [w.admin.id], admins: false, packs: [], shareable: false },
    });
    assert.notEqual(personal.digest, shared);
    const second = await w.knowledge.produceTree({ product: w.product, build });
    assert.equal(second.ok, true, second.reason ?? '');
    assert.equal((await composition(w, second.composition)).sources[0].artifact, shared);
  });
});
