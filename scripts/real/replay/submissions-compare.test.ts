// The comparison of a recorded and a replayed validation result: only the listed normalizations are applied, each is counted,
// and every other difference (down to one word of one message) is reported under its field. Synthetic results only.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { compareResults, describeDiff, groupDiffs, normalizationRules, stable, type Json } from './submissions-compare.ts';

const result = (): { [key: string]: Json } => ({
  schema: 'validation@1',
  run: 'run_00000000000000000000000001',
  submission: 'a'.repeat(64),
  acceptance: 'not_accepted',
  errors: [
    { code: 'case.rule_broken', message: '第一条消息', fix: '改法一', item: 'i1', path: '/items/0', requirement: 'r1', rounds_left: 2 },
    { code: 'missing_input', message: '缺少输入', item: 'i2', path: '/items/1', requirement: 'r2' },
  ],
  rounds: { used: 0, max: 2 },
  partitions: {
    delivered: [],
    incomplete: [
      {
        item: 'i2',
        requirements: [{ requirement: 'r2', status: 'unsatisfied', layers: [{ layer: 'static', terminal: 'unchecked', exit: { due: '2026-11-17T03:43:15.911Z', who: 'admin' } }] }],
      },
    ],
    quarantined: [],
    rejected: [{ item: 'i1', requirements: [] }],
  },
  cross_item: [{ kind: 'premise', text: '一条跨条目判断' }],
  coverage: { complete: false, examined: 0, total: 2, note: '提交未受理，没有分区' },
  locks: { pack: 'demo@1.0.0', pack_digest: 'b'.repeat(64), root: 'c'.repeat(64) },
  trace: 'e972b38148b658fe98209584d6f63435',
});

const copy = (value: Json): Json => JSON.parse(JSON.stringify(value)) as Json;
const mutate = (change: (r: { [key: string]: Json }) => void): { [key: string]: Json } => {
  const r = copy(result()) as { [key: string]: Json };
  change(r);
  return r;
};

describe('normalization', () => {
  test('a replay equal except for the trace id and the due times is the same, and both normalizations are reported with their counts', () => {
    const replayed = mutate((r) => {
      r.trace = '0123456789abcdef0123456789abcdef';
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (((r.partitions as any).incomplete[0].requirements[0].layers[0] as any).exit as any).due = '2026-11-16T10:00:00.000Z';
    });
    const comparison = compareResults(result(), replayed);
    assert.equal(comparison.same, true);
    assert.deepEqual(comparison.diffs, []);
    assert.deepEqual(comparison.normalizations.map((n) => [n.id, n.recorded, n.replayed]), [['trace', 1, 1], ['exit.due', 1, 1]]);
    assert.ok(comparison.normalizations.every((n) => n.description.length > 0));
  });

  test('nothing else is normalized: another timestamp, another hex string or one word of a message is a difference', () => {
    const replayed = mutate((r) => {
      (r.errors as Array<{ [key: string]: Json }>)[0].message = '第一条消息。';
      r.coverage = { ...(r.coverage as { [key: string]: Json }), note: 'x' };
    });
    const comparison = compareResults(result(), replayed);
    assert.equal(comparison.same, false);
    assert.deepEqual(comparison.diffs.map((d) => [d.field, d.path]), [['coverage', '/coverage/note'], ['errors', '/errors/0/message']]);
  });

  test('the pack binding of a candidate replay is normalized only when the replay says it was rebound, and the rule is listed', () => {
    const replayed = mutate((r) => {
      r.locks = { ...(r.locks as { [key: string]: Json }), pack: 'demo@1.0.1', pack_digest: 'd'.repeat(64) };
    });
    assert.deepEqual(compareResults(result(), replayed).diffs.map((d) => d.path), ['/locks/pack', '/locks/pack_digest']);
    const rebound = compareResults(result(), replayed, { rebound: true });
    assert.equal(rebound.same, true);
    assert.deepEqual(rebound.normalizations.map((n) => n.id), ['trace', 'exit.due', 'locks.pack', 'locks.pack_digest']);
    assert.deepEqual(normalizationRules().map((n) => n.id), ['trace', 'exit.due']);
  });
});

