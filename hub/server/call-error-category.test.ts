import assert from 'node:assert/strict';
import test from 'node:test';
import { PROTOCOL_CODES } from '../../contracts/generated/protocol.ts';
import { StartRunOutput, GetNodesOutput, SubmitResultOutput } from '../../contracts/src/tools.ts';
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
  assert.equal(callErrorCategoryOf('EFFECT_UNKNOWN_DISPOSED'), null);
  assert.deepEqual(errorPresentationOf('EFFECT_UNKNOWN_DISPOSED'), { kind: 'conclusion' });
});

test('pack-scoped codes default to 参数无效, not conclusion', () => {
  assert.deepEqual(errorPresentationOf('case-compile.workbook_context'), { kind: 'category', category: '参数无效' });
  assert.equal(callErrorCategoryOf('case-compile.workbook_context'), '参数无效');
});

test('pack denial fact uses 工作流 and 当前账户; no replaceAll 任务包', () => {
  assert.equal(
    callErrorFact('SOURCE_NOT_PERMITTED', '当前账户未获授权使用工作流「recompose」'),
    '当前账户未获授权使用工作流「recompose」',
  );
  assert.equal(
    callErrorFact('SOURCE_NOT_PERMITTED', '运行 run_abc 存在，你没有读取权限'),
    '当前账户未获授权读取「运行 run_abc」',
  );
  assert.equal(
    callErrorFact('SOURCE_NOT_PERMITTED', '当前账户未获授权使用技能「toy-skill」'),
    '当前账户未获授权使用技能「toy-skill」',
  );
});

test('SOURCE_NOT_PERMITTED member and admin next steps differ; admin commands are registered', () => {
  const memberFix = '请联系管理员为该账户或所在团队分配此工作流';
  const member = renderCallError(
    { code: 'SOURCE_NOT_PERMITTED', message: '当前账户未获授权使用工作流「recompose」', fix: memberFix, path: '/pack' },
    'user',
    fixByRole('SOURCE_NOT_PERMITTED', 'user', memberFix),
  )!;
  assert.equal(
    member,
    '无权限：当前账户未获授权使用工作流「recompose」。请联系管理员为该账户或所在团队分配此工作流。当前账户可用的工作流和技能用 list_task_packs 查看。',
  );
  assert.doesNotMatch(member, /状态|判断|原因|决定者|任务包|没有分配给你/);

  const adminFix = fixByRole('SOURCE_NOT_PERMITTED', 'admin', memberFix)!;
  const admin = renderCallError(
    { code: 'SOURCE_NOT_PERMITTED', message: '当前账户未获授权使用工作流「recompose」', fix: adminFix, path: '/pack' },
    'admin',
    adminFix,
  )!;
  assert.equal(
    admin,
    '无权限：当前账户未获授权使用工作流「recompose」。请执行 circle-hub pack assign <当前账户的名字> recompose 为该账户分配，或在控制台「团队」页为所在团队分配。',
  );
  assert.doesNotMatch(admin, /请管理员|状态|判断|决定者|任务包|分享读取权限|换一个|用法见该命令登记/);
  assertCommandsRegistered(admin);
  assertCommandsRegistered(adminFix);

  const named = renderCallError(
    { code: 'SOURCE_NOT_PERMITTED', message: '当前账户未获授权使用工作流「recompose」', fix: adminFix, path: '/pack' },
    'admin',
    adminFix,
    '合成成员',
  )!;
  assert.equal(
    named,
    '无权限：当前账户未获授权使用工作流「recompose」。请执行 circle-hub pack assign 合成成员 recompose 为该账户分配，或在控制台「团队」页为所在团队分配。',
  );
  assert.doesNotMatch(named, /<当前账户的名字>/);
});

test('knowledge-tree-root denial keeps 绑定产品线 semantics', () => {
  const member = callErrorNext(
    'SOURCE_NOT_PERMITTED',
    'user',
    '请管理员给你分配绑定这条产品线的任务包后重交',
    '知识树根 abc 存在，当前账户没有读取权限',
  );
  assert.equal(
    member,
    '请联系管理员为该账户分配绑定这条产品线的工作流；或改读这次运行锁定的构建的手册和命令树',
  );
  const admin = callErrorNext(
    'SOURCE_NOT_PERMITTED',
    'admin',
    '请管理员给你分配绑定这条产品线的任务包后重交',
    '知识树根 abc 存在，当前账户没有读取权限',
  );
  assert.match(admin, /绑定这条产品线/);
  assert.match(admin, /circle-hub pack assign /);
  assert.equal(
    renderCallError(
      { code: 'SOURCE_NOT_PERMITTED', message: '知识树根 abc 存在，当前账户没有读取权限', fix: '绑定这条产品线' },
      'user',
      '绑定这条产品线',
    ),
    '无权限：当前账户未获授权读取这条产品线的手册和命令树。请联系管理员为该账户分配绑定这条产品线的工作流；或改读这次运行锁定的构建的手册和命令树。',
  );
});

