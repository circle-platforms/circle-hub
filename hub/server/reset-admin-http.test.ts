import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRebuildHandler, type RebuildResetBridge, type RebuildConsoleContext } from './rebuild-http.ts';
import { SessionStore } from './console/session.ts';

test('administrator reset previews once and launches an acknowledged worker without synchronous reset', async t => {
  const session = new SessionStore().open('synthetic-token', false);
  let administrator = true, view: RebuildConsoleContext | undefined;
  let launches = 0, acknowledgements = 0;
  const contexts: string[] = [];
  const id = '550e8400-e29b-41d4-a716-446655440000';
  const bridge: RebuildResetBridge = {
    validate: input => typeof input === 'object' && input !== null && 'scopes' in input && Array.isArray(input.scopes) && input.scopes[0] === 'history' ? { scopes: ['history'], keepConfig: false } : null,
    inspect: async () => ({ available: true, compatible: true, needsRebuild: false, diagnostics: [], canKeepConfig: true, choices: [] }),
    preview: async request => ({ request, inspection: await bridge.inspect(), counts: [], blocked: [] }),
    launch: async (_request, context) => { launches++; contexts.push(context); return { operationId: id }; },
    acknowledge: async (_id, context) => { acknowledgements++; contexts.push(context); },
    status: async (_id, context) => { contexts.push(context); return { operationId: id, acknowledged: true, running: true, completed: false }; },
  };
  const handler = createRebuildHandler({
    dataDir: '/synthetic/unused', rebuildNeeded: null, bridge, originAllowed: () => true, log: () => {},
    authenticateAdmin: async () => administrator ? { session, principalId: 'synthetic-admin' } : null,
    render: context => { view = context; return 'synthetic reset preview'; },
  });
  const server = createServer((request, response) => {
    void handler(request, response, new URL(request.url!, 'http://localhost')).catch(() => { response.writeHead(500); response.end(); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const call = (path: string, form?: Record<string, string>) => fetch(base + path, {
    method: form ? 'POST' : 'GET', redirect: 'manual',
    ...(form ? { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form).toString() } : {}),
  });
  assert.equal((await call('/console/admin/do/reset', { csrf: 'wrong', scope: 'history', confirm: '重建' })).status, 403);
  assert.equal((await call('/console/admin/do/reset', { csrf: session.csrf, scope: 'history', confirm: '重建' })).status, 200);
  assert.equal(launches, 0); assert.ok(view?.actionId);
  const form = { csrf: session.csrf, actionId: view.actionId };
  assert.equal((await call('/console/rebuild/execute', form)).status, 202);
  assert.equal((await call('/console/rebuild/execute', form)).status, 202);
  assert.equal(launches, 1);
  await call('/console/reset/status/' + id);
  assert.ok(acknowledgements >= 1);
  assert.equal(new Set(contexts).size, 1);
  assert.equal(contexts[0], 'admin:synthetic-admin:' + form.actionId);
  assert.ok(!contexts[0].includes(session.token));
  administrator = false;
  assert.equal((await call('/console/reset/status/' + id)).status, 403);
  assert.equal((await call('/console/rebuild/execute', form)).status, 403);
  assert.equal(launches, 1);
});
