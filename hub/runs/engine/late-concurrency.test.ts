import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { ValidationResult } from '../../../contracts/src/validation.ts';
import { startPostgres, type TemporaryPostgres } from '../../testing/postgres.ts';
import { sandboxSkip } from './testing/harness.ts';
import { ITEM, openLateWorld } from './testing/late-packs.ts';

let pg: TemporaryPostgres;
const skip = await sandboxSkip();
before(async () => { pg = await startPostgres(); });
after(async () => { await pg?.stop(); });

const plan = (result: ValidationResult, id: string) => Object.values(result.partitions).flat().find((row) => row.item === id)!.requirements.find((row) => row.requirement === 'plan')!;
const turns = async (n: number) => { for (let i = 0; i < n; i++) await new Promise((resolve) => setImmediate(resolve)); };

test('submissions of one run are serialized, a stage result accepted meanwhile reaches the next one, and the export does not wait', { skip, timeout: 120_000 }, async () => {
  const w = await openLateWorld(pg);
  try {
    const stage = await w.startStage();
    const first = await w.submitStage(stage.run, [ITEM.one]);
    const consume = (await w.startConsume({ run: stage.run })).run!;
    const principals = w.h.kit.principals as unknown as { list: (...args: unknown[]) => Promise<unknown> };
    const list = principals.list;
    let entered!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let armed = true;
    principals.list = async function (this: unknown, ...args: unknown[]) {
      if (armed) { armed = false; entered(); await gate; }
      return list.apply(principals, args);
    };
    try {
      const c1 = w.submitConsume(consume.run);
      await reached;
      const second = await w.submitStage(stage.run, [ITEM.one, ITEM.two]);
      const exported = await w.h.service.exportLate!(w.h.alice, consume.run);
      assert.ok(exported?.ok);
      assert.deepEqual(exported.body.late.inputs, [{ slot: 'stage', run: stage.run, reference: 'rec:' + second.record }]);
      let c2done = false;
      const c2 = w.submitConsume(consume.run, '合成计划修订').then((answer) => { c2done = true; return answer; });
      await turns(20);
      assert.equal(c2done, false, 'the second submission waits for the first validation of the same run');
      release();
      const [a1, a2] = await Promise.all([c1, c2]);
      assert.equal(a1.acceptance, 'accepted', JSON.stringify(a1.errors));
      assert.equal(a2.acceptance, 'accepted', JSON.stringify(a2.errors));
      assert.deepEqual(a1.result!.locks.late?.inputs, [{ slot: 'stage', run: stage.run, reference: 'rec:' + first.record }], 'the first validation keeps the stage result it resolved');
      assert.equal(plan(a1.result!, ITEM.two).status, 'pending');
      assert.deepEqual(a2.result!.locks.late?.inputs, [{ slot: 'stage', run: stage.run, reference: 'rec:' + second.record }], 'the next one reads the newer stage result');
      assert.equal(plan(a2.result!, ITEM.two).status, 'satisfied');
      assert.equal((await w.h.service.getResult(w.h.alice, consume.run))!.result.submission, a2.result!.submission, 'the run\u2019s latest accepted result is the later one');
    } finally {
      principals.list = list;
      release();
    }
  } finally { await w.close(); }
});
