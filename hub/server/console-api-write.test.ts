// The write interfaces of /console/api over HTTP with synthetic principals and a recording command bridge: an
// administrator's session, this console's Origin and the session's CSRF token in X-CSRF-Token, then the same `circle-hub`
// argv as the HTML forms; the value shown once in a structured answer; 400, 409 and 503 as the doc maps them; commands
// that are only described; and the neutral answer for members and unknown objects.
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { request } from 'node:http';
import { strToU8, zipSync } from 'fflate';
import { after, before, test } from 'node:test';
import type { ServerDeps } from './api.ts';
import { createApp } from './app.ts';
import type { CommandBridge, CommandInput } from './command-bridge.ts';

interface User { id: string; name: string; role: 'user' | 'admin'; disabled: boolean; created_at: string; updated_at: string }

/** The token of each account's console session: what openConsoleSession issues and the commands then act with. */
const ADMIN_TOKEN = 'A'.repeat(43);
const MEMBER_TOKEN = 'M'.repeat(43);
const TOKENS = new Map([[ADMIN_TOKEN, 'usr_00000000000000000000000001'], [MEMBER_TOKEN, 'usr_00000000000000000000000002']]);
/** Every synthetic account, administrators included, signs in to the console with this password; a token never does. */
const PASSWORD = 'synthetic-api-password';
const users: User[] = [
  { id: 'usr_00000000000000000000000001', name: 'root', role: 'admin', disabled: false, created_at: '2026-11-01T00:00:00.000Z', updated_at: '2026-11-01T00:00:00.000Z' },
  { id: 'usr_00000000000000000000000002', name: 'bob', role: 'user', disabled: false, created_at: '2026-11-01T00:00:00.000Z', updated_at: '2026-11-01T00:00:00.000Z' },
];
const calls: { argv: readonly string[]; input: CommandInput }[] = [];

const bridge: CommandBridge = {
  async run(argv, input) {
    calls.push({ argv, input });
    if (argv.includes('fails')) return { code: 1, stdout: [], stderr: ['用户名已经存在'] };
    if (argv[0] === 'user' && argv[1] === 'create') return {code:0,stdout:['初始密码（仅显示一次，首次登录必须修改）：','p'.repeat(24)],stderr:[]};
    if (argv[0] === 'user' && argv[1] === 'invite') return { code: 0, stdout: [`已为 ${argv[2]} 签发邀请码，2026-11-02T00:00:00.000Z 前有效，仅可使用一次。邀请码只显示这一次：`, 'ABCD-EFGH-JKMN', '成员的 Circle 连接这个 Hub 时，浏览器打开授权页，在授权页输入邀请码'], stderr: [] };
    if (argv[0] === 'token' && argv[1] === 'issue') return { code: 0, stdout: ['已签发令牌 tok_synthetic。令牌只显示这一次：', 'T'.repeat(43)], stderr: [] };
    if (argv[0] === 'pack' && argv[1] === 'publish' && argv.includes('--dry-run')) return { code: 0, stdout: [`发布校验通过：synthetic-pack@1.0.0，检查目录 ${argv[2]}`, '试运行：没有发布，也没有写入任何内容'], stderr: [] };
    if (argv[0] === 'pack' && argv[1] === 'publish') return { code: 0, stdout: ['已发布 synthetic-pack@1.0.0'], stderr: [] };
    return { code: 0, stdout: [`已执行 ${argv.slice(0, 2).join(' ')}`], stderr: [] };
  },
};

const principals = {
  async verifyPassword(name: string, password: string) {
    const user=users.find(user=>user.name===name && !user.disabled);
    return user && password===PASSWORD ? {user,revision:1,mustChange:false} : null;
  },
  async openConsoleSession(id:string) {
    const token=[...TOKENS].find(([,user])=>user===id)?.[0];
    return token === undefined ? null : {token};
  },
  async passwordState() {return {configured:true,mustChange:false,revision:1};},
  async authenticate(header: string | null | undefined) {
    const id = TOKENS.get(String(header).replace(/^Bearer /, ''));
    const user = users.find((u) => u.id === id && !u.disabled);
    return user ? { id: user.id, name: user.name, role: user.role } : null;
  },
  async list() { return users; },
  async get(id: string) { return users.find((u) => u.id === id) ?? null; },
  async tokens(userId: string) {
    return userId === users[1].id ? [{ id: 'tok_00000000000000000000000009', user: userId, label: 'Circle', client: null, created_at: '2026-11-01T00:00:00.000Z', created_by: null, last_used_at: null, revoked_at: null }] : [];
  },
};

