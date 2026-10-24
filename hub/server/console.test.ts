// The console: sign-in with a token (with the Origin a browser derives under the pages' Referrer-Policy), cookie flags, CSRF
// and same-origin refusals, the strict CSP, escaping of stored case text, the pages (runs, run detail with the three groups,
// item cells, partitions, claims and the submissions marked unverified, knowledge, packs, admin) with their visibility, and
// that a revoked token or a sign-out ends the session at once.
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { after, before, describe, test } from 'node:test';
import { DISPLAY_ORDER } from '../../contracts/generated/protocol.ts';
import type { PermissionRole } from '../../contracts/generated/vocabulary.ts';
import { startPostgres, type TemporaryPostgres } from '../testing/postgres.ts';
import { ROOT_1, ROOT_2 } from './fakes.ts';
import { createTestServer, type TestServer, type TestUser } from './testing.ts';

let postgres: TemporaryPostgres;
let server: TestServer;
let counter = 0;

before(async () => {
  postgres = await startPostgres();
  server = await createTestServer({ postgres });
});
after(async () => {
  await server?.close();
  await postgres?.stop();
});

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function send(path: string, options: { method?: string; headers?: Record<string, string>; body?: string; port?: number } = {}): Promise<Reply> {
  const port = options.port ?? server.port;
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path, method: options.method ?? 'GET', headers: { host: `127.0.0.1:${port}`, ...options.headers }, setHost: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

const cookieHeader = (reply: Reply, name: string): string | undefined =>
  ([] as string[]).concat(reply.headers['set-cookie'] ?? []).find((value) => value.startsWith(`${name}=`));
const cookieValue = (header: string | undefined): string => (header ?? '').split(';')[0].split('=').slice(1).join('=');
const csrfOf = (body: string): string => /name="csrf" value="([^"]+)"/.exec(body)?.[1] ?? '';
const own = () => `http://127.0.0.1:${server.port}`;
const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();

async function loginForm(port = server.port): Promise<{ nonce: string; cookie: string }> {
  const page = await send('/console/login', { port });
  return { nonce: csrfOf(page.body), cookie: `circle_hub_login=${cookieValue(cookieHeader(page, 'circle_hub_login'))}` };
}

async function signIn(token: string, port = server.port): Promise<string> {
  const { nonce, cookie } = await loginForm(port);
  const reply = await send('/console/login', {
    method: 'POST',
    port,
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie, origin: `http://127.0.0.1:${port}` },
    body: form({ token, csrf: nonce }),
  });
  assert.equal(reply.status, 303, reply.body);
  return `circle_hub_session=${cookieValue(cookieHeader(reply, 'circle_hub_session'))}`;
}

const get = (path: string, session: string) => send(path, { headers: { cookie: session } });

const POLICIES = ['no-referrer', 'no-referrer-when-downgrade', 'same-origin', 'origin', 'strict-origin', 'origin-when-cross-origin', 'strict-origin-when-cross-origin', 'unsafe-url'];

/**
 * The Origin header a browser sends with a form POST (a navigation, not CORS) from a page of `pageOrigin` served with the
 * Referrer-Policy header `policy`, to `target`: Fetch, "append a request Origin header" (non-GET, mode not cors). The last
 * recognised token of the header wins; without one the default is strict-origin-when-cross-origin.
 */
function browserOrigin(policy: string | string[] | undefined, pageOrigin: string, target: string): string {
  const tokens = String(policy ?? '').split(',').map((token) => token.trim().toLowerCase());
  const effective = tokens.filter((token) => POLICIES.includes(token)).at(-1) ?? 'strict-origin-when-cross-origin';
  const downgrade = pageOrigin.startsWith('https:') && !target.startsWith('https:');
  if (effective === 'no-referrer') return 'null';
  if (effective === 'same-origin') return new URL(target).origin === pageOrigin ? pageOrigin : 'null';
  if (['no-referrer-when-downgrade', 'strict-origin', 'strict-origin-when-cross-origin'].includes(effective)) return downgrade ? 'null' : pageOrigin;
  return pageOrigin;
}

async function person(packs: string[] = ['review'], role: PermissionRole = 'user', name?: string): Promise<TestUser> {
  counter += 1;
  const user = await server.createUser(name ?? `控制台用户${counter}`, role);
  for (const pack of packs) await server.assign(user.principal, pack);
  return user;
}

