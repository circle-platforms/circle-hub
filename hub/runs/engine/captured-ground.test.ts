import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startPostgres, type TemporaryPostgres } from '../../testing/postgres.ts';
import type { ProvenanceType } from '../../../contracts/generated/vocabulary.ts';
import { newId, RECORD_SCHEMAS } from '../../records/api.ts';
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
  return { old, sha256: captured.body.sha256, captured };
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

test('evaluation checks the record its read came from, even when a newer record of the same bytes appears in between (round six, item 3)', { skip }, async t => {
  const h = await openHarness(postgres, { dataQuotes: true }); t.after(() => h.close());
  const { old, sha256, captured } = await capturedRun(h);
  const declared = (await h.kit.artifacts.records(sha256)).find(row => row.body.provenance_type === 'declared');
  assert.ok(declared);
  // The first unpinned lookup sees the captured record; any later one sees the declared record, as if a newer record of the
  // same bytes appeared between the read and the check. A pinned read gets the record it names.
  const source = h.kit.artifacts.source.bind(h.kit.artifacts);
  let unpinned = 0;
  t.mock.method(h.kit.artifacts, 'source', async (...args: Parameters<typeof source>) => {
    const [principal, sha, options = {}] = args;
    if (sha !== sha256 || options.record !== undefined) return source(...args);
    return source(principal, sha, { ...options, record: unpinned++ === 0 ? captured.digest : declared.digest });
  });
  const reference = `src:${sha256}/json@1/p`;
  const items = old.items.map(item => ({ item: item.id, handling: 'handled' as const, slots: { findings: item.id === ITEM.c4 ? [{ text: '合成', code: 'edge_case_gap', rank: 'major', data: { expected_quote: { reference, text: 'x' } } }] : [] } }));
  const evaluated = await evaluate(createEngineContext({ records: h.kit, workflows: h.workflows, packs: h.packs, knowledge: h.knowledge, external: h.external }), {
    run: old, workflow: h.review,
    submission: { run: old.run, model: 'synthetic-evaluation', items },
    submissionDigest: 'b'.repeat(64), exact: null, carried: new Map(), roundsUsed: new Map(), origin: null, author: null, traceId: '4bf92f3577b34da6a3ce929d0e0e4737',
  });
  assert.ok(unpinned >= 1, 'the source was looked up');
  assert.match(JSON.stringify(evaluated.result), /客户端捕获的原件只随操作记录进入回注层/, 'the captured record that was read is the one checked');
});

test('a run that bound no record reads a generated source on its own authority through the record it checks (round six, item 3)', { skip }, async t => {
  const h = await openHarness(postgres); t.after(() => h.close());
  const declared = await h.upload(h.alice, toyMap(standardDocument()));
  const started = await h.service.startRun(h.alice, { pack: 'toy-review', product: 'Meadow', version: '3.2', inputs: { map: { reference: declared } } }, h.call());
  const current = (await h.service.getRun(h.alice, started.run!.run))!.run;
  // A generated source no reader names: the runner reads it only through the run that refers to it.
  const generated = await h.kit.artifacts.ingest({
    bytes: Buffer.from(JSON.stringify({ p: 'synthetic generated' })), mediaType: 'application/json', name: 'generated.json',
    origin: { generated: { generator: 'synthetic@1', inputs: [] } }, author: { user: null }, provenanceType: 'projected',
    visibility: { readers: [], admins: true, packs: [], shareable: false },
  });
  assert.equal(await h.kit.artifacts.source(h.alice, generated.body.sha256, { consumer: 'function' }), null, 'not readable directly');
  const template = current.sources.find(source => source.reference === declared)!;
  const { feeding_offset: _feedingOffset, ...base } = current;
  const legacy = RunRecord.parse({ ...base, run: newId('run'), sources: [...current.sources, { ...template, reference: `src:${generated.body.sha256}`, artifact: undefined }] });
  await putRun(h.kit.store, legacy, current.started_at);
  const ctx = createEngineContext({ records: h.kit, workflows: h.workflows, packs: h.packs, knowledge: h.knowledge, external: h.external });
  const resolver = createResolver(ctx, await buildScope(ctx, legacy, h.review, h.alice, 'function'), 'function');
  const reference = `src:${generated.body.sha256}/json@1/p`;
  const read = await resolver.resolve(reference);
  assert.equal(read.ok, true, JSON.stringify(read));
  assert.equal((await resolver.resolve(reference, { grounds: true })).ok, true, 'a projected record may be grounds');
});

