import {withoutNonces} from './console/testing-security.ts';
import {THEME_TAGS,LIVE_TAG} from './console/html.ts';
import {THEME_BOOTSTRAP} from './console/theme.ts';
// The console's live updates over HTTP with the fake services: GET /console/api/stream on the session of the pages, events
// of MCP calls, knowledge imports, packs, knowledge roots and first connections reaching exactly the accounts that may see
// them, streams that end with the sign-in, the token or the app, and the one module script allowed by its hash.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { startPostgres, type TemporaryPostgres } from '../testing/postgres.ts';
import { createApp } from './app.ts';
import type { CommandBridge } from './command-bridge.ts';
import { CONTENT_SECURITY_POLICY, SCRIPT_HASH, THEME_SCRIPT_HASH } from './console/html.ts';
import { LIVE_EVENTS, environmentTransition, eventsOf, visibleTo, wantedEvents, type LiveEvent } from './console/live.ts';
import type { PageContext } from './console/pages.ts';
import { LIVE_SCRIPT } from './console/script.ts';
import { SessionStore } from './console/session.ts';
import { testConsoleCredentials, createTestServer, type TestServer, type TestUser } from './testing.ts';

const LIVE = { pollMs: 40, heartbeatMs: 250 };
let postgres: TemporaryPostgres;
let server: TestServer;
let counter = 0;

before(async () => {
  postgres = await startPostgres();
  server = await createTestServer({ postgres, live: LIVE });
});
after(async () => {
  await server?.close();
  await postgres?.stop();
});

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

function send(port: number, path: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method: options.method ?? 'GET', agent: false, setHost: false, headers: { host: `127.0.0.1:${port}`, ...options.headers } }, (res) => {
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

async function signIn(token: string, port = server.port): Promise<string> {
  const page = await send(port, '/console/login');
  const nonce = /name="csrf" value="([^"]+)"/.exec(page.body)![1];
  const reply = await send(port, '/console/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: `circle_hub_login=${valueOf(cookieOf(page, 'circle_hub_login'))}` },
    body: new URLSearchParams({ ...testConsoleCredentials(token), csrf: nonce }).toString(),
  });
  assert.equal(reply.status, 303, reply.body);
  return `circle_hub_session=${valueOf(cookieOf(reply, 'circle_hub_session'))}`;
}

async function member(packs: string[] = ['review']): Promise<TestUser> {
  counter += 1;
  const user = await server.createUser(`实时成员${counter}`);
  for (const pack of packs) await server.assign(user.principal, pack);
  return user;
}

interface Received {
  name: string;
  data: Record<string, unknown>;
}

interface StreamClient {
  status: number;
  headers: IncomingHttpHeaders;
  events: Received[];
  text: () => string;
  ended: Promise<void>;
  isEnded: () => boolean;
  close: () => void;
}

function openStream(path: string, cookie: string | null, port = server.port): Promise<StreamClient> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method: 'GET', agent: false, setHost: false, headers: { host: `127.0.0.1:${port}`, accept: 'text/event-stream', ...(cookie === null ? {} : { cookie }) } }, (res) => {
      let text = '';
      let buffer = '';
      let ended = false;
      const events: Received[] = [];
      let finish: () => void = () => {};
      const done = new Promise<void>((r) => { finish = r; });
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        text += chunk;
        buffer += chunk;
        for (let at = buffer.indexOf('\n\n'); at >= 0; at = buffer.indexOf('\n\n')) {
          const block = buffer.slice(0, at);
          buffer = buffer.slice(at + 2);
          const name = /^event: (.+)$/m.exec(block)?.[1];
          const data = /^data: (.+)$/m.exec(block)?.[1];
          if (name !== undefined && data !== undefined) events.push({ name, data: JSON.parse(data) as Record<string, unknown> });
        }
      });
      const end = () => { ended = true; finish(); };
      res.on('end', end);
      res.on('close', end);
      res.on('error', end);
      resolve({ status: res.statusCode ?? 0, headers: res.headers, events, text: () => text, ended: done, isEnded: () => ended, close: () => req.destroy() });
    });
    req.on('error', (error) => { if (!req.destroyed) reject(error); });
    req.end();
  });
}

async function until(check: () => boolean, what: string, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await delay(20);
  }
}

