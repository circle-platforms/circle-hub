import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Principal } from '../records/api.ts';
import type { ServerDeps } from './api.ts';
import type { PageContext } from './console/context.ts';
import { TEAM_ACTIONS, RESOURCE_AUDIENCE, RESOURCE_AUDIENCE_OPTIONS, SYSTEM_ADD_AUDIENCE_HINT, TEAMS } from './console/team-actions.ts';
import { teamDetailPage, teamsPage, type ConsoleTeam, type ConsoleTeamRow, type ConsoleTeams } from './console/team.ts';
import { wordingProblems } from './console/testing-wording.ts';

const ADMIN: Principal = { id: 'usr_synthetic_admin', name: '合成管理员', role: 'admin' };
const MEMBER: Principal = { id: 'usr_synthetic_member', name: '合成成员', role: 'user' };
const OTHER: Principal = { id: 'usr_synthetic_other', name: '合成外人', role: 'user' };

const TEAM_A: ConsoleTeamRow = {
  id: 'tm_01aryz0123456789abcdefghjk',
  name: '合成甲组',
  created_at: '2026-11-13T00:00:00.000Z',
  created_by: ADMIN.id,
  deleted_at: null,
  member_count: 2,
  pack_count: 1,
  resource_count: 3,
  changed_at: '2026-11-13T03:00:00.000Z',
};
const TEAM_B: ConsoleTeamRow = {
  id: 'tm_01bryyz0123456789abcdefghm',
  name: '合成乙组',
  created_at: '2026-11-13T01:00:00.000Z',
  created_by: ADMIN.id,
  deleted_at: null,
  member_count: 1,
  pack_count: 0,
  resource_count: 0,
  changed_at: '2026-11-13T01:00:00.000Z',
};
const BUILTIN: ConsoleTeamRow = {
  id: 'team',
  name: '不应出现',
  created_at: '2026-11-13T00:00:00.000Z',
  created_by: ADMIN.id,
  deleted_at: null,
  member_count: 0,
  pack_count: 0,
  resource_count: 0,
  changed_at: '2026-11-13T00:00:00.000Z',
};

function fakeTeams(options: {
  list?: ConsoleTeamRow[];
  get?: (id: string) => ConsoleTeam | null;
  members?: ConsoleTeams['members'];
  assignments?: ConsoleTeams['assignments'];
  memberships?: ConsoleTeams['memberships'];
} = {}): ConsoleTeams {
  const all = options.list ?? [TEAM_A, TEAM_B, BUILTIN];
  const memberships: ConsoleTeams['memberships'] = options.memberships ?? (async (by, userId) => {
    const id = userId ?? by.id;
    if (id === MEMBER.id || id === ADMIN.id) return [TEAM_A];
    return [];
  });
  return {
    list: async (by) => (by.role === 'admin' ? all : all.filter((row) => row.id === TEAM_A.id)),
    get: async (by, id) => {
      if (options.get) return options.get(id);
      const row = all.find((team) => team.id === id) ?? null;
      if (!row) return null;
      if (by.role !== 'admin' && row.id !== TEAM_A.id) return null;
      return row;
    },
    members: options.members ?? (async () => [
      {
        team: TEAM_A.id,
        user: { id: MEMBER.id, name: MEMBER.name, role: 'user', disabled: false, deleted_at: null, created_at: '2026-11-01T00:00:00.000Z', updated_at: '2026-11-01T00:00:00.000Z' },
        added_at: '2026-11-13T02:00:00.000Z',
        added_by: ADMIN.id,
      },
    ]),
    assignments: options.assignments ?? (async () => ({
      packs: [{ body: { object: 'wf.synthetic', subject: TEAM_A.id, revoked: false, decided_at: '2026-11-13T03:00:00.000Z', decided_by: ADMIN.id, note: null } }] as never,
      resources: [{ body: { object: 'res_synthetic', subject: TEAM_A.id, revoked: false, decided_at: '2026-11-13T03:30:00.000Z', decided_by: ADMIN.id, note: null } }] as never,
    })),
    memberships,
    membershipsMany: async (by, userIds) => new Map(await Promise.all(userIds.map(async (id) => [id, await memberships(by, id)] as const))),
    create: async () => TEAM_A,
    delete: async (_by, id) => ({ ...(all.find((row) => row.id === id) ?? TEAM_A), revoked_packs: 0, revoked_resources: 0 }),
    add: async () => ({
      team: TEAM_A.id,
      user: { id: MEMBER.id, name: MEMBER.name, role: 'user', disabled: false, deleted_at: null, created_at: '2026-11-01T00:00:00.000Z', updated_at: '2026-11-01T00:00:00.000Z' },
      added_at: '2026-11-13T02:00:00.000Z',
      added_by: ADMIN.id,
    }),
    remove: async () => true,
  };
}

