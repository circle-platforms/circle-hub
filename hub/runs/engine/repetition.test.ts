import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AGGREGATION,
  DYNAMIC_TERMINAL,
  WORK_CLASS,
  labelOf,
  type Aggregation,
  type DynamicTerminal,
  type WorkClass,
} from '../../../contracts/generated/vocabulary.ts';
import {
  INTERMITTENT_MARK,
  RERUN_ROUNDS,
  aggregate,
  comparableRepetitions,
  effectiveRepetition,
  repetitionApplies,
  withinCountBudget,
  type RoundOutcome,
} from './repetition.ts';

const all = (count: number) => ({ count, aggregation: 'all' as const satisfies Aggregation });
const pass = (round: number, meets = true): RoundOutcome => ({ round, terminal: 'pass', meets });
const fail = (round: number, code: string, meets = false): RoundOutcome => ({ round, terminal: 'fail', code, meets });
const gap = (round: number, terminal: Extract<DynamicTerminal, 'no_verdict' | 'not_run' | 'incomplete'>): RoundOutcome => ({ round, terminal });

function mixText(counts: Partial<Record<DynamicTerminal, number>>, where: readonly number[], count: number): string {
  const parts = DYNAMIC_TERMINAL.flatMap((terminal) => {
    const found = counts[terminal] ?? 0;
    return found > 0 ? [`${found} 次${labelOf('dynamic_terminal', terminal)}`] : [];
  });
  return `${labelOf('qualifier_mark', INTERMITTENT_MARK)}：${count} 次里 ${parts.join('、')}（第 ${where.join('、')} 次）`;
}

test('V07 R[0] every meeting round meets, including a failure the contract expected', () => {
  const support = aggregate([pass(1), pass(2), pass(3)], all(3));
  assert.equal(support.outcome, 'meets');
  assert.equal(support.status, 'satisfied');
  assert.equal(support.unsatisfied_reason, undefined);
  assert.equal(support.terminal, 'pass');
  assert.equal(support.code, undefined);
  assert.deepEqual(support.marks, []);
  assert.equal(support.firstCause, undefined);
  assert.deepEqual(support.missingRounds, []);
  assert.equal(support.exit, undefined);
  assert.equal(support.text, '3/3 次未见失败');
  assert.equal(Object.hasOwn(support, 'attribution'), false);
  // One pass out of three is not a meet: the missing rounds are re-run, and the pass is not the terminal.
  const partial = aggregate([pass(1)], all(3));
  assert.equal(partial.outcome, 'undecided');
  assert.notEqual(partial.status, 'satisfied');
  assert.equal(partial.terminal, 'not_run');
  assert.deepEqual(partial.missingRounds, [2, 3]);

  const expected = aggregate([fail(1, 'expected', true), fail(2, 'expected', true), fail(3, 'expected', true)], all(3));
  assert.equal(expected.outcome, 'meets');
  assert.equal(expected.status, 'satisfied');
  assert.equal(expected.terminal, 'fail');
  assert.equal(expected.code, 'expected');
  assert.equal(expected.text.includes('未见失败'), false);
});

test('V07 R[0] one miss takes the first code, and a later code does not replace it', () => {
  const summary = aggregate([fail(2, 'later'), fail(1, 'root'), fail(3, 'tail')], all(3));
  assert.equal(summary.outcome, 'misses');
  assert.equal(summary.status, 'unsatisfied');
  assert.equal(summary.unsatisfied_reason, 'outcome_mismatch');
  assert.equal(summary.terminal, 'fail');
  assert.equal(summary.code, 'root');
  assert.deepEqual(summary.firstCause, { round: 1, terminal: 'fail', code: 'root' });
  assert.equal(summary.distribution.rounds[1].code, 'later');
  assert.deepEqual(summary.marks, []);
  assert.equal(Object.hasOwn(summary, 'attribution'), false);
  // A gap beside a miss does not turn a decided miss into a missing judgment, and does not become a pass.
  const beside = aggregate([gap(2, 'no_verdict'), fail(1, 'root')], all(2));
  assert.equal(beside.outcome, 'misses');
  assert.notEqual(beside.outcome, 'undecided');
  assert.equal(beside.terminal, 'fail');
  assert.equal(beside.code, 'root');
  assert.deepEqual(beside.missingRounds, []);
  assert.equal(beside.exit, undefined);
  assert.equal(beside.distribution.byTerminal.pass, 0);
  assert.equal(beside.distribution.byTerminal.no_verdict, 1);
});