const has = (client: StreamClient, name: string, data: Record<string, unknown>) => () => client.events.some((e) => e.name === name && Object.entries(data).every(([k, v]) => e.data[k] === v));

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

describe('the event stream', () => {
  test('without a session it answers 401 in JSON; an unknown event name is a bad parameter; it is text/event-stream with a retry line', async () => {
    const anonymous = await send(server.port, '/console/api/stream');
    assert.equal(anonymous.status, 401);
    assert.equal(JSON.parse(anonymous.body).code, null);
    const session = await signIn((await member()).token);
    const wrong = await send(server.port, '/console/api/stream?events=task.updated,bogus', { headers: { cookie: session } });
    assert.equal(wrong.status, 400);
    assert.deepEqual(Object.keys(JSON.parse(wrong.body)).sort(), ['code', 'fix', 'message']);
    assert.equal(JSON.parse(wrong.body).code, null);
    assert.equal(server.app.consoleStreams(), 0);
    const stream = await openStream('/console/api/stream', session);
    assert.equal(server.app.consoleStreams(), 1, 'the resource sampling counts it');
    assert.equal(stream.status, 200);
    assert.match(String(stream.headers['content-type']), /^text\/event-stream; charset=utf-8$/);
    assert.equal(stream.headers['cache-control'], 'no-store');
    await until(() => stream.text().startsWith('retry: '), 'the retry line');
    stream.close();
    await stream.ended;
  });

  test('an MCP call reaches the run owner and an administrator, never another member, and carries ids only', async () => {
    const owner = await member();
    const other = await member();
    const mine = await openStream('/console/api/stream?events=task.updated', await signIn(owner.token));
    const theirs = await openStream('/console/api/stream?events=task.updated', await signIn(other.token));
    const admin = await openStream('/console/api/stream?events=task.updated', await signIn(server.admin.token));
    await delay(200);
    const run = await runWithResult(owner);
    await until(has(mine, 'task.updated', { run }), 'the owner event');
    await until(has(admin, 'task.updated', { run }), 'the admin event');
    await delay(300);
    assert.ok(!theirs.events.some((e) => e.data.run === run), 'another member never hears of the run');
    for (const event of [...mine.events, ...admin.events]) assert.deepEqual(Object.keys(event.data), ['run']);
    for (const client of [mine, theirs, admin]) client.close();
    await Promise.all([mine.ended, theirs.ended, admin.ended]);
  });

  test('a published pack and a moved knowledge root reach those who can read them', async () => {
    const reader = await member(['review']);
    const stranger = await member([]);
    const readerStream = await openStream('/console/api/stream?events=pack.published,knowledge.published', await signIn(reader.token));
    const strangerStream = await openStream('/console/api/stream?events=pack.published,knowledge.published', await signIn(stranger.token));
    await delay(200);
    await server.records.store.put({ kind: 'pack_version', schema: 'pack_version@1', provenance: 'declared', body: { pack: 'review', version: '9.9.9', note: `合成 ${counter}` } });
    await server.records.store.put({ kind: 'root_pointer', schema: 'root_pointer@1', provenance: 'observed', body: { product: 'line-a', line: '1.0', note: `合成 ${counter}` } });
    await until(has(readerStream, 'pack.published', { pack: 'review', version: '9.9.9' }), 'the pack event');
    await until(has(readerStream, 'knowledge.published', { product: 'line-a', line: '1.0' }), 'the knowledge event');
    await delay(300);
    assert.deepEqual(strangerStream.events, [], 'a member without the pack hears of neither');
    readerStream.close();
    strangerStream.close();
    await Promise.all([readerStream.ended, strangerStream.ended]);
  });

  test('a first connection of a member reaches administrators and that member only', async () => {
    const joining = await member();
    const other = await member();
    const circleToken = await server.issueToken(joining.principal);
    const admin = await openStream('/console/api/stream?events=member.connected', await signIn(server.admin.token));
    const own = await openStream('/console/api/stream?events=member.connected', await signIn(joining.token));
    const theirs = await openStream('/console/api/stream?events=member.connected', await signIn(other.token));
    await delay(200);
    const circle = await server.client(circleToken);
    await circle.listTools();
    await circle.close();
    await until(has(admin, 'member.connected', { user: joining.user.id }), 'the admin event');
    await until(has(own, 'member.connected', { user: joining.user.id }), 'the member event');
    await delay(300);
    assert.ok(!theirs.events.some((e) => e.data.user === joining.user.id));
    // A second call of the same Circle is not a first connection.
    const count = admin.events.length;
    const again = await server.client(circleToken);
    await again.listTools();
    await again.close();
    await delay(400);
    assert.equal(admin.events.length, count);
    for (const client of [admin, own, theirs]) client.close();
    await Promise.all([admin.ended, own.ended, theirs.ended]);
  });

  test('a stream ends when its session signs out and when its password is reset', async () => {
    const user = await member();
    const session = await signIn(user.token);
    const first = await openStream('/console/api/stream', session);
    const me = JSON.parse((await send(server.port, '/console/api/me', { headers: { cookie: session } })).body) as { csrf: string };
    const out = await send(server.port, '/console/logout', { method: 'POST', headers: { cookie: session, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf: me.csrf }).toString() });
    assert.equal(out.status, 303);
    await until(first.isEnded, 'the end after sign-out', 2_000);

    const token = await server.issueToken(user.principal);
    const second = await openStream('/console/api/stream', await signIn(token));
    await delay(100);
    await server.records.principals.resetPassword(server.admin.principal,user.user.id);
    await until(second.isEnded, 'the end after revocation', 3_000);
  });

  test('a session opens a bounded number of streams', async () => {
    const session = await signIn((await member()).token);
    const open: StreamClient[] = [];
    for (let i = 0; i < 4; i += 1) open.push(await openStream('/console/api/stream', session));
    const refused = await send(server.port, '/console/api/stream', { headers: { cookie: session } });
    assert.equal(refused.status, 429);
    assert.equal(JSON.parse(refused.body).code, null);
    for (const client of open) client.close();
    await Promise.all(open.map((client) => client.ended));
  });
});

