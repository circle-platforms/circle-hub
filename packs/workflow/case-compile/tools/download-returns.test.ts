// The device's own words on local disk for the delivery notes (decision 164), against a synthetic Hub stub only.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { sha256 } from '../functions/generated/skills/run-tools/hub-client/index.ts';
import { main, POLL_MS, UNDISPATCHED_MS, type Timing } from './download-returns.ts';

const TOKEN = 'synthetic-token-1234', RUN = 'run_01aaaaaaaaaaaaaaaaaaaaaaaa', PLAN = 'run_01bbbbbbbbbbbbbbbbbbbbbbbb';
const text = (s: string) => Buffer.from(s);
const deviceReturn = text('作业的设备返回。逐条结论：\n990000000000000301：失败\n'), log = text('合成日志：第 2 步断言没有命中\n');
const session = text('seat# configure widget\nFailed to run the synthetic command\nseat#\n'), held = text('合成会话：被扣住的一段\n');
const ref = (bytes: Uint8Array) => `src:${sha256(bytes)}`;
function jobs(sessionBytes: Uint8Array = session) {
  return { schema: 'run-jobs@1', run: RUN, jobs: [{ job: 'c'.repeat(64), verification_run: RUN, plan_run: PLAN, items: ['990000000000000301', '990000000000000302'], sha256: 'd'.repeat(64), ended: 'done', outcome: 'effective', frozen: false, result: `src:${'9'.repeat(64)}`, device_return: ref(deviceReturn),
    rows: [{ item: '990000000000000301', dynamic_terminal: 'fail', evidence: { log: ref(log), sessions: { 'dev-a.txt': ref(sessionBytes), '../escape.txt': ref(held) } } }, { item: '990000000000000302', dynamic_terminal: 'pass' }] }] };
}
async function hub(answer: unknown, served: Uint8Array[], forbidden: Uint8Array[] = []) {
  const bytes = new Map(served.map((b) => [sha256(b), b])), denied = new Set(forbidden.map((b) => sha256(b)));
  const server = createServer((request, response) => {
    if (request.headers.authorization !== `Bearer ${TOKEN}`) { response.statusCode = 401; response.end(); return; }
    const url = request.url ?? '';
    if (url === `/run-export/${RUN}/jobs`) {
      // A function answers each read in turn (a job that ends while it is waited for); null stands for the Hub being unavailable once.
      const now = typeof answer === 'function' ? (answer as () => unknown)() : answer;
      if (now === null) { response.statusCode = 503; response.end('稍后\n'); return; }
      response.end(JSON.stringify(now)); return;
    }
    const source = /^\/run-export\/run_\w+\/sources\/([0-9a-f]{64})$/.exec(url);
    if (source && denied.has(source[1])) { response.statusCode = 403; response.end('不给\n'); return; }
    if (source && bytes.has(source[1])) { response.end(bytes.get(source[1])); return; }
    response.statusCode = 404; response.end('没有\n');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}/mcp`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}
/** A clock the test moves: every pause advances it by the time asked for and is recorded. */
function clock(): Timing & { pauses: number[] } { let at = 0; const pauses: number[] = []; return { pauses, now: () => at, pause: async (ms) => { pauses.push(ms); at += ms; } }; }
async function run(url: string, out: string, extra: string[] = [], timing?: Timing) {
  const err: string[] = [], outText: string[] = [];
  const stderr = process.stderr.write.bind(process.stderr), stdout = process.stdout.write.bind(process.stdout);
  process.stderr.write = ((chunk: string | Uint8Array) => { err.push(String(chunk)); return true; }) as typeof process.stderr.write;
  process.stdout.write = ((chunk: string | Uint8Array) => { outText.push(String(chunk)); return true; }) as typeof process.stdout.write;
  try { return { code: await main(['--hub', url, '--run', RUN, '--out', out, ...extra], async () => TOKEN, timing), stderr: err.join(''), stdout: outText.join('') }; }
  finally { process.stderr.write = stderr; process.stdout.write = stdout; }
}

test('the device return, every saved log and session land as checked files; a withheld piece is named, an odd session name is not a path', async (t) => {
  const h = await hub(jobs(), [deviceReturn, log, session], [held]); t.after(h.close);
  const out = join(await mkdtemp(join(tmpdir(), 'cc-returns-')), 'returns');
  const done = await run(h.url, out);
  assert.equal(done.code, 0, done.stderr);
  const folder = join(out, 'c'.repeat(12));
  assert.deepEqual(await readFile(join(folder, 'device-return.txt')), deviceReturn);
  assert.deepEqual(await readFile(join(folder, 'cases', '990000000000000301', 'log.txt')), log);
  assert.deepEqual(await readFile(join(folder, 'cases', '990000000000000301', 'dev-a.txt')), session);
  const index = JSON.parse(await readFile(join(out, 'index.json'), 'utf8'));
  assert.deepEqual(index.jobs[0].rows.map((r: { item: string; verdict: string }) => [r.item, r.verdict]), [['990000000000000301', 'fail'], ['990000000000000302', 'pass']]);
  assert.deepEqual(index.jobs[0].rows[0].sessions, { 'dev-a.txt': join('c'.repeat(12), 'cases', '990000000000000301', 'dev-a.txt'), '../escape.txt': null });
  assert.equal(index.withheld.length, 1);
  assert.match(index.withheld[0], /session-2\.txt（[0-9a-f]{12}，Hub 的读取规则不给原文）/);
  assert.equal(JSON.parse(done.stdout).withheld.length, 1);
  assert.deepEqual(index.jobs[0].rows[0].syntax_rejected, [], 'sessions read, no lone caret in them');
  assert.equal('syntax_rejected' in index.jobs[0].rows[1], false, 'a row without sessions has nothing to read');
});

test('a command the device answered with a lone caret is listed for its row with the session, the word under the caret and the prompt', async (t) => {
  const refused = text('seat(config)#exit\n\nseat#widget sync to peer-b\n\nwidget sync to peer-b \n^\nseat#\n');
  const h = await hub(jobs(refused), [deviceReturn, log, refused, held]); t.after(h.close);
  const out = join(await mkdtemp(join(tmpdir(), 'cc-returns-')), 'returns');
  const done = await run(h.url, out);
  assert.equal(done.code, 0, done.stderr);
  const index = JSON.parse(await readFile(join(out, 'index.json'), 'utf8'));
  assert.deepEqual(index.jobs[0].rows[0].syntax_rejected, [{ session: 'dev-a.txt', command: 'widget sync to peer-b', token: 'widget', prompt: 'seat#' }]);
  assert.equal(JSON.parse(done.stdout).syntax_rejected, 1);
  assert.deepEqual(await readFile(join(out, 'c'.repeat(12), 'cases', '990000000000000301', 'dev-a.txt')), refused, 'the session itself is written word for word');
});

test('bytes that do not match their digest, a run never dispatched and a directory already in use write nothing', async (t) => {
  const forged = await hub(jobs(text('forged session')), [deviceReturn, log, session]); t.after(forged.close);
  const dir = await mkdtemp(join(tmpdir(), 'cc-returns-'));
  const wrong = await run(forged.url, join(dir, 'a'));
  assert.equal(wrong.code, 1);
  const none = await hub({ schema: 'run-jobs@1', run: RUN, jobs: [] }, []); t.after(none.close);
  assert.match((await run(none.url, join(dir, 'b'))).stderr, /没有派发过/);
  const used = join(dir, 'c'); await writeFile(join(dir, 'c-marker'), 'x');
  const fine = await hub(jobs(), [deviceReturn, log, session, held]); t.after(fine.close);
  await run(fine.url, used);
  assert.match((await run(fine.url, used)).stderr, /已有文件/, 'a second download into the same directory is refused');
});

// The wait is the program's (the reference engine's run tool returns when the bed has finished): started in the background, the
// tool exits when the job has ended and the client tells the model, which neither sleeps nor repeats the submission.
const running = () => { const answer = jobs(); return { ...answer, jobs: answer.jobs.map((job) => ({ ...job, ended: null, rows: null, device_return: null })) }; };
const undispatched = { schema: 'run-jobs@1', run: RUN, jobs: [] };

test('--wait reads the job list until every job of the run has ended, through a failed read, and then writes the returns', async (t) => {
  const answers: unknown[] = [running(), null, running(), jobs()];
  const h = await hub(() => answers.length > 1 ? answers.shift() : answers[0], [deviceReturn, log, session, held]); t.after(h.close);
  const out = join(await mkdtemp(join(tmpdir(), 'cc-returns-')), 'returns'), time = clock();
  const done = await run(h.url, out, ['--wait', '3600'], time);
  assert.equal(done.code, 0, done.stderr);
  assert.deepEqual(time.pauses, [POLL_MS, POLL_MS, POLL_MS], 'one read per interval; the read the Hub failed is tried again');
  assert.match(done.stderr, /等运行 run_01a+ 的作业结束，最多 3600 秒/);
  const summary = JSON.parse(done.stdout);
  assert.deepEqual([summary.jobs, summary.ended, summary.verdicts], [1, ['done'], { fail: 1, pass: 1 }]);
  assert.deepEqual(await readFile(join(out, 'c'.repeat(12), 'device-return.txt')), deviceReturn);
  assert.equal(JSON.parse(await readFile(join(out, 'jobs.json'), 'utf8')).jobs[0].ended, 'done', 'the answer saved is the one that showed the end');
});

test('--wait gives up at its limit, and sooner when the run shows no job at all, writing nothing; its value is a number of seconds', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cc-returns-'));
  const never = await hub(running, []); t.after(never.close);
  const late = clock(), slow = await run(never.url, join(dir, 'a'), ['--wait', '50'], late);
  assert.equal(slow.code, 1);
  assert.match(slow.stderr, /等了 50 秒，运行 run_01a+ 的作业还没有结束；什么都没有写入，用同一命令再等一次/);
  assert.deepEqual(late.pauses, [POLL_MS, POLL_MS, 10_000], 'the last pause ends at the limit');
  const none = await hub(undispatched, []); t.after(none.close);
  const idle = clock(), absent = await run(none.url, join(dir, 'b'), ['--wait', '3600'], idle);
  assert.equal(absent.code, 1);
  assert.match(absent.stderr, /到现在没有作业：它可能没有派发。原样重交那次提交，读 Hub 答复里的派发说明/);
  assert.equal(idle.pauses.reduce((sum, ms) => sum + ms, 0), UNDISPATCHED_MS);
  await assert.rejects(readFile(join(dir, 'a', 'index.json')));
  for (const value of ['0', 'abc', '86401', '-5']) assert.match((await run(never.url, join(dir, 'c'), ['--wait', value], clock())).stderr, /--wait 写最多等多少秒/, value);
  assert.match((await run(never.url, join(dir, 'c'), ['--poll', '1'], clock())).stderr, /参数写法/);
  // Without --wait a run that was never dispatched is refused at once, as before.
  assert.match((await run(none.url, join(dir, 'd'))).stderr, /没有派发过/);
});
