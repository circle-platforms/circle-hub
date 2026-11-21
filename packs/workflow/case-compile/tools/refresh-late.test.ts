// refresh-late: each time a case's recomposition is accepted (submitted alone in its recompose run), the plan run directory's late.json
// is rewritten from the Hub's late export (run-late@1) and that case gets its authoring brief; a case still waiting is listed with
// what it waits for. Synthetic Hub stub only.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { main } from './refresh-late.ts';
import { readLateFile } from '../functions/late.ts';
import { checkPlanObject } from './check-plan.ts';

const RUN = 'run_01aaaaaaaaaaaaaaaaaaaaaaaa', RECOMPOSE = 'run_01bbbbbbbbbbbbbbbbbbbbbbbb', TOKEN = 'synthetic-token-1234';
const ROOT = 'a'.repeat(64), ENTRY = 'e'.repeat(64);
const nodes = [
  { schema: 'run-knowledge@1', run: RUN, root: ROOT, composition: null, nodes: 2, entries: 1 },
  { path: '/', reference: `tree:${ROOT}/`, name: '', level: 'trunk', digest: ROOT, children: [{ name: 'widgets', path: '/widgets', digest: 'b'.repeat(64) }], entries: [] },
  { path: '/widgets', reference: `tree:${ROOT}/widgets`, name: 'widgets', level: 'leaf', digest: 'b'.repeat(64), children: [], entries: [{ entry: ENTRY, kind: 'definition', statement: 'widget health interval <seconds:int 1..60>', reference: `tree:${ROOT}/widgets@${ENTRY}`, data: {} }] },
];
const marker = (index: number) => ({ slot: 'recomposition_result', run: RECOMPOSE, source: 'src:' + 'a'.repeat(64), node: `n/case-${index}` });
const record = (index: number) => ({ case: { id: `99000000000000003${index}` }, atoms: [], ledgers: { adapted: [{ atom: 'a1', commands: [], equivalence_refs: [`tree:${ROOT}/widgets@${ENTRY}`] }] } });
const accepted = (index: number, digit: string) => ({ id: `case-${index}`, late: { recomposition: { record: record(index), receipt: 'rec:' + digit.repeat(64), late: true, record_sha256: digit.repeat(64) } } });
const waits = (index: number) => ({ id: `case-${index}`, late: { recomposition_problem: '合成：还没有已受理提交', recomposition_waiting: { run: RECOMPOSE, result: null, state: 'no_result', item: `recompose-item-${index}` } } });
const late = (items: unknown[]) => ({ schema: 'run-late@1', run: RUN, run_reference: 'rec:' + 'c'.repeat(64), resolved_at: '2026-11-17T00:00:00.000Z', late: { inputs: [{ slot: 'recomposition_result', run: RECOMPOSE, reference: 'rec:' + 'd'.repeat(64) }], refresh: 'f'.repeat(64) }, items });

