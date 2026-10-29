import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StartRunInput } from '../../../contracts/src/tools.ts';
import type { KnownBuild } from '../../../contracts/src/product.ts';
import type { LoadedWorkflow, ProductHandle, RootInfo } from '../../ports.ts';
import type { Principal } from '../../records/api.ts';
import type { EngineContext } from './deps.ts';
import { resolveTarget } from './target.ts';
import { startPostgres } from '../../testing/postgres.ts';
import { openHarness } from './testing/harness.ts';
import { standardDocument, toyMap } from './testing/mindmap.ts';
import { INDEX } from './store.ts';
import { RunRecord } from '../../../contracts/src/run.ts';
import { ROOTS } from './testing/knowledge.ts';

const root = 'a'.repeat(64), composition = 'b'.repeat(64), packDigest = 'c'.repeat(64), productDigest = 'd'.repeat(64);
const product = { id: 'meridian', version: '1.0.0', digest: productDigest, kind: 'product', directory: '/synthetic',
  product: { schema: 'product@1', id: 'meridian', title: 'Meridian', names: ['Meridian'], catalogs: [], producers: [] } } as ProductHandle;
const workflow = { pack: { id: 'synthetic', digest: packDigest }, workflow: { product: { id: 'meridian', catalogs: [] } } } as unknown as LoadedWorkflow;
const user = { id: 'usr_00000000000000000000000000', role: 'user' } as Principal;
const builds: KnownBuild[] = Array.from({ length: 3574 }, (_, i) => ({
  name: `Rel_MERIDIAN_${i}`, family: 'Meridian', line: `10.${8 + i % 14}`, base: `Rel_MERIDIAN_${i}`,
  platform: 'zx-u', built_at: null, released_at: new Date(Date.UTC(2026, 9, 1) + i * 1000).toISOString(), root: null, sources: {},
}));

function harness() {
  const counts = { builds: 0, seedlings: new Map<string, number>(), seeds: new Map<string, number>() };
  const info = (line: string, build = builds.find(row => row.line === line)!): RootInfo => ({ root, composition, product: 'meridian', build, produced_at: '2026-10-01T00:00:00.000Z' });
  const knowledge = {
    async builds(_product: string, filter?: { line?: string; released?: boolean }) {
      counts.builds++;
      return builds.filter(build => (filter?.line === undefined || build.line === filter.line) && (filter?.released === undefined || (build.released_at !== null) === filter.released));
    },
    async seedlingRoot(_product: string, line: string) {
      counts.seedlings.set(line, (counts.seedlings.get(line) ?? 0) + 1);
      return line === '10.21' ? null : info(line);
    },
    feeding: { async seedFor(_product: string, line: string) {
      counts.seeds.set(line, (counts.seeds.get(line) ?? 0) + 1);
      return { root: line === '10.8' || line === '10.9' ? root : 'e'.repeat(64) };
    } },
    async rootForRead(_product: string, query: { line: string; build: string }) { return { info: info(query.line, builds.find(b => b.name === query.build)!), source: 'seedling', sync: null }; },
    async unversionedRoot() { return null; },
  };
  const packs = { async readableProducts() { return new Set(['meridian']); }, async productByName() { return product; }, async productById() { return product; }, async products() { return [product]; } };
  const ctx = { deps: { packs, knowledge }, log() {} } as unknown as EngineContext;
  return { ctx, counts };
}

test('automatic target selection consults each exact version line once for thousands of builds', async () => {
  const { ctx, counts } = harness();
  const target = await resolveTarget(ctx, user, workflow, StartRunInput.parse({ pack: 'synthetic', product: 'Meridian', inputs: {} }), '2026-10-28T00:00:00.000Z', 'synthetic');
  const expected = [...builds].reverse().find(b => b.line !== '10.21')!;
  assert.equal(target.buildName, expected.name);
  assert.equal(target.root?.root, root);
  assert.equal(counts.builds, 1);
  assert.equal(counts.seedlings.size, 14);
  assert.ok([...counts.seedlings.values()].every(n => n === 1), `repeated seedling reads: ${Math.max(...counts.seedlings.values())}`);
});

