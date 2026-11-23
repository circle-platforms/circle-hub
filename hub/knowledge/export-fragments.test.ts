import {createTestParserRegistry as createDefaultRegistry} from '../testing/parsers.ts';
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { KnownBuild } from '../../contracts/src/product.ts';
import { resolveReference } from '../refs/api.ts';
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

async function produced(t: { after: (fn: () => Promise<void>) => void }): Promise<World & { root: string }> {
  const w = await makeWorld(postgres, {});
  t.after(() => w.close());
  w.external.set('site:tree:Rel_ACME_1_2_15', { bytes: catalogXml(BASE_CATALOG), mediaType: 'application/xml' });
  const result = await w.knowledge.produceTree({ product: w.product, build: build('Rel_ACME_1_2_15') });
  assert.equal(result.ok, true, result.reason ?? '');
  return Object.assign(w, { root: result.root as string });
}

describe('the batch export of a locked root', () => {
  test('each entry carries the source fragments a reference read gives as grounds; get_nodes does not carry them', async (t) => {
    const w = await produced(t);
    const batch = await w.knowledge.subtree!({ root: w.root, composition: null }, w.user);
    assert.ok(batch && batch.length > 0);
    const ctx = { reader: { user: w.user.id, role: w.user.role }, parsers: createDefaultRegistry(), trees: w.knowledge.treeReader() };
    let checked = 0;
    for (const node of batch) for (const entry of node.entries) {
      const resolved = await resolveReference(entry.reference, ctx);
      assert.equal(resolved.resolved, true, entry.reference);
      if (!resolved.resolved) continue;
      assert.ok(resolved.grounds.length > 0, 'a produced entry has source fragments');
      assert.deepEqual((entry as { fragments?: string[] }).fragments, resolved.grounds, `${node.path}: the export lists what the reference read lists`);
      checked++;
    }
    assert.ok(checked > 0);
    const page = await w.knowledge.getNodes({ root: w.root, paths: ['/commands/net/ping'], depth: 0 }, w.user);
    assert.ok(page?.nodes[0]?.entries.length);
    for (const entry of page!.nodes[0].entries) assert.equal('fragments' in entry, false, 'the public node view is unchanged');
  });
});
