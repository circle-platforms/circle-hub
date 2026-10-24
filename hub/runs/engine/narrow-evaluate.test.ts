import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { ActionBody } from '../../records/api.ts';
import { startPostgres, type TemporaryPostgres } from '../../testing/postgres.ts';
import { createEngineContext } from './deps.ts';
import { evaluate } from './evaluate.ts';
import { INDEX } from './store.ts';
import { sandboxSkip } from './testing/harness.ts';
import { openRetryHarness } from './testing/retry-harness.ts';
import { standardDocument, toyMap } from './testing/mindmap.ts';
import { reviewPack, writePack } from './testing/packs.ts';

let postgres: TemporaryPostgres;
const skip = await sandboxSkip();
before(async () => { postgres = await startPostgres(); });
after(async () => { await postgres?.stop(); });
const root = 'a'.repeat(64);
const index = (patch = {}) => ({ schema: 'index-view@1', product: 'sample', build: { build: 'build', root }, kind: 'case', key: 'topic', keys: { alpha: [] }, entries: {}, total_keys: 1, total_entries: 0, truncated: false, skipped: 0, notes: [], ...patch });
for (const mode of ['complete', 'missing', 'truncated', 'retain', 'unavailable', 'unread-refute', 'refute'] as const) test(`item-key reads construct subjects and persist graded receipts: ${mode}`, { skip }, async () => {
  const h = await openRetryHarness(postgres); const dir = await mkdtemp(join(tmpdir(), 'circle-hub-narrow-'));
  try {
    const spec = reviewPack(); spec.version = '1.0.1';
    spec.files['requirements.json'] = { json: { schema: 'requirements@1', requirements: [{ ...h.review.requirements[0], checks: ['probe'] }, h.review.requirements[3]] } };
    spec.files['checks.json'] = { json: { schema: 'checks@1', checks: [{ id: 'probe', applies: 'item', judges: 'subject', tier: 'advisory', catalog: 'commands@1',
      subject: { module: 'functions/subject.ts' }, function: { module: 'functions/probe.ts' },
      reads: { roles: ['expected'], types: ['knowledge:index'], narrow: { slot: 'lookup', key_path: '/keys', into: '/lookup', max_keys: 5, max_entries: 10 } } }] } };
    spec.files['functions/subject.ts'] = `export default input => ({item:input.item.id, keys:['alpha'], catalog_count:input.catalog?.length??0, lookup:'stale'});`;
    spec.files['functions/probe.ts'] = `export default input => [{item:input.subject.item, verdict:${JSON.stringify((mode === 'refute' || mode === 'unread-refute') ? 'refute' : 'support')}, ${(mode === 'refute' || mode === 'unread-refute') ? "code:'toy-review.synthetic_duplicate'," : ''} statement:'合成核对', tier:'advisory', grounds:[], data:{lookup:input.subject.lookup, catalog_count:input.subject.catalog_count, sources:Object.keys(input.sources)}}];`;
    await h.workflows.add(await writePack(dir, spec));
    const document = standardDocument(); document.groups = [{ ...document.groups[0], cases: [document.groups[0].cases[0]] }];
    const source = await h.upload(h.alice, toyMap(document));
    const started = await h.service.startRun(h.alice, { pack: 'toy-review', product: 'Meadow', version: '10.6.1', build: 'Rel_MEADOW_10_6_1_7', inputs: { map: { reference: source } } }, h.call());
    assert.ok(started.run, JSON.stringify(started.errors));
    const { runner: _, ...run } = (await h.service.getRun(h.alice, started.run.run))!.run;
    const bound = await h.upload(h.alice, Buffer.from(JSON.stringify(index())));
    const binding = { reference: bound, role: 'expected' as const, slot: 'lookup', external: `knowledge:index:sample:build?kind=case&key=topic@${root}` };
    let reads = 0;
    h.external.read = async (id, context) => {
      reads++; assert.equal(id, binding.external.replace(`@${root}`, `&only=alpha@${root}`)); assert.equal(context.principal.id, h.alice.id);
      if (mode === 'unavailable' || mode === 'unread-refute') return { ok: false, id, reason: 'private synthetic failure' };
      const bytes = Buffer.from(JSON.stringify(index(mode === 'missing' ? { keys: {} } : { truncated: mode === 'truncated' || mode === 'refute' })));
      const artifact = await h.kit.artifacts.ingest({ bytes, mediaType: 'application/json', origin: { read: { object: id } }, author: { user: null }, provenanceType: 'observed', visibility: { readers: [h.alice.id], admins: true, packs: [], shareable: false }, name: '合成收窄视图' });
      if (mode === 'retain') {
        const original = h.kit.artifacts.source.bind(h.kit.artifacts);
        h.kit.artifacts.source = async (reader, sha, options) => { const value = await original(reader, sha, options); return sha === artifact.body.sha256 && value ? { ...value, bytes: null, readTier: 'retain_only' } : value; };
      }
      return { ok: true, id, revision: root, artifacts: [{ name: 'original', artifact }], manifest: 'b'.repeat(64) };
    };
    const checked = await evaluate(createEngineContext({ records: h.kit, workflows: h.workflows, packs: h.packs, knowledge: h.knowledge, external: h.external }), {
      run: { ...run, runner: h.alice.id, sources: [...run.sources, binding] }, workflow: (await h.workflows.byDigest(run.pack_digest))!, submission: null,
      submissionDigest: 'd'.repeat(64), exact: null, carried: new Map(), roundsUsed: new Map(), origin: null, author: null, traceId: h.call().traceId,
    });
    const claim = Object.values(checked.result.partitions).flat().flatMap(item => item.requirements).flatMap(requirement => requirement.claims).find(claim => claim.statement.data?.read_manifest)!;
    assert.ok(claim); assert.equal(reads, 1); assert.equal(claim.statement.verdict, mode === 'complete' ? 'support' : mode === 'refute' ? 'refute' : 'unknown');
    if (!['retain', 'unavailable', 'unread-refute'].includes(mode)) assert.ok((claim.statement.data?.catalog_count as number) > 0);
    const receipts = (await h.kit.store.find<ActionBody>({ key: INDEX.actionRun, value: run.run, kind: 'action' })).items.filter(action => action.body.action === 'read');
    assert.equal(receipts.length, 1); assert.deepEqual(receipts[0].body.detail.keys, ['alpha']); assert.equal(receipts[0].body.detail.slot, 'lookup');
    assert.equal(claim.statement.data?.read_manifest, `rec:${receipts[0].digest}`);
    if (mode !== 'complete') {
      const unread = claim.statement.data?.unread_sources as Array<{missing_fact:string;next_action:string}>;
      if (mode !== 'refute') {
        const requirement = Object.values(checked.result.partitions).flat().flatMap(item => item.requirements).find(requirement => requirement.claims.includes(claim))!;
        assert.ok(requirement.layers.some(layer => typeof layer.missing === 'string' && layer.missing.includes('下一步')), JSON.stringify(requirement.layers));
      }
      assert.ok(unread.length); assert.ok(unread.every(row => row.missing_fact && row.next_action));
      assert.ok(!JSON.stringify(claim).includes('private synthetic failure'));
    }
  } finally { await h.close(); await rm(dir, { recursive: true, force: true }); }
});
