// The repair-round semantics of case-compile 1.3.0 (public formats only: README, SKILL, requirements, codes, examples):
// - With the rounds used up the Hub's static layer ends incomplete (reason repair_exhausted) and the item leaves
//   delivered for unfinished — the independent answer compares that as fail, like any other violation.
// - Every requirement's status (satisfied, unsatisfied, pending) is compared: all pass -> satisfied, some fail ->
//   unsatisfied, some unknown and none failing -> pending; a mismatch is a difference.
// - Delivered is not passed: an item with refutes and rounds left stays delivered with unsatisfied requirements; the
//   comparison never treats the partition as the verdict.
// - The only partition rule: an item sits in unfinished exactly when one of its requirements is incomplete.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compileCheck, type HubRequirement, type PartitionName } from './compile-check.ts';
import { digest, fixture as fixtureOf, rebind } from './compile-check.test.ts';

/** Overwrite one requirement of one item in place (keeping every other row untouched). */
const setRequirement = (f: ReturnType<typeof fixtureOf>, item: number, requirement: string, row: Partial<HubRequirement> & { terminal: string; reason?: string; refutes?: number }): void => {
  const target = f.run.latest!.result!.partitions.delivered![item]!.requirements.find((r) => r.requirement === requirement)!;
  target.layers = [{ layer: 'static', terminal: row.terminal, ...(row.reason !== undefined ? { reason: row.reason } : {}) }];
  target.status = row.status ?? (row.terminal === 'pass' ? 'satisfied' : row.terminal === 'violation' ? 'unsatisfied' : 'pending');
  if (row.terminal === 'violation') (target as { unsatisfied_reason?: string }).unsatisfied_reason = 'outcome_mismatch';
  if (row.refutes !== undefined) target.claims = Array.from({ length: row.refutes }, (_, i) => ({ pointer: `/items/0/slots/plan/0/data/steps/${i + 1}`, statement: { text: '驳回', verdict: 'refute', code: 'x' } }));
  rebind(f);
};

/** Move every item of the run into the given partition (rebuilding the whole map). */
const partitionOnly = (f: ReturnType<typeof fixtureOf>, name: PartitionName): void => {
  const all = Object.values(f.run.latest!.result!.partitions).flat();
  f.run.latest!.result!.partitions = { [name]: all } as Partial<Record<PartitionName, typeof all>>;
  rebind(f);
};

const differencesOf = (f: ReturnType<typeof fixtureOf>): string[] => compileCheck(f).comparison.differences.filter((d) => !d.includes('结论与运行条目集合不一致'));

test('repair_exhausted: static layer incomplete with rounds used up compares as fail', () => {
  const f = fixtureOf();
  setRequirement(f, 0, 'bed_addresses', { terminal: 'incomplete', status: 'pending', reason: 'repair_exhausted' });
  const all = Object.values(f.run.latest!.result!.partitions).flat();
  const first = all.filter((row) => row.item === f.run.run.items[0].id);
  const rest = all.filter((row) => row.item !== f.run.run.items[0].id);
  f.run.latest!.result!.partitions = { unfinished: first, delivered: rest };
  rebind(f);
  const diffs = differencesOf(f);
  assert.ok(diffs.some((d) => d.includes('bed_addresses') && d.includes('fail')), diffs.join(' | '));
});

test('another incomplete reason is reported as the difference it is, not silently a repair-exhaustion fail', () => {
  const f = fixtureOf();
  setRequirement(f, 0, 'bed_addresses', { terminal: 'incomplete', status: 'pending', reason: 'not_covered' });
  // Only the item with the incomplete requirement belongs in unfinished; the other stays delivered.
  const all = Object.values(f.run.latest!.result!.partitions).flat();
  const first = all.filter((row) => row.item === f.run.run.items[0].id);
  const rest = all.filter((row) => row.item !== f.run.run.items[0].id);
  f.run.latest!.result!.partitions = { unfinished: first, delivered: rest };
  rebind(f);
  const diffs = differencesOf(f);
  assert.ok(diffs.some((d) => d.includes('bed_addresses') && d.includes('incomplete')), diffs.join(' | '));
  assert.ok(diffs.every((d) => !d.includes('repair_exhausted')), 'not named as repair exhaustion');
});

