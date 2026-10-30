// Decision 104: the runner's export of its own run for client-side generation. Synthetic deps only.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { handleRunExport } from './run-export.ts';
import type { ServerDeps } from './api.ts';

const RUN = 'run_01aaaaaaaaaaaaaaaaaaaaaaaa';
const bytes = Buffer.from('{"synthetic":"contract"}');
const SHA = createHash('sha256').update(bytes).digest('hex');
const users: Record<string, { id: string; role: string }> = { 'Bearer runner-token': { id: 'u_runner', role: 'user' }, 'Bearer other-token': { id: 'u_other', role: 'user' } };
function deps(accepted = true): ServerDeps {
  return {
    records: {
      principals: { authenticate: async (header: string | null) => (header && users[header]) ?? null },
      artifacts: { sourceForRun: async (principal: { id: string }, sha: string, run: string) => principal.id === 'u_runner' && run === RUN && sha === SHA ? { bytes } : null },
      callLog: { append: async () => {} },
    },
    runs: { exportRun: async (principal: { id: string }, run: string) => principal.id === 'u_runner' && run === RUN ? { run: { run: RUN, sources: [{ slot: 'contract', reference: `src:${SHA}` }] }, result: accepted ? { run: RUN, acceptance: 'accepted', submission: 'd'.repeat(64) } : null, submission: accepted ? { run: RUN, items: [] } : null } : null },
  } as unknown as ServerDeps;
}
async function serve(d: ServerDeps) {
  const server = createServer((request, response) => { void handleRunExport(request, response, d, () => {}); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return { origin: `http://127.0.0.1:${port}`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

test('the runner reads its run, accepted result and submission, and the exact bytes of a bound source', async (t) => {
  const s = await serve(deps()); t.after(s.close);
  const own = await fetch(`${s.origin}/run-export/${RUN}`, { headers: { authorization: 'Bearer runner-token' } });
  assert.equal(own.status, 200); const body = await own.json() as Record<string, any>;
  assert.equal(body.schema, 'run-export@1'); assert.equal(body.run.run, RUN); assert.equal(body.result.acceptance, 'accepted'); assert.deepEqual(body.submission, { run: RUN, items: [] });
  const source = await fetch(`${s.origin}/run-export/${RUN}/sources/${SHA}`, { headers: { authorization: 'Bearer runner-token' } });
  assert.equal(source.status, 200); assert.deepEqual(Buffer.from(await source.arrayBuffer()), bytes);
  assert.match(source.headers.get('content-digest') ?? '', /^sha-256=:/);
});

test('no token, another user, an unbound source, a malformed path and a run without an accepted result are refused', async (t) => {
  const s = await serve(deps()); t.after(s.close);
  assert.equal((await fetch(`${s.origin}/run-export/${RUN}`)).status, 401);
  assert.equal((await fetch(`${s.origin}/run-export/${RUN}`, { headers: { authorization: 'Bearer other-token' } })).status, 404);
  assert.equal((await fetch(`${s.origin}/run-export/${RUN}/sources/${'e'.repeat(64)}`, { headers: { authorization: 'Bearer runner-token' } })).status, 404);
  assert.equal((await fetch(`${s.origin}/run-export/not-a-run`, { headers: { authorization: 'Bearer runner-token' } })).status, 404);
  assert.equal((await fetch(`${s.origin}/run-export/${RUN}`, { method: 'POST', headers: { authorization: 'Bearer runner-token' } })).status, 405);
  const pending = await serve(deps(false)); t.after(pending.close);
  assert.equal((await fetch(`${pending.origin}/run-export/${RUN}`, { headers: { authorization: 'Bearer runner-token' } })).status, 409);
});
