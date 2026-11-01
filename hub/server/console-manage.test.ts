// The console's management (decision 75) end to end over HTTP with synthetic records and a recording command bridge:
// first-admin setup with the one-time code, the management pages, actions as POST forms (own origin, the session's CSRF
// token, administrators only) turned into exact `circle-hub` argv, the secret value kept out of argv, a background job,
// and 发布任务包 in two steps: a zip upload checked with the dry run from a private directory, kept for its administrator
// alone until it is published or discarded, at most 30 minutes and never past the app's close, the directory gone after.
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
import { manifestDigest } from '../runs/api.ts';
import { ACTIONS } from './console/manage.ts';
import { NEUTRAL } from './console/pages.ts';
import { issueSetupCode } from './setup-code.ts';

interface User { id: string; name: string; role: 'user' | 'admin'; disabled: boolean; created_at: string }

const TOKENS = new Map<string, string>(); // token -> user id
const users: User[] = [];
let dataDir: string;
let port: number;
let close: () => Promise<void>;
const calls: { argv: readonly string[]; input: CommandInput; packJson?: string }[] = [];
/** What the pack catalog lists: a test adds a version to make an upload the same content as a published one. */
const listed: Record<string, unknown>[] = [{ id: 'synthetic-flow', version: '1.0.0', kind: 'workflow', title: '合成流程', owner: 'usr_admin', digest: 'd', published_at: 't', withdrawn: false, active: false, samples: {}, assigned_to: [] }];
/** Added to the app's clock: a test moves time past a stage's expiry. */
let shift = 0;

