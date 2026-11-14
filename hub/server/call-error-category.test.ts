import assert from 'node:assert/strict';
import test from 'node:test';
import { PROTOCOL_CODES } from '../../contracts/generated/protocol.ts';
import { StartRunOutput, GetNodesOutput } from '../../contracts/src/tools.ts';
import { COMMAND_METADATA } from './command-registry.ts';
import {
  CALL_ERROR_CATEGORIES,
  callErrorCategory,
  callErrorFact,
  callErrorNext,
  renderCallError,
} from './call-error-category.ts';
import { circleHubNamesIn, fixByRole } from './fix-by-role.ts';
import { toolText } from './text.ts';
import { callErrorCategoryOf, errorPresentationOf } from './error-reasons.ts';

const TRACE = 'a'.repeat(32);

function assertCommandsRegistered(text: string): void {
  for (const name of circleHubNamesIn(text)) {
    assert.ok(
      COMMAND_METADATA.some((command) => command.name === name),
      `circle-hub ${name} must be in COMMAND_METADATA`,
    );
  }
}

test('D3 maps the first three codes onto the closed category set', () => {
  assert.equal(callErrorCategory('SOURCE_NOT_PERMITTED'), '无权限');
  assert.equal(callErrorCategory('LEASE_UNAVAILABLE'), '已被占用');
  assert.equal(callErrorCategory('SOURCE_INTEGRITY_UNPROVEN'), '暂时不可用');
  assert.equal(callErrorCategory('SOURCE_UNAVAILABLE'), null);
  assert.equal(callErrorCategory('SOURCE_ABSENT'), '不存在');
  for (const word of ['无权限', '已被占用', '暂时不可用'] as const) {
    assert.ok((CALL_ERROR_CATEGORIES as readonly string[]).includes(word));
  }
});

test('Boss afternoon reassignments land in CATEGORY_BY_CODE', () => {
  assert.equal(callErrorCategoryOf('SHARE_DUPLICATE'), '已被占用');
  assert.equal(callErrorCategoryOf('SYNC_PURGE_CONFIRMATION_REQUIRED'), '参数无效');
  assert.equal(callErrorCategoryOf('SOURCE_PENDING_REVIEW'), '暂时不可用');
  assert.equal(callErrorCategoryOf('MEMORY_CURSOR_STALE'), '参数无效');
  assert.equal(callErrorCategoryOf('EFFECT_CONTENT_UNVERIFIED'), '不存在');
  assert.equal(callErrorCategoryOf('EFFECT_RELEASE_UNMET'), '不存在');
  assert.equal(callErrorCategoryOf('TEAM_PARSER_REQUIRED'), '不存在');
  assert.equal(callErrorCategoryOf('SYNC_MODE_LOCAL'), '不存在');
  assert.equal(callErrorCategoryOf('LEASE_EXPIRED'), '不存在');
});

test('pack-scoped codes default to 参数无效, not conclusion', () => {
  assert.deepEqual(errorPresentationOf('case-compile.workbook_context'), { kind: 'category', category: '参数无效' });
  assert.equal(callErrorCategoryOf('case-compile.workbook_context'), '参数无效');
});

test('pack denial fact uses 工作流 and 当前账户; no replaceAll 任务包', () => {
  assert.equal(
    callErrorFact('SOURCE_NOT_PERMITTED', '任务包 recompose 存在，没有分配给你'),
    '当前账户未获授权使用工作流「recompose」',
  );
  assert.equal(
    callErrorFact('SOURCE_NOT_PERMITTED', '运行 run_abc 存在，你没有读取权限'),
    '当前账户未获授权读取运行 run_abc',
  );
  assert.equal(
    callErrorFact('SOURCE_NOT_PERMITTED', '当前账户未获授权使用技能「toy-skill」'),
    '当前账户未获授权使用技能「toy-skill」',
  );
});