test('a binding to anything but a source artifact of these bytes leaves the record undetermined for grounds (round six, item 3)', { skip }, async t => {
  const h = await openHarness(postgres); t.after(() => h.close());
  const bytes = toyMap(standardDocument());
  const declared = await h.upload(h.alice, bytes);
  const started = await h.service.startRun(h.alice, { pack: 'toy-review', product: 'Meadow', version: '3.2', inputs: { map: { reference: declared } } }, h.call());
  const current = (await h.service.getRun(h.alice, started.run!.run))!.run;
  const binding = current.sources.find(source => source.reference === declared);
  assert.ok(binding?.artifact);
  // A second binding of the same digest names a real source artifact, but of other bytes.
  const other = await h.kit.artifacts.ingest({
    bytes: Buffer.from(JSON.stringify({ p: 'other bytes' })), mediaType: 'application/json', name: 'other.json',
    origin: { upload: { session: 'other-bytes', message: null } }, author: { user: h.alice.id }, provenanceType: 'declared',
    visibility: { readers: [h.alice.id], admins: true, packs: [], shareable: true },
  });
  const { feeding_offset: _feedingOffset, ...base } = current;
  const damaged = RunRecord.parse({ ...base, run: newId('run'), sources: [...current.sources, { ...binding, artifact: other.digest }] });
  await putRun(h.kit.store, damaged, current.started_at);
  const ctx = createEngineContext({ records: h.kit, workflows: h.workflows, packs: h.packs, knowledge: h.knowledge, external: h.external });
  const resolver = createResolver(ctx, await buildScope(ctx, damaged, h.review, h.alice, 'function'), 'function');
  const reference = `${declared}/json@1/p`;
  assert.equal((await resolver.resolve(reference)).ok, true, 'the verified binding is still read');
  const grounded = await resolver.resolve(reference, { grounds: true });
  assert.equal(grounded.ok, false);
  assert.match(JSON.stringify(grounded), /无法确定作根据的原件/);
});

/**
 * A run of the review pack that binds the map's digest to its uploaded record and, when asked, to a second record of the
 * same bytes whose provenance is not a known one or not the record's own. The first record is the one read; a use as
 * grounds checks both (round-seven review, item 3).
 */
async function runWithSecondRecord(h: Harness, second?: { provenance: ProvenanceType; type: string }) {
  const declared = await h.upload(h.alice, toyMap(standardDocument()));
  const notes = await h.upload(h.alice, new TextEncoder().encode('合成线索：引用条目自身的原文'), 'text/plain');
  const started = await h.service.startRun(h.alice, { pack: 'toy-review', product: 'Meadow', version: '3.2', inputs: { map: { reference: declared }, notes: [{ reference: notes }] } }, h.call());
  const current = (await h.service.getRun(h.alice, started.run!.run))!.run;
  if (second === undefined) return { run: current, notes, declared };
  const binding = current.sources.find(source => source.reference === declared)!;
  const real = (await h.kit.store.get<Record<string, unknown> & { sha256: string }>(binding.artifact!))!;
  const forged = await h.kit.store.put({
    kind: 'source_artifact', schema: RECORD_SCHEMAS.source_artifact, provenance: second.provenance,
    body: { ...real.body, name: 'second-record.json', provenance_type: second.type }, index: [{ key: 'artifact.sha256', value: real.body.sha256 }],
  });
  const { feeding_offset: _feedingOffset, ...base } = current;
  const run = RunRecord.parse({ ...base, run: newId('run'), sources: [...current.sources, { ...binding, artifact: forged.digest }] });
  await putRun(h.kit.store, run, current.started_at);
  return { run, notes, declared };
}