test('V07 R[0] a mix is intermittent and unsatisfied, and the causes are not an attribution', () => {
  const summary = aggregate([pass(1), fail(2, 'root'), pass(3)], all(3));
  assert.equal(summary.outcome, 'misses');
  assert.equal(summary.status, 'unsatisfied');
  assert.equal(summary.unsatisfied_reason, 'outcome_mismatch');
  assert.deepEqual(summary.marks, [INTERMITTENT_MARK]);
  assert.equal(labelOf('qualifier_mark', summary.marks[0]), '间歇');
  assert.equal(summary.terminal, 'fail');
  assert.equal(summary.code, 'root');
  assert.deepEqual(summary.missingRounds, []);
  assert.equal(summary.exit, undefined);
  assert.notEqual(summary.status, 'pending');
  assert.equal(summary.text, mixText({ pass: 2, fail: 1 }, [2], 3));
  assert.equal(Object.hasOwn(summary, 'attribution'), false);
  // Expected failure: two matching failures and one pass are a mix, so the requirement is unsatisfied.
  const reversed = aggregate([fail(1, 'expected', true), pass(2, false), fail(3, 'expected', true)], all(3));
  assert.equal(reversed.outcome, 'misses');
  assert.notEqual(reversed.status, 'satisfied');
  assert.equal(reversed.terminal, 'pass');
  assert.equal(reversed.code, undefined);
  assert.deepEqual(reversed.firstCause, { round: 2, terminal: 'pass' });
  assert.deepEqual(reversed.marks, [INTERMITTENT_MARK]);
  assert.equal(reversed.text, mixText({ pass: 1, fail: 2 }, [2], 3));
});

test('V07 R[0] a missing judgment takes the weakest round, names it, and exits by re-running it', () => {
  const summary = aggregate([gap(1, 'incomplete'), gap(2, 'no_verdict')], all(2));
  assert.equal(summary.outcome, 'undecided');
  assert.equal(summary.status, 'pending');
  assert.equal(summary.terminal, 'no_verdict');
  assert.notEqual(summary.terminal, 'incomplete');
  assert.deepEqual(summary.missingRounds, [1, 2]);
  assert.equal(summary.missing, '缺少第 1、2 轮的动态层判定；出口是重跑这几轮');
  assert.deepEqual(summary.exit, { action: RERUN_ROUNDS, rounds: [1, 2] });
  assert.equal(labelOf('exit_action', summary.exit!.action), '重评');
  assert.deepEqual(summary.marks, []);
  assert.equal(summary.text.includes('未见失败'), false);
  assert.equal(aggregate([gap(1, 'incomplete')], all(1)).terminal, 'incomplete');
  // Equal strength keeps the earliest round.
  assert.equal(aggregate([gap(1, 'no_verdict'), gap(2, 'not_run')], all(2)).terminal, 'no_verdict');
  assert.equal(aggregate([gap(1, 'not_run'), gap(2, 'no_verdict')], all(2)).terminal, 'not_run');
  // An absent round is not run, which is weaker than an observed incomplete, and it is not stored as an observation.
  const absent = aggregate([gap(1, 'incomplete')], all(2));
  assert.equal(absent.terminal, 'not_run');
  assert.deepEqual(absent.missingRounds, [1, 2]);
  assert.equal(absent.distribution.byTerminal.not_run, 0);
  assert.equal(absent.distribution.byTerminal.incomplete, 1);
  // A pass beside an observed incomplete stays open on that incomplete round.
  assert.equal(aggregate([pass(1), gap(2, 'incomplete')], all(2)).terminal, 'incomplete');
  const none = aggregate([], all(1));
  assert.equal(none.outcome, 'undecided');
  assert.notEqual(none.outcome, 'meets');
  assert.equal(none.terminal, 'not_run');
  assert.equal(none.text.includes('尚无轮次观察'), true);
});

