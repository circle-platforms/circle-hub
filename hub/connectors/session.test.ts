// LoginManager on its own (D01 R[9]), against the agile-like login stub and an in-memory vault: what stops a login for good
// (an answer that refuses, or no certain answer) and what only cools down (a login that provably never reached the source);
// a token is fresh until a request carrying it is answered by anything but "expired", for every caller; the decision to log
// in is made at once, so slow vault writes cannot let a second login through; a reset during a login drops its result; an
// expiry that is already due when the login states it is treated as unknown.
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, test } from 'node:test';
import { SystemProfile, type LoginDeclaration } from '../../contracts/src/resources.ts';
import type { Vault } from '../records/api.ts';
import { ConnectorError } from './errors.ts';
import { HttpSource, type ConnectorLogEvent } from './http.ts';
import { LoginManager } from './login.ts';
import { Redactor } from './redact.ts';
import { agileFixture, passwordDigest, startAgileStub, type AgileStub } from './testing/agile.ts';
import { agileSystem } from './testing/packs.ts';
import { startStub } from './testing/stub.ts';

const RES = 'res_01jacd5z8q3w7v9h2k4m6n8p0t';
const PASSWORD = 'Synthetic#Pass42';
const SESSION = `connector.${RES}.session`;
const CREDENTIALS = { username: `connector.${RES}.username`, password: `connector.${RES}.password` };
const profile = SystemProfile.parse(agileSystem());
const LOGIN = (profile.auth as { login: LoginDeclaration }).login;

const servers: { close(): Promise<void> }[] = [];
after(async () => {
  for (const server of servers) await server.close();
});

interface MemoryVault extends Vault {
  entries: Map<string, string>;
  readonly puts: number;
}

/** A vault in memory; the n-th put waits delays[n] ms first. */
function memoryVault(delays: number[] = []): MemoryVault {
  const entries = new Map<string, string>();
  let puts = 0;
  return {
    entries,
    get puts() {
      return puts;
    },
    async initKey() {},
    async put(name, value) {
      const delay = delays[puts] ?? 0;
      puts += 1;
      if (delay > 0) await sleep(delay);
      entries.set(name, typeof value === 'string' ? value : Buffer.from(value).toString('utf8'));
    },
    async get(name) {
      const value = entries.get(name);
      return value === undefined ? null : new Uint8Array(Buffer.from(value, 'utf8'));
    },
    async getText(name) {
      return entries.get(name) ?? null;
    },
    async has(name) {
      return entries.has(name);
    },
    async list() {
      return [...entries.keys()].sort();
    },
    async remove(name) {
      return entries.delete(name);
    },
  };
}

interface Bed {
  agile: AgileStub;
  vault: MemoryVault;
  log: ConnectorLogEvent[];
  clock: { now: number };
  manager(options?: { login?: LoginDeclaration; oauth?: string }): LoginManager;
}

async function bed(options: { lifetime?: number; loginDelayMs?: number; delays?: number[] } = {}): Promise<Bed> {
  const clock = { now: Date.parse('2026-10-22T08:00:00.000Z') };
  const agile = await startAgileStub({ ...agileFixture('q7w2e9r4t1y8', { password: PASSWORD }), tokenLifetimeSeconds: options.lifetime, loginDelayMs: options.loginDelayMs, now: () => clock.now });
  servers.push(agile);
  const vault = memoryVault(options.delays);
  vault.entries.set(CREDENTIALS.username, 'reader');
  vault.entries.set(CREDENTIALS.password, passwordDigest(PASSWORD));
  const log: ConnectorLogEvent[] = [];
  const redactor = new Redactor();
  return {
    agile,
    vault,
    log,
    clock,
    manager(extra = {}) {
      const oauth = extra.oauth ?? agile.origin;
      const http = new HttpSource({
        resource: RES,
        origins: { 'agile-oauth': oauth, 'agile-api': agile.origin },
        allowPlaintext: [...new Set([oauth, agile.origin])],
        routes: profile.routes,
        envelope: profile.envelope,
        redactor,
        now: () => clock.now,
      });
      return new LoginManager({
        resource: RES,
        login: extra.login ?? LOGIN,
        credentials: CREDENTIALS,
        sessionEntry: SESSION,
        binding: 'binding-1',
        vault,
        http,
        now: () => clock.now,
        cooldownMs: 30 * 60_000,
        expiryMarginMs: 60_000,
        redactor,
        log: (event) => void log.push(event),
      });
    },
  };
}

function session(token: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ v: 1, binding: 'binding-1', token, expires_at: null, obtained_at: 1, unconfirmed: false, cooldown_until: null, stopped: false, failed_at: null, failure: null, ...extra });
}

const loginFailed = (error: unknown) => error instanceof ConnectorError && error.code === 'LOGIN_FAILED';

test('a token another caller takes from the cache right after its login is still fresh: an expired answer to it stops, no second login', async () => {
  const b = await bed();
  const m = b.manager();
  const first = await m.token();
  assert.equal(b.agile.logins, 1);
  const second = await m.token();
  assert.equal(second.token, first.token);
  assert.equal(second.fresh, true, 'unconfirmed until a request carrying it is answered');
  await assert.rejects(m.expired(second.token), loginFailed);
  assert.equal(b.agile.logins, 1, 'a second login would not help');
  assert.equal((await m.status()).stopped, true);
});

