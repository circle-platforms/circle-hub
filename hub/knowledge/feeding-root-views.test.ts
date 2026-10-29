import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FacetView, IndexView } from '../../contracts/src/views.ts';
import { SeedlingBody } from '../../contracts/src/knowledge.ts';
import type { FeedingOffset } from '../../contracts/src/feeding.ts';
import { runRecord } from '../../contracts/src/fixtures.ts';
import { RunRecord } from '../../contracts/src/run.ts';
import { canonicalBytes, newId, sha256Hex } from '../records/api.ts';
import { resolveReference } from '../refs/api.ts';
import { recordReaderFor, sourceReaderFor } from '../server/readers.ts';
import type { RunsService } from '../ports.ts';
import type { LoadedWorkflow } from '../ports.ts';
import { createEngineContext } from '../runs/engine/deps.ts';
import { buildScope, createResolver } from '../runs/engine/exact.ts';
import { readCaseIndex } from '../../packs/workflow/template-gap/functions/index.ts';
import { isFailure } from '../../packs/workflow/template-gap/functions/common.ts';
import { createKnowledgeReader } from './api.ts';
import { startPostgres } from './test-support.ts';
import { mapBytes, workingPackage, world } from './testing/feeding-bounds-fixture.ts';

async function facets(w: Awaited<ReturnType<typeof world>>) {
  const read = await createKnowledgeReader(w.knowledge).read(
    `knowledge:facets:famx:${w.name}?kind=case&by=line`,
    { principal: w.user, run: null, purpose: 'Synthetic root projection test' },
  );
  assert.ok(read.ok, read.ok ? '' : read.reason);
  const original = read.artifacts.find(item => item.name === 'original');
  assert.ok(original);
  const source = await w.kit.artifacts.source(w.user, original.artifact.body.sha256, { consumer: 'function' });
  assert.ok(source?.bytes);
  return FacetView.parse(JSON.parse(new TextDecoder().decode(source.bytes)));
}

async function readFacets(reader: ReturnType<typeof createKnowledgeReader>, w: Awaited<ReturnType<typeof world>>, user = w.user, feeding_offset?: FeedingOffset) {
  const read = await reader.read(`knowledge:facets:famx:${w.name}?kind=case&by=line`, { principal: user, run: null, purpose: 'Synthetic feeding cache test', ...(feeding_offset?{feeding_offset}:{}) });
  assert.ok(read.ok, read.ok ? '' : read.reason);
  const original = read.artifacts.find(item => item.name === 'original');
  assert.ok(original);
  const source = await w.kit.artifacts.source(user, original.artifact.body.sha256, { consumer: 'function' });
  assert.ok(source?.bytes);
  return { view: FacetView.parse(JSON.parse(new TextDecoder().decode(source.bytes))), revision: read.revision };
}

test('a later rootless read of the same cases does not remove their root-specific facet rows', async t => {
  const pg = await startPostgres();
  t.after(() => pg.stop());
  const w = await world(pg);
  t.after(() => w.close());
  const layer = w.knowledge.feeding!;
  const rooted = await layer.observeSource(w.user, w.document.body.sha256, w.scope);
  assert.equal(rooted.objects.length, 40, JSON.stringify(rooted.pending));
  const before = await facets(w);
  assert.equal(before.total, 40);
  const unrooted = await layer.observeSource(w.user, w.document.body.sha256, { ...w.scope, root: null, composition: null });
  assert.deepEqual(unrooted.objects, rooted.objects);
  const after = await facets(w);
  assert.equal(after.total, 40);
});

test('a source-only projection reports the missing locked tree instead of inventing command coverage', async t => {
  const pg = await startPostgres();
  t.after(() => pg.stop());
  const w = await world(pg);
  t.after(() => w.close());
  const receipt = await w.knowledge.feeding!.observeSource(w.user, w.document.body.sha256, { ...w.scope, root: null, composition: null });
  assert.equal(receipt.objects.length, 40);
  const view = await facets(w);
  assert.equal(view.total, 0);
  assert.equal(view.truncated, true);
  assert.ok(view.notes.some(note => note.includes('缺所查树苗') && note.includes('下一步')));
});