function depsFor(): ServerDeps {
  return {
    config: { host: '127.0.0.1', port: 0, dataDir: '/nonexistent', limits: { maxRequestBytes: 1 << 20, maxUploadBytes: 1 << 20 } },
    records: { principals, authorizations: { packsFor: async () => [], canPublish: async () => false, history: async () => ({ items: [] }) } },
    resources: { list: async () => [{ id: 'res_1', system_pack: 'synthetic-system', name: '合成系统', environment: 'shared', enabled: true, origins: { api: 'https://192.0.2.20' } }] },
    packs: { list: async () => [{ id: 'synthetic-flow', version: '1.0.0', kind: 'workflow', title: '合成流程', owner: users[0].id, digest: 'd', published_at: 't', withdrawn: false, active: false, samples: {}, assigned_to: [] }] },
  } as unknown as ServerDeps;
}

let port: number;
let barePort: number;
const closers: (() => Promise<void>)[] = [];

before(async () => {
  const app = createApp(depsFor(), { bridge, log: () => {} });
  port = (await app.listen()).port;
  const bare = createApp(depsFor(), { log: () => {} });
  barePort = (await bare.listen()).port;
  closers.push(() => app.close(), () => bare.close());
});
after(async () => {
  for (const close of closers) await close();
});

interface Answer { status: number; body: string; headers: Record<string, string | string[] | undefined> }

function send(method: string, path: string, options: { cookie?: string; body?: string | Buffer; type?: string; origin?: string | null; csrf?: string; port?: number } = {}): Promise<Answer> {
  const at = options.port ?? port;
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: at, path, method, agent: false, headers: {
      host: `127.0.0.1:${at}`,
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...(options.origin === null ? {} : { origin: options.origin ?? `http://127.0.0.1:${at}` }),
      ...(options.csrf ? { 'x-csrf-token': options.csrf } : {}),
      ...(options.body === undefined ? {} : { 'content-type': options.type ?? 'application/json', 'content-length': String(Buffer.byteLength(options.body)) }),
    } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers }));
    });
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

/** Signs an account in with its username and password, as every account does. */
async function signIn(username: string, at = port): Promise<{ cookie: string; csrf: string }> {
  const page = await send('GET', '/console/login', { port: at, origin: null });
  const nonce = /name="csrf" value="([^"]+)"/.exec(page.body)![1];
  const loginCookie = ([] as string[]).concat(page.headers['set-cookie'] ?? []).find((c) => c.startsWith('circle_hub_login='))!.split(';')[0];
  const reply = await send('POST', '/console/login', { port: at, cookie: loginCookie, type: 'application/x-www-form-urlencoded', body: new URLSearchParams({ username, password: PASSWORD, csrf: nonce }).toString() });
  assert.equal(reply.status, 303, reply.body);
  const cookie = ([] as string[]).concat(reply.headers['set-cookie'] ?? []).find((c) => c.startsWith('circle_hub_session='))!.split(';')[0];
  const me = JSON.parse((await send('GET', '/console/api/me', { port: at, cookie, origin: null })).body);
  return { cookie, csrf: me.csrf as string };
}

let admin: { cookie: string; csrf: string };
const post = (path: string, body: unknown, who = admin, extra: { origin?: string | null; csrf?: string; type?: string } = {}) =>
  send('POST', `/console/api/${path}`, { cookie: who.cookie, csrf: extra.csrf ?? who.csrf, body: typeof body === 'string' ? body : JSON.stringify(body), ...(extra.type ? { type: extra.type } : {}), ...('origin' in extra ? { origin: extra.origin } : {}) });