describe('runtime environments', () => {
  const JOB = 'a'.repeat(64);
  const EXECUTOR = 'exe_0000000000000000000000000a';
  const dispatchAction = (detail: Record<string, unknown>) => ({ kind: 'action' as const, body: { component: 'dispatch@1', run: null, detail: { job: JOB, ...detail } } });

  test('a dispatch journal record that can change occupancy or freezing names its job, and its executor when it binds one', () => {
    assert.deepEqual(environmentTransition(dispatchAction({ phase: 'reservation', binding: { executor: EXECUTOR } })), { job: JOB, executor: EXECUTOR });
    for (const detail of [{ phase: 'intent' }, { phase: 'probe_intent' }, { phase: 'complete', done: true }, { phase: 'unknown', uncertain: true }, { phase: 'answer', unfreeze: true }, { phase: 'dispose' }, { phase: 'bed_hold', state: 'open' }, { phase: 'reconciled', outcome: 'unknown' }]) {
      assert.deepEqual(environmentTransition(dispatchAction(detail)), { job: JOB, executor: null }, JSON.stringify(detail));
    }
    // A read answer, a heartbeat or a record of another component changes neither.
    assert.equal(environmentTransition(dispatchAction({ phase: 'heartbeat.response' })), null);
    const timed = { ...dispatchAction({ phase: 'status', started_at: '2026-11-01T00:00:00.000Z', ended_at: '2026-11-01T00:00:00.000Z' }) };
    Object.assign(timed.body, { action: 'read', inputs: [`src:${'a'.repeat(64)}`] });
    assert.deepEqual(environmentTransition(timed), { job: JOB, executor: null }, 'a genuine zero-ms request changes the statistics');
    assert.equal(environmentTransition({ kind: 'action', body: { component: 'requests@1', detail: { job: JOB, phase: 'intent' } } }), null);
    assert.equal(environmentTransition({ kind: 'call_log', body: { component: 'dispatch@1', detail: { job: JOB, phase: 'intent' } } }), null);
    assert.equal(environmentTransition(dispatchAction({ phase: 'reservation', binding: { executor: 'bench-1' } }))?.executor, null, 'not an executor id');
  });

  test('a dispatch on an environment reaches administrators as environment.status, never members', async () => {
    const someone = await member();
    // As the journal writes them: indexed by job, so a later record of a job is traced to its reservation.
    const put = (job: string, detail: Record<string, unknown>, fields: Record<string, unknown> = {}) => server.records.store.put({ kind: 'action', schema: 'action@1', provenance: 'observed', body: { component: 'dispatch@1', run: null, ...fields, detail: { job, ...detail } }, index: [{ key: 'dispatch.job', value: job }] });
    const earlier = createHash('sha256').update(`合成作业 早 ${counter}`).digest('hex');
    const OTHER = 'exe_0000000000000000000000000b';
    // A reservation written before any stream opened is not read by the poller; its job's later records still name it.
    await put(earlier, { phase: 'reservation', binding: { job: earlier, executor: OTHER } });
    const admin = await openStream('/console/api/stream?events=environment.status', await signIn(server.admin.token));
    const user = await openStream('/console/api/stream?events=environment.status', await signIn(someone.token));
    await delay(200);
    await put(earlier, { phase: 'unknown', uncertain: true });
    await until(has(admin, 'environment.status', { environment: OTHER }), 'the event traced to an earlier reservation', 9_000);
    const job = createHash('sha256').update(`合成作业 ${counter}`).digest('hex');
    await put(job, { phase: 'reservation', binding: { job, executor: EXECUTOR } });
    await until(has(admin, 'environment.status', { environment: EXECUTOR }), 'the reservation event', 9_000);
    admin.events.length = 0;
    await put(job, { phase: 'complete', done: true, outcome: 'effective' });
    await until(has(admin, 'environment.status', { environment: EXECUTOR }), 'the end event', 9_000);
    admin.events.length = 0;
    for (let i = 0; i < 3; i++) await put(job,
      { phase: 'status.response', attempt: i, started_at: '2026-11-01T00:00:00.000Z', ended_at: '2026-11-01T00:00:00.100Z', source_record: `rec:${'b'.repeat(64)}`, http_status: 200 },
      { action: 'read', inputs: [`src:${'a'.repeat(64)}`] });
    await until(has(admin, 'environment.status', { environment: EXECUTOR }), 'a timed response event', 9_000);
    await delay(300);
    assert.ok(!user.events.some((e) => e.name === 'environment.status'), 'members never hear of environments');
    assert.equal(admin.events.filter((e) => e.name === 'environment.status').length, 1, 'one held event per environment');
    for (const event of admin.events) assert.deepEqual(Object.keys(event.data), ['environment']);
    for (const client of [admin, user]) client.close();
    await Promise.all([admin.ended, user.ended]);
  });
});

