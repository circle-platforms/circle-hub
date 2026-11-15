// Real M1 records, Bearer authentication and serve/assembly; conversion facts are scripted until the records writer lands.
import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { openRecords, type Principal } from '../records/api.ts';
import { assembleHub } from './assemble/hub.ts';
import { memoryOperatorTokens } from './assemble/operator-token.ts';
import { openCliHarness, type CliHarness } from './assemble/test-cli.ts';
import { loadServerConfig } from './main.ts';
import type { EnvironmentPermissionStartup, EnvironmentPermissionStartupPort } from './env-startup.ts';

let harness: CliHarness;
before(async () => { harness = await openCliHarness(); });
after(async () => { await harness?.close(); });

async function scenario(input: { completed: boolean | null; token: 'admin' | 'member' | 'missing' | 'revoked' | 'disabled'; unreadable?: boolean; commitResponseLost?: boolean; afterAssembly?: boolean | null }) {
  const deployment = await harness.deployment();
  const config = loadServerConfig(deployment.env);
  const kit = await openRecords(config, { migrate: false, keyProvider: deployment.key });
  let admin: Principal, member: Principal, stored: string | null = null;
  try {
    const first = (await kit.principals.bootstrapAdmin('合成启动管理员')).user;
    admin = { id: first.id, name: first.name, role: first.role };
    const user = await kit.principals.createUser(admin, '合成已有成员');
    member = { id: user.id, name: user.name, role: user.role };
    await kit.principals.createUser(admin, '合成另一管理员', 'admin');
    if (input.token !== 'missing') {
      const issued = await kit.principals.issueToken(admin, input.token === 'member' ? member.id : admin.id, '合成产品操作委托');
      stored = issued.token;
      if (input.token === 'revoked') await kit.principals.revokeToken(admin, issued.id);
      if (input.token === 'disabled') await kit.principals.setDisabled(admin, admin.id, true);
    }
  } finally { await kit.close(); }
  let completed = input.completed, conversions = 0, tokenReads = 0, listens = 0;
  const port: EnvironmentPermissionStartupPort = {
    read: async () => { if (input.unreadable) throw new Error('synthetic private-marker-detail'); return { completed }; },
    convert: async actor => {
      conversions++;
      assert.deepEqual(actor, admin, 'the actual stored Bearer determines the actor, never another enabled administrator');
      completed = true;
      if (input.commitResponseLost) throw new Error('synthetic uncertain commit response');
    },
  };
  const store = memoryOperatorTokens(stored);
  const stopped = Promise.withResolvers<void>();
  let observed: EnvironmentPermissionStartup | undefined;
  const result = await deployment.run(['serve'], {
    environmentPermissions: () => port,
    operatorTokens: () => ({ ...store, read: async () => { tokenReads++; return store.read(); } }),
    assembly: async () => ({ assemble: async (current, records, startup?: EnvironmentPermissionStartup) => {
      assert.ok(startup, 'main must observe conversion before ordinary business assembly');
      const hub = await assembleHub(current, records, { requireOsIsolation: false, log: () => {}, environmentPermissionStartup: startup, environmentPermissions: port });
      try {
        observed = await hub.deps.environmentPermissionStartup!();
        assert.equal(hub.dispatch?.options.enforceEnvironmentAssignments, startup.completed !== false);
        const view = await hub.deps.memberCapabilities(member);
        assert.equal(view.environmentAccess.enforced, startup.completed !== false);
        if (startup.completed === null) {
          assert.equal(view.environmentAccess.ready, false);
          assert.equal((await hub.dispatch!.options.environmentAccess!.inheritance()).completed, null, 'unverified completion reaches the dynamic provider rather than permitting use through an already-present grant');
        }
        assert.equal(hub.deps.rebuildNeeded, undefined, 'a conversion wait is not schema incompatibility');
        if (input.afterAssembly !== undefined) {
          completed = input.afterAssembly;
          const current = await hub.deps.environmentPermissionStartup!();
          assert.equal(current.completed, completed, 'ordinary management rereads completion after another process acts');
          const refreshed = await hub.deps.memberCapabilities(member);
          assert.equal(refreshed.environmentAccess.enforced, completed !== false);
          if (completed === null) assert.equal(refreshed.environmentAccess.ready, false);
          observed = current;
        }
        return hub.deps;
      } catch (error) { await hub.deps.close?.(); throw error; }
    } }),
    onListening: () => { listens++; stopped.resolve(); },
    stopSignal: () => stopped.promise,
  });
  assert.equal(result.code, 0, result.text);
  assert.equal(listens, 1, 'ordinary management and the service still listen');
  assert.ok(observed);
  assert.doesNotMatch(JSON.stringify(observed) + result.text, /synthetic private-marker-detail|synthetic uncertain commit response/);
  if (stored !== null) assert.equal((JSON.stringify(observed) + result.text).includes(stored), false);
  return { observed, conversions, tokenReads, result };
}

