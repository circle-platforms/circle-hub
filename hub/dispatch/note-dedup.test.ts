import assert from 'node:assert/strict';
import { test } from 'node:test';
import { consolidateDispatchNotes, runnerNote } from './accepted.ts';
import type { JobStatus } from './service.ts';

test('one shared next action is said once without dropping any job occurrence', () => {
  const jobs = ['a', 'b'].map((letter) => {
    const job = letter.repeat(64);
    return runnerNote({ job, ended: 'done', boundary_refused: false, status: { job, phase: 'complete', outcome: 'effective', frozen: false, events: 2 } as JobStatus }, 'admin-1');
  });
  const notes = consolidateDispatchNotes(jobs);
  assert.equal(notes.length, 2);
  assert.deepEqual(notes.map((note) => note.job), jobs.map((note) => note.job));
  assert.equal(notes.reduce((count, note) => count + (note.text.match(/下一步：/g)?.length ?? 0), 0), 1);
  assert.equal(consolidateDispatchNotes(notes).length, 2, 'already consolidated notes stay stable');
});
