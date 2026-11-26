import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ExecutorRegistry } from '../dispatch/api.ts';
import { definition } from '../dispatch/testing/definition.ts';
import { ResourceAssignmentSubject } from '../../contracts/src/common.ts';
import type { Principal, RecordsKit } from '../records/api.ts';
import { executorCommand, type JobCommandSession } from './cli-job.ts';
import { buildCommandArgv } from './command-parameters.ts';
import { createCommandBridge } from './command-bridge.ts';
import { UsageError } from './errors.ts';

const executor = 'exe_' + '0'.repeat(26), team = 'tm_' + '0'.repeat(26), user = 'usr_' + '1'.repeat(26);
// Two teams share one name: the command line never prints a team number, so only the name can tell them apart and it must not guess.
const teams = [{ id: team, name: '合成团队' }, { id: 'tm_' + '2'.repeat(26), name: '重名团队' }, { id: 'tm_' + '3'.repeat(26), name: '重名团队' }];
const admin: Principal = { id: 'usr_' + '0'.repeat(26), name: '合成管理员', role: 'admin' };
function fixture() {
  const calls: unknown[][] = [], lines: string[] = [];
  const records = {
    teams: { list: async () => teams, get: async (_by: Principal, id: string) => teams.find(row => row.id === id) ?? null },
    principals: { get: async (id: string) => id === user ? { id, name: '合成成员' } : null, findByName: async (name: string) => name === '合成成员' ? { id: user, name } : null },
    authorizations: { assignResource: async (...args: unknown[]) => { ResourceAssignmentSubject.parse(args[2]); calls.push(['assign', ...args]); }, unassignResource: async (...args: unknown[]) => { ResourceAssignmentSubject.parse(args[2]); calls.push(['unassign', ...args]); } },
  } as unknown as RecordsKit;
  const session: JobCommandSession = { ctx: { io: { cwd: '/synthetic/commands' } }, options: {}, out: line => lines.push(line), err: line => lines.push(line), admin: async () => admin, records: async () => records, hub: async () => ({ records, dispatch: null, executorRegistry: new ExecutorRegistry(records) }) };
  return { session, calls, lines, records };
}

test('executor assignment and revocation use the existing resource API and exact executor identity', async t => {
  t.mock.method(ExecutorRegistry.prototype, 'readSource', async (id: string) => id === executor ? { id, digest: 'a'.repeat(64), source: definition('http://127.0.0.1/mcp') } : null);
  const f = fixture();
  for (const action of ['assign', 'unassign']) {
    assert.equal(await executorCommand(f.session, [action, executor, '--team=' + team]), 0);
    assert.equal(await executorCommand(f.session, [action, executor, '--team=合成团队']), 0, 'a team by the name the command line prints, which is the only way it shows one');
    assert.equal(await executorCommand(f.session, [action, executor, '--user=合成成员']), 0);
    assert.equal(await executorCommand(f.session, [action, executor, '--user=' + user]), 0);
  }
  assert.deepEqual(f.calls, [['assign', admin, executor, team], ['assign', admin, executor, team], ['assign', admin, executor, user], ['assign', admin, executor, user], ['unassign', admin, executor, team], ['unassign', admin, executor, team], ['unassign', admin, executor, user], ['unassign', admin, executor, user]]);
  assert.match(f.lines.join('\n'), /合成团队/); assert.match(f.lines.join('\n'), /合成成员/);
  assert.doesNotMatch(f.lines.join('\n'), /exe_|tm_|usr_|127\.0\.0\.1/);
});

test('executor assignments refuse missing or mixed audiences, other command flags and nonexistent resources', async t => {
  t.mock.method(ExecutorRegistry.prototype, 'readSource', async (id: string) => id === executor ? { id, digest: 'a'.repeat(64), source: definition('http://127.0.0.1/mcp') } : null);
  const f = fixture();
  for (const argv of [['assign', executor], ['assign', executor, '--team=' + team, '--user=' + user], ['assign', executor, '--team=' + team, '--reference=src:' + 'a'.repeat(64)], ['list', '--user=' + user], ['assign', executor, '--all']]) await assert.rejects(executorCommand(f.session, argv), UsageError);
  for (const argv of [['assign', 'missing', '--team=' + team], ['assign', executor, '--team=missing'], ['assign', executor, '--user=missing'], ['assign', executor, '--team=tm_' + '9'.repeat(26)]]) await assert.rejects(executorCommand(f.session, argv));
  await assert.rejects(executorCommand(f.session, ['assign', executor, '--team=没有这个团队']), (error: unknown) => error instanceof UsageError && error.message === '没有叫「没有这个团队」的团队；团队的名字用 circle-hub team list 查看');
  await assert.rejects(executorCommand(f.session, ['unassign', executor, '--team=重名团队']), (error: unknown) => error instanceof UsageError && /^有 2 个团队都叫「重名团队」；请在控制台的团队页里操作其中一个$/.test(error.message));
  assert.equal(f.calls.length, 0);
  f.session.admin = async () => { throw new Error('管理员已停用'); };
  await assert.rejects(executorCommand(f.session, ['assign', executor, '--team=' + team]), /管理员已停用/);
  assert.equal(f.calls.length, 0);
});

test('executor assignment fields generate exclusive team or account CLI calls through the command bridge', async () => {
  const bridge = createCommandBridge({ env: {}, cwd: '/synthetic/commands', main: async () => 0 });
  for (const id of ['executor.assign', 'executor.unassign'] as const) {
    for (const audience of [{ team }, { user: '合成成员' }]) {
      const argv = buildCommandArgv(id, { executor, ...audience });
      assert.equal((await bridge.run(argv, { token: 'synthetic-token' })).code, 0);
    }
    for (const audience of [{}, { team, user }, { all: true }, { team: 'missing' }]) assert.throws(() => buildCommandArgv(id, { executor, ...audience }), UsageError);
  }
});
