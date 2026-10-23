// A pack check that fails to generate or read back its artifact answers unknown(output_failed) (P05 R[0]: the core has
// no generation step of its own, so the pack generates inside the check). The outcome stays valid — the requirement's
// static layer lands incomplete with reason output_failed and the item goes unfinished. A reason outside the list is
// still invalid: the check's output is rejected and the requirement turns unknown(check_error), the item unchecked.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startPostgres, type TemporaryPostgres } from '../../testing/postgres.ts';
import { openHarness, sandboxSkip, type Harness, type HarnessOptions } from './testing/harness.ts';
import { standardDocument, toyMap, ITEM } from './testing/mindmap.ts';

let postgres: TemporaryPostgres;
const skip = await sandboxSkip();

before(async function beforeHook() {
  postgres = await startPostgres();
});
after(async function afterHook() {
  await postgres?.stop();
});

const submitAll = async (h: Harness, map: string) => {
  const run = (await h.service.startRun(h.alice, { pack: 'toy-review', product: 'Meadow', version: '3.2', inputs: { map: { reference: map } } }, h.call())).run!;
  const answer = await h.service.submitResult(
    h.alice,
    {
      run: run.run,
      model: 'aster-7',
      items: [ITEM.c1, ITEM.c2, ITEM.c3, ITEM.c4].map((id) => ({ item: id, handling: 'handled', slots: { findings: [] } })),
      cross_item: [{ nature: 'judgment', statement: '一般', grounds: [], code: 'draft_level', rank: 'P4' }],
    },
    h.call(),
  );
  assert.equal(answer.acceptance, 'accepted', JSON.stringify(answer.errors));
  return answer;
};

test('output_failed keeps the requirement incomplete with that reason and the item unfinished', { skip }, async (t) => {
  const h = await openHarness(postgres, { review: { dynamicFindings: true }, fragile: 'output_failed' });
  t.after(() => h.close());
  const map = await h.upload(h.alice, toyMap(standardDocument()));
  const answer = await submitAll(h, map);
  const rows = [...(answer.result!.partitions.incomplete ?? []), ...(answer.result!.partitions.unfinished ?? [])];
  assert.ok(rows.length > 0, JSON.stringify(Object.keys(answer.result!.partitions)));
  const fragile = rows.flatMap((row) => row.requirements).find((r) => r.requirement === 'fragile');
  assert.ok(fragile !== undefined, JSON.stringify(rows.map((r) => r.requirements.map((x) => x.requirement))));
  const layer = fragile.layers.find((l) => l.layer === 'static')!;
  assert.equal(layer.terminal, 'incomplete');
  assert.equal(layer.reason, 'output_failed');
});

test('a reason outside the list still turns the check invalid (the old behaviour)', { skip }, async (t) => {
  const h = await openHarness(postgres, { review: { dynamicFindings: true }, fragile: 'bogus_reason' });
  t.after(() => h.close());
  const map = await h.upload(h.alice, toyMap(standardDocument()));
  const answer = await submitAll(h, map);
  const rows = Object.values(answer.result!.partitions).flat();
  const fragile = rows.flatMap((row) => row.requirements).find((r) => r.requirement === 'fragile');
  assert.ok(fragile !== undefined);
  const layer = fragile.layers.find((l) => l.layer === 'static')!;
  assert.equal(layer.terminal, 'unchecked');
  assert.equal(layer.reason, 'check_error');
});

void ({} as HarnessOptions);