test('LEASE_UNAVAILABLE category form splits member and admin next steps', () => {
  const message =
    '键 bed/合成环境/client0 上有未到期的占用（持有运行 run_abc，取得于 2026-11-14T05:00:00.000Z）';
  const memberFix = PROTOCOL_CODES.LEASE_UNAVAILABLE.fix;
  const member = renderCallError(
    { code: 'LEASE_UNAVAILABLE', message, fix: memberFix },
    'user',
    fixByRole('LEASE_UNAVAILABLE', 'user', memberFix),
  )!;
  assert.match(member, /^已被占用：测试环境「合成环境」正由「其他成员」占用（自 \d{2}:\d{2} 起）。请等待释放后重试，或改订其他测试环境。$/);
  assert.doesNotMatch(member, /状态|判断|决定者|租约键|主人|按既有带理由规则/);

  const adminFix = fixByRole('LEASE_UNAVAILABLE', 'admin', memberFix)!;
  const admin = renderCallError(
    { code: 'LEASE_UNAVAILABLE', message, fix: adminFix },
    'admin',
    adminFix,
  )!;
  assert.match(admin, /^已被占用：测试环境「合成环境」正由「其他成员」占用/);
  assert.match(admin, /circle-hub lease release bed\/合成环境\/client0 --reason <理由>/);
  assert.match(admin, /控制台「连接」页/);
  assert.doesNotMatch(admin, /请管理员|状态|判断|决定者|不补造到期时刻/);
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
      message: '当前账户未获授权使用工作流「recompose」',
      fix: '请联系管理员为该账户或所在团队分配此工作流',
      path: '/pack',
    }],
    trace: TRACE,
  }), { caller: { role: 'user' } });
  assert.equal(
    denied,
    '无权限：当前账户未获授权使用工作流「recompose」。请联系管理员为该账户或所在团队分配此工作流。当前账户可用的工作流和技能用 list_task_packs 查看。',
  );

  const adminFix = fixByRole('SOURCE_NOT_PERMITTED', 'admin', '请联系管理员为该账户或所在团队分配此工作流')!;
  const adminDenied = toolText('start_run', StartRunOutput.parse({
    call_result: 'error',
    errors: [{
      code: 'SOURCE_NOT_PERMITTED',
      message: '当前账户未获授权使用工作流「recompose」',
      fix: adminFix,
      path: '/pack',
    }],
    trace: TRACE,
  }), { caller: { role: 'admin' } });
  assert.equal(
    adminDenied,
    '无权限：当前账户未获授权使用工作流「recompose」。请执行 circle-hub pack assign <当前账户的名字> recompose 为该账户分配，或在控制台「团队」页为所在团队分配。',
  );
  assert.doesNotMatch(adminDenied, /状态|判断|决定者|请管理员|分享读取权限|用法见该命令登记/);
  assertCommandsRegistered(adminDenied);

  const adminNamed = toolText('start_run', StartRunOutput.parse({
    call_result: 'error',
    errors: [{
      code: 'SOURCE_NOT_PERMITTED',
      message: '当前账户未获授权使用工作流「recompose」',
      fix: fixByRole('SOURCE_NOT_PERMITTED', 'admin', '请联系管理员为该账户或所在团队分配此工作流', '合成成员')!,
      path: '/pack',
    }],
    trace: TRACE,
  }), { caller: { role: 'admin', name: '合成成员' } });
  assert.equal(
    adminNamed,
    '无权限：当前账户未获授权使用工作流「recompose」。请执行 circle-hub pack assign 合成成员 recompose 为该账户分配，或在控制台「团队」页为所在团队分配。',
  );
  assert.doesNotMatch(adminNamed, /<当前账户的名字>/);

  const leaseAdmin = fixByRole('LEASE_UNAVAILABLE', 'admin')!;
  const leaseText = toolText('start_run', StartRunOutput.parse({
    call_result: 'error',
    errors: [{
      code: 'LEASE_UNAVAILABLE',
      message: '键 bed/合成环境/client0 上有未到期的占用（持有运行 run_abc，取得于 2026-11-14T05:00:00.000Z）',
      fix: leaseAdmin,
    }],
    trace: TRACE,
  }), { caller: { role: 'admin' } });
  assert.match(leaseText, /^已被占用：测试环境「合成环境」/);
  assert.match(leaseText, /circle-hub lease release bed\/合成环境\/client0 --reason <理由>/);
  assert.doesNotMatch(leaseText, /不补造到期时刻|租约键|主人/);
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