test('V07 R[1] k-of-n meets at the threshold, misses past it, and stays open in between', () => {
  const policy = { count: 3, aggregation: 'k_of_n' as const satisfies Aggregation, k: 2 };
  const enough = aggregate([pass(1), fail(2, 'x'), pass(3)], policy);
  assert.equal(enough.outcome, 'meets');
  assert.equal(enough.status, 'satisfied');
  assert.equal(enough.terminal, 'pass');
  assert.deepEqual(enough.marks, [INTERMITTENT_MARK]);
  assert.deepEqual(enough.firstCause, { round: 2, terminal: 'fail', code: 'x' });
  assert.equal(enough.distribution.rounds.length, 3);
  assert.equal(Object.hasOwn(enough, 'attribution'), false);
  const tooMany = aggregate([fail(1, 'root'), pass(2), fail(3, 'later')], policy);
  assert.equal(tooMany.outcome, 'misses');
  assert.equal(tooMany.code, 'root');
  assert.notEqual(tooMany.code, 'later');
  assert.deepEqual(tooMany.marks, [INTERMITTENT_MARK]);
  const open = aggregate([pass(1), fail(2, 'x'), gap(3, 'no_verdict')], policy);
  assert.equal(open.outcome, 'undecided');
  assert.notEqual(open.outcome, 'meets');
  assert.notEqual(open.outcome, 'misses');
  assert.equal(open.terminal, 'no_verdict');
  assert.deepEqual(open.missingRounds, [3]);
  assert.deepEqual(open.exit?.rounds, [3]);
  assert.deepEqual(open.marks, []);
  // One miss is not enough to fail k=2, and one meet is not enough to pass it.
  assert.equal(aggregate([fail(1, 'x'), pass(2), gap(3, 'not_run')], policy).outcome, 'undecided');
  assert.notEqual(aggregate([pass(1), gap(2, 'not_run'), gap(3, 'not_run')], policy).outcome, 'meets');
  // k=1 is not the “all” rule.
  const one = aggregate([pass(1), gap(2, 'no_verdict')], { count: 2, aggregation: 'k_of_n', k: 1 });
  assert.equal(one.outcome, 'meets');
  assert.equal(aggregate([pass(1), gap(2, 'no_verdict')], all(2)).outcome, 'undecided');
});

test('V07 R[1] k equal to the count matches all on every round sequence', () => {
  const support: Omit<RoundOutcome, 'round'>[] = [
    { terminal: 'pass', meets: true },
    { terminal: 'fail', meets: false, code: 'a' },
    { terminal: 'fail', meets: false, code: 'b' },
    { terminal: 'no_verdict' },
    { terminal: 'not_run' },
    { terminal: 'incomplete' },
  ];
  const refute: Omit<RoundOutcome, 'round'>[] = [
    { terminal: 'fail', meets: true, code: 'expected' },
    { terminal: 'pass', meets: false },
    { terminal: 'fail', meets: false, code: 'other' },
    { terminal: 'no_verdict' },
    { terminal: 'not_run' },
    { terminal: 'incomplete' },
  ];
  let compared = 0;
  for (const alphabet of [support, refute]) {
    for (const count of [1, 2, 3]) {
      for (const rounds of sequences(count, alphabet)) {
        const left = aggregate(rounds, { count, aggregation: 'all' });
        const right = aggregate(rounds, { count, aggregation: 'k_of_n', k: count });
        assert.equal(left.outcome, right.outcome);
        assert.equal(left.status, right.status);
        assert.equal(left.unsatisfied_reason, right.unsatisfied_reason);
        assert.equal(left.terminal, right.terminal);
        assert.equal(left.code, right.code);
        assert.deepEqual(left.marks, right.marks);
        assert.deepEqual(left.missingRounds, right.missingRounds);
        assert.deepEqual(left.firstCause, right.firstCause);
        assert.equal(left.distribution.rounds.length, rounds.length);
        assert.equal(right.distribution.rounds.length, rounds.length);
        compared += 1;
      }
    }
  }
  assert.equal(compared, 2 * (6 + 36 + 216));
});