/** A run of the user with one submission accepted through the MCP tools (fake runs service). */
async function runWithResult(user: TestUser, findings: string[] = ['期望结果缺失'], sessionId?: string): Promise<string> {
  const client = await server.client(user.token, sessionId === undefined ? {} : { sessionId });
  const uploaded = await client.call('upload_file', { file_path: Buffer.from(`合成文档 ${counter}`).toString('base64') });
  const run = await client.call('start_run', { pack: 'review', inputs: { subject: { reference: String(uploaded.structuredContent.reference) } } });
  const summary = run.structuredContent.run as { run: string; items: { id: string }[] };
  const id = summary.run;
  await client.call('submit_result', {
    run: id,
    model: 'scripted-model@test',
    items: [
      { item: summary.items[0].id, handling: 'handled', slots: { findings: findings.map((text) => ({ text })) } },
      { item: summary.items[1].id, handling: 'handled', slots: { unknown: true } },
    ],
  });
  await client.close();
  return id;
}

describe('sign-in', () => {
  test('the login page has a strict CSP without script, frames denied, and a one-time nonce cookie scoped to the login path', async () => {
    const page = await send('/console/login');
    assert.equal(page.status, 200);
    const csp = String(page.headers['content-security-policy']);
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /style-src 'sha256-[A-Za-z0-9+/=]+'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /form-action 'self'/);
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|script-src/);
    assert.doesNotMatch(page.body, /<script/i);
    assert.equal(page.headers['x-frame-options'], 'DENY');
    const login = cookieHeader(page, 'circle_hub_login') ?? '';
    assert.match(login, /; Path=\/console\/login; HttpOnly; SameSite=Strict; Max-Age=900$/);
    assert.equal(cookieValue(login), csrfOf(page.body));
  });

  test('a valid token opens a session: HttpOnly, SameSite=Strict, Path=/console, and the token is not in the cookie', async () => {
    const user = await person();
    const { nonce, cookie } = await loginForm();
    const reply = await send('/console/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie, origin: own() }, body: form({ token: `Bearer ${user.token}`, csrf: nonce }) });
    assert.equal(reply.status, 303);
    assert.equal(reply.headers.location, '/console/runs');
    const session = cookieHeader(reply, 'circle_hub_session') ?? '';
    assert.match(session, /^circle_hub_session=[A-Za-z0-9_-]{43}; Path=\/console; HttpOnly; SameSite=Strict$/);
    assert.ok(!session.includes(user.token), 'the session cookie is not the token');
    assert.match(cookieHeader(reply, 'circle_hub_login') ?? '', /Max-Age=0/);
    const page = await get('/console/runs', `circle_hub_session=${cookieValue(session)}`);
    assert.equal(page.status, 200);
    assert.ok(page.body.includes(user.user.name));
  });

  test('CSRF: a missing, mismatched, reused or foreign nonce is refused; so is a form from another origin or of another type', async () => {
    const user = await person();
    const headers = (cookie: string, extra: Record<string, string> = {}) => ({ 'content-type': 'application/x-www-form-urlencoded', cookie, origin: own(), ...extra });
    const a = await loginForm();
    assert.equal((await send('/console/login', { method: 'POST', headers: headers(a.cookie), body: form({ token: user.token }) })).status, 403, 'no nonce');
    const b = await loginForm();
    assert.equal((await send('/console/login', { method: 'POST', headers: headers(a.cookie), body: form({ token: user.token, csrf: b.nonce }) })).status, 403, 'the nonce of another form');
    const forged = 'x'.repeat(43);
    assert.equal((await send('/console/login', { method: 'POST', headers: headers(`circle_hub_login=${forged}`), body: form({ token: user.token, csrf: forged }) })).status, 403, 'a nonce the server never issued');
    const c = await loginForm();
    assert.equal((await send('/console/login', { method: 'POST', headers: headers(c.cookie, { origin: 'http://localhost:9999' }), body: form({ token: user.token, csrf: c.nonce }) })).status, 403, 'another local origin');
    assert.equal((await send('/console/login', { method: 'POST', headers: headers(c.cookie, { 'content-type': 'application/json' }), body: JSON.stringify({ token: user.token, csrf: c.nonce }) })).status, 403, 'not a form');
    const d = await loginForm();
    assert.equal((await send('/console/login', { method: 'POST', headers: headers(d.cookie), body: form({ token: user.token, csrf: d.nonce }) })).status, 303);
    assert.equal((await send('/console/login', { method: 'POST', headers: headers(d.cookie), body: form({ token: user.token, csrf: d.nonce }) })).status, 403, 'a nonce is used once');
  });

  test('a browser can sign in and out: the Origin it derives under the pages\' Referrer-Policy is accepted', async () => {
    const user = await person();
    const login = await send('/console/login');
    const loginOrigin = browserOrigin(login.headers['referrer-policy'], own(), `${own()}/console/login`);
    assert.equal(loginOrigin, own(), 'a same-origin form post from the login page carries the real origin, not null');
    const signedIn = await send('/console/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: `circle_hub_login=${cookieValue(cookieHeader(login, 'circle_hub_login'))}`, origin: loginOrigin },
      body: form({ token: user.token, csrf: csrfOf(login.body) }),
    });
    assert.equal(signedIn.status, 303, signedIn.body);
    const session = `circle_hub_session=${cookieValue(cookieHeader(signedIn, 'circle_hub_session'))}`;
    const runs = await get('/console/runs', session);
    const pageOrigin = browserOrigin(runs.headers['referrer-policy'], own(), `${own()}/console/logout`);
    assert.equal(pageOrigin, own());
    const out = await send('/console/logout', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: session, origin: pageOrigin }, body: form({ csrf: csrfOf(runs.body) }) });
    assert.equal(out.status, 303);
    // Another origin still gets no referrer, and a POST from it stays refused (its Origin is foreign or null).
    assert.equal(browserOrigin(runs.headers['referrer-policy'], 'http://localhost:9999', `${own()}/console/logout`), 'null');
    const again = await loginForm();
    const foreign = await send('/console/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: again.cookie, origin: 'null' },
      body: form({ token: user.token, csrf: again.nonce }),
    });
    assert.equal(foreign.status, 403, 'Origin: null is never taken for this console');
  });

  test('a bad token is refused with a new form; pages without a session redirect to the login page', async () => {
    const { nonce, cookie } = await loginForm();
    const reply = await send('/console/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie, origin: own() }, body: form({ token: 'B'.repeat(43), csrf: nonce }) });
    assert.equal(reply.status, 401);
    assert.match(reply.body, /令牌无效/);
    assert.notEqual(csrfOf(reply.body), nonce);
    const anonymous = await send('/console/runs');
    assert.equal(anonymous.status, 303);
    assert.equal(anonymous.headers.location, '/console/login');
  });

  test('revoking the token ends the console session at the next page; signing out needs the session CSRF token', async () => {
    const user = await person();
    const session = await signIn(user.token);
    const page = await get('/console/runs', session);
    assert.equal(page.status, 200);
    const csrf = csrfOf(page.body);
    assert.equal((await send('/console/logout', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: session, origin: own() }, body: form({ csrf: 'wrong' }) })).status, 403);
    const out = await send('/console/logout', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: session, origin: own() }, body: form({ csrf }) });
    assert.equal(out.status, 303);
    assert.match(cookieHeader(out, 'circle_hub_session') ?? '', /Max-Age=0/);
    assert.equal((await get('/console/runs', session)).status, 303, 'the closed session is gone');

    const again = await signIn(user.token);
    assert.equal((await get('/console/runs', again)).status, 200);
    const [token] = await server.records.principals.tokens(user.user.id);
    await server.records.principals.revokeToken(server.admin.principal, token.id);
    const after = await get('/console/runs', again);
    assert.equal(after.status, 303);
    assert.equal(after.headers.location, '/console/login');
  });
});

