import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SeedlingBody } from '../../contracts/src/knowledge.ts';
import { StartRunInput } from '../../contracts/src/tools.ts';
import { FacetView, IndexView, LinksView } from '../../contracts/src/views.ts';
import type { LoadedWorkflow } from '../ports.ts';
import { canonicalBytes, sha256Hex } from '../records/api.ts';
import { resolveTarget } from '../runs/engine/target.ts';
import type { EngineContext } from '../runs/engine/deps.ts';
import { projectItems } from '../../packs/workflow/quality-board/functions/project.ts';
import { createKnowledgeReader } from './api.ts';
import { seedlingName } from './seedling.ts';
import { catalogXml, DEFAULT_PRODUCERS, DEFAULT_SYNC, makeWorld, startPostgres, STATIC_PLAN_SOURCE, type World } from './test-support.ts';

const DUAL = 'Synthetic_zx-u_10_8_1';
const ONLY = 'Synthetic_zx-u_10_5_1';
const SYNC = 'Synthetic_zx-u_9_1_1';
const TREE = 'site:tree:10_8';
const PROJECT = `export default function project(input:any){if(input.source.system!=='agile'||input.model.kind!=='case')return {rows:[]};const identity={case:'synthetic-1',line:'10.8'};return {rows:[{body:{schema:'fed-case@1',product:input.product,root:input.root,path:null,source:{system:'agile',document:'synthetic-document',element:'case-1',revision:null,bytes:input.source.bytes},autoid:null,priority:1,resources:[],steps:[{text:'合成步骤'}],expects:[{text:'合成期望'}],commands:[],unparsed_steps:0,document_lines:['10.8']},identity,lines:['10.8'],selector:'p',grammar:'synthetic-case@1',conflict:false}]};}`;

function build(name: string, line: string, tree: string, released: string | null) {
  return { name, base: name, family: 'ACME', line, platform: 'zx-u', built_at: '2026-10-01T00:00:00.000Z', released_at: released, sources: { tree } };
}

async function world(pg: Awaited<ReturnType<typeof startPostgres>>): Promise<World> {
  const builds = [
    build(DUAL, '10.8', TREE, '2026-10-02T00:00:00.000Z'),
    build(ONLY, '10.5', 'site:tree:10_5', null),
    build(SYNC, '9.1', 'site:tree:9_1', '2026-09-02T00:00:00.000Z'),
  ];
  const w = await makeWorld(pg, { pack: { functions: { 'plan.ts': STATIC_PLAN_SOURCE, 'feeding.ts': PROJECT }, declaration: { producers: DEFAULT_PRODUCERS, sync: { ...DEFAULT_SYNC, options: { builds } }, feeding: { project: { module: 'functions/feeding.ts' } } } } });
  w.external.set(TREE, { bytes: catalogXml({ system: [{ name: 'show', params: [] }] }), mediaType: 'application/xml' });
  w.external.set('site:tree:10_5', { bytes: catalogXml({ system: [{ name: 'show', params: [] }] }), mediaType: 'application/xml' });
  w.external.set('site:tree:9_1', { bytes: catalogXml({ system: [{ name: 'show', params: [] }] }), mediaType: 'application/xml' });
  return w;
}

async function seed(w: World, line: string, root: { root: string; composition: string; build: { name: string } | null }) {
  const composition = await w.knowledge.store.composition(root.composition);
  assert.ok(composition);
  const original = composition.sources[0];
  const body = SeedlingBody.parse({ product: w.product.id, line, root: root.root, composition: root.composition, build: root.build!.name, origin: [{ role: 'command-tree', producer: original.producer, slot: original.slot, external: original.external, sha256: original.sha256, revision: null }], parent: null, basis: 'synthetic test seed' });
  const rec = await w.knowledge.store.putClaim('seedling@1', 'projected', body, [{ key: 'knowledge.seedling.root', value: w.product.id + '/' + root.root }, { key: 'knowledge.seedling', value: w.product.id + '/' + line }]);
  await w.kit.pointers.move({ name: seedlingName(w.product.id, line), expected: null, next: rec.digest, by: w.admin, run: null, component: 'synthetic.feeding@1' });
}

async function viewOf(w: World, id: string): Promise<unknown> {
  const read = await createKnowledgeReader(w.knowledge).read(id, { principal: w.user, run: null, purpose: '树苗根视图' });
  assert.equal(read.ok, true, read.ok ? '' : read.reason);
  if (!read.ok) throw new Error('not ok');
  const original = read.artifacts.find((item) => item.name === 'original');
  assert.ok(original);
  const source = await w.kit.artifacts.source(w.user, original.artifact.body.sha256, { consumer: 'function' });
  assert.ok(source?.bytes);
  return JSON.parse(new TextDecoder().decode(source.bytes));
}