test('V07 R[2] the first meeting round meets, and earlier misses stay in the distribution', () => {
  const policy = { count: 3, aggregation: 'first_pass' as const satisfies Aggregation };
  const stopped = aggregate([fail(1, 'root'), pass(2)], policy);
  assert.equal(stopped.outcome, 'meets');
  assert.equal(stopped.status, 'satisfied');
  assert.equal(stopped.terminal, 'pass');
  assert.equal(stopped.code, undefined);
  assert.deepEqual(stopped.firstCause, { round: 1, terminal: 'fail', code: 'root' });
  assert.equal(stopped.distribution.rounds.length, 2);
  assert.equal(stopped.distribution.rounds[0].code, 'root');
  assert.deepEqual(stopped.marks, [INTERMITTENT_MARK]);
  assert.deepEqual(stopped.missingRounds, []);
  assert.equal(stopped.exit, undefined);
  assert.equal(Object.hasOwn(stopped, 'attribution'), false);
  const trailed = aggregate([pass(1), gap(2, 'not_run')], { count: 2, aggregation: 'first_pass' });
  assert.equal(trailed.outcome, 'meets');
  assert.equal(trailed.distribution.byTerminal.pass, 1);
  assert.equal(trailed.distribution.byTerminal.not_run, 1);
  assert.deepEqual(trailed.marks, []);
  const every = aggregate([fail(1, 'root'), fail(2, 'later'), fail(3, 'tail')], policy);
  assert.equal(every.outcome, 'misses');
  assert.equal(every.code, 'root');
  assert.deepEqual(every.marks, []);
  // One miss does not close first pass while later rounds are still open, and the pass does not erase the first code.
  const unfinished = aggregate([fail(1, 'root')], policy);
  assert.equal(unfinished.outcome, 'undecided');
  assert.notEqual(unfinished.outcome, 'misses');
  assert.notEqual(unfinished.terminal, 'fail');
  assert.equal(unfinished.terminal, 'not_run');
  assert.deepEqual(unfinished.firstCause, { round: 1, terminal: 'fail', code: 'root' });
  assert.deepEqual(unfinished.missingRounds, [2, 3]);
  assert.deepEqual(unfinished.exit?.rounds, [2, 3]);
});

test('V07 R[3] the distribution keeps every round and does not count a gap as a pass', () => {
  const summary = aggregate([fail(2, 'root'), pass(1), gap(3, 'no_verdict')], all(3));
  assert.equal(summary.distribution.count, 3);
  assert.deepEqual(summary.distribution.rounds.map((round) => [round.round, round.terminal, round.code ?? null, round.meets]), [
    [1, 'pass', null, true],
    [2, 'fail', 'root', false],
    [3, 'no_verdict', null, null],
  ]);
  assert.equal(summary.distribution.byTerminal.pass, 1);
  assert.equal(summary.distribution.byTerminal.fail, 1);
  assert.equal(summary.distribution.byTerminal.no_verdict, 1);
  assert.equal(summary.text.includes('未见失败'), false);
  const rounds = DYNAMIC_TERMINAL.map((terminal, index) => {
    if (terminal === 'pass') return pass(index + 1);
    if (terminal === 'fail') return fail(index + 1, 'x');
    return { round: index + 1, terminal };
  });
  const counted = aggregate(rounds, all(DYNAMIC_TERMINAL.length));
  for (const terminal of DYNAMIC_TERMINAL) assert.equal(counted.distribution.byTerminal[terminal], 1);
  assert.equal(counted.distribution.rounds.length, DYNAMIC_TERMINAL.length);
  assert.equal(aggregate([pass(1), pass(2)], all(2)).text, '2/2 次未见失败');
});