test('a feeding case index cites its stored readable record and uses command paths', async t => {
  const pg = await startPostgres();
  t.after(() => pg.stop());
  const xml = '<commands><menu name="system"><item name="show"><arguments/></item></menu></commands>';
  const w = await world(pg, false, undefined, xml);
  t.after(() => w.close());
  const layer = w.knowledge.feeding!;
  const receipt = await layer.observeSource(w.user, w.document.body.sha256, w.scope);
  assert.equal(receipt.objects.length, 40, JSON.stringify(receipt.pending));
  const external = `knowledge:index:famx:${w.name}?kind=case&key=document&only=SYN-DOC&fields=object,document,node,line,commands,command_identities,command_tree_root,title,path_labels,case_location,source_sha256,unparsed_steps`;
  const read = await createKnowledgeReader(w.knowledge).read(
    external,
    { principal: w.user, run: null, purpose: 'Synthetic feeding index test' },
  );
  assert.ok(read.ok, read.ok ? '' : read.reason);
  const original = read.artifacts.find(item => item.name === 'original');
  assert.ok(original);
  const source = await w.kit.artifacts.source(w.user, original.artifact.body.sha256, { consumer: 'function' });
  assert.ok(source?.bytes);
  const index = IndexView.parse(JSON.parse(new TextDecoder().decode(source.bytes)));
  assert.equal(index.keys['SYN-DOC']?.length, 40);
  const entry = index.entries[index.keys['SYN-DOC'][0]];
  assert.ok(entry.reference.startsWith('rec:'));
  const record = await layer.readRecord(entry.reference.slice(4), w.user);
  assert.ok(record);
  assert.equal(entry.reference, 'rec:' + entry.entry);
  assert.equal((record.body as any).statement.data.feeding.object, entry.data.object);
  const records = recordReaderFor(w.kit, { getRun: async () => null } as unknown as RunsService, w.user, undefined, w.knowledge.layers.contributions);
  const resolved = await resolveReference(entry.reference, { reader: { user: w.user.id, role: w.user.role }, parsers: w.knowledge.__context.parsers, records });
  assert.equal(resolved.resolved, true);
  if (resolved.resolved) assert.equal(resolved.groundable, true);
  assert.deepEqual(entry.data.commands, ['/commands/system/show']);
  assert.equal(entry.data.line, '10.8');
  assert.ok(Array.isArray(entry.data.command_identities));
  assert.ok(Array.from({ length: 40 }, (_, i) => 'Synthetic case ' + i).includes(entry.data.title as string));
  assert.deepEqual(entry.data.path_labels, ['Synthetic zx-u 10.8']);
  assert.equal(typeof entry.data.node, 'string');
  assert.equal(typeof entry.data.case_location, 'string');
  const location = await resolveReference(entry.data.case_location as string, { reader: { user: w.user.id, role: w.user.role }, parsers: w.knowledge.__context.parsers, sources: sourceReaderFor(w.kit, w.user, 'model') });
  assert.ok(location.resolved);
  if (location.resolved) assert.equal(location.text, entry.data.title);
  const consumed = readCaseIndex({ inputs: [{ slot: 'case_index', external, parser: 'json@1', model: index }], context: { root: w.root.root, product: 'famx', build: w.name } }, ['SYN-DOC']);
  assert.ok(consumed && !isFailure(consumed));
  assert.equal(Object.keys(consumed.entries).length, 40);
  const operation = structuredClone(record.body) as any;
  operation.statement.data.key='synthetic-client-observation';
  operation.statement.data.feeding={schema:'fed-observation@1',object:'e'.repeat(64),product:'famx',root:w.root.root,path:'/',source:{system:'upload',bytes:w.document.body.sha256},action:'Synthetic observation',result:{reference:`src:${w.document.body.sha256}/kityminder@1/n/case-0`,text:'Synthetic case 0'}};
  const declaration=await w.kit.store.put({kind:'claim',schema:'claim@1',provenance:'client_captured',body:operation,index:[{key:'knowledge.feeding.key',value:'synthetic-client-observation'}]});
  const frozen = await layer.freeze(w.user, newId('run'), w.root.root);
  const run = RunRecord.parse({ ...runRecord, run: frozen.run, runner: w.user.id, product: 'famx', root: w.root.root, feeding_offset: frozen, items: [], target_basis: [],
    sources: [{ slot: 'case_index', role: 'expected', external, reference: 'src:' + original.artifact.body.sha256, artifact: original.artifact.digest, media_type: 'application/json' }] });
  const workflow = { workflow: { subject: 'documents', product: { catalogs: [] } }, checks: [] } as unknown as LoadedWorkflow;
  const ctx = createEngineContext({ records: w.kit, knowledge: w.knowledge, packs: w.packs, external: w.external, parsers: w.knowledge.__context.parsers } as never);
  const scope = await buildScope(ctx, run, workflow, w.user, 'function');
  const grounded = await createResolver(ctx, scope, 'function').resolve(entry.reference, { grounds: true });
  assert.equal(grounded.ok, true, grounded.ok ? '' : grounded.message);
  if (grounded.ok) assert.equal(grounded.value.role, 'expected');
  const older = RunRecord.parse({ ...run, feeding_offset: { ...frozen, offset: 0 } });
  const olderScope = await buildScope(ctx, older, workflow, w.user, 'function');
  const tooNew = await createResolver(ctx, olderScope, 'function').resolve(entry.reference, { grounds: true });
  assert.equal(tooNew.ok, false);
  if (!tooNew.ok) assert.match(tooNew.message, /冻结/);
  const upload = await w.kit.artifacts.ingest({ bytes: source.bytes, mediaType: 'application/json', origin: { upload: { session: 'synthetic' } }, author: { user: w.user.id }, provenanceType: 'declared', visibility: { readers: [w.user.id], admins: true, packs: [], shareable: false }, readTier: 'model_readable' });
  const forged = RunRecord.parse({ ...run, sources: [{ ...run.sources[0], artifact: upload.digest, reference: 'src:' + upload.body.sha256 }] });
  const forgedScope = await buildScope(ctx, forged, workflow, w.user, 'function');
  const unbound = await createResolver(ctx, forgedScope, 'function').resolve(entry.reference, { grounds: true });
  assert.equal(unbound.ok, false);
  const declarationScope={...scope,records:new Map([...scope.records,[declaration.digest,'expected' as const]]),indexedFeedingRecords:new Set([declaration.digest])};
  const declarationAsGround=await createResolver(ctx,declarationScope,'function').resolve('rec:'+declaration.digest,{grounds:true});
  assert.equal(declarationAsGround.ok,false);
  const wrongRoot = RunRecord.parse({ ...run, root: 'f'.repeat(64), feeding_offset: { ...frozen, root: 'f'.repeat(64) } });
  const wrongScope = await buildScope(ctx, wrongRoot, workflow, w.user, 'function');
  assert.equal((await createResolver(ctx, wrongScope, 'function').resolve(entry.reference, { grounds: true })).ok, false);
  assert.equal(await layer.readRecord(entry.entry, w.outsider), null);
});