function context(principal: Principal, teams?: ConsoleTeams, path = TEAMS): PageContext {
  const admin = principal.role === 'admin';
  return {
    principal,
    admin,
    url: new URL(path, 'http://127.0.0.1'),
    csrf: 'synthetic-csrf',
    userName: async (id) => id ?? '—',
    chrome: (title, extra) => ({ title, user: { name: principal.name, role: admin ? '管理员' : '成员', admin }, csrf: 'synthetic-csrf', ...extra }),
    deps: {
      records: {
        teams,
        principals: {
          list: async () => [
            { id: ADMIN.id, name: ADMIN.name, role: 'admin', disabled: false, deleted_at: null, created_at: '2026-11-01T00:00:00.000Z', updated_at: '2026-11-01T00:00:00.000Z' },
            { id: MEMBER.id, name: MEMBER.name, role: 'user', disabled: false, deleted_at: null, created_at: '2026-11-01T00:00:00.000Z', updated_at: '2026-11-01T00:00:00.000Z' },
            { id: OTHER.id, name: OTHER.name, role: 'user', disabled: false, deleted_at: null, created_at: '2026-11-01T00:00:00.000Z', updated_at: '2026-11-01T00:00:00.000Z' },
          ],
        },
        authorizations: {},
      },
      packs: {
        list: async () => [{ id: 'wf.synthetic', title: '合成工作流', kind: 'workflow', space: null, withdrawn: false, version: '1.0.0' }],
      },
      resources: {
        list: async () => (admin ? [{ id: 'res_synthetic', name: '合成业务系统', system_pack: 'sys.synthetic@1.0.0', environment: 'lab', enabled: true }] : []),
      },
    } as unknown as ServerDeps,
  };
}

test('TEAM_ACTIONS build the argv shapes from interfaces §2', () => {
  const form = (entries: Record<string, string>) => ({ get: (name: string) => entries[name] ?? '' });
  assert.deepEqual(TEAM_ACTIONS['team-create'].build(form({ name: '合成组' })), { argv: ['team', 'create', '合成组'] });
  assert.deepEqual(TEAM_ACTIONS['team-delete'].build(form({ team: TEAM_A.id })), { argv: ['team', 'delete', TEAM_A.id] });
  assert.deepEqual(TEAM_ACTIONS['team-add'].build(form({ team: TEAM_A.id, user: MEMBER.id })), { argv: ['team', 'add', TEAM_A.id, MEMBER.id] });
  assert.deepEqual(TEAM_ACTIONS['pack-assign-team'].build(form({ pack: 'wf.synthetic', team: TEAM_A.id })), [
    { argv: ['pack', 'assign', 'wf.synthetic', `--team=${TEAM_A.id}`] },
  ]);
  assert.deepEqual(TEAM_ACTIONS['resource-assign'].build(form({ resource: 'res_synthetic', audience: RESOURCE_AUDIENCE.all })), [
    { argv: ['resource', 'assign', 'res_synthetic', '--all'] },
  ]);
  assert.deepEqual(TEAM_ACTIONS['resource-assign'].build(form({ resource: 'res_synthetic', audience: RESOURCE_AUDIENCE.team, team: TEAM_A.id })), [
    { argv: ['resource', 'assign', 'res_synthetic', `--team=${TEAM_A.id}`] },
  ]);
  assert.deepEqual(TEAM_ACTIONS['resource-assign'].build(form({
    resources: 'res_a\nres_b',
    audience: RESOURCE_AUDIENCE.team,
    team: TEAM_A.id,
  })), [
    { argv: ['resource', 'assign', 'res_a', `--team=${TEAM_A.id}`] },
    { argv: ['resource', 'assign', 'res_b', `--team=${TEAM_A.id}`] },
  ]);
  assert.throws(() => TEAM_ACTIONS['resource-assign'].build(form({ resource: 'res_synthetic', audience: RESOURCE_AUDIENCE.none })), /先不分配/);
  assert.equal(TEAMS, '/console/team');
  assert.deepEqual(RESOURCE_AUDIENCE_OPTIONS.map((row) => row.label), ['全体', '某团队', '先不分配']);
  assert.match(SYSTEM_ADD_AUDIENCE_HINT, /没有分配时对谁都不开放/);
});

test('teamsPage lists live teams for an admin and hides the built-in team space id', async () => {
  const page = await teamsPage(context(ADMIN, fakeTeams()));
  assert.equal(page.status, 200);
  const body = String(page.body);
  assert.match(body, /合成甲组/);
  assert.match(body, /合成乙组/);
  assert.doesNotMatch(body, /不应出现/);
  assert.match(body, /action="\/console\/admin\/do\/team-create"/);
  assert.match(body, /工作流 1 条，业务系统 3 条/);
  assert.match(body, /action="\/console\/admin\/do\/team-delete"/);
  assert.deepEqual(wordingProblems(body), []);
});

test('teamsPage for a member shows only own team names and no management forms', async () => {
  const page = await teamsPage(context(MEMBER, fakeTeams()));
  assert.equal(page.status, 200);
  const body = String(page.body);
  assert.match(body, /合成甲组/);
  assert.doesNotMatch(body, /合成乙组|team-create|team-delete|新建团队/);
  assert.deepEqual(wordingProblems(body), []);
});

