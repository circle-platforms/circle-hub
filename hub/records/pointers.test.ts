import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startPostgres } from '../testing/postgres.ts';
import type { TemporaryPostgres } from '../testing/postgres.ts';
import { openTestRecords } from '../testing/records.ts';
import type { MoveResult, Principal } from './api.ts';
import { sha256Hex } from './digest.ts';
import { AccessError } from './errors.ts';
import { newId } from './ids.ts';

let postgres: TemporaryPostgres;
before(async () => {
  postgres = await startPostgres();
});
after(async () => {
  await postgres?.stop();
});

const root = (label: string) => sha256Hex(`synthetic tree root ${label}`);

test('a pointer is created, moved by compare-and-set, and every move is a move_root action', async (t) => {
  const kit = await openTestRecords({ postgres });
  t.after(() => kit.close());
  const admin = (await kit.principals.bootstrapAdmin('管理员')).user;
  const by: Principal = { id: admin.id, name: admin.name, role: admin.role };
  const run = newId('run');
  const created = await kit.pointers.move({ name: 'knowledge/product-a', expected: null, next: root('a1'), by, run, component: 'knowledge.producer@1', note: '首次生产' });
  assert.equal(created.moved, true);
  if (!created.moved) return;
  assert.deepEqual({ ...created.pointer, moved_at: undefined }, { name: 'knowledge/product-a', target: root('a1'), version: 1, moved_at: undefined, action: created.action.digest });
  assert.equal(created.action.kind, 'action');
  assert.equal(created.action.schema, 'action@1');
  assert.equal(created.action.provenance, 'observed');
  assert.equal(created.action.body.action, 'move_root');
  assert.equal(created.action.body.result, 'completed');
  assert.equal(created.action.body.run, run);
  assert.equal(created.action.body.component, 'knowledge.producer@1');
  assert.deepEqual(created.action.body.inputs, [root('a1')]);
  assert.deepEqual(created.action.body.detail, {
    pointer: 'knowledge/product-a',
    expected: null,
    next: root('a1'),
    version: 1,
    previous_action: null,
    by: admin.id,
    note: '首次生产',
  });

  const moved = await kit.pointers.move({ name: 'knowledge/product-a', expected: root('a1'), next: root('a2') });
  assert.equal(moved.moved, true);
  if (moved.moved) {
    assert.equal(moved.pointer.version, 2);
    assert.deepEqual(moved.action.body.inputs, [root('a1'), root('a2')]);
    assert.equal(moved.action.body.component, 'records.pointers@1');
    assert.equal(moved.action.body.detail.version, 2);
    assert.equal(moved.action.body.detail.previous_action, created.action.digest);
  }
  // A stale expectation or a second creation is refused and writes nothing.
  const stale = await kit.pointers.move({ name: 'knowledge/product-a', expected: root('a1'), next: root('a3') });
  assert.deepEqual(stale.moved ? null : stale.current?.target, root('a2'));
  const again = await kit.pointers.move({ name: 'knowledge/product-a', expected: null, next: root('a3') });
  assert.equal(again.moved, false);
  const missing = await kit.pointers.move({ name: 'knowledge/absent', expected: root('x'), next: root('y') });
  assert.deepEqual(missing, { moved: false, current: null });
  assert.equal((await kit.pointers.get('knowledge/product-a'))?.target, root('a2'));
  const history = await kit.pointers.history('knowledge/product-a');
  assert.deepEqual(history.items.map((action) => action.body.detail.next), [root('a2'), root('a1')]);
  const oldestFirst = await kit.pointers.history('knowledge/product-a', { newestFirst: false, limit: 1 });
  assert.equal(oldestFirst.items[0].body.detail.next, root('a1'));
  assert.notEqual(oldestFirst.next, null);
  assert.equal((await kit.store.find({ key: 'action.run', value: run })).items.length, 1);
});

test('with a frozen clock a move that repeats an earlier one is still its own move_root action (B05 R[4])', async (t) => {
  const frozen = new Date('2026-10-21T08:00:00.000Z');
  const kit = await openTestRecords({ postgres, now: () => new Date(frozen) });
  t.after(() => kit.close());
  const moves: Array<[string | null, string]> = [
    [null, root('a')],
    [root('a'), root('b')],
    [root('b'), root('a')],
    [root('a'), root('b')],
  ];
  const actions: string[] = [];
  for (const [expected, next] of moves) {
    const result = await kit.pointers.move({ name: 'frozen', expected, next });
    assert.ok(result.moved);
    assert.equal((result.action as { created?: boolean }).created, true);
    assert.equal(result.pointer.action, result.action.digest);
    assert.equal(result.action.body.detail.previous_action, actions.at(-1) ?? null);
    actions.push(result.action.digest);
  }
  assert.equal((await kit.pointers.get('frozen'))?.version, 4);
  const history = await kit.pointers.history('frozen', { newestFirst: false });
  assert.deepEqual(history.items.map((action) => action.digest), actions);
  assert.deepEqual(history.items.map((action) => action.body.detail.version), [1, 2, 3, 4]);
});

