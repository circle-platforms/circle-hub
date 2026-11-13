import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_LIMITS } from '../config/index.ts';
import { createRebuildApp } from './rebuild-app.ts';
import { issueSetupCode, issueRebuildCode, checkRebuildCode } from './setup-code.ts';
import { rebuildRequiredState } from './rebuild-state.ts';
import type { RebuildConsoleContext, RebuildResetBridge } from './rebuild-http.ts';

const operationId = '12345678-1234-4123-8123-123456789abc';

test('unavailable connections and permissions never select destructive rebuild mode', () => {
  assert.equal(rebuildRequiredState({ status: 'unavailable', compatible: null, expected: [], applied: null, problems: ['连接失败，无法观察'] }), null);
  assert.equal(rebuildRequiredState({ status: 'compatible', compatible: true, expected: [], applied: [], problems: [] }), null);
  assert.ok(rebuildRequiredState({ status: 'incompatible', compatible: false, expected: [], applied: null, problems: ['没有迁移登记'] }));
});

test('restricted startup isolates bootstrap codes, requires maintenance grant and CSRF, and ACKs only after its response', { timeout: 10_000 }, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'circle-hub-rebuild-http-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  let view: RebuildConsoleContext | undefined, launches = 0, acknowledgements = 0;
  const contexts: string[] = [];
  const bridge: RebuildResetBridge = {
    validate: input => typeof input === 'object' && input !== null && 'scopes' in input && input.scopes === 'all' ? { scopes: 'all', keepConfig: false } : null,
    inspect: async () => ({ available: true, compatible: false, needsRebuild: true, diagnostics: [], canKeepConfig: false, choices: [{ scopes: 'all', keepConfig: false, definitionAllowed: false }] }),
    preview: async request => ({ request, inspection: await bridge.inspect(), counts: [], blocked: [] }),
    launch: async (_request, context) => { launches++; contexts.push(context); return { operationId }; },
    acknowledge: async (_id, context) => { acknowledgements++; contexts.push(context); },
    status: async (_id, context) => { contexts.push(context); return { operationId, acknowledged: true, running: true, completed: false }; },
  };
  const app = await createRebuildApp({ dataDir, logDir: join(dataDir, 'logs'), host: '127.0.0.1', port: 0, database: { host: '127.0.0.1', port: 1, database: 'unused', user: 'unused' }, limits: DEFAULT_LIMITS }, {
    dataDir, rebuildNeeded: { reason: 'migration identity mismatch', detail: 'private schema observation' }, bridge, log: () => {},
    render: context => { view = context; return context.authorized ? '授权重建预览' : '维护授权'; },
  });
  t.after(() => app.close()); const info = await app.listen();
  const cookies = new Map<string, string>();
  const remember = (response: Response) => { for (const line of response.headers.getSetCookie()) { const pair = line.split(';')[0], at = pair.indexOf('='); cookies.set(pair.slice(0, at), pair.slice(at + 1)); } };
  const request = async (path: string, form?: Record<string, string>) => {
    const response = await fetch(info.url + path, { method: form ? 'POST' : 'GET', redirect: 'manual', headers: { cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; '), ...(form ? { origin: info.url, 'content-type': 'application/x-www-form-urlencoded' } : {}) }, ...(form ? { body: new URLSearchParams(form).toString() } : {}) });
    remember(response); return response;
  };
  const health = await request('/healthz'); assert.deepEqual(await health.json(), { needsRebuild: true });
  assert.equal((await request('/mcp')).status, 503);
  assert.equal((await request('/console/reset/status/' + operationId)).status, 401);
  await request('/console/rebuild'); assert.ok(view?.loginNonce); assert.equal(view.rebuildNeeded, undefined);
  const bootstrap = await issueSetupCode(dataDir);
  assert.equal((await request('/console/rebuild/authorize', { setup_code: bootstrap, nonce: view.loginNonce })).status, 401);
  assert.equal(launches, 0);
  await request('/console/rebuild'); assert.ok(view?.loginNonce);
  const maintenance = await issueRebuildCode(dataDir);
  assert.equal((await request('/console/rebuild/authorize', { setup_code: maintenance, nonce: view.loginNonce })).status, 303);
  assert.equal(await checkRebuildCode(dataDir, maintenance), 'none', 'maintenance code was consumed once');
  await request('/console/rebuild'); assert.ok(view?.authorized && view.actionId);
  const action = view.actionId, csrf = view.csrf;
  assert.equal((await request('/console/rebuild/execute', { csrf: 'wrong', actionId: action })).status, 403);
  assert.equal((await request('/console/rebuild/preview', { csrf, actionId: action, scope: 'all', confirm: '重建' })).status, 200);
  const accepted = await request('/console/rebuild/execute', { csrf, actionId: action }); assert.equal(accepted.status, 202);
  assert.deepEqual(await accepted.json(), { operationId, statusUrl: '/console/reset/status/' + operationId });
  const retried = await request('/console/rebuild/execute', { csrf, actionId: action }); assert.equal(retried.status, 202); await retried.text();
  assert.equal(launches, 1, 'the same form action reuses its accepted worker');
  await request('/console/reset/status/' + operationId);
  assert.ok(acknowledgements >= 1); assert.equal(new Set(contexts).size, 1);
  assert.ok(contexts.every(context => !context.includes(maintenance) && !context.includes(bootstrap)));
});

test('a disconnected execute response never acknowledges its queued worker', { timeout: 10_000 }, async t => {
  const { createServer, request: httpRequest } = await import('node:http');
  const { createRebuildHandler } = await import('./rebuild-http.ts');
  const dataDir = await mkdtemp(join(tmpdir(), 'circle-hub-rebuild-disconnect-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const launchStarted = Promise.withResolvers<void>(), launchFinished = Promise.withResolvers<{ operationId: string }>(), disconnected = Promise.withResolvers<void>(), handled = Promise.withResolvers<void>();
  let view: RebuildConsoleContext | undefined, acknowledgements = 0;
  const bridge: RebuildResetBridge = {
    validate: () => ({ scopes: 'all', keepConfig: false }),
    inspect: async () => ({ available: true, compatible: false, needsRebuild: true, diagnostics: [], canKeepConfig: false, choices: [] }),
    preview: async request => ({ request, inspection: await bridge.inspect(), counts: [], blocked: [] }),
    launch: async () => { launchStarted.resolve(); return launchFinished.promise; },
    acknowledge: async () => { acknowledgements++; },
    status: async () => ({ operationId, acknowledged: false, running: false, completed: false }),
  };
  const handler = createRebuildHandler({ dataDir, rebuildNeeded: { reason: 'schema mismatch' }, bridge, originAllowed: () => true, render: context => { view = context; return 'maintenance'; }, log: () => {} });
  const server = createServer((req, res) => {
    const execute = req.url === '/console/rebuild/execute';
    if (execute) res.once('close', () => disconnected.resolve());
    void handler(req, res, new URL(req.url!, 'http://127.0.0.1')).then(() => { if (execute) handled.resolve(); }, handled.reject);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { launchFinished.resolve({ operationId }); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address !== 'string'); const base = `http://127.0.0.1:${address.port}`;
  const cookies = new Map<string, string>();
  const headers = () => ({ cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; '), 'content-type': 'application/x-www-form-urlencoded' });
  const call = async (path: string, data?: Record<string, string>) => { const response = await fetch(base + path, { method: data ? 'POST' : 'GET', redirect: 'manual', headers: headers(), ...(data ? { body: new URLSearchParams(data).toString() } : {}) }); for (const line of response.headers.getSetCookie()) { const [pair] = line.split(';'), at = pair.indexOf('='); cookies.set(pair.slice(0, at), pair.slice(at + 1)); } await response.text(); return response; };
  await call('/console/rebuild'); assert.ok(view?.loginNonce);
  await call('/console/rebuild/authorize', { nonce: view.loginNonce, setup_code: await issueRebuildCode(dataDir) });
  await call('/console/rebuild'); assert.ok(view?.actionId); const form = { csrf: view.csrf, actionId: view.actionId };
  await call('/console/rebuild/preview', { ...form, scope: 'all', confirm: '重建' });
  const pending = httpRequest(base + '/console/rebuild/execute', { method: 'POST', headers: headers() }); pending.on('error', () => {}); pending.end(new URLSearchParams(form).toString());
  await launchStarted.promise; pending.destroy(); await disconnected.promise; launchFinished.resolve({ operationId }); await handled.promise;
  assert.equal(acknowledgements, 0);
});
