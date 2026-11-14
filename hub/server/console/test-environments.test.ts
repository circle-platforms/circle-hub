import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ServerDeps } from '../api.ts';
import type { PageContext } from './context.ts';
import { ACTIONS } from './manage.ts';
import './test-environment-actions.ts';
import {
  TEST_ENVIRONMENT_ACTIONS,
  createMutableTestEnvironmentsPort,
  occupancyViewForEnvironment,
  testEnvironmentsPanel,
  testEnvironmentsPort,
  type TestEnvironmentConsoleRow,
  type TestEnvironmentsConsolePort,
} from './test-environments.ts';
import { ENVIRONMENT_ASSIGNMENT_PREVIEW } from './connections.ts';
import { ENVIRONMENT_ASSIGNMENT_PREVIEW as PREVIEW_FROM_WORDS } from '../pack-words.ts';
import { REGISTER_AS_TEST_ENVIRONMENT, REGISTER_FROM_PREFIX_DIALOG } from './test-environments-prefixes.ts';
import { commands } from './commands.ts';

const admin = { id: 'usr_' + '0'.repeat(26), name: '合成管理员', role: 'admin' as const };
const member = { id: 'usr_' + '1'.repeat(26), name: '合成成员', role: 'user' as const };

function row(partial: Partial<TestEnvironmentConsoleRow> = {}): TestEnvironmentConsoleRow {
  return {
    name: '合成实验室',
    target: 'APV_1',
    prefixes: ['synthetic/lab/'],
    resources: ['synthetic/lab/exact'],
    executors: ['合成执行器甲'],
    owner: '合成管理员',
    assignments: [{
      subject: { kind: 'team', name: '研发测试组' },
      source: 'direct',
      holderIds: [member.id],
    }, {
      subject: { kind: 'account', name: '合成成员' },
      source: 'inherited',
      viaTeam: '研发测试组',
      holderIds: [member.id],
    }],
    occupancyKeys: ['synthetic/lab/exact'],
    ...partial,
  };
}

function fakePort(overrides: Partial<TestEnvironmentsConsolePort> = {}): TestEnvironmentsConsolePort {
  return {
    list: async () => [row()],
    executorChoices: async () => [{ name: '合成执行器甲' }],
    ownerChoices: async () => [{ name: '合成管理员' }],
    teamChoices: async () => [{ name: '研发测试组' }],
    accountChoices: async () => [{ name: '合成成员' }],
    assignmentsEnforced: false,
    ...overrides,
  };
}

function context(input: {
  admin?: boolean;
  port?: TestEnvironmentsConsolePort | undefined;
  leases?: PageContext['deps']['leases'];
  prefixes?: { list(): Promise<readonly { prefix: string; ownerName: string }[]> };
  registerPrefix?: string | null;
}): PageContext {
  const principal = input.admin === false ? member : admin;
  const url = new URL('http://127.0.0.1/console/connections?tab=environments');
  if (input.registerPrefix) url.searchParams.set('register_prefix', input.registerPrefix);
  return {
    principal,
    admin: input.admin !== false,
    url,
    csrf: 'synthetic-csrf',
    userName: async (id) => (id === member.id ? '合成成员' : '账户'),
    chrome: (title, extra = {}) => ({ title, ...extra, user: { name: principal.name, role: input.admin === false ? '成员' : '管理员', admin: input.admin !== false } }),
    deps: {
      testEnvironments: input.port,
      bookingPrefixes: input.prefixes,
      leases: input.leases,
      records: { principals: { tokens: async () => [] }, callLog: {} },
      memberCapabilities: async () => ({ environmentAccess: { enforced: false, ready: true, missing: null, nextAction: null }, environments: [] }),
    } as unknown as ServerDeps,
  } as PageContext;
}

const formOf = (values: Record<string, string>) => ({ get: (name: string) => values[name] ?? '' });

test('preview sentence matches the shared ENVIRONMENT_ASSIGNMENT_PREVIEW wording', () => {
  assert.equal(ENVIRONMENT_ASSIGNMENT_PREVIEW, PREVIEW_FROM_WORDS);
  assert.match(ENVIRONMENT_ASSIGNMENT_PREVIEW, /测试环境的分配还没有启用/);
});

test('commands.bedCatalog names match manage action keys', () => {
  assert.equal(commands.bedCatalog.register, TEST_ENVIRONMENT_ACTIONS.register);
  assert.equal(commands.bedCatalog.assign, TEST_ENVIRONMENT_ACTIONS.assign);
  assert.equal(commands.bedCatalog.unassign, TEST_ENVIRONMENT_ACTIONS.unassign);
  assert.ok(Object.hasOwn(ACTIONS, TEST_ENVIRONMENT_ACTIONS.register));
  assert.ok(Object.hasOwn(ACTIONS, TEST_ENVIRONMENT_ACTIONS.assign));
  assert.ok(Object.hasOwn(ACTIONS, TEST_ENVIRONMENT_ACTIONS.unassign));
});

