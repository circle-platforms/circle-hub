// LoginManager on its own (D01 R[9]), against the agile-like login stub and an in-memory vault: what stops a login for good
// (an answer that refuses, or no certain answer) and what only cools down (a login that provably never reached the source);
// a token is fresh until a request carrying it is answered by anything but "expired", for every caller; the decision to log
// in is made at once, so slow vault writes cannot let a second login through; a reset during a login drops its result; an
// expiry that is already due when the login states it is treated as unknown. The session entry as what processes share:
// every write stores a new generation; a stop ends when the entry is removed or another process stores a generation this
// one did not write, never by time, by a re-read of an unchanged entry, an entry of another binding, an unparsable one or
// a vault read that fails; this process's own writes (even one that reported a failure) are never taken for another's;
// a login in flight keeps no result when the entry was removed or a credential changed meanwhile, and otherwise records its
// failure over what the entry holds then (another process's token is used, a cool-down gets the stop); a confirmation
// does not overwrite another process's stop; a reset wins over a read it overtook. A login in flight is marked in the
// entry, and another process waits for its result instead of sending the same password. StaticCredential's refusal is
// decided after its last read as well.
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, test } from 'node:test';
import { SystemProfile, type LoginDeclaration } from '../../contracts/src/resources.ts';
import type { Vault } from '../records/api.ts';
import { ConnectorError } from './errors.ts';
import { HttpSource, type ConnectorLogEvent } from './http.ts';
import { LoginManager, SessionStore, StaticCredential, markOf } from './login.ts';
import { Redactor } from './redact.ts';
import { agileFixture, passwordDigest, startAgileStub, type AgileStub } from './testing/agile.ts';
import { agileSystem } from './testing/packs.ts';
import { json, startStub } from './testing/stub.ts';

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
  /**
   * Faults of the session entry: a put that throws before or after it stored the value, a read that throws, a removal that
   * throws. Credential entries are never affected.
   */
  faults: { put: 'before' | 'after' | null; get: boolean; remove: boolean };
}

