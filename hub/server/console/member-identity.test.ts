import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { AccessError, ConflictError } from '../../records/api.ts';
import { handleConsole, type ConsoleOptions } from './index.ts';
import { JobStore } from './manage.ts';
import { IdentityChallenges } from './member-identity.ts';
import { SessionStore } from './session.ts';
import { PackStaging } from './staging.ts';
import { identityProfileName } from '../personal-bot.ts';
import { createTestServer, testConsoleCredentials, type TestServer } from '../testing.ts';

interface HttpReply {
  status: number;
  body: string;
  headers: Record<string, string | string[] | undefined>;
}

async function sendPeer(
  origin: string,
  path: string,
  peer: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<HttpReply> {
  return new Promise((resolve, reject) => {
    const req = request(
      new URL(path, origin),
      {
        method: init.method ?? 'GET',
        agent: false,
        headers: {
          'x-synthetic-peer': peer,
          ...(init.headers ?? {}),
        },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode!, body, headers: res.headers }));
      },
    );
    req.on('error', reject);
    req.end(init.body);
  });
}

function setCookiesOf(res: HttpReply): string[] {
  const raw = res.headers['set-cookie'];
  return Array.isArray(raw) ? raw : raw ? [raw] : [];
}

function firstCookie(res: HttpReply): string {
  return setCookiesOf(res)[0]?.split(';')[0] ?? '';
}

let hub: TestServer;
let adapter: ReturnType<typeof createServer>;
let fixture: ReturnType<typeof createServer>;
let origin = '';
let secureFlag = false;
let injectedBindError: Error | null = null;
const logs: string[] = [];
let sessionCookie = '';

before(async () => {
  hub = await createTestServer();
  const member = await hub.createUser('扫码审查成员');

  adapter = createServer(async (req, res) => {
    const parts: Buffer[] = [];
    for await (const part of req) parts.push(part);
    const input = JSON.parse(Buffer.concat(parts).toString()) as { action: string; state?: string };
    res.end(
      JSON.stringify(
        input.action === 'qr'
          ? { location: 'https://login.example.invalid/?state=' + input.state }
          : { subject: 'synthetic-subject-1' },
      ),
    );
  });
  const botDir = join(hub.deps.config.dataDir, 'bot-runtime');
  await mkdir(botDir, { recursive: true, mode: 0o700 });
  await new Promise<void>((r) => adapter.listen(join(botDir, 'channel.sock'), r));

  await hub.records.vault.put(
    identityProfileName,
    JSON.stringify({ tenant: 'demo', application: 'app', secret: 'test-app-secret' }),
  );

  const wrappedPrincipals: typeof hub.deps.records.principals = new Proxy(hub.deps.records.principals, {
    get(target, prop) {
      if (prop === 'bindExternalIdentity') {
        return async (...args: Parameters<typeof target.bindExternalIdentity>) => {
          if (injectedBindError) throw injectedBindError;
          return target.bindExternalIdentity(...args);
        };
      }
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const options: ConsoleOptions = {
    deps: {
      ...hub.deps,
      records: { ...hub.deps.records, principals: wrappedPrincipals },
    },
    sessions: new SessionStore(),
    ownOrigins: () => new Set([origin]),
    secureRequest: () => secureFlag,
    log: (line) => logs.push(line),
    jobs: new JobStore(),
    staging: new PackStaging(),
    identityChallenges: new IdentityChallenges(),
  };

  fixture = createServer((req, res) => {
    Object.defineProperty(req.socket, 'remoteAddress', {
      configurable: true,
      value: req.headers['x-synthetic-peer'] ?? '127.0.0.1',
    });
    handleConsole(req, res, new URL(req.url!, origin), options).catch((error) => {
      res.statusCode = 500;
      res.end(String(error));
    });
  });
  fixture.listen(0, '127.0.0.1');
  await once(fixture, 'listening');
  const addr = fixture.address();
  assert.ok(addr && typeof addr !== 'string');
  origin = `http://127.0.0.1:${addr.port}`;

  const loginPage = await sendPeer(origin, '/console/login', '192.0.2.30');
  const loginCsrf = /name="csrf" value="([^"]+)"/.exec(loginPage.body)![1];
  const signedIn = await sendPeer(origin, '/console/login', '192.0.2.30', {
    method: 'POST',
    headers: {
      origin,
      cookie: firstCookie(loginPage),
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ ...testConsoleCredentials(member.token), csrf: loginCsrf }).toString(),
  });
  assert.equal(signedIn.status, 303);
  sessionCookie = setCookiesOf(signedIn).find((c) => c.startsWith('circle_hub_session='))!.split(';')[0];
});

after(async () => {
  await new Promise<void>((resolve) => fixture?.close(() => resolve()));
  await new Promise<void>((resolve) => adapter?.close(() => resolve()));
  await hub?.close();
});