describe('fields', () => {
  test('acceptance', () => {
    const comparison = compareResults(result(), mutate((r) => { r.acceptance = 'accepted'; }));
    assert.deepEqual(comparison.diffs.map((d) => [d.field, d.kind, d.recorded, d.replayed]), [['acceptance', 'changed', 'not_accepted', 'accepted']]);
  });

  test('an error that changed in message and fix is one difference per field, named by its code, item and requirement', () => {
    const comparison = compareResults(result(), mutate((r) => {
      const first = (r.errors as Array<{ [key: string]: Json }>)[0];
      first.message = '换了说法';
      first.fix = '换了改法';
    }));
    assert.deepEqual(comparison.diffs.map((d) => [d.path, d.label]), [
      ['/errors/0/fix', 'code=case.rule_broken item=i1 requirement=r1'],
      ['/errors/0/message', 'code=case.rule_broken item=i1 requirement=r1'],
    ]);
    assert.match(describeDiff(comparison.diffs[1]), /^\/errors\/0\/message〔code=case\.rule_broken item=i1 requirement=r1〕：记录 "第一条消息" → 回放 "换了说法"$/);
  });

  test('an error that is gone, one that is new, and the one in between that stays are told apart without shifting', () => {
    const replayed = mutate((r) => {
      const errors = r.errors as Array<{ [key: string]: Json }>;
      errors.shift();
      errors.push({ code: 'awaiting_step', message: '等待前置', item: 'i3', path: '/items/2', requirement: 'r3' });
    });
    const comparison = compareResults(result(), replayed);
    assert.deepEqual(comparison.diffs.map((d) => [d.kind, d.path, d.label]), [
      ['removed', '/errors/0', 'code=case.rule_broken item=i1 requirement=r1'],
      ['added', '/errors/1', 'code=awaiting_step item=i3 requirement=r3'],
    ]);
    assert.match(describeDiff(comparison.diffs[0]), /记录里有，回放里没有/);
    assert.match(describeDiff(comparison.diffs[1]), /记录里没有，回放里多出/);
  });

  test('an item that moved between partitions is a removal from one and an addition to the other', () => {
    const replayed = mutate((r) => {
      const partitions = r.partitions as { [key: string]: Json[] };
      partitions.delivered = partitions.rejected;
      partitions.rejected = [];
    });
    const comparison = compareResults(result(), replayed);
    assert.deepEqual(comparison.diffs.map((d) => [d.field, d.kind, d.path, d.label]), [
      ['partitions', 'added', '/partitions/delivered/0', 'item=i1'],
      ['partitions', 'removed', '/partitions/rejected/0', 'item=i1'],
    ]);
  });

  test('a layer terminal deep in a partition is named by item, requirement and layer', () => {
    const replayed = mutate((r) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ((r.partitions as any).incomplete[0].requirements[0].layers[0] as any).terminal = 'violation';
    });
    const comparison = compareResults(result(), replayed);
    assert.equal(comparison.diffs.length, 1);
    assert.equal(comparison.diffs[0].field, 'partitions');
    assert.equal(comparison.diffs[0].path, '/partitions/incomplete/0/requirements/0/layers/0/terminal');
    assert.equal(comparison.diffs[0].label, 'item=i2 requirement=r2 layer=static');
  });

  test('coverage, rounds, cross_item and locks each report under their own field; other top-level keys under other', () => {
    const replayed = mutate((r) => {
      r.coverage = { complete: true, examined: 2, total: 2 };
      r.rounds = { used: 1, max: 2 };
      r.cross_item = [];
      r.locks = { ...(r.locks as { [key: string]: Json }), root: 'e'.repeat(64) };
      r.unavailable_references = ['rec:x'];
    });
    const groups = groupDiffs(compareResults(result(), replayed).diffs);
    assert.deepEqual(groups.map((g) => g.field), ['coverage', 'cross_item', 'rounds', 'locks', 'other']);
    const by = Object.fromEntries(groups.map((g) => [g.field, g.diffs.map((d) => d.path)]));
    assert.deepEqual(by.coverage, ['/coverage/complete', '/coverage/examined', '/coverage/note']);
    assert.deepEqual(by.cross_item, ['/cross_item/0']);
    assert.deepEqual(by.rounds, ['/rounds/used']);
    assert.deepEqual(by.locks, ['/locks/root']);
    assert.deepEqual(by.other, ['/unavailable_references']);
  });

  test('run and submission identity differences are filed apart from the content', () => {
    const comparison = compareResults(result(), mutate((r) => { r.submission = 'f'.repeat(64); }));
    assert.deepEqual(comparison.diffs.map((d) => [d.field, d.path]), [['identity', '/submission']]);
  });

  test('the same errors in another order are not the same: the longest common order stays, the moved one is removed and added', () => {
    const replayed = mutate((r) => { (r.errors as Json[]).reverse(); });
    const comparison = compareResults(result(), replayed);
    assert.equal(comparison.same, false);
    assert.deepEqual(comparison.diffs.map((d) => d.kind).sort(), ['added', 'removed']);
  });

  test('neither argument is changed, and key order does not matter', () => {
    const recorded = result();
    const before = stable(recorded);
    const reordered = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(recorded).reverse()))) as Json;
    assert.equal(compareResults(recorded, reordered).same, true);
    assert.equal(stable(recorded), before);
  });
});
