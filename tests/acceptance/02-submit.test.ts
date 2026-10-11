import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setup } from './harness.ts';

test('Act 2: concurrent scoped idempotency and transaction rollback at durable wakeup', async t => {
  const h = await setup(t);
  const request = { scopeId: 'scp_lab', title: 'Atomic admission', input: { requiredFields: ['target'] }, idempotencyKey: 'atomic-key' };
  const duplicates = await Promise.all(Array.from({ length: 6 }, () => h.request('/v1/tasks/submit', request)));
  assert.equal(new Set(duplicates.map(row => row.taskId)).size, 1);
  assert.equal(duplicates.filter(row => row.deduplicated).length, 5);
  assert.match(duplicates[0].taskId, /^task_/); assert.match(duplicates[0].inputRevisionId, /^inrev_/);
  await h.reject('/v1/tasks/submit', { ...request, title: 'Different content' }, 'IDEMPOTENCY_MISMATCH');
  const otherProject = await h.request('/v1/tasks/submit', { ...request, scopeId: 'scp_second' });
  assert.notEqual(otherProject.taskId, duplicates[0].taskId);
  const taskId = duplicates[0].taskId;
  for (const table of ['tasks', 'idempotency', 'wakeups', 'outbox']) {
    assert.ok((await h.db.query(`SELECT 1 FROM ${table} WHERE task_id=$1`, [taskId])).rowCount! > 0);
  }
  await h.db.query(`CREATE FUNCTION acceptance_reject_wakeup() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'synthetic admission rollback'; END; $$;
    CREATE TRIGGER reject_wakeup BEFORE INSERT ON wakeups FOR EACH ROW EXECUTE FUNCTION acceptance_reject_wakeup()`);
  await h.reject('/v1/tasks/submit', { ...request, idempotencyKey: 'rollback-key', title: 'Must roll back' }, 'INTERNAL_ERROR');
  assert.equal((await h.db.query("SELECT 1 FROM tasks WHERE title='Must roll back'")).rowCount, 0);
  assert.equal((await h.db.query("SELECT 1 FROM idempotency WHERE idem_key='rollback-key'")).rowCount, 0);
  assert.equal((await h.db.query("SELECT 1 FROM outbox WHERE payload->>'title'='Must roll back'")).rowCount, 0);
  await h.db.query('DROP TRIGGER reject_wakeup ON wakeups; DROP FUNCTION acceptance_reject_wakeup()');
});
