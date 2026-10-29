import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startPostgres, type TemporaryPostgres } from '../../testing/postgres.ts';
import { newId } from '../../records/api.ts';
import { RunRecord } from '../../../contracts/src/run.ts';
import { createEngineContext } from './deps.ts';
import { buildScope, createResolver, type RunScope } from './exact.ts';
import { evaluate } from './evaluate.ts';
import { openHarness, sandboxSkip, type Harness } from './testing/harness.ts';
import { standardDocument, toyMap, ITEM } from './testing/mindmap.ts';
import { putRun } from './store.ts';

let postgres: TemporaryPostgres;
const skip = await sandboxSkip();
before(async () => { postgres = await startPostgres(); });
after(async () => { await postgres?.stop(); });

async function capturedRun(h: Harness) {
  const bytes = toyMap(standardDocument());
  const declared = await h.upload(h.alice, bytes);
  const started = await h.service.startRun(h.alice, { pack: 'toy-review', product: 'Meadow', version: '3.2', inputs: { map: { reference: declared } } }, h.call());
  const current = (await h.service.getRun(h.alice, started.run!.run))!.run;
  const captured = await h.kit.artifacts.ingest({
    bytes, mediaType: 'application/json', name: 'legacy-captured.json',
    origin: { upload: { session: 'legacy-capture', message: null } }, author: { user: h.alice.id }, provenanceType: 'client_captured',
    visibility: { readers: [h.alice.id], admins: true, packs: [], shareable: true },
  });
  const { feeding_offset: _feedingOffset, ...base } = current;
  const old = RunRecord.parse({
    ...base, run: newId('run'),
    sources: current.sources.map(source => source.reference === declared ? { ...source, artifact: undefined } : source),
  });
  assert.ok(old.sources.some(source => source.reference === declared && source.artifact === undefined));
  await putRun(h.kit.store, old, current.started_at);
  return { old, sha256: captured.body.sha256 };
}

test('prefetch cannot bypass declaration-grade refusal on a later grounds use', { skip }, async t => {
  const h = await openHarness(postgres); t.after(() => h.close());
  const { old, sha256 } = await capturedRun(h);
  const ctx = createEngineContext({ records: h.kit, workflows: h.workflows, packs: h.packs, knowledge: h.knowledge, external: h.external });
  const scope = await buildScope(ctx, old, h.review, h.alice, 'function');
  const resolver = createResolver(ctx, scope, 'function');
  const reference = `src:${sha256}/json@1/p`;
  await resolver.prefetch([reference]);
  assert.equal((await resolver.resolve(reference)).ok, true);
  const grounded = await resolver.resolve(reference, { grounds: true });
  assert.equal(grounded.ok, false);
  assert.match(JSON.stringify(grounded), /决定 73|客户端捕获/);
});

test('evaluate resolves the actual captured artifact when a legacy binding has no artifact id', { skip }, async t => {
  const h = await openHarness(postgres, { dataQuotes: true }); t.after(() => h.close());
  const { old, sha256 } = await capturedRun(h);
  const reference = `src:${sha256}/json@1/p`;
  const items = old.items.map(item => ({
    item: item.id,
    handling: 'handled' as const,
    slots: {
      findings: item.id === ITEM.c4 ? [{
        text: '合成', code: 'edge_case_gap', rank: 'major',
        data: { expected_quote: { reference, text: 'x' } },
      }] : [],
    },
  }));
  const evaluated = await evaluate(createEngineContext({ records: h.kit, workflows: h.workflows, packs: h.packs, knowledge: h.knowledge, external: h.external }), {
    run: old, workflow: h.review,
    submission: { run: old.run, model: 'synthetic-evaluation', items },
    submissionDigest: 'a'.repeat(64), exact: null, carried: new Map(), roundsUsed: new Map(), origin: null, author: null, traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
  });
  assert.match(JSON.stringify(evaluated.result), /客户端捕获的原件只随操作记录进入回注层/);
});

