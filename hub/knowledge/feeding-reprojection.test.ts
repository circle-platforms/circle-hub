// Re-projection of fed cases onto a seedling root and the views over it (fed-case-reprojection, parts A, B, D and E):
// selection by version binding and current source head, re-projections that are visible exactly when their originals are,
// narrowed completeness by normalized id, the originals a view names when cases still lack a projection, and the recorded
// re-read it queues under the reader's own account. Synthetic mind maps and scripted projections only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IndexView, FacetView } from '../../contracts/src/views.ts';
import type { Claim as ClaimBody } from '../../contracts/src/claim.ts';
import type { Principal, StoredRecord } from '../records/api.ts';
import { boundView } from '../../packs/workflow/traceability/functions/test-support.ts';
import project from '../../packs/workflow/story-traceability/functions/project.ts';
import { mergeIndexBindings } from '../runs/engine/index-default.ts';
import { completeKnowledgeView, createKnowledgeReader, formatReprojectReport, knowledgeReproject, parseKnowledgeReprojectArgs } from './api.ts';
import { KnowledgeError } from './errors.ts';
import { startPostgres } from './test-support.ts';
import { mapBytes, world } from './testing/feeding-bounds-fixture.ts';

type World = Awaited<ReturnType<typeof world>>;
const TREE = '<commands><menu name="system"><item name="show"><arguments/></item></menu></commands>';
/** The product's projection with author-declared stories: case 0 declares 033001, every other case declares none. */
const STORIES = "import project from './feeding.ts'; export default function(input) { const out = project(input); for (const row of out.rows) if (row.body.schema === 'fed-case@1') row.body.stories = row.body.source.element === 'case-0' ? ['033001'] : []; return out; }";

async function view(w: World, query: string, user: Principal = w.user): Promise<unknown> {
  const read = await createKnowledgeReader(w.knowledge).read(`knowledge:${query}`, { principal: user, run: null, purpose: 'Synthetic reprojection view' });
  assert.ok(read.ok, read.ok ? '' : read.reason);
  const original = read.artifacts.find((row) => row.name === 'original');
  assert.ok(original);
  const source = await w.kit.artifacts.source(user, original.artifact.body.sha256, { consumer: 'function' });
  assert.ok(source?.bytes);
  return JSON.parse(new TextDecoder().decode(source.bytes));
}
const index = async (w: World, query: string, user?: Principal) => IndexView.parse(await view(w, `index:famx:${w.name}?${query}`, user));

/** A second mind map of the 10.9 line, readable by the reader only. */
async function otherLine(w: World) {
  const visibility = { readers: [w.user.id], admins: true, packs: [], shareable: false };
  const bytes = Buffer.from(mapBytes.toString('utf8').replaceAll('SYN-DOC', 'SYN-DOC-9').replaceAll('Synthetic case', 'Other case'));
  const ingest = (data: Uint8Array) => w.kit.artifacts.ingest({ bytes: data, mediaType: 'application/json', origin: { read: { object: 'agile:mindmap:SYN-DOC-9' } }, author: { user: null }, provenanceType: 'observed', visibility, readTier: 'model_readable' });
  const document = await ingest(bytes);
  const meta = await ingest(Buffer.from(JSON.stringify({ id: 'SYN-DOC-9', title: 'Synthetic doc 9', ancestors: ['rel_famx_10_9'], root: { id: 'synthetic-root', title: 'FAMX' } })));
  return { document, meta };
}

