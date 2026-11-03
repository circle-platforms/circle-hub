// A build's fed fixed-bug records (fed-build@1 with fixed_bugs) reach the kind=defect index of its seedling root, under the
// rules the views apply to fed cases: the frozen cut, exact root and build, root-less records as unknown entries, the latest
// bytes of a page, retractions. The core reads only the model's fields; the synthetic product pack declares the projection.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SeedlingBody } from '../../contracts/src/knowledge.ts';
import { IndexView } from '../../contracts/src/views.ts';
import type { FeedingOffset } from '../../contracts/src/feeding.ts';
import { newId } from '../records/api.ts';
import { createKnowledgeReader } from './api.ts';
import { seedlingName } from './seedling.ts';
import { catalogXml, DEFAULT_PRODUCERS, DEFAULT_SYNC, makeWorld, startPostgres, STATIC_PLAN_SOURCE, type World } from './test-support.ts';

const BUILD = 'Synthetic_zx-u_10_8_1';
const OTHER = 'Synthetic_zx-u_10_8_2';
const TREE = 'site:tree:10_8';
// One fed-build@1 row per listed identity of a synthetic page {build, bugs}: the shape the product pack's projection declares.
const PROJECT = `export default function project(input){if(input.source.system!=='site'||input.source.type!=='page')return {rows:[]};const m=input.model;const content={name:m.build,family:'ACME',line:'10.8',platform:'zx-u'};return {rows:m.bugs.map(bug=>({body:{schema:'fed-build@1',product:input.product,root:input.root,path:null,source:{system:'build-site',page:input.source.key,bytes:input.source.bytes},...content,built_at:null,released_at:null,tree:null,fixed_bugs:bug===null?[]:[bug]},identity:content,lines:['10.8'],selector:'p',grammar:'synthetic-fixed@1',conflict:false}))};}`;

function build(name: string) {
  return { name, base: name, family: 'ACME', line: '10.8', platform: 'zx-u', built_at: '2026-10-01T00:00:00.000Z', released_at: '2026-10-02T00:00:00.000Z', sources: { tree: TREE } };
}

async function world(pg: Awaited<ReturnType<typeof startPostgres>>): Promise<World & { seedling: { root: string; composition: string } }> {
  const w = await makeWorld(pg, { pack: { functions: { 'plan.ts': STATIC_PLAN_SOURCE, 'feeding.ts': PROJECT }, declaration: { producers: DEFAULT_PRODUCERS, sync: { ...DEFAULT_SYNC, options: { builds: [build(BUILD), build(OTHER)] } }, feeding: { project: { module: 'functions/feeding.ts' } } } } });
  w.external.set(TREE, { bytes: catalogXml({ system: [{ name: 'show', params: [] }] }), mediaType: 'application/xml' });
  await w.knowledge.syncProduct(w.product, { by: w.admin });
  const root = await w.knowledge.rootOfBuild(w.product.id, BUILD);
  assert.ok(root);
  const composition = await w.knowledge.store.composition(root.composition);
  assert.ok(composition);
  const original = composition.sources[0];
  const body = SeedlingBody.parse({ product: w.product.id, line: '10.8', root: root.root, composition: root.composition, build: BUILD, origin: [{ role: 'command-tree', producer: original.producer, slot: original.slot, external: original.external, sha256: original.sha256, revision: null }], parent: null, basis: 'synthetic seed' });
  const rec = await w.knowledge.store.putClaim('seedling@1', 'projected', body, [{ key: 'knowledge.seedling.root', value: w.product.id + '/' + root.root }, { key: 'knowledge.seedling', value: w.product.id + '/10.8' }]);
  await w.kit.pointers.move({ name: seedlingName(w.product.id, '10.8'), expected: null, next: rec.digest, by: w.admin, run: null, component: 'synthetic.feeding@1' });
  const seedling = await w.knowledge.seedlingRoot!(w.product.id, '10.8');
  assert.ok(seedling);
  return { ...w, seedling: { root: seedling.root, composition: seedling.composition } };
}

/** Reads a synthetic page as a connector would (an observed original of `site:page:<key>`) and feeds it. */
async function feed(w: Awaited<ReturnType<typeof world>>, key: string, page: { build: string; bugs: Array<string | null> }, root: string | null) {
  const artifact = await w.kit.artifacts.ingest({ bytes: Buffer.from(JSON.stringify(page)), mediaType: 'application/json', origin: { read: { object: 'site:page:' + key } }, author: { user: null }, provenanceType: 'observed', visibility: { readers: [w.user.id], admins: true, packs: [], shareable: false }, readTier: 'model_readable' });
  const receipt = await w.knowledge.feeding!.observeSource(w.user, artifact.body.sha256, { product: w.product.id, root, composition: root === null ? null : w.seedling.composition, line: '10.8' });
  assert.deepEqual(receipt.pending, [], JSON.stringify(receipt.pending));
  return receipt;
}

async function index(w: World, id: string, feeding_offset?: FeedingOffset): Promise<IndexView> {
  const read = await createKnowledgeReader(w.knowledge).read(id, { principal: w.user, run: null, purpose: 'synthetic defect index', ...(feeding_offset ? { feeding_offset } : {}) });
  assert.ok(read.ok, read.ok ? '' : read.reason);
  const original = read.artifacts.find((item) => item.name === 'original');
  assert.ok(original);
  const source = await w.kit.artifacts.source(w.user, original.artifact.body.sha256, { consumer: 'function' });
  assert.ok(source?.bytes);
  return IndexView.parse(JSON.parse(new TextDecoder().decode(source.bytes)));
}

