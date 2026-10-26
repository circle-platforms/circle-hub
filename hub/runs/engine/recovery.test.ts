import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LayerResult } from '../../../contracts/src/validation.ts';
import { unknown } from '../../rules/outcome.ts';
import { bindRecovery } from './recovery.ts';

const context = { trustedCore:true, now: new Date('2026-01-01T00:00:00Z'), runner: 'usr_' + '1'.repeat(26), owner: 'usr_' + '2'.repeat(26), admin: 'usr_' + '3'.repeat(26) };
test('missing check has an explicit fact and a repair exit to its author', () => {
  const layer = bindRecovery({ layer: 'static', terminal: 'unchecked', reason: 'no_check' }, [], context);
  assert.ok(layer.missing?.includes('检查'));
  assert.deepEqual(layer.exit, { action: 'request', request_kind: 'repair', audience: { user: context.owner }, due: '2026-01-04T00:00:00.000Z' });
  assert.ok(LayerResult.safeParse(layer).success);
});
test('check errors are valid outcomes before reaching the engine', () => {
  assert.ok(unknown({ tier: 'advisory', grounds: [] }, 'check_error', '检查声明没有可用的函数').missing);
});

test('timeout carries its own missing fact and named exit', () => {
  const result = bindRecovery({ layer: 'static', terminal: 'unchecked', reason: 'timeout' }, [], context);
  assert.equal(result.exit?.request_kind, 'repair');
  assert.deepEqual(result.exit?.audience, { user: context.owner });
  assert.ok(result.missing?.includes('检查在上限内'));
  assert.ok(LayerResult.safeParse(result).success);
});

test('missing_input carries its own missing fact and named exit', () => {
  const result = bindRecovery({ layer: 'static', terminal: 'unchecked', reason: 'missing_input' }, [], context);
  assert.equal(result.exit?.request_kind, 'clarification');
  assert.deepEqual(result.exit?.audience, { user: context.runner });
  assert.ok(result.missing?.includes('运行所需的已'));
  assert.ok(LayerResult.safeParse(result).success);
});

test('declared_skip carries its own missing fact and named exit', () => {
  const result = bindRecovery({ layer: 'static', terminal: 'unchecked', reason: 'declared_skip' }, [], context);
  assert.equal(result.exit?.request_kind, 'repair');
  assert.deepEqual(result.exit?.audience, { user: context.runner });
  assert.ok(result.missing?.includes('被跳过条目的'));
  assert.ok(LayerResult.safeParse(result).success);
});

test('not_covered carries its own missing fact and named exit', () => {
  const result = bindRecovery({ layer: 'static', terminal: 'unchecked', reason: 'not_covered' }, [], context);
  assert.equal(result.exit?.request_kind, 'repair');
  assert.deepEqual(result.exit?.audience, { user: context.runner });
  assert.ok(result.missing?.includes('未覆盖条目的'));
  assert.ok(LayerResult.safeParse(result).success);
});

test('awaiting_step carries its own missing fact and named exit', () => {
  const result = bindRecovery({ layer: 'static', terminal: 'unchecked', reason: 'awaiting_step' }, [], context);
  assert.equal(result.exit?.request_kind, 'repair');
  assert.deepEqual(result.exit?.audience, { user: context.runner });
  assert.ok(result.missing?.includes('所等步骤的完'));
  assert.ok(LayerResult.safeParse(result).success);
});

test('output_failed carries its own missing fact and named exit', () => {
  const result = bindRecovery({ layer: 'static', terminal: 'unchecked', reason: 'output_failed' }, [], context);
  assert.equal(result.exit?.request_kind, 'repair');
  assert.deepEqual(result.exit?.audience, { user: context.runner });
  assert.ok(result.missing?.includes('能回读且与重'));
  assert.ok(LayerResult.safeParse(result).success);
});

test('repair_exhausted carries its own missing fact and named exit', () => {
  const result = bindRecovery({ layer: 'static', terminal: 'unchecked', reason: 'repair_exhausted' }, [], context);
  assert.equal(result.exit?.request_kind, 'repair');
  assert.deepEqual(result.exit?.audience, { user: context.runner });
  assert.ok(result.missing?.includes('修复后符合要'));
  assert.ok(LayerResult.safeParse(result).success);
});

test('budget_exhausted carries its own missing fact and named exit', () => {
  const result = bindRecovery({ layer: 'static', terminal: 'unchecked', reason: 'budget_exhausted' }, [], context);
  assert.equal(result.exit?.request_kind, 'repair');
  assert.deepEqual(result.exit?.audience, { user: context.owner });
  assert.ok(result.missing?.includes('工作上限内完'));
  assert.ok(LayerResult.safeParse(result).success);
});

