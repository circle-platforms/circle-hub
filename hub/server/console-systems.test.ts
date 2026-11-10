// 接入业务系统's 尝试连接 and the reads of the last day, over HTTP with the test server and loopback stubs: the trial through
// POST /console/api/systems/test and the operation's form (system-test), for administrators only, recording the trial and
// showing no value of the trial; the 24-hour reads of a system from its read manifests on the interface, the connections
// page and the overview.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { ConnectorError, Redactor, TrialLoginStops, forgetTrialLogin, readProfile, trialSystem, type ConnectorLogEvent } from '../connectors/api.ts';
import { PLM_FUNCTIONS, PLM_PRODUCTS, agileFixture, plmSystem, startAgileStub, startPlmStub, writePack, type AgileStub, type PlmStub } from '../connectors/testing/api.ts';
import type { PackHandle } from '../ports.ts';
import { testConsoleCredentials, createTestServer, type TestServer } from './testing.ts';

const PASSWORD = 'Synthetic#Pass42';

let server: TestServer;
let agile: AgileStub;
let plm: PlmStub;
let packRoot: string;
let handle: PackHandle;
const logged: ConnectorLogEvent[] = [];

before(async () => {
  server = await createTestServer();
  agile = await startAgileStub(agileFixture('q7w2e9r4t1y8', { password: PASSWORD }));
  plm = await startPlmStub({ accepts: (token) => agile.tokens.has(token) });
  packRoot = await mkdtemp(join(tmpdir(), 'circle-hub-console-systems-'));
  handle = await writePack(packRoot, { id: 'plm-test', system: plmSystem(), functions: PLM_FUNCTIONS });
  const failedLogins = new TrialLoginStops(server.records.store, server.records.vault);
  const redactor = new Redactor();
  // The trial as the assembly wires it (connectors' admin.trial), over the synthetic PLM pack.
  const options = {
          store: server.records.store,
          load: async (ref: string) => {
            if (ref !== 'plm-test') throw new ConnectorError('PACK_UNAVAILABLE', `业务系统接入 ${ref} 不可用`);
            return { pack: handle, profile: await readProfile(handle) };
          },
          redactor,
          now: () => new Date(),
          log: (event: ConnectorLogEvent) => logged.push(event),
          failedLogins,
  };
  server.deps.systems = {
    trial: (by, input) => trialSystem(options, input, by.id),
    forgetTrialLogin: (by, input) => forgetTrialLogin(options, input, by.id),
  };
});
after(async () => {
  await server?.close();
  for (const stub of [agile, plm]) await stub?.close();
  if (packRoot) await rm(packRoot, { recursive: true, force: true });
});

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function send(path: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: server.port, path, method: options.method ?? 'GET', headers: { host: `127.0.0.1:${server.port}`, ...options.headers }, setHost: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

const origin = (): string => `http://127.0.0.1:${server.port}`;
const valueOf = (header: string | undefined): string => (header ?? '').split(';')[0].split('=').slice(1).join('=');
const cookieOf = (reply: Reply, name: string): string | undefined => ([] as string[]).concat(reply.headers['set-cookie'] ?? []).find((value) => value.startsWith(`${name}=`));

async function signIn(token: string): Promise<{ cookie: string; csrf: string }> {
  const page = await send('/console/login');
  const nonce = /name="csrf" value="([^"]+)"/.exec(page.body)![1];
  const reply = await send('/console/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: `circle_hub_login=${valueOf(cookieOf(page, 'circle_hub_login'))}`, origin: origin() },
    body: new URLSearchParams({ ...testConsoleCredentials(token), csrf: nonce }).toString(),
  });
  assert.equal(reply.status, 303, reply.body);
  const cookie = `circle_hub_session=${valueOf(cookieOf(reply, 'circle_hub_session'))}`;
  const me = JSON.parse((await send('/console/api/me', { headers: { cookie } })).body) as { csrf: string };
  return { cookie, csrf: me.csrf };
}

/** The operation's form for the synthetic PLM: both roles, plain HTTP on loopback, the account and its password. */
const fields = (password = PASSWORD): Record<string, string> => ({
  system_pack: 'plm-test',
  name: '合成 PLM',
  environment: 'test',
  plaintext: 'plm-oauth, plm-api',
  origins: `plm-oauth=${agile.origin}\nplm-api=${plm.origin}`,
  credentials: 'username=PLM_USER\npassword=PLM_PASS',
  secret_name_1: 'PLM_USER',
  value_1: 'reader',
  secret_name_2: 'PLM_PASS',
  value_2: password,
});

