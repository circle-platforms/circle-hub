// The read-only trial of a system pack (trial.ts) and the read statistics of a resource (statistics.ts), against loopback
// stubs: the trial logs in at most once, never twice with values that failed, tries only the routes that need no
// arguments, never reaches a write route, appends only a trial action (no object or session entry) and keeps every value
// out of its report and the log; the statistics count the read manifests of the window.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { startPostgres, type TemporaryPostgres } from '../testing/postgres.ts';
import { ConnectorError } from './errors.ts';
import { readStatistics } from './statistics.ts';
import { agileFixture, startAgileStub, type AgileStub } from './testing/agile.ts';
import { addSyntheticResource, setSyntheticCredentials } from './testing/credentials.ts';
import { openConnectorKit, type ConnectorKit } from './testing/kit.ts';
import { writePack } from './testing/packs.ts';
import { PLM_PRODUCTS, startPlmStub, type PlmStub } from './testing/plm.ts';
import { json, startStub } from './testing/stub.ts';
import { TRIAL_LOGIN_STOPS, TrialLoginStops, type SystemTrialReport } from './trial.ts';
import { TRIAL_REPORT_SCHEMA, TrialRecord } from './trial-report.ts';

let postgres: TemporaryPostgres;
before(async () => {
  postgres = await startPostgres();
});
after(() => postgres?.stop());

const PASSWORD = 'Synthetic#Pass42';

interface World {
  k: ConnectorKit;
  agile: AgileStub;
  plm: PlmStub;
}

async function world(t: { after: (fn: () => Promise<void>) => void }): Promise<World> {
  const k = await openConnectorKit(postgres);
  const agile = await startAgileStub(agileFixture('q7w2e9r4t1y8', { password: PASSWORD }));
  const plm = await startPlmStub({ accepts: (token) => agile.tokens.has(token) });
  t.after(async () => {
    for (const server of [agile, plm]) await server.close();
    await k.close();
  });
  return { k, agile, plm };
}

