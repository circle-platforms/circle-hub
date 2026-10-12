import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setup, until } from './harness.ts';

test('Act 4: replay resumes without loss or duplicate events across server process death', async t => {
  const h = await setup(t);
  const task = await h.submit({ requiredFields: ['target'] });
  const waiting = await h.phase(task.taskId, 'waiting-input');
  const first = await h.request(`/v1/tasks/${task.taskId}/events?after=0`);
  assert.ok(first.events.length >= 2);
  const after = first.events.at(-1).seq;
  const controller = new AbortController();
  const disconnected = fetch(`${h.url}/v1/tasks/${task.taskId}/events?after=${after}&waitMs=2000`, {
    headers: { authorization: `Bearer ${await h.login()}` }, signal: controller.signal }).catch(() => undefined);
  controller.abort(); await disconnected;
  assert.equal((await h.status(task.taskId)).phase, 'waiting-input');
  await h.stop(h.server, 'SIGKILL'); await h.startServer();
  assert.equal((await h.status(task.taskId)).inputRevisionId, waiting.inputRevisionId);
  const pending = waiting.pendingInputs[0];
  await h.request(`/v1/tasks/${task.taskId}/input`, { requestId: pending.requestId,
    inputRevisionId: task.inputRevisionId, response: { target: 'RESOURCE-LAB-01' } });
  await until(async () => (await h.status(task.taskId)).phase === 'running');
  const replay = await h.request(`/v1/tasks/${task.taskId}/events?after=${after}`);
  assert.ok(replay.events.length >= 2);
  assert.equal(new Set([...first.events, ...replay.events].map((event: any) => event.seq)).size, first.events.length + replay.events.length);
  assert.ok(replay.events.every((event: any) => event.seq > after));
  assert.deepEqual((await h.request(`/v1/tasks/${task.taskId}/events?after=${after}`)).events, replay.events);
  assert.equal((await h.db.query("SELECT 1 FROM outbox WHERE task_id=$1 AND kind='task.cancel-requested'", [task.taskId])).rowCount, 0);
  assert.equal((await h.status(task.taskId)).flowVersion, 'task/1');
});
