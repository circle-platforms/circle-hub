import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IndexView } from '../../contracts/src/views.ts';
import { completeKnowledgeView, createKnowledgeReader } from './api.ts';
import { BASE_CATALOG, DEFAULT_PRODUCERS, casesProducer, catalogXml, makeWorld, startPostgres } from './test-support.ts';
import { world } from './testing/feeding-bounds-fixture.ts';
import { boundView } from '../../packs/workflow/traceability/functions/test-support.ts';
import project from '../../packs/workflow/story-traceability/functions/project.ts';

test('the Hub distinguishes unresolved case keys from complete keys with a partial entry page', async t => {
  const pg = await startPostgres();
  t.after(() => pg.stop());
  const xml = '<commands><menu name="system"><item name="show"><arguments/></item></menu></commands>';
  const w = await world(pg, false, undefined, xml);
  t.after(() => w.close());
  const layer = w.knowledge.feeding!;
  await layer.observeSource(w.user, w.document.body.sha256, { ...w.scope, root: null, composition: null });

  async function index(query: string) {
    const result = await createKnowledgeReader(w.knowledge).read(`knowledge:index:famx:${w.name}?${query}`, { principal: w.user, run: null, purpose: 'Synthetic index key-space coverage' });
    assert.ok(result.ok, result.ok ? '' : result.reason);
    const original = result.artifacts.find(row => row.name === 'original');
    assert.ok(original);
    const source = await w.kit.artifacts.source(w.user, original.artifact.body.sha256, { consumer: 'function' });
    assert.ok(source?.bytes);
    return IndexView.parse(JSON.parse(new TextDecoder().decode(source.bytes)));
  }

  const unresolved = await index('kind=case&key=stories');
  assert.equal(unresolved.truncated, true);
  assert.equal(unresolved.key_space_complete, false);
  const projectStory = (view: typeof unresolved) => project({ inputs: [
    boundView('stories', { stories: [{ id: '33001', status: 'synthetic' }], unread: [] }, 'plm:stories:33001'),
    boundView('cases', view),
  ] }) as { error?: { code: string }; items?: unknown[] };
  assert.equal(projectStory(unresolved).error?.code, 'story-traceability.invalid_input');
  await layer.observeSource(w.user, w.document.body.sha256, w.scope);
  const complete = await index('kind=case&key=stories');
  assert.equal(complete.key_space_complete, true);
  assert.ok(projectStory(complete).items);
  const narrowed = await index('kind=case&key=stories&only=33001');
  assert.equal(narrowed.key_space_complete, false);

  w.knowledge.__context.limits.maxViewBytes = 64 * 1024 + 3500;
  const page = await index('kind=case&key=document&fields=document,node');
  assert.equal(page.truncated, true);
  assert.ok(page.next);
  assert.equal(page.total_keys, 1);
  assert.deepEqual(Object.keys(page.keys), ['SYN-DOC']);
  assert.equal(page.key_space_complete, true);
});

test('legacy case projections without the indexed story field do not claim a complete key space', async t => {
  const pg = await startPostgres();
  t.after(() => pg.stop());
  const legacy = "import project from './feeding.ts'; export default function(input) { const out = project(input); for (const row of out.rows) delete row.body.stories; return out; }";
  const xml = '<commands><menu name="system"><item name="show"><arguments/></item></menu></commands>';
  const w = await world(pg, false, legacy, xml);
  t.after(() => w.close());
  await w.knowledge.feeding!.observeSource(w.user, w.document.body.sha256, w.scope);
  const result = await createKnowledgeReader(w.knowledge).read(`knowledge:index:famx:${w.name}?kind=case&key=stories`, { principal: w.user, run: null, purpose: 'Synthetic missing story fields' });
  assert.ok(result.ok, result.ok ? '' : result.reason);
  const original = result.artifacts.find(row => row.name === 'original');assert.ok(original);
  const source = await w.kit.artifacts.source(w.user, original.artifact.body.sha256, { consumer: 'function' });assert.ok(source?.bytes);
  const view = IndexView.parse(JSON.parse(new TextDecoder().decode(source.bytes)));
  assert.equal(view.truncated, true);
  assert.equal(view.key_space_complete, false);
  assert.ok(view.notes.some(note => note.includes('缺少索引字段 stories') && note.includes('下一步')));
});