test('Boss 14:32 RUN_SUPERSEDED passes throw-site fact and table next', () => {
  const fact = '这次运行已有后续的运行 run_synth_successor，不再接受提交';
  assert.equal(callErrorFact('RUN_SUPERSEDED', fact), fact);
  assert.equal(
    renderCallError({ code: 'RUN_SUPERSEDED', message: fact }, 'user', PROTOCOL_CODES.RUN_SUPERSEDED.fix),
    '不存在：这次运行已有后续的运行 run_synth_successor，不再接受提交。要修改已交的内容，请开始新的运行再提交；不修改时，在后续的运行里继续。',
  );
  // Current engine message (Codex still to rewrite): still pass through, never invent a numberless fact.
  const legacy = '运行 run_old 已被新修订 run_new 取代';
  assert.equal(callErrorFact('RUN_SUPERSEDED', legacy), legacy);
  assert.match(
    renderCallError({ code: 'RUN_SUPERSEDED', message: legacy }, 'user', undefined)!,
    /^不存在：运行 run_old 已被新修订 run_new 取代。要修改已交的内容/,
  );
});

test('Boss 14:32 RUN_ABANDONED target sentence', () => {
  assert.equal(
    renderCallError({ code: 'RUN_ABANDONED', message: PROTOCOL_CODES.RUN_ABANDONED.when }, 'user', PROTOCOL_CODES.RUN_ABANDONED.fix),
    '不存在：这次运行已放弃，不再接受提交。请用 start_run 以这次运行为前驱（predecessor）开始新的运行。',
  );
});

test('Boss 14:32 EFFECT_UNKNOWN_DISPOSED is a核对结论, not a call-error category', () => {
  assert.equal(callErrorCategoryOf('EFFECT_UNKNOWN_DISPOSED'), null);
  assert.equal(renderCallError({ code: 'EFFECT_UNKNOWN_DISPOSED', message: PROTOCOL_CODES.EFFECT_UNKNOWN_DISPOSED.when }, 'user', PROTOCOL_CODES.EFFECT_UNKNOWN_DISPOSED.fix), null);
  const text = toolText('submit_result', SubmitResultOutput.parse({
    call_result: 'error',
    acceptance: 'not_accepted',
    errors: [{
      code: 'EFFECT_UNKNOWN_DISPOSED',
      message: PROTOCOL_CODES.EFFECT_UNKNOWN_DISPOSED.when,
      fix: PROTOCOL_CODES.EFFECT_UNKNOWN_DISPOSED.fix,
    }],
    trace: TRACE,
  }));
  assert.match(text, /效果原结局仍未证明，运行者已具名选择标记失败处置/);
  assert.match(text, /状态已确认；判断错误/);
  assert.match(text, /决定者程序/);
  assert.doesNotMatch(text, /^不存在：|^参数无效：|^无权限：|^已被占用：|^暂时不可用：/m);
});

test('Boss 14:32 admin next steps fill the caller account name; <理由> stays', () => {
  const knowledge = callErrorNext(
    'SOURCE_NOT_PERMITTED',
    'admin',
    '分享读取权限',
    '条目 foo 存在，你没有读取权限',
    '合成成员',
    '/reference',
  );
  assert.equal(
    knowledge,
    '请执行 circle-hub share run <运行编号> --users 合成成员 分享读取权限，或改用当前账户能读的引用',
  );
  const lease = callErrorNext(
    'LEASE_UNAVAILABLE',
    'admin',
    PROTOCOL_CODES.LEASE_UNAVAILABLE.fix,
    '键 bed/合成环境/client0 上有未到期的占用',
    '合成成员',
  );
  assert.match(lease, /--reason <理由>/);
  assert.doesNotMatch(lease, /<当前账户的名字>/);
});
