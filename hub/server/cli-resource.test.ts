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
    connectors: { admin: {
      addResource: async (by: Principal, input: unknown) => { calls.push(['add', by, input]); if (options.addError) throw options.addError; return record; },
      describe: async () => ({ credentials: [] }),
    } },
    records: {
      authorizations: { assignResource: async (...values: unknown[]) => { calls.push(['assign', ...values]); if (options.assignmentError) throw options.assignmentError; } },
      teams: { get: async (_by: Principal, id: string) => id === team ? { id: team, name: '合成团队' } : null },
    },
  };
  const session = new class extends Session {
    override async admin() { if (options.denied) throw new CliError('只有管理员可以接入资源'); return admin; }
    override async hub() { return hub as unknown as Awaited<ReturnType<Session['hub']>>; }
  }(ctx, {});
  return { session, out, calls };
}

test('resource add uses the created resource identity for explicit whole-Hub or team assignments', async () => {
  for (const [flag, subject] of [['--all', WHOLE_HUB], ['--team=' + team, team]]) {
    const f = fixture();
    assert.equal(await resourceCommand(f.session, [...args, flag]), 0);
    assert.deepEqual(f.calls.map(call => call[0]), ['add', 'assign']);
    assert.deepEqual(f.calls[1], ['assign', admin, record.id, subject]);
    assert.match(f.out[0], /已添加资源 synthetic-resource/);
    assert.match(f.out[1], subject === WHOLE_HUB ? /已分配给全体成员/ : /已分配给团队 合成团队/);
  }
});

test('resource add without an audience stays unassigned and discloses that nobody can use it', async () => {
  const f = fixture();
  assert.equal(await resourceCommand(f.session, args), 0);
  assert.deepEqual(f.calls.map(call => call[0]), ['add']);
  assert.match(f.out[1], /还没有分配，暂时谁都不能使用/);
});

test('resource add rejects conflicting or malformed targets and retains administrator permission before writes', async () => {
  for (const flags of [['--all', '--team=' + team], ['--team=team'], ['--team=not-a-team']]) {
    const f = fixture({ denied: true });
    await assert.rejects(resourceCommand(f.session, [...args, ...flags]), UsageError);
    assert.deepEqual(f.calls, []);
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
      assert.match(error.message, /资源 synthetic-resource 已添加，但分配未确认/);
      assert.match(error.message, /勿重复添加资源/);
      assert.doesNotMatch(error.message, /SYNTHETIC_PRIVATE_ERROR/);
      assert.equal(error.hint, assignmentError instanceof CliError ? '请核对团队' : null);
      return true;
    });
    assert.deepEqual(f.calls.map(call => call[0]), ['add', 'assign']);
    assert.equal(f.out.length, 1);
    assert.match(f.out[0], /已添加资源/);
  }
  const f = fixture({ addError: new CliError('接入失败') });
  await assert.rejects(resourceCommand(f.session, [...args, '--all']), /接入失败/);
  assert.deepEqual(f.calls.map(call => call[0]), ['add']);
  assert.deepEqual(f.out, []);
});