test('parallel movers with the same expectation: exactly one wins, the rest see the winner', async (t) => {
  const kit = await openTestRecords({ postgres });
  t.after(() => kit.close());
  const creations = await Promise.all(Array.from({ length: 8 }, (_, index) => kit.pointers.move({ name: 'race', expected: null, next: root(`c${index}`) })));
  const creators = creations.filter((result) => result.moved);
  assert.equal(creators.length, 1);
  const base = (await kit.pointers.get('race'))?.target;
  assert.ok(base);
  for (const result of creations) if (!result.moved) assert.equal(result.current?.target, base);
  const results: MoveResult[] = await Promise.all(Array.from({ length: 12 }, (_, index) => kit.pointers.move({ name: 'race', expected: base, next: root(`m${index}`) })));
  const winners = results.filter((result) => result.moved);
  assert.equal(winners.length, 1);
  const winner = winners[0];
  assert.ok(winner.moved);
  for (const result of results) if (!result.moved) assert.equal(result.current?.target, winner.pointer.target);
  const state = await kit.pointers.get('race');
  assert.equal(state?.version, 2);
  assert.equal(state?.target, winner.pointer.target);
  assert.equal((await kit.pointers.history('race')).items.length, 2);
});

test('a move inside a transaction that fails leaves neither the move nor its action record', async (t) => {
  const kit = await openTestRecords({ postgres });
  t.after(() => kit.close());
  await kit.pointers.move({ name: 'tx', expected: null, next: root('t1') });
  await assert.rejects(
    kit.store.withTransaction(async (tx) => {
      const result = await kit.pointers.move({ name: 'tx', expected: root('t1'), next: root('t2') }, tx);
      assert.equal(result.moved, true);
      assert.equal((await kit.pointers.get('tx', tx))?.target, root('t2'));
      throw new Error('downstream failure');
    }),
    /downstream failure/,
  );
  assert.equal((await kit.pointers.get('tx'))?.target, root('t1'));
  assert.equal((await kit.pointers.history('tx')).items.length, 1);
});

test('names, digests, runs and the acting account are validated', async (t) => {
  const kit = await openTestRecords({ postgres });
  t.after(() => kit.close());
  const admin = (await kit.principals.bootstrapAdmin('管理员')).user;
  const member = await kit.principals.createUser(admin, '成员');
  await kit.principals.setDisabled(admin, member.id, true);
  for (const name of ['', 'Upper', '/leading', 'space name', 'x'.repeat(201)]) {
    await assert.rejects(kit.pointers.move({ name, expected: null, next: root('n') }), TypeError, name);
  }
  await assert.rejects(kit.pointers.move({ name: 'p', expected: null, next: 'not-a-digest' }), TypeError);
  await assert.rejects(kit.pointers.move({ name: 'p', expected: root('same'), next: root('same') }), TypeError);
  await assert.rejects(kit.pointers.move({ name: 'p', expected: null, next: root('n'), run: 'run_bad' }), TypeError);
  // component@major as contracts Versioned: no leading-zero major either.
  for (const component of ['NoVersion', 'records.pointers@01', 'Records@1', '@1', 'x@']) {
    await assert.rejects(kit.pointers.move({ name: 'p', expected: null, next: root('n'), component }), TypeError, component);
  }
  await assert.rejects(kit.pointers.move({ name: 'p', expected: null, next: root('n'), by: { id: member.id, name: member.name, role: 'user' } }), AccessError);
  await assert.rejects(kit.pointers.history('Bad Name'), TypeError);
  assert.equal(await kit.pointers.get('Bad Name'), null);
  assert.equal(await kit.pointers.get('p'), null);
});

test('an explicit same-target refresh compares the previous action and cannot overwrite another refresh', async (t) => {
  const kit=await openTestRecords({postgres});t.after(()=>kit.close());
  const initial=await kit.pointers.move({name:'knowledge/refresh',expected:null,next:root('stable')});assert.ok(initial.moved);
  const input={name:'knowledge/refresh',expected:root('stable'),next:root('stable'),refresh:true,expected_action:initial.pointer.action};
  const results=await Promise.all([kit.pointers.move(input),kit.pointers.move(input)]);
  assert.equal(results.filter(result=>result.moved).length,1);
  const current=await kit.pointers.get(input.name);assert.equal(current?.target,root('stable'));assert.equal(current?.version,2);assert.notEqual(current?.action,initial.pointer.action);
  assert.equal((await kit.pointers.history(input.name)).items.length,2);
  await assert.rejects(kit.pointers.move({...input,expected_action:undefined}),TypeError);
});