/** Submit c4 with a quotation, deep in slot data, of c4's own location; its top-level quote cites the notes. */
async function quoteOwnLocation(h: Harness, run: RunRecord, notes: string) {
  const c4 = run.items.find(item => item.id === ITEM.c4)!;
  const submission = {
    run: run.run, model: 'synthetic-model',
    items: run.items.map(item => ({ item: item.id, handling: 'handled', slots: { findings: item.id === ITEM.c4 ? [{
      text: '引用条目自身', code: 'edge_case_gap', rank: 'major', quotes: [{ reference: notes, text: '引用条目自身的原文' }],
      data: { expected_quote: { reference: c4.location, text: c4.label } },
    }] : [] } })),
    cross_item: [{ nature: 'judgment', statement: '一般', grounds: [], code: 'draft_level', rank: 'P4' }],
  };
  const answer = await h.service.submitResult(h.alice, submission, h.call());
  assert.equal(answer.acceptance, 'accepted', JSON.stringify(answer.errors));
  const row = Object.values(answer.result!.partitions).flat().find(it => it.item === ITEM.c4)!;
  const claims = row.requirements.find(requirement => requirement.requirement === 'findings')!.claims.map(claim => claim.statement);
  return claims.filter(statement => JSON.stringify(statement).includes(c4.location));
}

test('a quotation in slot data of an item\'s own location is graded as grounds, not taken from the text read for the item (round seven, item 3)', { skip }, async t => {
  const h = await openHarness(postgres, { dataQuotes: true }); t.after(() => h.close());
  const plain = await runWithSecondRecord(h);
  const supported = await quoteOwnLocation(h, plain.run, plain.notes);
  assert.ok(supported.some(statement => statement.verdict === 'support' && /逐字一致/.test(statement.text ?? '')), JSON.stringify(supported));
  // The exact phase reads every item's location as the judged object; the same text quoted as grounds must stand on records
  // whose grade is known.
  const unknown = await runWithSecondRecord(h, { provenance: 'declared', type: 'synthetic-unknown' });
  const refused = await quoteOwnLocation(h, unknown.run, unknown.notes);
  assert.ok(refused.length > 0, 'the quotation was checked');
  assert.ok(refused.every(statement => statement.verdict !== 'support'), JSON.stringify(refused));
  assert.ok(refused.some(statement => statement.verdict === 'refute' && /无法确定作根据的原件/.test(statement.text ?? '')), JSON.stringify(refused));
});

// Each case in a Hub of its own: a later upload of the same bytes would otherwise bind the newest record, the second one.
for (const second of [{ provenance: 'client_captured' as const, type: 'declared' }, { provenance: 'declared' as const, type: 'synthetic-unknown' }]) {
  test(`a bound record of provenance ${second.provenance} with ${second.type} in its body is no grounds (round seven, item 3)`, { skip }, async t => {
    const h = await openHarness(postgres); t.after(() => h.close());
    const ctx = createEngineContext({ records: h.kit, workflows: h.workflows, packs: h.packs, knowledge: h.knowledge, external: h.external });
    const { run, declared } = await runWithSecondRecord(h, second);
    const resolver = createResolver(ctx, await buildScope(ctx, run, h.review, h.alice, 'function'), 'function');
    const reference = `${declared}/json@1/p`;
    assert.equal((await resolver.resolve(reference)).ok, true, 'the first, verified record is read');
    const grounded = await resolver.resolve(reference, { grounds: true });
    assert.equal(grounded.ok, false);
    assert.match(JSON.stringify(grounded), /无法确定作根据的原件/);
  });
}