test('re-projection picks the cases bound to the line by binding and current head, writes them as the admin and is idempotent', { timeout: 300_000 }, async (t) => {
  const pg = await startPostgres();
  t.after(() => pg.stop());
  const w = await world(pg, false, undefined, TREE);
  t.after(async () => { await w.knowledge.feeding!.drain(); await w.close(); });
  const layer = w.knowledge.feeding!;
  const rootless = { ...w.scope, root: null, composition: null };
  const read = await layer.observeSource(w.user, w.document.body.sha256, rootless);
  assert.equal(read.objects.length, 40, JSON.stringify(read.pending));
  const other = await otherLine(w);
  const otherRead = await layer.observeSource(w.user, other.document.body.sha256, { ...rootless, sourceRecord: other.document.digest, metaSource: other.meta.body.sha256 });
  assert.equal(otherRead.objects.length, 40, JSON.stringify(otherRead.pending));
  await layer.retract(w.admin, { schema: 'retraction@1', objects: [read.objects[0]], by: w.admin.id, at: new Date().toISOString(), reason: '合成撤回' });

  await assert.rejects(layer.reproject(w.user, 'famx', '10.8.0', { root: w.root.root, composition: w.root.composition }), KnowledgeError);
  const ground = `rec:${w.root.composition}`;
  const report = await layer.reproject(w.admin, 'famx', '10.8.0', { root: w.root.root, composition: w.root.composition }, [ground]);
  assert.deepEqual({ ...report, pending: report.pending.length }, { root: w.root.root, line: '10.8.0', selected: 39, already: 0, originals: 1, projected: 39, pending: 0 });

  // The rows are the admin's, grounded in the caller's ground, each naming the reader's original it re-projects.
  const entries = await layer.entries(w.admin, 'famx');
  const written = entries.filter((row) => row.body.root === w.root.root);
  assert.equal(new Set(written.map((row) => row.body.object)).size, 40, 'the whole original is re-read; the retracted object stays retracted');
  for (const row of written) {
    assert.equal(row.claim.statement.data?.actor, w.admin.id);
    assert.equal(row.claim.warrant.producer, 'function');
    assert.ok(row.claim.grounds.includes(ground));
    const original = row.claim.statement.data?.reprojection_of;
    assert.equal(typeof original, 'string');
    const before = entries.find((entry) => entry.record === original);
    assert.ok(before && before.body.root === null && before.body.object === row.body.object && before.claim.statement.data?.actor === w.user.id);
  }
  assert.equal(written.filter((row) => row.validity === 'invalid').length, 1);
  const cut = await layer.cut('famx', null, w.user);
  const rooted = cut?.casesByRoot?.get(w.root.root);
  assert.equal(rooted?.size, 39, 'the reader sees the re-projections of its own originals, minus the retracted one');
  assert.ok([...rooted!.values()].every((sources) => [...sources.values()].every((row) => (row.body.source as { document: string }).document === 'SYN-DOC')), 'cases bound to another line are not re-projected');

  const again = await layer.reproject(w.admin, 'famx', '10.8.0', { root: w.root.root, composition: w.root.composition }, [ground]);
  assert.deepEqual([again.selected, again.already, again.originals, again.projected], [39, 39, 0, 0]);
});

test('the reproject command re-projects a backlog onto the current seedling and reports it', { timeout: 300_000 }, async (t) => {
  assert.deepEqual(parseKnowledgeReprojectArgs(['FAMX', '10.8.0']), { product: 'FAMX', line: '10.8.0' });
  assert.throws(() => parseKnowledgeReprojectArgs(['FAMX']), /产品和版本线/);
  assert.throws(() => parseKnowledgeReprojectArgs(['FAMX', '10.8.0', '--force']), /不认识的参数/);
  const pg = await startPostgres();
  t.after(() => pg.stop());
  const w = await world(pg, false, undefined, TREE);
  t.after(async () => { await w.knowledge.feeding!.drain(); await w.close(); });
  await w.knowledge.feeding!.observeSource(w.user, w.document.body.sha256, { ...w.scope, root: null, composition: null });
  const before = await index(w, 'kind=case&key=document&only=SYN-DOC');
  assert.equal(before.unknown_entries, 40);
  await w.knowledge.feeding!.drain();

  const missing = await knowledgeReproject(w.knowledge, w.packs, w.admin, { product: 'FAMX', line: '9.9' });
  assert.equal(missing.ok, false);
  assert.match(missing.reason ?? '', /没有当前树苗/);
  const report = await knowledgeReproject(w.knowledge, w.packs, w.admin, { product: 'FAMX', line: '10.8.0' });
  assert.equal(report.ok, true, report.reason ?? '');
  assert.equal(report.root, w.root.root);
  assert.equal(report.reprojection?.selected, 40);
  const text = formatReprojectReport(report);
  assert.match(text, /重投影：产品 famx，版本线 10\.8\.0，树苗 rec:[0-9a-f]{64}/);
  assert.match(text, /现有 40 个喂入用例，已在该根 (0|40) 个/);
  const after = await index(w, 'kind=case&key=document&only=SYN-DOC');
  assert.equal(after.unknown_entries, undefined, after.notes.join('\n'));
  assert.equal(after.keys['SYN-DOC']?.length, 40);
  assert.equal(after.only_complete, true);
});

