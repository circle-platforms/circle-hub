import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalize, recordDigest } from '../../records/api.ts';
import { remoteUpgradeIssues } from './remote.ts';
import type { SqlSession } from '../sql.ts';

function event(phase: string, detail: Record<string, unknown> = {}) {
  const at = '2026-01-01T00:00:00.000Z';
  const body = { action: 'validate', run: null, item: null, component: 'dispatch@1', inputs: [], lease: null,
    started_at: at, ended_at: at, result: 'completed', error_code: null, acceptance: null, codes: [],
    detail: { job: 'a'.repeat(64), phase, ...detail } };
  const meta = { kind: 'action', schema: 'action@1', provenance: 'observed', created_at: at, body };
  return { ...meta, body: canonicalize(body), digest: recordDigest(meta), created_at: new Date(at), indexed_job: 'a'.repeat(64), seq: '1', id: 'rcd_' + '0'.repeat(26) };
}
function session(rows: Record<string, unknown>[]): SqlSession { return { query: async () => rows, close: async () => {} }; }

test('no indexed remote job is not confused with an ordinary lease', async () => {
  assert.deepEqual(await remoteUpgradeIssues(session([])), []);
});
test('an uncompleted indexed reservation blocks migration by the existing dispatch decision', async () => {
  const issues = await remoteUpgradeIssues(session([event('reservation')]));
  assert.equal(issues.length, 1);
  assert.match(issues[0]!.reason, /远端作业/);
});
test('confirmed no-send terminal evidence permits archiving its history', async () => {
  assert.deepEqual(await remoteUpgradeIssues(session([event('reservation'), event('boundary_refused', { done: true, outcome: 'not_dispatched', submit_invoked: false })])), []);
});
test('an inconsistent indexed job fails without printing private event data', async () => {
  const row = event('reservation', { note: 'SyntheticOpaquePrivate938' }); row.indexed_job = 'b'.repeat(64);
  const issues = await remoteUpgradeIssues(session([row]));
  assert.equal(issues.length, 1);
  assert.doesNotMatch(JSON.stringify(issues), /SyntheticOpaquePrivate938/);
});