const bridge: CommandBridge = {
  async run(argv, input) {
    const call: (typeof calls)[number] = { argv, input };
    if (argv[0] === 'pack' && argv[1] === 'publish') call.packJson = await readFile(join(argv[2], 'pack.json'), 'utf8');
    calls.push(call);
    if (argv[0] === 'pack' && argv[1] === 'publish' && call.packJson?.includes('echo-pack')) return { code: 1, stdout: [], stderr: [`读不出 ${argv[2]} 里的 pack.json`] };
    if (argv[0] === 'pack' && argv[1] === 'publish' && call.packJson?.includes('failing-pack')) return { code: 1, stdout: [], stderr: ['- [publish.unsampled] checks.json：检查 titles 没有反例样例（处理：补一个反例样例）'] };
    if (argv[0] === 'pack' && argv[1] === 'publish' && argv.includes('--dry-run')) return { code: 0, stdout: ['发布校验通过：synthetic-pack@1.0.0（工作流包，摘要 ' + 'e'.repeat(64) + '）：样例 4/4 通过', '包 synthetic-pack 还没有已发布的版本，没有可比较的当前版本', '试运行：没有发布，也没有写入任何内容；去掉 --dry-run 即发布这个版本'], stderr: [] };
    if (argv[0] === 'pack' && argv[1] === 'publish') return { code: 0, stdout: ['已发布 synthetic-pack@1.0.0（工作流包，摘要 ' + 'e'.repeat(64) + '）：样例 4/4 通过'], stderr: [] };
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
    now: () => new Date(Date.now() + shift),
    config: { host: '127.0.0.1', port: 0, dataDir, limits: { maxRequestBytes: 1 << 20, maxUploadBytes: 1 << 20 } },
    records: { principals, authorizations: { packsFor: async () => [], canPublish: async () => false, history: async () => ({ items: [] }) } },
    resources: { list: async () => [{ id: 'res_1', system_pack: 'synthetic-system', name: '合成系统', environment: 'shared', enabled: true, origins: { api: 'https://192.0.2.20' } }] },
    packs: { list: async () => listed },
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
  assert.match(noCode.body, /没有有效的初始化码/);

  const code = await issueSetupCode(dataDir);
  const again = await send('GET', '/console/setup');
  const second = cookieValue(again, 'circle_hub_setup');
  const wrong = await send('POST', '/console/setup', { cookie: `circle_hub_setup=${second}`, body: form({ csrf: second, code: 'ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ', name: 'root' }) });
  assert.equal(wrong.status, 403);
  assert.match(wrong.body, /初始化码不正确/);

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

test('the four operation pages carry the management forms of the console, and every management page answers', async () => {
  // Proposal decision 6 (2026-10-31): the console runs four operations; every other one is a command for the Circle.
  const forms = { member: 'member-add', system: 'system-add', pack: 'pack-stage', knowledge: 'knowledge-sync' } as const;
  for (const [operation, action] of Object.entries(forms)) {
    const page = await send('GET', `/console/operations/${operation}`, { cookie: `circle_hub_session=${session}` });
    assert.equal(page.status, 200, operation);
    assert.match(page.body, new RegExp(`action="/console/admin/do/${action}"`), operation);
    csrf = csrfOf(page.body);
  }
  const admin = await send('GET', '/console/admin', { cookie: `circle_hub_session=${session}` });
  assert.equal(admin.status, 200);
  assert.doesNotMatch(admin.body, /action="\/console\/admin\/do\/(?:user-disable|token-revoke|token-issue)"/, 'no form for an operation the Circle runs');
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

  // Adding a member creates the account, then issues an invitation code for the standard authorization, shown once with
  // the Circle entry of this Hub (no token in it); a client without the standard authorization gets a token instead.
  const member = await post('member-add', { name: 'carol', role: 'user', label: 'MacBook' });
  assert.equal(member.status, 200, member.body);
  assert.deepEqual(calls.slice(-2).map((call) => call.argv), [['user', 'create', 'carol', '--role=user'], ['user', 'invite', 'carol']]);
  assert.ok(/邀请码只显示这一次/.test(member.body) && /mcp_servers/.test(member.body) && /授权页/.test(member.body));
  assert.ok(!member.body.includes('CIRCLE_HUB_TOKEN'), 'the standard authorization needs no token in the Circle entry');
  const withToken = await post('member-add', { name: 'dave', role: 'user', label: 'MacBook', connect: 'token' });
  assert.equal(withToken.status, 200, withToken.body);
  assert.deepEqual(calls.slice(-2).map((call) => call.argv), [['user', 'create', 'dave', '--role=user'], ['token', 'issue', 'dave', '--label=MacBook']]);
  assert.ok(withToken.body.includes('T'.repeat(43)) && /令牌只显示这一次/.test(withToken.body) && /CIRCLE_HUB_TOKEN/.test(withToken.body));
  assert.equal((await post('member-add', { name: 'erin', role: 'user', connect: 'password' })).status, 400);

  // Connecting a business system adds the resource first, then sets its credential; the value never enters argv.
  await post('system-add', { system_pack: 'synthetic-system', name: '合成系统', environment: 'shared', origins: 'api=https://192.0.2.20', plaintext: '', settings: '', credentials: 'token=DEMO', secret_name_1: 'DEMO', value_1: ' synthetic value ' });
  const [added, secretSet] = calls.slice(-2);
  assert.deepEqual(added.argv, ['resource', 'add', 'synthetic-system', '--name=合成系统', '--environment=shared', '--origin=api=https://192.0.2.20', '--credential=token=DEMO']);
  assert.deepEqual(secretSet.argv, ['secret', 'set', '--name=DEMO', '--reason=接入业务系统 合成系统']);
  assert.deepEqual(secretSet.input.secrets, { DEMO: ' synthetic value ' }, 'the content is taken as typed');
  assert.ok(!calls.some((call) => call.argv.join(' ').includes('synthetic value')));
  const halfSecret = await post('system-add', { system_pack: 'synthetic-system', name: '合成', environment: 'shared', origins: 'api=https://192.0.2.20', secret_name_1: 'DEMO', value_1: '' });
  assert.equal(halfSecret.status, 400, 'a credential needs both its name and its content');

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

const BOUNDARY = 'synthetic-boundary-31415';

/** A multipart upload of a zip holding one pack directory with this pack.json. */
function upload(packJson: Record<string, unknown>, csrfToken = csrf): { body: Buffer; type: string } {
  const zip = Buffer.from(zipSync({ 'synthetic-pack/pack.json': strToU8(JSON.stringify(packJson)), 'synthetic-pack/README.md': strToU8('x') }));
  return {
    body: Buffer.concat([
      Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="csrf"\r\n\r\n${csrfToken}\r\n`),
      Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="archive"; filename="pack.zip"\r\nContent-Type: application/zip\r\n\r\n`),
      zip,
      Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
    ]),
    type: `multipart/form-data; boundary=${BOUNDARY}`,
  };
}

const PACK = { id: 'synthetic-pack', version: '1.0.0', kind: 'workflow', files: [] };
const stageIdOf = (body: string): string => /name="stage" value="([^"]+)"/.exec(body)![1];

async function stage(cookie: string, packJson: Record<string, unknown> = PACK, csrfToken = csrf): Promise<{ answer: Answer; dir: string }> {
  const answer = await send('POST', '/console/admin/do/pack-stage', { cookie, ...upload(packJson, csrfToken) });
  const call = calls.at(-1)!;
  return { answer, dir: call.argv[2] };
}

test('发布任务包 checks the upload with the dry run first, then publishes the staged directory, which is removed after', async () => {
  calls.length = 0;
  const cookie = `circle_hub_session=${session}`;
  const { answer, dir } = await stage(cookie);
  assert.equal(answer.status, 200, answer.body);
  const check = calls.at(-1)!;
  assert.deepEqual([check.argv[0], check.argv[1], check.argv[3], check.argv[4]], ['pack', 'publish', '--stage', '--dry-run'], 'the check is the dry run of publish');
  assert.equal(check.input.token, 'A'.repeat(43), 'as the signed-in administrator');
  assert.match(answer.body, /发布校验已通过/);
  assert.match(answer.body, /还没有已发布的版本，没有可比较的当前版本/, 'the comparison with the version in use is on the page');
  assert.match(answer.body, /action="\/console\/admin\/do\/pack-publish"/);
  assert.match(answer.body, /等待发布中/);
  assert.ok(!answer.body.includes(dir) && !answer.body.includes('circle-hub-upload-'), 'the private directory never appears in a page');
  await access(dir);
  const id = stageIdOf(answer.body);
  const operation = await send('GET', '/console/operations/pack', { cookie });
  assert.ok(operation.body.includes(id) && /暂存的任务包/.test(operation.body), 'the operation page lists the stage');

  const published = await send('POST', '/console/admin/do/pack-publish', { cookie, body: form({ csrf, stage: id }) });
  assert.equal(published.status, 200, published.body);
  assert.deepEqual(calls.at(-1)!.argv, ['pack', 'publish', dir, '--stage'], 'the directory that passed the check is the one published');
  assert.equal(calls.length, 2);
  assert.match(published.body, /已发布 synthetic-pack@1\.0\.0/);
  assert.ok(!published.body.includes(dir));
  await assert.rejects(access(dir), 'the staged directory is removed after publishing');
  const again = await send('POST', '/console/admin/do/pack-publish', { cookie, body: form({ csrf, stage: id }) });
  assert.equal(again.status, 404, 'a published stage is gone');
  assert.match(again.body, new RegExp(NEUTRAL));
  assert.equal(calls.length, 2, 'and runs nothing');
});

test('a failing check offers no 发布 step and keeps nothing; content already published is not staged either', async () => {
  calls.length = 0;
  const cookie = `circle_hub_session=${session}`;
  const failing = await stage(cookie, { ...PACK, id: 'failing-pack' });
  assert.equal(failing.answer.status, 409);
  assert.match(failing.answer.body, /未通过发布校验/);
  assert.match(failing.answer.body, /publish\.unsampled/);
  assert.doesNotMatch(failing.answer.body, /pack-publish/, 'no 发布 form');
  await assert.rejects(access(failing.dir), 'nothing is kept');

  const same = { ...PACK, id: 'published-pack' };
  listed.push({ ...listed[0], id: 'published-pack', version: '1.0.0', digest: manifestDigest(same) });
  const known = await stage(cookie, same);
  assert.equal(known.answer.status, 200);
  assert.match(known.answer.body, /相同内容已发布为/);
  assert.doesNotMatch(known.answer.body, /pack-publish/);
  await assert.rejects(access(known.dir));

  // A message of the command that names the private directory shows <目录> instead.
  const echoed = await stage(cookie, { ...PACK, id: 'echo-pack' });
  assert.equal(echoed.answer.status, 409);
  assert.ok(!echoed.answer.body.includes(echoed.dir) && echoed.answer.body.includes('读不出 &lt;目录&gt; 里的 pack.json'), echoed.answer.body);
  await assert.rejects(access(echoed.dir));

  const empty = await send('POST', '/console/admin/do/pack-stage', { cookie, body: Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="csrf"\r\n\r\n${csrf}\r\n--${BOUNDARY}\r\nContent-Disposition: form-data; name="archive"; filename="x.zip"\r\n\r\nnot a zip\r\n--${BOUNDARY}--\r\n`), type: `multipart/form-data; boundary=${BOUNDARY}` });
  assert.equal(empty.status, 400);
  assert.match(empty.body, /不是 zip 文件/);
  assert.equal(calls.length, 3, 'an upload that is not a zip runs nothing');
});

test('only the administrator who staged a pack can publish or discard it; any other id reads the same', async () => {
  calls.length = 0;
  const cookie = `circle_hub_session=${session}`;
  users.push({ id: 'usr_dave', name: 'dave', role: 'admin', disabled: false, created_at: 't' });
  TOKENS.set('D'.repeat(43), 'usr_dave');
  const login = await send('GET', '/console/login');
  const nonce = cookieValue(login, 'circle_hub_login');
  const signedIn = await send('POST', '/console/login', { cookie: `circle_hub_login=${nonce}`, body: form({ csrf: nonce, token: 'D'.repeat(43) }) });
  const dave = `circle_hub_session=${cookieValue(signedIn, 'circle_hub_session')}`;
  const daveCsrf = csrfOf((await send('GET', '/console/operations/pack', { cookie: dave })).body);

  const { answer, dir } = await stage(cookie);
  const id = stageIdOf(answer.body);
  const unknown = await send('POST', '/console/admin/do/pack-publish', { cookie: dave, body: form({ csrf: daveCsrf, stage: 'x'.repeat(24) }) });
  const foreign = await send('POST', '/console/admin/do/pack-publish', { cookie: dave, body: form({ csrf: daveCsrf, stage: id }) });
  assert.equal(foreign.status, 404);
  assert.equal(foreign.body.replace(/name="csrf" value="[^"]+"/g, ''), unknown.body.replace(/name="csrf" value="[^"]+"/g, ''), 'someone else\'s stage reads like an unknown one');
  assert.equal((await send('POST', '/console/admin/do/pack-discard', { cookie: dave, body: form({ csrf: daveCsrf, stage: id }) })).status, 404);
  assert.ok(!(await send('GET', '/console/operations/pack', { cookie: dave })).body.includes(id), 'and is not listed for them');
  assert.equal(calls.length, 1, 'only the check ran');
  await access(dir);
  assert.equal((await send('POST', '/console/admin/do/pack-publish', { cookie, body: form({ csrf: 'wrong', stage: id }) })).status, 403, 'the 发布 step needs the session CSRF token');

  const discarded = await send('POST', '/console/admin/do/pack-discard', { cookie, body: form({ csrf, stage: id }) });
  assert.equal(discarded.status, 200);
  assert.match(discarded.body, /已放弃暂存的任务包/);
  await assert.rejects(access(dir), 'discarding removes the directory');
  assert.equal(calls.length, 1, 'discarding publishes nothing');
});

test('a stage expires after 30 minutes: its 发布 step reads like an unknown stage and its directory is removed', async () => {
  calls.length = 0;
  const cookie = `circle_hub_session=${session}`;
  const { answer, dir } = await stage(cookie);
  const id = stageIdOf(answer.body);
  shift += 31 * 60 * 1000;
  const expired = await send('POST', '/console/admin/do/pack-publish', { cookie, body: form({ csrf, stage: id }) });
  assert.equal(expired.status, 404);
  assert.match(expired.body, new RegExp(NEUTRAL));
  await assert.rejects(access(dir), 'the expired directory is removed');
  assert.equal(calls.length, 1, 'nothing was published');
});

test('every action is declared with a page to return to', () => {
  for (const [name, action] of Object.entries(ACTIONS)) assert.ok(action.title && /^\/console\/(?:admin|operations)(?:\/|$)/.test(action.back), name);
});

test('closing the app removes every staged directory', async () => {
  const cookie = `circle_hub_session=${session}`;
  const { answer, dir } = await stage(cookie);
  assert.equal(answer.status, 200);
  await access(dir);
  await close();
  await assert.rejects(access(dir), 'no staged directory outlives the app');
});
