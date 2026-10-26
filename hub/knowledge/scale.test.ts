// A reduced scale run in the suite (the full measurement, 3,000 documents of 60 cases, is in the package README): 300
// synthetic mind maps of 20 cases each filed under 400 commands. The first build is produced in parts and bounded chunks;
// the second build (40 commands changed) reuses every stored document, runs its batches (the build is part of what the
// list producer receives) and shares the case parts; the impact view equals a command-level diff computed from the
// corpus itself, and its placements are exactly the cases on the changed commands; facets and index count what the corpus
// says.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { FacetView, ImpactView, IndexView } from '../../contracts/src/views.ts';
import { TreeRootBody } from '../../contracts/src/knowledge.ts';
import type { KnownBuild } from '../../contracts/src/product.ts';
import type { TemporaryPostgres } from '../testing/postgres.ts';
import { createKnowledgeReader } from './api.ts';
import { SCHEMAS } from './store.ts';
import { DEFAULT_PRODUCERS, casesProducer, makeWorld, startPostgres, syntheticCorpus, type World } from './test-support.ts';

let postgres: TemporaryPostgres;
before(async () => {
  postgres = await startPostgres();
});
after(() => postgres?.stop());

const build = (name: string, cases: string[]): KnownBuild => ({
  name,
  family: 'ACME',
  line: '1.2',
  base: name,
  platform: null,
  built_at: '2026-01-02T10:00:00.000Z',
  released_at: '2026-01-05T00:00:00.000Z',
  sources: { tree: `site:tree:${name}`, cases },
  root: null,
});

async function partRecords(w: World, schema: string): Promise<number> {
  let n = 0;
  let cursor: string | null = null;
  do {
    const page: { items: Array<{ schema: string }>; next: string | null } = await w.kit.store.list({ kind: 'tree_root', limit: 500, cursor });
    n += page.items.filter((r) => r.schema === schema).length;
    cursor = page.next;
  } while (cursor !== null);
  return n;
}

