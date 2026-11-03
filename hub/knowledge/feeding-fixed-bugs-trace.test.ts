// End to end, synthetic: a build's fixed-bug page read through the Hub with the product known (the generic read pack with
// product and build) enters the feeding layer as one fed-build@1 record per defect, the build's kind=defect index lists them,
// and traceability's start_run, which refused before the read with the one step that works, accepts and computes the matrix:
// cases joined where fed cases carry the number, unknown where none does, the release status undeclared throughout.
// The real FAMX feeding projection, source-read and traceability packs; synthetic page, case map and ids only.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { SeedlingBody } from '../../contracts/src/knowledge.ts';
import { IndexView } from '../../contracts/src/views.ts';
import type { ValidationResult, ItemResult } from '../../contracts/src/validation.ts';
import type { ExternalReaderPort } from '../ports.ts';
import { osIsolationAvailable } from '../rules/api.ts';
import { createRunsService } from '../runs/api.ts';
import { FakeWorkflowStore } from '../runs/engine/testing/workflows.ts';
import { createTestParserRegistry } from '../testing/parsers.ts';
import { createKnowledgeReader, routeKnowledgeViews } from './api.ts';
import { seedlingName } from './seedling.ts';
import { catalogXml, COMMANDS_SOURCE, DEFAULT_SYNC, makeWorld, startPostgres, STATIC_PLAN_SOURCE } from './test-support.ts';

const skip = (await osIsolationAvailable()) ? false : 'no OS network isolation on this machine (sandbox-exec)';
const FAMX = new URL('../../packs/product/famx/', import.meta.url);
const BUILD = 'Rel_FAMX_10_6_1_57';
const PAGE = `buildsite:file:/builds/Bugs_Fixed_with_DemoOS_${BUILD}.html`;
const DEFECTS = `knowledge:index:FAMX:${BUILD}?kind=defect&key=bug`;
const CASES = `knowledge:index:FAMX:${BUILD}?kind=case&key=defects`;
const plm = (id: string) => `<a href="https://tracker.example.invalid/index.php?m=bug&f=view&t=html&id=${id}">${id}</a><br />`;
const PAGE_BYTES = Buffer.from(`<HTML><HEAD><TITLE>Bugs fixed with ${BUILD}</TITLE></HEAD><BODY>${plm('900301')}${plm('900302')}${plm('900305')}<a href="https://bugs.example.invalid/show_bug.cgi?id=4401">4401</a><br /></BODY></HTML>`, 'latin1');
const caseNode = (id: string, title: string) => ({ data: { id, text: title, priority: 2, resource: ['functional'] }, children: [{ data: { id: id + '-step', text: 'show health' }, children: [{ data: { id: id + '-expect', text: 'Synthetic expected ' + id } }] }] });
const MAP = Buffer.from(JSON.stringify({ agile: { id: 'SYN-TRACE' }, root: { data: { id: 'root', text: 'Synthetic regression 10.6.1' }, children: [caseNode('case-1', 'bug:900301'), caseNode('case-2', 'bug:900302,900309'), caseNode('case-3', 'Synthetic case without ids')] } }));

const located = (result: ValidationResult, id: string): ItemResult => {
  for (const items of Object.values(result.partitions)) { const item = (items as ItemResult[]).find((row) => row.item === id); if (item) return item; }
  throw new Error(`item ${id} is in no partition`);
};

