// The layers beside the tree (K03): their write and read API works on synthetic data, observations are append only and
// readable with the product, candidates are the owner's alone and grounded in a verified quotation, a changed cited fragment
// is shown, and neither layer ever changes a root digest.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { KnownBuild } from '../../contracts/src/product.ts';
import type { TemporaryPostgres } from '../testing/postgres.ts';
import { KnowledgeError } from './errors.ts';
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

async function produced(t: { after: (fn: () => Promise<void>) => void }): Promise<World & { root: string }> {
  const w = await makeWorld(postgres);
  t.after(() => w.close());
  w.external.set('site:tree:Rel_ACME_1_2_15', { bytes: catalogXml(BASE_CATALOG), mediaType: 'application/xml' });
  const result = await w.knowledge.produceTree({ product: w.product, build: build('Rel_ACME_1_2_15') });
  assert.equal(result.ok, true, result.reason ?? '');
  return Object.assign(w, { root: result.root as string });
}

async function excerpt(w: World, owner: string, text: string, admins = false) {
  return w.kit.artifacts.ingest({
    bytes: new TextEncoder().encode(text),
    mediaType: 'text/plain',
    origin: { upload: { session: 'session-1', message: 'message-1' } },
    author: { user: owner },
    provenanceType: 'declared',
    visibility: { readers: [owner], admins, packs: [], shareable: admins },
  });
}

describe('observation layer', () => {
  test('append only, readable with the product, never in a root digest', async (t) => {
    const w = await produced(t);
    const echo = await w.kit.artifacts.ingest({
      bytes: new TextEncoder().encode('unit> show\nstate: up\n'),
      mediaType: 'text/plain',
      origin: { read: { object: 'bed:echo:1' } },
      author: { user: null },
      provenanceType: 'observed',
      visibility: { readers: [], admins: true, packs: [], shareable: false },
    });
    const observation = { product: 'acme', build: 'Rel_ACME_1_2_15', device: 'unit-1', collected_at: '2026-02-01T08:00:00.000Z', echo: echo.body.sha256, declared_by: 'review@1.0.0' };
    const digest = await w.knowledge.layers.observations.append(observation);
    assert.match(digest, /^[0-9a-f]{64}$/);
    const page = await w.knowledge.layers.observations.list('acme', w.user);
    assert.deepEqual(page?.items.map(({ record: _record, ...rest }) => rest), [observation]);
    assert.equal(await w.knowledge.layers.observations.list('acme', w.outsider), null);
    await assert.rejects(w.knowledge.layers.observations.append({ ...observation, echo: 'a'.repeat(64) }), /回显源文件不在 Hub 里/);
    await assert.rejects(w.knowledge.layers.observations.append({ ...observation, run: 'run_x' } as typeof observation), KnowledgeError);
    // Producing again gives the same root: the layer is not part of the tree.
    const again = await w.knowledge.produceTree({ product: w.product, build: build('Rel_ACME_1_2_15') });
    assert.equal(again.root, w.root);
  });
});

describe('candidate layer', () => {
  test("only the owner's verified candidates: quotation checked, grounds private to the owner, nobody else sees them", async (t) => {
    const w = await produced(t);
    const own = await excerpt(w, w.user.id, 'In the session we saw that system show needs no argument.');
    const input = {
      root: w.root,
      path: '/commands/system/show',
      statement: 'system show 不带参数',
      ground: { reference: `src:${own.body.sha256}`, quote: 'system show needs no argument' },
    };
    const digest = await w.knowledge.layers.candidates.add(w.user, input);
    assert.match(digest, /^[0-9a-f]{64}$/);
    const mine = await w.knowledge.layers.candidates.list(w.user);
    assert.equal(mine.length, 1);
    assert.equal(mine[0].candidate.path, '/commands/system/show');
    assert.equal(mine[0].status, 'valid');
    assert.deepEqual(await w.knowledge.layers.candidates.list(w.admin), [], 'admins do not see other people’s candidates');
    await assert.rejects(w.knowledge.layers.candidates.add(w.user, { ...input, ground: { ...input.ground, quote: 'system show needs two arguments' } }), (e: unknown) => e instanceof KnowledgeError && e.code === 'QUOTE_MISMATCH');
    const shared = await excerpt(w, w.user.id, 'An excerpt the admins may read.', true);
    await assert.rejects(w.knowledge.layers.candidates.add(w.user, { ...input, ground: { reference: `src:${shared.body.sha256}`, quote: 'An excerpt' } }), /只对你可见/);
    await assert.rejects(w.knowledge.layers.candidates.add(w.outsider, input), (e: unknown) => e instanceof KnowledgeError && e.code === 'SOURCE_UNAVAILABLE');
    // The candidate never changes the tree.
    const again = await w.knowledge.produceTree({ product: w.product, build: build('Rel_ACME_1_2_15') });
    assert.equal(again.root, w.root);
  });

  test('a reader whose root has other text at the path sees 被引片段已变 (K03 R[5])', async (t) => {
    const w = await produced(t);
    w.external.set('site:tree:Rel_ACME_1_2_16', {
      bytes: catalogXml({ ...BASE_CATALOG, system: [BASE_CATALOG.system[0], { name: 'show', params: [], help: 'show the full state' }] }),
      mediaType: 'application/xml',
    });
    const next = await w.knowledge.produceTree({ product: w.product, build: build('Rel_ACME_1_2_16') });
    const own = await excerpt(w, w.user.id, 'system show prints the state.');
    await w.knowledge.layers.candidates.add(w.user, { root: w.root, path: '/commands/system/show', statement: 'show 打印状态', ground: { reference: `src:${own.body.sha256}`, quote: 'prints the state' } });
    const [same] = await w.knowledge.layers.candidates.list(w.user, w.root);
    assert.equal(same.status, 'valid');
    const [changed] = await w.knowledge.layers.candidates.list(w.user, next.root as string);
    assert.equal(changed.status, 'cited_fragment_changed');
    assert.equal(changed.note, `被引片段已变（根 ${w.root.slice(0, 12)} → ${(next.root as string).slice(0, 12)}）`);
    // A path whose text did not change stays valid against the newer root.
    await w.knowledge.layers.candidates.add(w.user, { root: w.root, path: '/commands/net/ping', statement: 'ping 发回显请求', ground: { reference: `src:${own.body.sha256}`, quote: 'system show' } });
    const views = await w.knowledge.layers.candidates.list(w.user, next.root as string);
    assert.deepEqual(views.map((v) => [v.candidate.path, v.status]), [
      ['/commands/system/show', 'cited_fragment_changed'],
      ['/commands/net/ping', 'valid'],
    ]);
  });
});