/** A vault in memory; the n-th put waits delays[n] ms first. */
function memoryVault(delays: number[] = []): MemoryVault {
  const entries = new Map<string, string>();
  const faults: MemoryVault['faults'] = { put: null, get: false, remove: false };
  let puts = 0;
  return {
    entries,
    faults,
    get puts() {
      return puts;
    },
    async initKey() {},
    async put(name, value) {
      const delay = delays[puts] ?? 0;
      puts += 1;
      if (delay > 0) await sleep(delay);
      if (name === SESSION && faults.put === 'before') throw new Error('synthetic vault write failure');
      entries.set(name, typeof value === 'string' ? value : Buffer.from(value).toString('utf8'));
      if (name === SESSION && faults.put === 'after') throw new Error('synthetic failure reported after the write landed');
    },
    async get(name) {
      const value = entries.get(name);
      return value === undefined ? null : new Uint8Array(Buffer.from(value, 'utf8'));
    },
    async getText(name) {
      if (name === SESSION && faults.get) throw new Error('synthetic vault read failure');
      return entries.get(name) ?? null;
    },
    async has(name) {
      return entries.has(name);
    },
    async stat(name) { return entries.has(name) ? {written_at: '2026-10-24T00:00:00.000Z'} : null; },
    async list() {
      return [...entries.keys()].sort();
    },
    async remove(name) {
      if (name === SESSION && faults.remove) throw new Error('synthetic vault removal failure');
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
/** The refusal of a stop (or a failure that recorded one). */
const stopped = (error: unknown) => loginFailed(error) && (error as ConnectorError).detail.stopped === true;
/** A login whose result was not used: the session or a credential changed while it was out. */
const dropped = (error: unknown) => loginFailed(error) && (error as ConnectorError).detail.dropped === true;

/** Waits until `condition` holds (a login has reached the stub, say), at most 10 s. */
async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

/** A promise whose rejection the test checks later: marked as handled now, so an early rejection is not reported as unhandled. */
function later<T>(promise: Promise<T>): Promise<T> {
  promise.catch(() => undefined);
  return promise;
}

/**
 * Holds the n-th read of vault entry `name` from now on: the entry is read at once and its text is returned only after
 * `release()`, as a read that began before what the test does meanwhile. `reached()` tells whether that read began.
 */
function holdRead(vault: MemoryVault, name: string, nth: number): { reached: () => boolean; release: () => void } {
  const read = vault.getText.bind(vault);
  let count = 0;
  let began = false;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  vault.getText = async (entry) => {
    if (entry !== name) return read(entry);
    count += 1;
    const text = await read(entry);
    if (count === nth) {
      began = true;
      await gate;
    }
    return text;
  };
  return { reached: () => began, release };
}

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
  assert.notEqual(token, ["f0e1d2","c3b4a5","f6e7d8","c9b0a1"].join(''));
  assert.equal(b.agile.logins, 1);
});

// ---------------------------------------------------------------- the session entry between processes

test('every write stores a new generation; an entry written before generations existed is still read', async () => {
  const b = await bed();
  b.vault.entries.set(SESSION, session('a1b2c3d4e5f6a7b8c9d0e1f2'));
  const m = b.manager();
  assert.equal((await m.token()).token, ["a1b2c3","d4e5f6","a7b8c9","d0e1f2"].join(''), 'an entry without a generation is read as before');
  assert.equal(b.agile.logins, 0);
  const renewed = await m.expired('a1b2c3d4e5f6a7b8c9d0e1f2');
  assert.equal(b.agile.logins, 1);
  const generation = () => (JSON.parse(b.vault.entries.get(SESSION) ?? '{}') as { generation?: string }).generation;
  const first = generation();
  assert.match(first ?? '', /^[A-Za-z0-9_-]{16,64}$/);
  await m.confirmed(renewed);
  assert.notEqual(generation(), first, 'each write has its own');
  assert.equal(markOf(b.vault.entries.get(SESSION) ?? null), generation());
  assert.match(markOf(session('a1b2c3d4e5f6a7b8c9d0e1f2')) ?? '', /^sha256:[0-9a-f]{64}$/, 'an entry without one is known by its digest');
  assert.notEqual(markOf(session('a1b2c3d4e5f6a7b8c9d0e1f2')), markOf(session('a1b2c3d4e5f6a7b8c9d0e1f3')));
  assert.equal(markOf(null), null);
});

test('a stop held in memory ends when the entry is removed elsewhere: one attempt then; time and re-reads of an unchanged entry end nothing', async () => {
  const b = await bed();
  b.agile.setPassword('Changed#Pass99');
  const m = b.manager();
  await assert.rejects(m.token(), stopped);
  for (let i = 0; i < 3; i++) {
    b.clock.now += 24 * 3600_000;
    await assert.rejects(m.token(), stopped);
    await assert.rejects(m.expired('a1b2c3d4e5f6a7b8c9d0e1f2'), stopped);
    assert.equal((await m.status()).stopped, true);
  }
  assert.equal(b.agile.logins, 1, 'the source judged the credential: no attempt by time or by reading the entry again');
  // The CLI (another process) resets the login: it removes the entry.
  b.vault.entries.delete(SESSION);
  await assert.rejects(m.token(), stopped);
  assert.equal(b.agile.logins, 2, 'one attempt with the stored credential');
  await assert.rejects(m.token(), stopped);
  assert.equal(b.agile.logins, 2, 'refused again: stopped again');
  // Callers that come together after a removal share one login.
  b.vault.entries.delete(SESSION);
  b.agile.setPassword(PASSWORD);
  const [one, two] = await Promise.all([m.token(), m.token()]);
  assert.equal(one.token, two.token);
  assert.equal(b.agile.logins, 3);
});

test('an entry another process stored under a generation of its own replaces the state in memory: its token, or its stop', async () => {
  const b = await bed();
  b.agile.setPassword('Changed#Pass99');
  const m = b.manager();
  await assert.rejects(m.token(), stopped);
  // Another process logged in after a reset and stored its session.
  b.vault.entries.set(SESSION, session('c0ffee00c0ffee00c0ffee00', { generation: 'another-process-0001' }));
  const taken = await m.token();
  assert.equal(taken.token, 'c0ffee00c0ffee00c0ffee00');
  assert.equal(taken.fresh, false, 'confirmed there, so confirmed here');
  assert.equal(b.agile.logins, 1, 'no login of its own');
  // Its stop, stored the same way: an expired answer then meets the stop, not a second failed login.
  b.vault.entries.set(SESSION, session('', { token: null, stopped: true, failed_at: 2, failure: 'LOGIN_FAILED:1005', generation: 'another-process-0002' }));
  await assert.rejects(m.expired('c0ffee00c0ffee00c0ffee00'), stopped);
  await assert.rejects(m.token(), stopped);
  assert.equal(b.agile.logins, 1);
  assert.equal((await m.status()).failure, 'LOGIN_FAILED:1005');
});

test('an entry of another binding, one that does not parse, or a vault read that fails neither ends a stop nor gives a state', async () => {
  const b = await bed();
  b.agile.setPassword('Changed#Pass99');
  const m = b.manager();
  await assert.rejects(m.token(), stopped);
  b.agile.setPassword(PASSWORD);
  b.vault.entries.set(SESSION, session('f0e1d2c3b4a5f6e7d8c9b0a1', { binding: 'binding-0', generation: 'other-binding-00001' }));
  await assert.rejects(m.token(), stopped, 'another configuration says nothing about this one');
  b.vault.entries.set(SESSION, '{"v":1,"binding":');
  await assert.rejects(m.token(), stopped, 'an entry that does not parse');
  b.vault.entries.delete(SESSION);
  b.vault.faults.get = true;
  await assert.rejects(m.token(), stopped, 'a vault that cannot be read');
  assert.ok(b.log.some((event) => event.event === 'session_store_failed'));
  assert.equal(b.agile.logins, 1);
  b.vault.faults.get = false;
  assert.ok((await m.token()).token, 'the removal, once it can be read, ends the stop');
  assert.equal(b.agile.logins, 2);
});

test('a stop whose write failed is not ended by reading the entry again', async () => {
  const b = await bed();
  b.agile.setPassword('Changed#Pass99');
  b.vault.faults.put = 'before';
  const m = b.manager();
  await assert.rejects(m.token(), stopped);
  assert.equal(b.vault.entries.has(SESSION), false, 'the stop never reached the vault');
  assert.ok(b.log.some((event) => event.event === 'session_store_failed'));
  b.vault.faults.put = null;
  await assert.rejects(m.token(), stopped, 'no entry is what this process last saw: nothing changed elsewhere');
  assert.equal(b.agile.logins, 1);
});

test('status() reads the entry again: a stop or a cool-down ended elsewhere shows as ended, and nothing is sent for it', async () => {
  const b = await bed();
  b.agile.setPassword('Changed#Pass99');
  const m = b.manager();
  await assert.rejects(m.token(), stopped);
  assert.equal((await m.status()).stopped, true);
  b.vault.entries.delete(SESSION);
  const status = await m.status();
  assert.equal(status.stopped, false);
  assert.equal(status.failure, null);
  assert.equal(b.agile.logins, 1);
  // A cool-down (a login that never reached the source) ends the same way: one attempt at once, not after the cool-down.
  const closed = await startStub(() => ({ status: 200 }));
  const origin = closed.origin;
  await closed.close();
  const c = await bed();
  const cool = c.manager({ oauth: origin });
  await assert.rejects(cool.token(), loginFailed);
  assert.ok((await cool.status()).cooldownUntil !== null);
  await assert.rejects(cool.token(), (e: unknown) => loginFailed(e) && /冷却/.test((e as Error).message));
  assert.equal(cool.attempts, 1);
  c.vault.entries.delete(SESSION);
  assert.equal((await cool.status()).cooldownUntil, null);
  assert.equal(cool.attempts, 1, 'a status attempts nothing');
  await assert.rejects(cool.token(), loginFailed);
  assert.equal(cool.attempts, 2);
});

test('a login in flight keeps no result when a credential was set again or the entry removed elsewhere meanwhile; otherwise it stops', async () => {
  // No entry yet: the CLI sets a new password while the first login, with the old one, is out.
  const b = await bed({ loginDelayMs: 300 });
  b.agile.setPassword('Changed#Pass99');
  const m = b.manager();
  const first = m.token();
  await until(() => b.agile.logins === 1, 'the first login');
  b.vault.entries.set(CREDENTIALS.password, passwordDigest('Changed#Pass99'));
  await assert.rejects(first, dropped);
  assert.equal((await m.status()).stopped, false, 'the refusal judged a credential that is gone');
  const { token } = await m.token();
  assert.equal(b.agile.logins, 2, 'the next login uses the new value');
  // A stored session: the CLI resets it (removes the entry) while a renewal with a password the source refuses is out.
  await m.confirmed(token);
  b.agile.setPassword('Third#Pass77');
  const renewal = m.expired(token);
  await until(() => b.agile.logins === 3, 'the renewal');
  b.vault.entries.delete(SESSION);
  await assert.rejects(renewal, dropped);
  assert.equal((await m.status()).stopped, false);
  // Nothing changed elsewhere this time: the refusal stops the logins, as always.
  await assert.rejects(m.token(), stopped);
  assert.equal(b.agile.logins, 4);
  await assert.rejects(m.token(), stopped);
  assert.equal(b.agile.logins, 4);
});

test('two processes over one vault: a token one of them renewed is used by the other, and a stop one of them recorded holds for both', async () => {
  const b = await bed();
  const hub = b.manager();
  const cli = b.manager();
  const t1 = (await hub.token()).token;
  await hub.confirmed(t1);
  assert.equal((await cli.token()).token, t1, 'taken from the vault');
  const t2 = await hub.expired(t1);
  await hub.confirmed(t2);
  assert.equal(await cli.expired(t1), t2, 'renewed by the other process: no login of its own');
  assert.equal(b.agile.logins, 2);
  b.agile.setPassword('Changed#Pass99');
  await assert.rejects(hub.expired(t2), stopped);
  assert.equal(b.agile.logins, 3);
  await assert.rejects(cli.expired(t2), stopped, 'the stop the other process stored: no second failed login');
  await assert.rejects(cli.token(), stopped);
  assert.equal(b.agile.logins, 3);
});

test('the session store: its own writes, even one that reported a failure but landed, are never another process\'s change; a removal that fails reaches the caller', async () => {
  const vault = memoryVault();
  let failures = 0;
  const store = new SessionStore(SESSION, 'binding-1', vault, () => void (failures += 1));
  await store.ready();
  assert.equal(await store.refresh(), false, 'no entry, nothing changed');
  store.set({ ...store.state, token: 'd00dfeedd00dfeedd00dfeed' });
  await store.persist();
  assert.equal(await store.refresh(), false, 'its own write');
  vault.faults.put = 'after';
  store.set({ ...store.state, unconfirmed: true });
  await store.persist();
  assert.equal(failures, 1);
  vault.faults.put = null;
  const epoch = store.epoch;
  assert.equal(await store.refresh(), false, 'a write that reported a failure but landed is still its own');
  assert.equal(store.epoch, epoch);
  assert.equal(store.state.unconfirmed, true, 'the state in memory stays');
  vault.entries.set(SESSION, session('beefbeefbeefbeefbeefbeef', { generation: 'another-process-0003' }));
  assert.equal(await store.refresh(), true, "another process's write is taken");
  assert.equal(store.state.token, 'beefbeefbeefbeefbeefbeef');
  assert.equal(store.epoch, epoch + 1, 'and a login in flight across it keeps no result');
  assert.equal(await store.refresh(), false, 'taken once');
  vault.entries.delete(SESSION);
  assert.equal(await store.refresh(), true, 'a removal elsewhere');
  assert.equal(store.state.token, null);
  store.set({ ...store.state, token: 'abcdabcdabcdabcdabcdabcd' });
  await store.persist();
  await store.clear();
  assert.equal(await store.refresh(), false, 'its own removal');
  store.set({ ...store.state, token: 'abcdabcdabcdabcdabcdabcd' });
  await store.persist();
  vault.faults.remove = true;
  await assert.rejects(store.clear(), /removal failure/);
  vault.faults.remove = false;
  assert.equal(store.state.token, null, 'forgotten in memory all the same');
  await store.persist();
  assert.equal(await store.refresh(), false, 'the queue goes on after a failure');
  assert.equal(JSON.parse(vault.entries.get(SESSION) ?? '{}').token, null);
});

test('the session store: a refresh asked for after another one started reading gets a read of its own; one asked for before shares it', async () => {
  const vault = memoryVault();
  const store = new SessionStore(SESSION, 'binding-1', vault, () => {});
  await store.ready();
  const read = vault.getText.bind(vault);
  let reads = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  vault.getText = async (name) => {
    reads += 1;
    const text = await read(name);
    if (reads === 1) await gate;
    return text;
  };
  const first = store.refresh();
  const joined = store.refresh();
  assert.equal(joined, first, 'asked for before the read started: shared');
  await until(() => reads === 1, 'the first read');
  // Another process writes after that read began; a decision taken now must see it.
  vault.entries.set(SESSION, session('beefbeefbeefbeefbeefbeef', { generation: 'another-process-0004' }));
  const second = store.refresh();
  release();
  assert.equal(await first, false, 'the first read found no entry');
  assert.equal(await second, true, 'the later one read again and found the write');
  assert.equal(reads, 2);
  assert.equal(store.state.token, 'beefbeefbeefbeefbeefbeef');
});

test('an admin reset whose removal fails says so: the CLI must not report a reset the running Hub cannot see', async () => {
  const b = await bed();
  b.agile.setPassword('Changed#Pass99');
  const m = b.manager();
  await assert.rejects(m.token(), stopped);
  b.vault.faults.remove = true;
  await assert.rejects(m.reset(), /removal failure/);
  assert.ok(b.log.some((event) => event.event === 'session_store_failed'));
  assert.equal(JSON.parse(b.vault.entries.get(SESSION) ?? '{}').stopped, true, 'the stop is still in the vault');
});

// ---------------------------------------------------------------- what a failure is recorded over

test("a refused login stops even when another process's cool-down landed while it was out: the password is not sent again when the cool-down ends", async () => {
  const b = await bed({ loginDelayMs: 500 });
  b.agile.setPassword('Changed#Pass99');
  const m = b.manager();
  const pending = m.token();
  await until(() => b.agile.logins === 1, 'the login at the source');
  // Another process that decided before this login was visible: its own login never reached the source, so it cools down.
  b.vault.entries.set(
    SESSION,
    session('', { token: null, cooldown_until: b.clock.now + 30 * 60_000, failed_at: b.clock.now, failure: 'LOGIN_FAILED:SOURCE_UNREACHABLE', generation: 'another-process-0005' }),
  );
  await assert.rejects(pending, stopped);
  const status = await m.status();
  assert.equal(status.stopped, true);
  assert.equal(status.cooldownUntil, null, 'a stop wins over a cool-down');
  assert.match(status.failure ?? '', /LOGIN_FAILED:1005/);
  assert.equal(JSON.parse(b.vault.entries.get(SESSION) ?? '{}').stopped, true, 'stored, so the other process keeps it too');
  b.clock.now += 31 * 60_000;
  await assert.rejects(m.token(), stopped);
  assert.equal(b.agile.logins, 1, 'the refused password is not sent again when the cool-down ends');
});

test("the other process's logins cannot reach the source: it waits for the refused login instead of cooling down, and nothing is sent later", async () => {
  const closed = await startStub(() => ({ status: 200 }));
  const origin = closed.origin;
  await closed.close();
  const b = await bed({ loginDelayMs: 500 });
  b.agile.setPassword('Changed#Pass99');
  const hub = b.manager();
  const other = b.manager({ oauth: origin });
  const first = later(hub.token());
  await until(() => b.agile.logins === 1, 'the login at the source');
  await assert.rejects(other.token(), stopped);
  await assert.rejects(first, stopped);
  assert.equal(other.attempts, 0, 'no login of its own, so no cool-down to wait out');
  b.clock.now += 31 * 60_000;
  await assert.rejects(hub.token(), stopped);
  await assert.rejects(other.token(), stopped);
  assert.equal(b.agile.logins, 1, 'the refused password went out once');
});

test('a refused login uses the token another process stored while it was out: nothing is stopped, and the refusal is still reported', async () => {
  const b = await bed({ loginDelayMs: 500 });
  b.agile.setPassword('Changed#Pass99');
  const m = b.manager();
  const pending = m.token();
  await until(() => b.agile.logins === 1, 'the login at the source');
  b.vault.entries.set(SESSION, session('c0ffee11c0ffee11c0ffee11', { generation: 'another-process-0006' }));
  assert.equal((await pending).token, 'c0ffee11c0ffee11c0ffee11');
  assert.equal((await m.status()).stopped, false);
  assert.ok(b.log.some((event) => event.event === 'login_failed' && event.other_token === true));
  assert.equal(b.agile.logins, 1);
});

test('a reset adopted while a refused login compares its credentials is not undone by that failure', async () => {
  const b = await bed();
  b.vault.entries.set(SESSION, session('a1b2c3d4e5f6a7b8c9d0e1f2'));
  b.agile.setPassword('Changed#Pass99');
  const m = b.manager();
  // The first read of the user name is the login's own; the second compares it after the refusal.
  const held = holdRead(b.vault, CREDENTIALS.username, 2);
  const renewal = m.expired('a1b2c3d4e5f6a7b8c9d0e1f2');
  await until(held.reached, 'the comparison of the credentials');
  b.vault.entries.delete(SESSION);
  assert.equal((await m.status()).stopped, false, 'the removal elsewhere is adopted');
  held.release();
  await assert.rejects(renewal, dropped);
  assert.equal((await m.status()).stopped, false);
  assert.equal(b.vault.entries.has(SESSION), false, 'no stop is stored over the reset');
  assert.ok(b.log.some((event) => event.event === 'login_failed' && event.dropped === true), 'the refusal is reported all the same');
  assert.equal(b.agile.logins, 1);
});

test('a confirmation in one process does not overwrite the stop another process recorded for the same token', async () => {
  const b = await bed();
  const hub = b.manager();
  const cli = b.manager();
  const { token } = await hub.token();
  assert.equal((await cli.token()).token, token, 'taken from the entry, unconfirmed');
  // A request of the first process with it is answered "expired": a fresh token refused, a stop.
  await assert.rejects(hub.expired(token), stopped);
  // A request of the other process with it had been answered otherwise; its confirmation comes after the stop.
  await cli.confirmed(token);
  assert.equal(JSON.parse(b.vault.entries.get(SESSION) ?? '{}').stopped, true, 'the stop stays in the entry');
  assert.equal((await cli.status()).stopped, true);
  await assert.rejects(hub.token(), stopped);
  await assert.rejects(cli.token(), stopped);
  assert.equal(b.agile.logins, 1);
});

test('the session store: a refresh asked for after a reset does not join one queued before it, which reads before the removal', async () => {
  // The first write is slow, so the refresh asked for next is still queued (its read not begun) when the reset comes.
  const vault = memoryVault([300]);
  const store = new SessionStore(SESSION, 'binding-1', vault, () => {});
  await store.ready();
  store.set({ ...store.state, token: 'd00dfeedd00dfeedd00dfeed' });
  const written = store.persist();
  const before = store.refresh();
  const cleared = store.clear();
  // Another process writes right after the removal lands.
  const remove = vault.remove.bind(vault);
  vault.remove = async (name) => {
    const removed = await remove(name);
    vault.entries.set(SESSION, session('beefbeefbeefbeefbeefbeef', { generation: 'another-process-0013' }));
    return removed;
  };
  const after = store.refresh();
  assert.notEqual(after, before, 'not joined across the reset');
  await written;
  assert.equal(await before, false, 'its read came before the removal: the reset wins');
  await cleared;
  assert.equal(await after, true, 'its read came after the removal and finds the later write');
  assert.equal(store.state.token, 'beefbeefbeefbeefbeefbeef');
});

test('a reset made while a refresh is reading the entry wins over what that read finds', async () => {
  const b = await bed();
  b.vault.entries.set(SESSION, session('a1b2c3d4e5f6a7b8c9d0e1f2'));
  const m = b.manager();
  assert.equal((await m.token()).token, ["a1b2c3","d4e5f6","a7b8c9","d0e1f2"].join(''));
  // Another process stops; this one holds a usable token, so it reads nothing until its status is asked for.
  b.vault.entries.set(SESSION, session('', { token: null, stopped: true, failed_at: 2, failure: 'LOGIN_FAILED:1005', generation: 'another-process-0009' }));
  const held = holdRead(b.vault, SESSION, 1);
  const status = m.status();
  await until(held.reached, 'the read of the entry');
  const reset = m.reset();
  held.release();
  await status;
  await reset;
  assert.equal(b.vault.entries.has(SESSION), false, 'the reset removed the entry');
  assert.equal((await m.status()).stopped, false, 'the reset wins over the stop that read found');
  assert.ok((await m.token()).token);
  assert.equal(b.agile.logins, 1, 'one attempt after the reset');
});

// ---------------------------------------------------------------- a login in flight, seen by other processes

test('another process waits for a login in flight instead of sending the same password: the refusal stops both, after one attempt', async () => {
  const b = await bed({ loginDelayMs: 800 });
  b.agile.setPassword('Changed#Pass99');
  const hub = b.manager();
  const other = b.manager();
  const first = later(hub.token());
  await until(() => b.agile.logins === 1, 'the login at the source');
  const marked = JSON.parse(b.vault.entries.get(SESSION) ?? '{}') as { login_until?: number };
  assert.ok(typeof marked.login_until === 'number' && marked.login_until > b.clock.now, 'the login is marked in the entry before it is sent');
  const second = later(other.token());
  await assert.rejects(first, stopped);
  await assert.rejects(second, stopped);
  assert.equal(b.agile.logins, 1, 'one attempt for both processes');
  assert.ok(b.log.some((event) => event.event === 'login_waiting'));
  assert.equal(JSON.parse(b.vault.entries.get(SESSION) ?? '{}').login_until, null, 'the result replaces the mark');
});

test('another process waits for a login in flight and uses the token it brings', async () => {
  const b = await bed({ loginDelayMs: 500 });
  const hub = b.manager();
  const other = b.manager();
  const first = hub.token();
  await until(() => b.agile.logins === 1, 'the login at the source');
  const [one, two] = await Promise.all([other.token(), other.token()]);
  assert.equal(one.token, (await first).token);
  assert.equal(two.token, one.token);
  assert.equal(b.agile.logins, 1);
  // An "expired" answer to a confirmed token in the waiting process meets the other process's renewal the same way.
  await hub.confirmed(one.token);
  b.agile.expireTokens();
  const renewal = hub.expired(one.token);
  await until(() => b.agile.logins === 2, 'the renewal at the source');
  assert.equal(await other.expired(one.token), await renewal);
  assert.equal(b.agile.logins, 2);
});

test('a login is marked when it is decided; one that a reset overtakes before it is sent is not sent at all', async () => {
  const b = await bed();
  b.vault.entries.set(SESSION, session('a1b2c3d4e5f6a7b8c9d0e1f2'));
  const m = b.manager();
  const held = holdRead(b.vault, CREDENTIALS.username, 1);
  const renewal = later(m.expired('a1b2c3d4e5f6a7b8c9d0e1f2'));
  await until(held.reached, 'the read of the credentials');
  const marked = JSON.parse(b.vault.entries.get(SESSION) ?? '{}') as { login_until?: number; token?: string | null };
  assert.equal(marked.login_until, b.clock.now + 30_000 + 5_000, 'marked before the credentials are read: the login timeout and 5 s');
  assert.equal(marked.token, null, 'the token being replaced is not left for other processes');
  const reset = m.reset();
  held.release();
  await reset;
  await assert.rejects(renewal, (e: unknown) => dropped(e) && (e as ConnectorError).detail.sent === false);
  assert.equal(b.agile.logins, 0, 'nothing sent once a reset overtook the decision');
  assert.equal(m.attempts, 0);
  assert.ok((await m.token()).token);
  assert.equal(b.agile.logins, 1, 'the next read makes the one attempt');
});

test('a login that is not sent (a credential missing, a plaintext refusal) leaves no mark: another process does not wait for it', async () => {
  const b = await bed();
  b.vault.entries.delete(CREDENTIALS.password);
  const missing = (e: unknown) => e instanceof ConnectorError && e.code === 'CREDENTIAL_MISSING';
  await assert.rejects(b.manager().token(), missing);
  assert.equal(JSON.parse(b.vault.entries.get(SESSION) ?? '{}').login_until, null);
  const started = Date.now();
  await assert.rejects(b.manager().token(), missing);
  assert.ok(Date.now() - started < 1000, 'no wait');
  // Refused before any I/O: plain HTTP to an origin the resource does not allow it for.
  b.vault.entries.set(CREDENTIALS.password, passwordDigest(PASSWORD));
  const strict = new HttpSource({ resource: RES, origins: { 'agile-oauth': b.agile.origin, 'agile-api': b.agile.origin }, allowPlaintext: [], routes: profile.routes, envelope: profile.envelope });
  const m = new LoginManager({ resource: RES, login: LOGIN, credentials: CREDENTIALS, sessionEntry: SESSION, binding: 'binding-1', vault: b.vault, http: strict, now: () => b.clock.now, cooldownMs: 30 * 60_000, expiryMarginMs: 60_000, redactor: new Redactor() });
  await assert.rejects(m.token(), (e: unknown) => e instanceof ConnectorError && e.code === 'PLAINTEXT_REFUSED');
  assert.equal(JSON.parse(b.vault.entries.get(SESSION) ?? '{}').login_until, null);
  assert.equal(m.attempts, 0);
  assert.ok(!b.log.some((event) => event.event === 'login_waiting'));
  assert.equal(b.agile.logins, 0);
});

test('a login that waits long for its request slot writes its mark again, so the mark covers the exchange', async () => {
  const b = await bed({ loginDelayMs: 300 });
  const slow = await startStub(() => ({ ...json({ code: 1000, msg: '', data: { total: 0, list: [] } }), delayMs: 600 }));
  servers.push(slow);
  const http = new HttpSource({
    resource: RES,
    origins: { 'agile-oauth': b.agile.origin, 'agile-api': slow.origin },
    allowPlaintext: [b.agile.origin, slow.origin],
    routes: profile.routes,
    envelope: profile.envelope,
    limits: { concurrency: 1 },
    now: () => b.clock.now,
  });
  const m = new LoginManager({ resource: RES, login: LOGIN, credentials: CREDENTIALS, sessionEntry: SESSION, binding: 'binding-1', vault: b.vault, http, now: () => b.clock.now, cooldownMs: 30 * 60_000, expiryMarginMs: 60_000, redactor: new Redactor() });
  // A read holds the only request slot.
  const occupying = http.request({ route: 'roots', method: 'POST', path: '/agile/get_root_node/', body: { page: 1 }, credential: { name: 'Authorization', value: 'tok-holding-the-only-slot' } });
  const mark = () => (JSON.parse(b.vault.entries.get(SESSION) ?? '{}') as { login_until?: number | null }).login_until ?? null;
  const pending = m.token();
  await until(() => mark() !== null, 'the mark of the decision');
  const first = mark() as number;
  b.clock.now += 20_000;
  await until(() => b.agile.logins === 1, 'the login at the source');
  assert.equal(mark(), first + 20_000, 'written again when the slot came');
  await occupying;
  assert.ok((await pending).token);
  assert.equal(mark(), null, 'the result replaces it');
});

test('a mark whose process is gone stands until its time is up; then one login', async () => {
  const b = await bed();
  b.vault.entries.set(SESSION, session('', { token: null, login_until: b.clock.now + 10_000, generation: 'another-process-0007' }));
  const m = b.manager();
  let settled = false;
  const pending = m.token().finally(() => {
    settled = true;
  });
  await sleep(300);
  assert.equal(settled, false, 'waiting for the other login');
  assert.equal(b.agile.logins, 0);
  b.clock.now += 11_000;
  assert.ok((await pending).token);
  assert.equal(b.agile.logins, 1);
  // A reset ends a wait at once as well.
  b.vault.entries.set(SESSION, session('', { token: null, login_until: b.clock.now + 10_000, generation: 'another-process-0008' }));
  const c = b.manager();
  const waiting = c.token();
  await sleep(150);
  await c.reset();
  assert.ok((await waiting).token);
  assert.equal(b.agile.logins, 2);
  // A mark further away than any login can take (a corrupt or misdated entry) is not a login in flight.
  b.vault.entries.set(SESSION, session('', { token: null, login_until: b.clock.now + 24 * 3600_000, generation: 'another-process-0011' }));
  assert.ok((await b.manager().token()).token);
  assert.equal(b.agile.logins, 3);
});

// ---------------------------------------------------------------- static credentials

test('a reset adopted while a refused static value is compared is not undone by that refusal', async () => {
  const vault = memoryVault();
  const entry = `connector.${RES}.token`;
  vault.entries.set(entry, 'k3y-Wrong-0042');
  // An entry another process left; its removal later is a change this process sees.
  vault.entries.set(SESSION, session('', { token: null, generation: 'another-process-0010' }));
  const credential = new StaticCredential({
    resource: RES,
    credential: 'token',
    entry,
    header: { name: 'X-Api-Key', scheme: 'bearer' },
    sessionEntry: SESSION,
    binding: 'binding-1',
    vault,
    now: () => Date.now(),
    redactor: new Redactor(),
  });
  const header = await credential.acquire();
  const held = holdRead(vault, entry, 1);
  const refusal = credential.refused(new ConnectorError('SOURCE_LOGIN_EXPIRED', '来源答 401', { layer: 'transport', detail: { status: 401 } }), header);
  await until(held.reached, 'the comparison of the value');
  vault.entries.delete(SESSION);
  assert.equal((await credential.status()).stopped, false, 'the removal elsewhere is adopted');
  held.release();
  await assert.rejects(refusal, (e: unknown) => e instanceof ConnectorError && e.code === 'CREDENTIAL_REFUSED' && e.detail.stopped === false);
  assert.equal((await credential.status()).stopped, false);
  assert.equal(vault.entries.has(SESSION), false, 'no stop is stored over the reset');
});