test('root projections remain separate across a frozen cut and a later withdrawal', async t => {
  const pg = await startPostgres();
  t.after(() => pg.stop());
  const xmlA = '<commands><menu name="system"><item name="show"><arguments/></item></menu></commands>';
  const xmlB = '<commands><menu name="system"><item name="status"><arguments/></item></menu></commands>';
  const w = await world(pg, false, undefined, xmlA);
  t.after(() => w.close());
  const layer = w.knowledge.feeding!;
  const first = await layer.observeSource(w.user, w.document.body.sha256, w.scope);
  assert.equal(first.objects.length, 40);
  const early = await layer.freeze(w.user, newId('run'), w.root.root);

  w.external.set('site:tree:other', { bytes: xmlB, mediaType: 'application/xml' });
  const build = { name: 'Rel_FAMX-zx-u_10_9_1_1', base: 'Rel_FAMX-zx-u_10_9_1_1', family: 'FAMX', line: '10.9.0', platform: 'zx-u', built_at: null, released_at: null, root: null, sources: { tree: 'site:tree:other' } };
  const produced = await w.knowledge.produceTree({ product: w.product, build, by: w.admin });
  assert.ok(produced.ok, produced.reason ?? '');
  assert.ok(produced.root && produced.composition);
  assert.notEqual(produced.root, w.root.root);
  const composition = await w.knowledge.store.composition(produced.composition);
  assert.ok(composition);
  const original = composition.sources[0];
  const seed = SeedlingBody.parse({ product: 'famx', line: '10.9.0', root: produced.root, composition: produced.composition, build: build.name,
    origin: [{ role: 'command-tree', producer: original.producer, slot: original.slot, external: original.external, sha256: original.sha256, revision: null }], parent: null, basis: 'Synthetic second tree' });
  await w.knowledge.store.putClaim('seedling@1', 'projected', seed, [{ key: 'knowledge.seedling.root', value: 'famx/' + produced.root }]);
  const second = await layer.observeSource(w.user, w.document.body.sha256, { ...w.scope, root: produced.root, composition: produced.composition });
  assert.deepEqual(second.objects, first.objects);
  await layer.observeSource(w.user, w.document.body.sha256, { ...w.scope, root: null, composition: null });
  const beforeWithdrawal = await layer.freeze(w.user, newId('run'), w.root.root);
  const current = await layer.cut('famx', null, w.user);
  assert.equal(current?.casesByRoot?.get(w.root.root)?.size, 40);
  assert.equal(current?.casesByRoot?.get(produced.root)?.size, 40);
  const id = first.objects[0];
  assert.equal(([...current!.casesByRoot!.get(w.root.root)!.get(id)!.values()][0].body.commands as unknown[]).length, 1);
  assert.equal(([...current!.casesByRoot!.get(produced.root)!.get(id)!.values()][0].body.commands as unknown[]).length, 0);
  const earlier = await layer.cut('famx', early.offset, w.user);
  assert.equal(earlier?.casesByRoot?.get(w.root.root)?.size, 40);
  assert.equal(earlier?.casesByRoot?.has(produced.root), false);

  await layer.retract(w.admin, { schema: 'retraction@1', objects: [id], by: w.admin.id, at: new Date().toISOString(), reason: 'Synthetic withdrawal' });
  const withdrawn = await layer.cut('famx', null, w.user);
  assert.equal(withdrawn?.casesByRoot?.get(w.root.root)?.size, 39);
  assert.equal(withdrawn?.casesByRoot?.get(produced.root)?.size, 39);
  assert.equal((await layer.cut('famx', beforeWithdrawal.offset, w.user))?.casesByRoot?.get(produced.root)?.size, 40);
});