test('once a request carrying the token is answered, an explicit expired answer leads to exactly one login', async () => {
  const b = await bed();
  const m = b.manager();
  const { token } = await m.token();
  await m.confirmed(token);
  assert.equal((await m.token()).fresh, false);
  const next = await m.expired(token);
  assert.notEqual(next, token);
  assert.equal(b.agile.logins, 2);
  // A caller that still holds the old token gets the renewed one without a login.
  assert.equal(await m.expired(token), next);
  assert.equal(b.agile.logins, 2);
});

test('the decision to log in is made at once: a slow vault write cannot let a second login through after a failed one', async () => {
  // The token in the vault is confirmed; the password is wrong now; the second vault write takes 300 ms.
  const b = await bed({ delays: [0, 300] });
  b.vault.entries.set(SESSION, session('a1b2c3d4e5f6a7b8c9d0e1f2'));
  b.agile.setPassword('Changed#Pass99');
  const m = b.manager();
  const results = await Promise.allSettled([m.expired('a1b2c3d4e5f6a7b8c9d0e1f2'), m.expired('a1b2c3d4e5f6a7b8c9d0e1f2')]);
  assert.deepEqual(
    results.map((r) => r.status),
    ['rejected', 'rejected'],
  );
  assert.equal(b.agile.logins, 1, 'one login for one expiry, even after it failed');
  assert.equal((await m.status()).stopped, true);
});

test('a source that refuses the login stops it until an admin acts; the cool-down time passing changes nothing', async () => {
  const b = await bed();
  b.agile.setPassword('Changed#Pass99');
  const m = b.manager();
  await assert.rejects(m.token(), loginFailed);
  assert.equal(b.agile.logins, 1);
  b.clock.now += 31 * 60_000;
  await assert.rejects(m.token(), (e: unknown) => loginFailed(e) && /停止/.test((e as Error).message));
  b.clock.now += 7 * 24 * 3600_000;
  await assert.rejects(m.token(), loginFailed);
  assert.equal(b.agile.logins, 1, 'never a second attempt on its own');
  const status = await m.status();
  assert.equal(status.stopped, true);
  assert.equal(status.cooldownUntil, null);
  assert.match(status.failure ?? '', /LOGIN_FAILED:1005/);
  // A restarted Hub keeps the stop.
  await assert.rejects(b.manager().token(), loginFailed);
  assert.equal(b.agile.logins, 1);
  await m.reset();
  b.agile.setPassword(PASSWORD);
  assert.ok((await m.token()).token);
  assert.equal(b.agile.logins, 2, 'an explicit reset allows one attempt');
});

test('a login without an answer in time stops as well: the source may have judged the credential', async () => {
  const b = await bed({ loginDelayMs: 1000 });
  const m = b.manager({ login: { ...LOGIN, timeout_ms: 200 } });
  await assert.rejects(m.token(), loginFailed);
  b.clock.now += 31 * 60_000;
  await assert.rejects(m.token(), loginFailed);
  assert.equal(m.attempts, 1);
  assert.equal((await m.status()).stopped, true);
});

test('a login that provably never reached the source cools down, then is tried once again', async () => {
  const closed = await startStub(() => ({ status: 200 }));
  const origin = closed.origin;
  await closed.close();
  const b = await bed();
  const m = b.manager({ oauth: origin });
  await assert.rejects(m.token(), loginFailed);
  const status = await m.status();
  assert.equal(status.stopped, false);
  assert.ok(status.cooldownUntil !== null);
  await assert.rejects(m.token(), (e: unknown) => loginFailed(e) && /冷却/.test((e as Error).message));
  assert.equal(m.attempts, 1, 'nothing during the cool-down');
  b.clock.now += 31 * 60_000;
  await assert.rejects(m.token(), loginFailed);
  assert.equal(m.attempts, 2, 'one attempt after it');
});

test('a reset while a login is in flight drops its result: the token is neither kept nor stored', async () => {
  const b = await bed({ loginDelayMs: 300 });
  const m = b.manager();
  const pending = m.token();
  await sleep(100);
  await m.reset();
  await assert.rejects(pending, loginFailed);
  assert.equal((await m.status()).token, false);
  assert.equal(b.vault.entries.has(SESSION), false);
  assert.equal(b.agile.logins, 1);
});

test('an expiry that is already due when the login states it is unknown: no login per call', async () => {
  // 30-second tokens are inside the one-minute renewal margin the moment they are issued.
  const short = await bed({ lifetime: 30 });
  const m = short.manager();
  for (let i = 0; i < 3; i++) {
    const { token } = await m.token();
    await m.confirmed(token);
  }
  assert.equal(short.agile.logins, 1);
  assert.equal((await m.status()).expiresAt, null);
  assert.ok(short.log.some((event) => event.event === 'login_expiry_unusable'));
  // An expiry in the past (a misdeclared unit, for example) is treated the same way.
  const past = await bed({ lifetime: -3600 });
  const p = past.manager();
  for (let i = 0; i < 3; i++) await p.token();
  assert.equal(past.agile.logins, 1);
});

test('a session stored for another binding (other origins, pack or credentials) is not used', async () => {
  const b = await bed();
  b.vault.entries.set(SESSION, session('f0e1d2c3b4a5f6e7d8c9b0a1', { binding: 'binding-0', stopped: true, token: null }));
  const m = b.manager();
  assert.equal((await m.status()).stopped, false);
  const { token } = await m.token();
  assert.notEqual(token, 'f0e1d2c3b4a5f6e7d8c9b0a1');
  assert.equal(b.agile.logins, 1);
});