describe('尝试连接', () => {
  test('the interface tries the system read-only, records the trial and never exposes credential values', async () => {
    const admin = await signIn(server.admin.token);
    const listedBefore = await server.deps.resources.list(server.admin.principal);
    const reply = await send('/console/api/systems/test', { method: 'POST', headers: { cookie: admin.cookie, origin: origin(), 'x-csrf-token': admin.csrf, 'content-type': 'application/json' }, body: JSON.stringify(fields()) });
    assert.equal(reply.status, 200, reply.body);
    const report = JSON.parse(reply.body).report;
    assert.equal(report.saved, false);
    assert.equal(report.auth.ok, true);
    assert.equal(report.environment_label, '测试');
    const routes = Object.fromEntries(report.routes.map((r: { route: string }) => [r.route, r]));
    assert.equal(routes.products.ok, true);
    assert.equal(routes.builds.tried, false, 'a required query member is never invented');
    assert.equal(plm.writes, 0);
    assert.equal(agile.logins, 1);
    for (const value of [PASSWORD, ...agile.tokens]) {
      assert.ok(!reply.body.includes(value), 'a value of the trial in the answer');
      assert.ok(!JSON.stringify(logged).includes(value), 'a value of the trial in the log');
    }
    for (const product of PLM_PRODUCTS) assert.ok(!reply.body.includes(product.name), 'an answer of the system in the report');
    assert.deepEqual(await server.deps.resources.list(server.admin.principal), listedBefore, 'no business system was added');

    const bad = await send('/console/api/systems/test', { method: 'POST', headers: { cookie: admin.cookie, origin: origin(), 'x-csrf-token': admin.csrf, 'content-type': 'application/json' }, body: JSON.stringify({ ...fields(), origins: `plm-api=${plm.origin}` }) });
    assert.equal(bad.status, 400);
    assert.equal(JSON.parse(bad.body).code, null);
    const member = await signIn((await server.createUser('尝试读取成员')).token);
    const refused = await send('/console/api/systems/test', { method: 'POST', headers: { cookie: member.cookie, origin: origin(), 'x-csrf-token': member.csrf, 'content-type': 'application/json' }, body: JSON.stringify(fields()) });
    assert.equal(refused.status, 404);
    assert.equal(agile.logins, 1, 'nothing sent for a refused request');
    const records = await send('/console/records?tab=trials', { headers: { cookie: admin.cookie } });
    assert.match(records.body, /尝试读取记录/);
    assert.match(records.body, /plm-test@1.0.0/);
    assert.match(records.body, /HTTP 200/);
    const memberRecords = await send('/console/records?tab=trials', { headers: { cookie: member.cookie } });
    assert.doesNotMatch(memberRecords.body, /尝试读取记录|plm-test@/);
  });

  test('the operation page tries the form and comes back filled in, without the credential contents', async () => {
    const admin = await signIn(server.admin.token);
    const page = await send('/console/operations/system', { headers: { cookie: admin.cookie } });
    assert.match(page.body, /formaction="\/console\/admin\/do\/system-test"/);
    assert.match(page.body, />尝试连接<\/button>/);
    assert.doesNotMatch(page.body, /测试连接|未试读|试读记录/, 'the page uses only the approved current labels');
    assert.doesNotMatch(page.body, /规划中/);
    const tried = await send('/console/admin/do/system-test', { method: 'POST', headers: { cookie: admin.cookie, origin: origin(), 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...fields('wrong-password'), csrf: admin.csrf }).toString() });
    assert.equal(tried.status, 200, tried.body.slice(0, 300));
    assert.match(tried.body, /尝试连接结果/);
    assert.match(tried.body, /登录失败/);
    assert.match(tried.body, /未尝试读取/);
    assert.match(tried.body, /每次尝试连接记一条尝试读取记录/);
    assert.ok(tried.body.includes(agile.origin), 'the addresses come back in the form');
    assert.ok(!tried.body.includes('wrong-password'), 'a credential content never comes back into a page');
    assert.match(tried.body, /value="PLM_PASS"/, 'the credential names come back');
    const forged = await send('/console/admin/do/system-test', { method: 'POST', headers: { cookie: admin.cookie, origin: origin(), 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...fields(), csrf: 'forged' }).toString() });
    assert.equal(forged.status, 403);
  });

  test('forget is administrator-only, origin/CSRF protected, reports absence neutrally and never sends a request', async () => {
    const admin = await signIn(server.admin.token);
    const badFields = fields('synthetic-forget-password');
    const headers = { cookie: admin.cookie, origin: origin(), 'x-csrf-token': admin.csrf, 'content-type': 'application/json' };
    await send('/console/api/systems/test', { method: 'POST', headers, body: JSON.stringify(badFields) });
    const before = agile.logins;
    assert.equal((await send('/console/api/systems/test/forget', { method: 'POST', headers: { origin: origin(), 'content-type': 'application/json' }, body: JSON.stringify(badFields) })).status, 401);
    const member = await signIn((await server.createUser('清除记录成员')).token);
    const request = (extra: Record<string, string> = {}, body = badFields) => send('/console/api/systems/test/forget', { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) });
    const refused = await request({ cookie: member.cookie, 'x-csrf-token': member.csrf });
    assert.equal(refused.status, 404);
    assert.equal(JSON.parse(refused.body).code, 'SOURCE_UNAVAILABLE');
    assert.equal((await request({ origin: 'http://192.0.2.99' })).status, 403);
    assert.equal((await request({ 'x-csrf-token': 'forged' })).status, 403);
    const absent = await request({}, fields('synthetic-not-sent'));
    assert.deepEqual(JSON.parse(absent.body), { found: false, cleared: false });
    const cleared = await request();
    assert.equal(cleared.status, 200);
    assert.deepEqual(JSON.parse(cleared.body), { found: true, cleared: true });
    assert.equal(agile.logins, before, 'no login for any clear or refusal');
    assert.ok(!cleared.body.includes('synthetic-forget-password'));
    assert.equal(JSON.parse((await send('/console/api/systems/test', { method: 'POST', headers, body: JSON.stringify(badFields) })).body).report.auth.sent, true);
    assert.equal(JSON.parse((await send('/console/api/systems/test', { method: 'POST', headers, body: JSON.stringify(badFields) })).body).report.auth.sent, false);
  });

  test('a blocked result offers a form reset with re-entered credentials; write failures never claim a clear', async () => {
    const admin = await signIn(server.admin.token);
    const sendForm = (action: string) => send(`/console/admin/do/${action}`, { method: 'POST', headers: { cookie: admin.cookie, origin: origin(), 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...fields('wrong-password'), csrf: admin.csrf }).toString() });
    const blocked = await sendForm('system-test');
    assert.match(blocked.body, /清除这组凭据的失败记录/);
    assert.match(blocked.body, /formaction="\/console\/admin\/do\/system-test-forget"/);
    assert.ok(!blocked.body.includes('wrong-password'));
    const before = agile.logins;
    const cleared = await sendForm('system-test-forget');
    assert.equal(cleared.status, 200);
    assert.match(cleared.body, /失败记录已清除；未发送登录/);
    assert.ok(!cleared.body.includes('wrong-password'));
    assert.equal(agile.logins, before);
    const original = server.deps.systems!.forgetTrialLogin;
    try {
      server.deps.systems!.forgetTrialLogin = async () => { throw new ConnectorError('STORE_FAILED', 'synthetic-private-password'); };
      const failed = await sendForm('system-test-forget');
      assert.equal(failed.status, 503);
      assert.match(failed.body, /登录失败记录未能清除/);
      assert.ok(!failed.body.includes('synthetic-private-password'));
    } finally { server.deps.systems!.forgetTrialLogin = original; }
  });
});