describe('knowledge imports and closing', () => {
  test('a knowledge import of this process reaches administrators only, at its start and its end', async () => {
    const bridge: CommandBridge = { async run() { await delay(150); return { code: 0, stdout: ['合成导入完成'], stderr: [] }; } };
    const app = createApp(server.deps, { bridge, log: () => {}, live: LIVE });
    const { port } = await app.listen();
    try {
      const adminSession = await signIn(server.admin.token, port);
      const admin = await openStream('/console/api/stream?events=import.progress', adminSession, port);
      const user = await openStream('/console/api/stream?events=import.progress', await signIn((await member()).token, port), port);
      const me = JSON.parse((await send(port, '/console/api/me', { headers: { cookie: adminSession } })).body) as { csrf: string };
      const started = await send(port, '/console/admin/do/knowledge-sync', { method: 'POST', headers: { cookie: adminSession, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf: me.csrf, product: 'line-a' }).toString() });
      assert.equal(started.status, 202, started.body);
      await until(() => admin.events.filter((e) => e.name === 'import.progress').length >= 2, 'the start and end of the import');
      const jobs = new Set(admin.events.map((e) => e.data.job));
      assert.equal(jobs.size, 1);
      assert.match(String([...jobs][0]), /^[0-9a-f]{12}$/);
      await delay(200);
      assert.deepEqual(user.events, [], 'a member hears of no import');
      admin.close();
      user.close();
      await Promise.all([admin.ended, user.ended]);
    } finally {
      await app.close();
    }
  });

  test('close() ends the open streams at once instead of waiting for them', { timeout: 60_000 }, async (t) => {
    // The client never ends its stream, and close() waits for requests in flight longer than any test runs (the largest
    // timer delay, about 24 days). So close() returns only if it ended the stream itself; one that waited for the stream
    // would not return, and the test's timeout fails it. No elapsed time is compared.
    const never = 2 ** 31 - 1;
    const app = createApp(server.deps, { log: () => {}, live: LIVE, closeTimeoutMs: never, closeGraceMs: never });
    const { port } = await app.listen();
    let stream: StreamClient | undefined;
    t.after(() => { stream?.close(); return app.close(); });
    stream = await openStream('/console/api/stream', await signIn(server.admin.token, port), port);
    await until(() => stream!.text().length > 0, 'the first bytes of the stream');
    assert.equal(stream.isEnded(), false, 'the stream is open when close() starts');
    await app.close();
    await until(stream.isEnded, 'the end of the stream', 1_000);
  });
});

