import assert from 'node:assert/strict';
import test from 'node:test';
import { PROTOCOL_CODES } from '../../contracts/generated/protocol.ts';
import { StartRunOutput, GetNodesOutput } from '../../contracts/src/tools.ts';
import { COMMAND_METADATA } from './command-registry.ts';
import {
  circleHubFromMetadata,
  circleHubFromParameters,
  circleHubNamesIn,
  fixByRole,
  proseByRole,
  registeredCommandName,
} from './fix-by-role.ts';
import { toolText } from './text.ts';

const TRACE = 'a'.repeat(32);

const ADMIN_PROTOCOL_CODES = [
  'SOURCE_UNAVAILABLE',
  'SOURCE_NOT_PERMITTED',
  'IDENTITY_UNMAPPED',
  'LEASE_UNAVAILABLE',
  'SOURCE_RETRYABLE',
  'SOURCE_INTEGRITY_UNPROVEN',
  'SOURCE_READ_FAILED',
  'SOURCE_READ_LIMIT',
  'SOURCE_REDIRECT_REFUSED',
  'AUDIENCE_VISIBILITY_EXCEEDED',
  'SPACE_CAPACITY_EXCEEDED',
  'SPACE_INDEX_LIMIT',
  'PACK_PERSONAL_CAPABILITY_DENIED',
  'MEMORY_DOCUMENT_LIMIT',
  'MEMORY_SPACE_LIMIT',
  'MEMORY_TEAM_DISABLED',
] as const;

function assertCommandsRegistered(text: string): void {
  for (const name of circleHubNamesIn(text)) {
    assert.ok(
      COMMAND_METADATA.some((command) => command.name === name),
      `circle-hub ${name} must be in COMMAND_METADATA`,
    );
  }
}

test('registered helpers refuse unknown command names', () => {
  assert.equal(registeredCommandName('pack'), 'pack');
  assert.throws(() => registeredCommandName('not-a-real-command'), /COMMAND_METADATA/);
  assert.match(circleHubFromParameters('pack.assign'), /^circle-hub pack assign /);
  assert.match(circleHubFromMetadata('restore'), /^circle-hub restore /);
  assertCommandsRegistered(circleHubFromParameters('lease.release'));
  assertCommandsRegistered(circleHubFromMetadata('records'));
});

test('SOURCE_NOT_PERMITTED member keeps assignment ask; admin gets pack.assign from registry', () => {
  const memberFix = '请管理员把它分配给你；用 list_task_packs 看你能用的任务包';
  assert.equal(fixByRole('SOURCE_NOT_PERMITTED', 'user', memberFix), memberFix);
  const admin = fixByRole('SOURCE_NOT_PERMITTED', 'admin', memberFix)!;
  assert.doesNotMatch(admin, /请管理员/);
  assert.match(admin, /circle-hub pack assign /);
  assert.match(admin, /\/console\/team/);
  assertCommandsRegistered(admin);
});

test('LEASE_UNAVAILABLE member keeps contract; admin gets lease.release from registry', () => {
  const member = PROTOCOL_CODES.LEASE_UNAVAILABLE.fix;
  assert.equal(fixByRole('LEASE_UNAVAILABLE', 'user'), member);
  const admin = fixByRole('LEASE_UNAVAILABLE', 'admin')!;
  assert.doesNotMatch(admin, /请管理员/);
  assert.match(admin, /circle-hub lease release /);
  assert.match(admin, /\/console\/connections/);
  assertCommandsRegistered(admin);
});

test('SOURCE_INTEGRITY_UNPROVEN admin points at restore and records from registry', () => {
  assert.equal(fixByRole('SOURCE_INTEGRITY_UNPROVEN', 'user'), PROTOCOL_CODES.SOURCE_INTEGRITY_UNPROVEN.fix);
  const admin = fixByRole('SOURCE_INTEGRITY_UNPROVEN', 'admin')!;
  assert.doesNotMatch(admin, /请管理员/);
  assert.match(admin, /circle-hub restore /);
  assert.match(admin, /circle-hub records /);
  assertCommandsRegistered(admin);
});

