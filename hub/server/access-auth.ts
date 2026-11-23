import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  callErrorCategory,
  formatCallError,
  PROTOCOL_CODES,
  type ProtocolCode,
} from '../../contracts/generated/protocol.ts';
import type { Principal, Principals } from '../records/api.ts';
import { sendJson } from './http.ts';

export function botError(
  code: ProtocolCode,
  fact?: string,
  nextAction?: string,
): { code: ProtocolCode; message: string } {
  const category = callErrorCategory(code)!;
  return {
    code,
    message: formatCallError(category, fact ?? PROTOCOL_CODES[code].when, nextAction ?? PROTOCOL_CODES[code].fix),
  };
}

export function sendBotJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  if (response.headersSent || response.writableEnded || response.destroyed) return;
  sendJson(response, status, body, headers);
}

export const CONSOLE_SESSION_REFUSED = formatCallError(
  callErrorCategory('BOT_CLIENT_FORBIDDEN')!,
  '控制台登录凭证不能用于此入口',
  '请使用访问令牌',
);

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

export async function requireDirectAccessBearer(
  request: IncomingMessage,
  response: ServerResponse,
  principals: Principals,
): Promise<Principal | null> {
  const access = await authenticateAccessOnly(principals, request.headers.authorization ?? null);
  if (!access.ok) {
    request.resume();
    if (access.reason === 'console_session') {
      sendBotJson(
        response,
        403,
        botError('BOT_CLIENT_FORBIDDEN', '控制台登录凭证不能用于此入口', '请使用访问令牌'),
      );
      return null;
    }
    sendBotJson(response, 401, botError('BOT_UNAUTHENTICATED'), { 'www-authenticate': 'Bearer' });
    return null;
  }
  if (access.client_id !== null) {
    request.resume();
    sendBotJson(
      response,
      403,
      botError('BOT_CLIENT_FORBIDDEN', '第三方授权应用令牌不能访问机器人', '请使用成员直接持有的访问令牌'),
    );
    return null;
  }
  return access.principal;
}
