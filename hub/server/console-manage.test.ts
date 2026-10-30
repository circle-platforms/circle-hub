// The console's management (decision 75) end to end over HTTP with synthetic records and a recording command bridge:
// first-admin setup with the one-time code, the management pages, actions as POST forms (own origin, the session's CSRF
// token, administrators only) turned into exact `circle-hub` argv, the secret value kept out of argv, a background job,
// and a zip upload published from a private directory that is gone afterwards.
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { strToU8, zipSync } from 'fflate';
import type { ServerDeps } from './api.ts';
import { createApp } from './app.ts';
import type { CommandBridge, CommandInput } from './command-bridge.ts';
import { ACTIONS } from './console/manage.ts';
import { issueSetupCode } from './setup-code.ts';

interface User { id: string; name: string; role: 'user' | 'admin'; disabled: boolean; created_at: string }

const TOKENS = new Map<string, string>(); // token -> user id
const users: User[] = [];
let dataDir: string;
let port: number;
let close: () => Promise<void>;
const calls: { argv: readonly string[]; input: CommandInput; packJson?: string }[] = [];

const bridge: CommandBridge = {
  async run(argv, input) {
    const call: (typeof calls)[number] = { argv, input };
    if (argv[0] === 'pack' && argv[1] === 'publish') call.packJson = await readFile(join(argv[2], 'pack.json'), 'utf8');
    calls.push(call);
    if (argv[0] === 'token' && argv[1] === 'issue') return { code: 0, stdout: ['已为 alice 签发令牌 tok_synthetic。令牌只显示这一次，请立即保存到只有使用者能读的地方：', 'T'.repeat(43)], stderr: [] };
    if (argv[0] === 'secret' && argv[1] === 'list') return { code: 0, stdout: ['DEMO 第 1 版'], stderr: [] };
    return { code: 0, stdout: [`已执行 ${argv.slice(0, 2).join(' ')}`], stderr: [] };
  },
};

const principals = {
  async authenticate(header: string | null | undefined) {
    const id = TOKENS.get(String(header).replace(/^Bearer /, ''));
    const user = users.find((u) => u.id === id && !u.disabled);
    return user ? { id: user.id, name: user.name, role: user.role } : null;
  },
  async list() { return users; },
  async get(id: string) { return users.find((u) => u.id === id) ?? null; },
  async tokens() { return []; },
  async bootstrapAdmin(name: string) {
    if (users.some((u) => u.role === 'admin')) throw new Error('已经有管理员');
    const user: User = { id: 'usr_admin', name, role: 'admin', disabled: false, created_at: '2026-10-31T00:00:00.000Z' };
    users.push(user);
    const token = 'A'.repeat(43);
    TOKENS.set(token, user.id);
    return { user, token: { id: 'tok_admin', token } };
  },
};

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'circle-hub-manage-'));
  const deps = {
    config: { host: '127.0.0.1', port: 0, dataDir, limits: { maxRequestBytes: 1 << 20, maxUploadBytes: 1 << 20 } },
    records: { principals, authorizations: { packsFor: async () => [], canPublish: async () => false, history: async () => ({ items: [] }) } },
    resources: { list: async () => [{ id: 'res_1', system_pack: 'synthetic-system', name: '合成系统', environment: 'shared', enabled: true, origins: { api: 'https://192.0.2.20' } }] },
    packs: { list: async () => [{ id: 'synthetic-flow', version: '1.0.0', kind: 'workflow', title: '合成流程', owner: 'usr_admin', digest: 'd', published_at: 't', withdrawn: false, active: false, samples: {}, assigned_to: [] }] },
  } as unknown as ServerDeps;
  const app = createApp(deps, { bridge, log: () => {} });
  port = (await app.listen()).port;
  close = () => app.close();
});
after(async () => {
  await close();
  await rm(dataDir, { recursive: true, force: true });
});

interface Answer { status: number; body: string; cookies: string[]; location?: string }

function send(method: string, path: string, options: { cookie?: string; body?: Buffer | string; type?: string; origin?: string } = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const body = options.body === undefined ? undefined : Buffer.isBuffer(options.body) ? options.body : Buffer.from(options.body);
    const req = request({ host: '127.0.0.1', port, path, method, agent: false, headers: {
      host: `127.0.0.1:${port}`,
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...(options.origin ? { origin: options.origin } : {}),
      ...(body ? { 'content-type': options.type ?? 'application/x-www-form-urlencoded', 'content-length': String(body.length) } : {}),
    } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), cookies: res.headers['set-cookie'] ?? [], location: res.headers.location }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const cookieValue = (answer: Answer, name: string): string => {
  const found = answer.cookies.find((c) => c.startsWith(`${name}=`));
  assert.ok(found, `cookie ${name}`);
  return found.slice(name.length + 1, found.indexOf(';'));
};
const csrfOf = (body: string): string => /name="csrf" value="([^"]+)"/.exec(body)![1];
const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();

