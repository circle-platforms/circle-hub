import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deviceReturnRef, isFrozenJob, isNotDispatchedJob, parseRunJobs, settledDispatch, type ExportedJob } from './delivery.ts';

const RUN = 'run_01aaaaaaaaaaaaaaaaaaaaaaaa';
const PLAN = 'run_01bbbbbbbbbbbbbbbbbbbbbbbb';
const JOB = 'a'.repeat(64);
const SHA = 'b'.repeat(64);

function makeJob(overrides: Partial<ExportedJob> = {}): ExportedJob {
  return {
    job: JOB,
    verification_run: RUN,
    plan_run: PLAN,
    items: ['case-1'],
    sha256: SHA,
    ended: 'done',
    job_facts: {
      scope: { job: JOB },
      frozen: false,
      result: `src:${'9'.repeat(64)}`,
      device_return: `src:${'8'.repeat(64)}`,
      rounds: [{ round: 1, terminal: 'pass', dispatch_attempt: { scope: { operation: 'dispatch', job: JOB, round: 1 }, outcome: 'effective', result: `src:${'9'.repeat(64)}` } }],
    },
    dispatch_attempt: { scope: { operation: 'dispatch', job: JOB, round: 1 }, outcome: 'effective', result: `src:${'9'.repeat(64)}` },
    rows: [{ item: 'case-1', dynamic_terminal: 'pass' }],
    ...overrides,
  };
}

test('parseRunJobs requires run-jobs@2 and matching job scope', () => {
  const valid = { schema: 'run-jobs@2', run: RUN, jobs: [makeJob()] };
  assert.equal(parseRunJobs(valid, RUN).length, 1);
  assert.throws(() => parseRunJobs({ ...valid, schema: 'run-jobs@1' }, RUN), /不完整/);
  assert.throws(
    () => parseRunJobs({ schema: 'run-jobs@2', run: RUN, jobs: [makeJob({ job_facts: { scope: { job: 'f'.repeat(64) } } })] }, RUN),
    /不完整/,
  );
  assert.throws(
    () => parseRunJobs({ schema: 'run-jobs@2', run: RUN, jobs: [makeJob({ dispatch_attempt: { scope: { operation: 'dispatch', job: 'f'.repeat(64), round: 1 }, outcome: 'effective' } })] }, RUN),
    /不完整/,
  );
});

test('later not_dispatched attempt never hides round-one execution, verdict or historical device_return', () => {
  const round2Unsent = makeJob({
    job_facts: {
      scope: { job: JOB },
      frozen: false,
      result: `src:${'c'.repeat(64)}`,
      device_return: `src:${'e'.repeat(64)}`,
      rounds: [
        { round: 1, terminal: 'pass', dispatch_attempt: { scope: { operation: 'dispatch', job: JOB, round: 1 }, outcome: 'effective', result: `src:${'c'.repeat(64)}` } },
        { round: 2, terminal: 'not_run', dispatch_attempt: { scope: { operation: 'dispatch', job: JOB, round: 2 }, outcome: 'not_dispatched', not_sent: true } },
      ],
    },
    dispatch_attempt: { scope: { operation: 'dispatch', job: JOB, round: 2 }, outcome: 'not_dispatched', not_sent: true },
  });
  assert.equal(isNotDispatchedJob(round2Unsent), false);
  assert.equal(deviceReturnRef(round2Unsent), `src:${'e'.repeat(64)}`);
  assert.equal(settledDispatch(RUN, [round2Unsent]).job, JOB);
});

test('isNotDispatchedJob holds only when the whole job ended with no dispatch execution', () => {
  const wholeNotSent = makeJob({
    job_facts: {
      scope: { job: JOB },
      frozen: false,
      rounds: [{ round: 1, terminal: 'not_run', dispatch_attempt: { scope: { operation: 'dispatch', job: JOB, round: 1 }, outcome: 'not_dispatched', not_sent: true } }],
    },
    dispatch_attempt: { scope: { operation: 'dispatch', job: JOB, round: 1 }, outcome: 'not_dispatched', not_sent: true },
    rows: null,
  });
  assert.equal(isNotDispatchedJob(wholeNotSent), true);

  const preIntentRefusal = makeJob({
    job_facts: { scope: { job: JOB }, frozen: false, admission_error: { code: 'SOURCE_NOT_PERMITTED' } },
    dispatch_attempt: undefined,
    rows: null,
  });
  assert.equal(isNotDispatchedJob(preIntentRefusal), true);

  const conformanceOnly = makeJob({
    job_facts: { scope: { job: JOB }, frozen: false },
    dispatch_attempt: { scope: { operation: 'conformance', job: JOB }, outcome: 'not_dispatched' },
    rows: null,
  });
  assert.equal(isNotDispatchedJob(conformanceOnly), false);
});

test('settledDispatch blocks frozen or unknown jobs without failing on an unrelated prior round', () => {
  const frozen = makeJob({
    job_facts: { scope: { job: JOB }, frozen: true },
    dispatch_attempt: { scope: { operation: 'dispatch', job: JOB, round: 1 }, outcome: 'unknown' },
    rows: null,
  });
  assert.equal(isFrozenJob(frozen), true);
  assert.throws(() => settledDispatch(RUN, [frozen]), /上机验证状态未知/);
});