test('a declared version compares each distinct seedling once while preserving shared-root candidates', async () => {
  const { ctx, counts } = harness();
  const target = await resolveTarget(ctx, user, workflow, StartRunInput.parse({ pack: 'synthetic', product: 'Meridian', version: '10.8', inputs: {} }), '2026-10-28T00:00:00.000Z', 'synthetic');
  const expected = [...builds].reverse().find(b => b.line === '10.8' || b.line === '10.9')!;
  assert.equal(target.buildName, expected.name);
  assert.ok([...counts.seeds.values()].every(n => n === 1), `repeated line bindings: ${Math.max(...counts.seeds.values())}`);
  assert.ok([...counts.seedlings.values()].every(n => n === 1));
});

test('an undeclared seedling falls back to exact line equality', async t => {
  const { ctx, counts } = harness();
  t.mock.method(ctx.deps.knowledge.feeding!, 'seedFor', async (_product: string, line: string) => {
    counts.seeds.set(line, (counts.seeds.get(line) ?? 0) + 1);
    return null;
  });
  const target = await resolveTarget(ctx, user, workflow, StartRunInput.parse({ pack: 'synthetic', product: 'Meridian', version: '10.8', inputs: {} }), '2026-10-28T00:00:00.000Z', 'synthetic');
  assert.equal(target.buildName, [...builds].reverse().find(b => b.line === '10.8')!.name);
  assert.ok([...counts.seeds.values()].every(n => n === 1));
});

test('a missing seedling preserves the refusal and its exact version options', async t => {
  const { ctx, counts } = harness();
  const knowledge = ctx.deps.knowledge as unknown as { seedlingRoot(product: string, line: string): Promise<RootInfo | null> };
  t.mock.method(knowledge, 'seedlingRoot', async () => null);
  await assert.rejects(resolveTarget(ctx, user, workflow, StartRunInput.parse({ pack: 'synthetic', product: 'Meridian', version: '10.8', inputs: {} }), '2026-10-28T00:00:00.000Z', 'synthetic'), (error: any) => {
    assert.equal(error.errors[0].code, 'REFERENCE_UNRESOLVED');
    assert.equal(error.errors[0].path, '/version');
    assert.deepEqual(error.errors[0].options, builds.filter(b => b.line === '10.8').slice(0, 20).map(b => b.name));
    return true;
  });
  assert.equal(counts.builds, 1);
});

test('start_run reuses the build list selected by the target resolver', async t => {
  const pg = await startPostgres();
  const h = await openHarness(pg);
  t.after(async () => { await h.close(); await pg.stop(); });
  const map = await h.upload(h.alice, toyMap(standardDocument()));
  h.review.workflow.context = ['builds'];
  let calls = 0;
  const original = h.knowledge.builds.bind(h.knowledge);
  t.mock.method(h.knowledge, 'builds', async (...args: Parameters<typeof original>) => { calls++; return original(...args); });
  const result = await h.service.startRun(h.alice, { pack: 'toy-review', product: 'Grove', inputs: { map: { reference: map } } }, h.call());
  assert.equal(result.call_result, 'ok', JSON.stringify(result.errors));
  assert.equal(result.run?.build, 'Rel_GROVE_1_0_4');
  assert.equal(calls, 1);
  const stored = await h.kit.store.find({ key: INDEX.runId, value: result.run!.run, kind: 'run' });
  const record = RunRecord.parse(stored.items[0].body);
  assert.deepEqual(record.builds?.map(b => b.name), ['Rel_GROVE_1_0_2', 'Rel_GROVE_1_0_4', 'Rel_GROVE_1_0_5']);
  calls = 0;
  const alias = await h.service.startRun(h.alice, { pack: 'toy-review', product: 'Meadow', build: 'rel_pasture_3_2_9', inputs: { map: { reference: map } } }, h.call());
  assert.equal(alias.call_result, 'ok', JSON.stringify(alias.errors));
  assert.equal(alias.run?.build, 'rel_pasture_3_2_9');
  assert.equal(alias.run?.root, ROOTS.meadow329);
  assert.equal(calls, 1);
  const aliasStored = await h.kit.store.find({ key: INDEX.runId, value: alias.run!.run, kind: 'run' });
  assert.equal(RunRecord.parse(aliasStored.items[0].body).builds?.length, 5);
});
