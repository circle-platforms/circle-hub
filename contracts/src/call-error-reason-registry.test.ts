import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { PermissionRole } from '../generated/vocabulary.ts';
import { resolveCallErrorReasonRule, validateCallErrorReasonRegistry as validateRegistry, type CallErrorReasonRule } from './call-error-reasons.ts';

const model = () => JSON.parse(readFileSync(new URL('../model.json', import.meta.url), 'utf8'));
const reasons = (input = model()): string[] => input.vocabulary.find((axis: { axis: string }) => axis.axis === 'call_error_reason').values.map((value: { code: string }) => value.code);
const rules = (input = model()): Record<string, CallErrorReasonRule> => Object.fromEntries(input.formatProposals.callErrorReasons.map((row: CallErrorReasonRule & { reason: string }) => [row.reason, row]));
const validateCallErrorReasonRegistry = (rows: unknown, reasonCodes: readonly string[]) => {
  const input = model();
  const codes = (name: string): string[] => input.vocabulary.find((axis: { axis: string }) => axis.axis === name).values.map((value: { code: string }) => value.code);
  return validateRegistry(rows, reasonCodes, codes('call_error_category'), codes('permission_role'));
};

test('first reason registry covers the model axis and exactly one classification plus every actual role', () => {
  const input = model();
  assert.deepEqual(validateCallErrorReasonRegistry(input.formatProposals.callErrorReasons, reasons(input)), []);
  assert.equal(input.vocabulary.find((axis: { axis: string }) => axis.axis === 'call_error_reason').owner, 'D05');
  const values = rules(input);
  const labels = input.vocabulary.find((axis: { axis: string }) => axis.axis === 'call_error_reason').values;
  assert.deepEqual(labels.slice(0, 13).map((value: { label: string }) => value.label), [
    '账户已停用', '账户无效', '测试环境已停用', '缺少测试环境分配', '缺少测试环境登记', '测试环境登记不一致',
    '测试环境权限暂不可核对', '资源已有他人预订', '已有本人预订', '缺少本运行预订', '预订已到期', '预订已释放', '预订记录暂不可读取',
  ]);
  for (const row of input.formatProposals.callErrorReasons) {
    assert.equal(typeof row.when, 'string');
    assert.equal(typeof row.meaning, 'string');
    assert.equal('source_condition' in row, false);
  }
  for (const name of ['actor_disabled', 'environment_unassigned']) assert.deepEqual(values[name].classification, { category: 'permission_denied' });
  assert.deepEqual(values.environment_disabled.classification, { category: 'temporarily_unavailable' });
  assert.notDeepEqual(values.actor_disabled.next_by_role, values.environment_unassigned.next_by_role);
  assert.notDeepEqual(values.environment_disabled.next_by_role, values.environment_unassigned.next_by_role);
});

test('invalid code/reason/role combinations are never trusted or inferred from strings', () => {
  const registry = rules();
  assert.equal(resolveCallErrorReasonRule(registry, 'LEASE_UNAVAILABLE', 'environment_unassigned', 'user'), null);
  assert.equal(resolveCallErrorReasonRule(registry, 'SOURCE_NOT_PERMITTED', 'no_such_reason', 'user'), null);
  assert.equal(resolveCallErrorReasonRule(registry, 'SOURCE_NOT_PERMITTED', '__proto__', 'admin'), null);
  assert.equal(resolveCallErrorReasonRule(registry, 'SOURCE_NOT_PERMITTED', 'actor_disabled', 'operator' as PermissionRole), null);
  for (const role of ['user', 'admin'] as const) {
    const found = resolveCallErrorReasonRule(registry, 'SOURCE_NOT_PERMITTED', 'environment_unassigned', role);
    assert.deepEqual(found?.classification, { category: 'permission_denied' });
    assert.equal(found?.nextAction, registry.environment_unassigned.next_by_role[role]);
  }
  assert.deepEqual(resolveCallErrorReasonRule(registry, 'LEASE_UNAVAILABLE', 'lease_missing_for_lineage', 'user')?.classification, { category: 'not_found' });
  assert.deepEqual(resolveCallErrorReasonRule(registry, 'LEASE_UNAVAILABLE', 'lease_held_by_other_account', 'user')?.classification, { category: 'occupied' });
  assert.deepEqual(resolveCallErrorReasonRule(registry, 'LEASE_UNAVAILABLE', 'lease_already_held_by_current_account', 'user')?.classification, { category: 'invalid_parameters' });
});

test('registry rejects missing roles, duplicate reasons, extra classifications and unknown categories', () => {
  for (const mutate of [
    (row: any) => { row.classification.category = 'sixth_category'; },
    (row: any) => { row.classification.unknown = true; },
    (row: any) => { delete row.next_by_role.admin; },
    (row: any) => { row.next_by_role.operator = 'not an actual role'; },
    (row: any) => { row.next_by_role.user = null; },
    (row: any) => { row.codes.push(row.codes[0]); },
  ]) {
    const input = model(); mutate(input.formatProposals.callErrorReasons[0]);
    assert.ok(validateCallErrorReasonRegistry(input.formatProposals.callErrorReasons, reasons(input)).length > 0);
  }
  const input = model(); input.formatProposals.callErrorReasons.push(input.formatProposals.callErrorReasons[0]);
  assert.ok(validateCallErrorReasonRegistry(input.formatProposals.callErrorReasons, reasons(input)).length > 0);
});

test('conclusion and unknown are explicit non-category states, never a sixth call-error word', () => {
  for (const classification of [{ conclusion: true }, { unknown: true }]) {
    const row = { reason: 'synthetic_non_call', codes: ['SYNTHETIC'], classification, next_by_role: { user: null, admin: null } };
    assert.deepEqual(validateCallErrorReasonRegistry([row], [row.reason]), []);
  }
});

test('unreadable lease observations remain unknown and cannot become missing leases', () => {
  const registry = rules();
  const found = resolveCallErrorReasonRule(registry, 'SOURCE_UNAVAILABLE', 'lease_reader_unavailable', 'user');
  assert.deepEqual(found?.classification, { unknown: true });
  assert.equal(found?.nextAction, registry.lease_reader_unavailable.next_by_role.user);
  assert.equal(resolveCallErrorReasonRule(registry, 'LEASE_UNAVAILABLE', 'lease_reader_unavailable', 'user'), null);
  assert.equal(resolveCallErrorReasonRule(registry, 'SOURCE_UNAVAILABLE', 'lease_missing_for_lineage', 'user'), null);
});

test('Boss 20:41 coalesces observed registration contradictions into one temporary reason', () => {
  const input = model(), registry = rules(input);
  assert.deepEqual(input.formatProposals.callErrorReasonCandidates, []);
  for (const retired of [
    'environment_binding_mismatch', 'environment_target_mismatch', 'environment_resource_mismatch',
    'environment_registration_ambiguous',
  ]) {
    assert.equal(reasons(input).includes(retired), false);
    assert.equal(resolveCallErrorReasonRule(registry, 'SOURCE_NOT_PERMITTED', retired, 'user'), null);
  }
  for (const code of ['SOURCE_NOT_PERMITTED', 'LEASE_UNAVAILABLE', 'ENVIRONMENT_PERMISSION_UNAVAILABLE']) assert.deepEqual(
    resolveCallErrorReasonRule(registry, code, 'environment_registration_inconsistent', 'user')?.classification,
    { category: 'temporarily_unavailable' },
  );
  assert.equal(registry.environment_registration_inconsistent.next_by_role.user, '请联系管理员；改正之前重试结果不会变');
});