test('V07 R[4] runs compare only when aggregation, k and round depth match', () => {
  const verification = effectiveRepetition({ workClass: 'verification' });
  const explicit = effectiveRepetition({ declared: { count: 3, aggregation: 'all' } });
  assert.equal(comparableRepetitions(verification, explicit), true);
  assert.equal(comparableRepetitions({ count: 3, aggregation: 'k_of_n', k: 2 }, { count: 3, aggregation: 'k_of_n', k: 2 }), true);
  assert.equal(comparableRepetitions(verification, effectiveRepetition({ workClass: 'web' })), false);
  assert.equal(comparableRepetitions({ count: 3, aggregation: 'all' }, { count: 2, aggregation: 'all' }), false);
  assert.equal(comparableRepetitions({ count: 3, aggregation: 'k_of_n', k: 2 }, { count: 3, aggregation: 'k_of_n', k: 1 }), false);
  // The same terminal does not make a different aggregation comparable.
  assert.equal(comparableRepetitions({ count: 3, aggregation: 'all' }, { count: 3, aggregation: 'k_of_n', k: 3 }), false);
  assert.equal(comparableRepetitions({ count: 2, aggregation: 'first_pass' }, { count: 2, aggregation: 'all' }), false);
});

test('V07 R[5] defaults come from the work class, and a written count wins', () => {
  const expected = {
    verification: { count: 3, aggregation: 'all' as const satisfies Aggregation },
    reproduction: { count: 3, aggregation: 'all' as const satisfies Aggregation },
    web: { count: 2, aggregation: 'first_pass' as const satisfies Aggregation },
  } as const satisfies Record<WorkClass, { readonly count: number; readonly aggregation: Aggregation }>;
  assert.deepEqual([...WORK_CLASS].sort(), Object.keys(expected).sort());
  for (const workClass of WORK_CLASS) {
    const policy = effectiveRepetition({ workClass, layers: ['dynamic'] });
    assert.equal(policy.count, expected[workClass].count);
    assert.equal(policy.aggregation, expected[workClass].aggregation);
    assert.equal(policy.k, undefined);
    assert.equal(policy.basis, 'work_class');
    assert.equal(policy.explicit.count, false);
    assert.equal(policy.explicit.aggregation, false);
  }
  assert.deepEqual(effectiveRepetition({ workClass: 'reproduction' }), effectiveRepetition({ workClass: 'reproduction', layers: ['dynamic'] }));
  const once = effectiveRepetition({});
  assert.equal(once.count, 1);
  assert.equal(once.aggregation, 'all');
  assert.equal(once.basis, 'single_round');
  assert.notEqual(once.count, expected.verification.count);
  const written = effectiveRepetition({ workClass: 'verification', declared: { count: 1 } });
  assert.equal(written.count, 1);
  assert.notEqual(written.count, 3);
  assert.equal(written.aggregation, 'all');
  assert.equal(written.basis, 'explicit');
  assert.equal(written.explicit.count, true);
  assert.equal(written.explicit.aggregation, false);
  const dispatched = effectiveRepetition({ workClass: 'verification', declared: { count: 5 }, dispatchCount: 4 });
  assert.equal(dispatched.count, 4);
  assert.notEqual(dispatched.count, 5);
  assert.notEqual(dispatched.count, 3);
  const webAggregation = effectiveRepetition({ workClass: 'web', declared: { aggregation: 'all' } });
  assert.equal(webAggregation.count, 2);
  assert.equal(webAggregation.aggregation, 'all');
  const narrowed = effectiveRepetition({ workClass: 'web', declared: { aggregation: 'k_of_n', k: 1 } });
  assert.equal(narrowed.count, 2);
  assert.equal(narrowed.aggregation, 'k_of_n');
  assert.equal(narrowed.k, 1);
  assert.equal(repetitionApplies(['dynamic']), true);
  assert.equal(repetitionApplies(['static', 'dynamic']), true);
  assert.equal(repetitionApplies(['static']), false);
  const staticOnly = effectiveRepetition({ workClass: 'verification', layers: ['static'] });
  assert.equal(staticOnly.count, 1);
  assert.equal(staticOnly.basis, 'single_round');
  assert.notEqual(staticOnly.count, 3);
  assert.throws(() => effectiveRepetition({ layers: ['static'], declared: { count: 3 } }), /静态检查不重复/);
  assert.equal(withinCountBudget(2, all(3), 3), true);
  assert.equal(withinCountBudget(3, all(3), 2), false);
  assert.equal(withinCountBudget(4, all(3), 4), false);
});

