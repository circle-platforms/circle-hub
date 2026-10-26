import { addSyntheticResource, setSyntheticCredential, setSyntheticCredentials, syntheticStoredCredential } from './testing/credentials.ts';
// Login (D01 R[9]) through real reads against the agile-like stub: one login, the token reused from memory and from the
// vault, one login after an explicit expired answer, a refused login never retried (stopped until an admin acts), a token
// refused right after its login, shared logins, renewal at a known expiry and none at an unusable one, resource updates that
// change what the session depends on, and no secret in any log, record or object.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { RECORD_KINDS } from '../../contracts/generated/protocol.ts';
import type { ResourceRecord } from '../../contracts/src/resources.ts';
import type { ExternalRead } from '../ports.ts';
import type { Page, StoredRecord } from '../records/api.ts';
import { startPostgres, type TemporaryPostgres } from '../testing/postgres.ts';
import { agileFixture, startAgileStub, type AgileStub } from './testing/agile.ts';
import { openConnectorKit, type ConnectorKit } from './testing/kit.ts';
import { AGILE_FUNCTIONS, agileSystem, writePack } from './testing/packs.ts';

let postgres: TemporaryPostgres;
before(async () => {
  postgres = await startPostgres();
});
after(() => postgres?.stop());

const DOC = 'q7w2e9r4t1y8';
const PASSWORD = 'Synthetic#Pass42';

interface Setting {
  k: ConnectorKit;
  agile: AgileStub;
  resource: ResourceRecord;
  read: (connectors?: ConnectorKit['connectors']) => Promise<ExternalRead>;
}

async function setup(t: { after: (fn: () => Promise<void>) => void }, options: { lifetime?: number; plaintext?: boolean; credentials?: boolean } = {}): Promise<Setting> {
  const k = await openConnectorKit(postgres);
  const agile = await startAgileStub({ ...agileFixture(DOC, { password: PASSWORD }), tokenLifetimeSeconds: options.lifetime, now: () => k.clock.now().getTime() });
  t.after(async () => {
    await agile.close();
    await k.close();
  });
  const resource = await addSyntheticResource(k.records, k.packs, k.connectors, k.admin, {
    system_pack: 'agile-test',
    name: '合成敏捷平台',
    environment: 'test',
    origins: { 'agile-oauth': agile.origin, 'agile-api': agile.origin },
    allow_plaintext: options.plaintext === false ? [] : [agile.origin],
    settings: { roots: ['7714'] },
  });
  if (options.credentials !== false) {
    await setSyntheticCredential(k.records, k.connectors, k.admin, resource.id, 'username', 'reader');
    await setSyntheticCredential(k.records, k.connectors, k.admin, resource.id, 'password', PASSWORD);
  }
  const read = (connectors = k.connectors) => connectors.reader.read('agile:tree:7714', { principal: k.user, purpose: 'test' });
  return { k, agile, resource, read };
}

const ok = (read: ExternalRead) => assert.equal(read.ok, true, read.ok ? '' : read.reason);

test('one login; the token is reused from memory, and from the vault after a restart; the vault holds it sealed', async (t) => {
  const { k, agile, read } = await setup(t);
  ok(await read());
  assert.equal(agile.logins, 1);
  ok(await read());
  assert.equal(agile.logins, 1, 'no second login while the token is good');
  ok(await read(k.make()));
  assert.equal(agile.logins, 1, 'a restarted Hub takes the token from the vault');
  const token = [...agile.tokens][0];
  const vaultFiles = await readdir(join(k.records.dataDir, 'vault'));
  for (const file of vaultFiles) {
    const bytes = await readFile(join(k.records.dataDir, 'vault', file));
    assert.ok(!bytes.includes(Buffer.from(token)), `${file} holds the token in the clear`);
    assert.ok(!bytes.includes(Buffer.from(PASSWORD)), `${file} holds the password in the clear`);
  }
});

test('an explicit expired answer: one login, then the request once more', async (t) => {
  const { k, agile, read } = await setup(t);
  ok(await read());
  agile.expireTokens();
  const again = await read();
  ok(again);
  assert.equal(agile.logins, 2);
  const manifest = await k.records.store.get<{ requests: { key: string; error: string | null; after_login: boolean }[] }>((again as { manifest: string }).manifest);
  const entries=manifest!.body.requests;
  assert.ok(entries.some(entry=>entry.error==='SOURCE_LOGIN_EXPIRED'),'the source explicitly refused an expired token');
  assert.ok(entries.some(entry=>entry.after_login),'a refused request was repeated after renewal');
  for(const key of new Set(entries.map(entry=>entry.key))) {
    const requests=entries.filter(entry=>entry.key===key);
    assert.ok(requests.length<=2,'each request is retried at most once');
    if(requests.length===2)assert.deepEqual(requests.map(entry=>[entry.error,entry.after_login]),[['SOURCE_LOGIN_EXPIRED',false],[null,true]]);
  }
});

