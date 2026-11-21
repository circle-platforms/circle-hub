import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startPostgres, type TemporaryPostgres } from '../../testing/postgres.ts';
import { recheckEffectChecks } from './recheck-effect.ts';
import { putResult } from './store.ts';
import { sandboxSkip } from './testing/harness.ts';
import { ITEM, openLateWorld } from './testing/late-packs.ts';

let pg: TemporaryPostgres;
const skip = await sandboxSkip();
before(async () => { pg = await startPostgres(); });
after(async () => { await pg?.stop(); });

test('a replay reads the recorded stage result and refuses an overlay digest it cannot reproduce', { skip }, async () => {
  const w = await openLateWorld(pg);
  try {
    const stage = await w.startStage();
    const first = await w.submitStage(stage.run, [ITEM.one]);
    const consume = (await w.startConsume({ run: stage.run })).run!;
    const answer = await w.submitConsume(consume.run);
    assert.equal(answer.acceptance, 'accepted', JSON.stringify(answer.errors));
    const stored = (await w.h.service.getResult(w.h.alice, consume.run))!;
    assert.deepEqual(stored.result.locks.late?.inputs, [{ slot: 'stage', run: stage.run, reference: 'rec:' + first.record }]);
    await w.submitStage(stage.run, [ITEM.one, ITEM.two]);
    const deps = { records: w.h.kit, workflows: w.h.workflows, packs: w.h.packs, knowledge: w.h.knowledge, external: w.h.external, sandbox: { requireOsIsolation: false } };
    const input = { run: consume.run, submission: stored.result.submission, result: stored.record, checks: ['aligned'] };
    const replay = await recheckEffectChecks(deps, input);
    const byItem = new Map(replay.aligned.map((outcome) => [outcome.item, outcome]));
    assert.equal(byItem.get(ITEM.one)?.verdict, 'support');
    assert.equal(byItem.get(ITEM.two)?.verdict, 'unknown');
    assert.equal(byItem.get(ITEM.two)?.reason, 'awaiting_step');
    const forged = await putResult(w.h.kit.store, { ...stored.result, locks: { ...stored.result.locks, late: { ...stored.result.locks.late!, refresh: '0'.repeat(64) } } }, new Date().toISOString());
    await assert.rejects(recheckEffectChecks(deps, { ...input, result: forged.digest }), /重放的晚绑定覆盖与记录不符/);
  } finally { await w.close(); }
});
