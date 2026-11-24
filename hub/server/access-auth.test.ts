import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { test } from 'node:test';
import * as accessAuth from './access-auth.ts';
import type { Principal, Principals } from '../records/api.ts';

const { authenticateAccessOnly, BOT_INSUFFICIENT_SCOPE_HEADER, canAccessBot, CONSOLE_SESSION_REFUSED } = accessAuth;
const admin: Principal = { id: 'usr_' + '0'.repeat(26), name: '合成', role: 'admin' };

function fakePair(authorization?: string) {
  const req = Object.assign(new EventEmitter(), {
    headers: authorization ? { authorization } : {},
    resume() {},
  }) as unknown as IncomingMessage;
  let status = 0;
  let body = '';
  const headers: Record<string, string> = {};
  const recordHeader = (name: string, value: unknown) => {
    headers[name.toLowerCase()] = Array.isArray(value) ? value.map(String).join(', ') : String(value);
  };
  const res = {
    setHeader(name: string, value: unknown) {
      recordHeader(name, value);
    },
    writeHead(code: number, maybeHeaders?: Record<string, unknown> | string, thirdHeaders?: Record<string, unknown>) {
      status = code;
      const map = typeof maybeHeaders === 'object' && maybeHeaders !== null ? maybeHeaders : thirdHeaders;
      if (map) for (const [name, value] of Object.entries(map)) recordHeader(name, value);
    },
    end(chunk?: string | Buffer) {
      body = chunk ? String(chunk) : '';
    },
  } as unknown as ServerResponse;
  return {
    req,
    res,
    result: () => ({ status, headers, json: body ? JSON.parse(body) : null }),
  };
}

test('authenticateAccessOnly refuses console sessions with the 无权限 sentence constant', async () => {
  assert.match(CONSOLE_SESSION_REFUSED, /^无权限：/);
  const principals = {
    authenticateAccessToken: async () => null,
    identify: async (authorization: string | null | undefined) =>
      authorization === 'Bearer console' ? { principal: admin, token_id: 'tok_c', client_id: null, scope: [] } : null,
    authenticate: async () => null,
  } as unknown as Principals;
  assert.deepEqual(await authenticateAccessOnly(principals, 'Bearer console'), { ok: false, reason: 'console_session' });
  assert.deepEqual(await authenticateAccessOnly(principals, 'Bearer missing'), { ok: false, reason: 'unauthenticated' });
  assert.deepEqual(await authenticateAccessOnly(principals, null), { ok: false, reason: 'unauthenticated' });
});

test('authenticateAccessOnly accepts an access token identity', async () => {
  const principals = {
    authenticateAccessToken: async (authorization: string | null | undefined) =>
      authorization === 'Bearer access' ? { principal: admin, token_id: 'tok_a', client_id: null, scope: [] } : null,
  } as unknown as Principals;
  assert.deepEqual(await authenticateAccessOnly(principals, 'Bearer access'), {
    ok: true,
    principal: admin,
    token_id: 'tok_a',
    client_id: null,
    scope: [],
  });
});