test('every admin-ask protocol code has an admin fix without imperative 请管理员', () => {
  for (const code of ADMIN_PROTOCOL_CODES) {
    const member = PROTOCOL_CODES[code].fix;
    assert.match(member, /管理员/);
    const admin = fixByRole(code, 'admin', member)!;
    assert.doesNotMatch(admin, /请管理员/);
    assertCommandsRegistered(admin);
  }
});

test('toolText and structured-style fix stay role-split for SOURCE_NOT_PERMITTED', () => {
  const errors = [{
    code: 'SOURCE_NOT_PERMITTED' as const,
    message: '任务包 recompose 存在，没有分配给你',
    fix: '请管理员把它分配给你；用 list_task_packs 看你能用的任务包',
    path: '/pack',
  }];
  const answer = StartRunOutput.parse({ call_result: 'error', errors, trace: TRACE });
  const memberText = toolText('start_run', answer, { caller: { role: 'user' } });
  assert.match(memberText, /^无权限：/);
  assert.match(memberText, /请联系管理员为该账户或所在团队分配此工作流/);
  assert.doesNotMatch(memberText, /circle-hub pack assign|状态|判断|决定者/);

  const adminFix = fixByRole('SOURCE_NOT_PERMITTED', 'admin', errors[0].fix)!;
  const adminAnswer = StartRunOutput.parse({
    call_result: 'error',
    errors: [{ ...errors[0], fix: adminFix }],
    trace: TRACE,
  });
  const adminText = toolText('start_run', adminAnswer, { caller: { role: 'admin' } });
  assert.doesNotMatch(adminText, /请管理员|状态|判断|决定者/);
  assert.match(adminText, /^无权限：/);
  assert.match(adminText, /circle-hub pack assign /);
  assert.equal(adminAnswer.errors[0].fix, adminFix);
  assertCommandsRegistered(adminText);
  assertCommandsRegistered(adminFix);
});

test('toolText role-split for LEASE_UNAVAILABLE', () => {
  const memberFix = PROTOCOL_CODES.LEASE_UNAVAILABLE.fix;
  const answer = StartRunOutput.parse({
    call_result: 'error',
    errors: [{ code: 'LEASE_UNAVAILABLE', message: '租约键已被预订', fix: memberFix }],
    trace: TRACE,
  });
  const memberText = toolText('start_run', answer, { caller: { role: 'user' } });
  assert.match(memberText, /^已被占用：/);
  assert.match(memberText, /请/);
  assert.doesNotMatch(memberText, /状态|判断|决定者/);
  const adminFix = fixByRole('LEASE_UNAVAILABLE', 'admin', memberFix)!;
  const adminText = toolText('start_run', StartRunOutput.parse({
    call_result: 'error',
    errors: [{ code: 'LEASE_UNAVAILABLE', message: '租约键已被预订', fix: adminFix }],
    trace: TRACE,
  }), { caller: { role: 'admin' } });
  assert.doesNotMatch(adminText, /请管理员|状态|判断|决定者/);
  assert.match(adminText, /^已被占用：/);
  assert.match(adminText, /circle-hub lease release /);
  assertCommandsRegistered(adminText);
});

test('proseByRole covers the five hardcoded text.ts ask-admin lines', () => {
  for (const kind of ['unassigned_packs', 'context_unread', 'contribution_unreadable', 'content_unread', 'missing_result_record', 'fallback'] as const) {
    const member = proseByRole('user', kind, { usable: 0, unassigned: 5 });
    const admin = proseByRole('admin', kind, { usable: 0, unassigned: 5 });
    assert.match(member, /请管理员|或请管理员/);
    assert.doesNotMatch(admin, /请管理员/);
    assertCommandsRegistered(admin);
  }
});

test('get_nodes integrity error text for admin uses registry commands', () => {
  const adminFix = fixByRole('SOURCE_INTEGRITY_UNPROVEN', 'admin')!;
  const text = toolText('get_nodes', GetNodesOutput.parse({
    call_result: 'error',
    errors: [{ code: 'SOURCE_INTEGRITY_UNPROVEN', message: '缺少经摘要核验的知识原件', fix: adminFix }],
    trace: TRACE,
  }), { caller: { role: 'admin' } });
  assert.doesNotMatch(text, /请管理员|状态|判断|决定者/);
  assert.match(text, /^暂时不可用：/);
  assert.match(text, /circle-hub restore /);
  assertCommandsRegistered(text);
});
