import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DYNAMIC_TERMINAL, EFFECT_OUTCOME } from '../generated/vocabulary.ts';
import { RUN_HISTORY_MAX_RUNS, RunHistoryExport } from './run.ts';

const RUN = 'run_01aaaaaaaaaaaaaaaaaaaaaaaa', OTHER = 'run_01bbbbbbbbbbbbbbbbbbbbbbbb', PLAN = 'run_01cccccccccccccccccccccccc';
const job = { job: 'c'.repeat(64), plan_run: PLAN, ended_at: '2026-11-19T03:00:00.000Z', outcome: 'effective', rows: [{ item: 'case-1', dynamic_terminal: 'pass' }, { item: 'case-2', dynamic_terminal: 'fail' }] };
const answer = { schema: 'run-history@1', run: RUN, subjects: ['mind-map:document:1'], limit: 8, complete: true, runs: [{ run: OTHER, started_at: '2026-11-19T02:00:00.000Z', build: 'build-2.1-7', jobs: [job] }] };

test('run-history@1 holds recorded facts only, in the generated vocabulary', () => {
  assert.deepEqual(RunHistoryExport.parse(answer), answer);
  assert.ok(RunHistoryExport.safeParse({ ...answer, subjects: [], runs: [] }).success, 'a run nothing earlier verified answers an empty list');
  assert.ok(RunHistoryExport.safeParse({ ...answer, runs: [{ ...answer.runs[0], build: null, jobs: [{ ...job, plan_run: null, ended_at: null, rows: null }] }] }).success, 'what is not recorded, or may not be shown, is null');
  for (const terminal of DYNAMIC_TERMINAL) assert.ok(RunHistoryExport.safeParse({ ...answer, runs: [{ ...answer.runs[0], jobs: [{ ...job, rows: [{ item: 'case-1', dynamic_terminal: terminal }] }] }] }).success, terminal);
  for (const outcome of EFFECT_OUTCOME) assert.ok(RunHistoryExport.safeParse({ ...answer, runs: [{ ...answer.runs[0], jobs: [{ ...job, outcome }] }] }).success, outcome);
  assert.equal(RUN_HISTORY_MAX_RUNS, 8);
});

test('run-history@1 refuses a word outside the vocabulary, a judgment of its own and a bound outside 1..8', () => {
  const refused = (value: unknown) => assert.equal(RunHistoryExport.safeParse(value).success, false, JSON.stringify(value).slice(0, 200));
  refused({ ...answer, runs: [{ ...answer.runs[0], jobs: [{ ...job, rows: [{ item: 'case-1', dynamic_terminal: 'passed' }] }] }] });
  refused({ ...answer, runs: [{ ...answer.runs[0], jobs: [{ ...job, outcome: 'ok' }] }] });
  refused({ ...answer, runs: [{ ...answer.runs[0], jobs: [{ ...job, rows: [{ item: 'case-1', dynamic_terminal: 'pass', log: `src:${'1'.repeat(64)}` }] }] }] });
  refused({ ...answer, runs: [{ ...answer.runs[0], jobs: [] }] });
  refused({ ...answer, runs: [{ ...answer.runs[0], advice: '合成：照这个写' }] });
  refused({ ...answer, limit: 0 });
  refused({ ...answer, limit: 9 });
  refused({ ...answer, schema: 'run-history@2' });
});
