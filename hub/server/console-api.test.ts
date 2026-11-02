// The read-only JSON interface /console/api over HTTP with the fake services: the pages' session and visibility, GET only,
// 401 without a session instead of a redirect, absent and forbidden alike (SOURCE_UNAVAILABLE), interface terms beside the
// codes, bad parameters as code null, and no token value or credential content in any answer.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { PROTOCOL_CODES } from '../../contracts/generated/protocol.ts';
import { uiLabelOf } from '../../contracts/generated/vocabulary.ts';
import { NEUTRAL } from './console/pages.ts';
import { ROOT_1, ROOT_2 } from './fakes.ts';
import { testConsoleCredentials, createTestServer, type TestServer, type TestUser } from './testing.ts';

let server: TestServer;
let counter = 0;
const seen: string[] = [];
/** Every token value the tests issued: none may appear in any answer. */
const issued: string[] = [];

before(async () => {
  server = await createTestServer();
});
after(async () => {
  await server?.close();
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
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        seen.push(body);
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body });
      });
    });
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

const valueOf = (header: string | undefined): string => (header ?? '').split(';')[0].split('=').slice(1).join('=');
const cookieOf = (reply: Reply, name: string): string | undefined => ([] as string[]).concat(reply.headers['set-cookie'] ?? []).find((value) => value.startsWith(`${name}=`));

async function signIn(token: string): Promise<string> {
  const page = await send('/console/login');
  const nonce = /name="csrf" value="([^"]+)"/.exec(page.body)![1];
  const reply = await send('/console/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: `circle_hub_login=${valueOf(cookieOf(page, 'circle_hub_login'))}`, origin: `http://127.0.0.1:${server.port}` },
    body: new URLSearchParams({ ...testConsoleCredentials(token), csrf: nonce }).toString(),
  });
  assert.equal(reply.status, 303, reply.body);
  return `circle_hub_session=${valueOf(cookieOf(reply, 'circle_hub_session'))}`;
}

async function json(path: string, session: string, status = 200): Promise<Record<string, any>> {
  const reply = await send(path, { headers: { cookie: session } });
  assert.equal(reply.status, status, `${path}: ${reply.body.slice(0, 300)}`);
  assert.match(String(reply.headers['content-type']), /^application\/json; charset=utf-8$/, path);
  assert.equal(reply.headers['x-content-type-options'], 'nosniff', path);
  assert.equal(reply.headers['cache-control'], 'no-store', path);
  return JSON.parse(reply.body) as Record<string, any>;
}

async function member(packs: string[] = ['review']): Promise<TestUser> {
  counter += 1;
  const user = await server.createUser(`接口成员${counter}`);
  issued.push(user.token);
  for (const pack of packs) await server.assign(user.principal, pack);
  return user;
}

async function runWithResult(user: TestUser): Promise<string> {
  const client = await server.client(user.token);
  const uploaded = await client.call('upload_file', { file_path: Buffer.from(`合成文档 ${counter}`).toString('base64') });
  const run = await client.call('start_run', { pack: 'review', inputs: { subject: { reference: String(uploaded.structuredContent.reference) } } });
  const summary = run.structuredContent.run as { run: string; items: { id: string }[] };
  await client.call('submit_result', {
    run: summary.run,
    model: 'scripted-model@test',
    items: [
      { item: summary.items[0].id, handling: 'handled', slots: { findings: [{ text: '期望结果缺失' }] } },
      { item: summary.items[1].id, handling: 'handled', slots: { unknown: true } },
    ],
  });
  await client.close();
  return summary.run;
}

