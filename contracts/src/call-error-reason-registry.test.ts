import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { PermissionRole } from '../generated/vocabulary.ts';
import { resolveCallErrorReasonRule, validateCallErrorReasonRegistry, type CallErrorReasonRule } from './call-error-reasons.ts';

const model = () => JSON.parse(readFileSync(new URL('../model.json', import.meta.url), 'utf8'));
const reasons = (input = model()): string[] => input.vocabulary.find((axis: { axis: string }) => axis.axis === 'call_error_reason').values.map((value: { code: string }) => value.code);
const rules = (input = model()): Record<string, CallErrorReasonRule> => Object.fromEntries(input.formatProposals.callErrorReasons.map((row: CallErrorReasonRule & { reason: string }) => [row.reason, row]));

test('first reason registry covers the model axis and exactly one classification plus every actual role', () => {
  const input = model();
  assert.deepEqual(validateCallErrorReasonRegistry(input.formatProposals.callErrorReasons, reasons(input)), []);
  assert.equal(input.vocabulary.find((axis: { axis: string }) => axis.axis === 'call_error_reason').owner, 'D05');
  const values = rules(input);
  for (const name of ['actor_disabled', 'environment_disabled', 'environment_unassigned']) assert.deepEqual(values[name].classification, { category: 'permission_denied' });
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