let session = '';
let csrf = '';

test('the first administrator is created with the setup code; the token is shown once and opens a session', async () => {
  const login = await send('GET', '/console/login');
  assert.match(login.body, /还没有管理员/);
  const page = await send('GET', '/console/setup');
  assert.equal(page.status, 200);
  const nonce = cookieValue(page, 'circle_hub_setup');
  const noCode = await send('POST', '/console/setup', { cookie: `circle_hub_setup=${nonce}`, body: form({ csrf: nonce, code: 'ABCDE', name: 'root' }) });
  assert.equal(noCode.status, 403);
  assert.match(noCode.body, /没有有效的设置码/);

  const code = await issueSetupCode(dataDir);
  const again = await send('GET', '/console/setup');
  const second = cookieValue(again, 'circle_hub_setup');
  const wrong = await send('POST', '/console/setup', { cookie: `circle_hub_setup=${second}`, body: form({ csrf: second, code: 'ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ', name: 'root' }) });
  assert.equal(wrong.status, 403);
  assert.match(wrong.body, /设置码不对/);

  const third = await send('GET', '/console/setup');
  const nonce3 = cookieValue(third, 'circle_hub_setup');
  const crossSite = await send('POST', '/console/setup', { cookie: `circle_hub_setup=${nonce3}`, origin: 'http://evil.example', body: form({ csrf: nonce3, code, name: 'root' }) });
  assert.equal(crossSite.status, 403, 'a foreign origin cannot submit the setup form');

  const fourth = await send('GET', '/console/setup');
  const nonce4 = cookieValue(fourth, 'circle_hub_setup');
  const done = await send('POST', '/console/setup', { cookie: `circle_hub_setup=${nonce4}`, body: form({ csrf: nonce4, code: code.toLowerCase(), name: 'root' }) });
  assert.equal(done.status, 200, done.body);
  assert.ok(done.body.includes('A'.repeat(43)), 'the token is on the page once');
  assert.match(done.body, /mcp_servers/);
  await assert.rejects(access(join(dataDir, 'config', 'setup-code.json')), 'the code is used up');
  session = cookieValue(done, 'circle_hub_session');

  const closed = await send('GET', '/console/setup');
  assert.equal(closed.status, 409, 'no second first administrator');
  assert.doesNotMatch((await send('GET', '/console/login')).body, /还没有管理员/);
});

test('the admin page carries the management forms, and every management page answers', async () => {
  const admin = await send('GET', '/console/admin', { cookie: `circle_hub_session=${session}` });
  assert.equal(admin.status, 200);
  assert.match(admin.body, /action="\/console\/admin\/do\/user-create"/);
  assert.match(admin.body, /action="\/console\/admin\/do\/token-issue"/);
  csrf = csrfOf(admin.body);
  for (const path of ['packs', 'resources', 'secrets', 'knowledge']) {
    const page = await send('GET', `/console/admin/${path}`, { cookie: `circle_hub_session=${session}` });
    assert.equal(page.status, 200, path);
  }
  assert.match((await send('GET', '/console/admin/secrets', { cookie: `circle_hub_session=${session}` })).body, /DEMO 第 1 版/);
});

test('actions become exact argv as the signed-in administrator; flag values cannot become flags', async () => {
  calls.length = 0;
  const post = (name: string, fields: Record<string, string>) => send('POST', `/console/admin/do/${name}`, { cookie: `circle_hub_session=${session}`, body: form({ csrf, ...fields }) });
  assert.equal((await post('user-create', { name: 'alice', role: 'user' })).status, 200);
  assert.deepEqual(calls.at(-1)!.argv, ['user', 'create', 'alice', '--role=user']);
  assert.equal(calls.at(-1)!.input.token, 'A'.repeat(43), 'the command acts with the session token');

  const issued = await post('token-issue', { user: 'usr_alice', label: '--raw' });
  assert.deepEqual(calls.at(-1)!.argv, ['token', 'issue', 'usr_alice', '--label=--raw']);
  assert.match(issued.body, /只显示这一次/);

  const flagged = await post('user-create', { name: '--role=admin', role: 'user' });
  assert.equal(flagged.status, 400);
  assert.equal(calls.length, 2, 'a positional that looks like a flag never reaches a command');

  await post('secret-set', { name: 'DEMO', value: 'synthetic secret value', reason: '轮换' });
  const secret = calls.at(-1)!;
  assert.deepEqual(secret.argv, ['secret', 'set', '--name=DEMO', '--reason=轮换']);
  assert.deepEqual(secret.input.secrets, { DEMO: 'synthetic secret value' });
  assert.ok(!secret.argv.join(' ').includes('synthetic secret value'), 'the value is never in argv');

  await post('resource-add', { system_pack: 'synthetic-system', name: '合成', environment: 'shared', origins: 'api=https://192.0.2.20\n', plaintext: '', settings: 'tenant=demo', credentials: 'token=DEMO' });
  assert.deepEqual(calls.at(-1)!.argv, ['resource', 'add', 'synthetic-system', '--name=合成', '--environment=shared', '--origin=api=https://192.0.2.20', '--setting=tenant=demo', '--credential=token=DEMO']);

  const job = await post('knowledge-sync', { product: 'synthetic', line: '', dry_run: '1' });
  assert.equal(job.status, 202);
  const jobPath = /href="(\/console\/admin\/jobs\/[0-9a-f]+)"/.exec(job.body)![1];
  const jobPage = await send('GET', jobPath, { cookie: `circle_hub_session=${session}` });
  assert.equal(jobPage.status, 200);
  assert.ok(calls.some((call) => call.argv.join(' ') === 'knowledge sync --product=synthetic --dry-run'));
});

