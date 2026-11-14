import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import {
  ProtocolError, CallErrorObjectKindSchema, LeaseHolderRelationSchema, DispatchOperationSchema, EffectOutcomeSchema,
  DispatchOutcomeFactsSchema, SCHEMA_REGISTRY, resolveCallErrorReason, type CallErrorReason,
  EnvironmentRegistrationIssueSchema, RegistrationComparison,
} from '../api.ts';
import { SubmitResultOutput } from './tools.ts';
import { accepted, acceptedCounts } from './fixtures.ts';

const H = 'a'.repeat(64);

test('object kind is a closed parallel fact; display-name shape cannot establish semantic identity', () => {
  const kinds = ['pack', 'knowledge', 'knowledge_root', 'system', 'source_artifact', 'record', 'named_document', 'test_environment'];
  assert.deepEqual([...CallErrorObjectKindSchema.options], kinds);
  for (const object_kind of kinds) {
    const value = ProtocolError.parse({ code: 'SOURCE_NOT_PERMITTED', message: '源事实原样保留', object_kind, object_display_name: '合成对象' });
    assert.equal(value.call_error_reason, undefined);
    assert.equal(value.object_display_name, '合成对象');
  }
  assert.equal(ProtocolError.parse({ code: 'SOURCE_NOT_PERMITTED', message: '无可靠对象观察' }).object_kind, undefined);
  for (const name of ['usr_0' + 'b'.repeat(25), 'env_0' + 'b'.repeat(25), 'exe_0' + 'b'.repeat(25), H]) {
    assert.equal(ProtocolError.parse({ code: 'SOURCE_NOT_PERMITTED', message: '原事实', object_display_name: name }).object_display_name, name, 'a legitimate explicit name may look like an identifier or digest');
  }
  assert.equal(ProtocolError.safeParse({ code: 'SOURCE_NOT_PERMITTED', message: '原事实', object_kind: 'default_pack' }).success, false);
});

test('six action-specific reasons only accept the confirmed authorization machine code', () => {
  const reasons: CallErrorReason[] = ['pack_unassigned', 'knowledge_root_unassigned', 'system_unassigned', 'content_read_not_permitted', 'named_document_run_scope_denied', 'run_submission_not_owned'];
  for (const reason of reasons) {
    assert.deepEqual(resolveCallErrorReason('SOURCE_NOT_PERMITTED', reason, 'user')?.classification, { category: 'permission_denied' });
    assert.equal(resolveCallErrorReason('SOURCE_UNAVAILABLE', reason, 'user'), null);
    assert.equal(resolveCallErrorReason('PACK_SPACE_DENIED', reason, 'admin'), null);
  }
  const submit = ProtocolError.parse({ code: 'SOURCE_NOT_PERMITTED', message: '只能向本人运行提交', object_kind: 'record', call_error_reason: 'run_submission_not_owned' });
  const read = ProtocolError.parse({ code: 'SOURCE_NOT_PERMITTED', message: '共享读取许可明确拒绝', object_kind: 'record', call_error_reason: 'content_read_not_permitted' });
  assert.equal(submit.object_kind, read.object_kind);
  for (const role of ['user', 'admin'] as const) {
    assert.equal(resolveCallErrorReason(submit.code, submit.call_error_reason!, role)?.nextAction, '请用 start_run 开始自己的运行，再提交');
    assert.notEqual(resolveCallErrorReason(read.code, read.call_error_reason!, role)?.nextAction, resolveCallErrorReason(submit.code, submit.call_error_reason!, role)?.nextAction);
  }
});

test('booking observations stay optional and schema shape is not administrator visibility proof', () => {
  assert.deepEqual([...LeaseHolderRelationSchema.options], ['current_account', 'other_account', 'unknown']);
  const base = { code: 'LEASE_UNAVAILABLE', message: '原预订事实' };
  assert.deepEqual(ProtocolError.parse(base), base);
  const visible = { ...base, environment_display_name: '合成环境', holder_relation: 'other_account', holder_display_name: '其他成员', acquired_at: '2026-11-14T21:16:00.000Z', lease_key: 'bed/synthetic/a', grounds: [`rec:${H}`] };
  assert.deepEqual(ProtocolError.parse(visible), visible, 'this test validates shape, not source authority to reveal a private key');
  assert.equal(ProtocolError.safeParse({ ...base, acquired_at: 'yesterday' }).success, false);
  assert.equal(ProtocolError.safeParse({ ...base, holder_relation: 'self' }).success, false);
  assert.equal(ProtocolError.safeParse({ ...base, holder_run: 'run_0' + 'b'.repeat(25) }).success, false);
  const explicitName = 'usr_0' + 'b'.repeat(25);
  assert.equal(ProtocolError.parse({ ...base, holder_display_name: explicitName }).holder_display_name, explicitName, 'source tests, not a name-pattern guess, establish provenance');
});

