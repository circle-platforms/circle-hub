import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selectCurrentRecords, type CurrentRecord } from './selection.ts';
const hash = (n: number) => n.toString(16).padStart(64, '0');
const user = 'usr_' + '0'.repeat(25) + '1', at = '2026-11-14T00:00:00.000Z';
const history: CurrentRecord = { digest: hash(1), kind: 'call_log', schema: 'call_log@1', body: {
  at, trace_id: '1'.repeat(32), span_id: '2'.repeat(16), user: null, session: null, tool: 'list_task_packs', run: null,
  args_digest: hash(9), args_size: 2, args_preview: null, call_result: 'ok', acceptance: null, error_code: null, duration_ms: 1,
} };
const grant: CurrentRecord = { digest: hash(2), kind: 'authorization', schema: 'authorization@1', body: {
  permission: 'resource_assign', subject: user, object: 'exe_' + '0'.repeat(26), revoked: false, bound: null,
  decided_by: user, decided_at: at, expires_at: null, note: 'synthetic', supersedes: null,
} };
test('retained external snapshot source blocks deletion without changing record scope ownership', () => {
  const result = selectCurrentRecords([history, grant], new Set(['history']), { externalRoots: [{
    table: 'environment_assignment_snapshot', row: 1, references: [{ kind: 'record', digest: history.digest, field: '/snapshot/sourceRecords/0', recordAlias: false }],
  }] });
  assert.deepEqual(result.cleared, [history.digest]); assert.deepEqual(result.retained, [grant.digest]);
  assert.ok(result.blocked.some(problem => problem.table === 'environment_assignment_snapshot' && problem.reason.includes('/snapshot/sourceRecords/0')));
});
test('retained completion references block config deletion, never implicit grant retention', () => {
  const result = selectCurrentRecords([history, grant], new Set(['config']), { externalRoots: [{
    table: 'environment_assignment_completion', row: 1, references: [{ kind: 'record', digest: grant.digest, field: '/authorization_records/0', recordAlias: false }],
  }] });
  assert.deepEqual(result.cleared, [grant.digest]);
  assert.ok(result.blocked.some(problem => problem.table === 'environment_assignment_completion' && problem.reason.includes('/authorization_records/0')));
});
test('external roots must resolve actual formal targets; empty fresh roots add no ownership', () => {
  const empty = selectCurrentRecords([history], new Set(['history']), { externalRoots: [] });
  assert.deepEqual(empty.cleared, [history.digest]); assert.deepEqual(empty.blocked, []);
  const missing = selectCurrentRecords([history], new Set(['history']), { externalRoots: [{ table: 'environment_assignment_snapshot', row: 1,
    references: [{ kind: 'record', digest: hash(100), field: '/snapshot/sourceRecords/0', recordAlias: false }],
  }] });
  assert.ok(missing.blocked.some(problem => problem.reason.includes('缺少已核对')));
});
