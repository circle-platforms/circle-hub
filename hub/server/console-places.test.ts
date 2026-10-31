// The seven places of the redesigned console (proposal decisions 3 and 6 of 2026-10-31) over HTTP with the fake services:
// every page of an administrator and of a member answers with the side navigation, interface terms only, no style attribute
// and no script; a task's result is derived in one place (display rule 20); the four operations are the only forms; every
// other operation is a command dialog with the real ids; members see only their own Circles and calls.
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { after, before, describe, test } from 'node:test';
import { TASK_RESULT, uiLabelOf } from '../../contracts/generated/vocabulary.ts';
import type { ValidationResult } from '../../contracts/src/validation.ts';
import type { RunDetail } from '../ports.ts';
import { shellWord } from './console/commands.ts';
import { escapeHtml } from './console/html.ts';
import { CSS } from './console/style.ts';
import { NEUTRAL } from './console/pages.ts';
import { taskResultOf } from './console/status.ts';
import { createTestServer, type TestServer, type TestUser } from './testing.ts';

let server: TestServer;
let counter = 0;

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
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

const cookieOf = (reply: Reply, name: string): string | undefined => ([] as string[]).concat(reply.headers['set-cookie'] ?? []).find((value) => value.startsWith(`${name}=`));
const valueOf = (header: string | undefined): string => (header ?? '').split(';')[0].split('=').slice(1).join('=');
const csrfOf = (body: string): string => /name="csrf" value="([^"]+)"/.exec(body)?.[1] ?? '';
const own = () => `http://127.0.0.1:${server.port}`;

async function signIn(token: string): Promise<string> {
  const page = await send('/console/login');
  const reply = await send('/console/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: `circle_hub_login=${valueOf(cookieOf(page, 'circle_hub_login'))}`, origin: own() },
    body: new URLSearchParams({ token, csrf: csrfOf(page.body) }).toString(),
  });
  assert.equal(reply.status, 303, reply.body);
  assert.equal(reply.headers.location, '/console/overview');
  return `circle_hub_session=${valueOf(cookieOf(reply, 'circle_hub_session'))}`;
}

const get = (path: string, session: string) => send(path, { headers: { cookie: session } });