test('a bad case selector or title leaves that field unknown without rejecting other cases', async t => {
  const pg = await startPostgres();
  t.after(() => pg.stop());
  const faulty = `import project from './feeding.ts'; export default function(input) { const out = project(input); if(input.parser === 'kityminder@1') { out.rows[0].body.title = 'Synthetic wrong title'; out.rows[1].body.node_selector = 'n/not-present'; } return out; }`;
  const w = await world(pg, false, faulty);
  t.after(() => w.close());
  const layer = w.knowledge.feeding!;
  const receipt = await layer.observeSource(w.user, w.document.body.sha256, w.scope);
  assert.equal(receipt.objects.length, 40);
  assert.equal(receipt.pending.filter(gap => gap.missing.includes('选择器或标题')).length, 2);
  const entries = await layer.entries(w.user, 'famx');
  assert.equal(entries.length, 40);
  for (const id of ['case-0', 'case-1']) {
    const body = entries.find(row => row.body.source.element === id)!.body;
    assert.equal(Object.hasOwn(body, 'node_selector'), false);
    assert.equal(Object.hasOwn(body, 'title'), false);
    assert.equal(Object.hasOwn(body, 'node_key'), false);
  }
  assert.equal(entries.find(row => row.body.source.element === 'case-2')!.body.title, 'Synthetic case 2');
});

test('a mismatched command-tree identity is not published as a known command', async t => {
  const pg = await startPostgres();
  t.after(() => pg.stop());
  const faulty = `import project from './feeding.ts'; export default function(input) { const out = project(input); if(input.tree && out.rows.length) out.rows[0].body.command_tree_root = '${'f'.repeat(64)}'; return out; }`;
  const xml = '<commands><menu name="system"><item name="show"><arguments/></item></menu></commands>';
  const w = await world(pg, false, faulty, xml);
  t.after(() => w.close());
  const layer = w.knowledge.feeding!;
  const receipt = await layer.observeSource(w.user, w.document.body.sha256, w.scope);
  assert.equal(receipt.objects.length, 40);
  const entries = await layer.entries(w.user, 'famx');
  const bad = entries.find(row => row.body.source.element === 'case-0')!.body;
  assert.deepEqual(bad.commands, []);
  assert.equal(bad.command_tree_root, null);
  assert.equal(bad.unparsed_steps, 1);
  assert.ok(receipt.pending.some(gap => gap.missing.includes('命令树') && gap.next_action));
  assert.equal(entries.find(row => row.body.source.element === 'case-1')!.body.commands.length, 1);
});

