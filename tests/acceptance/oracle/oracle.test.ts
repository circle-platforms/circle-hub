// Hand-derived expectations for the oracle itself, written from the model text: they keep the reference implementation
// honest before it is compared with the engine.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cellOf, expected, type CheckOutcomes, type RequirementDescription, type RunDescription, type SubmissionDescription } from './oracle.ts';

const req = (over: Partial<RequirementDescription> = {}): RequirementDescription => ({
  key: 'r1',
  required: true,
  layers: ['static'],
  producer: 'fact',
  acceptsDeclaredIndependence: false,
  checks: ['c1'],
  negativeCodes: null,
  errorTable: [{ code: 'p.x', action: 'repair', maxRounds: 2 }],
  ...over,
});

const run = (over: Partial<RunDescription> = {}): RunDescription => ({
  items: [{ id: 'i1', negative: false }],
  requirements: [req()],
  runLevel: [],
  checks: [{ id: 'c1', judges: 'subject', tier: null }],
  roundsUsed: 0,
  author: null,
  ...over,
});

const handled: SubmissionDescription = { judge: { session: 's2', model: 'beta@2' }, items: { i1: { handling: 'handled' } }, defects: [] };
const support: CheckOutcomes = { c1: { i1: [{ verdict: 'support' }] } };
const refuteX: CheckOutcomes = { c1: { i1: [{ verdict: 'refute', code: 'p.x', tier: 'blocking' }] } };