describe('sessions', () => {
  test('a look of the live updates is not activity: peek leaves the idle time running', () => {
    let now = 0;
    const sessions = new SessionStore(() => now, { idleMs: 1_000, absoluteMs: 10_000 });
    const session = sessions.open('t'.repeat(43));
    now = 900;
    assert.equal(sessions.peek(session.id)?.id, session.id);
    now = 1_100;
    assert.equal(sessions.peek(session.id), null, 'idle since it was opened');
    assert.equal(sessions.peek(undefined), null);
    assert.equal(sessions.get(session.id), null);
  });

  test('the page fetches of the script and the stream never keep an unattended session open', async () => {
    let clock = Date.parse('2026-11-01T00:00:00.000Z');
    const timed = await createTestServer({ postgres, live: LIVE, now: () => new Date(clock) });
    try {
      const session = await signIn(timed.admin.token, timed.port);
      clock += 90 * 60_000;
      const refreshed = await send(timed.port, '/console/overview', { headers: { cookie: session, 'circle-hub-refresh': 'live' } });
      assert.equal(refreshed.status, 200);
      const stream = await openStream('/console/api/stream', session, timed.port);
      assert.equal(stream.status, 200);
      stream.close();
      await stream.ended;
      clock += 60 * 60_000;
      const later = await send(timed.port, '/console/overview', { headers: { cookie: session } });
      assert.equal(later.status, 303, 'two and a half hours after the last request of a person');
      assert.equal(later.headers.location, '/console/login');
    } finally {
      await timed.close();
    }
  });
});

describe('the module script', () => {
  test('every page carries the hash-allowed theme script and only live pages carry the live module', async () => {
    const session = await signIn(server.admin.token);
    const overview = await send(server.port, '/console/overview', { headers: { cookie: session } });
    assert.equal(overview.status, 200);
    const scripts = [...overview.body.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)];
    assert.equal(scripts.length, 3);
    assert.match(scripts[0][0], /^<script data-console-theme>/);
    assert.equal(scripts[0][1], THEME_BOOTSTRAP);
    assert.equal(createHash('sha256').update(scripts[0][1]).digest('base64'), THEME_SCRIPT_HASH);
    assert.ok(withoutNonces(overview.body).includes(THEME_TAGS));
    assert.equal(scripts[1][1], '');
    assert.equal(withoutNonces(scripts[2][0]), LIVE_TAG);
    const hash = createHash('sha256').update(LIVE_SCRIPT, 'utf8').digest('base64');
    assert.equal(hash, SCRIPT_HASH);
    const csp = String(overview.headers['content-security-policy']);
    assert.equal(csp.replace(/ 'nonce-[A-Za-z0-9+/=]+'/g,''), CONTENT_SECURITY_POLICY);
    assert.ok(csp.includes(`'sha256-${THEME_SCRIPT_HASH}'`));
    const nonce=/script-src 'nonce-([A-Za-z0-9+/]{24})'/.exec(csp)?.[1];assert.ok(nonce);
    assert.ok(scripts.slice(1).every(script=>script[0].includes(`nonce="${nonce}"`)));
    assert.ok(csp.includes("connect-src 'self'"));
    assert.doesNotMatch(csp, /unsafe|\*/);
    assert.match(overview.body, /<p class="live-state" id="live-state" role="status" hidden><\/p>/);
    assert.match(overview.body, /data-live="task\.updated"/);
    const records = await send(server.port, '/console/records', { headers: { cookie: session } });
    assert.equal(records.status, 200);
    assert.doesNotMatch(withoutNonces(records.body).replace(THEME_TAGS, ''), /<script/i);
    assert.ok(withoutNonces(records.body).includes(THEME_TAGS));
    const login = await send(server.port, '/console/login');
    assert.doesNotMatch(withoutNonces(login.body).replace(THEME_TAGS, ''), /<script/i);
    assert.ok(withoutNonces(login.body).includes(THEME_TAGS));
  });

  test('the script parses as a JavaScript module and names only the stream of this console', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'circle-hub-live-'));
    try {
      const file = join(dir, 'live.mjs');
      await writeFile(file, LIVE_SCRIPT);
      execFileSync(process.execPath, ['--check', file]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    assert.doesNotMatch(LIVE_SCRIPT, /https?:|\/\/[a-z0-9]|eval\(|new Function|innerHTML|<\/script/i);
    assert.match(LIVE_SCRIPT, /new EventSource\('\/console\/api\/stream\?events='/);
    assert.match(LIVE_SCRIPT, /15000/);
    assert.match(LIVE_SCRIPT, /连接中断/);
  });
});