describe('pages', () => {
  test('a run page shows partitions with labels, not applicable layers, unknown with its own symbol and claims in display order', async () => {
    const user = await person();
    const run = await runWithResult(user);
    const session = await signIn(user.token);
    const list = await get('/console/runs', session);
    assert.ok(list.body.includes(run));
    const page = await get(`/console/runs/${run}`, session);
    assert.equal(page.status, 200);
    for (const text of ['已交付', '未完成', '动态：本层不适用', '？ 静态：未核对', '✓ 静态：通过', '回执：已受理；分区：已交付 2', '期望结果缺失', '调用日志', 'submit_result']) {
      assert.ok(page.body.includes(text), `the run page shows ${text}`);
    }
    const blocks = [...page.body.matchAll(/<div class="claim"><dl>([\s\S]*?)<\/dl><\/div>/g)].map((m) => [...m[1].matchAll(/<dt>([^<]+)<\/dt>/g)].map((d) => d[1]));
    assert.ok(blocks.length >= 2, 'the target basis and the finding are shown as claims');
    const order: readonly string[] = DISPLAY_ORDER;
    for (const labels of blocks) {
      assert.ok(labels.length >= 4, 'a claim shows its fields');
      const positions = labels.map((label) => order.indexOf(label));
      assert.ok(positions.every((p) => p >= 0), 'only display fields');
      assert.deepEqual([...positions].sort((a, b) => a - b), positions, 'claim fields appear in DISPLAY_ORDER');
    }
    assert.ok(blocks.some((labels) => labels[0] === '位置'), 'a finding claim starts with its position');
    assert.doesNotMatch(page.body, /管理员备注/, 'a user sees no admin note column');
  });

  test('the run page shows each item\'s two cells by conjunction, the three groups and every submission verbatim, marked unverified', async () => {
    const user = await person();
    const run = await runWithResult(user, ['发现<甲>']);
    const session = await signIn(user.token);
    const page = await get(`/console/runs/${run}`, session);
    assert.equal(page.status, 200);
    // V03 R[3], display rule 4: one cell per layer, the strongest terminal and the counts of the non-pass values.
    assert.ok(page.body.includes('◇ 静态：判断（判断 1）'), 'a handled item: pass and judgment give judgment');
    assert.ok(page.body.includes('？ 静态：未核对（未核对 1，判断 1）'), 'unknown is not hidden behind the judgment');
    assert.ok(page.body.includes('… 静态：未完成（未完成 2）'), 'the item the submission did not cover');
    assert.ok(page.body.includes('动态：本层不适用'), 'a layer no requirement declares');
    // Display rule 5: unknown has its own colour.
    assert.match(page.body, /<span class="t-unknown">？ 静态：未核对/);
    assert.match(page.body, /\.t-unknown\{color:/);
    // Display rule 13: the three groups derived from the partition list.
    const adopted = page.body.indexOf('已采用的成果（已交付');
    const open = page.body.indexOf('仍需处理的事项（已拒收、已隔离、未完成');
    const requests = page.body.indexOf('未回答的请求');
    assert.ok(adopted > 0 && open > adopted && requests > open, 'adopted, still to handle, requests');
    // Display rule 3: the submission as received, marked unverified, next to its receipt.
    assert.ok(page.body.includes('提交内容（未经平台验证）'));
    assert.ok(page.body.includes('scripted-model@test'), 'the submitted text is shown');
    assert.ok(page.body.includes('发现&lt;甲&gt;') && !page.body.includes('发现<甲>'), 'escaped');
    // Arguments that are not canonical JSON are kept by runs as their JSON text, an object the record names: shown as that text.
    const text = Buffer.from(`{"run":"${run}","model":"m","items":[],"notes":"<\\ud800>"}`);
    const object = await server.records.objects.put(text, 'application/json');
    const received = await server.records.store.put({
      kind: 'submission',
      schema: 'submission-received@1',
      provenance: 'declared',
      body: { received: { object: object.sha256, size: text.length, non_canonical_path: '/notes', run } },
    });
    server.fakes.runs.runs.get(run)!.submissions.push({ record: received.digest, received_at: '2026-10-22T00:00:00.000Z', acceptance: 'not_accepted', errors: [], result: null });
    const again = await get(`/console/runs/${run}`, session);
    assert.ok(again.body.includes('收到的参数不是规范 JSON，按收到的 JSON 文本保存'));
    assert.ok(again.body.includes('&quot;notes&quot;:&quot;&lt;\\ud800&gt;&quot;'), 'the JSON text as received, escaped');
  });

  test('stored case text, finding text, session ids and user names are escaped: no markup gets through', async () => {
    const payload = '<script>alert(1)</script>';
    const attribute = '"><img src=x onerror=alert(2)>';
    server.fakes.runs.items = (subject) => [
      { id: 'doc-x:n1', label: payload, location: subject, fields: {} },
      { id: 'doc-x:n2', label: `用例${attribute}`, location: subject, fields: {} },
    ];
    try {
      const user = await person(['review'], 'user', `<b>名字</b>${attribute}`);
      const run = await runWithResult(user, [`发现${payload}`, attribute], `s"><script>x</script>`);
      const session = await signIn(user.token);
      const page = await get(`/console/runs/${run}`, session);
      assert.equal(page.status, 200);
      assert.ok(!page.body.includes('<script>'), 'no script element from stored text');
      assert.ok(!page.body.includes('<img src=x'), 'no element from an attribute payload');
      assert.ok(!page.body.includes('<b>名字</b>'));
      assert.ok(page.body.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
      assert.ok(page.body.includes('&quot;&gt;&lt;img src=x onerror=alert(2)&gt;'));
      const admin = await signIn(server.admin.token);
      const adminPage = await get('/console/admin', admin);
      assert.ok(!adminPage.body.includes('<b>名字</b>') && adminPage.body.includes('&lt;b&gt;名字&lt;/b&gt;'));
    } finally {
      server.fakes.runs.items = null;
    }
  });

  test('another user\'s run and an absent run give the same neutral page', async () => {
    const owner = await person();
    const run = await runWithResult(owner);
    const other = await person();
    const session = await signIn(other.token);
    const forbidden = await get(`/console/runs/${run}`, session);
    const absent = await get('/console/runs/run_7zzzzzzzzzzzzzzzzzzzzzzzzz', session);
    assert.equal(forbidden.status, 404);
    assert.equal(forbidden.body, absent.body);
    assert.match(forbidden.body, /对你不可用/);
    assert.ok(!(await get('/console/runs', session)).body.includes(run), 'a user lists only their own runs');
    for (const path of ['/console/__proto__', '/console/constructor', '/console/knowledge/__proto__', '/console/runs/a/b']) {
      const reply = await get(path, session);
      assert.equal(reply.status, 404, path);
      assert.equal(reply.body, absent.body, path);
    }
    const admin = await signIn(server.admin.token);
    assert.equal((await get(`/console/runs/${run}`, admin)).status, 200, 'admins see every run');
  });

  test('knowledge: product names, version lines, builds with aliases, the tree browser and the version diff; nothing for a user without packs', async () => {
    const user = await person(['review']);
    const session = await signIn(user.token);
    const knowledge = await get('/console/knowledge', session);
    assert.equal(knowledge.status, 200);
    assert.ok(knowledge.body.includes('Line A、LA'));
    for (const line of ['2.1', '2.2']) assert.ok(knowledge.body.includes(`>${line}</a>`), `version line ${line}`);
    const product = await get('/console/knowledge/product?id=line-a&line=2.1', session);
    assert.ok(product.body.includes('别名，基于 b-2.1-7'));
    const tree = await get(`/console/knowledge/tree?root=${ROOT_1}&path=%2Fcatalog%2Falpha`, session);
    assert.equal(tree.status, 200);
    assert.ok(tree.body.includes('alpha &lt;name&gt;'), 'entry statements are escaped');
    assert.ok(tree.body.includes(`tree:${ROOT_1}/catalog/alpha`));
    const root = await get(`/console/knowledge/root?root=${ROOT_1}`, session);
    assert.ok(root.body.includes('b-2.1-7'));
    const diff = await get(`/console/knowledge/diff?from=${ROOT_1}&to=${ROOT_2}`, session);
    assert.equal(diff.status, 200);
    assert.match(diff.body, /只在新根里（1）[\s\S]*\/catalog\/gamma/);
    assert.match(diff.body, /内容变了（1）[\s\S]*\/catalog\/alpha\/beta/);

    const stranger = await person([]);
    const strangerSession = await signIn(stranger.token);
    assert.match((await get('/console/knowledge', strangerSession)).body, /没有你可读的产品线/);
    const hidden = await get(`/console/knowledge/tree?root=${ROOT_1}&path=%2F`, strangerSession);
    const missing = await get(`/console/knowledge/tree?root=${'e'.repeat(64)}&path=%2F`, strangerSession);
    assert.equal(hidden.status, 404);
    assert.equal(hidden.body, missing.body);
    assert.equal((await get(`/console/knowledge/diff?from=${ROOT_1}&to=${ROOT_2}`, strangerSession)).status, 404);
    assert.equal((await get('/console/knowledge/product?id=line-a', strangerSession)).status, 404);
  });

  test('without the product port an admin sees the product packs of the catalog and a user sees no line', async () => {
    const bare = await createTestServer({ postgres, withoutProducts: true });
    try {
      const admin = await send('/console/knowledge', { port: bare.port, headers: { cookie: await signIn(bare.admin.token, bare.port) } });
      assert.ok(admin.body.includes('（line-a）'), 'the product pack id of the catalog');
      const user = await bare.createUser('无产品端口');
      await bare.assign(user.principal, 'review');
      const page = await send('/console/knowledge', { port: bare.port, headers: { cookie: await signIn(user.token, bare.port) } });
      assert.match(page.body, /没有你可读的产品线/);
    } finally {
      await bare.close();
    }
  });

  test('packs: a user sees the assigned packs, an admin every pack with the users it is assigned to', async () => {
    const user = await person(['local-review']);
    const session = await signIn(user.token);
    const packs = await get('/console/packs', session);
    assert.ok(packs.body.includes('>local-review@1.0.0<'));
    assert.ok(!packs.body.includes('>review@1.0.0<'), 'an unassigned pack is not listed');
    assert.ok(!packs.body.includes('分配给'));
    const admin = await signIn(server.admin.token);
    const all = await get('/console/packs', admin);
    for (const id of ['review@1.0.0', 'local-review@1.0.0', 'line-a@1.0.0', 'tracker-system@1.0.0']) assert.ok(all.body.includes(id), id);
    assert.ok(all.body.includes(user.user.name), 'assignments are shown to admins');
  });

  test('admin pages: users, tokens without values, assignments, resources with addresses and filtered call logs; neutral for a user', async () => {
    const user = await person(['review']);
    const userSession = await signIn(user.token);
    const refused = await get('/console/admin', userSession);
    assert.equal(refused.status, 404);
    assert.match(refused.body, /对你不可用/);
    assert.equal((await get('/console/admin/calls', userSession)).status, 404);

    const session = await signIn(server.admin.token);
    const admin = await get('/console/admin', session);
    assert.equal(admin.status, 200);
    assert.ok(admin.body.includes(user.user.name));
    assert.ok(!admin.body.includes(user.token) && !admin.body.includes(server.admin.token), 'no token value is ever shown');
    assert.ok(admin.body.includes('http://192.0.2.10:8080'), 'resource addresses for admins');
    assert.ok(admin.body.includes('review'), 'assignments');
    await runWithResult(user);
    const calls = await get(`/console/admin/calls?user=${encodeURIComponent(user.user.name)}&tool=submit_result`, session);
    assert.equal(calls.status, 200);
    assert.ok(calls.body.includes('submit_result'));
    assert.ok(calls.body.includes('管理员备注'));
    assert.equal((await get('/console/admin/calls?from=not-a-time', session)).status, 400);
    assert.equal((await get('/console/admin/calls?cursor=%21%21', session)).status, 400);
  });
});

test('knowledge console lists product-wide roots and renders undeclared builds safely', async () => {
  const originalInfo=server.deps.knowledge.rootInfo;
  const originalRoot=server.deps.knowledge.unversionedRoot;
  const info={root:ROOT_1,composition:'c'.repeat(64),product:'line-a',build:null,source_count:17,produced_at:'2026-10-24T00:00:00.000Z'};
  try {
    server.deps.knowledge.unversionedRoot=async product=>product==='line-a'?info:null;
    server.deps.knowledge.rootInfo=async ()=>[info];
    const user=await person(['review']);const session=await signIn(user.token);
    const overview=await get('/console/knowledge',session);
    assert.match(overview.body,/不分版本/);assert.match(overview.body,/来源 17 个/);
    assert.match((await get(`/console/knowledge/root?root=${ROOT_1}`,session)).body,/构建未声明/);
    server.deps.knowledge.unversionedRoot=async ()=>null;
    assert.match((await get('/console/knowledge',session)).body,/不分版本[\s\S]*—/);
  } finally { server.deps.knowledge.rootInfo=originalInfo;server.deps.knowledge.unversionedRoot=originalRoot; }
});

test('full administrator reasons are escaped in console details and unavailable to an ordinary reader',async()=>{
 const user=await person();
 await server.records.callLog.append({traceId:'4bf92f3577b34da6a3ce929d0e0e4736',sessionId:null,runId:null,userId:user.user.id,tool:'submit_result',arguments:{},callResult:'ok',durationMs:1,adminNote:'摘要',adminReasons:['合成完整理由 <script>unsafe</script>']});
 const session=await signIn(server.admin.token);const path=`/console/admin/calls?user=${encodeURIComponent(user.user.name)}&tool=submit_result`;
 const calls=await get(path,session);assert.equal(calls.status,200);assert.match(calls.body,/完整理由（1 条）/);assert.match(calls.body,/合成完整理由 &lt;script&gt;unsafe&lt;\/script&gt;/);assert.ok(!calls.body.includes('<script>unsafe</script>'));
 assert.equal((await get(path,await signIn(user.token))).status,404);
});