describe('oracle', () => {
  it('a supported fact passes, is satisfied and delivered', () => {
    const e = expected(run(), handled, support);
    assert.equal(e.acceptance, 'accepted');
    assert.deepEqual(e.items[0].requirements, [{ requirement: 'r1', layers: [{ layer: 'static', terminal: 'pass' }], status: 'satisfied' }]);
    assert.equal(e.items[0].partition, 'delivered');
    assert.deepEqual(e.items[0].cells, { static: { value: 'pass', counts: {} }, dynamic: null });
    assert.deepEqual(e.counts, { delivered: 1, rejected: 0, quarantined: 0, incomplete: 0, unknown: 0 });
    assert.deepEqual(e.errors, []);
  });

  it('a refuted fact on the artifact routed to repair is a delivered violation with the rounds left (T03 R[4])', () => {
    const e = expected(run({ checks: [{ id: 'c1', judges: 'artifact_under_verification', tier: null }] }), handled, refuteX);
    assert.deepEqual(e.items[0].requirements[0], {
      requirement: 'r1',
      layers: [{ layer: 'static', terminal: 'violation', code: 'p.x', tier: 'blocking', attribution: 'producer_error' }],
      status: 'unsatisfied',
      unsatisfied_reason: 'outcome_mismatch',
    });
    assert.equal(e.items[0].partition, 'delivered');
    // Rounds still remain, so the refutation stays on the terminal and is not yet an error (W02 R[5]).
    assert.deepEqual(e.errors, []);
    assert.deepEqual(e.rounds, { used: 0, max: 2 });
  });

  it('a refutation of the subject does not enter repair even when the error table has a repair row (T03 R[4], W02 F[7])', () => {
    const onSubject = run({ checks: [{ id: 'c1', judges: 'subject', tier: null }] });
    const first = expected(onSubject, handled, refuteX);
    assert.deepEqual(first.items[0].requirements[0].layers[0], { layer: 'static', terminal: 'violation', code: 'p.x', tier: 'blocking', attribution: 'author_input' });
    assert.deepEqual(first.errors, []);
    assert.deepEqual(first.rounds, { used: 0, max: 2 });
    const second = expected(run({ ...onSubject, roundsUsed: 2 }), handled, refuteX);
    assert.deepEqual(second.items[0].requirements[0].layers[0], { layer: 'static', terminal: 'violation', code: 'p.x', tier: 'blocking', attribution: 'author_input' });
    assert.equal(second.items[0].partition, 'delivered');
    assert.deepEqual(second.errors, []);
    assert.deepEqual(second.rounds, { used: 0, max: 2 });
  });

  it('used-up repair rounds make every declared layer incomplete (W02 R[5])', () => {
    const e = expected(run({ roundsUsed: 2, requirements: [req({ layers: ['static', 'dynamic'] })], checks: [{ id: 'c1', judges: 'artifact_under_verification', tier: null }] }), handled, refuteX);
    assert.deepEqual(e.items[0].requirements[0], {
      requirement: 'r1',
      layers: [
        { layer: 'static', terminal: 'incomplete', reason: 'repair_exhausted', attribution: 'producer_error' },
        { layer: 'dynamic', terminal: 'incomplete', reason: 'repair_exhausted', attribution: 'producer_error' },
      ],
      status: 'pending',
    });
    assert.equal(e.items[0].partition, 'incomplete');
    assert.equal(e.items[0].reason, 'repair_exhausted');
    assert.deepEqual(e.errors, [{ kind: 'refutation', code: 'p.x', item: 'i1', requirement: 'r1', rounds_left: 0 },{kind:'unknown',code:'repair_exhausted',item:'i1',requirement:'r1',rounds_left:0}]);
    assert.deepEqual(e.rounds, { used: 2, max: 2 });
  });

  it('an expected refutation of a negative item is satisfied, carries no attribution and is not repaired (V03 R[2], V04 R[1])', () => {
    const e = expected(run({ items: [{ id: 'i1', negative: true }], requirements: [req({ negativeCodes: ['p.x'] })] }), handled, refuteX);
    assert.deepEqual(e.items[0].requirements[0], {
      requirement: 'r1',
      layers: [{ layer: 'static', terminal: 'violation', code: 'p.x', tier: 'blocking' }],
      status: 'satisfied',
    });
    assert.deepEqual(e.errors, []);
  });

  it('a negative item whose check supports misses the expectation without an attribution on the pass', () => {
    const e = expected(run({ items: [{ id: 'i1', negative: true }], requirements: [req({ negativeCodes: ['p.x'] })] }), handled, support);
    assert.deepEqual(e.items[0].requirements[0], { requirement: 'r1', layers: [{ layer: 'static', terminal: 'pass' }], status: 'unsatisfied', unsatisfied_reason: 'outcome_mismatch' });
  });

  it('an unknown verdict is unchecked with its reason and counted unknown (V01 R[2], V03 R[4])', () => {
    const e = expected(run(), handled, { c1: { i1: [{ verdict: 'unknown', reason: 'timeout' }] } });
    assert.deepEqual(e.items[0].requirements[0], { requirement: 'r1', layers: [{ layer: 'static', terminal: 'unchecked', reason: 'timeout', attribution: 'transient' }], status: 'pending' });
    assert.equal(e.items[0].partition, 'delivered');
    assert.equal(e.counts.unknown, 1);
  });

  it('a fact requirement without a check is unchecked and pending; an independent judgment without one has no producer (V01 R[1], V03 R[4], W02 R[4])', () => {
    const e = expected(run({ requirements: [req({ checks: [] })], checks: [] }), handled, {});
    assert.deepEqual(e.items[0].requirements[0], {
      requirement: 'r1',
      layers: [{ layer: 'static', terminal: 'unchecked', reason: 'no_check', attribution: 'unattributed' }],
      status: 'pending',
    });
    assert.equal(e.items[0].partition, 'delivered');
    assert.equal(e.counts.unknown, 1);
    const closed = expected(run({ requirements: [req({ checks: [], producer: 'independent_judgment' })], checks: [] }), handled, {});
    assert.equal(closed.items[0].requirements[0].status, 'unsatisfied');
    assert.equal(closed.items[0].requirements[0].unsatisfied_reason, 'no_producer');
  });

  it('a skipped item is incomplete at every declared layer; only a required requirement makes the item incomplete (W07 R[2], V05 R[3])', () => {
    const skipped: SubmissionDescription = { ...handled, items: { i1: { handling: 'skipped' } } };
    const e = expected(run({requirements:[req({producer:'judgment'})]}), skipped, support);
    assert.deepEqual(e.items[0].requirements[0].layers, [{ layer: 'static', terminal: 'incomplete', reason: 'declared_skip', attribution: 'unattributed' }]);
    assert.equal(e.items[0].partition, 'incomplete');
    assert.equal(e.items[0].reason, 'declared_skip');
    const optional = expected(run({ requirements: [req({ required: false,producer:'judgment' })] }), skipped, support);
    assert.equal(optional.items[0].partition, 'delivered');
  });

  it('a missing item is not covered, named in errors, and the submission stays accepted (W07 R[3])', () => {
    const missing: SubmissionDescription = { ...handled, items: {} };
    const e = expected(run({requirements:[req({producer:'judgment'})]}), missing, support);
    assert.equal(e.acceptance, 'accepted');
    assert.deepEqual(e.items[0].requirements[0].layers, [{ layer: 'static', terminal: 'incomplete', reason: 'not_covered', attribution: 'unattributed' }]);
    assert.equal(e.items[0].partition, 'incomplete');
    assert.equal(e.items[0].reason, 'not_covered');
    assert.deepEqual(e.errors, [{kind:'not_covered',code:'not_covered',item:'i1',requirement:'r1',rounds_left:2},{ kind: 'not_covered',code:'core.coverage.shortfall', item: 'i1', rounds_left: 2 }]);
  });

  it('an independent judgment needs another session and model, and the template must accept the declaration (W02 F[4])', () => {
    const judged = req({ producer: 'independent_judgment', acceptsDeclaredIndependence: true });
    const base = run({ requirements: [judged], author: { session: 's1', model: 'alpha@1' } });
    assert.equal(expected(base, handled, support).items[0].requirements[0].status, 'satisfied');
    assert.deepEqual(expected(base, handled, support).items[0].requirements[0].layers, [{ layer: 'static', terminal: 'judgment' }]);
    const sameSession: SubmissionDescription = { ...handled, judge: { session: 's1', model: 'beta@2' } };
    assert.equal(expected(base, sameSession, support).items[0].requirements[0].unsatisfied_reason, 'independence_unknown');
    const sameModel: SubmissionDescription = { ...handled, judge: { session: 's2', model: 'alpha@1' } };
    assert.equal(expected(base, sameModel, support).items[0].requirements[0].unsatisfied_reason, 'independence_unknown');
    const notAccepted = run({ requirements: [req({ producer: 'independent_judgment' })], author: { session: 's1', model: 'alpha@1' } });
    assert.equal(expected(notAccepted, handled, support).items[0].requirements[0].unsatisfied_reason, 'independence_unknown');
    assert.equal(expected(run({ requirements: [judged] }), handled, support).items[0].requirements[0].unsatisfied_reason, 'independence_unknown');
  });

  it('a blocking refutation of the artifact routed to reject rejects the item, unless a required requirement is incomplete first (V05 R[3])', () => {
    const rejecting = req({ errorTable: [{ code: 'p.x', action: 'reject' }] });
    const base = run({ requirements: [rejecting], checks: [{ id: 'c1', judges: 'artifact_under_verification', tier: null }] });
    const e = expected(base, handled, refuteX);
    assert.equal(e.items[0].partition, 'rejected');
    assert.equal(e.items[0].code, 'p.x');
    assert.equal(e.items[0].requirements[0].layers[0].attribution, 'producer_error');
    assert.deepEqual(e.errors, [{ kind: 'refutation', code: 'p.x', item: 'i1', requirement: 'r1' }]);
    const both = run({
      requirements: [rejecting, req({ key: 'r2', checks: ['c2'] })],
      checks: [
        { id: 'c1', judges: 'artifact_under_verification', tier: null },
        { id: 'c2', judges: 'artifact_under_verification', tier: null },
      ],
      roundsUsed: 2,
    });
    const out = expected(both, handled, { ...refuteX, c2: { i1: [{ verdict: 'refute', code: 'p.x', tier: 'blocking' }] } });
    assert.equal(out.items[0].partition, 'incomplete');
    assert.equal(out.items[0].reason, 'repair_exhausted');
    // The rejection remains an item-level refutation. V05 R[3] only decides the partition.
    assert.deepEqual(out.errors, [
      { kind: 'refutation', code: 'p.x', item: 'i1', requirement: 'r1' },
      { kind: 'refutation', code: 'p.x', item: 'i1', requirement: 'r2', rounds_left: 0 },
      {kind:'unknown',code:'repair_exhausted',item:'i1',requirement:'r2',rounds_left:0},
    ]);
  });

  it('a declared dynamic layer is not run, which leaves the requirement pending (V03 R[1], R[4], R[5])', () => {
    const e = expected(run({ requirements: [req({ layers: ['static', 'dynamic'] })] }), handled, support);
    assert.deepEqual(e.items[0].requirements[0], {
      requirement: 'r1',
      layers: [
        { layer: 'static', terminal: 'pass' },
        { layer: 'dynamic', terminal: 'not_run', reason: 'no_check', attribution: 'unattributed' },
      ],
      status: 'pending',
    });
    assert.deepEqual(e.items[0].cells.dynamic, { value: 'not_run', counts: { not_run: 1 } });
    assert.equal(e.counts.unknown, 1);
    // No static layer to receive the check: the refutation is not recorded as a dynamic fail (V03 R[5]).
    const onlyDynamic = expected(run({ requirements: [req({ layers: ['dynamic'] })] }), handled, refuteX);
    assert.equal(onlyDynamic.items[0].partition, 'delivered');
    assert.deepEqual(onlyDynamic.items[0].requirements[0].layers, [{ layer: 'dynamic', terminal: 'not_run', reason: 'no_check', attribution: 'unattributed' }]);
    assert.deepEqual(onlyDynamic.errors, [{kind:'unknown',code:'no_check',item:'i1',requirement:'r1',rounds_left:2}]);
  });

  it('repair rounds are the rounds of the code that was refuted, not the largest row of the requirement (W02 F[7])', () => {
    const table = req({
      errorTable: [
        { code: 'p.x', action: 'repair', maxRounds: 1 },
        { code: 'p.y', action: 'repair', maxRounds: 3 },
      ],
    });
    const usedUp = expected(run({ roundsUsed: 1, requirements: [table], checks: [{ id: 'c1', judges: 'artifact_under_verification', tier: null }] }), handled, refuteX);
    assert.equal(usedUp.items[0].partition, 'incomplete');
    assert.equal(usedUp.items[0].reason, 'repair_exhausted');
    assert.deepEqual(usedUp.rounds, { used: 1, max: 3 });
    assert.equal(usedUp.errors[0].rounds_left, 0);
    const open = expected(run({ roundsUsed: 1, requirements: [table], checks: [{ id: 'c1', judges: 'artifact_under_verification', tier: null }] }), handled, { c1: { i1: [{ verdict: 'refute', code: 'p.y', tier: 'blocking' }] } });
    assert.equal(open.items[0].partition, 'delivered');
    assert.equal(open.items[0].requirements[0].layers[0].code, 'p.y');
    assert.deepEqual(open.errors, []);
  });

  it('reject reaches the rejected partition only for a blocking code on the artifact (W02 F[7], V05 R[2])', () => {
    const rejecting = req({ errorTable: [{ code: 'p.x', action: 'reject' }] });
    const artifact = run({ requirements: [rejecting], checks: [{ id: 'c1', judges: 'artifact_under_verification', tier: null }] });
    assert.equal(expected(artifact, handled, refuteX).items[0].partition, 'rejected');
    const advisory = run({ requirements: [rejecting], checks: [{ id: 'c1', judges: 'artifact_under_verification', tier: 'advisory' }] });
    const advised = expected(advisory, handled, { c1: { i1: [{ verdict: 'refute', code: 'p.x', tier: 'blocking' }] } });
    assert.equal(advised.items[0].partition, 'delivered');
    assert.equal(advised.items[0].requirements[0].layers[0].tier, 'advisory');
    const subject = expected(run({ requirements: [rejecting] }), handled, refuteX);
    assert.equal(subject.items[0].partition, 'delivered');
    // The check judges the subject, which is the author's input (V04 F[1]), and the row is not a repair (T03 R[4]).
    assert.equal(subject.items[0].requirements[0].layers[0].attribution, 'author_input');
    assert.deepEqual(advised.errors, []);
    assert.deepEqual(subject.errors, []);
    const refused = expected(artifact, { ...handled, defects: ['SUBMISSION_SCHEMA_VIOLATION'] }, refuteX);
    assert.deepEqual(refused.items, []);
    assert.deepEqual(refused.errors, [
      { kind: 'protocol', code: 'SUBMISSION_SCHEMA_VIOLATION' },
      { kind: 'refutation', code: 'p.x', item: 'i1', requirement: 'r1' },
    ]);
  });

  it('optional requirements alone do not force an item into incomplete (W07 R[3], V05 R[3])', () => {
    const e = expected(run({ requirements: [req({ required: false,producer:'judgment' })] }), { ...handled, items: {} }, support);
    assert.equal(e.items[0].partition, 'delivered');
    assert.equal(e.items[0].reason, undefined);
    assert.equal(e.errors[0].kind, 'not_covered');
  });

  it('a submission that is not accepted has no partitions and lists its codes and the item-level refutations (W08 R[1])', () => {
    const e = expected(run({ checks: [{ id: 'c1', judges: 'artifact_under_verification', tier: null }] }), { ...handled, defects: ['SUBMISSION_SCHEMA_VIOLATION'] }, refuteX);
    assert.equal(e.acceptance, 'not_accepted');
    assert.deepEqual(e.items, []);
    assert.deepEqual(e.counts, { delivered: 0, rejected: 0, quarantined: 0, incomplete: 0, unknown: 0 });
    assert.deepEqual(e.errors, [
      { kind: 'protocol', code: 'SUBMISSION_SCHEMA_VIOLATION' },
      { kind: 'refutation', code: 'p.x', item: 'i1', requirement: 'r1', rounds_left: 2 },
    ]);
  });

  it('one item and one static requirement, over producer, handling, outcome and negative expectation', () => {
    const producers = ['fact', 'judgment', 'independent_judgment'] as const;
    const handlings = ['handled', 'skipped', 'missing'] as const;
    const outcomes = ['pass', 'violation', 'unknown', 'incomplete'] as const;
    const author = { session: 's1', model: 'alpha@1' };
    const judge = { session: 's2', model: 'beta@2' };
    for (const producer of producers) {
      for (const handling of handlings) {
        for (const outcome of outcomes) {
          for (const negative of [false, true]) {
            const description = run({
              items: [{ id: 'i1', negative }],
              roundsUsed: outcome === 'incomplete' ? 2 : 0,
              author,
              checks: [{ id: 'c1', judges: outcome === 'incomplete' ? 'artifact_under_verification' : 'subject', tier: null }],
              requirements: [req({ producer, acceptsDeclaredIndependence: producer === 'independent_judgment', negativeCodes: negative ? ['p.x'] : null })],
            });
            const submission: SubmissionDescription = {
              judge,
              items: handling === 'missing' ? {} : { i1: { handling } },
              defects: [],
            };
            const checks: CheckOutcomes =
              outcome === 'pass'
                ? support
                : outcome === 'unknown'
                  ? { c1: { i1: [{ verdict: 'unknown', reason: 'timeout' }] } }
                  : refuteX;
            const got = expected(description, submission, checks);
            const layer = got.items[0].requirements[0].layers[0];
            const where = `${producer}/${handling}/${outcome}/${negative ? 'negative' : 'plain'}`;
            if (handling !== 'handled' && (producer !== 'fact' || outcome === 'incomplete')) {
              assert.equal(layer.terminal, 'incomplete', where);
              assert.equal(layer.reason,outcome==='incomplete'?'repair_exhausted':handling === 'skipped' ? 'declared_skip' : 'not_covered', where);
              assert.equal(layer.attribution,outcome==='incomplete'?'producer_error':'unattributed', where);
              assert.equal(got.items[0].requirements[0].status, 'pending', where);
              assert.equal(got.items[0].partition, 'incomplete', where);
              assert.equal(got.counts.unknown, 0, where);
              continue;
            }
            if (outcome === 'unknown') {
              assert.equal(layer.terminal, 'unchecked', where);
              assert.equal(layer.reason, 'timeout', where);
              assert.equal(layer.attribution, 'transient', where);
              assert.equal(got.items[0].requirements[0].status, 'pending', where);
              assert.equal(got.items[0].partition, 'delivered', where);
              assert.equal(got.counts.unknown, 1, where);
              continue;
            }
            if (outcome === 'incomplete' && !negative) {
              assert.equal(layer.terminal, 'incomplete', where);
              assert.equal(layer.reason, 'repair_exhausted', where);
              assert.equal(got.items[0].partition, 'incomplete', where);
              assert.equal(got.items[0].requirements[0].status, 'pending', where);
              assert.equal(got.errors[0]?.rounds_left, 0, where);
              continue;
            }
            if (outcome === 'violation' || (outcome === 'incomplete' && negative)) {
              // An expected refutation is satisfied and is not sent to repair, so used-up rounds do not apply (V04 R[1]).
              assert.equal(layer.terminal, 'violation', where);
              assert.equal(layer.code, 'p.x', where);
              assert.equal(layer.attribution, negative ? undefined : 'author_input', where);
              assert.equal(got.items[0].requirements[0].status, negative ? 'satisfied' : 'unsatisfied', where);
              if (!negative) assert.equal(got.items[0].requirements[0].unsatisfied_reason, 'outcome_mismatch', where);
              assert.equal(got.items[0].partition, 'delivered', where);
              assert.equal(got.errors.length, 0, where);
              continue;
            }
            const judgment = producer !== 'fact';
            assert.equal(layer.terminal, judgment ? 'judgment' : 'pass', where);
            assert.equal(layer.attribution, undefined, where);
            assert.equal(got.items[0].requirements[0].status, negative ? 'unsatisfied' : 'satisfied', where);
            if (negative) assert.equal(got.items[0].requirements[0].unsatisfied_reason, 'outcome_mismatch', where);
            assert.equal(got.items[0].partition, 'delivered', where);
            assert.equal(got.counts.unknown, 0, where);
          }
        }
      }
    }
  });

  it('the cell projection follows V03 R[3] and counts every non-pass terminal', () => {
    assert.deepEqual(cellOf('static', ['pass', 'judgment', 'unchecked', 'violation']), { value: 'violation', counts: { judgment: 1, unchecked: 1, violation: 1 } });
    assert.deepEqual(cellOf('static', ['pass', 'judgment']), { value: 'judgment', counts: { judgment: 1 } });
    assert.deepEqual(cellOf('static', ['unchecked', 'incomplete']), { value: 'incomplete', counts: { unchecked: 1, incomplete: 1 } });
    assert.deepEqual(cellOf('dynamic', ['not_run', 'pass', 'incomplete']), { value: 'incomplete', counts: { not_run: 1, incomplete: 1 } });
    assert.equal(cellOf('dynamic', []), null);
  });
});

it('unknowns and skipped work name each requirement and its remaining budget',()=>{
  const unknown=expected(run(),handled,{c1:{i1:[{verdict:'unknown',reason:'timeout'}]}});
  assert.deepEqual(unknown.errors,[{kind:'unknown',code:'timeout',item:'i1',requirement:'r1',rounds_left:2}]);
  const skipped=expected(run({requirements:[req({producer:'judgment'})]}),{...handled,items:{i1:{handling:'skipped'}}},support);
  assert.deepEqual(skipped.errors,[{kind:'not_covered',code:'declared_skip',item:'i1',requirement:'r1',rounds_left:2}]);
});
it('a record-unknown row remains a violation and names the request in receipt errors',()=>{
  const value=expected(run({requirements:[req({errorTable:[{code:'p.x',action:'unknown'}]})],checks:[{id:'c1',judges:'artifact_under_verification',tier:null}]}),handled,refuteX);
  assert.equal(value.items[0].requirements[0].layers[0].terminal,'violation');
  assert.deepEqual(value.errors,[{kind:'refutation',code:'p.x',item:'i1',requirement:'r1'}]);
});