test('the defect index of a seedling build lists its fed fixed-bug records, one cited record per defect, never a status', async (t) => {
  const pg = await startPostgres();
  t.after(() => pg.stop());
  const w = await world(pg);
  t.after(() => w.close());
  const DEFECTS = `knowledge:index:${w.product.id}:${BUILD}?kind=defect&key=bug`;
  const empty = await index(w, DEFECTS);
  assert.deepEqual([empty.total_keys, empty.truncated], [0, false]);
  assert.ok(empty.notes.some((note) => note.includes('还没有被用到过') && note.includes('source-read') && note.includes(`build ${BUILD}`) && note.includes('product')), empty.notes.join('；'));
  const frozen = await w.knowledge.feeding!.freeze(w.user, newId('run'), w.seedling.root);

  await feed(w, 'fixed-1', { build: BUILD, bugs: ['plm:bug:900301', 'plm:bug:900302', 'bugzilla:bug:4401', 'SYN-7'] }, w.seedling.root);
  await feed(w, 'fixed-other', { build: OTHER, bugs: ['plm:bug:900999'] }, w.seedling.root);
  await feed(w, 'fixed-none', { build: BUILD, bugs: [null] }, w.seedling.root);
  const view = await index(w, DEFECTS);
  assert.deepEqual(Object.keys(view.keys).sort(), ['4401', '900301', '900302', 'SYN-7'], 'the other build and the record without identities give no key');
  assert.deepEqual([view.total_keys, view.total_entries, view.truncated, view.unknown_entries], [4, 4, false, undefined]);
  const bySystem = Object.values(view.entries).map((entry) => [entry.data.bug, entry.data.system ?? null]).sort();
  assert.deepEqual(bySystem, [['4401', 'bugzilla'], ['900301', 'plm'], ['900302', 'plm'], ['SYN-7', null]]);
  const objects = new Set<unknown>();
  for (const [digest, entry] of Object.entries(view.entries)) {
    assert.equal(entry.kind, 'defect');
    assert.equal(entry.reference, `rec:${digest}`, 'each defect cites its own feeding record');
    assert.deepEqual([entry.data.status, entry.data.declaration_status, entry.data.build, entry.data.line], [null, 'undeclared', BUILD, '10.8']);
    const record = await w.knowledge.feeding!.readRecord(digest, w.user);
    assert.ok(record, 'the cited record is readable by the reader');
    assert.equal((record.body as { statement: { data: { feeding: { schema: string } } } }).statement.data.feeding.schema, 'fed-build@1');
    objects.add(entry.data.object);
  }
  assert.equal(objects.size, 1, 'the records of one build share its content identity');
  assert.ok(view.notes.some((note) => note.includes('喂入索引列出 4 条来源记录、1 个内容身份')), view.notes.join('；'));
  assert.equal((await index(w, `knowledge:index:${w.product.id}:${OTHER}?kind=defect&key=bug`)).total_keys, 1);
  // The run's frozen offset was taken before any page was read: the cut holds none of them.
  assert.equal((await index(w, DEFECTS, frozen)).total_keys, 0);
  // `only` keeps the selected numbers; the view revision follows the layer.
  assert.deepEqual(Object.keys((await index(w, `${DEFECTS}&only=900302&fields=bug`)).keys), ['900302']);

  // A retracted record leaves the index.
  const retracted = Object.entries(view.entries).find(([, entry]) => entry.data.bug === 'SYN-7')![0];
  await w.knowledge.feeding!.retract(w.admin, { schema: 'retraction@1', entries: [retracted], by: w.admin.id, at: new Date().toISOString(), reason: '合成撤回' });
  assert.deepEqual(Object.keys((await index(w, DEFECTS)).keys).sort(), ['4401', '900301', '900302']);

  // A changed page: the latest bytes of that page decide its list.
  await feed(w, 'fixed-1', { build: BUILD, bugs: ['plm:bug:900301', 'plm:bug:900303'] }, w.seedling.root);
  assert.deepEqual(Object.keys((await index(w, DEFECTS)).keys).sort(), ['900301', '900303']);
});

test('a fixed-bug page fed without the seedling is an unknown entry of the index, until it is read under the root', async (t) => {
  const pg = await startPostgres();
  t.after(() => pg.stop());
  const w = await world(pg);
  t.after(() => w.close());
  const DEFECTS = `knowledge:index:${w.product.id}:${BUILD}?kind=defect&key=bug`;
  await feed(w, 'fixed-2', { build: BUILD, bugs: ['plm:bug:900401', 'plm:bug:900402'] }, null);
  const unrooted = await index(w, DEFECTS);
  assert.deepEqual([unrooted.total_keys, unrooted.truncated, unrooted.unknown_entries, unrooted.unknown_only], [0, true, 2, true]);
  assert.ok(unrooted.notes.some((note) => note.includes('2 个缺陷缺所查树苗的投影')), unrooted.notes.join('；'));
  assert.ok(!unrooted.notes.some((note) => note.includes('还没有被用到过')), 'the empty-layer note does not deny the unrooted records');
  assert.equal((await index(w, `${DEFECTS}&only=900401`)).unknown_entries, 1, 'only the selected numbers count');
  await feed(w, 'fixed-2', { build: BUILD, bugs: ['plm:bug:900401', 'plm:bug:900402'] }, w.seedling.root);
  const rooted = await index(w, DEFECTS);
  assert.deepEqual([Object.keys(rooted.keys).sort(), rooted.truncated, rooted.unknown_entries], [['900401', '900402'], false, undefined]);
});
