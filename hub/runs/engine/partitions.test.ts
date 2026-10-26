import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PARTITION, REASON, STATIC_TERMINAL, type Partition, type Reason } from '../../../contracts/generated/vocabulary.ts';
import { Partitions, partitionCountsOf, type ItemResult, type LayerResult, type RequirementResult } from '../../../contracts/src/validation.ts';
import { PartitionInvariantError, assertCovering, partitionItems, type PartitionInput } from './partitions.ts';
import { dynamicLayer, bindRecovery } from './terminals.ts';

/** Deterministic generator (mulberry32), so a failing case is reproducible from its seed. */
function seeded(seed: number) {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { int: (max: number) => Math.floor(next() * max), chance: (p: number) => next() < p, pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)] };
}

const recovery = { now: new Date('2026-01-01T00:00:00Z'), runner: 'usr_' + '1'.repeat(26), owner: 'usr_' + '2'.repeat(26), admin: 'usr_' + '3'.repeat(26) };
const bind = (layer: LayerResult): LayerResult => bindRecovery(layer,{runner:recovery.runner,owner:recovery.owner,administrator:recovery.admin,due:new Date(recovery.now.getTime()+86400000).toISOString(),location:'synthetic'});
const LOCATION = `src:${'a'.repeat(64)}/kityminder@1/n/x`;

function layer(terminal: (typeof STATIC_TERMINAL)[number], reason: Reason): LayerResult {
  if (terminal === 'pass' || terminal === 'judgment') return { layer: 'static', terminal };
  if (terminal === 'violation') return { layer: 'static', terminal, code: 'core.structure.required_empty' };
  return bind({ layer: 'static', terminal, reason });
}

function requirementResult(key: string, layers: LayerResult[]): RequirementResult {
  return { requirement: key, layers:layers.map(l=>bindRecovery(l,{runner:'usr_00000000000000000000000001',owner:'usr_00000000000000000000000002',administrator:'usr_00000000000000000000000003',due:'2026-10-25T00:00:00.000Z',location:key})), status: 'pending', claims: [] };
}

function input(item: string, requirements: RequirementResult[], extra: Partial<PartitionInput> = {}): PartitionInput {
  return { item, label: item, location: LOCATION, requirements, required: new Set(requirements.map((r) => r.requirement)), notCovered: false, rejection: null, ...extra };
}

test('assignment order: incomplete before rejected before delivered; only required requirements make an item incomplete', () => {
  const parts = partitionItems(
    [
      input('a', [requirementResult('r', [layer('pass', 'no_check')])]),
      input('b', [requirementResult('r', [layer('incomplete', 'timeout')])], { rejection: 'p.code' }),
      input('c', [requirementResult('r', [layer('violation', 'no_check')])], { rejection: 'p.code' }),
      input('d', [requirementResult('r', [layer('pass', 'no_check')])], { notCovered: true }),
      input('e', [requirementResult('o', [layer('incomplete', 'timeout')])], { required: new Set() }),
      input('f', [requirementResult('r', [layer('unchecked', 'no_check')])]),
    ],
    ['a', 'b', 'c', 'd', 'e', 'f'],
  );
  assert.deepEqual(parts.delivered.map((i) => i.item), ['a', 'e', 'f']);
  assert.deepEqual(parts.incomplete.map((i) => [i.item, i.reason]), [
    ['b', 'timeout'],
    ['d', 'not_covered'],
  ]);
  assert.deepEqual(parts.rejected.map((i) => [i.item, i.code]), [['c', 'p.code']]);
  assert.deepEqual(parts.quarantined, []);
  assert.deepEqual(partitionCountsOf(parts), { delivered: 3, rejected: 1, quarantined: 0, incomplete: 2, unknown: 1 });
});

test('hooks for effects, dispositions and abandonment come first (unused in milestone 1)', () => {
  const r = [requirementResult('r', [layer('incomplete', 'timeout')])];
  const parts = partitionItems(
    [input('q', r, { hooks: { quarantine: 'integrity_unproven' } }), input('x', r, { hooks: { dispositionReject: 'p.marked_failed' } }), input('y', r, { hooks: { abandon: true } })],
    ['q', 'x', 'y'],
  );
  assert.deepEqual(parts.quarantined.map((i) => i.item), ['q']);
  assert.deepEqual(parts.rejected.map((i) => i.item), ['x']);
  assert.deepEqual(parts.delivered.map((i) => i.item), ['y']);
});