async function runDirectory(): Promise<string> {
  const directory = join(await mkdtemp(join(tmpdir(), 'cc-refresh-late-')), 'run');
  await mkdir(join(directory, 'items'), { recursive: true }); await mkdir(join(directory, 'knowledge'));
  const items = [0, 1].map((index) => ({ id: `case-${index}`, label: `合成用例 ${index}`, fields: { title: `合成用例 ${index}`, recomposition_late: marker(index) } }));
  await writeFile(join(directory, 'run.json'), JSON.stringify({ run: RUN, items, groups: [] }));
  for (const [index, item] of items.entries()) await writeFile(join(directory, 'items', `0${index}.json`), JSON.stringify(item));
  await writeFile(join(directory, 'knowledge', 'nodes.jsonl'), nodes.map((line) => JSON.stringify(line)).join('\n') + '\n');
  return directory;
}
async function hub(answer: () => unknown | null) {
  const paths: string[] = [];
  const server = createServer((request, response) => {
    paths.push(request.url ?? '');
    if (request.headers.authorization !== `Bearer ${TOKEN}`) { response.statusCode = 401; response.end(); return; }
    const value = answer();
    if (request.url !== `/run-export/${RUN}/late` || value === null) { response.statusCode = 404; response.end('运行没有开运行后再绑定的输入\n'); return; }
    const bytes = Buffer.from(JSON.stringify(value));
    response.setHeader('content-digest', `sha-256=:${createHash('sha256').update(bytes).digest('base64')}:`); response.end(bytes);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`, paths, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}
async function outputOf(run: () => Promise<number>): Promise<{ code: number; stdout: string; stderr: string }> {
  const out: string[] = [], err: string[] = [];
  const stdout = process.stdout.write.bind(process.stdout), stderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array) => { out.push(String(chunk)); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => { err.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try { return { code: await run(), stdout: out.join(''), stderr: err.join('') }; } finally { process.stdout.write = stdout; process.stderr.write = stderr; }
}

test('each acceptance rewrites late.json whole and briefs the case just accepted; a waiting case is listed with what it waits for', async (t) => {
  const directory = await runDirectory();
  let current: unknown = late([waits(0), waits(1)]);
  const h = await hub(() => current); t.after(h.close);
  const refresh = () => outputOf(() => main(['--hub', h.url, '--run', RUN, '--dir', directory], async () => TOKEN));
  const first = await refresh();
  assert.equal(first.code, 0, first.stderr);
  assert.deepEqual(JSON.parse(first.stdout).waiting.map((row: { item: string; state: string }) => [row.item, row.state]), [['case-0', 'no_result'], ['case-1', 'no_result']]);
  assert.deepEqual(readLateFile(directory, RUN), current);
  await assert.rejects(readdir(join(directory, 'briefs')), 'no case is accepted, so nothing is briefed');
  // The first case is accepted alone in its recompose run.
  current = late([accepted(0, '1'), waits(1)]);
  const second = await refresh();
  const report = JSON.parse(second.stdout);
  assert.deepEqual([second.code, report.accepted, report.newly_accepted, report.briefs, report.waiting.length], [0, 1, ['case-0'], 1, 1]);
  assert.deepEqual(await readdir(join(directory, 'briefs')), ['00.md']);
  assert.ok((await readFile(join(directory, 'briefs', '00.md'), 'utf8')).includes(`"record_sha256": "${'1'.repeat(64)}"`), 'the envelope names the record by its digest');
  assert.deepEqual(readLateFile(directory, RUN), current, 'late.json is the answer as it came');
  // The second case is accepted; the first case's record is accepted again, different: it is said, and its brief is left as it is.
  current = late([accepted(0, '2'), accepted(1, '3')]);
  const third = JSON.parse((await refresh()).stdout);
  assert.deepEqual([third.newly_accepted, third.changed, third.briefs], [['case-1'], ['case-0'], 1]);
  assert.deepEqual(await readdir(join(directory, 'briefs')), ['00.md', '01.md']);
  assert.deepEqual((await readdir(directory)).filter((name) => name.endsWith('.tmp')), [], 'no staged file is left behind');
});

test('a run without late inputs writes nothing; another run\'s directory, a bad run id and an answer of another run are refused', async (t) => {
  const directory = await runDirectory();
  let current: unknown = null;
  const h = await hub(() => current); t.after(h.close);
  const none = await outputOf(() => main(['--hub', h.url, '--run', RUN, '--dir', directory], async () => TOKEN));
  assert.equal(none.code, 0, none.stderr);
  assert.equal(JSON.parse(none.stdout).late, false);
  await assert.rejects(readFile(join(directory, 'late.json')));
  const other = await outputOf(() => main(['--hub', h.url, '--run', 'run_01zzzzzzzzzzzzzzzzzzzzzzzz', '--dir', directory], async () => TOKEN));
  assert.equal(other.code, 1); assert.match(other.stderr, /run\.json 是运行 run_01aaaaaaaaaaaaaaaaaaaaaaaa 的，不是 --run 的/);
  assert.equal((await outputOf(() => main(['--hub', h.url, '--run', 'not-a-run', '--dir', directory], async () => TOKEN))).code, 1);
  current = { ...late([]), run: 'run_01zzzzzzzzzzzzzzzzzzzzzzzz' };
  const forged = await outputOf(() => main(['--hub', h.url, '--run', RUN, '--dir', directory], async () => TOKEN));
  assert.equal(forged.code, 1); assert.match(forged.stderr, /不是运行 run_01aaaaaaaaaaaaaaaaaaaaaaaa 的 run-late@1 答复/);
  await assert.rejects(readFile(join(directory, 'late.json')), 'nothing was written');
  const missing = await outputOf(() => main(['--hub', h.url, '--run', RUN, '--dir', join(directory, 'items')], async () => TOKEN));
  assert.equal(missing.code, 1); assert.match(missing.stderr, /没有 run\.json/);
});

test('check-plan without late.json says the late record cannot be judged here and where to get it', () => {
  const run = { run: RUN, pack: 'case-compile', items: [{ id: 'case-0', fields: { recomposition_late: marker(0) } }], groups: [{ kind: 'case-compile' }] };
  const plan = { item: 'case-0', handling: 'handled', slots: { plan: [{ text: '合成', quotes: [], data: { bucket: 'bed-a', blocks: [], steps: [{ object: 'o', method: 'm', args: [], keywords: {} }], expects: [], replacements: [] } }] } };
  const without = checkPlanObject('plan.json', plan, run);
  const problem = without.problems.find((row) => row.pointer === '/run/late.json');
  assert.ok(problem, JSON.stringify(without.problems));
  for (const part of ['late.json', '没有这个文件', 'refresh-late.ts', RECOMPOSE, '下一步']) assert.ok(problem.message.includes(part), part);
  assert.equal(checkPlanObject('plan.json', plan, run, undefined, late([waits(0)]) as never).problems.some((row) => row.pointer === '/run/late.json'), false);
});