test('a re-projection is visible exactly when its original is, and the batched and the per-record checks agree', { timeout: 300_000 }, async (t) => {
  const pg = await startPostgres();
  t.after(() => pg.stop());
  const w = await world(pg, false, undefined, TREE);
  t.after(async () => { await w.knowledge.feeding!.drain(); await w.close(); });
  const layer = w.knowledge.feeding!;
  const peer = await w.kit.principals.createUser(w.admin, 'peer');
  w.packs.readers.set(peer.id, new Set(['famx']));
  // The reader's original; a second original the peer may read too.
  await layer.observeSource(w.user, w.document.body.sha256, { ...w.scope, root: null, composition: null });
  const visibility = { readers: [w.user.id, peer.id], admins: true, packs: [], shareable: false };
  const shared = await w.kit.artifacts.ingest({ bytes: Buffer.from(mapBytes.toString('utf8').replaceAll('Synthetic case', 'Shared case')), mediaType: 'application/json', origin: { read: { object: 'agile:mindmap:SYN-DOC' } }, author: { user: null }, provenanceType: 'observed', visibility, readTier: 'model_readable' });
  const sharedMeta = await w.kit.artifacts.ingest({ bytes: Buffer.from(JSON.stringify({ id: 'SYN-DOC', title: 'Synthetic doc', ancestors: ['rel_famx_10_8'], root: { id: 'synthetic-root', title: 'FAMX' } })), mediaType: 'application/json', origin: { read: { object: 'agile:mindmap:SYN-DOC' } }, author: { user: null }, provenanceType: 'observed', visibility, readTier: 'model_readable' });
  await layer.observeSource(peer, shared.body.sha256, { product: 'famx', root: null, composition: null, sourceRecord: shared.digest, metaSource: sharedMeta.body.sha256 });
  await layer.reproject(w.admin, 'famx', '10.8.0', { root: w.root.root, composition: w.root.composition });

  const records = (await w.knowledge.store.all<ClaimBody>({ key: 'knowledge.feeding.product', value: 'famx', kind: 'claim' })) as Array<StoredRecord<ClaimBody>>;
  const reprojections = records.filter((row) => typeof row.body.statement.data?.reprojection_of === 'string');
  assert.equal(reprojections.length, 80);
  // Two forged rows: one naming an original of another source, one naming a re-projection instead of an original.
  const foreign = records.find((row) => row.body.statement.data?.reprojection_of === undefined && (row.body.statement.data?.feeding as { source?: { bytes?: string } })?.source?.bytes === shared.body.sha256)!;
  const forge = async (base: StoredRecord<ClaimBody>, original: string, key: string) => {
    const body = structuredClone(base.body) as ClaimBody;
    (body.statement.data as Record<string, unknown>).reprojection_of = original;
    (body.statement.data as Record<string, unknown>).key = key;
    return await w.kit.store.put({ kind: 'claim', schema: 'claim@1', provenance: 'projected', body, index: [{ key: 'knowledge.feeding.key', value: key }] }) as StoredRecord<ClaimBody>;
  };
  const mine = reprojections.find((row) => (row.body.statement.data?.feeding as { source: { bytes: string } }).source.bytes === w.document.body.sha256)!;
  const forged = [await forge(mine, foreign.digest, 'synthetic-forged-foreign'), await forge(mine, reprojections.find((row) => row !== mine)!.digest, 'synthetic-forged-chain')];
  const all = [...records, ...forged];
  const internal = layer as unknown as {
    recordVisible(record: StoredRecord<ClaimBody>, principal: Principal): Promise<boolean>;
    recordsVisible(items: Array<{ record: StoredRecord<ClaimBody>; body: Record<string, unknown> | null }>, session: unknown): Promise<boolean[]>;
    visibility(principal: Principal): unknown;
    body(record: StoredRecord<ClaimBody>): Record<string, unknown> | null;
  };
  for (const principal of [w.user, peer, w.outsider, w.admin]) {
    const one: boolean[] = [];
    for (const row of all) one.push(await internal.recordVisible(row, principal));
    const many = await internal.recordsVisible(all.map((row) => ({ record: row, body: internal.body(row) })), internal.visibility(principal));
    assert.deepEqual(many, one, `batched and per-record visibility agree for ${principal.name}`);
    for (const row of reprojections) {
      const original = all.find((candidate) => candidate.digest === row.body.statement.data?.reprojection_of)!;
      assert.equal(one[all.indexOf(row)], await internal.recordVisible(original, principal), `a re-projection follows its original for ${principal.name}`);
    }
    for (const row of forged) assert.equal(one[all.indexOf(row)], false, 'a re-projection naming another source or a re-projection is never visible');
  }
  // The admin wrote every re-projection; the peer still sees only those of the original it may read.
  const peerCut = await layer.cut('famx', null, peer);
  assert.equal(peerCut?.casesByRoot?.get(w.root.root)?.size, 40);
  assert.ok([...peerCut!.casesByRoot!.get(w.root.root)!.values()].every((sources) => [...sources.values()].every((row) => (row.body.source as { bytes: string }).bytes === shared.body.sha256)));
});

