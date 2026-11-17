import {withoutNonces} from './console/testing-security.ts';
// Search and a knowledge node's citations on the console, over HTTP with the fake services and real records.
// U5: /console/api/search and /console/api/knowledge/node retired — call searchHub / tree page instead of JSON.
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { after, before, describe, test } from 'node:test';
import { putSubmission } from '../runs/engine/store.ts';
import { NEUTRAL } from './console/context.ts';
import { SEARCH_MAX_HITS, SEARCH_MAX_QUERY, searchHub } from './console/search.ts';
import { ROOT_1 } from './fakes.ts';
import { testConsoleCredentials, createTestServer, type TestServer, type TestUser } from './testing.ts';

let server: TestServer;
let clock = Date.parse('2026-11-01T09:00:00.000Z');
let counter = 0;

before(async () => {
  server = await createTestServer({ now: () => new Date(clock) });
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

async function member(packs: string[] = ['review']): Promise<TestUser> {
  counter += 1;
  const user = await server.createUser(`查找成员${counter}`);
  for (const pack of packs) await server.assign(user.principal, pack);
  return user;
}

/** A run of `user` with an accepted submission; its id. */
async function runOf(user: TestUser): Promise<string> {
  const client = await server.client(user.token);
  const uploaded = await client.call('upload_file', { file_path: Buffer.from(`合成文档 ${counter}-${Math.random()}`).toString('base64') });
  const run = await client.call('start_run', { pack: 'review', inputs: { subject: { reference: String(uploaded.structuredContent.reference) } } });
  const id = (run.structuredContent.run as { run: string }).run;
  await client.close();
  return id;
}

async function ctxOf(user: TestUser, admin = false) {
  return {
    deps: server.deps,
    principal: user.principal,
    admin,
    url: new URL('http://127.0.0.1/console/search'),
    userName: async (id: string) => (await server.records.principals.get(id))?.name ?? null,
  } as unknown as Parameters<typeof searchHub>[0];
}

describe('search', () => {
  test('a member finds their own tasks and records, never another member\'s; an administrator finds both and the members', async () => {
    const first = await member();
    const second = await member();
    const own = await runOf(first);
    const foreign = await runOf(second);
    const mine = await searchHub(await ctxOf(first), own);
    assert.deepEqual(mine.tasks.map((hit) => hit.run), [own]);
    assert.ok(mine.records.length > 0 && mine.records.every((hit) => hit.run === own), 'the calls of the run');
    const theirs = await searchHub(await ctxOf(first), foreign);
    assert.deepEqual(theirs.tasks, [], 'another member\'s run is not found');
    assert.deepEqual(theirs.records, [], 'nor its calls');
    assert.deepEqual(theirs.members, [], 'members are found by administrators only');
    assert.deepEqual((await searchHub(await ctxOf(server.admin, true), foreign)).tasks.map((hit) => hit.run), [foreign]);
    const people = await searchHub(await ctxOf(server.admin, true), second.user.name);
    assert.deepEqual(people.members.map((hit) => hit.id), [second.user.id]);
    assert.ok(people.records.every((hit) => hit.user === second.user.name), 'the records of the member named exactly');
  });

  test('task packs, product lines, builds and a tree path are found within what the reader may read', async () => {
    const reader = await member(['review']);
    const stranger = await member([]);
    const packs = await searchHub(await ctxOf(reader), 'review');
    assert.ok(packs.packs.some((hit) => hit.id === 'review'));
    const line = await searchHub(await ctxOf(reader), 'Line A');
    assert.ok(line.knowledge.some((hit) => hit.kind === 'line' && hit.product === 'line-a'));
    const build = await searchHub(await ctxOf(reader), 'b-2.1-7');
    assert.ok(build.knowledge.some((hit) => hit.kind === 'build' && hit.build === 'b-2.1-7'));
    const path = await searchHub(await ctxOf(reader), '/catalog/alpha');
    assert.ok(path.knowledge.some((hit) => hit.kind === 'path' && hit.path === '/catalog/alpha'));
    for (const q of ['Line A', 'b-2.1-7', '/catalog/alpha']) assert.deepEqual((await searchHub(await ctxOf(stranger), q)).knowledge, [], `${q}: no readable line, no knowledge`);
  });

  test('each kind stops at its bound and says so; the query is cut to its length and an empty one finds nothing', async () => {
    const busy = await member();
    for (let i = 0; i <= SEARCH_MAX_HITS; i++) await runOf(busy);
    const many = await searchHub(await ctxOf(busy), 'review');
    assert.equal(many.tasks.length, SEARCH_MAX_HITS);
    assert.equal(many.partial.tasks, true);
    const long = await searchHub(await ctxOf(busy), 'x'.repeat(SEARCH_MAX_QUERY + 50));
    assert.equal([...long.q].length, SEARCH_MAX_QUERY);
    const empty = await searchHub(await ctxOf(busy), '');
    assert.deepEqual([empty.tasks, empty.knowledge, empty.records], [[], [], []]);
  });

  test('every signed-in page carries the search box, which leads to a page of the matches', async () => {
    const user = await member();
    const run = await runOf(user);
    const session = await signIn(user.token);
    const overview = await send('/console/overview', { headers: { cookie: session } });
    assert.match(overview.body, /<form role="search" method="get" action="\/console\/search">/);
    assert.doesNotMatch((await send('/console/login')).body, /<form role="search"/, 'not on the sign-in page');
    const found = await send(`/console/search?q=${run}`, { headers: { cookie: session } });
    assert.equal(found.status, 200);
    assert.ok(found.body.includes(`href="/console/runs/${run}"`));
    const odd = await send(`/console/search?q=${encodeURIComponent('<b>合成</b>')}`, { headers: { cookie: session } });
    assert.ok(odd.body.includes('&lt;b&gt;合成&lt;/b&gt;') && !odd.body.includes('<b>合成</b>'), 'the query is escaped');
    const retired = await send(`/console/api/search?q=${run}`, { headers: { cookie: session } });
    assert.equal(retired.status, 404);
    assert.equal(JSON.parse(retired.body).code, 'SOURCE_UNAVAILABLE');
  });
});

describe('a knowledge node\'s citations', () => {
  test('the node detail counts the accepted submissions that cited it in 30 days, says from when, and is the pages\' visibility', async () => {
    const user = await member(['review']);
    const reader = await signIn(user.token);
    const before = await send(`/console/knowledge/tree?root=${ROOT_1}&path=%2Fcatalog%2Falpha`, { headers: { cookie: reader } });
    assert.equal(before.status, 200);
    assert.match(before.body, /\/catalog\/alpha/);
    assert.match(before.body, /近 30 天被引用/);
    const nodes = await server.fakes.knowledge.getNodes({ root: ROOT_1, paths: ['/catalog/alpha'], depth: 0 }, user.principal);
    const reference = nodes!.nodes[0].entries[0].reference;
    const store = server.records.store;
    const cite = (n: number, at: number, grounds: string[]) =>
      putSubmission(store, { run: `run_${'1'.repeat(26)}`, digest: `${n}`.padStart(64, '0'), body: { grounds }, parses: true, createdAt: new Date(at).toISOString() });
    await cite(1, clock - 40 * 86_400_000, [reference]);
    await cite(2, clock - 2 * 86_400_000, [reference]);
    await cite(3, clock - 86_400_000, [`tree:${ROOT_1}/catalog/alpha`]);
    await cite(4, clock - 3_600_000, [`tree:${ROOT_1}/catalog/gamma`]);

    const page = await send(`/console/knowledge/tree?root=${ROOT_1}&path=%2Fcatalog%2Falpha`, { headers: { cookie: reader } });
    assert.match(page.body, /近 30 天被引用 2 次/);
    assert.match(page.body, /<th[^>]*>来源<\/th>/);

    const stranger = await signIn((await member([])).token);
    const hidden = await send(`/console/knowledge/tree?root=${ROOT_1}&path=%2Fcatalog%2Falpha`, { headers: { cookie: stranger } });
    const missing = await send(`/console/knowledge/tree?root=${'e'.repeat(64)}&path=%2F`, { headers: { cookie: stranger } });
    assert.equal(hidden.status, 404);
    assert.equal(withoutNonces(hidden.body), withoutNonces(missing.body));
    assert.match(hidden.body, new RegExp(NEUTRAL));
    const retired = await send(`/console/api/knowledge/node?root=${ROOT_1}&path=%2Fcatalog%2Falpha`, { headers: { cookie: reader } });
    assert.equal(retired.status, 404);
    assert.equal(JSON.parse(retired.body).code, 'SOURCE_UNAVAILABLE');
  });

  test('when the index starts inside the window the count is a lower bound that says from when it counts', async () => {
    const fresh = await createTestServer({ now: () => new Date(clock) });
    try {
      const user = await fresh.createUser('新近成员');
      await fresh.assign(user.principal, 'review');
      await putSubmission(fresh.records.store, { run: `run_${'2'.repeat(26)}`, digest: '9'.padStart(64, '0'), body: { grounds: [`tree:${ROOT_1}/catalog/alpha`] }, parses: true, createdAt: new Date(clock - 86_400_000).toISOString() });
      const { nodeCitations, citationsLine } = await import('./console/citations.ts');
      const nodes = await fresh.fakes.knowledge.getNodes({ root: ROOT_1, paths: ['/catalog/alpha'], depth: 0 }, user.principal);
      const ctx = { deps: fresh.deps, principal: user.principal } as unknown as Parameters<typeof nodeCitations>[0];
      const citations = (await nodeCitations(ctx, ROOT_1, nodes!.nodes[0]))!;
      assert.equal(citations.complete, false);
      assert.equal(citations.count, 1);
      assert.match(citationsLine(citations), /^近 30 天被引用至少 1 次（引用自 .+ 起统计，更早的提交未计入）$/);
    } finally {
      await fresh.close();
    }
  });
});
