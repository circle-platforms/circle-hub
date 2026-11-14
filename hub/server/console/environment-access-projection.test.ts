// Pure projection over a fake catalog; no PostgreSQL, vault, network or environment files.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Principal } from '../../records/api.ts';
import {
  assignmentSourceLabel,
  environmentAccessProjection,
  type EnvironmentAccessCatalogItem,
  type EnvironmentAccessPort,
} from './environment-access-projection.ts';

const admin: Principal = { id: 'usr_0' + 'a'.repeat(25), name: '合成管理员', role: 'admin' };
const alice: Principal = { id: 'usr_0' + 'b'.repeat(25), name: '合成成员甲', role: 'user' };
const bob: Principal = { id: 'usr_0' + 'c'.repeat(25), name: '合成成员乙', role: 'user' };

const catalog: EnvironmentAccessCatalogItem[] = [
  {
    name: '合成环境·直接',
    enabled: true,
    assignments: [{ kind: 'account', name: '合成成员甲' }],
  },
  {
    name: '合成环境·团队',
    enabled: true,
    assignments: [{ kind: 'team', name: '合成一组' }],
  },
  {
    name: '合成环境·全体',
    enabled: true,
    assignments: [{ kind: 'all', name: '全体' }],
  },
  {
    name: '合成环境·未分配',
    enabled: true,
    assignments: [],
  },
  {
    name: '合成环境·停用',
    enabled: false,
    assignments: [{ kind: 'account', name: '合成成员甲' }],
  },
];

function fakePort(teams: Record<string, readonly string[]>): EnvironmentAccessPort {
  return {
    list: async () => catalog,
    teamsOf: async (principal) => teams[principal.id] ?? [],
  };
}

test('administrator sees every catalog name; member sees only assigned ones', async () => {
  const port = fakePort({ [alice.id]: ['合成一组'], [bob.id]: [], [admin.id]: [] });
  const names = (rows: readonly { name: string }[]) => [...rows.map((row) => row.name)].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  const adminView = await environmentAccessProjection(port, admin);
  assert.deepEqual(names(adminView), names(catalog));
  assert.equal(adminView.length, catalog.length);

  const aliceView = await environmentAccessProjection(port, alice);
  assert.deepEqual(names(aliceView), names([
    { name: '合成环境·停用' },
    { name: '合成环境·全体' },
    { name: '合成环境·团队' },
    { name: '合成环境·直接' },
  ]));
  assert.ok(!aliceView.some((row) => row.name === '合成环境·未分配'));

  const bobView = await environmentAccessProjection(port, bob);
  assert.deepEqual(names(bobView), ['合成环境·全体']);
});

test('inheritance source fields stay consistent for the same principal across calls', async () => {
  const port = fakePort({ [alice.id]: ['合成一组'] });
  const first = await environmentAccessProjection(port, alice);
  const second = await environmentAccessProjection(port, alice);
  assert.deepEqual(first, second);

  const byName = Object.fromEntries(first.map((row) => [row.name, row]));
  assert.equal(byName['合成环境·直接']?.assignmentSource, 'direct');
  assert.equal(byName['合成环境·直接']?.inheritedFrom, null);
  assert.equal(assignmentSourceLabel(byName['合成环境·直接']!.assignmentSource), '直接');

  assert.equal(byName['合成环境·团队']?.assignmentSource, 'team');
  assert.equal(byName['合成环境·团队']?.inheritedFrom, '合成一组');
  assert.equal(assignmentSourceLabel(byName['合成环境·团队']!.assignmentSource), '从团队继承');

  assert.equal(byName['合成环境·全体']?.assignmentSource, 'all');
  assert.equal(byName['合成环境·全体']?.inheritedFrom, null);
  assert.equal(assignmentSourceLabel(byName['合成环境·全体']!.assignmentSource), '全体');
});

test('administrator unassigned rows keep null inheritance source while listing assignees', async () => {
  const port = fakePort({ [admin.id]: [] });
  const view = await environmentAccessProjection(port, admin);
  const unassigned = view.find((row) => row.name === '合成环境·未分配');
  assert.ok(unassigned);
  assert.equal(unassigned.assigned, false);
  assert.equal(unassigned.assignmentSource, null);
  assert.equal(unassigned.inheritedFrom, null);
  assert.equal(assignmentSourceLabel(unassigned.assignmentSource), '未分配');
  assert.deepEqual(unassigned.assignees, []);

  const teamRow = view.find((row) => row.name === '合成环境·团队');
  assert.ok(teamRow);
  assert.equal(teamRow.assigned, false);
  assert.equal(teamRow.assignmentSource, null);
  assert.deepEqual(teamRow.assignees, [{ kind: 'team', name: '合成一组' }]);
});

test('direct assignment wins over team and all for the inheritance source field', async () => {
  const port: EnvironmentAccessPort = {
    list: async () => [{
      name: '合成环境·重叠',
      enabled: true,
      assignments: [
        { kind: 'all', name: '全体' },
        { kind: 'team', name: '合成一组' },
        { kind: 'account', name: '合成成员甲' },
      ],
    }],
    teamsOf: async () => ['合成一组'],
  };
  const [row] = await environmentAccessProjection(port, alice);
  assert.equal(row.assignmentSource, 'direct');
  assert.equal(row.inheritedFrom, null);
  assert.equal(row.assigned, true);
});
