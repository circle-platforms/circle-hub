import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  ProtocolError, CallErrorReasonSchema, CALL_ERROR_REASON, CALL_ERROR_REASON_RULES, SCHEMA_REGISTRY,
  resolveCallErrorReason, formatCallErrorReason, formatCallError, type CallErrorReason, type PermissionRole,
} from '../api.ts';

test('public optional reason accepts the generated closed schema without changing machine code or source message', () => {
  const original = { code: 'SOURCE_NOT_PERMITTED', message: '预订测试环境「合成环境」被拒：当前账户没有分配', fix: '原source改法', path: '/lease_requests' };
  assert.deepEqual(ProtocolError.parse(original), original);
  assert.deepEqual(ProtocolError.parse({ ...original, call_error_reason: 'environment_unassigned' }), { ...original, call_error_reason: 'environment_unassigned' });
  assert.equal(ProtocolError.safeParse({ ...original, call_error_reason: 'made_up_reason' }).success, false);
  assert.equal(SCHEMA_REGISTRY['call-error-reason@1'], CallErrorReasonSchema);
  const published = JSON.parse(readFileSync(new URL('../generated/schemas/call-error-reason.v1.schema.json', import.meta.url), 'utf8'));
  assert.deepEqual(published.enum, [...CALL_ERROR_REASON]);
});

test('generated reason table has exactly the model rows and actual-role actions', () => {
  const model = JSON.parse(readFileSync(new URL('../model.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(CALL_ERROR_REASON_RULES), [...CALL_ERROR_REASON]);
  for (const row of model.formatProposals.callErrorReasons) {
    const reason = CallErrorReasonSchema.parse(row.reason);
    assert.deepEqual(CALL_ERROR_REASON_RULES[reason], { codes: row.codes, classification: row.classification, next_by_role: row.next_by_role });
    for (const role of ['user', 'admin'] as const) assert.deepEqual(resolveCallErrorReason(row.codes[0], reason, role), {
      classification: row.classification, nextAction: row.next_by_role[role],
    });
  }
});

test('the public formatter uses one generated classification and role action, never facts as classification input', () => {
  const sourceMessage = '上机验证「合成环境」被拒，原件里有“已被占用”四个字，实际原因是未分配';
  for (const role of ['user', 'admin'] as const) {
    const rule = CALL_ERROR_REASON_RULES.environment_unassigned;
    assert.equal(formatCallErrorReason('SOURCE_NOT_PERMITTED', 'environment_unassigned', role, sourceMessage),
      formatCallError('permission_denied', sourceMessage, rule.next_by_role[role]));
  }
  assert.deepEqual(resolveCallErrorReason('SOURCE_NOT_PERMITTED', 'environment_disabled', 'user')?.classification, { category: 'temporarily_unavailable' });
  assert.deepEqual(resolveCallErrorReason('LEASE_UNAVAILABLE', 'environment_registration_inconsistent', 'admin')?.classification, { category: 'temporarily_unavailable' });
});

test('invalid code/reason/role pairs and explicit unknown never gain an invocation prefix', () => {
  assert.equal(resolveCallErrorReason('LEASE_UNAVAILABLE', 'environment_unassigned', 'admin'), null);
  assert.equal(resolveCallErrorReason('SOURCE_NOT_PERMITTED', '__proto__' as CallErrorReason, 'admin'), null);
  assert.equal(resolveCallErrorReason('SOURCE_NOT_PERMITTED', 'environment_unassigned', 'operator' as PermissionRole), null);
  assert.equal(formatCallErrorReason('LEASE_UNAVAILABLE', 'environment_unassigned', 'user', '原事实'), null);
  assert.deepEqual(resolveCallErrorReason('SOURCE_UNAVAILABLE', 'lease_reader_unavailable', 'user')?.classification, { unknown: true });
  assert.equal(formatCallErrorReason('SOURCE_UNAVAILABLE', 'lease_reader_unavailable', 'user', '这次运行的预订记录尚未读到'), null);
});