test('a write needs this console\'s Origin, the session\'s CSRF token in its header, a JSON object and an administrator', async () => {
  admin = await signIn('root');
  const member = await signIn('bob');
  calls.length = 0;
  assert.equal((await post('members', { name: 'carol' }, admin, { origin: null })).status, 403, 'no Origin');
  assert.equal((await post('members', { name: 'carol' }, admin, { origin: 'http://192.0.2.1' })).status, 403, 'a foreign Origin');
  assert.equal((await post('members', { name: 'carol' }, admin, { csrf: 'wrong' })).status, 403, 'a wrong CSRF token');
  assert.equal((await post('members', 'name=carol', admin, { type: 'application/x-www-form-urlencoded' })).status, 400);
  assert.equal((await post('members', '[1]')).status, 400);
  assert.equal((await post('members', { name: 'carol', role: 3 })).status, 400, 'a field is a string or a boolean');
  assert.equal((await send('POST', '/console/api/members', { body: '{}' })).status, 401);
  const refused = await post('members', { name: 'carol' }, member);
  assert.equal(refused.status, 404);
  assert.equal(JSON.parse(refused.body).code, 'SOURCE_UNAVAILABLE');
  assert.equal((await post('me', {})).status, 405, 'a read interface takes no POST');
  // A member's upload is answered before it is read, with the same neutral answer.
  const upload = await send('POST', '/console/api/packs/stage', { cookie: member.cookie, csrf: member.csrf, body: Buffer.alloc(256 * 1024, 1), type: 'multipart/form-data; boundary=x' });
  assert.equal(upload.status, 404);
  assert.equal(JSON.parse(upload.body).code, 'SOURCE_UNAVAILABLE');
  assert.deepEqual(calls, [], 'nothing ran');
});

test('adding a member runs user create then user invite and answers the invitation code with the Circle entry', async () => {
  calls.length = 0;
  const reply = await post('members', { name: 'carol', role: 'user' });
  assert.equal(reply.status, 200, reply.body);
  assert.deepEqual(calls.map((call) => call.argv), [['user', 'create', 'carol', '--role=user'], ['user', 'invite', 'carol']]);
  assert.ok(calls.every((call) => call.input.token === ADMIN_TOKEN), 'the commands act as the signed-in administrator');
  const body = JSON.parse(reply.body);
  assert.equal(body.initial_password,'p'.repeat(24));
  assert.equal(body.must_change_password,true);
  assert.equal(body.invitation, 'ABCD-EFGH-JKMN');
  assert.deepEqual(body.circle_entry.mcp_servers[0], { name: 'circle-hub', url: `http://127.0.0.1:${port}/mcp`, transport: 'streamable_http' });
  assert.deepEqual(body.steps.map((step: { command: string }) => step.command), ['circle-hub user create carol --role=user', 'circle-hub user invite carol']);

  const token = JSON.parse((await post('members', { name: 'dave', connect: 'token', label: 'MacBook' })).body);
  assert.equal(token.token, 'T'.repeat(43));
  assert.ok(token.circle_entry.mcp_servers[0].headers.Authorization.includes('CIRCLE_HUB_TOKEN'));

  const usage = await post('members', { name: '-x' });
  assert.equal(usage.status, 400);
  assert.equal(JSON.parse(usage.body).code, null);
  const failed = await post('members', { name: 'fails' });
  assert.equal(failed.status, 409);
  const answer = JSON.parse(failed.body);
  assert.equal(answer.message, '操作未完成');
  assert.equal(answer.fix, '用户名已经存在');
  assert.equal(answer.steps.length, 1, 'the commands after the one that did not finish were not run');
});

test('connecting a system keeps the credential out of argv and out of the answer; an import runs in the background', async () => {
  calls.length = 0;
  const reply = await post('systems', { system_pack: 'synthetic-system', name: '合成系统', environment: 'shared', origins: 'api=https://192.0.2.20', credentials: 'token=DEMO', secret_name_1: 'DEMO', value_1: ' synthetic value ' });
  assert.equal(reply.status, 200, reply.body);
  assert.deepEqual(calls[0].argv, ['resource', 'add', 'synthetic-system', '--name=合成系统', '--environment=shared', '--origin=api=https://192.0.2.20', '--credential=token=DEMO']);
  assert.deepEqual(calls[1].input.secrets, { DEMO: ' synthetic value ' });
  assert.ok(!reply.body.includes('synthetic value') && !calls.some((call) => call.argv.join(' ').includes('synthetic value')));

  const job = await post('knowledge/imports', { product: 'synthetic', dry_run: true });
  assert.equal(job.status, 202, job.body);
  const started = JSON.parse(job.body);
  assert.equal(started.command, 'circle-hub knowledge sync --product=synthetic --dry-run');
  const status = await send('GET', started.status_url, { cookie: admin.cookie, origin: null });
  assert.equal(status.status, 200, status.body);
});