test('SOURCE_NOT_PERMITTED member and admin next steps differ; admin commands are registered', () => {
  const memberFix = '请管理员把它分配给你；用 list_task_packs 看你能用的任务包';
  const member = renderCallError(
    { code: 'SOURCE_NOT_PERMITTED', message: '任务包 recompose 存在，没有分配给你', fix: memberFix },
    'user',
    fixByRole('SOURCE_NOT_PERMITTED', 'user', memberFix),
  )!;
  assert.equal(
    member,
    '无权限：当前账户未获授权使用工作流「recompose」。请联系管理员为该账户或所在团队分配此工作流；当前账户可用的工作流和技能用 list_task_packs 查看。',
  );
  assert.doesNotMatch(member, /状态|判断|原因|决定者|任务包|没有分配给你/);

  const adminFix = fixByRole('SOURCE_NOT_PERMITTED', 'admin', memberFix)!;
  const admin = renderCallError(
    { code: 'SOURCE_NOT_PERMITTED', message: '任务包 recompose 存在，没有分配给你', fix: adminFix },
    'admin',
    adminFix,
  )!;
  assert.match(admin, /^无权限：当前账户未获授权使用工作流「recompose」。/);
  assert.doesNotMatch(admin, /请管理员|状态|判断|决定者|任务包/);
  assert.match(admin, /circle-hub pack assign /);
  assertCommandsRegistered(admin);
  assertCommandsRegistered(adminFix);
});

test('knowledge-tree-root denial keeps 绑定产品线 semantics', () => {
  const member = callErrorNext(
    'SOURCE_NOT_PERMITTED',
    'user',
    '请管理员给你分配绑定这条产品线的任务包后重交',
    '知识树根 abc 存在，当前账户没有读取权限',
  );
  assert.match(member, /绑定这条产品线/);
  assert.doesNotMatch(member, /分配此工作流$/);
  const admin = callErrorNext(
    'SOURCE_NOT_PERMITTED',
    'admin',
    '请管理员给你分配绑定这条产品线的任务包后重交',
    '知识树根 abc 存在，当前账户没有读取权限',
  );
  assert.match(admin, /绑定这条产品线/);
  assert.match(admin, /circle-hub pack assign /);
});

test('LEASE_UNAVAILABLE category form splits member and admin next steps', () => {
  const memberFix = PROTOCOL_CODES.LEASE_UNAVAILABLE.fix;
  const member = renderCallError(
    { code: 'LEASE_UNAVAILABLE', message: '租约键已被预订', fix: memberFix },
    'user',
    fixByRole('LEASE_UNAVAILABLE', 'user', memberFix),
  )!;
  assert.match(member, /^已被占用：租约键正被占用。请/);
  assert.doesNotMatch(member, /状态|判断|决定者/);

  const adminFix = fixByRole('LEASE_UNAVAILABLE', 'admin', memberFix)!;
  const admin = renderCallError(
    { code: 'LEASE_UNAVAILABLE', message: '租约键已被预订', fix: adminFix },
    'admin',
    adminFix,
  )!;
  assert.match(admin, /^已被占用：/);
  assert.match(admin, /circle-hub lease release /);
  assert.doesNotMatch(admin, /请管理员|状态|判断|决定者/);
  assertCommandsRegistered(admin);
});

test('SOURCE_INTEGRITY_UNPROVEN admin next step cites restore and records from the registry', () => {
  const adminFix = fixByRole('SOURCE_INTEGRITY_UNPROVEN', 'admin')!;
  const admin = renderCallError(
    { code: 'SOURCE_INTEGRITY_UNPROVEN', message: '缺少经摘要核验的知识原件', fix: adminFix },
    'admin',
    adminFix,
  )!;
  assert.equal(
    admin,
    `暂时不可用：缺少经摘要核验的知识原件。${callErrorNext('SOURCE_INTEGRITY_UNPROVEN', 'admin', adminFix)}。`,
  );
  assert.match(admin, /circle-hub restore /);
  assert.match(admin, /circle-hub records /);
  assert.doesNotMatch(admin, /请管理员|状态|判断|决定者/);
  assertCommandsRegistered(admin);

  const member = renderCallError(
    { code: 'SOURCE_INTEGRITY_UNPROVEN', message: '缺少经摘要核验的知识原件', fix: PROTOCOL_CODES.SOURCE_INTEGRITY_UNPROVEN.fix },
    'user',
    PROTOCOL_CODES.SOURCE_INTEGRITY_UNPROVEN.fix,
  )!;
  assert.equal(
    member,
    '暂时不可用：缺少经摘要核验的知识原件。请联系管理员从备份恢复原件并重验摘要，恢复后按原引用重读。',
  );
});