describe('the reads of the last day', () => {
  test('a system\'s read manifests give its reads, results and median time on the interface, the connections page and the overview', async () => {
    const now = Date.now();
    const manifest = (minutesAgo: number, ms: number, result: string) => ({
      action: 'read', run: null, item: null, inputs: [], component: 'connectors@1', lease: null,
      started_at: new Date(now - minutesAgo * 60_000).toISOString(), ended_at: new Date(now - minutesAgo * 60_000 + ms).toISOString(), result, error_code: result === 'completed' ? null : 'SOURCE_TIMEOUT',
      external: 'tracker:item:1', revision: null, resource: `res_${'1'.repeat(26)}`, environment: 'test',
      system_pack: { id: 'tracker-system', version: '1.0.0', digest: 'a'.repeat(64) }, read: 'item', principal: server.admin.principal.id,
      purpose: 'synthetic', requests: [], reads: [], original: null, artifacts: [], coverage: { complete: result === 'completed', examined: 1, total: 1 }, reason: null, warnings: [],
    });
    // One read a day and a half ago and three in the window (one of them failed), all of the catalog's system res-tracker,
    // stored as reads are: when each ends, oldest first.
    for (const [minutes, ms, result] of [[36 * 60, 50, 'completed'], [60, 900, 'error'], [30, 300, 'completed'], [5, 100, 'completed']] as const) {
      await server.records.store.put({ kind: 'action', schema: 'read-manifest@1', provenance: 'observed', body: manifest(minutes, ms, result), index: [{ key: 'action.kind', value: 'read' }, { key: 'connectors.resource', value: 'res-tracker' }] });
    }
    const admin = await signIn(server.admin.token);
    const systems = JSON.parse((await send('/console/api/systems', { headers: { cookie: admin.cookie } })).body).systems;
    const reads = systems.find((s: { id: string }) => s.id === 'res-tracker').reads_24h;
    assert.equal(reads.reads, 3);
    assert.deepEqual(reads.results, { completed: 2, error: 1, unknown: 0 });
    assert.equal(reads.median_ms, 200);
    assert.equal(reads.slowest_ms, 300);
    assert.equal(reads.partial, false);
    assert.equal(reads.results_label.error, '报错');
    const connections = await send('/console/connections', { headers: { cookie: admin.cookie } });
    assert.match(connections.body, /近 24 小时读取/);
    assert.match(connections.body, /3 次（报错 1 次） · 中位 200 毫秒/);
    assert.match(connections.body, /<p class="ch-meta" data-tab-facts>已启用 \d+ 个，共 \d+ 个 · 统计时段 [^；]+? 至 [^；]+?<\/p>/);
    const overview = await send('/console/overview', { headers: { cookie: admin.cookie } });
    assert.match(overview.body, /4 次（报错 1 次）/, 'the selected seven-day period also includes the read 36 hours ago');
  });
});
