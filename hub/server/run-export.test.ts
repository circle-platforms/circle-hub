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

test('the run alone is readable before anything is accepted, and only by the one who may read it', async (t) => {
  const pending = await serve(deps(false)); t.after(() => pending.close());
  const answer = await fetch(`${pending.origin}/run-export/${RUN}/run`, { headers: { authorization: 'Bearer runner-token' } });
  assert.equal(answer.status, 200);
  const body = await answer.json() as { schema: string; run: unknown; result?: unknown };
  assert.equal(body.schema, 'run-export@1');
  assert.ok(body.run);
  assert.equal(body.result, undefined);
  assert.equal((await fetch(`${pending.origin}/run-export/${RUN}/run`, { headers: { authorization: 'Bearer other-token' } })).status, 404);
  assert.equal((await fetch(`${pending.origin}/run-export/${RUN}/run`)).status, 401);
});

test("the run's jobs come with each item's verdict, and what a job returned is downloadable by its digest", async (t) => {
  const deviceReturn = Buffer.from('作业 j1 的设备返回。逐条结论：\ncase-1：通过\ncase-2：失败\n'), log = Buffer.from('合成日志\n');
  const sha = (value: Buffer) => createHash('sha256').update(value).digest('hex');
  const job = { job: 'j1', verification_run: RUN, plan_run: 'run_01bbbbbbbbbbbbbbbbbbbbbbbb', items: ['case-1', 'case-2'], sha256: 'c'.repeat(64), ended: 'done', outcome: 'effective', frozen: false, result: `src:${'f'.repeat(64)}`, device_return: `src:${sha(deviceReturn)}`, rows: [{ item: 'case-1', dynamic_terminal: 'pass' }, { item: 'case-2', dynamic_terminal: 'fail', evidence: { log: `src:${sha(log)}` } }] };
  const d = deps(false) as unknown as { runs: Record<string, unknown>; records: { artifacts: Record<string, unknown> } };
  d.runs.exportJobs = async (principal: { id: string }, run: string) => principal.id === 'u_runner' && run === RUN ? { run, jobs: [job] } : null;
  d.records.artifacts.source = async (principal: { id: string }, wanted: string) => principal.id !== 'u_runner' ? null : wanted === sha(deviceReturn) ? { bytes: deviceReturn } : wanted === sha(log) ? { bytes: log } : null;
  const s = await serve(d as unknown as ServerDeps); t.after(s.close);
  const answer = await fetch(`${s.origin}/run-export/${RUN}/jobs`, { headers: { authorization: 'Bearer runner-token' } });
  assert.equal(answer.status, 200, 'readable before or after acceptance: the jobs are their own answer');
  assert.deepEqual(await answer.json(), { schema: 'run-jobs@1', run: RUN, jobs: [job] });
  for (const bytes of [deviceReturn, log]) {
    const source = await fetch(`${s.origin}/run-export/${RUN}/sources/${sha(bytes)}`, { headers: { authorization: 'Bearer runner-token' } });
    assert.equal(source.status, 200); assert.deepEqual(Buffer.from(await source.arrayBuffer()), bytes);
  }
  assert.equal((await fetch(`${s.origin}/run-export/${RUN}/sources/${'e'.repeat(64)}`, { headers: { authorization: 'Bearer runner-token' } })).status, 404, 'a digest no job of the run returned');
  assert.equal((await fetch(`${s.origin}/run-export/${RUN}/jobs`, { headers: { authorization: 'Bearer other-token' } })).status, 404);
  assert.equal((await fetch(`${s.origin}/run-export/${RUN}/sources/${sha(log)}`, { headers: { authorization: 'Bearer other-token' } })).status, 404);
  assert.equal((await fetch(`${s.origin}/run-export/${RUN}/jobs`)).status, 401);
});

test("the runs started from a run come back reduced to their lineage, at the reader's own visibility", async (t) => {
  const successor = { run: 'run_01bbbbbbbbbbbbbbbbbbbbbbbb', pack: 'synthetic-flow@1.0.0', started_at: '2026-11-08T08:00:00.000Z', predecessor: RUN, parameters: { plan_run: RUN }, sources: [{ slot: 'recomposition_result', reference: `rec:${'d'.repeat(64)}` }] };
  const d = deps(false) as unknown as { runs: Record<string, unknown> };
  d.runs.exportSuccessors = async (principal: { id: string }, run: string) => principal.id === 'u_runner' && run === RUN ? { run, successors: [successor] } : null;
  const s = await serve(d as unknown as ServerDeps); t.after(s.close);
  const answer = await fetch(`${s.origin}/run-export/${RUN}/successors`, { headers: { authorization: 'Bearer runner-token' } });
  assert.equal(answer.status, 200);
  assert.deepEqual(await answer.json(), { schema: 'run-successors@1', run: RUN, successors: [successor] });
  assert.equal((await fetch(`${s.origin}/run-export/${RUN}/successors`, { headers: { authorization: 'Bearer other-token' } })).status, 404);
  assert.equal((await fetch(`${s.origin}/run-export/${RUN}/successors/x`, { headers: { authorization: 'Bearer runner-token' } })).status, 404);
  assert.equal((await fetch(`${s.origin}/run-export/${RUN}/successors`)).status, 401);
});
