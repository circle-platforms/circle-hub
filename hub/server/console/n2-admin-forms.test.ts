import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  REGISTERED_ACTIONS,
  UPLOAD_REFERENCE_ACTIONS,
  buildRegisteredAction,
  commandFields,
  registeredActionForm,
} from './command-form.ts';
import { ACTIONS, displayCommandLine, resultPage, scrubInternalIds } from './manage.ts';
import { TEAM_ACTIONS } from './team-actions.ts';
import type { PageContext } from './context.ts';

const formOf = (entries: Record<string, string>) => ({ get: (name: string) => entries[name] ?? '' });
const team = 'tm_0123456789abcdefghjkmnpqrs';
const user = 'usr_0123456789abcdefghjkmnpqrs';
const executor = 'exe_0123456789abcdefghjkmnpqrs';
const resource = 'res_0123456789abcdefghjkmnpqrs';

test('N2 registered actions cover member, pack install, and environment registration commands', () => {
  for (const action of [
    'user-invite', 'token-issue', 'password-reset', 'user-disable', 'user-enable',
    'pack-install', 'pack-uninstall', 'pack-activate', 'pack-deactivate', 'pack-retire',
    'executor-add', 'executor-update', 'executor-disable', 'executor-assign', 'doc-put',
  ] as const) {
    assert.equal(typeof REGISTERED_ACTIONS[action], 'string');
    assert.ok(Object.hasOwn(ACTIONS, action), action);
  }
  assert.ok(UPLOAD_REFERENCE_ACTIONS.has('executor-add'));
  assert.ok(UPLOAD_REFERENCE_ACTIONS.has('executor-update'));
  assert.ok(UPLOAD_REFERENCE_ACTIONS.has('doc-put'));
});

test('pack install and executor assign build argv from the command registry', () => {
  assert.deepEqual(
    buildRegisteredAction('pack-install', formOf({ pack: 'synth-skill@1.0.0' })),
    { argv: ['pack', 'install', 'synth-skill@1.0.0'] },
  );
  assert.deepEqual(
    buildRegisteredAction('executor-assign', formOf({ executor: 'exe_synthetic', team: 'tm_0123456789abcdefghjkmnpqrs' })),
    { argv: ['executor', 'assign', 'exe_synthetic', '--team=tm_0123456789abcdefghjkmnpqrs'] },
  );
  assert.deepEqual(
    buildRegisteredAction('doc-put', formOf({ name: 'bed-topology', reference: 'src:' + 'a'.repeat(64) })),
    { argv: ['doc', 'put', 'bed-topology', '--reference=src:' + 'a'.repeat(64)] },
  );
});

test('executor-assign accepts several executors in one form for the same subject', () => {
  const built = ACTIONS['executor-assign'].build(formOf({
    executors: 'exe_synthetic_a\nexe_synthetic_b',
    team: 'tm_0123456789abcdefghjkmnpqrs',
  }));
  assert.ok(Array.isArray(built));
  assert.deepEqual(built, [
    { argv: ['executor', 'assign', 'exe_synthetic_a', '--team=tm_0123456789abcdefghjkmnpqrs'] },
    { argv: ['executor', 'assign', 'exe_synthetic_b', '--team=tm_0123456789abcdefghjkmnpqrs'] },
  ]);
});

test('member invite and team batch assign forms post to admin actions', () => {
  const invite = String(registeredActionForm('user-invite', 'csrf', '签发', { values: { user: 'usr_synthetic' } }));
  assert.match(invite, /action="\/console\/admin\/do\/user-invite"/);
  assert.match(invite, /name="user" value="usr_synthetic"/);
  assert.match(String(commandFields('pack.install', {}, { pack: 'x@1' })), /通用技能版本/);
  const batch = TEAM_ACTIONS['pack-assign-team'].build(formOf({
    team: 'tm_0123456789abcdefghjkmnpqrs',
    packs: 'flow-a\nflow-b',
  }));
  assert.ok(Array.isArray(batch));
  assert.deepEqual(batch, [
    { argv: ['pack', 'assign', 'flow-a', '--team=tm_0123456789abcdefghjkmnpqrs'] },
    { argv: ['pack', 'assign', 'flow-b', '--team=tm_0123456789abcdefghjkmnpqrs'] },
  ]);
});

test('operations page wording no longer claims only four actions', async () => {
  const source = await import('node:fs/promises').then((fs) => fs.readFile(new URL('./operations.ts', import.meta.url), 'utf8'));
  assert.doesNotMatch(source, /只执行这四种管理操作/);
  assert.match(source, /经同一命令通道写入/);
});

