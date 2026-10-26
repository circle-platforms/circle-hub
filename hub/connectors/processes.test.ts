import { addSyntheticResource, setSyntheticCredential, setSyntheticCredentials } from './testing/credentials.ts';
// The running Hub and the CLI are two processes over one records kit and one vault; here they are two connector instances
// (the kit's, and ones made with `make()`, each with its own memory). The running Hub ends a stop it holds in memory when
// the CLI resets the login or sets a credential: it reads the session entry again before it refuses, so its next read logs
// in once, however many reads arrive together. Nothing else ends a stop: not time, not the other process's reads or status.
// Both processes share one renewal and one stop, and a read of one process that needs a login while the other's is in
// flight waits for it. A login or a static request in flight when the CLI sets a new value keeps no result. Two
// credentials set in one call end a stop with one login that carries both. Static credentials (an API key) stop and resume
// the same way, and a value one process was refused for is not sent by the other.
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, before, test } from 'node:test';
import type { ResourceRecord } from '../../contracts/src/resources.ts';
import type { ExternalRead } from '../ports.ts';
import { startPostgres, type TemporaryPostgres } from '../testing/postgres.ts';
import { agileFixture, passwordDigest, startAgileStub, type AgileStub } from './testing/agile.ts';
import { openConnectorKit, type ConnectorKit } from './testing/kit.ts';
import { DOCSTORE_FUNCTIONS, keyedStoreSystem, writePack } from './testing/packs.ts';
import { startStub, text, type StubServer } from './testing/stub.ts';

let postgres: TemporaryPostgres;
before(async () => {
  postgres = await startPostgres();
});
after(() => postgres?.stop());

const DOC = 'q7w2e9r4t1y8';
const PASSWORD = 'Synthetic#Pass42';
const CHANGED = 'Changed#Pass99';
const RIGHT_KEY = 'k3y-Right-0042';
const WRONG_KEY = ["k3y-Wr","ong-00","42"].join('');

type Connectors = ConnectorKit['connectors'];

const ok = (read: ExternalRead) => assert.equal(read.ok, true, read.ok ? '' : read.reason);

function failure(read: ExternalRead, pattern: RegExp): void {
  assert.equal(read.ok, false);
  assert.match((read as { reason: string }).reason, pattern);
}

/** Waits until `condition` holds (a request has reached a stub, say), at most 10 s. */
async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

interface AgileSetting {
  k: ConnectorKit;
  agile: AgileStub;
  resource: ResourceRecord;
  /** A read through the running Hub, or through another process's connectors. */
  read: (connectors?: Connectors) => Promise<ExternalRead>;
}

/** The agile-like source and a resource whose stored password is `stored` (the source expects PASSWORD at first). */
async function agileSetting(t: { after: (fn: () => Promise<void>) => void }, options: { stored?: string; loginDelayMs?: number } = {}): Promise<AgileSetting> {
  const k = await openConnectorKit(postgres);
  const agile = await startAgileStub({ ...agileFixture(DOC, { password: PASSWORD }), loginDelayMs: options.loginDelayMs, now: () => k.clock.now().getTime() });
  t.after(async () => {
    await agile.close();
    await k.close();
  });
  const resource = await addSyntheticResource(k.records, k.packs, k.connectors, k.admin, {
    system_pack: 'agile-test',
    name: '合成敏捷平台',
    environment: 'test',
    origins: { 'agile-oauth': agile.origin, 'agile-api': agile.origin },
    allow_plaintext: [agile.origin],
    settings: { roots: ['7714'] },
  });
  await setSyntheticCredential(k.records, k.connectors, k.admin, resource.id, 'username', 'reader');
  await setSyntheticCredential(k.records, k.connectors, k.admin, resource.id, 'password', options.stored ?? PASSWORD);
  const read = (connectors: Connectors = k.connectors) => connectors.reader.read('agile:tree:7714', { principal: k.user, purpose: 'test' });
  return { k, agile, resource, read };
}

interface KeyedSetting {
  k: ConnectorKit;
  store: StubServer;
  resource: ResourceRecord;
  read: (connectors?: Connectors) => Promise<ExternalRead>;
}

/**
 * A document store behind an API key: RIGHT_KEY is answered (until `revoked.now` is set), anything else gets 401 (after
 * `refusalDelayMs`).
 */