describe('scale (reduced: 300 documents)', () => {
  test('two builds of 6,000 cases: parts, reuse of loads and batches, shared case parts, views equal to the corpus truth', { timeout: 600_000 }, async (t) => {
    const corpus = syntheticCorpus({ documents: 300, cases: 20, groups: 8, commands: 50, changed: 40 });
    const w = await makeWorld(postgres, { pack: { declaration: { producers: [DEFAULT_PRODUCERS[0], casesProducer()] } } });
    t.after(() => w.close());
    w.external.set('site:tree:Rel_ACME_1_2_15', { bytes: corpus.catalogA, mediaType: 'application/xml' });
    w.external.set('site:tree:Rel_ACME_1_2_16', { bytes: corpus.catalogB, mediaType: 'application/xml' });
    for (const doc of corpus.documents) w.external.set(doc.id, { bytes: doc.json, mediaType: 'application/json' });
    const ids = corpus.documents.map((d) => d.id);
    const time = async <T>(what: string, fn: () => Promise<T>): Promise<T> => {
      const started = performance.now();
      const value = await fn();
      t.diagnostic(`${what}: ${((performance.now() - started) / 1000).toFixed(1)} s, rss ${(process.memoryUsage().rss / 2 ** 20).toFixed(0)} MiB`);
      return value;
    };

    const a = await time('first build', () => w.knowledge.produceTree({ product: w.product, build: build('Rel_ACME_1_2_15', ids) }));
    assert.equal(a.ok, true, a.reason ?? '');
    assert.equal(a.entries, 6000 + 400);
    assert.equal(a.skippedCount, 0);
    assert.deepEqual(a.calls, { made: 1 + 6, reused: 0 });
    assert.deepEqual(a.loads, { reused: 0, read: 300 });
    const bodyA = TreeRootBody.parse((await w.kit.store.get(a.composition as string))?.body);
    assert.ok(bodyA.parts !== undefined, 'the composition is in parts');
    assert.deepEqual(bodyA.composition, []);
    assert.ok(bodyA.parts.composition.length >= 3);
    assert.ok(Buffer.byteLength(JSON.stringify(bodyA), 'utf8') < 512 * 1024, 'the composition record stays small');
    const caseParts = bodyA.parts.composition.filter((p) => p.kind === 'case').map((p) => p.record);
    const rowsBefore = await partRecords(w, SCHEMAS.rowsPart);

    const b = await time('second build', () => w.knowledge.produceTree({ product: w.product, build: build('Rel_ACME_1_2_16', ids) }));
    assert.equal(b.ok, true, b.reason ?? '');
    assert.deepEqual(b.loads, { reused: 300, read: 0 }, 'no document is read again');
    assert.deepEqual(b.calls, { made: 7, reused: 0 }, 'another build is another input of the list producer: its batches run again');
    const bodyB = TreeRootBody.parse((await w.kit.store.get(b.composition as string))?.body);
    assert.deepEqual(bodyB.parts?.composition.filter((p) => p.kind === 'case').map((p) => p.record), caseParts, 'the case parts are shared');
    const definitionParts = bodyB.parts?.composition.filter((p) => p.kind === 'definition').length ?? 0;
    assert.equal(await partRecords(w, SCHEMAS.rowsPart), rowsBefore + definitionParts, 'only definition parts are new');
    assert.ok(b.created < a.created, 'unchanged subtrees are shared');

    const reader = createKnowledgeReader(w.knowledge);
    const read = async (id: string): Promise<unknown> => {
      const answer = await time(id.split('?')[0], () => reader.read(id, { principal: w.user, run: null, purpose: '规模测试' }));
      assert.equal(answer.ok, true, answer.ok ? '' : answer.reason);
      if (!answer.ok) return null;
      const source = await w.kit.artifacts.source(w.user, answer.artifacts[0].artifact.body.sha256, { consumer: 'function' });
      return JSON.parse(new TextDecoder().decode(source?.bytes ?? new Uint8Array()));
    };
    const impact = ImpactView.parse(await read('knowledge:impact:acme:Rel_ACME_1_2_15..Rel_ACME_1_2_16'));
    assert.deepEqual(impact.changes.map((c) => c.path), corpus.changedPaths, 'the command-level diff of the corpus');
    assert.ok(impact.changes.every((c) => c.change === 'modified'));
    const statements = new Map(Object.entries(impact.entries).map(([digest, e]) => [digest, e]));
    const placed = impact.placements.flatMap((p) => p.to.map((d) => `${p.path} ${String(statements.get(d)?.data.case)}`)).sort();
    const changed = new Set(corpus.changedPaths);
    const expected = corpus.cases.filter((c) => changed.has(c.path)).map((c) => `${c.path} ${c.id}`).sort();
    assert.deepEqual(placed, expected, 'the regression scope is exactly the cases on the changed commands');
    assert.deepEqual(impact.totals, { changed_paths: 40, attached_from: expected.length, attached_to: expected.length });

    const facets = FacetView.parse(await read('knowledge:facets:acme:Rel_ACME_1_2_16?kind=case&by=module'));
    assert.deepEqual(facets.rows, Array.from({ length: 10 }, (_, m) => ({ values: { module: `M${m}` }, count: 600 })));
    const index = IndexView.parse(await read('knowledge:index:acme:Rel_ACME_1_2_16?kind=case&key=defects'));
    const truth = new Map<string, number>();
    for (const c of corpus.cases) for (const d of c.defects) truth.set(d, (truth.get(d) ?? 0) + 1);
    assert.equal(index.total_keys, truth.size);
    assert.deepEqual(Object.fromEntries(Object.entries(index.keys).map(([k, v]) => [k, v.length])), Object.fromEntries([...truth].sort(([x], [y]) => (x < y ? -1 : 1))));
  });
});