test('a story index narrowed by only= is complete by normalized id, and story-traceability accepts it', { timeout: 300_000 }, async (t) => {
  const pg = await startPostgres();
  t.after(() => pg.stop());
  const w = await world(pg, false, STORIES, TREE);
  t.after(async () => { await w.knowledge.feeding!.drain(); await w.close(); });
  const layer = w.knowledge.feeding!;
  // Only root-less projections first: a requested story none of them declares is already a definite absence.
  await layer.observeSource(w.user, w.document.body.sha256, { ...w.scope, root: null, composition: null });
  const absentOnly = await index(w, 'kind=case&key=stories&only=99');
  assert.equal(absentOnly.unknown_entries, undefined, absentOnly.notes.join('\n'));
  assert.equal(absentOnly.only_complete, true);
  assert.equal(absentOnly.key_space_complete, false, 'a narrowed view never claims the whole key space');
  const pending = await index(w, 'kind=case&key=stories&only=33001');
  assert.equal(pending.unknown_entries, 1, 'the case declaring 033001 has no projection under the root yet');
  assert.equal(pending.only_complete, false);
  await layer.drain();

  await layer.observeSource(w.user, w.document.body.sha256, w.scope);
  const narrowed = await index(w, 'kind=case&key=stories&only=33001,99');
  assert.equal(narrowed.only_complete, true, narrowed.notes.join('\n'));
  assert.deepEqual(Object.keys(narrowed.keys), ['033001'], 'the stored spelling is kept; the requested id matched it by normalized id');
  assert.ok(narrowed.notes.some((note) => note.includes('这些取值没有条目：99')));
  assert.ok(!narrowed.notes.some((note) => note.includes('33001、')), 'a normalized match is not reported absent');
  const output = project({ inputs: [boundView('stories', { stories: [{ id: '33001', status: 'synthetic' }, { id: '99', status: 'synthetic' }], unread: [] }, 'plm:stories:33001+99'), boundView('cases', narrowed)] }) as { error?: { message: string }; items?: Array<{ fields: { id: string; coverage_complete: boolean; indexed_match_count: number } }> };
  assert.equal(output.error, undefined, output.error?.message);
  assert.deepEqual(output.items!.map((item) => [item.fields.id, item.fields.indexed_match_count, item.fields.coverage_complete]), [['99', 0, true], ['33001', 1, true]]);
  const uncovered = project({ inputs: [boundView('stories', { stories: [{ id: '77', status: 'synthetic' }], unread: [] }, 'plm:stories:77'), boundView('cases', narrowed)] }) as { error?: { message: string } };
  assert.match(uncovered.error?.message ?? '', /77/, 'an id the narrowed view did not request stays undetermined');
});