describe('the read-only interface', () => {
  test('without a session it answers 401 in JSON, never a redirect, and it takes no method but GET', async () => {
    const anonymous = await send('/console/api/me');
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.headers.location, undefined);
    assert.deepEqual(Object.keys(JSON.parse(anonymous.body)).sort(), ['code', 'fix', 'message']);
    assert.equal(JSON.parse(anonymous.body).code, null, 'no code is registered for this, so none is coined');
    const session = await signIn((await member()).token);
    const posted = await send('/console/api/me', { method: 'POST', headers: { cookie: session, 'content-type': 'application/json', origin: `http://127.0.0.1:${server.port}` }, body: '{}' });
    assert.equal(posted.status, 405);
    assert.equal(posted.headers.allow, 'GET, HEAD');
  });

  test('a member reads their own tasks, account and Circles; administrators\' interfaces are the neutral 404', async () => {
    const user = await member();
    const other = await member();
    const own = await runWithResult(user);
    const foreign = await runWithResult(other);
    const session = await signIn(user.token);
    const me = await json('/console/api/me', session);
    assert.equal(me.id, user.user.id);
    assert.equal(me.role_label, uiLabelOf('permission_role', 'user'));
    assert.equal(me.admin, false);
    assert.equal(typeof me.csrf, 'string');
    assert.ok(me.circles >= 1);
    const listed = await json('/console/api/tasks', session);
    assert.ok(listed.items.some((item: { run: string }) => item.run === own));
    assert.ok(!listed.items.some((item: { run: string }) => item.run === foreign), 'only their own tasks');
    const row = listed.items.find((item: { run: string }) => item.run === own);
    assert.equal(row.result_label, uiLabelOf('task_result', row.result));
    const detail = await json(`/console/api/tasks/${own}`, session);
    assert.ok(detail.steps.some((step: { name: string }) => step.name === '提交结果'));
    assert.ok(detail.steps.some((step: { name: string; moment: boolean }) => step.name === '任务结果' && step.moment));
    assert.ok(detail.calls.some((call: { tool: string; tool_label: string }) => call.tool === 'submit_result' && call.tool_label === '提交结果'));
    const forbidden = await send(`/console/api/tasks/${foreign}`, { headers: { cookie: session } });
    const absent = await send(`/console/api/tasks/run_${'z'.repeat(26)}`, { headers: { cookie: session } });
    assert.equal(forbidden.status, 404);
    assert.equal(forbidden.body, absent.body, 'absent and forbidden look the same');
    assert.deepEqual(JSON.parse(forbidden.body), { code: 'SOURCE_UNAVAILABLE', message: NEUTRAL, fix: PROTOCOL_CODES.SOURCE_UNAVAILABLE.fix });
    for (const path of ['/console/api/members', '/console/api/secrets', '/console/api/environments', '/console/api/system-packs', '/console/api/knowledge/imports', '/console/api/nowhere', '/console/api/tasks/a/b']) {
      const refused = await send(path, { headers: { cookie: session } });
      assert.equal(refused.status, 404, path);
      assert.equal(refused.body, absent.body, path);
    }
    const systems = await json('/console/api/systems', session);
    assert.deepEqual(systems.systems, [], 'the resource catalog gives a member none');
    const circles = await json('/console/api/circles', session);
    assert.ok(circles.circles.length >= 1 && circles.circles.every((c: { owner: string }) => c.owner === user.user.name));
    const records = await json('/console/api/records', session);
    assert.ok(records.records.every((r: { user: { id: string } | null }) => r.user?.id === user.user.id), 'only their own calls');
    assert.ok(records.records.every((r: object) => !('admin_note' in r)));
  });

  test('an administrator reads members, systems, environments, packs, records and the Hub; parameters are checked', async () => {
    const user = await member();
    await runWithResult(user);
    const admin = await signIn(server.admin.token);
    const members = await json('/console/api/members', admin);
    const found = members.members.find((m: { id: string }) => m.id === user.user.id);
    assert.ok(found && found.tokens.length >= 1);
    const systems = await json('/console/api/systems', admin);
    assert.ok(systems.systems.some((s: { origins?: Record<string, string> }) => Object.values(s.origins ?? {}).includes('http://192.0.2.10:8080')));
    assert.deepEqual(await json('/console/api/environments', admin), { wired: false, environments: [] });
    const packs = await json('/console/api/packs', admin);
    assert.ok(packs.packs.some((p: { id: string; assigned?: unknown[] }) => p.id === 'review' && Array.isArray(p.assigned)));
    const review = await json('/console/api/packs/review', admin);
    assert.ok(review.workflow.requirements.length > 0);
    assert.equal((await send('/console/api/packs/__proto__', { headers: { cookie: admin } })).status, 404);
    const records = await json('/console/api/records?tool=submit_result', admin);
    assert.ok(records.records.length > 0 && records.records.every((r: { tool: string }) => r.tool === 'submit_result'));
    assert.ok(records.records.every((r: object) => 'admin_note' in r));
    const hub = await json('/console/api/hub', admin);
    assert.deepEqual(hub.https, { enabled: false });
    assert.equal(typeof hub.uptime_ms, 'number');
    const overview = await json('/console/api/overview?days=14', admin);
    assert.equal(overview.days, 14);
    assert.equal(overview.daily.length, 14);
    assert.ok(overview.scope.tasks > 0);
    for (const [path, status] of [['/console/api/overview?days=5', 400], ['/console/api/tasks?result=bogus', 400], ['/console/api/records?from=not-a-time', 400], ['/console/api/records?cursor=%21%21', 400]] as const) {
      const reply = await json(path, admin, status);
      assert.equal(reply.code, null, path);
    }
  });

  test('a member\'s detail lists the invitations issued for them, never a code, for administrators only', async () => {
    const user = await member();
    const invitation = await server.records.principals.invite(server.admin.principal, user.user.id);
    const admin = await signIn(server.admin.token);
    const detail = await json(`/console/api/members/${user.user.id}`, admin);
    assert.equal(detail.name, user.user.name);
    assert.deepEqual(detail.invitations.map((i: { id: string; open: boolean }) => [i.id, i.open]), [[invitation.id, true]]);
    assert.ok(!JSON.stringify(detail).includes(invitation.code), 'an invitation code is shown once, when issued');
    assert.ok(detail.tokens.every((t: { client: unknown }) => t.client === null), 'tokens say which client they went to');
    assert.equal((await send(`/console/api/members/usr_${'0'.repeat(26)}`, { headers: { cookie: admin } })).status, 404);
    const own = await signIn(user.token);
    assert.equal((await send(`/console/api/members/${user.user.id}`, { headers: { cookie: own } })).status, 404, 'members read no member detail');
  });

  test('the Hub\'s state gives the newest backup under the data root and the database size, or null when unreadable', async () => {
    const admin = await signIn(server.admin.token);
    const before = await json('/console/api/hub', admin);
    assert.deepEqual(before.backups, { count: 0, latest_at: null });
    assert.ok(typeof before.database_bytes === 'number' && before.database_bytes > 0, 'the size PostgreSQL reports');
    // A complete backup is a directory with a manifest (hub/platform writes them; the newest by created_at).
    for (const [name, at] of [['20261030T000000Z', '2026-10-30T00:00:00.000Z'], ['20261031T000000Z', '2026-10-31T00:00:00.000Z']]) {
      const dir = join(server.deps.config.dataDir, 'backups', name);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'manifest.json'), JSON.stringify({ created_at: at }));
    }
    await mkdir(join(server.deps.config.dataDir, 'backups', '.partial-20261101T000000Z-x'), { recursive: true });
    const after = await json('/console/api/hub', admin);
    assert.deepEqual(after.backups, { count: 2, latest_at: '2026-10-31T00:00:00.000Z' }, 'a partial backup is not counted');
    const settings = await send('/console/settings', { headers: { cookie: admin } });
    assert.match(settings.body, /最近备份/);
    assert.match(settings.body, /2 份/);
  });

  test('knowledge is read with the same visibility as the pages', async () => {
    const reader = await signIn((await member(['review'])).token);
    const stranger = await signIn((await member([])).token);
    const lines = await json('/console/api/knowledge/lines', reader);
    assert.ok(lines.lines.some((line: { names: string[] }) => line.names.includes('Line A')));
    assert.deepEqual((await json('/console/api/knowledge/lines', stranger)).lines, []);
    const tree = await json(`/console/api/knowledge/nodes?root=${ROOT_1}&path=%2F`, reader);
    assert.ok(tree.nodes.length > 0);
    const hidden = await send(`/console/api/knowledge/nodes?root=${ROOT_1}&path=%2F`, { headers: { cookie: stranger } });
    const missing = await send(`/console/api/knowledge/nodes?root=${'e'.repeat(64)}&path=%2F`, { headers: { cookie: stranger } });
    assert.equal(hidden.status, 404);
    assert.equal(hidden.body, missing.body);
    const diff = await json(`/console/api/knowledge/diff?from=${ROOT_1}&to=${ROOT_2}`, reader);
    assert.ok(diff.added.includes('/catalog/gamma'));
    assert.equal((await send(`/console/api/knowledge/diff?from=${ROOT_1}&to=${ROOT_2}`, { headers: { cookie: stranger } })).status, 404);
  });

  test('no answer ever carries a token value', () => {
    assert.ok(seen.length > 20 && issued.length > 3);
    for (const body of seen) for (const token of [server.admin.token, ...issued]) assert.ok(!body.includes(token), 'a token value in an answer');
  });
});
