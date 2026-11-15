import assert from 'node:assert/strict';
import { test } from 'node:test';
import { authenticateAccessOnly, CONSOLE_SESSION_REFUSED } from './access-auth.ts';
import type { Principal, Principals } from '../records/api.ts';

const admin: Principal = { id: 'usr_' + '0'.repeat(26), name: '合成', role: 'admin' };

test('authenticateAccessOnly refuses console sessions with the 无权限 sentence constant', async () => {
  assert.match(CONSOLE_SESSION_REFUSED, /^无权限：/);
  const principals = {
    authenticateAccessToken: async () => null,
    identify: async (authorization: string | null | undefined) =>
      authorization === 'Bearer console' ? { principal: admin, token_id: 'tok_c', client_id: null } : null,
    authenticate: async () => null,
  } as unknown as Principals;
  assert.deepEqual(await authenticateAccessOnly(principals, 'Bearer console'), { ok: false, reason: 'console_session' });
  assert.deepEqual(await authenticateAccessOnly(principals, 'Bearer missing'), { ok: false, reason: 'unauthenticated' });
  assert.deepEqual(await authenticateAccessOnly(principals, null), { ok: false, reason: 'unauthenticated' });
});

test('authenticateAccessOnly accepts an access token identity', async () => {
  const principals = {
    authenticateAccessToken: async (authorization: string | null | undefined) =>
      authorization === 'Bearer access' ? { principal: admin, token_id: 'tok_a', client_id: null } : null,
  } as unknown as Principals;
  assert.deepEqual(await authenticateAccessOnly(principals, 'Bearer access'), {
    ok: true,
    principal: admin,
    token_id: 'tok_a',
    client_id: null,
  });
});