test('integrity_unproven carries its own missing fact and named exit', () => {
  const result = bindRecovery({ layer: 'static', terminal: 'unchecked', reason: 'integrity_unproven' }, [], context);
  assert.equal(result.exit?.request_kind, 'repair');
  assert.deepEqual(result.exit?.audience, { user: context.admin });
  assert.ok(result.missing?.includes('完整的来源目'));
  assert.ok(LayerResult.safeParse(result).success);
});
test('one layer preserves independent reasons and their separate facts', () => {
  const outcomes = [unknown({ tier: 'advisory', grounds: [] }, 'missing_input', '缺少来源甲'), unknown({ tier: 'advisory', grounds: [] }, 'timeout', '缺少检查乙的完成结果')];
  const layer = bindRecovery({ layer: 'static', terminal: 'unchecked', reason: 'missing_input' }, outcomes, context);
  assert.deepEqual([layer.reason, ...(layer.gaps ?? []).map(g => g.reason)], ['missing_input', 'timeout']);
  assert.equal(layer.gaps?.length, 1, 'additional causes must not repeat the primary exit');
  assert.ok(LayerResult.safeParse(layer).success);
});
test('withheld source waits for an administrator while an unavailable source is reread', () => {
  const retained = unknown({ tier: 'advisory', grounds: [] }, 'awaiting_step', '管理员尚未接受来源', { data: { unread_sources: [{ reason: 'credential_unreadable' }] } });
  const temporary = unknown({ tier: 'advisory', grounds: [] }, 'missing_input', '暂不可读的片段原文', { data: { why: 'unavailable' } });
  assert.deepEqual(bindRecovery({ layer: 'static', terminal: 'unchecked', reason: 'awaiting_step' }, [retained], context).exit?.audience, { user: context.admin });
  assert.equal(bindRecovery({ layer: 'static', terminal: 'unchecked', reason: 'missing_input' }, [temporary], context).exit?.action, 'reread');
});
test('digest mismatch requests trusted backup restoration instead of rereading bytes', () => {
  const outcome = unknown({ tier: 'advisory', grounds: [] }, 'integrity_unproven', '缺与摘要一致的可信原文；下一步：管理员从可信备份恢复', { data: { why: 'integrity_unproven' } });
  const layer = bindRecovery({ layer: 'static', terminal: 'unchecked', reason: 'integrity_unproven' }, [outcome], context);
  assert.deepEqual(layer.exit?.audience, { user: context.admin });
  assert.equal(layer.exit?.action, 'request');
});
test('exhausted transient sandbox availability schedules reevaluation', () => {
  const outcome = unknown({ tier: 'advisory', grounds: [] }, 'check_error', '可用的沙箱', { data: { sandbox: 'SANDBOX_UNAVAILABLE' } });
  assert.equal(bindRecovery({ layer: 'static', terminal: 'unchecked', reason: 'check_error' }, [outcome], context).exit?.action, 'reevaluate');
});
test('a matched check failure retains the concrete missing fact and the repair procedure', () => {
  const outcome = unknown({ tier: 'advisory', grounds: [] }, 'check_error', '检查甲没有返回结果');
  const layer = bindRecovery({ layer: 'static', terminal: 'unchecked', reason: 'check_error' }, [outcome], context);
  assert.match(layer.missing!, /检查甲/);
  assert.match(layer.missing!, /发布.*重跑/);
});
test('a missing input caused by structured source withholding has an administrator exit', () => {
  const outcome = unknown({ tier: 'advisory', grounds: [] }, 'missing_input', '普通来源尚不可读', { data: { unread_sources: [{ reason: 'credential_unreadable' }] } });
  const result = bindRecovery({ layer: 'static', terminal: 'unchecked', reason: 'missing_input' }, [outcome], context);
  assert.deepEqual(result.exit?.audience, { user: context.admin });
  assert.match(result.missing!, /管理员接受/);
});
test('an empty unread list never changes a prerequisite repair into administrator acceptance', () => {
  const outcome = unknown({ tier: 'advisory', grounds: [] }, 'awaiting_step', '前置检查修正后的事实', { data: { unread_sources: [] } });
  const result = bindRecovery({ layer: 'static', terminal: 'unchecked', reason: 'awaiting_step' }, [outcome], context);
  assert.deepEqual(result.exit?.audience, { user: context.runner });
  assert.doesNotMatch(result.missing!, /管理员接受/);
});

test('package-authored exit metadata cannot choose another request audience',()=>{
  const outcome={verdict:'unknown' as const,reason:'check_error' as const,missing:'合成检查缺结论',statement:'缺结论',grounds:[],tier:'advisory' as const,exit:{action:'request' as const,request_kind:'disposition' as const,audience:{user:'usr_'+'4'.repeat(26)},due:'2026-01-09T00:00:00.000Z'}};
  const result=bindRecovery({layer:'static',terminal:'unchecked',reason:'check_error'},[outcome],context);
  assert.deepEqual(result.exit?.audience,{user:context.owner});
});

test('an absent publication owner is a named identity wiring failure, not an invented owner',()=>{
  assert.throws(()=>bindRecovery({layer:'static',terminal:'unchecked',reason:'no_check'},[],{...context,owner:null}),/具名|owner/);
});

test('package data cannot schedule Hub recovery by imitating a sandbox status',()=>{
  const outcome=unknown({tier:'advisory',grounds:[]},'check_error','合成缺失事实',{data:{sandbox:'SANDBOX_UNAVAILABLE'}});
  const result=bindRecovery({layer:'static',terminal:'unchecked',reason:'check_error'},[outcome],{...context,trustedCore:false});
  assert.equal(result.exit?.action,'request');assert.deepEqual(result.exit?.audience,{user:context.owner});
});