test('the quote search reads the record the run bound, not another readable record of the same bytes (round seven, item 3)', { skip }, async t => {
  const h = await openHarness(postgres); t.after(() => h.close());
  const bytes = toyMap(standardDocument());
  const own = await h.upload(h.alice, bytes);
  const started = await h.service.startRun(h.alice, { pack: 'toy-review', product: 'Meadow', version: '3.2', inputs: { map: { reference: own } } }, h.call());
  const current = (await h.service.getRun(h.alice, started.run!.run))!.run;
  const ctx = createEngineContext({ records: h.kit, workflows: h.workflows, packs: h.packs, knowledge: h.knowledge, external: h.external });
  const map = own.slice('src:'.length);
  const inMap = async (run: RunRecord) => (await (await buildScope(ctx, run, h.review, h.alice, 'function')).candidates()).filter(candidate => candidate.source === map);
  assert.ok((await inMap(current)).length > 0, 'the bound record is searched');
  // The same bytes as a record only another user can read, bound to the run in place of the runner's own record.
  const hidden = await h.kit.artifacts.ingest({
    bytes, mediaType: 'application/json', name: 'hidden.json',
    origin: { upload: { session: 'hidden-upload', message: null } }, author: { user: h.bob.id }, provenanceType: 'declared',
    visibility: { readers: [h.bob.id], admins: false, packs: [], shareable: false },
  });
  const { feeding_offset: _feedingOffset, ...base } = current;
  const rebound = RunRecord.parse({ ...base, run: newId('run'), sources: current.sources.map(source => source.reference === own ? { ...source, artifact: hidden.digest } : source) });
  await putRun(h.kit.store, rebound, current.started_at);
  assert.deepEqual(await inMap(rebound), [], 'the bound record is unreadable, so nothing is found in its bytes');
});

test('a generated source a run reads on its own authority stays on the chosen record when a newer one of the same bytes appears (round seven, item 3)', { skip }, async t => {
  const h = await openHarness(postgres); t.after(() => h.close());
  const declared = await h.upload(h.alice, toyMap(standardDocument()));
  const started = await h.service.startRun(h.alice, { pack: 'toy-review', product: 'Meadow', version: '3.2', inputs: { map: { reference: declared } } }, h.call());
  const current = (await h.service.getRun(h.alice, started.run!.run))!.run;
  const bytes = Buffer.from(JSON.stringify({ p: 'synthetic generated p', q: 'synthetic generated q' }));
  const generate = (name: string) => h.kit.artifacts.ingest({
    bytes, mediaType: 'application/json', name,
    origin: { generated: { generator: 'synthetic@1', inputs: [] } }, author: { user: null }, provenanceType: 'projected',
    visibility: { readers: [], admins: true, packs: [], shareable: false },
  });
  const first = await generate('generated-first.json');
  const template = current.sources.find(source => source.reference === declared)!;
  const { feeding_offset: _feedingOffset, ...base } = current;
  const legacy = RunRecord.parse({ ...base, run: newId('run'), sources: [...current.sources, { ...template, reference: `src:${first.body.sha256}`, artifact: undefined }] });
  await putRun(h.kit.store, legacy, current.started_at);
  const ctx = createEngineContext({ records: h.kit, workflows: h.workflows, packs: h.packs, knowledge: h.knowledge, external: h.external });
  const scope = await buildScope(ctx, legacy, h.review, h.alice, 'function');
  const resolver = createResolver(ctx, scope, 'function');
  assert.equal((await resolver.resolve(`src:${first.body.sha256}/json@1/p/p`)).ok, true);
  const second = await generate('generated-second.json');
  assert.notEqual(second.digest, first.digest);
  const later = await resolver.resolve(`src:${first.body.sha256}/json@1/p/q`, { grounds: true });
  assert.equal(later.ok, true, JSON.stringify(later));
  assert.equal((await scope.pinned!.choice(first.body.sha256)).records[0]?.digest, first.digest, 'the evaluation keeps the record it chose');
});
