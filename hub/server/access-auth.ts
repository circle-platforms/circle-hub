import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ProtocolCode } from '../../contracts/generated/protocol-codes.ts';
import type { Principal, Principals } from '../records/api.ts';
import { sendJson } from './http.ts';

export const CONSOLE_SESSION_REFUSED = '无权限：控制台登录凭证不能用于此入口。请使用访问令牌。';
const BOT_CLIENT_FORBIDDEN: ProtocolCode = 'BOT_CLIENT_FORBIDDEN';

export type AccessAuthResult =
  | { ok: true; principal: Principal; token_id: string | null; client_id: string | null }
  | { ok: false; reason: 'unauthenticated' | 'console_session' };

export async function authenticateAccessOnly(principals: Principals, authorization: string | null | undefined): Promise<AccessAuthResult> {
  if (principals.authenticateAccessToken) {
    const access = await principals.authenticateAccessToken(authorization);
    if (access) return { ok: true, principal: access.principal, token_id: access.token_id, client_id: access.client_id };
    if (typeof authorization === 'string' && authorization.length > 0) {
      const any = principals.identify ? await principals.identify(authorization) : await principals.authenticate(authorization);
      if (any) return { ok: false, reason: 'console_session' };
    }
    return { ok: false, reason: 'unauthenticated' };
  }
  const principal = await principals.authenticate(authorization);
  return principal
    ? { ok: true, principal, token_id: null, client_id: null }
    : { ok: false, reason: 'unauthenticated' };
}

export async function requireAccessBearer(
  request: IncomingMessage,
  response: ServerResponse,
  principals: Principals,
): Promise<Principal | null> {
  const access = await authenticateAccessOnly(principals, request.headers.authorization ?? null);
  if (access.ok) return access.principal;
  request.resume();
  if (access.reason === 'console_session') {
    sendJson(response, 403, { message: CONSOLE_SESSION_REFUSED });
    return null;
  }
  sendJson(response, 401, { message: '请重新登录' }, { 'www-authenticate': 'Bearer' });
  return null;
}

export async function requireDirectAccessBearer(
  request: IncomingMessage,
  response: ServerResponse,
  principals: Principals,
): Promise<Principal | null> {
  const access = await authenticateAccessOnly(principals, request.headers.authorization ?? null);
  if (!access.ok) {
    request.resume();
    if (access.reason === 'console_session') {
      sendJson(response, 403, { code: BOT_CLIENT_FORBIDDEN, message: CONSOLE_SESSION_REFUSED });
      return null;
    }
    sendJson(
      response,
      401,
      { code: BOT_CLIENT_FORBIDDEN, message: '请重新登录' },
      { 'www-authenticate': 'Bearer' },
    );
    return null;
  }
  if (access.client_id !== null) {
    request.resume();
    sendJson(response, 403, {
      code: BOT_CLIENT_FORBIDDEN,
      message: '无权限：第三方授权应用令牌不能访问个人助手，请使用成员直接持有的访问令牌。',
    });
    return null;
  }
  return access.principal;
}
