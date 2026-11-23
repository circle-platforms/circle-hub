import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { test } from 'node:test';
import * as accessAuth from './access-auth.ts';
import type { Principal, Principals } from '../records/api.ts';

const { authenticateAccessOnly, CONSOLE_SESSION_REFUSED } = accessAuth;
const admin: Principal = { id: 'usr_' + '0'.repeat(26), name: '合成', role: 'admin' };

function fakePair(authorization?: string) {
  const req = Object.assign(new EventEmitter(), {
    headers: authorization ? { authorization } : {},
    resume() {},
  }) as unknown as IncomingMessage;
  let status = 0;
  let body = '';
  const res = {
    setHeader() {},
    writeHead(code: number) {
      status = code;
    },
    end(chunk?: string | Buffer) {
      body = chunk ? String(chunk) : '';
    },
  } as unknown as ServerResponse;
  return {
    req,
    res,
    result: () => ({ status, json: body ? JSON.parse(body) : null }),
  };
}

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

test('requireDirectAccessBearer accepts direct member tokens and rejects OAuth client tokens with 403 BOT_CLIENT_FORBIDDEN', async () => {
  const requireDirectAccessBearer = (
    accessAuth as unknown as {
      requireDirectAccessBearer?: (
        req: IncomingMessage,
        res: ServerResponse,
        principals: Principals,
      ) => Promise<Principal | null>;
    }
  ).requireDirectAccessBearer;
  assert.equal(typeof requireDirectAccessBearer, 'function');

  const principals = {
    authenticateAccessToken: async (authorization: string | null | undefined) => {
      if (authorization === 'Bearer direct') return { principal: admin, token_id: 'tok_d', client_id: null };
      if (authorization === 'Bearer oauth') return { principal: admin, token_id: 'tok_o', client_id: 'cli_oauth_1' };
      return null;
    },
    identify: async (authorization: string | null | undefined) =>
      authorization === 'Bearer console' ? { principal: admin, token_id: 'tok_c', client_id: null } : null,
  } as unknown as Principals;

  const direct = fakePair('Bearer direct');
  assert.deepEqual(await requireDirectAccessBearer!(direct.req, direct.res, principals), admin);

  const oauth = fakePair('Bearer oauth');
  assert.equal(await requireDirectAccessBearer!(oauth.req, oauth.res, principals), null);
  assert.equal(oauth.result().status, 403);
  assert.equal(oauth.result().json.code, 'BOT_CLIENT_FORBIDDEN');

  const consoleTok = fakePair('Bearer console');
  assert.equal(await requireDirectAccessBearer!(consoleTok.req, consoleTok.res, principals), null);
  assert.equal(consoleTok.result().status, 403);
  assert.equal(consoleTok.result().json.code, 'BOT_CLIENT_FORBIDDEN');

  const missing = fakePair();
  assert.equal(await requireDirectAccessBearer!(missing.req, missing.res, principals), null);
  assert.equal(missing.result().status, 401);
  assert.equal(missing.result().json.code, 'BOT_CLIENT_FORBIDDEN');
});