async function keyedSetting(t: { after: (fn: () => Promise<void>) => void }, stored: string, refusalDelayMs = 0, revoked = { now: false }): Promise<KeyedSetting> {
  const k = await openConnectorKit(postgres);
  const store = await startStub((request) =>
    request.headers['x-api-key'] === `Bearer ${RIGHT_KEY}` && !revoked.now
      ? text('# 正文\n', 'text/markdown; charset=utf-8')
      : { ...text('unauthorized', 'text/plain', 401), delayMs: refusalDelayMs },
  );
  t.after(async () => {
    await store.close();
    await k.close();
  });
  k.packs.set(await writePack(k.packRoot, { id: 'keyed-store', system: keyedStoreSystem(), functions: DOCSTORE_FUNCTIONS }));
  const resource = await addSyntheticResource(k.records, k.packs, k.connectors, k.admin, { system_pack: 'keyed-store', name: '带密钥的手册库', environment: 'test', origins: { 'manual-store': store.origin }, allow_plaintext: [store.origin] });
  await setSyntheticCredential(k.records, k.connectors, k.admin, resource.id, 'token', stored);
  const read = (connectors: Connectors = k.connectors) => connectors.reader.read('manual:file:spec/a.md', { principal: k.user, purpose: 'test' });
  return { k, store, resource, read };
}

test('a stop the running Hub holds ends when the CLI resets the login: its next read logs in once, and only once', async (t) => {
  const { k, agile, resource, read } = await agileSetting(t);
  ok(await read());
  assert.equal(agile.logins, 1);
  // The source stops accepting the stored password: one attempt, then the running Hub holds a stop.
  agile.setPassword(CHANGED);
  agile.expireTokens();
  failure(await read(), /LOGIN_FAILED/);
  assert.equal(agile.logins, 2);
  const sent = agile.requests.length;
  for (let i = 0; i < 3; i++) failure(await read(), /登录已停止/);
  k.clock.advance(7 * 24 * 3600_000);
  failure(await read(), /登录已停止/);
  // The CLI looks (a status, a read of its own): it finds the stop, sends nothing and ends nothing.
  const cli = k.make();
  assert.equal((await cli.admin.loginStatus(k.admin, resource.id))?.stopped, true);
  failure(await read(cli), /登录已停止/);
  failure(await read(), /登录已停止/);
  assert.equal(agile.requests.length, sent, 'nothing at all is sent by either process while stopped, however long');
  // The account works again at the source; an admin resets the login from the CLI (a process without the Hub's memory).
  agile.setPassword(PASSWORD);
  await k.make().admin.resetLogin(k.admin, resource.id);
  assert.ok(k.log.some((event) => event.event === 'login_reset'));
  const status = await k.connectors.admin.loginStatus(k.admin, resource.id);
  assert.equal(status?.stopped, false, 'the running Hub shows the reset at once');
  assert.equal(status?.token, false);
  assert.equal(agile.logins, 2, 'a status logs in nothing');
  ok(await read());
  assert.equal(agile.logins, 3, 'one login on the next read');
  for (let i = 0; i < 3; i++) ok(await read());
  assert.equal(agile.logins, 3, 'and only one');
  // The CLI instance that saw the stop ends it too at its next read, with the running Hub's token.
  ok(await read(cli));
  assert.equal(agile.logins, 3);
});

test('after a reset from the CLI two reads that come together share one login, whether it succeeds or is refused again', async (t) => {
  const { k, agile, resource, read } = await agileSetting(t, { stored: CHANGED });
  failure(await read(), /LOGIN_FAILED/);
  assert.equal(agile.logins, 1);
  // This time the CLI's own runtime holds the session (it showed the status first), and the reset goes through it.
  const cli = k.make();
  assert.equal((await cli.admin.loginStatus(k.admin, resource.id))?.stopped, true);
  agile.setPassword(CHANGED);
  await cli.admin.resetLogin(k.admin, resource.id);
  (await Promise.all([read(), read()])).forEach(ok);
  assert.equal(agile.logins, 2, 'one login for both reads');
  // Refused again after the next reset: one attempt with the stored credential for both reads, then a stop again.
  agile.setPassword(PASSWORD);
  agile.expireTokens();
  failure(await read(), /LOGIN_FAILED/);
  assert.equal(agile.logins, 3);
  await k.make().admin.resetLogin(k.admin, resource.id);
  for (const outcome of await Promise.all([read(), read()])) failure(outcome, /LOGIN_FAILED/);
  assert.equal(agile.logins, 4, 'one attempt for the pair');
  failure(await read(), /登录已停止/);
  assert.equal(agile.logins, 4, 'stopped again until the next admin action');
});