test('equal case content keeps both document sources in the index but counts once in facets', async t => {
  const pg = await startPostgres();
  t.after(() => pg.stop());
  const xml = '<commands><menu name="system"><item name="show"><arguments/></item></menu></commands>';
  const w = await world(pg, false, undefined, xml);
  t.after(() => w.close());
  const layer = w.knowledge.feeding!;
  async function feed(document: string, folder: string | string[], rooted = true) {
    const raw = JSON.parse(mapBytes.toString());
    raw.agile.id = document;
    const external = 'agile:mindmap:' + document;
    const ingest = (bytes: Uint8Array) => w.kit.artifacts.ingest({ bytes, mediaType: 'application/json', origin: { read: { object: external } }, author: { user: null }, provenanceType: 'observed', visibility: { readers: [w.user.id], admins: true, packs: [], shareable: false }, readTier: 'model_readable' });
    const source = await ingest(Buffer.from(JSON.stringify(raw)));
    const meta = await ingest(Buffer.from(JSON.stringify({ id: document, root: { id: 'SYN-ROOT', title: w.product.product.names[0] }, ancestors: Array.isArray(folder) ? folder : [folder] })));
    return layer.observeSource(w.user, source.body.sha256, { ...w.scope, ...(rooted?{}:{root:null,composition:null}), sourceRecord: source.digest, metaSource: meta.body.sha256 });
  }
  const a = await feed('SYN-A', 'rel_famx_10_8');
  const pendingB = await feed('SYN-B', 'rel_famx_10_8', false);
  assert.deepEqual(a.objects, pendingB.objects);
  const partial = await facets(w);
  assert.equal(partial.total, 40);
  assert.equal(partial.truncated, true);
  assert.ok(partial.notes.some(note => note.includes('缺所查树苗') && note.includes('下一步')));
  const partialIndexRead = await createKnowledgeReader(w.knowledge).read(`knowledge:index:famx:${w.name}?kind=case&key=document&only=SYN-B`, { principal: w.user, run: null, purpose: 'Synthetic missing source projection' });
  assert.ok(partialIndexRead.ok, partialIndexRead.ok ? '' : partialIndexRead.reason);
  const partialOriginal=partialIndexRead.artifacts.find(item=>item.name==='original');assert.ok(partialOriginal);
  const partialSource=await w.kit.artifacts.source(w.user,partialOriginal.artifact.body.sha256,{consumer:'function'});assert.ok(partialSource?.bytes);
  const partialIndex=IndexView.parse(JSON.parse(new TextDecoder().decode(partialSource.bytes)));
  assert.equal(partialIndex.truncated,true);assert.ok(partialIndex.notes.some(note=>note.includes('缺所查树苗')&&note.includes('下一步')));
  const b = await feed('SYN-B', 'rel_famx_10_8');
  assert.deepEqual(a.objects, b.objects);
  const complete = await facets(w);
  assert.equal(complete.total, 40);
  assert.equal(complete.truncated, false);
  const external = `knowledge:index:famx:${w.name}?kind=case&key=document&only=SYN-A,SYN-B&fields=object,document,node,commands,command_identities,command_tree_root,title,path_labels`;
  const read = await createKnowledgeReader(w.knowledge).read(external, { principal: w.user, run: null, purpose: 'Synthetic multi-source case index' });
  assert.ok(read.ok, read.ok ? '' : read.reason);
  const original = read.artifacts.find(item => item.name === 'original');
  assert.ok(original);
  const source = await w.kit.artifacts.source(w.user, original.artifact.body.sha256, { consumer: 'function' });
  assert.ok(source?.bytes);
  const index = IndexView.parse(JSON.parse(new TextDecoder().decode(source.bytes)));
  assert.equal(index.keys['SYN-A']?.length, 40);
  assert.equal(index.keys['SYN-B']?.length, 40);
  assert.equal(Object.keys(index.entries).length, 80);
  assert.equal(new Set(Object.values(index.entries).map(entry => entry.data.object)).size, 40);
  for (const entry of Object.values(index.entries)) assert.equal(entry.reference, 'rec:' + entry.entry);
  const consumed = readCaseIndex({ inputs: [{ slot: 'case_index', external, parser: 'json@1', model: index }], context: { root: w.root.root, product: 'famx', build: w.name } }, ['SYN-A', 'SYN-B']);
  assert.ok(consumed && !isFailure(consumed));

  await feed('SYN-D', ['rel_famx_10_8', 'rel_famy_10_9']);
  async function documentIndex(document: string) {
    const read = await createKnowledgeReader(w.knowledge).read(`knowledge:index:famx:${w.name}?kind=case&key=document&only=${document}`, { principal: w.user, run: null, purpose: 'Synthetic document binding conflict' });
    assert.ok(read.ok, read.ok ? '' : read.reason);
    const original = read.artifacts.find(item => item.name === 'original');
    assert.ok(original);
    const source = await w.kit.artifacts.source(w.user, original.artifact.body.sha256, { consumer: 'function' });
    assert.ok(source?.bytes);
    return IndexView.parse(JSON.parse(new TextDecoder().decode(source.bytes)));
  }
  const conflictedDocument = await documentIndex('SYN-D');
  assert.equal(conflictedDocument.truncated, true);
  assert.ok(conflictedDocument.notes.some(note => note.includes('版本层有冲突') && note.includes('下一步')));
  const unrelatedDocument = await documentIndex('SYN-A');
  assert.equal(unrelatedDocument.truncated, false);
  assert.equal(unrelatedDocument.keys['SYN-A']?.length, 40);

  await feed('SYN-C', 'rel_famy_10_9');
  const conflicting = await facets(w);
  assert.equal(conflicting.total, 0);
  assert.equal(conflicting.truncated, true);
  assert.ok(conflicting.notes.some(note => note.includes('多个来源') && note.includes('下一步')));
});

