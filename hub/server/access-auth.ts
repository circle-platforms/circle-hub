import type { Principal, Principals } from '../records/api.ts';

export const CONSOLE_SESSION_REFUSED = '无权限：控制台登录凭证不能用于此入口。请使用访问令牌。';

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