test('partitions that would miss an item or hold a foreign one fail loudly', () => {
  const r = [requirementResult('r', [layer('pass', 'no_check')])];
  assert.throws(() => partitionItems([input('a', r)], ['a', 'b']), PartitionInvariantError);
  assert.throws(() => partitionItems([input('a', r), input('z', r)], ['a']), PartitionInvariantError);
  assert.throws(() => partitionItems([input('a', r), input('a', r)], ['a']), PartitionInvariantError);
  const parts = Object.fromEntries(PARTITION.map((p) => [p, []])) as unknown as Partitions;
  assert.throws(() => assertCovering(parts, ['a', 'a']), PartitionInvariantError);
});

// The acceptance mutation check's M5: the union check is the engine's own invariant — a projection or caller that
// hands in partitions missing an item must make the assert ring (PartitionInvariantError), not silently pass.
test('assertCovering rings for every shape of a broken partition set (M5)', () => {
  const parts = (over: Record<string, unknown[]>): Partitions =>
    Object.fromEntries(PARTITION.map((p) => [p, over[p] ?? []])) as unknown as Partitions;
  const item = (id: string): ItemResult =>
    ({ item: id, label: id, location: LOCATION, requirements: [requirementResult('r', [layer('pass', 'no_check')])] }) as ItemResult;
  // an item in no partition at all
  assert.throws(() => assertCovering(parts({}), ['a']), PartitionInvariantError, 'the item set is not covered');
  // an item that is not this run's
  assert.throws(() => assertCovering(parts({ delivered: [item('ghost')] }), ['a']), PartitionInvariantError, 'a foreign item');
  // the same item twice in one partition, and in two partitions
  assert.throws(() => assertCovering(parts({ delivered: [item('a'), item('a')] }), ['a']), PartitionInvariantError, 'twice in one');
  assert.throws(() => assertCovering(parts({ delivered: [item('a')], rejected: [item('a')] }), ['a']), PartitionInvariantError, 'in two');
  // duplicate ids in the wanted list
  assert.throws(() => assertCovering(parts({ delivered: [item('a')] }), ['a', 'a']), PartitionInvariantError, 'duplicate ids');
  // and a well-formed set still passes
  assert.doesNotThrow(() => assertCovering(parts({ delivered: [item('a')], incomplete: [{ ...item('b'), reason: 'timeout' as const }] }), ['a', 'b']));
});

test('property: for random runs the partitions are disjoint, cover the item set and follow V05 R[3]', () => {
  const rand = seeded(20261022);
  for (let run = 0; run < 400; run++) {
    const n = 1 + rand.int(30);
    const keys = ['k0', 'k1', 'k2', 'k3'].slice(0, 1 + rand.int(4));
    const required = new Set(keys.filter(() => rand.chance(0.7)));
    const inputs: PartitionInput[] = [];
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const id = `doc:${run}:${i}`;
      ids.push(id);
      const requirements = keys.map((k) => {
        const layers: LayerResult[] = [layer(rand.pick(STATIC_TERMINAL), rand.pick(REASON))];
        if (rand.chance(0.2)) layers.push(bind(dynamicLayer()));
        return requirementResult(k, layers);
      });
      inputs.push(input(id, requirements, { required, notCovered: rand.chance(0.1), rejection: rand.chance(0.15) ? 'pack.reject_me' : null }));
    }
    // shuffle the input order: assignment must not depend on it
    for (let i = inputs.length - 1; i > 0; i--) {
      const j = rand.int(i + 1);
      [inputs[i], inputs[j]] = [inputs[j], inputs[i]];
    }
    const parts = partitionItems(inputs, ids);
    const placed = new Map<string, Partition>();
    for (const p of PARTITION) {
      for (const it of parts[p]) {
        assert.ok(!placed.has(it.item), `seed run ${run}: ${it.item} twice`);
        placed.set(it.item, p);
      }
    }
    assert.equal(placed.size, ids.length, `seed run ${run}: union is the item set`);
    for (const inp of inputs) {
      const incomplete = inp.notCovered || inp.requirements.some((r) => required.has(r.requirement) && r.layers.some((l) => l.terminal === 'incomplete'));
      const expected: Partition = incomplete ? 'incomplete' : inp.rejection !== null ? 'rejected' : 'delivered';
      assert.equal(placed.get(inp.item), expected, `seed run ${run}: ${inp.item}`);
    }
    assert.ok(Partitions.safeParse(parts).success);
    const counts = partitionCountsOf(parts);
    assert.equal(counts.delivered + counts.rejected + counts.quarantined + counts.incomplete, ids.length);
  }
});

