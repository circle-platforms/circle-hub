// Decision 104: the runner's export of its own run for client-side generation. Synthetic deps only.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { handleRunExport } from './run-export.ts';
import type { ServerDeps } from './api.ts';

const RUN = 'run_01aaaaaaaaaaaaaaaaaaaaaaaa';
const RUN_REFERENCE = `rec:${'a'.repeat(64)}`;
const ACCEPTED_RESULT_REFERENCE = `rec:${'b'.repeat(64)}`;
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
    runs: { exportRun: async (principal: { id: string }, run: string) => principal.id === 'u_runner' && run === RUN ? { run_reference: RUN_REFERENCE, accepted_result_reference: accepted ? ACCEPTED_RESULT_REFERENCE : null, run: { run: RUN, sources: [{ slot: 'contract', reference: `src:${SHA}` }] }, result: accepted ? { run: RUN, acceptance: 'accepted', submission: 'd'.repeat(64) } : null, submission: accepted ? { run: RUN, items: [] } : null } : null },
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
  assert.equal(body.schema, 'run-export@1');
  assert.equal(body.run_reference, RUN_REFERENCE, 'the immutable run reference supplied by the service');
  assert.equal(body.accepted_result_reference, ACCEPTED_RESULT_REFERENCE, 'the immutable reference supplied with this accepted result, not its submission digest');
  assert.equal(body.run.run, RUN); assert.equal(body.result.acceptance, 'accepted'); assert.deepEqual(body.submission, { run: RUN, items: [] });
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
  const body = await answer.json() as { schema: string; run_reference: string; run: unknown; result?: unknown };
  assert.equal(body.schema, 'run-export@1');
  assert.equal(body.run_reference, RUN_REFERENCE, 'the run reference is available before any accepted result exists');
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

test("a run's job outputs are found with one listing of its jobs, not one per file; a digest not found lists them again", async (t) => {
  const sha = (value: Buffer) => createHash('sha256').update(value).digest('hex');
  const files = Array.from({ length: 6 }, (_, i) => Buffer.from(`合成会话 ${i}\n`));
  const later = Buffer.from('合成：作业结束后才有的日志\n');
  const row = (item: string, file: Buffer) => ({ item, dynamic_terminal: 'pass', evidence: { log: `src:${sha(file)}` } });
  const job = { job: 'j1', verification_run: RUN, plan_run: 'run_01bbbbbbbbbbbbbbbbbbbbbbbb', items: [], sha256: 'c'.repeat(64), ended: 'done', outcome: 'effective', frozen: false, result: null, device_return: null, rows: files.map((file, i) => row(`case-${i}`, file)) };
  const d = deps(false) as unknown as { runs: Record<string, unknown>; records: { artifacts: Record<string, unknown> } };
  let listings = 0, rows = job.rows;
  d.runs.exportJobs = async (principal: { id: string }, run: string) => { listings++; return principal.id === 'u_runner' && run === RUN ? { run, jobs: [{ ...job, rows }] } : null; };
  const all = [...files, later];
  d.records.artifacts.source = async (_principal: unknown, wanted: string) => { const found = all.find((file) => sha(file) === wanted); return found ? { bytes: found } : null; };
  const s = await serve(d as unknown as ServerDeps); t.after(s.close);
  const get = (file: Buffer, token = 'runner-token') => fetch(`${s.origin}/run-export/${RUN}/sources/${sha(file)}`, { headers: { authorization: `Bearer ${token}` } });
  for (const file of files) { const answer = await get(file); assert.equal(answer.status, 200); assert.deepEqual(Buffer.from(await answer.arrayBuffer()), file); }
  assert.equal(listings, 1, 'six files of one run, one listing of its jobs');
  rows = [...job.rows, row('case-6', later)];
  const found = await get(later);
  assert.equal(found.status, 200, 'an output of a job that ended since is found at once'); assert.equal(listings, 2);
  assert.equal((await get(Buffer.from('合成：没有哪个作业返回过'))).status, 404); assert.equal(listings, 3);
  assert.equal((await get(files[0], 'other-token')).status, 404, 'a reader who may not export the run gets nothing from the kept digests');
});