test('counts, aggregations and rounds outside the generated vocabulary are rejected', () => {
  assert.throws(() => aggregate([pass(1)], { count: 0, aggregation: 'all' }), /重复次数/);
  assert.throws(() => aggregate([pass(1)], { count: 11, aggregation: 'all' }), /重复次数/);
  assert.equal(aggregate(Array.from({ length: 10 }, (_, index) => pass(index + 1)), all(10)).outcome, 'meets');
  assert.throws(() => aggregate([pass(1)], { count: 1, aggregation: 'majority' as Aggregation }), /聚合方式/);
  assert.throws(() => aggregate([pass(1)], { count: 1, aggregation: 'all', k: 1 }), /只有 k-of-n/);
  assert.throws(() => aggregate([pass(1)], { count: 2, aggregation: 'k_of_n' }), /k-of-n/);
  assert.throws(() => aggregate([pass(1)], { count: 2, aggregation: 'k_of_n', k: 3 }), /k-of-n/);
  assert.throws(() => aggregate([pass(1)], { count: 2, aggregation: 'k_of_n', k: 0 }), /k-of-n/);
  assert.equal(aggregate([pass(1)], { count: 2, aggregation: 'k_of_n', k: 1 }).outcome, 'meets');
  assert.throws(() => effectiveRepetition({ dispatchCount: 0 }), /重复次数/);
  assert.throws(() => effectiveRepetition({ workClass: 'desktop' as WorkClass }), /工作类/);
  assert.throws(() => aggregate([pass(1), pass(1)], all(2)), /轮次重复/);
  assert.throws(() => aggregate([{ round: 1, terminal: 'no_verdict', meets: true }], all(1)), /不能记成合期望/);
  assert.throws(() => aggregate([{ round: 1, terminal: 'fail', code: 'x' }], all(1)), /要写明合不合期望/);
  assert.throws(() => aggregate([{ round: 1, terminal: 'pass', meets: true, code: 'x' }], all(1)), /通过不带码/);
  assert.throws(() => aggregate([pass(1), fail(2, 'other', true)], all(2)), /终态不一致/);
  for (const aggregation of AGGREGATION) {
    const policy = aggregation === 'k_of_n' ? { count: 1, aggregation, k: 1 } : { count: 1, aggregation };
    assert.equal(aggregate([pass(1)], policy).outcome, 'meets');
  }
});

function sequences(count: number, alphabet: readonly Omit<RoundOutcome, 'round'>[]): RoundOutcome[][] {
  let rows: RoundOutcome[][] = [[]];
  for (let round = 1; round <= count; round++) {
    const next: RoundOutcome[][] = [];
    for (const row of rows) for (const sample of alphabet) next.push([...row, { ...sample, round }]);
    rows = next;
  }
  return rows;
}