test('V05 R[3] by hand: each case written from the rule, not from the code', () => {
  const pass = layer('pass', 'no_check');
  const violation = layer('violation', 'no_check');
  const judgment = layer('judgment', 'no_check');
  const unchecked = (reason: Reason) => layer('unchecked', reason);
  const incomplete = (reason: Reason) => layer('incomplete', reason);
  const notRun: LayerResult = bind(dynamicLayer());
  const dynamicIncomplete: LayerResult = bind({ layer: 'dynamic', terminal: 'incomplete', reason: 'not_covered', attribution: 'producer_error' });
  type Case = [name: string, requirements: [key: string, layers: LayerResult[]][], extra: Partial<PartitionInput>, expected: [Partition, string | null]];
  const required = new Set(['r1', 'r2']);
  const cases: Case[] = [
    ['every layer passes: delivered (⑥)', [['r1', [pass]], ['r2', [judgment]]], {}, ['delivered', null]],
    ['a violation of the target is delivered content (V05 R[1])', [['r1', [violation]]], {}, ['delivered', null]],
    ['an unknown is delivered and counted as unknown, never incomplete', [['r1', [unchecked('check_error')]], ['r2', [pass, notRun]]], {}, ['delivered', null]],
    ['a required requirement incomplete at its static layer: incomplete with that reason (④)', [['r1', [pass]], ['r2', [incomplete('repair_exhausted')]]], {}, ['incomplete', 'repair_exhausted']],
    ['incomplete at a declared dynamic layer only: still incomplete (④ "在它声明的某层")', [['r1', [pass, dynamicIncomplete]]], {}, ['incomplete', 'not_covered']],
    ['an optional requirement incomplete: delivered (④ counts required ones)', [['r1', [pass]], ['o', [incomplete('timeout')]]], {}, ['delivered', null]],
    ['not covered by the submission: incomplete even when every layer passes (④)', [['r1', [pass]]], { notCovered: true }, ['incomplete', 'not_covered']],
    ['a blocking rejection of the artifact under verification: rejected with its code (⑤)', [['r1', [violation]]], { rejection: 'p.reject_me' }, ['rejected', 'p.reject_me']],
    ['incomplete comes before rejected (④ before ⑤)', [['r1', [incomplete('awaiting_step')]]], { rejection: 'p.reject_me' }, ['incomplete', 'awaiting_step']],
    ['an unknown effect comes first (①)', [['r1', [incomplete('timeout')]]], { rejection: 'p.reject_me', hooks: { quarantine: 'integrity_unproven' } }, ['quarantined', 'integrity_unproven']],
    ['a disposition marked failed comes before incomplete (②)', [['r1', [incomplete('timeout')]]], { hooks: { dispositionReject: 'p.marked_failed' } }, ['rejected', 'p.marked_failed']],
    ['abandoned is delivered whatever else holds (③)', [['r1', [incomplete('timeout')]]], { rejection: 'p.reject_me', hooks: { abandon: true } }, ['delivered', null]],
  ];
  const inputs = cases.map(([name, requirements, extra], i) =>
    input(`case-${i}`, requirements.map(([key, layers]) => requirementResult(key, layers)), { required, ...extra, label: name }),
  );
  const parts = partitionItems(inputs, inputs.map((x) => x.item));
  cases.forEach(([name, , , [partition, detail]], i) => {
    const found = parts[partition].find((it) => it.item === `case-${i}`);
    assert.ok(found, `${name}: expected in ${partition}`);
    const shown = 'reason' in found ? (found as { reason: string }).reason : 'code' in found ? (found as { code: string }).code : null;
    assert.equal(shown, detail, name);
  });
  // counts: one item per case, unknown counts the items with an unknown terminal in any partition
  assert.deepEqual(partitionCountsOf(parts), { delivered: 5, rejected: 2, quarantined: 1, incomplete: 4, unknown: 1 });
});