test('a pending source scope cannot claim a complete key space', async t => {
  const pg = await startPostgres();t.after(() => pg.stop());
  const w = await makeWorld(pg, { pack: { declaration: { producers: [...DEFAULT_PRODUCERS, casesProducer({ optional: true })] } } });
  t.after(() => w.close());
  w.external.set('site:tree:synthetic', { bytes: catalogXml(BASE_CATALOG), mediaType: 'application/xml' });
  const build = { name: 'Rel_ACME_10_8_1_71', family: 'ACME', line: '10.8.1', base: 'Rel_ACME_10_8_1_71', platform: null, built_at: null, released_at: null, root: null, sources: { tree: 'site:tree:synthetic', cases: ['store:mindmap:missing'] } };
  const produced = await w.knowledge.produceTree({ product: w.product, build });
  assert.ok(produced.ok, produced.reason ?? '');
  const result = await createKnowledgeReader(w.knowledge).read('knowledge:index:acme:Rel_ACME_10_8_1_71?kind=case&key=stories', { principal: w.user, run: null, purpose: 'Synthetic pending source scope' });
  assert.ok(result.ok, result.ok ? '' : result.reason);
  const original = result.artifacts.find(row => row.name === 'original');assert.ok(original);
  const source = await w.kit.artifacts.source(w.user, original.artifact.body.sha256, { consumer: 'function' });assert.ok(source?.bytes);
  const view = IndexView.parse(JSON.parse(new TextDecoder().decode(source.bytes)));
  assert.equal(view.scope?.complete, false);
  assert.equal(view.key_space_complete, false);
});

test('a completed multi-page case index can prove an absent story only after all pages are merged', async t => {
  const pg = await startPostgres(); t.after(() => pg.stop());
  const projection = "import project from './feeding.ts'; export default function(input) { const out = project(input); for (const [i, row] of out.rows.entries()) { row.body.stories = [String(100 + i)]; row.body.title = 'synthetic '.repeat(300) + i; } return out; }";
  const xml = '<commands><menu name="system"><item name="show"><arguments/></item></menu></commands>';
  const w = await world(pg, false, projection, xml); t.after(() => w.close());
  await w.knowledge.feeding!.observeSource(w.user, w.document.body.sha256, w.scope);
  w.knowledge.__context.limits.maxViewBytes = 64 * 1024 + 3500;
  const reader = createKnowledgeReader(w.knowledge);
  const context = { principal: w.user, run: null, purpose: 'Synthetic complete multi-page index' };
  let pages = 0;
  const external = { accepts: reader.accepts, read: async (id: string, ctx: typeof context) => { pages++; return reader.read(id, ctx); } };
  const result = await completeKnowledgeView(`knowledge:index:famx:${w.name}?kind=case&key=stories`, context, external, w.kit);
  assert.ok(result.ok, result.ok ? '' : result.reason);
  assert.ok(pages > 1);
  const source = await w.kit.artifacts.source(w.user, result.artifacts[0].artifact.body.sha256, { consumer: 'function' });
  assert.ok(source?.bytes);
  const view = IndexView.parse(JSON.parse(new TextDecoder().decode(source.bytes)));
  assert.equal(view.truncated, false);
  assert.equal(Object.keys(view.keys).length, view.total_keys);
  assert.equal(view.key_space_complete, true);
  const output = project({ inputs: [boundView('stories', { stories: [{ id: '33001', status: 'synthetic' }], unread: [] }, 'plm:stories:33001'), boundView('cases', view)] }) as { error?: unknown; items?: unknown[] };
  assert.equal(output.error, undefined);
  assert.ok(output.items);

  const legacyExternal = { accepts: reader.accepts, read: async (id: string, ctx: typeof context) => {
    const page = await reader.read(id, ctx);
    if (!page.ok) return page;
    const original = page.artifacts.find(row => row.name === 'original'); assert.ok(original);
    const pageSource = await w.kit.artifacts.source(w.user, original.artifact.body.sha256, { consumer: 'function', record: original.artifact.digest }); assert.ok(pageSource?.bytes);
    const oldModel = JSON.parse(new TextDecoder().decode(pageSource.bytes)); delete oldModel.key_space_complete;
    const artifact = await w.kit.artifacts.ingest({ bytes: Buffer.from(JSON.stringify(oldModel)), mediaType: 'application/json', origin: { read: { object: id } }, author: { user: null }, provenanceType: 'observed', visibility: { readers: [w.user.id], admins: true, packs: [], shareable: false }, readTier: 'model_readable' });
    return { ...page, artifacts: [{ name: 'original', artifact }] };
  } };
  const legacy = await completeKnowledgeView(`knowledge:index:famx:${w.name}?kind=case&key=stories`, context, legacyExternal, w.kit);
  assert.ok(legacy.ok, legacy.ok ? '' : legacy.reason);
  const legacySource = await w.kit.artifacts.source(w.user, legacy.artifacts[0].artifact.body.sha256, { consumer: 'function' }); assert.ok(legacySource?.bytes);
  const legacyView = IndexView.parse(JSON.parse(new TextDecoder().decode(legacySource.bytes)));
  assert.equal(legacyView.key_space_complete, undefined);
  const legacyOutput = project({ inputs: [boundView('stories', { stories: [{ id: '33001', status: 'synthetic' }], unread: [] }, 'plm:stories:33001'), boundView('cases', legacyView)] }) as { error?: { code: string } };
  assert.equal(legacyOutput.error?.code, 'story-traceability.invalid_input');
});