test('H8: identity flow uses hub_identity and __Secure-hub_identity cookies instead of circle_identity', async () => {
  secureFlag = false;
  const insecureStart = await sendPeer(origin, '/console/identity/login', '192.0.2.20');
  assert.equal(insecureStart.status, 303);
  assert.ok(
    setCookiesOf(insecureStart).some((c) => c.startsWith('hub_identity=')),
    `expected hub_identity cookie, got: ${setCookiesOf(insecureStart).join(', ')}`,
  );
  assert.ok(!setCookiesOf(insecureStart).some((c) => c.includes('circle_identity')));

  secureFlag = true;
  const secureStart = await sendPeer(origin, '/console/identity/login', '192.0.2.21');
  assert.equal(secureStart.status, 303);
  assert.ok(
    setCookiesOf(secureStart).some((c) => c.startsWith('__Secure-hub_identity=')),
    `expected __Secure-hub_identity cookie, got: ${setCookiesOf(secureStart).join(', ')}`,
  );
  secureFlag = false;
});

test('H15: callback maps bindExternalIdentity ConflictError/AccessError to 403 and unexpected DB errors to logged 503', async () => {
  const startBind = async () => {
    const settingsRes = await sendPeer(origin, '/console/settings', '192.0.2.30', {
      headers: { cookie: sessionCookie },
    });
    const settingsCsrf = /name="csrf" value="([^"]+)"/.exec(settingsRes.body)![1];
    const begin = await sendPeer(origin, '/console/identity/bind', '192.0.2.30', {
      method: 'POST',
      headers: {
        origin,
        cookie: sessionCookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ csrf: settingsCsrf }).toString(),
    });
    assert.equal(begin.status, 303);
    const state = new URL(String(begin.headers.location)).searchParams.get('state')!;
    const bindCookie = firstCookie(begin);
    return { state, cookie: `${sessionCookie}; ${bindCookie}` };
  };

  try {
    const b1 = await startBind();
    logs.length = 0;
    injectedBindError = new Error('simulated postgres connection lost');
    const dbFail = await sendPeer(origin, `/console/identity/callback?code=c1&state=${b1.state}`, '192.0.2.30', {
      headers: { cookie: b1.cookie },
    });
    assert.equal(dbFail.status, 503, 'DB failure must return 503, not 403');
    assert.match(dbFail.body, /服务暂时不可用，请稍后重试/);
    assert.ok(logs.some((line) => /simulated postgres connection lost/.test(line)), 'DB failure must be logged');

    const b2 = await startBind();
    injectedBindError = new ConflictError('此身份或当前成员已有不同绑定');
    const conflictFail = await sendPeer(origin, `/console/identity/callback?code=c2&state=${b2.state}`, '192.0.2.30', {
      headers: { cookie: b2.cookie },
    });
    assert.equal(conflictFail.status, 403);

    const b3 = await startBind();
    injectedBindError = new AccessError('身份未授权');
    const accessFail = await sendPeer(origin, `/console/identity/callback?code=c3&state=${b3.state}`, '192.0.2.30', {
      headers: { cookie: b3.cookie },
    });
    assert.equal(accessFail.status, 403);

    injectedBindError = null;
    const b4 = await startBind();
    const okRes = await sendPeer(origin, `/console/identity/callback?code=c4&state=${b4.state}`, '192.0.2.30', {
      headers: { cookie: b4.cookie },
    });
    assert.equal(okRes.status, 303);
  } finally {
    injectedBindError = null;
  }
});

test('H6 + S13: exceeding STATES_PER_PEER (20) returns 429 without evicting valid states and leaves Peer B unaffected', async () => {
  const peerAStates: Array<{ state: string; cookie: string }> = [];
  for (let i = 0; i < 20; i++) {
    const res = await sendPeer(origin, '/console/identity/login', '192.0.2.10');
    assert.equal(res.status, 303, `peer A request #${i + 1} within cap should return 303`);
    peerAStates.push({
      state: new URL(String(res.headers.location)).searchParams.get('state')!,
      cookie: firstCookie(res),
    });
  }
  const overLimit = await sendPeer(origin, '/console/identity/login', '192.0.2.10');
  assert.equal(overLimit.status, 429, '21st concurrent state from Peer A must return 429 instead of evicting');

  const peerBRes = await sendPeer(origin, '/console/identity/login', '192.0.2.22');
  assert.equal(peerBRes.status, 303, 'Peer B must still get 303 while Peer A is capped at 20');

  // Consume Peer A's first state (proving it was NOT evicted) -> drops Peer A count to 19
  const first = peerAStates[0]!;
  const consumed = await sendPeer(origin, `/console/identity/callback?code=c&state=${first.state}`, '192.0.2.10', {
    headers: { cookie: first.cookie },
  });
  assert.equal(consumed.status, 303, 'first state remained valid (not evicted) and completed callback');

  const afterConsume = await sendPeer(origin, '/console/identity/login', '192.0.2.10');
  assert.equal(afterConsume.status, 303, 'Peer A can issue a fresh state once one pending challenge is consumed');
});
