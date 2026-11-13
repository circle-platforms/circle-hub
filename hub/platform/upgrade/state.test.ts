import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recordDigest, canonicalize } from '../../records/api.ts';
import { selectState, canonicalOldBody, type OldRecord } from './state.ts';
import { PREVIOUS_MIGRATIONS, BASELINE_MIGRATION, schemaGeneration } from './signatures.ts';

const user = 'usr_' + '0'.repeat(26), at = '2026-01-01T00:00:00.000Z';
function row(kind: string, schema: string, body: unknown, seq = '1'): OldRecord {
  const meta = { kind, schema, provenance: 'declared', created_at: at, body };
  return { ...meta, seq, id: 'rcd_' + '0'.repeat(26), digest: recordDigest(meta) };
}
test('only the exact preceding 33 migrations or frozen baseline are accepted', () => {
  assert.equal(schemaGeneration(PREVIOUS_MIGRATIONS), 'previous');
  assert.equal(schemaGeneration([BASELINE_MIGRATION]), 'current');
  assert.throws(() => schemaGeneration(PREVIOUS_MIGRATIONS.slice(1)));
  assert.throws(() => schemaGeneration([{ ...BASELINE_MIGRATION, sha256: '0'.repeat(64) }]));
});
test('space quota state is retained and run history is counted without its body', () => {
  const quota = row('knowledge_space_quota', 'knowledge-space-quota@1', { space: 'team', bytes: 1000, by: user, at });
  const run = { ...row('run', 'run@1', {}), body: undefined };
  const selected = selectState([quota, run], new Set());
  assert.deepEqual([...selected.selected], [quota.digest]);
  assert.deepEqual(selected.issues, []);
  assert.equal(selected.archived.get('run'), 1);
});
test('unknown kinds and mismatched immutable bodies fail with row reasons only', () => {
  const unknown = row('claim', 'unknown@1', { private: 'SyntheticOpaquePrivate938' });
  const selected = selectState([unknown], new Set());
  assert.equal(selected.issues.length, 1);
  assert.deepEqual(selected.issues[0], { table: 'records', row: 1, reason: '没有声明这个种类和模式的迁移规则，不能判作历史丢弃' });
  assert.doesNotMatch(JSON.stringify(selected.issues), /SyntheticOpaquePrivate938/);
});
test('an explicit rec reference to archived history fails closed instead of moving history', () => {
  const run = row('run', 'run@1', {});
  const grant = row('authorization', 'authorization@1', { permission: 'resource_config', subject: '*', object: 'synthetic', revoked: false, bound: run.digest, supersedes: null });
  const selected = selectState([grant, run], new Set());
  assert.equal(selected.issues.length, 1);
  assert.equal(selected.selected.has(run.digest), false);
});
test('a root move keeps an opaque producing RunId without treating it as a missing rec reference', () => {
  const body = { action: 'move_root', result: 'completed', run: 'run_' + '1'.repeat(26), inputs: [], detail: { next: null, previous_action: null, expected: null } };
  const action = row('action', 'action@1', body);
  const grant = row('authorization', 'authorization@1', { permission: 'resource_config', subject: '*', object: 'synthetic', revoked: false, bound: action.digest, supersedes: null });
  const selected = selectState([grant, action], new Set());
  assert.deepEqual(selected.issues, []);
  assert.equal(selected.selected.has(action.digest), true);
});
test('noncanonical old bodies are rejected rather than a runtime fallback being introduced', () => {
  assert.deepEqual(canonicalOldBody(canonicalize({ b: 2, a: 1 })), { a: 1, b: 2 });
  assert.throws(() => canonicalOldBody('{"b":2,"a":1}'));
});

test('the complete old-release fixture has a closed state graph without retaining task history', async () => {
  const { buildOld33Fixture } = await import('./testing/fixtures.ts');
  const fixture = buildOld33Fixture();
  const records = fixture.records.map((record, index) => ({ ...record, seq: String(index + 1) }));
  const aliases = new Map<string, string[]>();
  for (const record of records) for (const entry of record.index) if (['knowledge.node', 'knowledge.entry', 'knowledge.root'].includes(entry.key)) {
    const values = aliases.get(entry.value) ?? []; values.push(record.digest); aliases.set(entry.value, values);
  }
  const selected = selectState(records, new Set(fixture.objects.map(object => object.sha256)), aliases);
  assert.deepEqual(selected.issues, []);
  for (const digest of fixture.archived) assert.equal(selected.selected.has(digest), false);
  for (const digest of fixture.retained) {
    if (fixture.handles.secrets.some(secret => secret.decision === digest)) continue;
    assert.equal(selected.selected.has(digest), true, 'a fixture state record was omitted');
  }
});