test('missing product delegation keeps verified absence pending and starts ordinary management', async () => {
  const result = await scenario({ completed: false, token: 'missing' });
  assert.equal(result.observed.completed, false); assert.equal(result.observed.enforced, false);
  assert.equal(result.conversions, 0); assert.equal(result.tokenReads, 1);
});
for (const token of ['revoked', 'disabled', 'member'] as const) test(token + ' stored delegation cannot convert or fall back to another administrator', async () => {
  const result = await scenario({ completed: false, token });
  assert.equal(result.observed.completed, false); assert.equal(result.observed.enforced, false);
  assert.equal(result.conversions, 0);
});
test('an authenticated enabled product administrator converts before business assembly and the same fact drives N1 and dispatch', async () => {
  const result = await scenario({ completed: false, token: 'admin' });
  assert.equal(result.observed.completed, true); assert.equal(result.conversions, 1); assert.equal(result.tokenReads, 1);
});
test('completed inheritance starts without consulting a now-revoked operator token', async () => {
  const result = await scenario({ completed: true, token: 'revoked' });
  assert.equal(result.observed.completed, true); assert.equal(result.conversions, 0); assert.equal(result.tokenReads, 0);
});
test('a broken completion keeps ordinary management alive without legacy fallback or repeated grants', async () => {
  const result = await scenario({ completed: null, token: 'admin' });
  assert.equal(result.observed.completed, null); assert.equal(result.observed.enforced, true);
  assert.equal(result.conversions, 0); assert.equal(result.tokenReads, 0);
});
test('unreadable completion is not first-time absence and still allows the ordinary service to listen', async () => {
  const result = await scenario({ completed: false, token: 'admin', unreadable: true });
  assert.equal(result.observed.completed, null); assert.equal(result.observed.enforced, true);
  assert.equal(result.conversions, 0); assert.equal(result.tokenReads, 0);
});
test('a lost writer response rereads durable completion without repeating the approved action', async () => {
  const result = await scenario({ completed: false, token: 'admin', commitResponseLost: true });
  assert.equal(result.observed.completed, true); assert.equal(result.conversions, 1);
});
test('serve still rejects an environment token before reading stored delegation or conversion facts', async () => {
  const deployment = await harness.deployment();
  let calls = 0;
  const result = await deployment.run(['serve'], {
    environmentPermissions: () => { calls++; throw new Error('must not reach conversion'); },
    operatorTokens: () => { calls++; throw new Error('must not read product token'); },
  }, { CIRCLE_HUB_TOKEN: 'synthetic-environment-token' });
  assert.equal(result.code, 1); assert.equal(calls, 0);
  assert.equal(result.text.includes('synthetic-environment-token'), false);
});

test('ordinary status and N1 refresh after another process completes without reading delegation or converting again', async () => {
  const result = await scenario({ completed: false, token: 'missing', afterAssembly: true });
  assert.equal(result.observed.completed, true); assert.equal(result.observed.enforced, true);
  assert.equal(result.conversions, 0); assert.equal(result.tokenReads, 1);
});
test('a previously completed marker becoming unreadable is shown unavailable without legacy fallback', async () => {
  const result = await scenario({ completed: true, token: 'admin', afterAssembly: null });
  assert.equal(result.observed.completed, null); assert.equal(result.observed.enforced, true);
  assert.equal(result.conversions, 0); assert.equal(result.tokenReads, 0);
});
