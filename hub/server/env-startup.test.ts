// Scripted lifecycle ports only: no PostgreSQL, service listener, token file or personal environment.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_LIMITS, type HubConfig } from '../config/index.ts';
import type { Principal, RecordsKit, Transaction } from '../records/api.ts';
import { memoryOperatorTokens } from './assemble/operator-token.ts';
import { environmentStartupAuthority, prepareEnvironmentPermissionStartup, readEnvironmentPermissionStartup, recordsEnvironmentPermissionStartup, type EnvironmentPermissionStartupPort } from './env-startup.ts';

const admin: Principal = { id: 'usr_' + '0'.repeat(26), name: '合成管理员', role: 'admin' };
const member: Principal = { ...admin, name: '合成成员', role: 'user' };
function fixture(completed: boolean | null = false) {
  const calls: string[] = [];
  const state = { completed };
  const port: EnvironmentPermissionStartupPort = {
    read: async () => { calls.push('read'); return { completed: state.completed }; },
    convert: async actor => { assert.deepEqual(actor, admin); calls.push('convert'); state.completed = true; },
  };
  const authority = { readToken: async () => { calls.push('token'); return 'synthetic-token'; }, authenticate: async (authorization: string) => { assert.equal(authorization, 'Bearer synthetic-token'); calls.push('authenticate'); return admin; } };
  return { calls, state, port, authority };
}

test('confirmed absence uses only the authenticated delegate for the atomic conversion and rereads completion', async () => {
  const f = fixture();
  assert.deepEqual(await prepareEnvironmentPermissionStartup(f.port, f.authority), { completed: true, enforced: true, missing: null, nextAction: null });
  assert.deepEqual(f.calls, ['read', 'token', 'authenticate', 'convert', 'read']);
});

test('durable completion does not read the operator token or repeat conversion after a later revocation', async () => {
  const f = fixture(true);
  assert.equal((await prepareEnvironmentPermissionStartup(f.port, f.authority)).completed, true);
  assert.deepEqual(f.calls, ['read']);
});

for (const [name, actor] of [['revoked or disabled token', null], ['ordinary member token', member]] as const) {
  test(name + ' leaves verified absence pending without selecting another administrator', async () => {
    const f = fixture();
    const result = await prepareEnvironmentPermissionStartup(f.port, { ...f.authority, authenticate: async () => actor });
    assert.equal(result.completed, false); assert.equal(result.enforced, false);
    assert.match(result.missing!, /仍按原工作流和预订规则/);
    assert.equal(f.calls.includes('convert'), false);
  });
}

test('a missing stored delegation leaves the service pending under legacy rules', async () => {
  const f = fixture();
  const result = await prepareEnvironmentPermissionStartup(f.port, { ...f.authority, readToken: async () => null });
  assert.equal(result.completed, false); assert.equal(result.enforced, false);
  assert.deepEqual(f.calls, ['read', 'read']);
});

test('unreadable operator storage never exposes its exception or treats it as completion', async () => {
  const f = fixture();
  const result = await prepareEnvironmentPermissionStartup(f.port, { ...f.authority, readToken: async () => { throw new Error('synthetic-token private-path'); } });
  assert.equal(result.completed, false); assert.equal(result.enforced, false);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-token|private-path/);
  assert.equal(f.calls.includes('convert'), false);
});

test('a broken or historically removed completion is unavailable, never first-time or legacy fallback', async () => {
  const f = fixture(null);
  const result = await prepareEnvironmentPermissionStartup(f.port, f.authority);
  assert.equal(result.completed, null); assert.equal(result.enforced, true);
  assert.match(result.missing!, /不能重做继承或退回旧权限/);
  assert.deepEqual(f.calls, ['read']);
});

test('a failed completion read neither consults delegation nor writes and does not expose raw storage details', async () => {
  const f = fixture();
  f.port.read = async () => { throw new Error('synthetic-token private-storage'); };
  const result = await prepareEnvironmentPermissionStartup(f.port, f.authority);
  assert.equal(result.completed, null); assert.equal(result.enforced, true);
  assert.deepEqual(f.calls, []);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-token|private-storage/);
});

test('an uncertain writer response is resolved by durable completion, not by retrying or assuming rollback', async () => {
  const f = fixture();
  f.port.convert = async () => { f.calls.push('convert'); f.state.completed = true; throw new Error('lost commit response'); };
  assert.equal((await prepareEnvironmentPermissionStartup(f.port, f.authority)).completed, true);
  assert.equal(f.calls.filter(call => call === 'convert').length, 1);
});

test('a rejected conversion may retain legacy rules only after verified absence is reread', async () => {
  const f = fixture();
  f.port.convert = async () => { f.calls.push('convert'); throw new Error('authority revoked inside the transaction'); };
  const result = await prepareEnvironmentPermissionStartup(f.port, f.authority);
  assert.equal(result.completed, false); assert.equal(result.enforced, false);
  assert.equal(f.calls.at(-1), 'read');
});

test('a conversion followed by an unreadable receipt cannot fall back to legacy rules or repeat grants', async () => {
  const f = fixture();
  f.port.convert = async () => { f.calls.push('convert'); f.port.read = async () => { throw new Error('unreadable receipt'); }; };
  const result = await prepareEnvironmentPermissionStartup(f.port, f.authority);
  assert.equal(result.completed, null); assert.equal(result.enforced, true);
  assert.equal(f.calls.filter(call => call === 'convert').length, 1);
});

test('malformed observations are not absence', async () => {
  const result = await readEnvironmentPermissionStartup({ read: async () => ({}) as { completed: boolean | null } });
  assert.equal(result.completed, null); assert.equal(result.enforced, true);
});

test('the product-store adapter uses memory injection and ignores an environment token', async () => {
  const config = { dataDir: '/synthetic-unused-root', logDir: '/synthetic-unused-root/logs', host: '127.0.0.1', port: 0, database: { host: '127.0.0.1', port: 1, database: 'synthetic', user: 'synthetic' }, limits: DEFAULT_LIMITS } satisfies HubConfig;
  const store = memoryOperatorTokens('synthetic-stored');
  const calls: string[] = [];
  const authority = environmentStartupAuthority(config, { CIRCLE_HUB_TOKEN: 'synthetic-environment' }, {
    authenticate: async (authorization: string) => { calls.push(authorization); return admin; },
  }, current => { assert.equal(current, config); return store; });
  assert.equal(await authority.readToken(), 'synthetic-stored');
  assert.deepEqual(await authority.authenticate('Bearer synthetic-stored'), admin);
  assert.deepEqual(calls, ['Bearer synthetic-stored']);
});

test('the public records adapter forwards the exact admission transaction when rereading completion', async () => {
  const tx: Transaction = { transactionId: 17 };
  const records = { testEnvironments: { inheritance: async (current?: Transaction) => {
    assert.equal(current, tx); return { completed: null, record: null, missingFacts: ['合成不可核对'] };
  } } } as unknown as RecordsKit;
  assert.equal((await recordsEnvironmentPermissionStartup(records).read(tx)).completed, null);
});

test('the public records adapter passes the actual actor and the signed source collector to the atomic writer', async () => {
  let calls = 0;
  const records = { testEnvironments: { inherit: async (actor: Principal, sources: { collect: unknown }) => {
    calls++; assert.equal(actor, admin); assert.equal(typeof sources.collect, 'function');
    return { completed: true, record: 'a'.repeat(64), assignments: 0 };
  } } } as unknown as RecordsKit;
  await recordsEnvironmentPermissionStartup(records).convert(admin);
  assert.equal(calls, 1);
});