test('every other operation is only described, for an object that exists', async () => {
  calls.length = 0;
  const described = JSON.parse((await post('commands', { operation: 'user-disable', object: users[1].id })).body);
  assert.equal(described.executed, false);
  assert.equal(described.command, `circle-hub user disable ${users[1].id}`);
  assert.equal(JSON.parse((await post('commands', { operation: 'user-invite', object: users[1].id })).body).command, `circle-hub user invite ${users[1].id}`);
  assert.equal(JSON.parse((await post('commands', { operation: 'token-revoke', object: 'tok_00000000000000000000000009' })).body).command, 'circle-hub token revoke tok_00000000000000000000000009');
  assert.equal(JSON.parse((await post('commands', { operation: 'resource-toggle', object: 'res_1' })).body).command, 'circle-hub resource disable res_1');
  assert.match(JSON.parse((await post('commands', { operation: 'pack-assign', object: 'synthetic-flow' })).body).command, /pack assign '成员编号' synthetic-flow/);
  assert.equal(JSON.parse((await post('commands', { operation: 'backup', object: '' })).body).command, 'circle-hub backup');
  for (const [operation, object] of [['user-disable', 'usr_00000000000000000000000099'], ['token-revoke', 'tok_x'], ['pack-retire', 'synthetic-flow@9.9.9'], ['format-disk', ''], ['backup', 'x']]) {
    assert.equal((await post('commands', { operation, object })).status, 404, `${operation} ${object}`);
  }
  assert.deepEqual(calls, [], 'describing runs nothing');
});

const BOUNDARY = 'synthetic-boundary-27182';

function zipUpload(): Buffer {
  const zip = Buffer.from(zipSync({ 'synthetic-pack/pack.json': strToU8(JSON.stringify({ id: 'synthetic-pack', version: '1.0.0', kind: 'workflow', files: [] })) }));
  return Buffer.concat([
    Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="archive"; filename="pack.zip"\r\nContent-Type: application/zip\r\n\r\n`),
    zip,
    Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
  ]);
}

test('a task pack is checked from its zip into a stage, then published by the administrator who staged it', async () => {
  calls.length = 0;
  const staged = await send('POST', '/console/api/packs/stage', { cookie: admin.cookie, csrf: admin.csrf, body: zipUpload(), type: `multipart/form-data; boundary=${BOUNDARY}` });
  assert.equal(staged.status, 200, staged.body);
  const answer = JSON.parse(staged.body);
  const dir = calls[0].argv[2];
  assert.deepEqual([calls[0].argv[0], calls[0].argv[1], calls[0].argv[3], calls[0].argv[4]], ['pack', 'publish', '--stage', '--dry-run']);
  assert.equal(answer.stage.pack, 'synthetic-pack');
  assert.ok(!staged.body.includes(dir), 'the private directory never appears in an answer');
  await access(dir);
  assert.equal((await send('POST', '/console/api/packs/stage', { cookie: admin.cookie, csrf: admin.csrf, body: 'x', type: 'text/plain' })).status, 400);

  // Another administrator's session cannot publish it: the stage belongs to the one who checked it.
  users.push({ id: 'usr_00000000000000000000000003', name: 'root2', role: 'admin', disabled: false, created_at: users[0].created_at, updated_at: users[0].updated_at });
  TOKENS.set('C'.repeat(43), 'usr_00000000000000000000000003');
  const other = await signIn('root2');
  assert.equal((await post(`packs/stage/${answer.stage.id}/publish`, {}, other)).status, 404);

  const published = await post(answer.publish_url.replace('/console/api/', ''), {});
  assert.equal(published.status, 200, published.body);
  assert.deepEqual(calls.at(-1)!.argv, ['pack', 'publish', dir, '--stage']);
  assert.equal(JSON.parse(published.body).version, '1.0.0');
  await assert.rejects(access(dir), 'the stage is gone after publishing');
  assert.equal((await post(answer.publish_url.replace('/console/api/', ''), {})).status, 404, 'a stage is published once');

  const again = JSON.parse((await send('POST', '/console/api/packs/stage', { cookie: admin.cookie, csrf: admin.csrf, body: zipUpload(), type: `multipart/form-data; boundary=${BOUNDARY}` })).body);
  assert.equal(JSON.parse((await post(`packs/stage/${again.stage.id}/discard`, {})).body).discarded.id, again.stage.id);
  assert.equal((await post(`packs/stage/${again.stage.id}/publish`, {})).status, 404);
});

test('without a command bridge the operations answer 503 and point to the administrator\'s Circle', async () => {
  const bare = await signIn('root', barePort);
  const reply = await send('POST', '/console/api/members', { port: barePort, cookie: bare.cookie, csrf: bare.csrf, body: JSON.stringify({ name: 'carol' }) });
  assert.equal(reply.status, 503);
  assert.match(JSON.parse(reply.body).fix, /管理员的 Circle/);
});