test('a case view names the originals of root-less cases, queues their re-read under the reader and lists them in its scope', { timeout: 300_000 }, async (t) => {
  const pg = await startPostgres();
  t.after(() => pg.stop());
  const w = await world(pg, false, undefined, TREE);
  t.after(async () => { await w.knowledge.feeding!.drain(); await w.close(); });
  const layer = w.knowledge.feeding!;
  await layer.observeSource(w.user, w.document.body.sha256, { ...w.scope, root: null, composition: null });
  const before = await index(w, 'kind=case&key=stories');
  assert.equal(before.unknown_entries, 40);
  const note = before.notes.find((row) => row.includes('缺所查树苗'));
  assert.ok(note, before.notes.join('\n'));
  assert.ok(note.includes(`40 个用例缺所查树苗 ${w.root.root.slice(0, 12)} 的投影`), note);
  assert.ok(note.includes('原件 agile:mindmap:SYN-DOC（文档 SYN-DOC，40 个用例'), note);
  assert.ok(note.includes(`pack 写 source-read，顶层写 product famx 和 build ${w.name}`), note);
  assert.ok(note.includes('已按你的账号排队重读'), note);
  assert.ok(!note.includes('同步这条产品线'), 'a missing projection is not a product-line sync');
  const scopeNote = before.notes.find((row) => row.includes('不分版本的根'));
  if (scopeNote?.includes('同步这条产品线')) assert.ok(scopeNote.includes('不影响用例投影'), scopeNote);
  assert.deepEqual(before.scope?.fed, { root: w.root.root, originals: 1, cases: 40, projected: 0, rootless: 40, documents: [{ external: 'agile:mindmap:SYN-DOC', sha256: w.document.body.sha256, document: 'SYN-DOC', cases: 40, projected: 0, rootless: 40 }] });
  const facets = FacetView.parse(await view(w, `facets:famx:${w.name}?kind=case&by=line`));
  assert.ok(facets.notes.some((row) => row.includes('原件 agile:mindmap:SYN-DOC') && row.includes('source-read')), facets.notes.join('\n'));

  // The queued re-read is a recorded job of the reader's own account; once it is done the next read is definite.
  await layer.drain();
  const jobs = await w.knowledge.store.all<{ detail: { feeding_job: { by: string; state: string; scope: { root: string | null } } } }>({ key: 'knowledge.feeding.job', value: w.user.id, kind: 'action' });
  assert.ok(jobs.some((row) => row.body.detail.feeding_job.state === 'queued' && row.body.detail.feeding_job.by === w.user.id && row.body.detail.feeding_job.scope.root === w.root.root));
  assert.ok(jobs.some((row) => row.body.detail.feeding_job.state === 'completed'));
  const projected = (await layer.entries(w.user, 'famx')).filter((row) => row.body.root === w.root.root);
  assert.equal(projected.length, 40);
  assert.ok(projected.every((row) => row.claim.statement.data?.actor === w.user.id && row.claim.statement.data?.reprojection_of === undefined));
  const after = await index(w, 'kind=case&key=stories');
  assert.equal(after.unknown_entries, undefined, after.notes.join('\n'));
  assert.equal(after.key_space_complete, true);
  assert.deepEqual([after.scope?.fed?.projected, after.scope?.fed?.rootless], [40, 0]);
});