test('a refused login is never retried: it stops until an admin acts, however long; a reset allows one attempt, a new credential ends it', async (t) => {
  const { k, agile, resource, read } = await setup(t);
  ok(await read());
  agile.setPassword('Changed#Pass99');
  agile.expireTokens();
  const failed = await read();
  assert.equal(failed.ok, false);
  assert.match((failed as { reason: string }).reason, /LOGIN_FAILED/);
  assert.equal(agile.logins, 2, 'one attempt');
  const before = agile.requests.length;
  for (let i = 0; i < 3; i++) {
    const stopped = await read();
    assert.equal(stopped.ok, false);
    assert.match((stopped as { reason: string }).reason, /停止/);
  }
  k.clock.advance(31 * 60_000);
  assert.equal((await read()).ok, false);
  k.clock.advance(7 * 24 * 3600_000);
  assert.equal((await read()).ok, false);
  assert.equal(agile.requests.length, before, 'while stopped nothing at all is sent, however much time passes');
  assert.equal(agile.logins, 2);
  const status = await k.connectors.admin.loginStatus(k.admin, resource.id);
  assert.equal(status?.stopped, true);
  assert.equal(status?.cooldownUntil, null);
  assert.ok(status?.failure?.startsWith('LOGIN_FAILED'));
  assert.ok(k.log.some((event) => event.event === 'login_stopped'));
  // An explicit reset by an admin: one attempt, which fails again with the same stored password and stops again.
  await assert.rejects(k.connectors.admin.resetLogin(k.user, resource.id), (e: unknown) => (e as { code?: string }).code === 'ACCESS_DENIED');
  await k.connectors.admin.resetLogin(k.admin, resource.id);
  assert.ok(k.log.some((event) => event.event === 'login_reset'));
  assert.equal((await read()).ok, false);
  assert.equal(agile.logins, 3);
  assert.equal((await read()).ok, false);
  assert.equal(agile.logins, 3, 'stopped again');
  await setSyntheticCredential(k.records, k.connectors, k.admin, resource.id, 'password', 'Changed#Pass99');
  ok(await read());
  assert.equal(agile.logins, 4, 'a new credential ends the stop');
});

test('a token answered expired right after its login causes no second login, now or later', async (t) => {
  const { k, agile, read } = await setup(t);
  agile.refuseNewTokens = true;
  const first = await read();
  assert.equal(first.ok, false);
  assert.match((first as { reason: string }).reason, /LOGIN_FAILED/);
  assert.equal(agile.logins, 1);
  assert.equal((await read()).ok, false);
  k.clock.advance(31 * 60_000);
  assert.equal((await read()).ok, false);
  assert.equal(agile.logins, 1, 'none at all until an admin acts');
});

test('a stated expiry inside the renewal margin, or in the past, does not make every read log in', async (t) => {
  const short = await setup(t, { lifetime: 30 });
  for (let i = 0; i < 3; i++) ok(await short.read());
  assert.equal(short.agile.logins, 1, 'one login for three reads of two rounds each');
  assert.ok(short.k.log.some((event) => event.event === 'login_expiry_unusable'));
  const past = await setup(t, { lifetime: -3600 });
  for (let i = 0; i < 3; i++) ok(await past.read());
  assert.equal(past.agile.logins, 1);
});

test('moving a resource to other origins: the cached token never goes there; the new origin gets its own single login', async (t) => {
  const { k, agile, resource, read } = await setup(t);
  ok(await read());
  const oldToken = [...agile.tokens][0];
  const moved = await startAgileStub({ ...agileFixture(DOC, { password: PASSWORD }), now: () => k.clock.now().getTime() });
  t.after(() => moved.close());
  await k.connectors.admin.updateResource(k.admin, resource.id, { origins: { 'agile-oauth': moved.origin, 'agile-api': moved.origin }, allow_plaintext: [moved.origin] });
  assert.equal((await read()).ok,false,'old enrollment cannot send to a new origin');
  assert.equal(moved.requests.length,0);
  await setSyntheticCredentials(k.records,k.connectors,k.admin,resource.id,{username:'reader',password:PASSWORD});
  assert.equal((await k.connectors.admin.loginStatus(k.admin, resource.id))?.token,false);
  ok(await read());
  assert.equal(moved.logins, 1);
  assert.ok(moved.requests.every((r) => r.headers.authorization !== oldToken), 'the old token is never sent to the new origin');
  assert.equal(agile.logins, 1);
});

test('a change that the session does not depend on (name, settings, environment) keeps the token: no extra login', async (t) => {
  const { k, agile, resource, read } = await setup(t);
  ok(await read());
  await k.connectors.admin.updateResource(k.admin, resource.id, { name: '改名的合成敏捷平台', settings: { roots: ['7714', '7001'] }, environment: 'shared' });
  assert.equal((await k.connectors.admin.loginStatus(k.admin, resource.id))?.token, true);
  ok(await read());
  ok(await read(k.make()));
  assert.equal(agile.logins, 1);
});