test('the run\'s locked knowledge root comes as one batch, kept by the process and still asked for each reader\'s permission', async (t) => {
  // K05: a batch fetch of the subtree the run locked; D06 R[2]: lock the root, fetch the subtree, verify at delivery.
  const ROOT = 'a'.repeat(64), COMPOSITION = 'c'.repeat(64);
  const nodes = [
    { path: '/', reference: `tree:${ROOT}/`, name: '', level: 'trunk', digest: ROOT, children: [{ name: 'widgets', path: '/widgets', digest: 'b'.repeat(64) }], entries: [] },
    { path: '/widgets', reference: `tree:${ROOT}/widgets`, name: 'widgets', level: 'leaf', digest: 'b'.repeat(64), children: [], entries: [{ entry: 'e'.repeat(64), kind: 'definition', statement: '合成条目：widget health interval', reference: `tree:${ROOT}/widgets@${'e'.repeat(64)}`, data: { words: ['widget', 'health', 'interval'] } }] },
  ];
  const asked: Array<{ root: string; composition: string | null; reader: string }> = []; const checked: string[] = []; let readable = true;
  const d = deps();
  (d.runs as unknown as { exportRun: unknown }).exportRun = async (principal: { id: string }, run: string) => principal.id === 'u_runner' && run === RUN ? { run_reference: RUN_REFERENCE, accepted_result_reference: null, run: { run: RUN, root: ROOT, target_basis: [{ statement: { data: { root: ROOT, composition: COMPOSITION } } }], sources: [] }, result: null, submission: null } : null;
  (d as unknown as { knowledge: unknown }).knowledge = {
    subtree: async (query: { root: string; composition: string | null }, reader: { id: string }) => { asked.push({ root: query.root, composition: query.composition, reader: reader.id }); return readable ? nodes : null; },
    treeReader: () => ({ hasRoot: async (root: string, reader: { user: string }) => { checked.push(`${reader.user}:${root.slice(0, 4)}`); return readable; } }),
  };
  const s = await serve(d); t.after(s.close);
  const read = () => fetch(`${s.origin}/run-export/${RUN}/knowledge`, { headers: { authorization: 'Bearer runner-token' } });
  const first = await read();
  assert.equal(first.status, 200);
  assert.match(first.headers.get('content-type') ?? '', /^application\/x-ndjson/);
  const body = Buffer.from(await first.arrayBuffer());
  assert.equal(first.headers.get('content-digest'), `sha-256=:${createHash('sha256').update(body).digest('base64')}:`);
  const lines = body.toString('utf8').trimEnd().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(lines[0], { schema: 'run-knowledge@1', run: RUN, root: ROOT, composition: COMPOSITION, nodes: 2, entries: 1 });
  assert.deepEqual(lines.slice(1), nodes, 'each node as the subtree read gives it, in its order');
  assert.deepEqual(asked, [{ root: ROOT, composition: COMPOSITION, reader: 'u_runner' }], 'the composition the run locked for that root');
  // A second read of the same root is served from what the process kept, after the reader's permission is asked again.
  const again = await read();
  assert.deepEqual(Buffer.from(await again.arrayBuffer()), body);
  assert.equal(asked.length, 1);
  assert.deepEqual(checked, ['u_runner:aaaa']);
  readable = false;
  assert.equal((await read()).status, 404, 'a reader who lost the permission gets nothing of what is kept');
  // Other readers and unauthenticated requests are answered as for every export.
  assert.equal((await fetch(`${s.origin}/run-export/${RUN}/knowledge`, { headers: { authorization: 'Bearer other-token' } })).status, 404);
  assert.equal((await fetch(`${s.origin}/run-export/${RUN}/knowledge`)).status, 401);
  assert.equal((await fetch(`${s.origin}/run-export/${RUN}/knowledge/extra`, { headers: { authorization: 'Bearer runner-token' } })).status, 404);
});

test('a run that locked no root, or a Hub without the batch read, answers the knowledge route as absent', async (t) => {
  const s = await serve(deps()); t.after(s.close);
  assert.equal((await fetch(`${s.origin}/run-export/${RUN}/knowledge`, { headers: { authorization: 'Bearer runner-token' } })).status, 404);
});