test('narrowed completeness survives multi-page continuation and only= slices only when every part is complete', { timeout: 300_000 }, async (t) => {
  const pg = await startPostgres();
  t.after(() => pg.stop());
  // Every case declares 033001 with a long title, so the one requested key spans several pages.
  const long = "import project from './feeding.ts'; export default function(input) { const out = project(input); for (const row of out.rows) if (row.body.schema === 'fed-case@1') { row.body.stories = ['033001']; row.body.title = 'synthetic '.repeat(300) + row.body.source.element; } return out; }";
  const w = await world(pg, false, long, TREE);
  t.after(async () => { await w.knowledge.feeding!.drain(); await w.close(); });
  const layer = w.knowledge.feeding!;
  const reader = createKnowledgeReader(w.knowledge);
  const context = { principal: w.user, run: null, purpose: 'Synthetic narrowed merge' };
  const model = async (read: Awaited<ReturnType<typeof completeKnowledgeView>>) => {
    assert.ok(read.ok, read.ok ? '' : read.reason);
    const source = await w.kit.artifacts.source(w.user, read.artifacts[0].artifact.body.sha256, { consumer: 'function' });
    assert.ok(source?.bytes);
    return IndexView.parse(JSON.parse(new TextDecoder().decode(source.bytes)));
  };
  const base = `knowledge:index:famx:${w.name}?kind=case&key=stories`;
  // Root-less only: 99 is definite, 33001 is not; the merged slices are not complete.
  await layer.observeSource(w.user, w.document.body.sha256, { ...w.scope, root: null, composition: null });
  const pendingMerge = await model(await mergeIndexBindings([`${base}&only=99`, `${base}&only=33001`], base, context, reader, w.kit, { unknownEntries: 'disclose' }));
  assert.equal(pendingMerge.only_complete, false);
  await layer.drain();
  await layer.observeSource(w.user, w.document.body.sha256, w.scope);
  const merged = await model(await mergeIndexBindings([`${base}&only=99`, `${base}&only=33001`], base, context, reader, w.kit));
  assert.equal(merged.only_complete, true);
  assert.equal(merged.keys['033001']?.length, 40);

  w.knowledge.__context.limits.maxViewBytes = 64 * 1024 + 3500;
  let pages = 0;
  const counting = { accepts: reader.accepts, read: async (id: string, ctx: typeof context) => { pages++; return reader.read(id, ctx); } };
  const paged = await model(await completeKnowledgeView(`${base}&only=33001`, context, counting, w.kit));
  assert.ok(pages > 1, 'the narrowed view spans several pages');
  assert.equal(paged.only_complete, true);
  assert.equal(paged.keys['033001']?.length, 40);
});

test('a root without any case entry proves no story absence, narrowed or not', { timeout: 300_000 }, async (t) => {
  const pg = await startPostgres();
  t.after(() => pg.stop());
  const w = await world(pg, false, undefined, TREE);
  t.after(async () => { await w.knowledge.feeding!.drain(); await w.close(); });
  // Nothing was fed and the root holds no case: the version has no case knowledge at all.
  const narrowed = await index(w, 'kind=case&key=stories&only=99999');
  assert.equal(narrowed.only_complete, false, narrowed.notes.join('\n'));
  const whole = await index(w, 'kind=case&key=stories');
  assert.notEqual(whole.key_space_complete, true, whole.notes.join('\n'));
  const output = project({ inputs: [boundView('stories', { stories: [{ id: '99999', status: 'synthetic' }], unread: [] }, 'plm:stories:99999'), boundView('cases', narrowed)] }) as { error?: { code: string; fix: string } };
  assert.equal(output.error?.code, 'story-traceability.invalid_input');
  assert.match(output.error!.fix, /去掉无法确定的编号 99999/);
});