describe('events and their audience', () => {
  const RUN = `run_${'a'.repeat(26)}`;
  const DIGEST = 'b'.repeat(64);

  test('records map to events with ids only', () => {
    assert.deepEqual(eventsOf({ kind: 'call_log', digest: DIGEST, body: { run: RUN, user: `usr_${'c'.repeat(26)}`, tool: 'submit_result' } }), [{ name: 'task.updated', data: { run: RUN } }]);
    assert.deepEqual(eventsOf({ kind: 'call_log', digest: DIGEST, body: { run: null } }), []);
    assert.deepEqual(eventsOf({ kind: 'request', digest: DIGEST, body: { run: RUN, audience: 'x' } }), [{ name: 'task.updated', data: { run: RUN } }, { name: 'request.updated', data: { run: RUN, request: DIGEST } }]);
    assert.deepEqual(eventsOf({ kind: 'action', digest: DIGEST, body: { run: RUN, detail: { request: 'd'.repeat(64), answer: 'e'.repeat(64) } } }).map((e) => e.name), ['task.updated', 'request.updated']);
    assert.deepEqual(eventsOf({ kind: 'pack_version', digest: DIGEST, body: { pack: 'p', version: '1.0.0' } }), [{ name: 'pack.published', data: { pack: 'p', version: '1.0.0' } }]);
    assert.deepEqual(eventsOf({ kind: 'root_pointer', digest: DIGEST, body: { product: 'line-a', line: null } }), [{ name: 'knowledge.published', data: { product: 'line-a', line: null } }]);
    const system = { permission: 'resource_config', subject: '*', object: `res_${'f'.repeat(26)}`, revoked: false, supersedes: null };
    assert.deepEqual(eventsOf({ kind: 'authorization', digest: DIGEST, body: system }), [{ name: 'system.added', data: { system: system.object } }]);
    // A later decision (enabled, disabled, changed) is a change of state, not a new system.
    assert.deepEqual(eventsOf({ kind: 'authorization', digest: DIGEST, body: { ...system, supersedes: DIGEST } }), [{ name: 'system.status', data: { system: system.object } }]);
    assert.deepEqual(eventsOf({ kind: 'authorization', digest: DIGEST, body: { ...system, revoked: true, supersedes: DIGEST } }), [{ name: 'system.status', data: { system: system.object } }]);
    // A runtime environment is the configuration of an executor.
    assert.deepEqual(eventsOf({ kind: 'authorization', digest: DIGEST, body: { ...system, object: 'executor.bench-1' } }), [{ name: 'environment.status', data: { environment: 'bench-1' } }]);
    assert.deepEqual(eventsOf({ kind: 'authorization', digest: DIGEST, body: { ...system, object: 'secret:DEMO' } }), []);
    assert.deepEqual(eventsOf({ kind: 'authorization', digest: DIGEST, body: { ...system, permission: 'publish' } }), []);
    // A read of a business system ended: its reads and response times changed.
    const manifest = { resource: system.object, started_at: '2026-11-01T00:00:00.000Z', ended_at: '2026-11-01T00:00:01.000Z', result: 'completed', run: null };
    assert.deepEqual(eventsOf({ kind: 'action', digest: DIGEST, body: manifest }), [{ name: 'system.status', data: { system: system.object } }]);
    assert.deepEqual(eventsOf({ kind: 'action', digest: DIGEST, body: { ...manifest, run: RUN } }).map((e) => e.name), ['task.updated', 'system.status']);
    assert.deepEqual(eventsOf({ kind: 'action', digest: DIGEST, body: { ...manifest, resource: 'not-a-resource' } }), []);
    assert.deepEqual(eventsOf({ kind: 'tree_node', digest: DIGEST, body: { run: RUN } }), []);
  });

  test('the stream asks for known events only', () => {
    assert.deepEqual([...wantedEvents(null)!], [...LIVE_EVENTS]);
    assert.deepEqual([...wantedEvents('task.updated, pack.published')!], ['task.updated', 'pack.published']);
    assert.equal(wantedEvents('task.updated,nope'), null);
    assert.equal(wantedEvents(','), null);
  });

  test('the audience follows the pages: catalogs for systems and packs, admins for imports, the member for a connection', async () => {
    const ctx = (admin: boolean, id = 'usr_me') => ({
      admin,
      principal: { id, name: id, role: admin ? 'admin' : 'user' },
      deps: {
        resources: { list: async () => (admin ? [{ id: 'res_x' }] : []) },
        packs: { list: async () => [{ id: 'shared-pack' }] },
        runs: { getRun: async (_user: unknown, run: string) => (run === RUN ? {} : null) },
      },
    }) as unknown as PageContext;
    const event = (name: LiveEvent['name'], data: LiveEvent['data']): LiveEvent => ({ name, data });
    assert.equal(await visibleTo(ctx(true), event('system.added', { system: 'res_x' })), true);
    assert.equal(await visibleTo(ctx(false), event('system.added', { system: 'res_x' })), false);
    assert.equal(await visibleTo(ctx(false), event('pack.published', { pack: 'shared-pack', version: '1' })), true);
    assert.equal(await visibleTo(ctx(false), event('pack.published', { pack: 'other', version: '1' })), false);
    assert.equal(await visibleTo(ctx(false), event('import.progress', { job: 'j' })), false);
    assert.equal(await visibleTo(ctx(true), event('import.progress', { job: 'j' })), true);
    assert.equal(await visibleTo(ctx(false, 'usr_me'), event('member.connected', { user: 'usr_me' })), true);
    assert.equal(await visibleTo(ctx(false, 'usr_me'), event('member.connected', { user: 'usr_else' })), false);
    assert.equal(await visibleTo(ctx(false), event('task.updated', { run: RUN })), true);
    assert.equal(await visibleTo(ctx(false), event('task.updated', { run: `run_${'z'.repeat(26)}` })), false);
    // A system's state goes to administrators who see the system; an environment's to administrators.
    assert.equal(await visibleTo(ctx(true), event('system.status', { system: 'res_x' })), true);
    assert.equal(await visibleTo(ctx(true), event('system.status', { system: 'res_other' })), false);
    assert.equal(await visibleTo(ctx(false), event('system.status', { system: 'res_x' })), false);
    assert.equal(await visibleTo(ctx(true), event('environment.status', { environment: 'bench-1' })), true);
    assert.equal(await visibleTo(ctx(false), event('environment.status', { environment: 'bench-1' })), false);
  });

  test('a run event asks the visibility port, never the full detail, when the engine has one', async () => {
    const asked: string[] = [];
    const event = (name: LiveEvent['name'], data: LiveEvent['data']): LiveEvent => ({ name, data });
    const ctx = {
      admin: false,
      principal: { id: 'usr_me', name: 'usr_me', role: 'user' },
      deps: {
        runs: {
          runVisible: async (_user: unknown, run: string) => { asked.push(run); return run === RUN; },
          getRun: async () => { throw new Error('the full detail must not be read to decide visibility'); },
        },
      },
    } as unknown as PageContext;
    assert.equal(await visibleTo(ctx, event('task.updated', { run: RUN })), true);
    assert.equal(await visibleTo(ctx, event('request.updated', { run: `run_${'z'.repeat(26)}`, request: DIGEST })), false);
    assert.deepEqual(asked, [RUN, `run_${'z'.repeat(26)}`]);
  });
});