test('a product-bound read of a fixed-bug page feeds the defect index, and traceability computes its matrix', { skip }, async (t) => {
  const pg = await startPostgres();
  t.after(() => pg.stop());
  const manifest = JSON.parse(readFileSync(new URL('pack.json', FAMX), 'utf8')) as { files: Array<{ path: string }> };
  const functions: Record<string, string> = Object.fromEntries(manifest.files.filter((file) => file.path.startsWith('functions/')).map((file) => [file.path.slice(10), readFileSync(new URL(file.path, FAMX), 'utf8')]));
  functions['synthetic-tree.ts'] = COMMANDS_SOURCE;
  functions['synthetic-plan.ts'] = STATIC_PLAN_SOURCE;
  const w = await makeWorld(pg, { pack: { id: 'famx', names: ['FAMX', 'FAMY'], functions, declaration: {
    sync: { ...DEFAULT_SYNC, plan: { module: 'functions/synthetic-plan.ts' }, options: { builds: [{ name: BUILD, base: BUILD, family: 'FAMX', line: '10.6.1', platform: null, built_at: '2026-09-20T10:00:00.000Z', released_at: '2026-09-21T00:00:00.000Z', sources: { tree: 'site:tree:synthetic' } }] } },
    catalogs: [], producers: [{ id: 'tree', title: 'Synthetic tree', function: { module: 'functions/synthetic-tree.ts' }, inputs: { tree: { source: 'tree' } } }],
    feeding: { project: { module: 'functions/feeding.ts' }, normalize_line: { module: 'functions/feeding.ts', export: 'normalizeLine' } },
  } } });
  const layer = w.knowledge.feeding!;
  t.after(async () => { await layer.drain(); await w.close(); });
  // The line's seedling: the manual and command tree only (owner rule 2026-10-24); everything else is fed on use.
  w.external.set('site:tree:synthetic', { bytes: catalogXml({ show: [{ name: 'health', params: [] }] }), mediaType: 'application/xml' });
  await w.knowledge.syncProduct(w.product, { by: w.admin });
  const root = await w.knowledge.rootOfBuild('famx', BUILD);
  assert.ok(root);
  const original = (await w.knowledge.store.composition(root.composition))!.sources[0];
  const seed = SeedlingBody.parse({ product: 'famx', line: '10.6.1', root: root.root, composition: root.composition, build: BUILD, origin: [{ role: 'command-tree', producer: original.producer, slot: original.slot, external: original.external, sha256: original.sha256, revision: null }], parent: null, basis: 'synthetic seed' });
  const seeded = await w.knowledge.store.putClaim('seedling@1', 'projected', seed, [{ key: 'knowledge.seedling', value: 'famx/10.6.1' }, { key: 'knowledge.seedling.root', value: 'famx/' + root.root }]);
  await w.kit.pointers.move({ name: seedlingName('famx', '10.6.1'), expected: null, next: seeded.digest, by: w.admin, run: null, component: 'synthetic.feeding@1' });
  const seedling = (await w.knowledge.seedlingRoot!('famx', '10.6.1'))!;
  // Earlier use fed the cases of one regression map under the seedling; two carry fixed numbers, one carries none.
  const ingest = (bytes: Uint8Array, object: string, mediaType = 'application/json') => w.kit.artifacts.ingest({ bytes, mediaType, origin: { read: { object } }, author: { user: null }, provenanceType: 'observed', visibility: { readers: [w.user.id], admins: true, packs: [], shareable: false }, readTier: 'model_readable' });
  const map = await ingest(MAP, 'agile:mindmap:SYN-TRACE');
  const meta = await ingest(Buffer.from(JSON.stringify({ id: 'SYN-TRACE', title: 'Synthetic regression', ancestors: ['rel_famx_10_6_1'], root: { id: 'synthetic-root', title: 'FAMX' } })), 'agile:mindmap:SYN-TRACE');
  const cases = await layer.observeSource(w.user, map.body.sha256, { product: 'famx', root: seedling.root, composition: seedling.composition, sourceRecord: map.digest, metaSource: meta.body.sha256 });
  assert.equal(cases.objects.length, 3, JSON.stringify(cases.pending));

  // The connectors' part: the build site serves the page; PLM is not configured here (its statuses stay unknown).
  const site: ExternalReaderPort = {
    accepts: async (id) => id === PAGE || id.startsWith('plm:bugs:'),
    read: async (id) => {
      if (id !== PAGE) return { ok: false, id, reason: 'synthetic PLM is not configured' };
      return { ok: true, id, revision: null, manifest: 'synthetic', artifacts: [{ name: 'original', artifact: await ingest(PAGE_BYTES, id, 'text/html; charset=ISO-8859-1') }] };
    },
  };
  const workflows = new FakeWorkflowStore(w.admin.id);
  for (const pack of ['source-read', 'traceability']) { await workflows.add(fileURLToPath(new URL(`../../packs/workflow/${pack}/`, import.meta.url))); workflows.assign(w.user.id, pack); }
  const service = createRunsService({ records: w.kit, packs: w.packs, knowledge: w.knowledge, external: routeKnowledgeViews(createKnowledgeReader(w.knowledge), site), workflows, parsers: createTestParserRegistry() });
  let trace = 0x4730;
  const call = () => ({ traceId: `4bf92f3577b34da6a3ce929d0e0e${(trace++).toString(16)}`, sessionId: 'synthetic-trace' });
  const traceability = () => service.startRunDetailed(w.user, { pack: 'traceability', inputs: { defects: { external: DEFECTS }, cases: { external: CASES } } }, call());

  // Before the read: the refusal names the one step that works, with this view's product and build.
  const refused = await traceability();
  assert.equal(refused.answer.call_result, 'error');
  const empty = refused.answer.errors.find((error) => error.message.includes('缺陷索引没有编号'));
  assert.ok(empty, JSON.stringify(refused.answer.errors));
  assert.match(empty.fix ?? '', /pack 写 source-read，顶层同时写 product FAMX 和 build Rel_FAMX_10_6_1_57/);

  // The step: the generic read pack with product and build reads the page under that build's seedling.
  const read = await service.startRunDetailed(w.user, { pack: 'source-read', product: 'FAMX', build: BUILD, inputs: { build_page: { external: PAGE } } }, call());
  assert.equal(read.answer.call_result, 'ok', JSON.stringify(read.answer.errors));
  assert.deepEqual([read.answer.run!.product, read.answer.run!.build, read.answer.run!.root], ['famx', BUILD, seedling.root]);
  await layer.drain();
  assert.deepEqual(await layer.pending(w.user, read.answer.run!.run), []);

  const defects = await createKnowledgeReader(w.knowledge).read(DEFECTS, { principal: w.user, run: null, purpose: 'synthetic defect index' });
  assert.ok(defects.ok, defects.ok ? '' : defects.reason);
  const bytes = (await w.kit.artifacts.source(w.user, defects.artifacts.find((item) => item.name === 'original')!.artifact.body.sha256, { consumer: 'function' }))!.bytes!;
  const view = IndexView.parse(JSON.parse(new TextDecoder().decode(bytes)));
  assert.deepEqual(Object.keys(view.keys), ['4401', '900301', '900302', '900305']);
  assert.deepEqual(Object.values(view.entries).map((entry) => [entry.data.bug, entry.data.system, entry.data.declaration_status, entry.reference.slice(0, 4)]).sort(), [['4401', 'bugzilla', 'undeclared', 'rec:'], ['900301', 'plm', 'undeclared', 'rec:'], ['900302', 'plm', 'undeclared', 'rec:'], ['900305', 'plm', 'undeclared', 'rec:']]);

  // Traceability now accepts and computes the matrix at start_run.
  const started = await traceability();
  assert.equal(started.answer.call_result, 'ok', JSON.stringify(started.answer.errors));
  const run = started.answer.run!;
  assert.ok(run.sources.some((source) => source.slot === 'cases' && source.external?.includes('only=4401,900301,900302,900305')), JSON.stringify(run.sources.map((source) => source.external)));
  assert.deepEqual(run.items.map((item) => [item.id, item.summary]), [
    ['bugzilla:4401', '状态未知；无已索引用例（未知）'],
    ['plm:900301', '状态未知；1 个用例'],
    ['plm:900302', '状态未知；1 个用例'],
    ['plm:900305', '状态未知；无已索引用例（未知）'],
  ]);
  const result = started.production!.result;
  const EXPECTED: Record<string, string[]> = { 'bugzilla:4401': [], 'plm:900301': ['bug:900301'], 'plm:900302': ['bug:900302,900309'], 'plm:900305': [] };
  for (const [id, titles] of Object.entries(EXPECTED)) {
    const [requirement] = located(result, id).requirements;
    const [claim] = requirement.claims;
    // The release status of a fixed-bug page is undeclared: every defect stays unknown and names the missing fact.
    assert.equal(claim.statement.verdict, 'unknown', id);
    assert.deepEqual((claim.statement.data as { cases: Array<{ title: string }> }).cases.map((c) => c.title), titles, id);
    assert.ok(claim.grounds.some((ground) => ground.startsWith('rec:')), 'grounded on the fed record of the defect');
  }
  const counts = result.cross_item.find((claim) => claim.requirement === 'counts')!;
  const data = counts.statement.data as Record<string, number>;
  assert.deepEqual([data.defects, data.traced, data.untraced, data.release_status_undeclared, data.status_unread], [4, 2, 2, 4, 1]);
});
