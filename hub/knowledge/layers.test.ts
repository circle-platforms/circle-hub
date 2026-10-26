// The layers beside the tree (K03): their write and read API works on synthetic data, observations are append only and
// readable with the product, and they never change a root digest. Contributions are covered by the run tests.
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
