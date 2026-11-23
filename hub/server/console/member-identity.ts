import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { AccessError, ConflictError } from '../../records/api.ts';
import { cookiesOf, readBody, sendText, setCommonHeaders } from '../http.ts';
import { issuerOf, peerOf } from '../oauth.ts';
import { callBot, identityIssuer, readIdentity } from '../personal-bot.ts';
import { principalOfConsoleSession, type ConsoleOptions } from './console-http.ts';
import { cookie, safeNext, SECURE_SESSION_COOKIE, SESSION_COOKIE, type ConsoleSession } from './session.ts';

const callback = '/console/identity/callback';
const STATES_PER_PEER = 20;
const MAX_PENDING_STATES = 1000;
const STATE_TTL_MS = 300_000;

type Challenge = {
  session: string | null;
  owner: string | null;
  issuer: string;
  origin: string;
  next: string;
  peer: string;
  expires: number;
};

export class IdentityChallenges {
  private states = new Map<string, Challenge>();

  issue(input: Omit<Challenge, 'expires'>): string | null {
    const now = Date.now();
    for (const [id, item] of this.states) if (item.expires <= now) this.states.delete(id);
    let samePeerCount = 0;
    for (const item of this.states.values()) if (item.peer === input.peer) samePeerCount += 1;
    if (samePeerCount >= STATES_PER_PEER) return null;
    if (this.states.size >= MAX_PENDING_STATES) return null;
    const state = randomBytes(32).toString('base64url');
    this.states.set(state, { ...input, expires: now + STATE_TTL_MS });
    return state;
  }

  take(state: string): Challenge | null {
    const value = this.states.get(state);
    this.states.delete(state);
    return value && value.expires > Date.now() ? value : null;
  }
}

export async function handleIdentity(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  options: ConsoleOptions,
  session: ConsoleSession | null,
): Promise<void> {
  const { deps, identityChallenges: states } = options;
  const unavailable = (status = 403, message = '扫码身份不可用。请使用成员账号登录。', headers: Record<string, string> = {}) => {
    req.resume();
    return sendText(res, status, message, headers);
  };
  const secure = options.secureRequest(req);
  const origin = issuerOf(req, secure);
  if (!states || !deps.records.vault?.has || !(await deps.records.vault.has('personal-bot.identity'))) {
    return unavailable(404);
  }
  const profile = await readIdentity(deps.records.vault);
  if (!profile) return unavailable(404);
  const issuer = identityIssuer(profile.tenant);
  const cookieName = secure ? '__Secure-hub_identity' : 'hub_identity';
  const redirect = (to: string, values: string[]) => {
    setCommonHeaders(res);
    res.writeHead(303, { location: to, 'set-cookie': values });
    res.end();
  };
  const optionsForAdapter = { tenant: profile.tenant, application: profile.application, redirect: origin + callback };
  if (url.pathname === callback) {
    if (req.method !== 'GET') return unavailable(405);
    const state = url.searchParams.get('state');
    if (!state || cookiesOf(req).get(cookieName) !== state) return unavailable();
    const issued = states.take(state);
    const code = url.searchParams.get('code');
    if (!issued || issued.issuer !== issuer || issued.origin !== origin || !code || code.length > 2048) {
      return unavailable();
    }
    const result = await callBot(
      deps.config.dataDir,
      { action: 'identity', ...optionsForAdapter, secret: profile.secret, code },
      'channel',
    );
    const subject = (result.body as { subject?: unknown })?.subject;
    if (result.status !== 200 || typeof subject !== 'string' || !subject || subject.length > 256) return unavailable();
    const clear = cookie(cookieName, '', callback, 0, secure, true);
    if (issued.session) {
      const bound = options.sessions.peek(issued.session, secure);
      if (!bound || (session && session.id !== bound.id)) return unavailable();
      const actor = await principalOfConsoleSession(deps.records.principals, bound.token);
      if (!actor || actor.id !== issued.owner) return unavailable();
      try {
        await deps.records.principals.bindExternalIdentity(actor, issuer, subject);
      } catch (error) {
        if (error instanceof ConflictError || error instanceof AccessError) {
          return unavailable(403);
        }
        options.log(`扫码身份绑定失败（成员 ${actor.id}）：${error instanceof Error ? error.message : String(error)}`);
        return unavailable(503, '服务暂时不可用，请稍后重试');
      }
      return redirect('/console/settings', [clear]);
    }
    let member;
    let login;
    try {
      member = await deps.records.principals.externalMember(issuer, subject);
      if (!member) return unavailable();
      const revision = await deps.records.principals.passwordState(member.id);
      login = await deps.records.principals.openConsoleSession(member.id, revision.revision);
    } catch (error) {
      options.log(`扫码身份查询失败：${error instanceof Error ? error.message : String(error)}`);
      return unavailable(503, '服务暂时不可用，请稍后重试');
    }
    if (!login) return unavailable();
    const signed = options.sessions.open(login.token, secure);
    return redirect(issued.next, [
      clear,
      cookie(secure ? SECURE_SESSION_COOKIE : SESSION_COOKIE, signed.token, '/console', undefined, secure),
    ]);
  }
  let owner: string | null = null;
  if (url.pathname === '/console/identity/bind') {
    if (req.method !== 'POST' || !session || req.headers.origin !== origin) return unavailable();
    const actor = await principalOfConsoleSession(deps.records.principals, session.token);
    if (!actor || (await deps.records.principals.passwordState(actor.id)).mustChange) return unavailable();
    const data = await readBody(req, 8192);
    if (!data.ok || new URLSearchParams(data.bytes.toString()).get('csrf') !== session.csrf) return unavailable();
    owner = actor.id;
  } else if (url.pathname !== '/console/identity/login' || req.method !== 'GET') {
    return unavailable(404);
  }
  const state = states.issue({
    issuer,
    origin,
    owner,
    peer: peerOf(req),
    session: owner ? session!.id : null,
    next: safeNext(url.searchParams.get('next')),
  });
  if (!state) return unavailable(429, '当前来源待完成的扫码登录请求过多，请稍后再试。', { 'retry-after': '60' });
  const result = await callBot(deps.config.dataDir, { action: 'qr', ...optionsForAdapter, state }, 'channel');
  const location = (result.body as { location?: unknown })?.location;
  if (
    result.status !== 200 ||
    typeof location !== 'string' ||
    !URL.canParse(location) ||
    new URL(location).protocol !== 'https:'
  ) {
    return unavailable(503);
  }
  redirect(location, [cookie(cookieName, state, callback, 300, secure, true)]);
}