async function member(packs: string[] = ['review']): Promise<TestUser> {
  counter += 1;
  const user = await server.createUser(`页面成员${counter}`);
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

/** Every page a signed-in account opens: one console, no style attribute (the CSP refuses it) and no script. */
function assertPage(reply: Reply, path: string): void {
  assert.equal(reply.status, 200, `${path}: ${reply.body.slice(0, 300)}`);
  assert.match(String(reply.headers['content-security-policy']), /default-src 'none'/, path);
  assert.doesNotMatch(reply.body, /<script/i, path);
  assert.doesNotMatch(reply.body, /\sstyle=/i, `${path}: a style attribute would be refused by the CSP`);
  assert.match(reply.body, /<nav class="side" aria-label="主导航">/, path);
  for (const place of ['总览', '任务', '知识库', '任务包', '连接', '记录', '设置']) assert.ok(reply.body.includes(`<span>${place}</span>`), `${path}: ${place}`);
  assert.doesNotMatch(reply.body, /你/, `${path}: interface text states facts without a subject`);
}

describe('the seven places', () => {
  test('an administrator opens every place and every operation; the current place is marked', async () => {
    const user = await member();
    const run = await runWithResult(user);
    const admin = await signIn(server.admin.token);
    const pages: Record<string, string> = {
      '/console/overview': '总览', '/console/runs': '任务', [`/console/runs/${run}`]: '任务', '/console/knowledge': '知识库',
      '/console/packs': '任务包', '/console/packs/review': '任务包', '/console/connections': '连接', '/console/records': '记录',
      '/console/settings': '设置', '/console/operations': '设置', '/console/operations/member': '设置', '/console/operations/system': '连接',
      '/console/operations/pack': '任务包', '/console/operations/knowledge': '知识库', '/console/overview?days=30': '总览',
    };
    for (const [path, place] of Object.entries(pages)) {
      const reply = await get(path, admin);
      assertPage(reply, path);
      assert.match(reply.body, new RegExp(`<a class="nav-item on" href="[^"]+" aria-current="page"><svg[^>]*><path[^>]*></path></svg><span>${place}</span>`), `${path} marks ${place}`);
    }
    assert.equal((await get('/console', admin)).headers.location, '/console/overview');
  });

  test('a member opens the places, sees no operation and only their own Circles and calls', async () => {
    const user = await member();
    const other = await member();
    await runWithResult(user);
    const otherRun = await runWithResult(other);
    const session = await signIn(user.token);
    for (const path of ['/console/overview', '/console/runs', '/console/knowledge', '/console/packs', '/console/connections', '/console/records', '/console/settings']) assertPage(await get(path, session), path);
    for (const path of ['/console/operations', '/console/operations/member', '/console/admin', '/console/admin/calls']) {
      const refused = await get(path, session);
      assert.equal(refused.status, 404, path);
      assert.ok(refused.body.includes(NEUTRAL), path);
    }
    const records = await get('/console/records', session);
    assert.ok(!records.body.includes(otherRun), 'another member\'s calls are not listed');
    assert.ok(!records.body.includes('管理员备注'));
    const settings = await get('/console/settings', session);
    assert.ok(settings.body.includes('我的 Circle'));
    assert.ok(!settings.body.includes('circle-hub user disable'), 'no command for an administrator\'s operation');
    const overview = await get('/console/overview', session);
    assert.ok(!overview.body.includes('添加成员'), 'no management entry for a member');
  });
});

describe('tasks', () => {
  test('the list filters by task result, the detail shows the execution process above the full record', async () => {
    const user = await member();
    const run = await runWithResult(user);
    const session = await signIn(user.token);
    const list = await get('/console/runs', session);
    assert.ok(list.body.includes(run));
    const result = taskResultOf((await server.deps.runs.getRun(user.principal, run))!);
    assert.ok(list.body.includes(uiLabelOf('task_result', result)), 'the result of the task');
    const filtered = await get(`/console/runs?result=${result}`, session);
    assert.ok(filtered.body.includes(run));
    const other = TASK_RESULT.find((r) => r !== result)!;
    assert.ok(!(await get(`/console/runs?result=${other}`, session)).body.includes(`/console/runs/${run}"`), 'another result filters it out');
    assert.equal((await get('/console/runs?result=bogus', session)).status, 400);
    const detail = await get(`/console/runs/${run}`, session);
    for (const text of ['执行过程', '工具调用', 'Hub 校验', '任务结果', '完整记录', uiLabelOf('mcp_tool', 'submit_result'), uiLabelOf('mcp_tool', 'start_run')]) assert.ok(detail.body.includes(text), text);
    assert.ok(detail.body.indexOf('执行过程') < detail.body.indexOf('完整记录'), 'the process comes first');
    assert.match(detail.body, /<svg class="svg-track" role="img"/, 'bars are SVG attributes');
  });

  test('a task result follows display rule 20: held, incomplete and rejected first, unknown never passed', () => {
    const requirement = (status: 'satisfied' | 'pending' | 'unsatisfied', terminal: 'pass' | 'unchecked' | 'violation' = 'pass') => ({ requirement: 'r', layers: [{ layer: 'static' as const, terminal }], status, ...(status === 'unsatisfied' ? { unsatisfied_reason: 'outcome_mismatch' as const } : {}), claims: [] });
    const item = (id: string, r = requirement('satisfied')) => ({ item: id, label: id, location: 'src:x', requirements: [r] });
    const detail = (partitions: Partial<ValidationResult['partitions']>, acceptance: 'accepted' | 'not_accepted' = 'accepted'): RunDetail => ({
      run: { run: 'run_x', requirements: [{ key: 'r', accepted_producer: 'judgment' }] },
      submissions: [], production: null,
      latest: { record: 'r'.repeat(64), result: { acceptance, cross_item: [], partitions: { delivered: [], rejected: [], quarantined: [], incomplete: [], ...partitions } } },
    } as unknown as RunDetail);
    assert.equal(taskResultOf(detail({ delivered: [item('a')] })), 'passed');
    assert.equal(taskResultOf(detail({ delivered: [item('a'), item('b', requirement('pending'))] })), 'delivered_pending');
    assert.equal(taskResultOf(detail({ delivered: [item('a', requirement('satisfied', 'unchecked'))] })), 'delivered_pending', 'an unknown terminal is never passed');
    assert.equal(taskResultOf(detail({ delivered: [item('a', requirement('unsatisfied', 'violation'))] })), 'delivered_unsatisfied');
    assert.equal(taskResultOf(detail({ delivered: [item('a')], rejected: [{ ...item('b'), code: 'x' }] as never })), 'rejected');
    assert.equal(taskResultOf(detail({ rejected: [{ ...item('b'), code: 'x' }] as never, incomplete: [{ ...item('c'), reason: 'not_covered' }] as never })), 'incomplete');
    assert.equal(taskResultOf(detail({ incomplete: [{ ...item('c'), reason: 'not_covered' }] as never, quarantined: [{ ...item('d'), reason: 'integrity_unproven' }] as never })), 'held');
    assert.equal(taskResultOf(detail({}, 'not_accepted')), 'awaiting');
    assert.equal(taskResultOf({ ...detail({ delivered: [item('a')] }), latest: null }), 'awaiting');
    assert.equal(taskResultOf({ ...detail({ delivered: [item('a')] }), management: { record: 'm'.repeat(64), disposition: 'abandon', result: null } }), 'abandoned');
  });
});

describe('operations and commands', () => {
  test('settings, connections and packs offer the other operations as commands with the real ids, never as forms', async () => {
    const user = await member();
    const admin = await signIn(server.admin.token);
    const settings = await get('/console/settings', admin);
    const [token] = await server.records.principals.tokens(user.user.id);
    for (const command of [`circle-hub user disable ${user.user.id}`, `circle-hub token revoke ${token.id}`, `circle-hub token issue ${user.user.id} '--label=备用登录'`]) assert.ok(settings.body.includes(escapeHtml(command)), command);
    assert.match(settings.body, /<div class="modal" id="cmd-user-disable-[^"]+" role="dialog"/);
    assert.match(settings.body, /href="#cmd-user-disable-[^"]+"/, 'the button opens its dialog by fragment');
    assert.doesNotMatch(settings.body, /action="\/console\/admin\/do\/(?!member-add)/, 'no management form on the settings page');
    const connections = await get('/console/connections', admin);
    const [resource] = await server.deps.resources.list(server.admin.principal);
    assert.ok(connections.body.includes(`circle-hub resource disable ${resource.id}`) || connections.body.includes(`circle-hub resource enable ${resource.id}`));
    assert.ok(connections.body.includes('这个 Hub 进程未接入派发'), 'no runtime environments without the dispatch port');
    const pack = await get('/console/packs/review', admin);
    assert.ok(pack.body.includes('circle-hub pack retire review@1.0.0'));
    assert.ok(pack.body.includes('要求项') && pack.body.includes('检查项'));
    for (const path of ['/console/packs/absent', '/console/packs/__proto__', '/console/operations/backup']) assert.equal((await get(path, admin)).status, 404, path);
    assert.match(CSS, /\.modal:target\{/);
  });

  test('a command word that is not an identifier is quoted for the shell', () => {
    assert.equal(shellWord('usr_0123456789abcdefghjkmnpqrs'), 'usr_0123456789abcdefghjkmnpqrs');
    assert.equal(shellWord('review@1.0.0'), 'review@1.0.0');
    assert.equal(shellWord("a b'c"), `'a b'\\''c'`);
    assert.equal(shellWord('--reason=请填写理由'), `'--reason=请填写理由'`);
  });
});

describe('sign-in states', () => {
  test('a session whose token was revoked returns to the login page, which says the sign-in ended once', async () => {
    const user = await member();
    const session = await signIn(user.token);
    for (const token of await server.records.principals.tokens(user.user.id)) await server.records.principals.revokeToken(server.admin.principal, token.id);
    const ended = await get('/console/runs', session);
    assert.equal(ended.status, 303);
    assert.equal(ended.headers.location, '/console/login');
    const flag = cookieOf(ended, 'circle_hub_ended');
    assert.match(flag ?? '', /^circle_hub_ended=1; Path=\/console\/login; HttpOnly; SameSite=Strict; Max-Age=120$/);
    const login = await send('/console/login', { headers: { cookie: `circle_hub_ended=1` } });
    assert.match(login.body, /登录已过期或已退出/);
    assert.match(cookieOf(login, 'circle_hub_ended') ?? '', /Max-Age=0/, 'said once');
    assert.doesNotMatch((await send('/console/login')).body, /登录已过期或已退出/);
  });
});