test('teamsPage stays empty without pretending when records.teams is absent', async () => {
  const page = await teamsPage(context(ADMIN, undefined));
  assert.equal(page.status, 200);
  const body = String(page.body);
  assert.match(body, /尚无团队/);
  assert.doesNotMatch(body, /合成甲组/);
  assert.match(body, /action="\/console\/admin\/do\/team-create"/);
});

test('teamDetailPage is neutral when get returns null', async () => {
  const page = await teamDetailPage(context(OTHER, fakeTeams()), TEAM_B.id);
  assert.equal(page.status, 404);
  assert.match(String(page.body), /该内容不存在或无权查看/);
});

test('teamDetailPage for a member shows only the team name', async () => {
  const page = await teamDetailPage(context(MEMBER, fakeTeams(), `${TEAMS}/${TEAM_A.id}`), TEAM_A.id);
  assert.equal(page.status, 200);
  const body = String(page.body);
  assert.match(body, /合成甲组/);
  assert.doesNotMatch(body, /team-add|pack-assign-team|resource-assign|删除团队/);
  assert.deepEqual(wordingProblems(body), []);
});

test('teamDetailPage for an admin shows members, assignments and delete counts', async () => {
  const page = await teamDetailPage(context(ADMIN, fakeTeams(), `${TEAMS}/${TEAM_A.id}`), TEAM_A.id);
  assert.equal(page.status, 200);
  const body = String(page.body);
  assert.match(body, /合成成员/);
  assert.match(body, /合成工作流/);
  assert.match(body, /合成业务系统/);
  assert.match(body, /action="\/console\/admin\/do\/team-add"/);
  assert.match(body, /action="\/console\/admin\/do\/pack-assign-team"|action="\/console\/admin\/do\/pack-unassign-team"/);
  assert.match(body, /批量分配业务系统/);
  assert.match(body, /工作流 1 条，业务系统 1 条/);
  assert.match(body, /测试环境分配/);
  assert.deepEqual(wordingProblems(body), []);
});

test('teamDetailPage lists executor assignments under 测试环境 with target names', async () => {
  const executor = 'exe_01aryz0123456789abcdefghjk';
  const teams = fakeTeams({
    assignments: async () => ({
      packs: [{ body: { object: 'wf.synthetic', subject: TEAM_A.id, revoked: false, decided_at: '2026-11-13T03:00:00.000Z', decided_by: ADMIN.id, note: null } }] as never,
      resources: [
        { body: { object: 'res_synthetic', subject: TEAM_A.id, revoked: false, decided_at: '2026-11-13T03:30:00.000Z', decided_by: ADMIN.id, note: null } },
        { body: { object: executor, subject: TEAM_A.id, revoked: false, decided_at: '2026-11-13T04:00:00.000Z', decided_by: ADMIN.id, note: null } },
      ] as never,
    }),
  });
  const ctx = context(ADMIN, teams, `${TEAMS}/${TEAM_A.id}`);
  (ctx.deps as unknown as { dispatch: { executors: () => Promise<unknown[]> } }).dispatch = {
    executors: async () => [{ id: executor, target: '合成实验室', endpoint: 'https://192.0.2.10', enabled: true, resources: [] }],
  };
  (ctx.deps as unknown as { memberCapabilities: () => Promise<unknown> }).memberCapabilities = async () => ({
    environmentAccess: { enforced: false, ready: true, missing: null, nextAction: null },
  });
  const listed = await ctx.deps.resources.list(ADMIN);
  ctx.deps.resources.list = async () => [
    ...listed,
    { id: 'res_unassigned', name: '未分配业务系统', system_pack: 'sys.synthetic@1.0.0', environment: 'lab', enabled: true },
  ] as never;
  const page = await teamDetailPage(ctx, TEAM_A.id);
  assert.equal(page.status, 200);
  const body = String(page.body);
  assert.match(body, /合成实验室/);
  assert.match(body, /测试环境分配/);
  assert.match(body, /data-environment-assignment-preview/);
  assert.match(body, /<dt>业务系统<\/dt><dd>1<\/dd>/);
  assert.match(body, /<dt>测试环境<\/dt><dd>1<\/dd>/);
  assert.match(body, /name="resources" value="res_unassigned"/);
  const businessSection = body.slice(body.indexOf('业务系统分配'), body.indexOf('测试环境分配'));
  assert.doesNotMatch(businessSection, /合成实验室|exe_/);
  const environmentSection = body.slice(body.indexOf('测试环境分配'));
  assert.match(environmentSection, /合成实验室/);
  assert.doesNotMatch(environmentSection.replace(/value="exe_[^"]+"/g, 'value="hidden"'), /exe_/);
  assert.match(environmentSection, /href="#unassign-environment-0"/);
  assert.match(environmentSection, /撤回…/);
  assert.match(environmentSection, /id="unassign-environment-0"/);
  assert.match(environmentSection, /确认撤回/);
  assert.match(environmentSection, /预订仍留在持有人名下/);
  assert.match(environmentSection, /data-unassign-occupancy/);
  assert.doesNotMatch(environmentSection, /运行环境/);
});
