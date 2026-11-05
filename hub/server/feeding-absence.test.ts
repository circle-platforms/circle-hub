// "System S has no X, read at T" stays what it is: an observation a run may bind and a reader may read. No path feeds it, leaves
// it pending or sends an administrator after it. Synthetic world; the capture has the shape a read gives it (connectors/read.ts).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ReadManifest } from '../../contracts/src/resources.ts';
import { FEEDING_BOUNDS } from '../knowledge/feeding.ts';
import { startPostgres } from '../knowledge/test-support.ts';
import { installedMindmapFixture, world } from '../knowledge/testing/feeding-bounds-fixture.ts';
import { SOURCE_ABSENCE_GENERATOR, canonicalBytes, newId, type ArtifactOrigin, type IngestInput } from '../records/api.ts';
import { osIsolationAvailable } from '../rules/api.ts';
import { createRunsService } from '../runs/api.ts';
import { FakeWorkflowStore } from '../runs/engine/testing/workflows.ts';
import { createTestServer } from './testing.ts';

const ABSENT = 'plm:bug:9999';
const NOT_FED = { objects: [], offset: null, pending: [] };

async function setting(t: { after(fn: () => unknown): void }) {
  const pg = await startPostgres(); t.after(() => pg.stop());
  const w = await world(pg);
  const layer = w.knowledge.feeding!;
  t.after(async () => { await layer.drain(); await w.close(); });
  const ingest = (bytes: Uint8Array, origin: ArtifactOrigin, name: string, provenanceType: IngestInput['provenanceType']) =>
    w.kit.artifacts.ingest({ bytes, mediaType: 'application/json', origin, name, author: { user: null }, provenanceType, visibility: { readers: [w.user.id], admins: true, packs: [], shareable: false } });
  const at = new Date().toISOString(), absent = { code: 'SOURCE_ABSENT' as const, system: 'plm', object: ABSENT, observed_at: at, responses: ['response'] };
  const original = await ingest(Buffer.from('{"error":"synthetic not found"}'), { read: { object: ABSENT } }, 'original', 'observed');
  const content = await ingest(canonicalBytes({ ...absent, message: `系统 plm 里没有 ${ABSENT}（读于 ${at}）` }), { generated: { generator: SOURCE_ABSENCE_GENERATOR, inputs: ['src:' + original.body.sha256], read_back: null } }, 'content', 'projected');
  const artifacts = [{ name: 'original', artifact: original }, { name: 'content', artifact: content }];
  const manifest = await w.kit.store.put({ kind: 'action', schema: 'read-manifest@1', provenance: 'observed', index: artifacts.map(({ artifact }) => ({ key: 'connectors.artifact', value: artifact.digest })), body: ReadManifest.parse({
    action: 'read', run: null, item: null, inputs: ['rec:' + original.digest], component: 'connectors.read@1', lease: null, started_at: at, ended_at: at, result: 'completed', error_code: null, external: ABSENT, revision: null, resource: newId('res'), environment: 'test',
    system_pack: { id: 'synthetic-plm', version: '1.0.0', digest: w.product.digest }, read: 'bug', principal: w.user.id, purpose: 'Synthetic absence', requests: [], reads: [], original: null,
    artifacts: artifacts.map(({ name, artifact }) => ({ name, record: artifact.digest, sha256: artifact.body.sha256, media_type: artifact.body.media_type, size: artifact.body.size })), coverage: { complete: true, examined: 1, total: 1 }, reason: null, warnings: [],
  }) });
  const scope = { sourceRecord: content.digest, readManifest: manifest.digest, requested: ABSENT };
  /** What a feed of the observation would leave behind: a to-do naming the object, and jobs under these keys. */
  const untouched = async (...keys: string[]) => {
    await layer.drain();
    assert.deepEqual((await layer.todos(w.admin)).filter(todo => todo.source.system === 'plm'), [], 'an administrator has nothing to do about it');
    for (const value of keys) assert.deepEqual(await w.knowledge.store.all({ key: 'knowledge.feeding.job', value, kind: 'action' }), [], 'and no job exists for it');
  };
  return { pg, w, layer, sha: content.body.sha256, scope, artifacts, absent, untouched };
}