test('a reprojected legacy source gains node fields without duplicating its case index entries', async t => {
  const pg = await startPostgres();
  t.after(() => pg.stop());
  const old = `import project from './feeding.ts'; export default function(input) { const out = project(input); for(const row of out.rows) for(const field of ['title','path_labels','node_selector','node_parser','node_key','command_tree_root','has_expected']) delete row.body[field]; return out; }`;
  const xml = '<commands><menu name="system"><item name="show"><arguments/></item></menu></commands>';
  const w = await world(pg, false, old, xml);
  t.after(() => w.close());
  const layer = w.knowledge.feeding!;
  const first = await layer.observeSource(w.user, w.document.body.sha256, w.scope);
  assert.equal(first.objects.length, 40);
  const legacy = await createKnowledgeReader(w.knowledge).read(`knowledge:facets:famx:${w.name}?kind=case&by=has_expected`, { principal: w.user, run: null, purpose: 'Synthetic missing expectation state' });
  assert.ok(legacy.ok, legacy.ok ? '' : legacy.reason);
  const legacyOriginal=legacy.artifacts.find(item=>item.name==='original');assert.ok(legacyOriginal);
  const legacySource=await w.kit.artifacts.source(w.user,legacyOriginal.artifact.body.sha256,{consumer:'function'});assert.ok(legacySource?.bytes);
  const legacyView=FacetView.parse(JSON.parse(new TextDecoder().decode(legacySource.bytes)));
  assert.equal(legacyView.total,0);assert.equal(legacyView.truncated,true);assert.ok(legacyView.notes.some(note=>note.includes('缺期望节点')&&note.includes('下一步')));
  await workingPackage(w);
  const second = await layer.observeSource(w.user, w.document.body.sha256, w.scope);
  assert.deepEqual(second.objects, first.objects);
  const cut = await layer.cut('famx', null, w.user);
  for (const sources of cut!.casesByRoot!.get(w.root.root)!.values()) assert.equal(sources.size, 1);
  const external = `knowledge:index:famx:${w.name}?kind=case&key=document&only=SYN-DOC`;
  const read = await createKnowledgeReader(w.knowledge).read(external, { principal: w.user, run: null, purpose: 'Synthetic legacy reproject' });
  assert.ok(read.ok, read.ok ? '' : read.reason);
  const original = read.artifacts.find(item => item.name === 'original');
  assert.ok(original);
  const source = await w.kit.artifacts.source(w.user, original.artifact.body.sha256, { consumer: 'function' });
  assert.ok(source?.bytes);
  const index = IndexView.parse(JSON.parse(new TextDecoder().decode(source.bytes)));
  assert.equal(index.keys['SYN-DOC']?.length, 40);
  assert.ok(Object.values(index.entries).every(entry => typeof entry.data.title === 'string'));
});

