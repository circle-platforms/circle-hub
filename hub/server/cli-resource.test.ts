import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { ENVIRONMENT } from '../../contracts/generated/vocabulary.ts';
import { WHOLE_HUB, type Principal } from '../records/api.ts';
import type { CliContext } from './api.ts';
import { resourceCommand } from './cli-resource.ts';
import { Session } from './cli-session.ts';
import { CliError, UsageError } from './errors.ts';

const team = 'tm_0123456789abcdefghjkmnpqrs';
const admin: Principal = { id: 'usr_0123456789abcdefghjkmnpqrs', name: '合成管理员', role: 'admin' };
const record = { id: 'synthetic-resource', name: '合成资源', system_pack: 'synthetic-system', environment: ENVIRONMENT[0] };
const args = ['add', record.system_pack, '--name=' + record.name, '--environment=' + record.environment, '--origin=api=https://192.0.2.1'];
function fixture(options: { denied?: boolean; addError?: Error; assignmentError?: Error } = {}) {
  const out: string[] = [], calls: unknown[][] = [];
  const unused = () => { throw new Error('must not access storage'); };
  const ctx: CliContext = { io: { stdout: line => out.push(line), stderr: unused, env: {}, cwd: tmpdir() }, config: unused, records: async () => unused(), deps: async () => unused(), actingAdmin: async () => unused() };
  const hub = {
    resources: { list: async () => [record] },
    connectors: { admin: {
      addResource: async (by: Principal, input: unknown) => { calls.push(['add', by, input]); if (options.addError) throw options.addError; return record; },
      describe: async () => ({ credentials: [] }),
    } },
    records: {
      authorizations: {
        assignResource: async (...values: unknown[]) => { calls.push(['assign', ...values]); if (options.assignmentError) throw options.assignmentError; },
        unassignResource: async (...values: unknown[]) => { calls.push(['unassign', ...values]); },
      },
      teams: { get: async (_by: Principal, id: string) => id === team ? { id: team, name: '合成团队' } : null, list: async () => [{ id: team, name: '合成团队' }] },
    },
  };
  const session = new class extends Session {
    override async admin() { if (options.denied) throw new CliError('只有管理员可以接入资源'); return admin; }
    override async hub() { return hub as unknown as Awaited<ReturnType<Session['hub']>>; }
  }(ctx, {});
  return { session, out, calls };
}

test('resource add uses the created resource identity for explicit whole-Hub or team assignments', async () => {
  for (const [flag, subject] of [['--all', WHOLE_HUB], ['--team=' + team, team], ['--team=合成团队', team]]) {
    const f = fixture();
    assert.equal(await resourceCommand(f.session, [...args, flag]), 0);
    assert.deepEqual(f.calls.map(call => call[0]), ['add', 'assign']);
    assert.deepEqual(f.calls[1], ['assign', admin, record.id, subject]);
    assert.match(f.out[0], /已添加资源 合成资源/);
    assert.doesNotMatch(f.out.join('\n'), /synthetic-resource|res_/);
    assert.match(f.out[1], subject === WHOLE_HUB ? /已分配给全体成员/ : /已分配给团队 合成团队/);
  }
});

test('resource assign and unassign name a team by its name or its number, and the answers name the resource and the team without ids', async () => {
  for (const [flag, subject, whom] of [['--team=合成团队', team, '团队 合成团队'], ['--team=' + team, team, '团队 合成团队'], ['--all', WHOLE_HUB, '全体成员']]) {
    const f = fixture();
    assert.equal(await resourceCommand(f.session, ['assign', record.id, flag]), 0);
    assert.equal(await resourceCommand(f.session, ['unassign', record.id, flag, '--note=合成备注']), 0);
    assert.deepEqual(f.calls, [['assign', admin, record.id, subject, { note: undefined }], ['unassign', admin, record.id, subject, '合成备注']], flag);
    assert.deepEqual(f.out, [`资源 合成资源 已分配给${whom}`, `已撤回资源 合成资源 给${whom}的分配`], flag);
    assert.doesNotMatch(f.out.join('\n'), /synthetic-resource|res_|tm_/);
  }
  // A name no team has is refused in the words every command that takes a team uses, and a resource that is not listed is the neutral one; nothing is written.
  const f = fixture();
  for (const sub of ['assign', 'unassign']) await assert.rejects(resourceCommand(f.session, [sub, record.id, '--team=没有的团队']), (error: unknown) => error instanceof UsageError && error.message === '没有叫「没有的团队」的团队；团队的名字用 circle-hub team list 查看');
  await assert.rejects(resourceCommand(f.session, ['assign', 'no-such-resource', '--team=合成团队']), (error: unknown) => error instanceof CliError && error.message === '资源不可用');
  assert.deepEqual([f.calls, f.out], [[], []]);
  // The team is looked up only for an administrator.
  const denied = fixture({ denied: true });
  for (const sub of ['assign', 'unassign']) await assert.rejects(resourceCommand(denied.session, [sub, record.id, '--team=合成团队']), /只有管理员/);
  assert.deepEqual(denied.calls, []);
});