test('registration issue is a parallel closed comparison and never changes the shared reason or role action', () => {
  assert.deepEqual([...EnvironmentRegistrationIssueSchema.options], ['executor_identity', 'target', 'resources', 'booking_scope']);
  const reason = 'environment_registration_inconsistent';
  for (const issue of EnvironmentRegistrationIssueSchema.options) {
    const member = ProtocolError.parse({ code: 'SOURCE_NOT_PERMITTED', message: '测试环境「合成环境」登记不一致，这次上机验证没有执行', call_error_reason: reason, environment_display_name: '合成环境', registration_comparison: { issue } });
    assert.deepEqual(member.registration_comparison, { issue }, 'schema adds no side names or raw values');
    assert.deepEqual(resolveCallErrorReason(member.code, member.call_error_reason!, 'user')?.classification, { category: 'temporarily_unavailable' });
  }
  const adminVisibleShape = { issue: 'resources', left_display_name: '合成环境', right_display_name: '合成执行器', left_values: ['bed/a'], right_values: ['bed/b'] };
  assert.deepEqual(RegistrationComparison.parse(adminVisibleShape), adminVisibleShape, 'source authorization, not this parser, controls disclosure');
  assert.equal(RegistrationComparison.safeParse({ issue: 'unknown_issue' }).success, false);
  assert.equal(resolveCallErrorReason('SOURCE_NOT_PERMITTED', reason, 'admin')?.nextAction, '请在控制台「测试环境」页或用 circle-hub bed update 把上面不一致的这一项改正；改正后原样重试');
  for (const role of ['user', 'admin'] as const) assert.equal(resolveCallErrorReason('SOURCE_NOT_PERMITTED', 'actor_not_active', role)?.nextAction, '请由有效的账户重新开始运行');
});

test('precheck stage complete and effect not_dispatched are distinct observations with no inferred flags', () => {
  assert.deepEqual([...DispatchOperationSchema.options], ['precheck', 'dispatch', 'conformance']);
  assert.equal(EffectOutcomeSchema.options.length, 8);
  assert.equal(EffectOutcomeSchema.safeParse('complete').success, false);
  const precheck = { operation: 'precheck', phase: 'complete', outcome: 'not_dispatched' };
  assert.deepEqual(DispatchOutcomeFactsSchema.parse(precheck), precheck);
  assert.deepEqual(DispatchOutcomeFactsSchema.parse({ phase: 'complete' }), { phase: 'complete' }, 'old records do not gain an operation or effect from stage/prose');
  assert.deepEqual(DispatchOutcomeFactsSchema.parse({}), {});
  assert.equal(DispatchOutcomeFactsSchema.parse(precheck).not_sent, undefined);
  assert.equal(DispatchOutcomeFactsSchema.safeParse({ operation: 'complete' }).success, false);
  assert.equal(DispatchOutcomeFactsSchema.safeParse({ operation: 'precheck', outcome: 'complete' }).success, false);
  for (const alias of ['effect_outcome', 'effects_unknown', 'request_not_sent', 'target_rejected']) assert.equal(DispatchOutcomeFactsSchema.safeParse({ [alias]: true }).success, false);
});

test('public carrier is one generated model schema and requires valid authorized-reference shapes', () => {
  assert.equal(SCHEMA_REGISTRY['dispatch-outcome@1'], DispatchOutcomeFactsSchema);
  assert.deepEqual(DispatchOutcomeFactsSchema.parse({ outcome: 'issued', result: `src:${H}`, device_return: `src:${H}` }), { outcome: 'issued', result: `src:${H}`, device_return: `src:${H}` });
  assert.equal(DispatchOutcomeFactsSchema.safeParse({ result: H }).success, false);
  const shared = JSON.parse(readFileSync(new URL('../model.json', import.meta.url), 'utf8')).formatProposals.sharedInterfaces.definitions.find((entry: { name: string }) => entry.name === 'DispatchOutcomeFacts');
  assert.equal(shared.id, 'dispatch-outcome@1');
  assert.equal(shared.schema.properties.outcome.$ref, 'vocabulary:effect_outcome');
  assert.deepEqual(shared.schema.required, []);
  const output = SubmitResultOutput.safeParse({ call_result: 'ok', errors: [], trace: 'b'.repeat(32), acceptance: 'accepted', result: accepted, counts: acceptedCounts(), dispatch: [{ operation: 'precheck', phase: 'complete', outcome: 'not_dispatched', text: '只读核对完成' }] });
  assert.equal(output.success, true, output.success ? undefined : JSON.stringify(output.error.issues));
  if (output.success) assert.equal(output.data.dispatch?.[0].operation, 'precheck');
  const json = JSON.parse(readFileSync(new URL('../generated/schemas/dispatch-outcome.v1.schema.json', import.meta.url), 'utf8'));
  assert.equal(json.properties.phase.type, 'string');
  assert.equal(json.properties.outcome.enum.length, 8);
  assert.deepEqual(json.properties.operation.enum, ['precheck', 'dispatch', 'conformance']);
  const description = 'The job result once it is complete (src:), readable by the runner: one row per dispatched item';
  assert.equal(json.properties.result.description, description);
  const tools = JSON.parse(readFileSync(new URL('../generated/tools.json', import.meta.url), 'utf8'));
  assert.equal(tools.find((tool: { name: string }) => tool.name === 'submit_result').outputSchema.properties.dispatch.items.properties.result.description, description);
});

test('Common and shared schemas load cold in either order without a shared-module TDZ', () => {
  const common = new URL('./common.ts', import.meta.url).href;
  const shared = new URL('../generated/shared-interfaces.ts', import.meta.url).href;
  const api = new URL('../api.ts', import.meta.url).href;
  for (const order of [[common, shared, api], [shared, common, api]]) {
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', `for(const path of ${JSON.stringify(order)})await import(path);`], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
  }
});