test('a new password set from the CLI ends the stop; the other process takes the token instead of logging in, and one stop holds for both', async (t) => {
  const { k, agile, resource, read } = await agileSetting(t);
  const other = k.make();
  ok(await read());
  ok(await read(other));
  assert.equal(agile.logins, 1, 'the other process takes the token from the vault');
  agile.expireTokens();
  ok(await read());
  ok(await read(other));
  assert.equal(agile.logins, 2, 'one renewal for both processes');
  agile.setPassword(CHANGED);
  agile.expireTokens();
  failure(await read(), /LOGIN_FAILED/);
  failure(await read(other), /登录已停止/);
  assert.equal(agile.logins, 3, 'a refused password is tried once across both processes');
  assert.equal((await other.admin.loginStatus(k.admin, resource.id))?.stopped, true);
  // A third process (the CLI) sets the new password: both stops end; one login, the other process uses its token.
  await setSyntheticCredential(k.records, k.make(), k.admin, resource.id, 'password', CHANGED);
  ok(await read());
  ok(await read(other));
  assert.equal(agile.logins, 4);
  ok(await read());
  assert.equal(agile.logins, 4);
});

test('a login in flight finishes on its captured version and cannot stop the next credential version', async (t) => {
  const { k, agile, resource, read } = await agileSetting(t, { stored: 'Old#Pass00', loginDelayMs: 1000 });
  agile.setPassword(CHANGED);
  const pending = read();
  await until(() => agile.logins === 1, 'the login at the source');
  await setSyntheticCredential(k.records, k.make(), k.admin, resource.id, 'password', CHANGED);
  failure(await pending, /LOGIN_FAILED/);
  assert.equal((await k.connectors.admin.loginStatus(k.admin, resource.id))?.stopped, false, 'refused with a value that is gone: nothing stopped');
  ok(await read());
  assert.equal(agile.logins, 2, 'one login, with the new value');
});

test('a static credential the source refused: it stays stopped in both processes and over time; a reset from the CLI allows one attempt, a changed value ends the stop', async (t) => {
  const { k, store, resource, read } = await keyedSetting(t, WRONG_KEY);
  failure(await read(), /CREDENTIAL_REFUSED/);
  assert.equal(store.requests.length, 1);
  for (let i = 0; i < 3; i++) failure(await read(), /CREDENTIAL_REFUSED/);
  k.clock.advance(7 * 24 * 3600_000);
  failure(await read(), /CREDENTIAL_REFUSED/);
  const cli = k.make();
  assert.equal((await cli.admin.loginStatus(k.admin, resource.id))?.stopped, true);
  failure(await read(cli), /CREDENTIAL_REFUSED/);
  assert.equal(store.requests.length, 1, 'neither process sends the refused value again');
  // A reset from the CLI without a new value: one attempt with the stored value, refused, stopped again.
  await k.make().admin.resetLogin(k.admin, resource.id);
  failure(await read(), /CREDENTIAL_REFUSED/);
  assert.equal(store.requests.length, 2);
  failure(await read(), /CREDENTIAL_REFUSED/);
  assert.equal(store.requests.length, 2);
  // A changed value set from the CLI: the running Hub sends it at its next read.
  await setSyntheticCredential(k.records, k.make(), k.admin, resource.id, 'token', RIGHT_KEY);
  ok(await read());
  assert.equal(store.requests.length, 3);
  assert.equal(store.requests[2].headers['x-api-key'], `Bearer ${RIGHT_KEY}`);
  ok(await read());
  // The CLI instance that saw the stop ends it too.
  ok(await read(cli));
  assert.equal(store.requests.length, 5);
  assert.ok(store.requests.slice(2).every((request) => request.headers['x-api-key'] === `Bearer ${RIGHT_KEY}`));
});

test('after a value was accepted, a value the CLI sets goes out one request at a time until it is answered: a wrong one is refused once', async (t) => {
  const { k, store, resource, read } = await keyedSetting(t, RIGHT_KEY, 300);
  ok(await read());
  ok(await read());
  assert.equal(store.requests.length, 2);
  await setSyntheticCredential(k.records, k.make(), k.admin, resource.id, 'token', WRONG_KEY);
  for (const outcome of await Promise.all([read(), read(), read()])) failure(outcome, /CREDENTIAL_REFUSED/);
  const carried = store.requests.filter((request) => request.headers['x-api-key'] === `Bearer ${WRONG_KEY}`);
  assert.equal(carried.length, 1, 'one request carried the new value, not one per read in flight');
  assert.equal((await k.connectors.admin.loginStatus(k.admin, resource.id))?.stopped, true);
});

