import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { ItemResult, ValidationResult } from '../../../contracts/src/validation.ts';
import { startPostgres, type TemporaryPostgres } from '../../testing/postgres.ts';
import { openHarness, sandboxSkip, type Harness } from './testing/harness.ts';
import { ITEM, standardDocument, toyMap } from './testing/mindmap.ts';

let postgres: TemporaryPostgres;
let h: Harness;
let map: string;
const skip = await sandboxSkip();

before(async () => {
  postgres = await startPostgres();
  if (skip) return;
  // structure (a check on the target) carries a `*` repair row: it must never apply
  h = await openHarness(postgres, { review: { subjectRepair: true } });
  map = await h.upload(h.alice, toyMap(standardDocument()));
});
after(async () => {
  await h?.close();
  await postgres?.stop();
});

const IDS = [ITEM.c1, ITEM.c2, ITEM.c3, ITEM.c4];
const itemOf = (result: ValidationResult, id: string): { partition: string; item: ItemResult } => {
  for (const [partition, items] of Object.entries(result.partitions)) {
    const found = (items as ItemResult[]).find((i) => i.item === id);
    if (found) return { partition, item: found };
  }
  throw new Error(id);
};

test('a repair row never applies to a check on the target: the violation is delivered and no round is used (T03 R[4])', { skip }, async () => {
  const started = await h.service.startRun(h.alice, { pack: 'toy-review', product: 'Meadow', version: '3.2', inputs: { map: { reference: map } } }, h.call());
  assert.equal(started.call_result, 'ok', JSON.stringify(started.errors));
  const run = started.run!;
  assert.equal(run.requirements.find((r) => r.key === 'structure')?.repair_rounds, 1, 'the row is declared');
  for (const rank of ['P4', 'P5', 'P6']) {
    const answer = await h.service.submitResult(
      h.alice,
      {
        run: run.run,
        model: 'aster-7',
        items: IDS.map((id) => ({ item: id, handling: 'handled', slots: { findings: [] } })),
        cross_item: [{ nature: 'judgment', statement: '一般', grounds: [], code: 'draft_level', rank }],
      },
      h.call(),
    );
    assert.equal(answer.acceptance, 'accepted', JSON.stringify(answer.errors));
    const c4 = itemOf(answer.result!, ITEM.c4);
    assert.equal(c4.partition, 'delivered', rank);
    const structure = c4.item.requirements.find((r) => r.requirement === 'structure')!;
    assert.deepEqual(structure.layers, [{ layer: 'static', terminal: 'violation', code: 'core.structure.required_empty', tier: 'blocking', attribution: 'author_input' }], rank);
    assert.deepEqual(answer.errors, [], `${rank}: nothing is routed back to the model`);
    assert.deepEqual(answer.result!.rounds, { used: 0, max: 2 }, `${rank}: no round is used`);
  }
});
