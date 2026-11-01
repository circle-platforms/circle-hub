// The read-only trial of a system pack (trial.ts) and the read statistics of a resource (statistics.ts), against loopback
// stubs: the trial logs in at most once, never twice with values that failed, tries only the routes that need no
// arguments, never reaches a write route, stores nothing (no record, no object, no session entry) and keeps every value
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
import type { SystemTrialReport } from './trial.ts';

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

test('a trial logs in once, tries the routes that need no arguments, opens no write route and keeps nothing', async (t) => {
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
    assert.match(route(report, id).reason!, /试读时没有可用的取值/, id);
  }
  assert.equal(w.plm.writes, 0, 'the write route is never reached');
  assert.equal(report.saved, false);
  assert.deepEqual(await counts(w.k), before, 'no record, no object, no pointer, no vault entry');
  // No value of the trial in the report or the log: neither the password, nor the token, nor what the system answered.
  const token = [...w.agile.tokens][0]!;
  const shown = JSON.stringify(report);
  const logged = JSON.stringify(w.k.log);
  for (const secret of [PASSWORD, token]) {
    assert.ok(!shown.includes(secret), 'a value in the report');
    assert.ok(!logged.includes(secret), 'a value in the log');
  }
  for (const product of PLM_PRODUCTS) assert.ok(!shown.includes(product.name), 'an answer in the report');
  assert.ok(w.k.log.some((event) => event.event === 'resource_trial'));
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
  assert.match(again.auth.reason!, /已登录失败，未再次发送/);
  assert.equal(w.agile.logins, 1, 'no second login with the values that failed');
  const corrected = await w.k.connectors.admin.trial(w.k.admin, plmInput(w));
  assert.equal(corrected.auth.ok, true);
  assert.equal(w.agile.logins, 2);
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
  assert.match(route(report, 'moved').message!, /试读不跟随跳转/);
  assert.deepEqual([route(report, 'jumps').ok, route(report, 'jumps').code], [false, 'SOURCE_REDIRECT_REFUSED']);
  assert.equal(route(report, 'slow').ok, true);
  assert.equal(route(report, 'status').tried, false);
  assert.match(route(report, 'status').reason!, /其余接口未试读/);
  assert.deepEqual(site.requests.map((r) => r.path), ['/moved/', '/jumps/', '/slow/'], 'no hop followed, nothing after the deadline');
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
});