test('a static request in flight is refused on its captured version and the next read sends the new version', async (t) => {
  const { k, store, resource, read } = await keyedSetting(t, WRONG_KEY, 1000);
  const pending = read();
  await until(() => store.requests.length === 1, 'the request at the source');
  await setSyntheticCredential(k.records, k.make(), k.admin, resource.id, 'token', RIGHT_KEY);
  failure(await pending, /CREDENTIAL_REFUSED/);
  assert.equal((await k.connectors.admin.loginStatus(k.admin, resource.id))?.stopped, false);
  ok(await read());
  assert.equal(store.requests.length, 2);
  assert.equal(store.requests[1].headers['x-api-key'], `Bearer ${RIGHT_KEY}`);
});

test('a static value both processes had accepted and the source then refuses: the other process keeps the stop instead of sending the value again', async (t) => {
  const revoked = { now: false };
  const { k, store, resource, read } = await keyedSetting(t, RIGHT_KEY, 0, revoked);
  const other = k.make();
  ok(await read());
  ok(await read(other));
  revoked.now = true;
  const before = store.requests.length;
  failure(await read(), /CREDENTIAL_REFUSED/);
  assert.equal((await k.connectors.admin.loginStatus(k.admin, resource.id))?.stopped, true);
  failure(await read(other), /CREDENTIAL_REFUSED/);
  failure(await read(other), /CREDENTIAL_REFUSED/);
  assert.equal(store.requests.length - before, 1, 'the refused value went out once in total');
});

test('a refused static value is not sent by a process that loaded its state before the refusal', async (t) => {
  const { k, store, resource, read } = await keyedSetting(t, WRONG_KEY);
  const other = k.make();
  assert.equal((await other.admin.loginStatus(k.admin, resource.id))?.stopped, false, 'loaded before the refusal');
  failure(await read(), /CREDENTIAL_REFUSED/);
  failure(await read(other), /CREDENTIAL_REFUSED/);
  assert.equal(store.requests.length, 1, 'one refusal in total');
});

test('reads of two processes that overlap one refused login: one attempt in total, both stopped', async (t) => {
  // The login answer waits long enough that the other read (its planner runs in the sandbox first) asks while it is out.
  const { k, agile, resource, read } = await agileSetting(t, { stored: CHANGED, loginDelayMs: 1500 });
  const other = k.make();
  const first = read();
  await until(() => agile.logins === 1, 'the login at the source');
  const second = read(other);
  failure(await first, /LOGIN_FAILED/);
  failure(await second, /登录已停止/);
  assert.equal(agile.logins, 1, 'the other process waited for the login in flight instead of sending the same password');
  assert.equal((await other.admin.loginStatus(k.admin, resource.id))?.stopped, true);
  const count=agile.requests.length;failure(await read(other),/LOGIN_FAILED/);assert.equal(agile.requests.length,count,'shared stop persists after both overlapping reads finish');
});

test('two credentials set in one call: the stop ends once both are stored, and the one login carries both new values', async (t) => {
  const k = await openConnectorKit(postgres);
  const agile = await startAgileStub({ ...agileFixture(DOC, { username: 'reader2', password: CHANGED }), now: () => k.clock.now().getTime() });
  t.after(async () => {
    await agile.close();
    await k.close();
  });
  const resource = await addSyntheticResource(k.records, k.packs, k.connectors, k.admin, {
    system_pack: 'agile-test',
    name: '合成敏捷平台',
    environment: 'test',
    origins: { 'agile-oauth': agile.origin, 'agile-api': agile.origin },
    allow_plaintext: [agile.origin],
    settings: { roots: ['7714'] },
  });
  await setSyntheticCredentials(k.records, k.connectors, k.admin, resource.id, { username: 'reader', password: PASSWORD });
  const read = () => k.connectors.reader.read('agile:tree:7714', { principal: k.user, purpose: 'test' });
  failure(await read(), /LOGIN_FAILED/);
  failure(await read(), /登录已停止/);
  await setSyntheticCredentials(k.records, k.make(), k.admin, resource.id, { username: 'reader2', password: CHANGED });
  ok(await read());
  const logins = agile.requests.filter((request) => request.path === '/oauth/login/').map((request) => request.json as { username: string; password: string });
  assert.deepEqual(logins, [
    { username: 'reader', password: passwordDigest(PASSWORD) },
    { username: 'reader2', password: passwordDigest(CHANGED) },
  ]);
  assert.deepEqual((await k.records.variables.list(k.admin)).map(v=>v.version),[2,2],'each named credential has two versions');
});