test('runs and views read the seedling root, and a fed case reaches the quality board', async (t) => {
  const pg = await startPostgres();
  t.after(() => pg.stop());
  const w = await world(pg);
  t.after(() => w.close());
  await w.knowledge.syncProduct(w.product, { by: w.admin });
  const first = await w.knowledge.rootOfBuild(w.product.id, DUAL);
  assert.ok(first);
  assert.equal(await w.knowledge.rootOfBuild(w.product.id, ONLY), null);
  await seed(w, '10.8', first);
  await seed(w, '10.5', first);
  w.external.set(TREE, { bytes: catalogXml({ system: [{ name: 'show', params: [] }, { name: 'reboot', params: [] }] }), mediaType: 'application/xml' });
  await w.knowledge.syncProduct(w.product, { by: w.admin, recheck: true });
  const syncRoot = await w.knowledge.rootOfBuild(w.product.id, DUAL);
  const seedling = await w.knowledge.seedlingRoot!(w.product.id, '10.8');
  assert.ok(syncRoot && seedling);
  assert.notEqual(seedling.root, syncRoot.root);
  const source = await w.kit.artifacts.ingest({ bytes: Buffer.from(JSON.stringify({ kind: 'case', id: 'SYN-1' })), mediaType: 'application/json', origin: { read: { object: 'agile:case:SYN-1' } }, author: { user: null }, provenanceType: 'observed', visibility: { readers: [w.user.id], admins: true, packs: [], shareable: false }, readTier: 'model_readable' });
  const receipt = await w.knowledge.feeding!.observeSource(w.user, source.body.sha256, { product: w.product.id, root: seedling.root, composition: seedling.composition, line: '10.8' });
  assert.equal(receipt.objects.length, 1, JSON.stringify(receipt.pending));

  const note = `读的是树苗根（${seedling.root.slice(0, 12)}）；同一构建另有同步根（${syncRoot.root.slice(0, 12)}）`;
  const facets = FacetView.parse(await viewOf(w, `knowledge:facets:acme:${DUAL}?kind=case&by=line,module,has_expected,negative,test_type_status`));
  assert.equal(facets.build.root, seedling.root);
  assert.equal(facets.total, 1);
  assert.ok(facets.notes.includes(note), facets.notes.join('\n'));
  const indexed = IndexView.parse(await viewOf(w, `knowledge:index:acme:${DUAL}?kind=case&key=line`));
  assert.equal(indexed.build.root, seedling.root);
  assert.equal(indexed.keys['10.8']?.length, 1);
  assert.ok(indexed.notes.includes(note), indexed.notes.join('\n'));
  const links = LinksView.parse(await viewOf(w, `knowledge:links:acme:${DUAL}`));
  assert.ok(links.notes.includes(note), links.notes.join('\n'));

  const onlyFacets = FacetView.parse(await viewOf(w, `knowledge:facets:acme:${ONLY}?kind=case&by=line`));
  const onlyIndex = IndexView.parse(await viewOf(w, `knowledge:index:acme:${ONLY}?kind=case&key=line`));
  const onlyLinks = LinksView.parse(await viewOf(w, `knowledge:links:acme:${ONLY}`));
  const lineLinks = LinksView.parse(await viewOf(w, 'knowledge:links:acme:10.5'));
  for (const seen of [onlyFacets, onlyIndex, onlyLinks, lineLinks]) assert.equal(seen.notes.some((row) => row.includes('没有已生产的组成')), false);
  assert.equal(onlyFacets.build.root, seedling.root);
  assert.equal(onlyFacets.total, 1);
  assert.equal(onlyIndex.build.root, seedling.root);
  assert.equal(onlyLinks.notes.some((row) => row.includes('同步根')), false);

  const syncOnly = FacetView.parse(await viewOf(w, `knowledge:facets:acme:${SYNC}?kind=case&by=line`));
  const syncRootOnly = await w.knowledge.rootOfBuild(w.product.id, SYNC);
  assert.ok(syncRootOnly);
  assert.equal(syncOnly.build.root, syncRootOnly.root);
  assert.equal((await w.knowledge.lockRoot(w.product.id, { build: SYNC }))?.root, syncRootOnly.root);
  assert.equal(syncOnly.total, 0);
  assert.ok(syncOnly.notes.some((row) => row.includes('根里没有')));
  assert.equal(syncOnly.notes.some((row) => row.includes('树苗根')), false);

  const workflow = { pack: w.product, workflow: { product: { id: w.product.id, catalogs: [] } } } as unknown as LoadedWorkflow;
  const ctx = { deps: { packs: w.packs, knowledge: w.knowledge, external: w.external }, log() {} } as unknown as EngineContext;
  const locked = await resolveTarget(ctx, w.user, workflow, StartRunInput.parse({ pack: 'synthetic@1', product: 'ACME', build: DUAL, inputs: {} }), '2026-10-27T00:00:00.000Z', 'trace');
  assert.equal(locked.root?.root, facets.build.root);
  assert.ok(facets.scope?.roots.some((row) => row.root === locked.root?.root));
  const lockedOnly = await resolveTarget(ctx, w.user, workflow, StartRunInput.parse({ pack: 'synthetic@1', product: 'ACME', build: ONLY, inputs: {} }), '2026-10-27T00:00:00.000Z', 'trace');
  assert.equal(lockedOnly.root?.root, onlyFacets.build.root);
  assert.equal((await w.knowledge.lockRoot(w.product.id, { build: DUAL }))?.root, facets.build.root);

  const placement = FacetView.parse(await viewOf(w, `knowledge:facets:acme:${DUAL}?kind=case&by=commands`));
  const bound = (slot: string, model: unknown) => ({ slot, model, sha256: sha256Hex(canonicalBytes(model)) });
  const projected = projectItems({ inputs: [bound('facets', facets), bound('placement', placement)], parameters: {}, context: { product: w.product.id } });
  if ('error' in projected) assert.fail(projected.error.message);
  assert.ok(projected.items.length > 0);
  assert.ok(projected.items.some((item) => ((item.fields as { counts?: { cases?: number } }).counts?.cases ?? 0) > 0));
});