test('a run that binds an absence and a caller who reads it back: the answer says so, and no read of it feeds, pends or asks for another read', async t => {
  const { pg, w, layer, sha, scope, artifacts, absent, untouched } = await setting(t);
  const workflows = new FakeWorkflowStore(w.admin.id);
  await workflows.add(fileURLToPath(new URL('../../packs/workflow/source-read/', import.meta.url)));
  workflows.assign(w.user.id, 'source-read');
  const external = w.external.read.bind(w.external);
  w.external.accepts = async id => id === ABSENT;
  w.external.read = async (id, context) => id === ABSENT ? { ok: true, id, revision: null, manifest: scope.readManifest, artifacts, absent } : external(id, context);
  const runs = createRunsService({ sandbox: { requireOsIsolation: await osIsolationAvailable() }, records: w.kit, packs: w.packs, knowledge: w.knowledge, external: w.external, workflows, parsers: installedMindmapFixture() });
  const hub = await createTestServer({ postgres: pg }); t.after(() => hub.close());
  hub.deps.records = w.kit; hub.deps.knowledge = w.knowledge; hub.deps.runs = runs;
  const token = await w.kit.principals.issueToken(w.admin, w.user.id, 'synthetic');
  const client = await hub.client(token.token, { sessionId: 'synthetic-absence-session' }); t.after(() => client.close());

  const started = await runs.startRunDetailed(w.user, { pack: 'source-read', inputs: { defect: { external: ABSENT } } }, { traceId: '4bf92f3577b34da6a3ce929d0e0e0001', sessionId: 'synthetic-absence-session' });
  assert.equal(started.answer.call_result, 'ok', JSON.stringify(started.answer.errors));
  assert.match(started.gaps?.find(gap => gap.code === 'SOURCE_ABSENT')?.message ?? '', /系统 plm 里没有 plm:bug:9999/, 'the absence stays a gap of the answer');
  const run = started.answer.run!, reference = run.sources[0].reference;
  assert.equal(reference, 'src:' + sha);

  for (const query of [{ reference }, { reference, run: run.run }, { reference, run: run.run }]) {
    const read = await client.call('get_nodes', query);
    assert.equal(read.isError, false, JSON.stringify(read.structuredContent.errors));
    assert.match((read.structuredContent.content as { text: string }).text, /系统 plm 里没有 plm:bug:9999/, 'the observation itself stays readable');
    assert.deepEqual(read.structuredContent.feeding_pending, []);
    assert.deepEqual(read.structuredContent.feeding_objects, []);
    assert.doesNotMatch(read.content[0].text ?? '', /喂入未知|重读/);
  }
  assert.deepEqual(await layer.pending(w.user, run.run), []);
  assert.deepEqual(await layer.usages(w.user, run.run), []);
  await untouched(w.user.id, run.run);
});

test('a run bound to a product feeds it no more than a run that is not: expected sources, checks and a sync all stop at the same place', async t => {
  const { w, layer, sha, scope, untouched } = await setting(t);
  const calls = w.calls(), run = newId('run'), bound = { ...w.scope, metaSource: undefined, ...scope, run };
  assert.deepEqual(await layer.observeSourceBounded(w.user, sha, bound), NOT_FED, 'the read hook of a run');
  assert.deepEqual(await layer.observeSourceBounded(w.user, sha, { product: 'famx', root: w.root.root, run }), NOT_FED, 'a read that names no capture gets the one this reader has');
  assert.deepEqual(await layer.observeSource(w.user, sha, { product: 'famx', ...scope }), NOT_FED, 'the path of a sync and a re-projection');
  await untouched(w.user.id, run);
  assert.equal(w.calls(), calls, 'no pack function saw the observation');
  assert.deepEqual(await layer.entries(w.user, 'famx'), []);
});

test('a full queue has no say: the receipt carries no pending item and no refused job is written', async t => {
  const { w, layer, sha, scope, untouched } = await setting(t);
  const source = w.kit.artifacts.source.bind(w.kit.artifacts);
  let release!: () => void;
  const gate = new Promise<void>(yes => { release = yes; });
  w.kit.artifacts.source = async (...args) => { if (args[1] === w.document.body.sha256) await gate; return source(...args); };
  t.after(() => { release(); w.kit.artifacts.source = source; });
  const waiting = await Promise.all(Array.from({ length: FEEDING_BOUNDS.concurrency + FEEDING_BOUNDS.queued }, () => layer.observeSourceBounded(w.user, w.document.body.sha256, { run: newId('run') })));
  assert.ok(waiting.every(receipt => receipt.pending.length > 0), 'the queue is full');
  const run = newId('run'), receipt = await layer.observeSourceBounded(w.user, sha, { ...scope, run });
  release();
  assert.deepEqual(receipt, NOT_FED);
  await untouched(run);
});
