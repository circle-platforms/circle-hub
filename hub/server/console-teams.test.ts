// Synthetic PageContext only; team rows are faked in this file (fakes.ts stays Codex-owned).
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
  id: 'tm_01syntheticteama00000000000',
  name: '合成甲组',
  created_at: '2026-11-13T00:00:00.000Z',
  created_by: ADMIN.id,
  deleted_at: null,
  member_count: 2,
  pack_count: 1,
  resource_count: 3,
};
const TEAM_B: ConsoleTeamRow = {
  id: 'tm_01syntheticteamb00000000000',
  name: '合成乙组',
  created_at: '2026-11-13T01:00:00.000Z',
  created_by: ADMIN.id,
  deleted_at: null,
  member_count: 1,
  pack_count: 0,
  resource_count: 0,
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
};

function fakeTeams(options: {
  list?: ConsoleTeamRow[];
  get?: (id: string) => ConsoleTeam | null;
  members?: ConsoleTeams['members'];
  assignments?: ConsoleTeams['assignments'];
  memberships?: ConsoleTeams['memberships'];
} = {}): ConsoleTeams {
  const all = options.list ?? [TEAM_A, TEAM_B, BUILTIN];
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
      packs: [{ body: { object: 'wf.synthetic', subject: TEAM_A.id, revoked: false, decided_at: '2026-11-13T03:00:00.000Z', decided_by: ADMIN.id, note: null } }],
      resources: [{ body: { object: 'res_synthetic', subject: TEAM_A.id, revoked: false, decided_at: '2026-11-13T03:30:00.000Z', decided_by: ADMIN.id, note: null } }],
    })),
    memberships: options.memberships ?? (async (by, userId) => {
      const id = userId ?? by.id;
      if (id === MEMBER.id || id === ADMIN.id) return [TEAM_A];
      return [];
    }),
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
  assert.deepEqual(TEAM_ACTIONS['pack-assign-team'].build(form({ pack: 'wf.synthetic', team: TEAM_A.id })), {
    argv: ['pack', 'assign', 'wf.synthetic', `--team=${TEAM_A.id}`],
  });
  assert.deepEqual(TEAM_ACTIONS['resource-assign'].build(form({ resource: 'res_synthetic', audience: RESOURCE_AUDIENCE.all })), {
    argv: ['resource', 'assign', 'res_synthetic', '--all'],
  });
  assert.deepEqual(TEAM_ACTIONS['resource-assign'].build(form({ resource: 'res_synthetic', audience: RESOURCE_AUDIENCE.team, team: TEAM_A.id })), {
    argv: ['resource', 'assign', 'res_synthetic', `--team=${TEAM_A.id}`],
  });
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
  assert.match(body, /工作流 1 条，业务系统 1 条/);
  assert.deepEqual(wordingProblems(body), []);
});
