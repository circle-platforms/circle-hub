import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startPostgres, type TemporaryPostgres } from '../../testing/postgres.ts';
import { sandboxSkip } from './testing/harness.ts';
import { ITEM, openLateWorld } from './testing/late-packs.ts';

let pg: TemporaryPostgres;
const skip = await sandboxSkip();
before(async () => { pg = await startPostgres(); });
after(async () => { await pg?.stop(); });

test('a stage run without any accepted submission is bound by its run alone; the projection sees which run, never a result', { skip }, async () => {
  const w = await openLateWorld(pg);
  try {
    const stage = await w.startStage();
    const answer = await w.startConsume({ run: stage.run });
    assert.equal(answer.call_result, 'ok', JSON.stringify(answer.errors));
    const run = answer.run!;
    assert.deepEqual(run.late_inputs, [{ slot: 'stage', run: stage.run }]);
    assert.equal(run.sources.some((source) => source.slot === 'stage'), false, 'the slot binds no source at start');
    assert.equal(run.input_defaults, undefined, 'and no result reference is frozen');
    assert.deepEqual(run.items.map((item) => item.id), [ITEM.one, ITEM.two]);
    for (const item of run.items) {
      assert.deepEqual(item.fields.bound_after_start, [{ slot: 'stage', run: stage.run }], 'the projection context names the slot and the run only');
      assert.deepEqual(item.fields.slots_seen, ['cases'], 'and the projection inputs do not include the slot');
    }
    const stored = (await w.h.service.getRun(w.h.alice, run.run))!.run;
    assert.deepEqual(stored.late_inputs, [{ slot: 'stage', run: stage.run }]);
  } finally { await w.close(); }
});

test('an omitted required slot follows the predecessor lineage and is marked defaulted', { skip }, async () => {
  const w = await openLateWorld(pg);
  try {
    const stage = await w.startStage();
    const answer = await w.startConsume(undefined, { predecessor: stage.run });
    assert.equal(answer.call_result, 'ok', JSON.stringify(answer.errors));
    assert.deepEqual(answer.run!.late_inputs, [{ slot: 'stage', run: stage.run, defaulted: true }]);
  } finally { await w.close(); }
});

test('an explicit rec: binding of the same slot is frozen as before', { skip }, async () => {
  const w = await openLateWorld(pg);
  try {
    const stage = await w.startStage();
    const accepted = await w.submitStage(stage.run, [ITEM.one]);
    const answer = await w.startConsume({ reference: 'rec:' + accepted.record });
    assert.equal(answer.call_result, 'ok', JSON.stringify(answer.errors));
    assert.equal(answer.run!.late_inputs, undefined);
    assert.equal(answer.run!.sources.find((source) => source.slot === 'stage')?.reference, 'rec:' + accepted.record);
  } finally { await w.close(); }
});

test('a run another account holds, a run of another workflow and a run of the binding workflow itself are refused at the slot', { skip }, async () => {
  const w = await openLateWorld(pg, [{ id: 'toy-self', from: 'toy-self', required: false }]);
  try {
    w.h.workflows.assign(w.h.bob.id, 'toy-stage');
    const bobs = await w.h.service.startRun(w.h.bob, { pack: 'toy-stage', inputs: { cases: { reference: await w.h.upload(w.h.bob, new TextEncoder().encode(JSON.stringify({ cases: [{ id: 'c9', title: '乙的合成用例' }] }))) } } }, w.h.call('bob-session'));
    assert.equal(bobs.call_result, 'ok', JSON.stringify(bobs.errors));
    const hidden = await w.startConsume({ run: bobs.run!.run });
    assert.equal(hidden.call_result, 'error');
    assert.ok(hidden.errors.some((error) => error.path === '/inputs/stage' && /不存在或当前用户不可见/.test(error.message)), JSON.stringify(hidden.errors));

    const stage = await w.startStage();
    const consume = await w.startConsume({ run: stage.run });
    assert.equal(consume.call_result, 'ok', JSON.stringify(consume.errors));
    const other = await w.startConsume({ run: consume.run!.run });
    assert.equal(other.call_result, 'error');
    const wrong = other.errors.find((error) => error.path === '/inputs/stage');
    assert.ok(wrong && wrong.message.includes('toy-consume') && wrong.message.includes('toy-stage'), JSON.stringify(other.errors));

    const first = await w.startConsume(undefined, { pack: 'toy-self' });
    assert.equal(first.call_result, 'ok', JSON.stringify(first.errors));
    const self = await w.startConsume({ run: first.run!.run }, { pack: 'toy-self' });
    assert.equal(self.call_result, 'error');
    const own = self.errors.find((error) => error.path === '/inputs/stage');
    assert.ok(own && /自己的运行/.test(own.message) && own.fix?.includes('predecessor'), JSON.stringify(self.errors));

    const many = await w.startConsume([{ run: stage.run }, { run: stage.run }]);
    assert.equal(many.call_result, 'error');
  } finally { await w.close(); }
});