test('toolText renders category form for the three codes and SOURCE_UNAVAILABLE with 当前账户', () => {
  const denied = toolText('start_run', StartRunOutput.parse({
    call_result: 'error',
    errors: [{
      code: 'SOURCE_NOT_PERMITTED',
      message: '任务包 recompose 存在，没有分配给你',
      fix: '请管理员把它分配给你；用 list_task_packs 看你能用的任务包',
      path: '/pack',
    }],
    trace: TRACE,
  }), { caller: { role: 'user' } });
  assert.equal(
    denied,
    '无权限：当前账户未获授权使用工作流「recompose」。请联系管理员为该账户或所在团队分配此工作流；当前账户可用的工作流和技能用 list_task_packs 查看。',
  );

  const adminFix = fixByRole('SOURCE_NOT_PERMITTED', 'admin', '请管理员把它分配给你')!;
  const adminDenied = toolText('start_run', StartRunOutput.parse({
    call_result: 'error',
    errors: [{
      code: 'SOURCE_NOT_PERMITTED',
      message: '任务包 recompose 存在，没有分配给你',
      fix: adminFix,
      path: '/pack',
    }],
    trace: TRACE,
  }), { caller: { role: 'admin' } });
  assert.match(adminDenied, /^无权限：当前账户未获授权使用工作流「recompose」。/);
  assert.match(adminDenied, /circle-hub pack assign /);
  assert.doesNotMatch(adminDenied, /状态|判断|决定者|请管理员/);
  assertCommandsRegistered(adminDenied);

  const leaseAdmin = fixByRole('LEASE_UNAVAILABLE', 'admin')!;
  const leaseText = toolText('start_run', StartRunOutput.parse({
    call_result: 'error',
    errors: [{ code: 'LEASE_UNAVAILABLE', message: '租约键已被预订', fix: leaseAdmin }],
    trace: TRACE,
  }), { caller: { role: 'admin' } });
  assert.match(leaseText, /^已被占用：/);
  assert.match(leaseText, /circle-hub lease release /);
  assertCommandsRegistered(leaseText);

  const integrityFix = fixByRole('SOURCE_INTEGRITY_UNPROVEN', 'admin')!;
  const integrityText = toolText('get_nodes', GetNodesOutput.parse({
    call_result: 'error',
    errors: [{ code: 'SOURCE_INTEGRITY_UNPROVEN', message: '缺少经摘要核验的知识原件', fix: integrityFix }],
    trace: TRACE,
  }), { caller: { role: 'admin' } });
  assert.match(integrityText, /^暂时不可用：缺少经摘要核验的知识原件。/);
  assert.match(integrityText, /circle-hub restore /);
  assertCommandsRegistered(integrityText);

  const unknown = toolText('start_run', StartRunOutput.parse({
    call_result: 'error',
    errors: [{ code: 'SOURCE_UNAVAILABLE', message: '对你不可用', fix: PROTOCOL_CODES.SOURCE_UNAVAILABLE.fix }],
    trace: TRACE,
  }));
  assert.match(unknown, /^资料尚未取得。/);
  assert.match(unknown, /当前账户读不到这份资料；状态未知；原因缺资料；下一步由使用者联系管理员核对；决定者程序/);
  assert.doesNotMatch(unknown, /对你不可用|判断错误|参数无效|无权限/);
});
