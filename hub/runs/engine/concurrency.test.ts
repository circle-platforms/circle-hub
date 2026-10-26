import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { ActionBody } from '../../records/api.ts';
import { startPostgres, type TemporaryPostgres } from '../../testing/postgres.ts';
import { INDEX } from './store.ts';
import { openHarness, sandboxSkip, type Harness } from './testing/harness.ts';
import { ITEM, standardDocument, toyMap } from './testing/mindmap.ts';
import { createKeyedLock } from './util.ts';

let postgres: TemporaryPostgres;
let h: Harness;
let map: string;
const skip = await sandboxSkip();

before(async () => {
  postgres = await startPostgres();
  if (skip) return;
  h = await openHarness(postgres);
  map = await h.upload(h.alice, toyMap(standardDocument()));
});
after(async () => {
  await h?.close();
  await postgres?.stop();
});

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

test('the keyed lock runs one holder per key at a time, others in parallel, and a failing holder releases it', async () => {
  const lock = createKeyedLock();
  const events: string[] = [];
  let inside = 0;
  let most = 0;
  const hold = (key: string, name: string, fail = false) =>
    lock(key, async () => {
      inside++;
      most = Math.max(most, inside);
      events.push(`${name}+`);
      await tick();
      await tick();
      events.push(`${name}-`);
      inside--;
      if (fail) throw new Error(name);
      return name;
    });
  const results = await Promise.allSettled([hold('a', 'a1'), hold('a', 'a2', true), hold('a', 'a3'), hold('b', 'b1')]);
  assert.deepEqual(results.map((r) => (r.status === 'fulfilled' ? r.value : 'failed')), ['a1', 'failed', 'a3', 'b1']);
  // on key a every holder leaves before the next one enters; b ran beside them
  const a = events.filter((e) => e.startsWith('a'));
  assert.deepEqual(a, ['a1+', 'a1-', 'a2+', 'a2-', 'a3+', 'a3-']);
  assert.equal(most, 2);
  assert.equal(await hold('a', 'a4'), 'a4', 'the key is free again after a failure');
});

test('concurrent identical submissions give one stored submission, one result and one validate action', { skip }, async () => {
  const started = await h.service.startRun(h.alice, { pack: 'toy-review', product: 'Meadow', version: '3.2', inputs: { map: { reference: map } } }, h.call());
  const run = started.run!;
  const args = {
    run: run.run,
    model: 'aster-7',
    items: [ITEM.c1, ITEM.c2, ITEM.c3, ITEM.c4].map((id) => ({ item: id, handling: 'handled', slots: { findings: [] } })),
    cross_item: [{ nature: 'judgment', statement: '一般', grounds: [], code: 'draft_level', rank: 'P4' }],
  };
  const answers = await Promise.all(Array.from({ length: 6 }, () => h.service.submitResult(h.alice, structuredClone(args), h.call())));
  for (const answer of answers) assert.deepEqual(answer, answers[0]);
  assert.equal(answers[0].acceptance, 'accepted');
  const count = async (key: string, kind: 'submission' | 'validation_result' | 'action') => (await h.kit.store.find({ key, value: run.run, kind })).items;
  assert.equal((await count(INDEX.submissionRun, 'submission')).length, 1);
  assert.equal((await count(INDEX.resultRun, 'validation_result')).length, 1);
  assert.equal((await count(INDEX.actionRun, 'action')).filter((a) => (a.body as ActionBody).action === 'validate').length, 1);
});

test('concurrent starts under one client key give one run', { skip }, async () => {
  const request = { pack: 'toy-review', product: 'Meadow', version: '3.2', inputs: { map: { reference: map } }, client_key: 'parallel-1' };
  const answers = await Promise.all(Array.from({ length: 5 }, () => h.service.startRun(h.alice, structuredClone(request), h.call())));
  const ids = new Set(answers.map((a) => a.run?.run));
  assert.equal(ids.size, 1, JSON.stringify(answers.map((a) => a.errors)));
  const keyed = await h.kit.store.find({ key: INDEX.runClientKey, value: `${h.alice.id}:parallel-1`, kind: 'run' });
  assert.equal(keyed.items.length, 1);
});