test('resource add without an audience stays unassigned and discloses that nobody can use it', async () => {
  const f = fixture();
  assert.equal(await resourceCommand(f.session, args), 0);
  assert.deepEqual(f.calls.map(call => call[0]), ['add']);
  assert.match(f.out[0], /已添加资源 合成资源/);
  assert.doesNotMatch(f.out.join('\n'), /synthetic-resource|res_/);
  assert.match(f.out[1], /还没有分配，暂时谁都不能使用/);
});

test('resource add rejects conflicting or malformed targets and retains administrator permission before writes', async () => {
  {
    const f = fixture({ denied: true });
    await assert.rejects(resourceCommand(f.session, [...args, '--all', '--team=' + team]), UsageError);
    assert.deepEqual(f.calls, []);
  }
  // A team is named by its number or its name, so a value that is no number is looked up, which only an administrator may do
  for (const flag of ['--team=team', '--team=not-a-team']) {
    const denied = fixture({ denied: true });
    await assert.rejects(resourceCommand(denied.session, [...args, flag]), /只有管理员/);
    assert.deepEqual(denied.calls, []);
    const unknown = fixture();
    await assert.rejects(resourceCommand(unknown.session, [...args, flag]), (error: unknown) => error instanceof UsageError && /没有叫「(team|not-a-team)」的团队/.test(error.message));
    assert.deepEqual(unknown.calls, [], 'nothing is added for a team that does not exist');
  }
  const f = fixture({ denied: true });
  await assert.rejects(resourceCommand(f.session, [...args, '--all']), /只有管理员/);
  assert.deepEqual(f.calls, []);
});

test('resource add reports the committed creation when assignment fails without claiming success or exposing raw errors', async () => {
  for (const assignmentError of [new CliError('团队不可用', '请核对团队'), new Error('SYNTHETIC_PRIVATE_ERROR')]) {
    const f = fixture({ assignmentError });
    await assert.rejects(resourceCommand(f.session, [...args, '--team=' + team]), error => {
      assert.ok(error instanceof CliError);
      assert.match(error.message, /资源 合成资源 已添加，但分配未确认/);
      assert.match(error.message, /勿重复添加资源/);
      assert.doesNotMatch(error.message, /SYNTHETIC_PRIVATE_ERROR|synthetic-resource|res_/);
      assert.equal(error.hint, assignmentError instanceof CliError ? '请核对团队' : null);
      return true;
    });
    assert.deepEqual(f.calls.map(call => call[0]), ['add', 'assign']);
    assert.equal(f.out.length, 1);
    assert.match(f.out[0], /已添加资源 合成资源/);
    assert.doesNotMatch(f.out[0], /synthetic-resource|res_/);
  }
  const f = fixture({ addError: new CliError('接入失败') });
  await assert.rejects(resourceCommand(f.session, [...args, '--all']), /接入失败/);
  assert.deepEqual(f.calls.map(call => call[0]), ['add']);
  assert.deepEqual(f.out, []);
});

test('resource list, update and show print names without internal ids', async () => {
  const out: string[] = [], listing = {
    id: 'res_0123456789abcdefghjkmnpqrs', name: '合成资源', system_pack: 'synthetic-system@1.0.0',
    environment: ENVIRONMENT[0], enabled: false, origins: { api: 'https://192.0.2.1' }, allow_plaintext: [] as string[],
  };
  const unused = () => { throw new Error('must not access storage'); };
  const ctx: CliContext = { io: { stdout: line => out.push(line), stderr: unused, env: {}, cwd: tmpdir() }, config: unused, records: async () => unused(), deps: async () => unused(), actingAdmin: async () => unused() };
  const described = { ...listing, credentials: [] as { name: string; entry: string; set: boolean; digest: string }[] };
  const hub = {
    resources: { list: async () => [listing] },
    connectors: { admin: {
      describe: async () => described,
      updateResource: async () => ({ ...listing, name: '乙' }),
    } },
    records: {
      authorizations: {
        resourceConfig: async () => ({ body: { bound: 'a'.repeat(64) } }),
        history: async () => ({ items: [], next: null }),
      },
      objects: { get: async () => Buffer.from(JSON.stringify({ settings: {} })) },
      variables: { list: async () => [] },
    },
  };
  const session = new class extends Session {
    override async admin() { return admin; }
    override async viewer() { return admin; }
    override async hub() { return hub as unknown as Awaited<ReturnType<Session['hub']>>; }
    override async records() { return hub.records as unknown as Awaited<ReturnType<Session['records']>>; }
  }(ctx, {});
  assert.equal(await resourceCommand(session, ['list']), 0);
  assert.deepEqual(out, ['合成资源\tsynthetic-system@1.0.0\t测试\t停用\tapi=https://192.0.2.1']);
  assert.doesNotMatch(out.join('\n'), /res_/);
  out.length = 0;
  assert.equal(await resourceCommand(session, ['update', listing.id, '--name', '乙']), 0);
  assert.match(out[0], /已更新资源 乙（业务系统接入 synthetic-system@1\.0\.0，环境 测试）/);
  assert.doesNotMatch(out.join('\n'), /res_/);
  out.length = 0;
  assert.equal(await resourceCommand(session, ['show', listing.id]), 0);
  assert.equal(out[0], '合成资源 synthetic-system@1.0.0');
  assert.doesNotMatch(out.join('\n'), /res_/);
});
