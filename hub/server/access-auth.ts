// Non-console HTTP entries (MCP, run-export, local-tools) accept only access tokens. A live console-session credential
// is refused with the closed「无权限」category sentence; missing or unusable tokens stay the existing unauthenticated answer.
import type { Principal, Principals } from '../records/api.ts';

/** User-visible refusal when a console-session credential is presented to a non-console entry. */
export const CONSOLE_SESSION_REFUSED = '无权限：控制台登录凭证不能用于此入口。请使用访问令牌。';

export type AccessAuthResult =
  | { ok: true; principal: Principal; token_id: string | null; client_id: string | null }
  | { ok: false; reason: 'unauthenticated' | 'console_session' };

/**
 * Prefer authenticateAccessToken; when that fails, detect a still-valid console session so the caller can answer「无权限」
 * instead of the generic unauthenticated body. authenticate() itself still accepts console sessions (CLI / command-bridge).
 */
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
