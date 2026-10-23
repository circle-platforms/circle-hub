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
import { standardDocument, toyMap } from './testing/mindmap.ts';
import { reviewPack, writePack } from './testing/packs.ts';
import { openRetryHarness } from './testing/retry-harness.ts';

let postgres: TemporaryPostgres;
const skip = await sandboxSkip();
before(async () => { postgres = await startPostgres(); });
after(async () => { await postgres?.stop(); });

for (const mode of ['recover', 'exhaust', 'size', 'retain', 'hub-retain', 'binary']) test(`bound source ${mode}: retries, fixed reasons and stored unread sources`, { skip }, async () => {
  const h = await openRetryHarness(postgres);
  const root = await mkdtemp(join(tmpdir(), 'circle-hub-bound-retry-'));
  try {
    const spec = reviewPack(); spec.version = '1.0.1';
    spec.files['requirements.json'] = { json: { schema: 'requirements@1', requirements: [
      { ...h.review.requirements[0], checks: ['probe'] }, h.review.requirements[3],
    ] } };
    spec.files['checks.json'] = { json: { schema: 'checks@1', checks: [{ id: 'probe', applies: 'run', judges: 'subject', tier: 'advisory',
      function: { module: 'functions/probe.ts' }, reads: { roles: ['expected'], ...(mode === 'size' ? { max_bytes: 1 } : {}) } }] } };
    spec.files['functions/probe.ts'] = `export default input => input.subject.items.map(item => ({item:item.id, verdict:'support', tier:'advisory', statement:'合成来源核对', grounds:[], data:{ reasons:input.unread_sources.map(source=>source.reason), observed:Object.values(input.sources) }}));`;
    await h.workflows.add(await writePack(root, spec));
    const document = standardDocument(); document.groups = [{ ...document.groups[0], cases: [document.groups[0].cases[0]] }];
    if (mode === 'binary') h.external.put('toy:story:4021', {bytes:new Uint8Array([0,255,0,254]),mediaType:'application/octet-stream'});
    const source = await h.upload(h.alice, toyMap(document));
    const started = await h.service.startRun(h.alice, { pack: 'toy-review', product: 'Meadow', version: '10.6.1', build: 'Rel_MEADOW_10_6_1_7', inputs: { map: { reference: source } } }, h.call());
    assert.ok(started.run, JSON.stringify(started.errors)); const run = started.run;
    const bound = run.sources.find(source => source.external?.startsWith('toy:story:'))!;
    assert.ok(bound); const sha = /^src:([0-9a-f]{64})/.exec(bound.reference)![1];
    const original = h.kit.artifacts.source.bind(h.kit.artifacts); let reads = 0; let hubEvaluation = false;
    h.kit.artifacts.source = async (reader, digest, options) => {
      if (digest === sha) {
        reads++;
        if (mode === 'exhaust' || (mode === 'recover' && reads < 3)) throw new Error('SyntheticPrivateReadFailure');
      }
      const value = await original(reader, digest, options);
      if (digest === sha && value && (mode === 'retain' || mode === 'hub-retain' && hubEvaluation)) return { ...value, bytes: null, readTier: 'retain_only' };
      return value;
    };
    const answer = await h.service.submitResult(h.alice, { run: run.run, model: 'synthetic-model',
      items: run.items.map(item => ({ item: item.id, handling: 'handled', slots: { findings: [] } })),
      cross_item: [{ nature: 'judgment', statement: '一般', grounds: [], code: 'draft_level', rank: 'P4' }] }, h.call());
    assert.equal(answer.acceptance, 'accepted');
    const stored = (await h.service.getResult(h.alice, run.run))!;
    let checked = stored.result;
    if (mode === 'hub-retain') {
      reads = 0; hubEvaluation = true; const { runner: _, ...hubRun } = (await h.service.getRun(h.alice, run.run))!.run;
      checked = (await evaluate(createEngineContext({records:h.kit, workflows:h.workflows, packs:h.packs, knowledge:h.knowledge, external:h.external}), {run:{...hubRun, host:'hub', configurer:h.admin.id}, workflow:await h.workflows.byDigest(run.pack_digest).then(value=>value!), submission:null, submissionDigest:'a'.repeat(64), exact:null, carried:new Map(), roundsUsed:new Map(), origin:null, author:null, traceId:h.call().traceId})).result;
    }
    const claim = Object.values(checked.partitions).flat().flatMap(item => item.requirements).flatMap(requirement => requirement.claims).find(claim => claim.statement.data?.reasons)!;
    assert.ok(claim); assert.ok(!JSON.stringify(stored.result).includes('SyntheticPrivateReadFailure'));
    if (mode === 'recover') { assert.equal(reads, 3); assert.deepEqual(claim.statement.data?.reasons, []); assert.ok((claim.statement.data?.observed as unknown[]).length > 0); }
    else {
      assert.equal(reads, mode === 'exhaust' ? 3 : 1);
      const reason = mode.includes('retain') ? 'credential_unreadable' : mode === 'size' ? 'budget_exhausted' : mode === 'binary' ? 'missing_input' : 'check_error';
      assert.deepEqual(claim.statement.data?.reasons, mode === 'size' ? [reason, reason] : [reason]);
      assert.equal((claim.statement.data?.unread_sources as Array<{ reason: string }>)[0].reason, reason);
    }
    if (mode === 'exhaust') assert.ok(h.logs.some(entry => entry.detail.includes('SyntheticPrivateReadFailure')));
    if (mode.includes('retain')) {
      assert.match(JSON.stringify(claim.statement.data?.unread_sources), /管理员/);
      assert.match(JSON.stringify(claim.statement.data?.unread_sources), /接受/);
    }
    if (mode === 'recover' || mode === 'exhaust') {
      const actions = (await h.kit.store.find<ActionBody>({ key: INDEX.actionRun, value: run.run, kind: 'action' })).items;
      const action = actions.find(action => action.body.action === 'validate')!;
      const attempts = (action.body.detail.retry_attempts as Array<Record<string, unknown>>).filter(attempt => attempt.operation === 'read');
      assert.deepEqual(attempts.map(attempt => attempt.attempt), [1, 2, 3]);
      assert.deepEqual(attempts.map(attempt => attempt.delayMs), [50, 100, 0]);
    }
  } finally { await h.close(); await rm(root, { recursive: true, force: true }); }
});
