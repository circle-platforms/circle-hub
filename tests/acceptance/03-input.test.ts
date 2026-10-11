import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { setup } from './harness.ts';

test('Act 3: every response is recorded and bound to the current input revision and server time', async t => {
  const h = await setup(t, { CIRCLE_SERVER_INPUT_TTL_MS: '300' });
  const task = await h.submit({ requiredFields: ['target'] });
  const waiting = await h.phase(task.taskId, 'waiting-input');
  const old = waiting.pendingInputs[0];
  const revised = await h.request(`/v1/tasks/${task.taskId}/input`, { inputRevisionId: task.inputRevisionId,
    replacement: { requiredFields: ['version'], target: 'LBX-LAB-01' } });
  await h.reject(`/v1/tasks/${task.taskId}/input`, { inputRevisionId: task.inputRevisionId, requestId: old.requestId,
    response: { target: 'LBX-LAB-01' } }, 'INPUT_REVISION_STALE');
  const pending = (await h.phase(task.taskId, 'waiting-input')).pendingInputs.find((row: any) => row.inputRevisionId === revised.inputRevisionId);
  await delay(350);
  await h.reject(`/v1/tasks/${task.taskId}/input`, { inputRevisionId: revised.inputRevisionId, requestId: pending.requestId,
    response: { version: '8.4.2' }, respondedAt: '2026-01-01T00:00:00Z', actorId: 'prn_admin' }, 'INPUT_EXPIRED');
  const decisions = (await h.db.query('SELECT outcome, principal_id FROM decisions WHERE task_id=$1 ORDER BY created_at', [task.taskId])).rows;
  assert.deepEqual(decisions.map(row => row.outcome), ['stale-revision', 'expired']);
  assert.ok(decisions.every(row => row.principal_id === 'prn_alice'));
  const current = await h.status(task.taskId);
  const acceptedTask = await h.request(`/v1/tasks/${task.taskId}/input`, { inputRevisionId: current.inputRevisionId,
    replacement: { requiredFields: ['version'], target: 'LBX-LAB-01' } });
  const newPending = (await h.phase(task.taskId, 'waiting-input')).pendingInputs.find((row: any) => row.inputRevisionId === acceptedTask.inputRevisionId);
  const result = await h.request(`/v1/tasks/${task.taskId}/input`, { inputRevisionId: acceptedTask.inputRevisionId,
    requestId: newPending.requestId, response: { version: '8.4.2' } });
  assert.notEqual(result.inputRevisionId, acceptedTask.inputRevisionId);
  assert.equal((await h.db.query("SELECT 1 FROM decisions WHERE task_id=$1 AND outcome='accepted'", [task.taskId])).rowCount, 1);
});
