import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { ValidationResult } from '../../../contracts/src/validation.ts';
import { startPostgres, type TemporaryPostgres } from '../../testing/postgres.ts';
import { sandboxSkip } from './testing/harness.ts';
import { ITEM, openLateWorld } from './testing/late-packs.ts';
import { actionsOf } from './store.ts';

let pg: TemporaryPostgres;
const skip = await sandboxSkip();
before(async () => { pg = await startPostgres(); });
after(async () => { await pg?.stop(); });

const plan = (result: ValidationResult, id: string) => Object.values(result.partitions).flat().find((row) => row.item === id)!.requirements.find((row) => row.requirement === 'plan')!;
async function validateActions(w: Awaited<ReturnType<typeof openLateWorld>>, run: string, submission: string) {
  return (await actionsOf(w.h.kit.store, run)).filter((action) => action.body.action === 'validate' && (action.body.detail as { submission?: string }).submission === submission).map((action) => action.body.detail as { repair?: string[]; late?: unknown; result?: string });
}

test('each submission reads the latest accepted stage result, binds it, and a wait on it is no repair round', { skip }, async () => {
  const w = await openLateWorld(pg);
  try {
    const stage = await w.startStage();
    const first = await w.submitStage(stage.run, [ITEM.one]);
    const consume = (await w.startConsume({ run: stage.run })).run!;

    const c1 = await w.submitConsume(consume.run);
    assert.equal(c1.acceptance, 'accepted', JSON.stringify(c1.errors));
    const r1 = c1.result!;
    assert.deepEqual(r1.locks.late?.inputs, [{ slot: 'stage', run: stage.run, reference: 'rec:' + first.record }]);
    assert.match(r1.locks.late?.refresh ?? '', /^[0-9a-f]{64}$/);
    assert.equal(plan(r1, ITEM.one).status, 'satisfied');
    assert.equal(plan(r1, ITEM.two).status, 'pending');
    assert.equal(plan(r1, ITEM.two).layers[0].reason, 'awaiting_step');
    assert.ok(plan(r1, ITEM.one).claims.length > 0 && plan(r1, ITEM.one).claims.every((claim) => claim.validity.bound.includes(first.record)), 'the claims are bound to the stage result read');
    const waiting = r1.errors.find((error) => error.item === ITEM.two && error.requirement === 'plan');
    assert.equal(waiting?.code, 'awaiting_step');
    assert.equal(waiting?.rounds_left, 2, 'the wait leaves every round');
    const [action] = await validateActions(w, consume.run, r1.submission);
    assert.deepEqual(action.repair, [], 'a requirement that only waits is not a repair round');
    assert.deepEqual(action.late, r1.locks.late!.inputs);

    const c2 = await w.submitConsume(consume.run, '合成计划修订');
    assert.equal(c2.acceptance, 'accepted', JSON.stringify(c2.errors));
    assert.equal(c2.result!.rounds.used, 0);

    const second = await w.submitStage(stage.run, [ITEM.one, ITEM.two]);
    const again = await w.submitConsume(consume.run);
    assert.equal(again.acceptance, 'accepted', JSON.stringify(again.errors));
    assert.equal(again.result!.submission, r1.submission);
    assert.deepEqual(again.result!.locks.late?.inputs, [{ slot: 'stage', run: stage.run, reference: 'rec:' + second.record }]);
    assert.equal(plan(again.result!, ITEM.one).status, 'satisfied');
    assert.equal(plan(again.result!, ITEM.two).status, 'satisfied');
    assert.equal(again.result!.rounds.used, 0);

    const cached = await w.submitConsume(consume.run);
    assert.equal(cached.acceptance, 'accepted', JSON.stringify(cached.errors));
    assert.equal(cached.result!.trace, again.result!.trace, 'the same submission against the same stage result is not checked again');

    const third = await w.submitStage(stage.run, [ITEM.one, ITEM.two], '合成重组记录修订');
    const rechecked = await w.submitConsume(consume.run);
    assert.equal(rechecked.acceptance, 'accepted', JSON.stringify(rechecked.errors));
    assert.notEqual(rechecked.result!.trace, again.result!.trace);
    assert.deepEqual(rechecked.result!.locks.late?.inputs, [{ slot: 'stage', run: stage.run, reference: 'rec:' + third.record }]);
  } finally { await w.close(); }
});

test('a stage result the run reads may be cited; one it did not read is out of scope', { skip }, async () => {
  const w = await openLateWorld(pg);
  try {
    const stage = await w.startStage();
    const first = await w.submitStage(stage.run, [ITEM.one]);
    const consume = (await w.startConsume({ run: stage.run })).run!;
    const cited = await w.submitConsume(consume.run, '合成计划', { grounds: ['rec:' + first.record] });
    assert.equal(cited.acceptance, 'accepted', JSON.stringify(cited.errors));
    await w.submitStage(stage.run, [ITEM.one, ITEM.two]);
    const stale = await w.submitConsume(consume.run, '合成计划', { grounds: ['rec:' + first.record] });
    assert.equal(stale.acceptance, 'not_accepted', 'the older stage result is no longer what the run reads');
    assert.ok(stale.result?.locks.late?.inputs[0].reference !== 'rec:' + first.record);
  } finally { await w.close(); }
});

test('a refresh function that fails leaves every check unknown, records no overlay and charges no round', { skip }, async () => {
  const w = await openLateWorld(pg, [{ id: 'toy-broken', refresh: "export default function refresh(): unknown {\n  throw new Error('合成刷新失败');\n}\n" }]);
  try {
    const stage = await w.startStage();
    await w.submitStage(stage.run, [ITEM.one, ITEM.two]);
    const consume = await w.startConsume({ run: stage.run }, { pack: 'toy-broken' });
    assert.equal(consume.call_result, 'ok', JSON.stringify(consume.errors));
    const answer = await w.submitConsume(consume.run!.run);
    assert.equal(answer.acceptance, 'accepted', JSON.stringify(answer.errors));
    const result = answer.result!;
    assert.equal(result.locks.late?.refresh, null);
    for (const id of [ITEM.one, ITEM.two]) {
      assert.equal(plan(result, id).status, 'pending');
      const error = result.errors.find((row) => row.item === id && row.requirement === 'plan');
      assert.equal(error?.code, 'check_error');
      assert.match(error?.message ?? '', /覆盖值/);
    }
    const [action] = await validateActions(w, consume.run!.run, result.submission);
    assert.deepEqual(action.repair, []);
  } finally { await w.close(); }
});

test('a stage run that has accepted nothing yet is named as the missing fact the refresh function and the check see', { skip }, async () => {
  const w = await openLateWorld(pg);
  try {
    const stage = await w.startStage();
    const consume = (await w.startConsume({ run: stage.run })).run!;
    const answer = await w.submitConsume(consume.run);
    assert.equal(answer.acceptance, 'accepted', JSON.stringify(answer.errors));
    assert.deepEqual(answer.result!.locks.late?.inputs, [{ slot: 'stage', run: stage.run, missing: '运行 ' + stage.run + ' 还没有已受理提交' }]);
    for (const id of [ITEM.one, ITEM.two]) {
      assert.equal(plan(answer.result!, id).layers[0].reason, 'awaiting_step');
      assert.match(answer.result!.errors.find((row) => row.item === id)?.message ?? '', /还没有已受理提交/);
    }
  } finally { await w.close(); }
});