test('missing port shows the explicit empty state for administrators', async () => {
  const body = (await testEnvironmentsPanel(context({ port: undefined }))).text;
  assert.match(body, /data-test-environments="unwired"/);
  assert.match(body, /请管理员配置测试环境目录/);
  assert.doesNotMatch(body, /env_|exe_|usr_|bed-register/);
});

test('member sees a pointer, not the catalog form', async () => {
  const body = (await testEnvironmentsPanel(context({ admin: false, port: fakePort() }))).text;
  assert.match(body, /data-test-environments="member"/);
  assert.match(body, /我能做的事/);
  assert.doesNotMatch(body, /登记测试环境|bed-register|分给了谁/);
});

test('catalog lists by name with human fields and manage action names', async () => {
  const body = (await testEnvironmentsPanel(context({ port: fakePort() }))).text;
  assert.match(body, /data-test-environments="ready"/);
  assert.match(body, /合成实验室/);
  assert.match(body, /APV_1/);
  assert.match(body, /synthetic\/lab\//);
  assert.match(body, /合成执行器甲/);
  assert.match(body, /团队 研发测试组 · 直接/);
  assert.match(body, /账户 合成成员 · 从团队「研发测试组」继承/);
  assert.match(body, new RegExp(`/console/admin/do/${TEST_ENVIRONMENT_ACTIONS.register}`));
  assert.match(body, new RegExp(`/console/admin/do/${TEST_ENVIRONMENT_ACTIONS.assign}`));
  assert.match(body, new RegExp(`/console/admin/do/${TEST_ENVIRONMENT_ACTIONS.unassign}`));
  assert.match(body, /name="name"/);
  assert.match(body, /name="target"/);
  assert.match(body, /name="prefix_or_key"/);
  assert.match(body, /name="executor"/);
  assert.match(body, /name="owner"/);
  assert.doesNotMatch(body, /env_|exe_|usr_|type="file"|enctype="multipart/);
});

test('unassign confirmation reuses occupancy fields with force_release checkboxes', async () => {
  const port = fakePort();
  const body = (await testEnvironmentsPanel(context({
    port,
    leases: {
      view: async () => ({
        entries: [{
          key: 'synthetic/lab/exact',
          since: '2026-11-14T08:00:00.000Z',
          until: null,
          run: 'run_a',
          user: member.id,
        }],
      }),
    },
  }))).text;
  assert.match(body, /撤回测试环境分配：合成实验室/);
  assert.match(body, /force_release/);
  assert.match(body, /测试环境「合成实验室」/);
  assert.match(body, /合成成员/);
  assert.match(body, /预订仍留在持有人名下/);
  assert.doesNotMatch(body, /exe_occupancy|env_/);
});

test('occupancy view uses the environment name and occupancy keys only', () => {
  const view = occupancyViewForEnvironment(row());
  assert.equal(view.target, '合成实验室');
  assert.deepEqual(view.resources, ['synthetic/lab/exact']);
  assert.doesNotMatch(view.id, /^env_/);
});

test('testEnvironmentsPort reads the optional deps field', () => {
  const port = fakePort();
  assert.equal(testEnvironmentsPort(context({ port })), port);
  assert.equal(testEnvironmentsPort(context({ port: undefined })), undefined);
});

test('bed-register / bed-assign / bed-unassign build argv matching Codex bed CLI', () => {
  assert.deepEqual(
    ACTIONS['bed-register'].build(formOf({
      name: '合成实验室',
      target: 'APV_1',
      prefix_or_key: 'synthetic/lab/',
      executor: '合成执行器甲',
      owner: '合成管理员',
    })),
    {
      argv: [
        'bed', 'register', '合成实验室',
        '--target=APV_1',
        '--prefix=synthetic/lab/',
        '--executor=合成执行器甲',
        '--owner=合成管理员',
      ],
    },
  );
  assert.deepEqual(
    ACTIONS['bed-register'].build(formOf({
      name: '精确键环境',
      target: 'APV_2',
      prefix_or_key: 'synthetic/exact-key',
      owner: '合成管理员',
    })),
    {
      argv: [
        'bed', 'register', '精确键环境',
        '--target=APV_2',
        '--resource=synthetic/exact-key',
        '--owner=合成管理员',
      ],
    },
  );
  assert.deepEqual(
    ACTIONS['bed-assign'].build(formOf({ environment: '合成实验室', team: '研发测试组' })),
    { argv: ['bed', 'assign', '合成实验室', '--team=研发测试组'] },
  );
  assert.deepEqual(
    ACTIONS['bed-assign'].build(formOf({ environment: '合成实验室', user: '合成成员' })),
    { argv: ['bed', 'assign', '合成实验室', '--user=合成成员'] },
  );
  assert.deepEqual(
    ACTIONS['bed-assign'].build(formOf({ environment: '合成实验室', all: '1' })),
    { argv: ['bed', 'assign', '合成实验室', '--all'] },
  );
  assert.deepEqual(
    ACTIONS['bed-unassign'].build(formOf({ environment: '合成实验室', team: '研发测试组' })),
    { argv: ['bed', 'unassign', '合成实验室', '--team=研发测试组'] },
  );
  const chained = ACTIONS['bed-unassign'].build(formOf({
    environment: '合成实验室',
    user: '合成成员',
    force_release: 'synthetic/lab/exact',
  }));
  assert.ok(Array.isArray(chained));
  assert.equal(chained.length, 2);
  assert.deepEqual(chained[0]!.argv, ['bed', 'unassign', '合成实验室', '--user=合成成员']);
  assert.deepEqual(chained[1]!.argv.slice(0, 3), ['lease', 'release', 'synthetic/lab/exact']);
});

test('mutable fake port assign and unassign update 分给了谁 direct and inherited labels', async () => {
  const port = createMutableTestEnvironmentsPort({
    rows: [row({
      assignments: [{
        subject: { kind: 'account', name: '合成成员' },
        source: 'inherited',
        viaTeam: '研发测试组',
        holderIds: [member.id],
      }],
    })],
    executors: [{ name: '合成执行器甲' }],
    owners: [{ name: '合成管理员' }],
    teams: [{ name: '研发测试组' }],
    accounts: [{ name: '合成成员' }],
    teamHolders: { 研发测试组: [member.id] },
    accountHolders: { 合成成员: [member.id] },
  });
  assert.ok(port.assign);
  assert.ok(port.unassign);
  let body = (await testEnvironmentsPanel(context({ port }))).text;
  assert.match(body, /账户 合成成员 · 从团队「研发测试组」继承/);
  assert.doesNotMatch(body, /团队 研发测试组 · 直接/);

  await port.assign!(admin, '合成实验室', { kind: 'team', name: '研发测试组' });
  body = (await testEnvironmentsPanel(context({ port }))).text;
  assert.match(body, /团队 研发测试组 · 直接/);
  assert.match(body, /账户 合成成员 · 从团队「研发测试组」继承/);

  await port.assign!(admin, '合成实验室', { kind: 'account', name: '合成成员' });
  body = (await testEnvironmentsPanel(context({ port }))).text;
  assert.match(body, /账户 合成成员 · 直接/);
  assert.match(body, /账户 合成成员 · 从团队「研发测试组」继承/);

  await port.unassign!(admin, '合成实验室', { kind: 'team', name: '研发测试组' });
  body = (await testEnvironmentsPanel(context({ port }))).text;
  assert.doesNotMatch(body, /团队 研发测试组 · 直接/);
  assert.match(body, /账户 合成成员 · 直接/);
  assert.match(body, /账户 合成成员 · 从团队「研发测试组」继承/);
});

test('mutable fake port register adds a catalog row without internal ids', async () => {
  const port = createMutableTestEnvironmentsPort({
    executors: [{ name: '合成执行器甲' }],
    owners: [{ name: '合成管理员' }],
  });
  assert.ok(port.register);
  await port.register!(admin, {
    name: '新实验室',
    target: 'APV_9',
    prefixOrKey: 'synthetic/new/',
    executor: '合成执行器甲',
    owner: '合成管理员',
  });
  const body = (await testEnvironmentsPanel(context({ port }))).text;
  assert.match(body, /新实验室/);
  assert.match(body, /APV_9/);
  assert.match(body, /synthetic\/new\//);
  assert.match(body, /尚未分配/);
  assert.doesNotMatch(body, /env_|exe_|usr_/);
});

test('booking-prefix column opens the same bed-register form with prefix prefilled', async () => {
  const port = fakePort();
  const body = (await testEnvironmentsPanel(context({
    port,
    registerPrefix: 'ordinary/bookings/',
    prefixes: {
      list: async () => [{
        prefix: 'ordinary/bookings/',
        ownerName: '合成责任人',
        holders: [{ name: '合成持有人甲' }],
        workflowAssignees: [{ kind: 'team', name: '合成一组' }],
      }],
    },
  }))).text;
  assert.match(body, new RegExp(REGISTER_AS_TEST_ENVIRONMENT));
  assert.match(body, new RegExp(`id="${REGISTER_FROM_PREFIX_DIALOG}"`));
  assert.match(body, /ordinary\/bookings\//);
  assert.match(body, /value="ordinary\/bookings\/"/);
  assert.match(body, /合成责任人/);
  assert.match(body, new RegExp(`/console/admin/do/${TEST_ENVIRONMENT_ACTIONS.register}`));
  assert.match(body, /现在谁在用这个前缀/);
  assert.doesNotMatch(body, /usr_|tm_|env_/);
});
