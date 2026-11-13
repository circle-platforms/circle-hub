import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RunRecord } from '../../contracts/src/run.ts';
import { RECORD_KINDS } from '../../contracts/generated/protocol.ts';
import type { Principal, StoredRecord, User } from './api.ts';
import { canSeeRun, isAdmin } from './permissions.ts';
import { RECORD_ACCESS, mayReadRecord, runOfRecord, type RecordVisibilityPorts } from './record-visibility.ts';

const alice: User = { id: 'synthetic-alice', name: '甲', role: 'user', disabled: false, created_at: '2026-11-13T00:00:00.000Z', updated_at: '2026-11-13T00:00:00.000Z' };
const admin: Principal = { id: 'synthetic-admin', name: '管理员', role: 'admin' };
const run = { run: 'synthetic-run', runner: alice.id, host: 'local_circle', pack_space: 'team' } as RunRecord;
const record = (kind: StoredRecord['kind'], body: unknown = {}, schema = kind + '@1'): StoredRecord => ({ kind, body, schema, digest: 'a'.repeat(64), id: 'synthetic-record', provenance: 'observed', created_at: alice.created_at });
const ports = (changes: Partial<RecordVisibilityPorts> = {}): RecordVisibilityPorts => ({ account: async () => alice, run: async () => run, source: async () => false, contribution: async () => false, request: async () => true, result: async () => true, submission: async () => true, ...changes });

test('every registered record kind has an access rule', () => {
  assert.deepEqual(Object.keys(RECORD_ACCESS).sort(), [...RECORD_KINDS].sort());
});

test('personal runs remain private to their runner, including against administrators', () => {
  assert.equal(isAdmin(admin), true);
  assert.equal(canSeeRun(admin, { ...run, pack_space: alice.id }), false);
  assert.equal(canSeeRun(admin, run), true);
  assert.equal(canSeeRun(alice, { ...run, host: 'hub' }), false);
  assert.equal(canSeeRun(alice, run), true);
});

test('both run extraction call shapes enforce the received-submission schema', () => {
  const received = record('submission', { received: { run: run.run } }, 'submission-received@1');
  assert.equal(runOfRecord(received), run.run);
  assert.equal(runOfRecord(received.kind, received.body, received.schema), run.run);
  assert.equal(runOfRecord('submission', received.body, 'unrelated@1'), null);
  assert.equal(runOfRecord('authorization', { run: run.run }), null);
  assert.equal(runOfRecord('claim', { run: run.run }, 'hypothesis-set@1'), run.run);
  assert.equal(runOfRecord('submission', { run: run.run, received: { run: 'other' } }, 'submission-received@1'), run.run);
});

test('the current stored account decides, with disabled and deleted accounts refused', async () => {
  const value = record('authorization');
  assert.equal(await mayReadRecord(admin, value, ports()), false);
  assert.equal(await mayReadRecord(alice, value, ports({ account: async () => ({ ...alice, role: 'admin' }) })), true);
  for (const account of [null, { ...alice, disabled: true }, { ...alice, deleted_at: alice.created_at }]) {
    assert.equal(await mayReadRecord(admin, value, ports({ account: async () => account })), false);
  }
});

test('dedicated records and source artifacts never gain a generic administrator bypass', async () => {
  const activeAdmin = ports({ account: async () => ({ ...alice, role: 'admin' }) });
  for (const kind of RECORD_KINDS.filter(kind => RECORD_ACCESS[kind] === 'dedicated')) assert.equal(await mayReadRecord(admin, record(kind), activeAdmin), false, kind);
  assert.equal(await mayReadRecord(admin, record('source_artifact'), activeAdmin), false);
  assert.equal(await mayReadRecord(admin, record('source_artifact'), { ...activeAdmin, source: async () => true }), true);
});

test('read-only sharing does not expose requests, hypotheses or rejected results', async () => {
  const shared = ports({ run: async () => ({ ...run, runner: 'other' }) });
  assert.equal(await mayReadRecord(alice, record('request', { run: run.run }), shared), false);
  assert.equal(await mayReadRecord(alice, record('claim', { run: run.run }, 'hypothesis-set@1'), shared), false);
  assert.equal(await mayReadRecord(alice, record('validation_result', { run: run.run, acceptance: 'not_accepted' }), shared), false);
  assert.equal(await mayReadRecord(alice, record('validation_result', { run: run.run, acceptance: 'accepted' }), shared), true);
  assert.equal(await mayReadRecord(alice, record('validation_result', { run: run.run, acceptance: 'accepted' }), { ...shared, result: async () => false }), false);
});

test('submissions read by someone else require receipts and readable grounds', async () => {
  const value = record('submission', { run: run.run });
  const shared = ports({ run: async () => ({ ...run, runner: 'other' }), submission: async () => false });
  assert.equal(await mayReadRecord(alice, value, shared), false);
  assert.equal(await mayReadRecord(alice, value, { ...shared, submission: async () => true }), true);
  assert.equal(await mayReadRecord(alice, value, { ...shared, run: async () => null }), false);
});

test('contribution reads always use product permissions and memory action audits stay private', async () => {
  const activeAdmin = ports({ account: async () => ({ ...alice, role: 'admin' }) });
  const contribution = record('claim', { statement: { data: { feeding: {} } } }, 'claim@1');
  assert.equal(await mayReadRecord(admin, contribution, activeAdmin), false);
  assert.equal(await mayReadRecord(admin, contribution, { ...activeAdmin, contribution: async () => true }), true);
  assert.equal(await mayReadRecord(admin, record('action', {}, 'memory-refusal@1'), activeAdmin), false);
});