test('the requirement status is compared beside the terminal: satisfied/unsatisfied/pending', () => {
  // Hub marks unsatisfied while the terminal says violation and the independent answer passes: a difference.
  const mismatch = fixtureOf();
  setRequirement(mismatch, 0, 'bed_addresses', { terminal: 'violation', status: 'unsatisfied', refutes: 1 });
  const diffs = differencesOf(mismatch);
  assert.ok(diffs.some((d) => d.includes('bed_addresses') && d.includes('状态 unsatisfied') && d.includes('独立答案 satisfied')), diffs.join(' | '));

  // Hub leaves a requirement pending (unchecked) while the independent answer passes: a difference too.
  const pending = fixtureOf();
  setRequirement(pending, 0, 'commands_known', { terminal: 'unchecked', status: 'pending', reason: '缺少命令树原件' });
  const diffs2 = differencesOf(pending);
  assert.ok(diffs2.some((d) => d.includes('commands_known') && d.includes('独立答案 pass')), diffs2.join(' | '));
  assert.ok(diffs2.some((d) => d.includes('commands_known') && d.includes('状态 pending') && d.includes('独立答案 satisfied')), diffs2.join(' | '));

  // A status that contradicts the independent answer while the terminal agrees (pass but unsatisfied): the status
  // difference stands on its own.
  const lying = fixtureOf();
  setRequirement(lying, 0, 'bed_addresses', { terminal: 'pass', status: 'unsatisfied' });
  const diffs3 = differencesOf(lying);
  assert.ok(diffs3.some((d) => d.includes('bed_addresses') && d.includes('状态 unsatisfied') && d.includes('独立答案 satisfied')), diffs3.join(' | '));
});

test('both sides unknown remains unresolved and is reported as a difference', () => {
  const f = fixtureOf();
  // Without the command tree the independent commands_known answers are unknown for every item; so are the Hub's.
  for (const item of [0, 1]) setRequirement(f, item, 'commands_known', { terminal: 'unchecked', status: 'pending', reason: '缺少命令树原件' });
  const r = compileCheck({ ...f, commandTreeXml: undefined, commandCatalog: undefined });
  assert.ok(r.comparison.differences.some((d) => d.includes('commands_known')), r.comparison.differences.join(' | '));
});

test('delivered with refutes and rounds left stays delivered: the requirement is unsatisfied, the partition is not a pass', () => {
  const f = fixtureOf();
  f.submission.items[0].slots!.plan![0].data.steps[0].params.address = '203.0.113.99';
  setRequirement(f, 0, 'bed_addresses', { terminal: 'violation', status: 'unsatisfied', refutes: 1 });
  const r = compileCheck(f);
  assert.ok(r.stepVerdicts.some((v) => v.checkType === 'address' && v.verdict === 'fail'), 'the independent answer fails the address');
  assert.equal(r.allPassed, false, 'delivered is not passed: the unsatisfied requirement keeps the answer failing');
  // The comparison finds no terminal difference (both sides fail) but the failing locations must line up.
  assert.ok(!r.comparison.differences.some((d) => d.includes('bed_addresses：Hub')), r.comparison.differences.filter((d) => d.includes('bed_addresses')).join(' | '));
});

test('the partition rule: unfinished exactly when a requirement is incomplete', () => {
  // An incomplete requirement while the item still sits in delivered: a difference.
  const misplaced = fixtureOf();
  setRequirement(misplaced, 0, 'bed_addresses', { terminal: 'incomplete', status: 'pending', reason: 'not_covered' });
  const d1 = differencesOf(misplaced);
  assert.ok(d1.some((d) => d.includes('未完成') || d.includes('unfinished') || d.includes('incomplete')), d1.join(' | '));

  // No incomplete requirement but the item sits in unfinished: a difference the other way.
  const stray = fixtureOf();
  partitionOnly(stray, 'unfinished');
  const d2 = differencesOf(stray);
  assert.ok(d2.some((d) => d.includes('未完成') || d.includes('unfinished') || d.includes('incomplete')), d2.join(' | '));
});