test('a shared reader refreshes a live feeding view and never shares private cases between users', async t => {
  const pg = await startPostgres();
  t.after(() => pg.stop());
  const w = await world(pg);
  t.after(() => w.close());
  w.packs.readers.set(w.outsider.id, new Set(['famx']));
  const reader = createKnowledgeReader(w.knowledge);
  const before = await readFacets(reader, w);
  assert.equal(before.view.total, 0);
  const projected = await w.knowledge.feeding!.observeSource(w.user, w.document.body.sha256, w.scope);
  assert.equal(projected.objects.length, 40);
  const own = await readFacets(reader, w);
  assert.equal(own.view.total, 40);
  const other = await readFacets(reader, w, w.outsider);
  assert.equal(other.view.total, 0);
  assert.notEqual(own.revision, before.revision);
  const id = `knowledge:facets:famx:${w.name}?kind=case&by=line`;
  const stale = await reader.read(`${id}@${before.revision}`, { principal: w.user, run: null, purpose: 'Synthetic stale revision' });
  assert.equal(stale.ok, false);
  const pinned = await reader.read(`${id}@${own.revision}`, { principal: w.user, run: null, purpose: 'Synthetic current revision' });
  assert.equal(pinned.ok, true);
  const frozen = await w.knowledge.feeding!.freeze(w.user, newId('run'), w.root.root);
  const frozenBefore = await readFacets(reader, w, w.user, frozen);
  assert.equal(frozenBefore.view.total, 40);
  await w.knowledge.feeding!.retract(w.admin, { schema: 'retraction@1', objects: [projected.objects[0]], by: w.admin.id, at: new Date().toISOString(), reason: 'Synthetic retraction' });
  const after = await readFacets(reader, w);
  assert.equal(after.view.total, 39);
  assert.notEqual(after.revision, own.revision);
  const frozenAfter = await readFacets(reader, w, w.user, frozen);
  assert.equal(frozenAfter.view.total, 40);
  assert.equal(frozenAfter.revision, frozenBefore.revision);
});

test('indexing many feeding references does not read each record until it is used', async t => {
  const pg = await startPostgres();
  t.after(() => pg.stop());
  const w = await world(pg);
  t.after(() => w.close());
  const ids=Array.from({length:5000},(_,i)=>sha256Hex('synthetic feeding record '+i));
  const entries=Object.fromEntries(ids.map(id=>[id,{entry:id,kind:'case',statement:'',data:{object:sha256Hex('synthetic object '+id)},reference:'rec:'+id}]));
  const model={schema:'index-view@1',product:'famx',build:{build:w.name,root:w.root.root},kind:'case',key:'document',keys:{'SYN-DOC':ids},entries,only:['SYN-DOC'],cut_keys:[],total_keys:1,total_entries:ids.length,truncated:false,skipped:0,notes:[]};
  const artifact=await w.kit.artifacts.ingest({bytes:canonicalBytes(model),mediaType:'application/json',origin:{generated:{generator:'knowledge.views@1',inputs:[]}},author:{user:null},provenanceType:'projected',visibility:{readers:[w.user.id],admins:true,packs:[],shareable:false},readTier:'model_readable'});
  const frozen=await w.knowledge.feeding!.freeze(w.user,newId('run'),w.root.root);
  const external=`knowledge:index:famx:${w.name}?kind=case&key=document&only=SYN-DOC`;
  const run=RunRecord.parse({...runRecord,run:frozen.run,runner:w.user.id,product:'famx',root:w.root.root,feeding_offset:frozen,items:[],target_basis:[],sources:[{slot:'case_index',role:'expected',external,reference:'src:'+artifact.body.sha256,artifact:artifact.digest,media_type:'application/json'}]});
  const workflow={workflow:{subject:'documents',product:{catalogs:[]}},checks:[]} as unknown as LoadedWorkflow;
  const ctx=createEngineContext({records:w.kit,knowledge:w.knowledge,packs:w.packs,external:w.external,parsers:w.knowledge.__context.parsers} as never);
  let reads=0;const get=w.kit.store.get.bind(w.kit.store);
  t.mock.method(w.kit.store,'get',async(...args:Parameters<typeof get>)=>{reads++;return get(...args);});
  const scope=await buildScope(ctx,run,workflow,w.user,'function');
  assert.equal(scope.indexedFeedingRecords?.size,5000);
  assert.ok(reads<20,`record reads during scope construction: ${reads}`);
  assert.equal((await createResolver(ctx,scope,'function').resolve('rec:'+ids[0],{grounds:true})).ok,false);
});