async function counts(k: ConnectorKit): Promise<Record<string, number>> {
  const client = new pg.Client({ ...k.records.database, ssl: false });
  await client.connect();
  try {
    const out: Record<string, number> = {};
    for (const table of ['records', 'objects', 'pointers']) out[table] = Number((await client.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n);
    // Secrets and the login sessions of resources are vault entries.
    out.vault = (await k.records.vault.list()).length;
    return out;
  } finally {
    await client.end();
  }
}

const plmInput = (w: World, password = PASSWORD) => ({
  system_pack: 'plm-test',
  environment: 'test' as const,
  origins: { 'plm-oauth': w.agile.origin, 'plm-api': w.plm.origin },
  allow_plaintext: [w.agile.origin, w.plm.origin],
  credentials: { username: 'reader', password },
});

const route = (report: SystemTrialReport, id: string) => report.routes.find((r) => r.route === id)!;

test('a trial logs in once, tries only argument-free routes and appends one trial action without source content or credentials', async (t) => {
  const w = await world(t);
  const before = await counts(w.k);
  const report = await w.k.connectors.admin.trial(w.k.admin, plmInput(w));
  assert.deepEqual(report.auth, { kind: 'login_token', sent: true, ok: true, reason: null, code: null, message: null, ms: report.auth.ms });
  assert.equal(w.agile.logins, 1);
  const products = route(report, 'products');
  assert.equal(products.tried, true);
  assert.equal(products.ok, true);
  assert.equal(products.status, 200);
  assert.ok(products.bytes! > 0 && products.ms! >= 0);
  // A route whose query member is required, and POST routes with a body, need arguments: not tried, none invented.
  for (const id of ['builds', 'bug-detail', 'story-detail']) {
    assert.equal(route(report, id).tried, false, id);
    assert.match(route(report, id).reason!, /尝试读取时没有可用的取值/, id);
  }
  assert.equal(w.plm.writes, 0, 'the write route is never reached');
  assert.equal(report.saved, false);
  assert.deepEqual(await counts(w.k), { ...before, records: before.records + 1 }, 'only a trial action: no object, pointer or vault entry');
  const actions = await w.k.records.store.find({ kind: 'action', key: 'action.kind', value: 'trial' });
  assert.equal(actions.items.length, 1);
  const action = actions.items[0];
  assert.equal(action.schema, TRIAL_REPORT_SCHEMA);
  assert.equal(action.provenance, 'observed');
  const body = TrialRecord.parse(action.body);
  assert.equal(body.principal, w.k.admin.id);
  assert.deepEqual(body.system_pack, { id: report.system_pack.id, version: report.system_pack.version });
  assert.deepEqual(body.auth, { sent: true, ok: true, code: null });
  assert.deepEqual(body.routes, report.routes.map(({ route, tried, ok, status, code, ms }) => ({ route, tried, ok, status, code, ms })));
  assert.equal(body.started_at, report.started_at);
  assert.equal(body.ended_at, report.ended_at);
  assert.equal((await w.k.records.store.find({ kind: 'action', key: 'action.user', value: w.k.admin.id })).items[0].digest, action.digest);
  // No value of the trial in the report or the log: neither the password, nor the token, nor what the system answered.
  const token = [...w.agile.tokens][0]!;
  const shown = JSON.stringify(report);
  const logged = JSON.stringify(w.k.log);
  const recorded = JSON.stringify(body);
  for (const secret of [PASSWORD, token]) {
    assert.ok(!shown.includes(secret), 'a value in the report');
    assert.ok(!logged.includes(secret), 'a value in the log');
    assert.ok(!recorded.includes(secret), 'a value in the record');
  }
  for (const product of PLM_PRODUCTS) {
    assert.ok(!shown.includes(product.name), 'an answer in the report');
    assert.ok(!recorded.includes(product.name), 'an answer in the record');
  }
  for (const origin of Object.values(plmInput(w).origins)) assert.ok(!recorded.includes(origin), 'no address in the record');
  assert.ok(w.k.log.some((event) => event.event === 'resource_trial'));
});

test('a failed trial record leaves the report intact and never repeats the system requests', async (t) => {
  const w = await world(t);
  const store = new Proxy(w.k.records.store, { get(target, key) {
    if (key === 'put') return async () => { throw new Error('synthetic store failure'); };
    const value = Reflect.get(target, key);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const connectors = w.k.make({ records: { ...w.k.records, store } });
  const report = await connectors.admin.trial(w.k.admin, plmInput(w));
  assert.equal(report.auth.ok, true);
  assert.equal(w.agile.logins, 1);
  assert.equal(route(report, 'products').ok, true);
  assert.equal(w.plm.requests.length, report.routes.filter((row) => row.tried).length, 'each tried route was sent once');
  assert.ok(w.k.log.some((event) => event.event === 'resource_trial_record_failed'));
});

test('a refused login is not sent again with the same values; corrected values are', async (t) => {
  const w = await world(t);
  const refused = await w.k.connectors.admin.trial(w.k.admin, plmInput(w, 'wrong-password'));
  assert.equal(refused.auth.sent, true);
  assert.equal(refused.auth.ok, false);
  assert.equal(refused.auth.code, 'LOGIN_FAILED');
  assert.match(refused.auth.message!, /^登录未成功/);
  assert.ok(!JSON.stringify(refused).includes('wrong-password'));
  assert.equal(route(refused, 'products').tried, false, 'a route that carries the token waits for a login');
  assert.equal(w.agile.logins, 1);
  const again = await w.k.connectors.admin.trial(w.k.admin, plmInput(w, 'wrong-password'));
  assert.equal(again.auth.sent, false);
  assert.match(again.auth.reason!, /此前登录失败，未再次发送/);
  assert.equal(w.agile.logins, 1, 'no second login with the values that failed');
  const actions = await w.k.records.store.find<TrialRecord>({ kind: 'action', key: 'action.kind', value: 'trial' });
  assert.deepEqual(actions.items.map((a) => a.body.auth), [{ sent: true, ok: false, code: 'LOGIN_FAILED' }, { sent: false, ok: null, code: null }]);
  const corrected = await w.k.connectors.admin.trial(w.k.admin, plmInput(w));
  assert.equal(corrected.auth.ok, true);
  assert.equal(w.agile.logins, 2);
});

test('a refused login stays refused after a restart: the vault keeps its digest, never the values', async (t) => {
  const w = await world(t);
  const refused = await w.k.connectors.admin.trial(w.k.admin, plmInput(w, 'wrong-password'));
  assert.equal(refused.auth.ok, false);
  assert.equal(w.agile.logins, 1);
  // A new process over the same records and vault: nothing in its memory.
  const restarted = w.k.make();
  const again = await restarted.admin.trial(w.k.admin, plmInput(w, 'wrong-password'));
  assert.equal(again.auth.sent, false);
  assert.match(again.auth.reason!, /此前登录失败，未再次发送/);
  assert.equal(w.agile.logins, 1, 'no second login with the values that failed, after a restart either');
  const kept = (await w.k.records.vault.getText(TRIAL_LOGIN_STOPS))!;
  assert.ok(!kept.includes('wrong-password') && !kept.includes('reader'), 'digests only');
  const parsed = JSON.parse(kept) as { v: number; failed: string[] };
  assert.equal(parsed.v, 1);
  assert.equal(parsed.failed.length, 1);
  assert.match(parsed.failed[0], /^[0-9a-f]{64}$/);
  assert.equal((await restarted.admin.trial(w.k.admin, plmInput(w))).auth.ok, true, 'corrected values are sent');
});

test('a record of failed logins that cannot be read refuses the login', async (t) => {
  const w = await world(t);
  await w.k.records.vault.put(TRIAL_LOGIN_STOPS, 'not a record');
  const report = await w.k.make().admin.trial(w.k.admin, plmInput(w));
  assert.equal(report.auth.sent, false);
  assert.equal(report.auth.reason, '登录失败记录不可读，未登录');
  assert.equal(w.agile.logins, 0);
});

test('a targeted reset clears only the typed login in memory and the vault, allowing one new attempt here and after restart', async (t) => {
  const w = await world(t);
  const a = plmInput(w, 'synthetic-refused-a'), b = plmInput(w, 'synthetic-refused-b');
  await w.k.connectors.admin.trial(w.k.admin, a);
  await w.k.connectors.admin.trial(w.k.admin, b);
  assert.equal(w.agile.logins, 2);
  await assert.rejects(w.k.connectors.admin.forgetTrialLogin(w.k.user, a), (error: unknown) => error instanceof ConnectorError && error.code === 'ACCESS_DENIED');
  assert.deepEqual(await w.k.connectors.admin.forgetTrialLogin(w.k.admin, a), { found: true, cleared: true });
  assert.equal(w.agile.logins, 2, 'forgetting never logs in');
  assert.equal((await w.k.connectors.admin.trial(w.k.admin, b)).auth.sent, false, 'other credentials stay stopped');
  assert.equal((await w.k.connectors.admin.trial(w.k.admin, a)).auth.sent, true);
  assert.equal((await w.k.connectors.admin.trial(w.k.admin, a)).auth.sent, false, 'the next failure stops again');
  await w.k.connectors.admin.forgetTrialLogin(w.k.admin, a);
  assert.equal((await w.k.make().admin.trial(w.k.admin, a)).auth.sent, true, 'cleared in the vault too');
  assert.equal((await w.k.make().admin.trial(w.k.admin, b)).auth.sent, false);
  assert.equal(w.agile.logins, 4);
  assert.deepEqual(await w.k.connectors.admin.forgetTrialLogin(w.k.admin, plmInput(w, 'never-sent')), { found: false, cleared: false });
});

test('a repaired source accepts the same credentials after an explicit reset; incomplete credentials clear nothing', async (t) => {
  const w = await world(t);
  w.agile.setPassword('synthetic-temporarily-unavailable-password');
  await w.k.connectors.admin.trial(w.k.admin, plmInput(w));
  w.agile.setPassword(PASSWORD);
  assert.equal((await w.k.connectors.admin.trial(w.k.admin, plmInput(w))).auth.sent, false);
  await assert.rejects(w.k.connectors.admin.forgetTrialLogin(w.k.admin, { ...plmInput(w), credentials: {} }), (error: unknown) => error instanceof ConnectorError && error.code === 'RESOURCE_INVALID');
  assert.deepEqual(await w.k.connectors.admin.forgetTrialLogin(w.k.admin, plmInput(w)), { found: true, cleared: true });
  assert.equal(w.agile.logins, 1);
  assert.equal((await w.k.connectors.admin.trial(w.k.admin, plmInput(w))).auth.ok, true);
  assert.equal(w.agile.logins, 2);
});

test('concurrent adds and a targeted reset preserve other entries; a failed clear retains the stop', async (t) => {
  const w = await world(t);
  const stops = new TrialLoginStops(w.k.records.store, w.k.records.vault);
  const a = 'a'.repeat(64), b = 'b'.repeat(64), c = 'c'.repeat(64);
  await stops.add(a); await stops.add(b);
  await Promise.all([stops.forget(a), stops.add(c)]);
  assert.equal(await stops.has(a), false);
  assert.equal(await stops.has(b), true);
  assert.equal(await stops.has(c), true);
  const broken = new TrialLoginStops(w.k.records.store, { getText: (name) => w.k.records.vault.getText(name), put: async () => { throw new Error('synthetic write failure'); } });
  await assert.rejects(broken.forget(b), /synthetic write failure/);
  assert.equal(await broken.has(b), true);
});

test('a new failure arriving during a clear is retained even when its later vault write fails', { timeout: 10_000 }, async (t) => {
  const w = await world(t);
  const key = 'a'.repeat(64);
  let release!: () => void, entered!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  t.after(() => release());
  const writing = new Promise<void>((resolve) => { entered = resolve; });
  let clearing = false;
  const stops = new TrialLoginStops(w.k.records.store, {
    getText: (name) => w.k.records.vault.getText(name),
    put: async (name, bytes) => {
      if (clearing) {
        const kept = JSON.parse(typeof bytes === 'string' ? bytes : Buffer.from(bytes).toString('utf8')) as { failed: string[] };
        if (kept.failed.includes(key)) throw new Error('synthetic later write failure');
        entered(); await waiting;
      }
      await w.k.records.vault.put(name, bytes);
    },
  });
  await stops.add(key);
  clearing = true;
  const forgotten = stops.forget(key);
  await writing;
  const newFailure = stops.add(key);
  release();
  assert.deepEqual(await forgotten, { found: true, cleared: false });
  assert.equal(await newFailure, false);
  assert.equal(await stops.has(key), true, 'the later failure remains stopped in memory');
});

test('a trial is for administrators, of a published system pack, with every role and the plaintext rule', async (t) => {
  const w = await world(t);
  await assert.rejects(w.k.connectors.admin.trial(w.k.user, plmInput(w)), (error: unknown) => error instanceof ConnectorError && error.code === 'ACCESS_DENIED');
  await assert.rejects(w.k.connectors.admin.trial(w.k.admin, { ...plmInput(w), system_pack: 'nope' }), (error: unknown) => error instanceof ConnectorError && error.code === 'PACK_UNAVAILABLE');
  await assert.rejects(w.k.connectors.admin.trial(w.k.admin, { ...plmInput(w), origins: { 'plm-api': w.plm.origin } }), (error: unknown) => error instanceof ConnectorError && error.code === 'RESOURCE_INVALID');
  await assert.rejects(w.k.connectors.admin.trial(w.k.admin, { ...plmInput(w), credentials: { username: 'reader', password: PASSWORD, extra: 'x' } }), (error: unknown) => error instanceof ConnectorError && error.code === 'RESOURCE_INVALID');
  // Plain HTTP not declared for the login's origin: the login is refused before any request.
  const plain = await w.k.connectors.admin.trial(w.k.admin, { ...plmInput(w), allow_plaintext: [w.plm.origin] });
  assert.equal(plain.auth.sent, false);
  assert.equal(plain.auth.code, 'PLAINTEXT_REFUSED');
  assert.equal(w.agile.logins, 0);
  // Without the credentials no login is sent and the routes that carry the token wait.
  const blank = await w.k.connectors.admin.trial(w.k.admin, { ...plmInput(w), credentials: {} });
  assert.equal(blank.auth.sent, false);
  assert.match(blank.auth.reason!, /未填写，未登录/);
  assert.equal(route(blank, 'products').tried, false);
  assert.equal(w.agile.logins, 0);
});

test('a redirect is never followed, a declared hop stays unknown, and no route is requested past the deadline', async (t) => {
  const w = await world(t);
  const site = await startStub((request) => {
    if (request.path === '/slow/') w.k.clock.advance(61_000);
    return ['/slow/', '/status/'].includes(request.path) ? json({ ok: true }) : { status: 302, headers: { location: '/status/' } };
  });
  t.after(() => site.close());
  const get = (id: string, extra: Record<string, unknown> = {}) => ({ id, role: 'site', method: 'GET', path: `/${id}/`, response: 'json', max_bytes: 4096, read: true, ...extra });
  w.k.packs.set(
    await writePack(w.k.packRoot, {
      id: 'site-test',
      system: {
        schema: 'system@1',
        title: '合成站点',
        roles: [{ name: 'site' }],
        auth: { kind: 'none' },
        routes: [get('moved', { redirects: { same_origin: true, max_hops: 1 } }), get('jumps'), get('slow'), get('status')],
        reads: [{ name: 'status', external: 'site:status', request: { route: 'status' } }],
      },
    }),
  );
  const report = await w.k.connectors.admin.trial(w.k.admin, { system_pack: 'site-test', environment: 'test', origins: { site: site.origin }, allow_plaintext: [site.origin] });
  assert.deepEqual([report.auth.kind, report.auth.sent, report.auth.ok], ['none', false, null]);
  assert.deepEqual([route(report, 'moved').tried, route(report, 'moved').ok, route(report, 'moved').status], [true, null, 302]);
  assert.match(route(report, 'moved').message!, /尝试读取不跟随跳转/);
  assert.deepEqual([route(report, 'jumps').ok, route(report, 'jumps').code], [false, 'SOURCE_REDIRECT_REFUSED']);
  assert.equal(route(report, 'slow').ok, true);
  assert.equal(route(report, 'status').tried, false);
  assert.match(route(report, 'status').reason!, /其余接口未尝试读取/);
  assert.deepEqual(site.requests.map((r) => r.path), ['/moved/', '/jumps/', '/slow/'], 'no hop followed, nothing after the deadline');
  const record = (await w.k.records.store.find<TrialRecord>({ kind: 'action', key: 'action.kind', value: 'trial' })).items[0].body;
  assert.deepEqual(record.routes.map((row) => [row.tried, row.ok]), [[true, null], [true, false], [true, true], [false, null]], 'unknown and untried outcomes stay distinct');
});

test('the statistics count the reads of the window by result, with the median and longest time of the completed ones', async (t) => {
  const w = await world(t);
  const add = (input: Parameters<ConnectorKit['connectors']['admin']['addResource']>[1]) => addSyntheticResource(w.k.records, w.k.packs, w.k.connectors, w.k.admin, input);
  const plm = await add({ system_pack: 'plm-test', name: '合成 PLM', environment: 'shared', origins: { 'plm-oauth': w.agile.origin, 'plm-api': w.plm.origin }, allow_plaintext: [w.agile.origin, w.plm.origin] });
  const idle = await add({ system_pack: 'plm-test', name: '另一个 PLM', environment: 'test', origins: { 'plm-oauth': w.agile.origin, 'plm-api': w.plm.origin }, allow_plaintext: [w.agile.origin, w.plm.origin] });
  await setSyntheticCredentials(w.k.records, w.k.connectors, w.k.admin, plm.id, { username: 'reader', password: PASSWORD });
  const ctx = { principal: w.k.user, run: null, purpose: 'statistics test' };
  for (let i = 0; i < 3; i++) assert.equal((await w.k.connectors.executeRead(plm.id, 'products', { id: 'all' }, ctx)).ok, true);
  // A read that fails after planning still writes its manifest: counted as an error, not in the times.
  w.agile.expireTokens();
  w.agile.refuseNewTokens = true;
  await w.k.connectors.executeRead(plm.id, 'products', { id: 'all' }, ctx);
  const [busy, quiet] = await readStatistics(w.k.records.store, [plm.id, idle.id], w.k.clock.now());
  assert.equal(busy.reads, 4);
  assert.equal(busy.results.completed, 3);
  assert.equal(busy.results.error + busy.results.unknown, 1);
  assert.equal(typeof busy.median_ms, 'number');
  assert.ok(busy.slowest_ms! >= busy.median_ms!);
  assert.ok(busy.last_at !== null && busy.partial === false);
  assert.deepEqual([quiet.reads, quiet.median_ms, quiet.last_at], [0, null, null]);
  // A window that has moved past them counts none; a scan limit below the reads says the numbers are partial.
  const later = new Date(w.k.clock.now().getTime() + 25 * 60 * 60 * 1000);
  assert.equal((await readStatistics(w.k.records.store, [plm.id], later))[0].reads, 0);
  const capped = (await readStatistics(w.k.records.store, [plm.id], w.k.clock.now(), undefined, 2))[0];
  assert.equal(capped.partial, true);
  assert.equal(capped.reads, 2);
  await w.k.connectors.admin.trial(w.k.admin, plmInput(w));
  assert.deepEqual(await readStatistics(w.k.records.store, [plm.id, idle.id], new Date(busy.until)), [busy, quiet], 'trial actions never enter real-read statistics');
});