test('requireAccessBearer is removed and requireDirectAccessBearer accepts direct and bot-scoped tokens while returning BOT_UNAUTHENTICATED on 401 and BOT_CLIENT_FORBIDDEN on 403', async () => {
  assert.equal('requireAccessBearer' in accessAuth, false);
  const { requireDirectAccessBearer, botError } = accessAuth;
  assert.equal(typeof requireDirectAccessBearer, 'function');
  assert.equal(typeof botError, 'function');

  assert.equal(canAccessBot({ client_id: null, scope: [] }), true);
  assert.equal(canAccessBot({ client_id: 'cli_oauth_1', scope: ['bot'] }), true);
  assert.equal(canAccessBot({ client_id: 'cli_oauth_1', scope: [] }), false);

  const principals = {
    authenticateAccessToken: async (authorization: string | null | undefined) => {
      if (authorization === 'Bearer direct') return { principal: admin, token_id: 'tok_d', client_id: null, scope: [] };
      if (authorization === 'Bearer oauth') return { principal: admin, token_id: 'tok_o', client_id: 'cli_oauth_1', scope: [] };
      if (authorization === 'Bearer oauth-bot') return { principal: admin, token_id: 'tok_ob', client_id: 'cli_oauth_1', scope: ['bot'] };
      return null;
    },
    identify: async (authorization: string | null | undefined) =>
      authorization === 'Bearer console' ? { principal: admin, token_id: 'tok_c', client_id: null, scope: [] } : null,
  } as unknown as Principals;

  let gateEnabled = true;
  const botGate: accessAuth.BotGate = {
    enabled: async () => gateEnabled,
    disabledBody: () => botError('BOT_DISABLED', '机器人模型尚未启用', '请管理员在控制台配置并启用机器人模型后重试'),
  };

  const direct = fakePair('Bearer direct');
  assert.deepEqual(await requireDirectAccessBearer(direct.req, direct.res, principals, botGate), admin);

  const oauthBot = fakePair('Bearer oauth-bot');
  assert.deepEqual(await requireDirectAccessBearer(oauthBot.req, oauthBot.res, principals, botGate), admin);

  const oauth = fakePair('Bearer oauth');
  assert.equal(await requireDirectAccessBearer(oauth.req, oauth.res, principals, botGate), null);
  assert.equal(oauth.result().status, 403);
  assert.equal(oauth.result().headers['www-authenticate'], BOT_INSUFFICIENT_SCOPE_HEADER);
  assert.equal(BOT_INSUFFICIENT_SCOPE_HEADER, 'Bearer error="insufficient_scope", scope="bot"');
  assert.equal(oauth.result().json.code, 'BOT_CLIENT_FORBIDDEN');
  assert.match(oauth.result().json.message, /^无权限：/);
  assert.match(oauth.result().json.message, /允许这个客户端使用我的机器人/);
  assert.ok(!String(oauth.result().json.message).includes('个人助手'));
  assert.ok(String(oauth.result().json.message).includes('机器人'));

  const consoleTok = fakePair('Bearer console');
  assert.equal(await requireDirectAccessBearer(consoleTok.req, consoleTok.res, principals, botGate), null);
  assert.equal(consoleTok.result().status, 403);
  assert.equal(consoleTok.result().headers['www-authenticate'], undefined);
  assert.equal(consoleTok.result().json.code, 'BOT_CLIENT_FORBIDDEN');
  assert.equal(consoleTok.result().json.message, CONSOLE_SESSION_REFUSED);

  const missing = fakePair();
  assert.equal(await requireDirectAccessBearer(missing.req, missing.res, principals, botGate), null);
  assert.equal(missing.result().status, 401);
  assert.equal(missing.result().json.code, 'BOT_UNAUTHENTICATED');
  assert.match(missing.result().json.message, /^无权限：/);
  assert.ok(!String(missing.result().json.message).includes('个人助手'));

  gateEnabled = false;

  const disabledDirect = fakePair('Bearer direct');
  assert.deepEqual(await requireDirectAccessBearer(disabledDirect.req, disabledDirect.res, principals, botGate), admin);

  const disabledOAuthBot = fakePair('Bearer oauth-bot');
  assert.deepEqual(await requireDirectAccessBearer(disabledOAuthBot.req, disabledOAuthBot.res, principals, botGate), admin);

  const disabledConsole = fakePair('Bearer console');
  assert.equal(await requireDirectAccessBearer(disabledConsole.req, disabledConsole.res, principals, botGate), null);
  assert.equal(disabledConsole.result().status, 403);
  assert.equal(disabledConsole.result().headers['www-authenticate'], undefined);
  assert.equal(disabledConsole.result().json.code, 'BOT_CLIENT_FORBIDDEN');
  assert.equal(disabledConsole.result().json.message, CONSOLE_SESSION_REFUSED);

  const disabledMissing = fakePair();
  assert.equal(await requireDirectAccessBearer(disabledMissing.req, disabledMissing.res, principals, botGate), null);
  assert.equal(disabledMissing.result().status, 401);
  assert.equal(disabledMissing.result().headers['www-authenticate'], 'Bearer');
  assert.equal(disabledMissing.result().json.code, 'BOT_UNAUTHENTICATED');

  const disabledOAuth = fakePair('Bearer oauth');
  assert.equal(await requireDirectAccessBearer(disabledOAuth.req, disabledOAuth.res, principals, botGate), null);
  assert.equal(disabledOAuth.result().status, 503);
  assert.equal(disabledOAuth.result().headers['www-authenticate'], undefined);
  assert.equal(disabledOAuth.result().json.code, 'BOT_DISABLED');
  assert.equal(
    disabledOAuth.result().json.message,
    '暂时不可用：机器人模型尚未启用。请管理员在控制台配置并启用机器人模型后重试。',
  );

  gateEnabled = true;
  const enabledOAuth = fakePair('Bearer oauth');
  assert.equal(await requireDirectAccessBearer(enabledOAuth.req, enabledOAuth.res, principals, botGate), null);
  assert.equal(enabledOAuth.result().status, 403);
  assert.equal(enabledOAuth.result().headers['www-authenticate'], BOT_INSUFFICIENT_SCOPE_HEADER);
  assert.equal(enabledOAuth.result().json.code, 'BOT_CLIENT_FORBIDDEN');

  // F2: botError default fallback and situational override behavior
  const defaultErr = botError('BOT_DISABLED');
  assert.equal(defaultErr.code, 'BOT_DISABLED');
  assert.equal(defaultErr.message, '暂时不可用：机器人尚未配置启用。请管理员在控制台配置机器人模型后重试。');

  const factOnlyErr = botError('BOT_DISABLED', '自定义事实');
  assert.equal(factOnlyErr.message, '暂时不可用：自定义事实。请管理员在控制台配置机器人模型后重试。');

  const customNextErr = botError('BOT_CLIENT_FORBIDDEN', '缺少有效来源', '请核对请求来源后重试');
  assert.equal(customNextErr.message, '无权限：缺少有效来源。请核对请求来源后重试。');
});
