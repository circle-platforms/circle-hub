import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startPostgres, type TemporaryPostgres } from '../../testing/postgres.ts';
import { newId } from '../../records/api.ts';
import { RunRecord } from '../../../contracts/src/run.ts';
import { createEngineContext } from './deps.ts';
import { buildScope, createResolver } from './exact.ts';
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
