import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {ProtocolError, CallErrorReasonSchema, CALL_ERROR_REASON_RULES, resolveCallErrorReason, formatCallErrorReason} from '../api.ts';

const reason = 'environment_registration_incomplete';

test('incomplete environment registration reuses the public reason carrier without changing code or facts', () => {
  const value = {code:'SOURCE_NOT_PERMITTED',message:'测试环境「合成环境」还没有登记完成',call_error_reason:reason,environment_display_name:'合成环境',object_kind:'test_environment'};
  assert.deepEqual(ProtocolError.parse(value),value);
  assert.equal(CallErrorReasonSchema.parse(reason),reason);
  const json = JSON.parse(readFileSync(new URL('../generated/schemas/call-error-reason.v1.schema.json',import.meta.url),'utf8'));
  assert.equal(json.enum.includes(reason),true);
});

test('missing registration prerequisite is not missing assignment or an unknown observation', () => {
  const rule = CALL_ERROR_REASON_RULES.environment_registration_incomplete;
  assert.deepEqual(rule.codes,['SOURCE_NOT_PERMITTED']);
  assert.deepEqual(rule.classification,{category:'not_found'});
  assert.equal(resolveCallErrorReason('SOURCE_UNAVAILABLE',reason,'user'),null);
  assert.equal(resolveCallErrorReason('ENVIRONMENT_PERMISSION_UNAVAILABLE',reason,'admin'),null);
  assert.equal(resolveCallErrorReason('LEASE_UNAVAILABLE',reason,'admin'),null);
  assert.notDeepEqual(rule.classification,CALL_ERROR_REASON_RULES.environment_unassigned.classification);
  for (const role of ['user','admin'] as const) {
    assert.deepEqual(resolveCallErrorReason('SOURCE_NOT_PERMITTED',reason,role)?.classification,{category:'not_found'});
    assert.notEqual(rule.next_by_role[role],CALL_ERROR_REASON_RULES.environment_unassigned.next_by_role[role]);
  }
});

test('candidate actions remain role-specific without embedding an unparsed CLI or interpreting facts', () => {
  assert.equal(CALL_ERROR_REASON_RULES.environment_registration_incomplete.next_by_role.user,'请联系管理员完成该测试环境的登记');
  assert.equal(CALL_ERROR_REASON_RULES.environment_registration_incomplete.next_by_role.admin,'请先只读采集该测试环境的资源，再将采集到的资源填入定义');
  const source = '合成事实原样保留';
  assert.equal(formatCallErrorReason('SOURCE_NOT_PERMITTED',reason,'user',source),`不存在：${source}。请联系管理员完成该测试环境的登记。`);
});
