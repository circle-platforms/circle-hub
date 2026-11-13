import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import type { Principal, Team, TeamDeletion, Teams, User } from '../records/api.ts';
import type { CliContext } from './api.ts';
import { teamCommand, type TeamCommandSession } from './cli-team.ts';
import { packCommand } from './cli-pack.ts';
import { resourceCommand } from './cli-resource.ts';
import { Session } from './cli-session.ts';
import { UsageError } from './errors.ts';

const id = 'tm_0123456789abcdefghjkmnpqrs';
const member: User = { id: 'usr_0123456789abcdefghjkmnpqrs', name: '合成成员', role: 'user', disabled: false, deleted_at: null, created_at: '2035-01-01T00:00:00.000Z', updated_at: '2035-01-01T00:00:00.000Z' };
const team: Team = { id, name: '合成团队', created_at: member.created_at, created_by: member.id, deleted_at: null };
const deletion: TeamDeletion = { ...team, deleted_at: '2035-01-02T00:00:00.000Z', revoked_packs: 2, revoked_resources: 3 };
function fixture(admin: boolean) {
  const by: Principal = { ...member, role: admin ? 'admin' : 'user' }, out: string[] = [], writes: string[] = [];
  let restrictedReads = 0;
  const teams: Teams = {
    list: async () => [{ ...team, member_count: 1, pack_count: 0, resource_count: 0, changed_at: team.created_at }], get: async () => team, memberships: async () => [team], membershipsMany: async () => new Map([[member.id, [team]]]),
    members: async () => { restrictedReads++; return []; }, assignments: async () => { restrictedReads++; return { packs: [], resources: [] }; },
    create: async () => { writes.push('create'); return team; }, delete: async () => { writes.push('delete'); return deletion; },
    add: async () => { writes.push('add'); return { team: id, user: member, added_at: member.created_at, added_by: by.id }; },
    remove: async () => { writes.push('remove'); return true; },
  };
  const session: TeamCommandSession = {
    member: async () => by, admin: async () => { if (!admin) throw new Error('admin required'); return by; }, records: async () => ({ teams }), user: async () => member, out: line => out.push(line),
  };
  return { session, out, writes, restrictedReads: () => restrictedReads };
}

test('ordinary members see only their own team names and never request member or assignment details', async () => {
  const f = fixture(false);
  assert.equal(await teamCommand(f.session, ['list']), 0);
  assert.equal(await teamCommand(f.session, ['show', id]), 0);
  assert.deepEqual(f.out, [team.name, team.name]);
  assert.equal(f.restrictedReads(), 0);
  for (const args of [['create', team.name], ['delete', id], ['add', id, member.id], ['remove', id, member.id]]) await assert.rejects(teamCommand(f.session, args), /admin required/);
  assert.deepEqual(f.writes, []);
});

test('administrator team operations delegate to the records team service', async () => {
  const f = fixture(true);
  for (const args of [['create', team.name], ['add', id, member.name], ['remove', id, member.id], ['delete', id]]) assert.equal(await teamCommand(f.session, args), 0);
  assert.deepEqual(f.writes, ['create', 'add', 'remove', 'delete']);
  assert.equal(f.out.at(-1), `已删除团队 ${team.name}（${team.id}）；撤回工作流分配 2 条、资源分配 3 条`);
  assert.equal(f.restrictedReads(), 0);
});

test('assignment commands accept equals flags and reject conflicting personal, team and all targets before authentication', async () => {
  const reached = new Error('valid argv reached authentication');
  const unused = () => { throw new Error('must not access storage'); };
  const ctx: CliContext = { io: { stdout: () => {}, stderr: () => {}, env: {}, cwd: tmpdir() }, config: unused, records: async () => unused(), deps: async () => unused(), actingAdmin: async () => unused() };
  const session = new class extends Session { override admin(): Promise<Principal> { return Promise.reject(reached); } }(ctx, {});
  for (const args of [['assign', 'synthetic-workflow', '--team=' + id], ['unassign', 'synthetic-workflow', '--team=' + id], ['assign', member.name, 'synthetic-workflow']]) await assert.rejects(packCommand(session, args), error => error === reached);
  for (const args of [['assign', 'synthetic-resource', '--team=' + id], ['unassign', 'synthetic-resource', '--all']]) await assert.rejects(resourceCommand(session, args), error => error === reached);
  await assert.rejects(packCommand(session, ['assign', member.name, 'synthetic-workflow', '--team=' + id]), UsageError);
  await assert.rejects(resourceCommand(session, ['assign', 'synthetic-resource', '--team=' + id, '--all']), UsageError);
  await assert.rejects(resourceCommand(session, ['assign', 'synthetic-resource']), UsageError);
});