test('a use as grounds reads the very artifact whose provenance it checks (round-four review, item 3)', { skip }, async t => {
  const h = await openHarness(postgres); t.after(() => h.close());
  const bytes = toyMap(standardDocument());
  const declared = await h.upload(h.alice, bytes);
  const started = await h.service.startRun(h.alice, { pack: 'toy-review', product: 'Meadow', version: '3.2', inputs: { map: { reference: declared } } }, h.call());
  const run = (await h.service.getRun(h.alice, started.run!.run))!.run;
  const bound = run.sources.find(source => source.reference === declared)?.artifact;
  assert.ok(bound, 'a current run names the artifact it bound');
  // Later the same user uploads the same bytes as a client capture: a second, newer record of that digest.
  const captured = await h.kit.artifacts.ingest({
    bytes, mediaType: 'application/json', name: 'later-captured.json',
    origin: { upload: { session: 'later-capture', message: null } }, author: { user: h.alice.id }, provenanceType: 'client_captured',
    visibility: { readers: [h.alice.id], admins: true, packs: [], shareable: true },
  });
  assert.notEqual(captured.digest, bound);
  const reads: Array<string | undefined> = [];
  const source = h.kit.artifacts.source.bind(h.kit.artifacts);
  t.mock.method(h.kit.artifacts, 'source', async (...args: Parameters<typeof source>) => {
    if (args[1] === captured.body.sha256) reads.push(args[2]?.record);
    return source(...args);
  });
  const ctx = createEngineContext({ records: h.kit, workflows: h.workflows, packs: h.packs, knowledge: h.knowledge, external: h.external });
  const resolver = createResolver(ctx, await buildScope(ctx, run, h.review, h.alice, 'function'), 'function');
  const reference = `src:${captured.body.sha256}/json@1/p`;
  await resolver.prefetch([reference]);
  const grounded = await resolver.resolve(reference, { grounds: true });
  assert.equal(grounded.ok, true, 'the declared artifact the run bound may be grounds');
  assert.ok(reads.length > 0, 'the resolver read the source');
  assert.deepEqual([...new Set(reads)], [bound], 'every read asks for the bound record, never the newer captured one');
});

function capturedUpload(h: Harness, bytes: Uint8Array, session: string) {
  return h.kit.artifacts.ingest({
    bytes, mediaType: 'application/json', name: `${session}.json`,
    origin: { upload: { session, message: null } }, author: { user: h.alice.id }, provenanceType: 'client_captured',
    visibility: { readers: [h.alice.id], admins: true, packs: [], shareable: true },
  });
}

test('without a run, a use as grounds still checks the record it reads and refuses a captured one (round five, item 3)', { skip }, async t => {
  const h = await openHarness(postgres); t.after(() => h.close());
  const captured = await capturedUpload(h, toyMap(standardDocument()), 'no-run-capture');
  const sha = captured.body.sha256;
  const scope: RunScope = {
    reader: { user: h.alice.id, role: h.alice.role }, sources: new Map([[sha, 'expected']]), records: new Map(),
    subject: { shas: new Set(), records: new Set() }, root: null, catalogs: [], candidates: async () => [],
  };
  const ctx = createEngineContext({ records: h.kit, workflows: h.workflows, packs: h.packs, knowledge: h.knowledge, external: h.external });
  const resolver = createResolver(ctx, scope, 'function');
  const reference = `src:${sha}/json@1/p`;
  assert.equal((await resolver.resolve(reference)).ok, true, 'the source can be read');
  const grounded = await resolver.resolve(reference, { grounds: true });
  assert.equal(grounded.ok, false);
  assert.match(JSON.stringify(grounded), /客户端捕获/);
});

test('a run that binds one digest to two records refuses it as grounds when either record is captured (round five, item 3)', { skip }, async t => {
  const h = await openHarness(postgres); t.after(() => h.close());
  const bytes = toyMap(standardDocument());
  const declared = await h.upload(h.alice, bytes);
  const started = await h.service.startRun(h.alice, { pack: 'toy-review', product: 'Meadow', version: '3.2', inputs: { map: { reference: declared } } }, h.call());
  const current = (await h.service.getRun(h.alice, started.run!.run))!.run;
  const binding = current.sources.find(source => source.reference === declared);
  assert.ok(binding?.artifact, 'the run bound the declared record first');
  const captured = await capturedUpload(h, bytes, 'second-binding');
  const { feeding_offset: _feedingOffset, ...base } = current;
  const twice = RunRecord.parse({ ...base, run: newId('run'), sources: [...current.sources, { ...binding, artifact: captured.digest }] });
  await putRun(h.kit.store, twice, current.started_at);
  const ctx = createEngineContext({ records: h.kit, workflows: h.workflows, packs: h.packs, knowledge: h.knowledge, external: h.external });
  const resolver = createResolver(ctx, await buildScope(ctx, twice, h.review, h.alice, 'function'), 'function');
  const reference = `src:${captured.body.sha256}/json@1/p`;
  assert.equal((await resolver.resolve(reference)).ok, true, 'the source can be read');
  const grounded = await resolver.resolve(reference, { grounds: true });
  assert.equal(grounded.ok, false, 'the captured record bound second is checked too');
  assert.match(JSON.stringify(grounded), /客户端捕获/);
});