test('scrubInternalIds removes management-result identity prefixes', () => {
  assert.equal(scrubInternalIds(`已建立用户 甲（${user}，成员）`), '已建立用户 甲（成员）');
  assert.equal(scrubInternalIds(`已撤回团队 ${team} 的工作流分配`), '已撤回团队 的工作流分配');
  assert.doesNotMatch(scrubInternalIds(`资源 ${resource}：合成；执行器 ${executor}`), /usr_|tm_|exe_|res_/);
});

test('displayCommandLine replaces team and account ids with form labels', async () => {
  const ctx = {
    principal: { id: user, name: '合成管理员', role: 'admin' },
    userName: async () => '合成成员',
    deps: {
      records: { teams: { get: async () => ({ id: team, name: '合成团队' }) } },
      resources: { list: async () => [{ id: resource, name: '合成资源' }] },
      dispatch: { executors: async () => [{ id: executor, target: 'APV_1', endpoint: 'https://192.0.2.1', enabled: true, resources: [] }] },
    },
  } as unknown as PageContext;
  const line = await displayCommandLine(ctx, ['pack', 'unassign', 'case-compile', `--team=${team}`], formOf({ team, team_label: '研发测试组' }));
  assert.equal(line, 'circle-hub pack unassign case-compile --team=研发测试组');
  assert.doesNotMatch(line, /tm_|usr_|exe_|res_/);
  const assigned = await displayCommandLine(ctx, ['executor', 'assign', executor, `--team=${team}`], formOf({}));
  assert.equal(assigned, 'circle-hub executor assign APV_1 --team=合成团队');
  const resLine = await displayCommandLine(ctx, ['resource', 'assign', resource, `--team=${team}`], formOf({}));
  assert.equal(resLine, 'circle-hub resource assign 合成资源 --team=合成团队');
});

test('resultPage command echo and stdout hide internal ids', async () => {
  const ctx = {
    principal: { id: user, name: '合成管理员', role: 'admin' },
    userName: async () => '合成成员',
    chrome: (title: string) => ({ title, user: { name: '合成管理员', role: '管理员', admin: true } }),
    deps: {
      records: { teams: { get: async () => ({ id: team, name: '合成团队' }) } },
      resources: { list: async () => [] },
    },
    url: new URL('http://192.0.2.1/console/admin/do/pack-unassign-team'),
  } as unknown as PageContext;
  const page = await resultPage(
    ctx,
    TEAM_ACTIONS['pack-unassign-team'],
    [{ argv: ['pack', 'unassign', 'case-compile', `--team=${team}`], run: { code: 0, stdout: ['已撤回团队 合成团队 的 case-compile 分配'], stderr: [] } }],
    formOf({ team, team_label: '合成团队' }),
  );
  const body = String(page.body);
  assert.match(body, /circle-hub pack unassign case-compile --team=合成团队/);
  assert.match(body, /已撤回团队 合成团队/);
  assert.doesNotMatch(body, /tm_|usr_|exe_|res_/);
});

test('executor-assign result page carries the staged environment-assignment preview', async () => {
  const ctx = {
    principal: { id: user, name: '合成管理员', role: 'admin' },
    userName: async () => '合成成员',
    chrome: (title: string, extra = {}) => ({ title, user: { name: '合成管理员', role: '管理员', admin: true }, ...extra }),
    deps: {
      records: { teams: { get: async () => ({ id: team, name: '合成团队' }) } },
      resources: { list: async () => [] },
      dispatch: { executors: async () => [{ id: executor, target: 'APV_1', endpoint: 'https://192.0.2.1', enabled: true, resources: [] }] },
      memberCapabilities: async () => ({ environmentAccess: { enforced: false, ready: true, missing: null, nextAction: null } }),
    },
    url: new URL('http://192.0.2.1/console/admin/do/executor-assign'),
  } as unknown as PageContext;
  const page = await resultPage(
    ctx,
    ACTIONS['executor-assign'],
    [{ argv: ['executor', 'assign', executor, `--team=${team}`], run: { code: 0, stdout: ['已分配'], stderr: [] } }],
    formOf({ executor, team }),
  );
  const body = String(page.body);
  assert.match(body, /data-environment-assignment-preview/);
  assert.match(body, /新测试环境分配尚未启用，当前仍按原工作流和预订规则/);
  assert.doesNotMatch(body, /exe_/);
});