test('a new system pack digest rule preserves shared secrets and refuses incompatible material', async (t) => {
  const { k, agile, resource, read } = await setup(t);
  ok(await read());
  const system = agileSystem() as { auth: { credentials: { name: string; digest: string }[] } };
  system.auth.credentials = system.auth.credentials.map((c) => (c.name === 'password' ? { ...c, digest: 'plain' } : c));
  k.packs.set(await writePack(k.packRoot, { id: 'agile-test', version: '1.1.0', system, functions: AGILE_FUNCTIONS }));
  k.connectors.refresh();
  const updated = await k.connectors.admin.updateResource(k.admin, resource.id, { system_pack: 'agile-test' });
  assert.equal(updated.system_pack, 'agile-test@1.1.0');
  assert.ok(await syntheticStoredCredential(k.records,updated,'password'),'shared secret is preserved');
  assert.equal(await syntheticStoredCredential(k.records,updated,'username'), 'reader', 'a credential whose rule did not change stays');
  agile.expireTokens();
  const missing = await read();
  assert.equal(missing.ok, false);
  assert.match((missing as { reason: string }).reason, /CREDENTIAL_MISSING/);
  assert.equal(agile.logins, 1, 'no login with a value kept under another rule');
  assert.ok(!k.log.some((event) => event.event === 'credential_dropped'));
});

test('concurrent reads share one login', async (t) => {
  const { agile, read } = await setup(t);
  const all = await Promise.all(Array.from({ length: 5 }, () => read()));
  all.forEach(ok);
  assert.equal(agile.logins, 1);
  agile.expireTokens();
  (await Promise.all(Array.from({ length: 5 }, () => read()))).forEach(ok);
  assert.equal(agile.logins, 2);
});

test('a known expiry time renews the token before use, without an expired answer', async (t) => {
  const { k, agile, read } = await setup(t, { lifetime: 600 });
  ok(await read());
  assert.equal(agile.logins, 1);
  k.clock.advance(11 * 60_000);
  const before = agile.requests.length;
  ok(await read());
  assert.equal(agile.logins, 2);
  assert.equal(agile.requests[before].path, '/oauth/login/', 'the first request after the expiry is the login');
  assert.ok(agile.requests.slice(before).every((r) => r.path === '/oauth/login/' || r.headers.authorization !== undefined));
});

test('missing credentials and plaintext refusal: no login attempt, nothing sent, no cool-down', async (t) => {
  const missing = await setup(t, { credentials: false });
  const r1 = await missing.read();
  assert.equal(r1.ok, false);
  assert.match((r1 as { reason: string }).reason, /CREDENTIAL_MISSING/);
  assert.equal(missing.agile.requests.length, 0);
  const plain = await setup(t, { plaintext: false });
  const r2 = await plain.read();
  assert.equal(r2.ok, false);
  assert.match((r2 as { reason: string }).reason, /PLAINTEXT_REFUSED/);
  assert.equal(plain.agile.requests.length, 0);
  assert.equal((await plain.k.connectors.admin.loginStatus(plain.k.admin, plain.resource.id))?.cooldownUntil, null);
});

test('no secret in any log event, stored object, record or reason', async (t) => {
  const { k, agile, read } = await setup(t);
  const reasons: string[] = [];
  ok(await read());
  ok(await k.connectors.reader.read(`agile:mindmap:${DOC}`, { principal: k.user, purpose: 'test' }));
  agile.expireTokens();
  ok(await read());
  agile.setPassword('Changed#Pass99');
  agile.expireTokens();
  const failed = await read();
  reasons.push((failed as { reason: string }).reason);
  const tokens = new Set(agile.requests.map((r) => r.headers.authorization).filter((v): v is string => typeof v === 'string' && v.length > 0));
  assert.ok(tokens.size >= 2);
  const secrets = [PASSWORD, createHash('sha512').update(PASSWORD).digest('base64'), ...tokens];
  const haystacks: [string, string][] = [
    ['log', JSON.stringify(k.log)],
    ['reasons', JSON.stringify(reasons)],
  ];
  for (const bytes of await k.allObjects()) haystacks.push(['object', bytes.toString('utf8')]);
  for (const kind of RECORD_KINDS) {
    let cursor: string | null = null;
    do {
      const page: Page<StoredRecord> = await k.records.store.list({ kind, limit: 500, cursor });
      for (const record of page.items) haystacks.push([`record ${kind}`, JSON.stringify(record)]);
      cursor = page.next;
    } while (cursor !== null);
  }
  for (const secret of secrets) {
    for (const [where, text] of haystacks) assert.ok(!text.includes(secret), `a secret appears in ${where}`);
  }
  // The login exchange is not stored: no stored answer carries a token field.
  for (const bytes of await k.allObjects()) assert.ok(!bytes.toString('utf8').includes('登录成功'), 'a login answer was stored');
  assert.ok(k.log.some((event) => event.event === 'login_ok') && k.log.some((event) => event.event === 'login_failed'));
});