test('actions refuse a missing or wrong CSRF token, a foreign origin, GET, a non-admin and an unknown action', async () => {
  calls.length = 0;
  const cookie = `circle_hub_session=${session}`;
  assert.equal((await send('POST', '/console/admin/do/user-create', { cookie, body: form({ csrf: 'wrong', name: 'x' }) })).status, 403);
  assert.equal((await send('POST', '/console/admin/do/user-create', { cookie, body: form({ name: 'x' }) })).status, 403);
  assert.equal((await send('POST', '/console/admin/do/user-create', { cookie, origin: 'http://evil.example', body: form({ csrf, name: 'x' }) })).status, 403);
  assert.equal((await send('GET', '/console/admin/do/user-create', { cookie })).status, 405);
  assert.equal((await send('POST', '/console/admin/do/backup', { cookie, body: form({ csrf }) })).status, 404);
  assert.equal((await send('POST', '/console/admin/do/user-create', { body: form({ csrf, name: 'x' }) })).status, 303, 'no session: back to sign-in');
  users.push({ id: 'usr_bob', name: 'bob', role: 'user', disabled: false, created_at: 't' });
  TOKENS.set('B'.repeat(43), 'usr_bob');
  const login = await send('GET', '/console/login');
  const nonce = cookieValue(login, 'circle_hub_login');
  const signedIn = await send('POST', '/console/login', { cookie: `circle_hub_login=${nonce}`, body: form({ csrf: nonce, token: 'B'.repeat(43) }) });
  const bob = cookieValue(signedIn, 'circle_hub_session');
  const bobPage = await send('GET', '/console/runs', { cookie: `circle_hub_session=${bob}` });
  const bobCsrf = /name="csrf" value="([^"]+)"/.exec(bobPage.body)?.[1] ?? '';
  assert.equal((await send('POST', '/console/admin/do/user-create', { cookie: `circle_hub_session=${bob}`, body: form({ csrf: bobCsrf, name: 'x' }) })).status, 404, 'a non-admin gets the neutral page');
  assert.equal((await send('GET', '/console/admin/packs', { cookie: `circle_hub_session=${bob}` })).status, 404);
  assert.equal(calls.length, 0, 'no refused request ran a command');
});

test('a zip upload is published from a private directory with --stage, and the directory is removed', async () => {
  calls.length = 0;
  const boundary = 'synthetic-boundary-31415';
  const zip = Buffer.from(zipSync({ 'synthetic-pack/pack.json': strToU8('{"id":"synthetic-pack"}'), 'synthetic-pack/README.md': strToU8('x') }));
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="csrf"\r\n\r\n${csrf}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="archive"; filename="pack.zip"\r\nContent-Type: application/zip\r\n\r\n`),
    zip,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const answer = await send('POST', '/console/admin/do/pack-publish', { cookie: `circle_hub_session=${session}`, body, type: `multipart/form-data; boundary=${boundary}` });
  assert.equal(answer.status, 200, answer.body);
  const call = calls.at(-1)!;
  assert.equal(call.argv[0], 'pack');
  assert.equal(call.argv[1], 'publish');
  assert.equal(call.argv[3], '--stage');
  assert.equal(call.packJson, '{"id":"synthetic-pack"}');
  await assert.rejects(access(call.argv[2]), 'the unpacked directory is removed after the command');

  const bad = await send('POST', '/console/admin/do/pack-publish', { cookie: `circle_hub_session=${session}`, body: Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="csrf"\r\n\r\n${csrf}\r\n--${boundary}\r\nContent-Disposition: form-data; name="archive"; filename="x.zip"\r\n\r\nnot a zip\r\n--${boundary}--\r\n`), type: `multipart/form-data; boundary=${boundary}` });
  assert.equal(bad.status, 400);
  assert.match(bad.body, /不是 zip 文件/);
});

test('every action is declared with a page to return to', () => {
  for (const [name, action] of Object.entries(ACTIONS)) assert.ok(action.title && action.back.startsWith('/console/admin'), name);
});
