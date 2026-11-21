import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { RunLateExport } from '../../contracts/src/run.ts';
import type { ServerDeps } from './api.ts';
import { handleRunExport } from './run-export.ts';

const RUN = 'run_01aaaaaaaaaaaaaaaaaaaaaaaa';
const PLAIN = 'run_01bbbbbbbbbbbbbbbbbbbbbbbb';
const STAGE = 'run_01cccccccccccccccccccccccc';
const users: Record<string, { id: string; role: string }> = { 'Bearer runner-token': { id: 'u_runner', role: 'user' }, 'Bearer other-token': { id: 'u_other', role: 'user' } };
const BODY = RunLateExport.parse({
  schema: 'run-late@1', run: RUN, run_reference: 'rec:' + 'a'.repeat(64), resolved_at: '2026-11-17T08:00:00.000Z',
  late: { inputs: [{ slot: 'stage', run: STAGE, reference: 'rec:' + 'b'.repeat(64) }], refresh: 'c'.repeat(64) },
  items: [{ id: 'case-c1', late: { stage: { status: 'satisfied' } } }, { id: 'case-c2', late: { waiting: { run: STAGE } } }],
});

function deps(calls: string[]): ServerDeps {
  return {
    records: { principals: { authenticate: async (header: string | null) => (header && users[header]) ?? null }, callLog: { append: async () => {} } },
    runs: {
      exportRun: async () => { calls.push('exportRun'); return null; },
      exportLate: async (principal: { id: string }, run: string) => {
        calls.push('exportLate');
        if (principal.id !== 'u_runner') return null;
        if (run === RUN) return { ok: true, body: BODY };
        if (run === PLAIN) return { ok: false, reason: 'no_late' };
        return null;
      },
    },
  } as unknown as ServerDeps;
}
async function serve(d: ServerDeps) {
  const server = createServer((request, response) => { void handleRunExport(request, response, d, () => {}); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return { origin: `http://127.0.0.1:${port}`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

test('the runner reads the late export with its digest, and the route never goes through exportRun', async (t) => {
  const calls: string[] = [];
  const s = await serve(deps(calls)); t.after(s.close);
  const answer = await fetch(`${s.origin}/run-export/${RUN}/late`, { headers: { authorization: 'Bearer runner-token' } });
  assert.equal(answer.status, 200);
  assert.equal(answer.headers.get('content-type'), 'application/json');
  const bytes = Buffer.from(await answer.arrayBuffer());
  assert.equal(answer.headers.get('content-digest'), `sha-256=:${createHash('sha256').update(bytes).digest('base64')}:`);
  const body = RunLateExport.parse(JSON.parse(bytes.toString('utf8')));
  assert.deepEqual(body, BODY);
  assert.deepEqual(calls, ['exportLate']);
});

test('another user, no token, a run without inputs bound after the start, a malformed path and a write are refused', async (t) => {
  const calls: string[] = [];
  const s = await serve(deps(calls)); t.after(s.close);
  assert.equal((await fetch(`${s.origin}/run-export/${RUN}/late`, { headers: { authorization: 'Bearer other-token' } })).status, 404);
  assert.equal((await fetch(`${s.origin}/run-export/${RUN}/late`)).status, 401);
  const plain = await fetch(`${s.origin}/run-export/${PLAIN}/late`, { headers: { authorization: 'Bearer runner-token' } });
  assert.equal(plain.status, 404);
  assert.match(await plain.text(), /运行没有开运行后再绑定的输入/);
  assert.equal((await fetch(`${s.origin}/run-export/${RUN}/late/x`, { headers: { authorization: 'Bearer runner-token' } })).status, 404);
  assert.equal((await fetch(`${s.origin}/run-export/${RUN}/late`, { method: 'POST', headers: { authorization: 'Bearer runner-token' } })).status, 405);
  assert.ok(!calls.includes('exportRun'));
});
