// The device's own words on local disk for the delivery notes (decision 164), against a synthetic Hub stub only.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { sha256 } from '../functions/generated/skills/run-tools/hub-client/index.ts';
import { CONTRACT_DOC, MANIFEST_DOC, PROFILE_DOC } from '../functions/test-support.ts';
import { planRunFixture } from '../testing/plan-run.ts';
import { signTypedRuntime } from '../testing/typed-fixtures.ts';
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
async function hub(answer: unknown, served: Uint8Array[], forbidden: Uint8Array[] = [], plan?: { record: unknown; result: unknown; submission: unknown }) {
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
    if (plan && url === `/run-export/${PLAN}`) { response.end(JSON.stringify({ schema: 'run-export@1', run: plan.record, result: plan.result, submission: plan.submission })); return; }
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
async function run(url: string, out: string, extra: string[] = [], timing?: Timing, retry?: Parameters<typeof main>[3]) {
  const err: string[] = [], outText: string[] = [];
  const stderr = process.stderr.write.bind(process.stderr), stdout = process.stdout.write.bind(process.stdout);
  process.stderr.write = ((chunk: string | Uint8Array) => { err.push(String(chunk)); return true; }) as typeof process.stderr.write;
  process.stdout.write = ((chunk: string | Uint8Array) => { outText.push(String(chunk)); return true; }) as typeof process.stdout.write;
  try { return { code: await main(['--hub', url, '--run', RUN, '--out', out, ...extra], async () => TOKEN, timing, retry), stderr: err.join(''), stdout: outText.join('') }; }
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
  assert.match(index.withheld[0], /session-2\.txt，没有读取这份设备输出的权限/);
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

test('a pass whose run log carries a declared execution-failure line its assertions do not read is listed as no verdict when the returns are read', async (t) => {
  // InfoTest tools/device/batch_tools.py downgrades such a pass when it reads the verdict (broken, subtype errored) and the case
  // goes back to its author; here the model sees it with the returns instead of at the delivery.
  const doc = structuredClone(CONTRACT_DOC) as Record<string, unknown>;
  doc.exec_failure_markers = { source: 'reference-engine/domain_grammar.json', sha256: 'a'.repeat(64), lines: ['Failed to run the synthetic command'] };
  const contract = text(JSON.stringify(signTypedRuntime(doc))), profile = text(JSON.stringify(PROFILE_DOC)), inventory = text(JSON.stringify(MANIFEST_DOC));
  const items = ['990000000000000301', '990000000000000302', '990000000000000303', '990000000000000304'];
  const plan = planRunFixture({ run: PLAN, autoids: items, exclude: [], contract, profile, inventory, predecessor: 'run_01zzzzzzzzzzzzzzzzzzzzzzzz', recomposed: `rec:${'7'.repeat(64)}` });
  const clean = text('seat# configure widget\nseat#\n'), unread = text('seat# configure widget\nFailed to run the synthetic command\nseat#\n');
  const read = text('seat# configure widget\n健康检查间隔设置成功 Failed to run the synthetic command\nseat#\n');
  const answer = jobs(); answer.jobs[0].items = items;
  answer.jobs[0].rows = [
    { item: items[0], dynamic_terminal: 'pass', evidence: { log: ref(clean) } }, { item: items[1], dynamic_terminal: 'pass', evidence: { log: ref(unread) } },
    { item: items[2], dynamic_terminal: 'pass', evidence: { log: ref(read) } }, { item: items[3], dynamic_terminal: 'pass' },
  ] as typeof answer.jobs[0]['rows'];
  const h = await hub(answer, [deviceReturn, clean, unread, read, contract, profile, inventory], [], plan); t.after(h.close);
  const out = join(await mkdtemp(join(tmpdir(), 'cc-returns-')), 'returns');
  const done = await run(h.url, out);
  assert.equal(done.code, 0, done.stderr);
  const index = JSON.parse(await readFile(join(out, 'index.json'), 'utf8'));
  assert.deepEqual(index.jobs[0].rows.map((r: { verdict: string }) => r.verdict), ['pass', 'no_verdict', 'pass', 'pass'], 'the line inside an assertion text of the case is read by it; a pass without a saved log is not reviewed');
  assert.deepEqual([index.jobs[0].rows[1].runner_verdict, index.jobs[0].rows[1].pass_review], ['pass', { where: '运行日志', line: 'Failed to run the synthetic command' }]);
  assert.equal('pass_review' in index.jobs[0].rows[0], false);
  const reviewed = { markers: 1, read: 3, downgraded: 1, wordless: 1, unread: [] };
  assert.deepEqual(index.pass_review, reviewed);
  const summary = JSON.parse(done.stdout);
  assert.deepEqual([summary.verdicts, summary.pass_review], [{ pass: 3, no_verdict: 1 }, reviewed]);
  assert.deepEqual(await readFile(join(out, 'c'.repeat(12), 'cases', items[1], 'log.txt')), unread, 'the log itself is written word for word');

  // A plan run that cannot be read leaves the passes as the runner reported them and says they were not reviewed.
  const blind = await hub(answer, [deviceReturn, clean, unread, read]); t.after(blind.close);
  const other = join(await mkdtemp(join(tmpdir(), 'cc-returns-')), 'returns');
  const kept = await run(blind.url, other);
  assert.equal(kept.code, 0, kept.stderr);
  const unreviewed = JSON.parse(kept.stdout);
  assert.deepEqual(unreviewed.verdicts, { pass: 4 });
  assert.deepEqual([unreviewed.pass_review.markers, unreviewed.pass_review.read, unreviewed.pass_review.unread.length], [null, 0, 1]);
  assert.match(unreviewed.pass_review.unread[0], /^缺少执行器规则或自动化用例，尚未核对设备输出，也未列出被设备拒绝执行的命令$/);
});

test('a command the device refused to execute is listed for its row with the session, the prompt and the device’s reply up to the declared line', async (t) => {
  // The reference hands the next writer the lines of the last run that carry a device CLI error, with the directive that the
  // fault is in the case's own command sequence (compile_engine/briefs.py execution_failures); the lines are the ones the
  // plan run's contract declares, the same the pass review reads.
  const doc = structuredClone(CONTRACT_DOC) as Record<string, unknown>;
  doc.exec_failure_markers = { source: 'reference-engine/domain_grammar.json', sha256: 'a'.repeat(64), lines: ['Failed to run the synthetic command'] };
  const contract = text(JSON.stringify(signTypedRuntime(doc))), profile = text(JSON.stringify(PROFILE_DOC)), inventory = text(JSON.stringify(MANIFEST_DOC));
  const plan = planRunFixture({ run: PLAN, autoids: ['990000000000000301', '990000000000000302'], exclude: [], contract, profile, inventory, predecessor: 'run_01zzzzzzzzzzzzzzzzzzzzzzzz', recomposed: `rec:${'7'.repeat(64)}` });
  const refused = text('seat(config)#widget name "a_b:c" 60\n\nWidget name format error.\nFailed to run the synthetic command\n\nseat(config)#widget on\nseat(config)#\n');
  const h = await hub(jobs(refused), [deviceReturn, log, refused, held, contract, profile, inventory], [], plan); t.after(h.close);
  const out = join(await mkdtemp(join(tmpdir(), 'cc-returns-')), 'returns');
  const done = await run(h.url, out);
  assert.equal(done.code, 0, done.stderr);
  const index = JSON.parse(await readFile(join(out, 'index.json'), 'utf8'));
  assert.deepEqual(index.jobs[0].rows[0].execution_refused, [{ session: 'dev-a.txt', command: 'widget name "a_b:c" 60', prompt: 'seat(config)#', reply: ['Widget name format error.', 'Failed to run the synthetic command'] }]);
  assert.deepEqual(index.jobs[0].rows[0].syntax_rejected, [], 'no caret: the device parsed the command and refused to execute it');
  assert.equal('execution_refused' in index.jobs[0].rows[1], false, 'a row without sessions lists nothing');
  assert.equal(JSON.parse(done.stdout).execution_refused, 1);

  // Without the plan run's contract the declared lines are unknown: nothing is listed, and the returns say so.
  const blind = await hub(jobs(refused), [deviceReturn, log, refused, held]); t.after(blind.close);
  const other = join(await mkdtemp(join(tmpdir(), 'cc-returns-')), 'returns');
  const kept = await run(blind.url, other);
  assert.equal(kept.code, 0, kept.stderr);
  const unlisted = JSON.parse(await readFile(join(other, 'index.json'), 'utf8'));
  assert.equal('execution_refused' in unlisted.jobs[0].rows[0], false);
  assert.deepEqual(unlisted.jobs[0].rows[0].syntax_rejected, []);
  assert.match(unlisted.pass_review.unread[0], /也未列出被设备拒绝执行的命令$/);

  // Only a literal failure line explicitly published by this contract makes these replies execution refusals.
  // Generic Error/Failed words and warning lines do not supply an undeclared failure rule.
  const batch2Session = text([
    'seat(config)#widget peer r1 192.0.2.71',
    'Warning: For security consideration, please set a challenge code.',
    'seat(config)#widget sync to r1',
    '',
    'checking version and licenses....',
    'Error: Wrong peer configurations or the challenge codes on the peers are mismatched.',
    'Failed to synchronize configuration to 192.0.2.71.',
    '',
    'seat(config)#widget sync rollback r1',
    '',
    'checking version and licenses....',
    'Error: Wrong peer configurations or the challenge codes on the peers are mismatched.',
    'Failed to synchronize configuration to 192.0.2.71.',
    'seat(config)#',
  ].join('\n'));
  const batch2Doc = structuredClone(doc);
  batch2Doc.exec_failure_markers = { source: 'synthetic/domain-rules.json', sha256: 'a'.repeat(64), lines: ['Failed to synchronize configuration to 192.0.2.71.'] };
  const batch2Contract = text(JSON.stringify(signTypedRuntime(batch2Doc)));
  const batch2Plan = planRunFixture({ run: PLAN, autoids: ['990000000000000301', '990000000000000302'], exclude: [], contract: batch2Contract, profile, inventory, predecessor: 'run_01zzzzzzzzzzzzzzzzzzzzzzzz', recomposed: `rec:${'7'.repeat(64)}` });
  const b2Hub = await hub(jobs(batch2Session), [deviceReturn, log, batch2Session, held, batch2Contract, profile, inventory], [], batch2Plan);
  t.after(b2Hub.close);
  const b2Out = join(await mkdtemp(join(tmpdir(), 'cc-returns-b2-')), 'returns');
  const b2Done = await run(b2Hub.url, b2Out);
  assert.equal(b2Done.code, 0, b2Done.stderr);
  const b2Index = JSON.parse(await readFile(join(b2Out, 'index.json'), 'utf8'));
  assert.deepEqual(b2Index.jobs[0].rows[0].execution_refused, [
    {
      session: 'dev-a.txt',
      command: 'widget sync to r1',
      prompt: 'seat(config)#',
      reply: [
        'checking version and licenses....',
        'Error: Wrong peer configurations or the challenge codes on the peers are mismatched.',
        'Failed to synchronize configuration to 192.0.2.71.',
      ],
    },
    {
      session: 'dev-a.txt',
      command: 'widget sync rollback r1',
      prompt: 'seat(config)#',
      reply: [
        'checking version and licenses....',
        'Error: Wrong peer configurations or the challenge codes on the peers are mismatched.',
        'Failed to synchronize configuration to 192.0.2.71.',
      ],
    },
  ]);
  assert.deepEqual(b2Index.jobs[0].rows[0].syntax_rejected, []);
  assert.equal(JSON.parse(b2Done.stdout).execution_refused, 2);
  assert.deepEqual(await readFile(join(b2Out, 'c'.repeat(12), 'cases', '990000000000000301', 'log.txt')), log);
  const unrelated = await hub(jobs(batch2Session), [deviceReturn, log, batch2Session, held, contract, profile, inventory], [], plan); t.after(unrelated.close);
  const unrelatedOut = join(await mkdtemp(join(tmpdir(), 'cc-returns-unrelated-marker-')), 'returns');
  const unrelatedDone = await run(unrelated.url, unrelatedOut); assert.equal(unrelatedDone.code, 0, unrelatedDone.stderr);
  const unrelatedIndex = JSON.parse(await readFile(join(unrelatedOut, 'index.json'), 'utf8'));
  assert.deepEqual(unrelatedIndex.jobs[0].rows[0].execution_refused, [], 'the same generic Error/Failed text does not match an unrelated declared marker');
  const noMarkerContract = text(JSON.stringify(signTypedRuntime(CONTRACT_DOC)));
  const noMarkerPlan = planRunFixture({ run: PLAN, autoids: ['990000000000000301', '990000000000000302'], exclude: [], contract: noMarkerContract, profile, inventory, predecessor: 'run_01zzzzzzzzzzzzzzzzzzzzzzzz', recomposed: `rec:${'7'.repeat(64)}` });
  const undeclared = await hub(jobs(batch2Session), [deviceReturn, log, batch2Session, held, noMarkerContract, profile, inventory], [], noMarkerPlan); t.after(undeclared.close);
  const undeclaredOut = join(await mkdtemp(join(tmpdir(), 'cc-returns-no-marker-')), 'returns');
  const undeclaredDone = await run(undeclared.url, undeclaredOut); assert.equal(undeclaredDone.code, 0, undeclaredDone.stderr);
  const undeclaredIndex = JSON.parse(await readFile(join(undeclaredOut, 'index.json'), 'utf8'));
  assert.equal('execution_refused' in undeclaredIndex.jobs[0].rows[0], false, 'missing rules stay undeclared rather than becoming an empty verified execution result');
  assert.deepEqual(undeclaredIndex.jobs[0].rows[0].execution_refused ?? [], []);
  assert.equal(undeclaredIndex.pass_review.markers, null);
  assert.equal(JSON.parse(undeclaredDone.stdout).execution_refused, 0);
});

test('bytes that do not match their digest, a run never dispatched and a directory already in use write nothing', async (t) => {
  const forged = await hub(jobs(text('forged session')), [deviceReturn, log, session]); t.after(forged.close);
  const dir = await mkdtemp(join(tmpdir(), 'cc-returns-'));
  const wrong = await run(forged.url, join(dir, 'a'));
  assert.equal(wrong.code, 1);
  const none = await hub({ schema: 'run-jobs@1', run: RUN, jobs: [] }, []); t.after(none.close);
  assert.match((await run(none.url, join(dir, 'b'))).stderr, /尚未开始上机验证/);
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
  assert.match(done.stderr, /等待上机验证结束，最多 3600 秒/);
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
  assert.match(slow.stderr, /等了 50 秒，上机验证还没有结束，设备输出尚未保存。用同一命令继续等待/);
  assert.deepEqual(late.pauses, [POLL_MS, POLL_MS, 10_000], 'the last pause ends at the limit');
  const none = await hub(undispatched, []); t.after(none.close);
  const idle = clock(), absent = await run(none.url, join(dir, 'b'), ['--wait', '3600'], idle);
  assert.equal(absent.code, 1);
  assert.match(absent.stderr, /尚未开始上机验证，设备输出尚未保存。原样再做一次脚本合并，查看 Hub 的上机验证说明/);
  assert.equal(idle.pauses.reduce((sum, ms) => sum + ms, 0), UNDISPATCHED_MS);
  await assert.rejects(readFile(join(dir, 'a', 'index.json')));
  for (const value of ['0', 'abc', '86401', '-5']) assert.match((await run(never.url, join(dir, 'c'), ['--wait', value], clock())).stderr, /--wait 不在允许范围内。填写 1 到 86400 的整数秒数后重试/, value);
  assert.match((await run(never.url, join(dir, 'c'), ['--poll', '1'], clock())).stderr, /参数缺值、重复或未声明。使用 --hub/);
  // Without --wait a run that was never dispatched is refused at once, as before.
  assert.match((await run(none.url, join(dir, 'd'))).stderr, /尚未开始上机验证/);
});

test('download-returns retries 503 Retry-After and ECONNREFUSED on reads, honors Retry-After in --wait, and reports waited time and attempts', async (t) => {
  const h = await hub(jobs(), [deviceReturn, log, session, held]); t.after(h.close);
  let calls = 0;
  const t1 = clock();
  const out1 = join(await mkdtemp(join(tmpdir(), 'cc-returns-retry-')), 'ok');
  const r1 = await run(h.url, out1, [], t1, {
    fetch: async (input, init) => {
      calls++;
      if (calls === 1) return new Response('重启中', { status: 503, headers: { 'retry-after': '5' } });
      if (calls === 2) throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
      return globalThis.fetch(input, init);
    },
  });
  assert.equal(r1.code, 0, r1.stderr);
  assert.deepEqual(t1.pauses, [5_000, 2_000]);
  assert.deepEqual(await readFile(join(out1, 'c'.repeat(12), 'device-return.txt')), deviceReturn);

  // Inside --wait, 503 Retry-After: 5 uses 5_000ms instead of POLL_MS, and if Hub remains unreachable/503 when --wait runs out, error reports waited duration & attempts.
  let pollStep = 0;
  const t2 = clock();
  const out2 = join(await mkdtemp(join(tmpdir(), 'cc-returns-wait-retry-')), 'ok');
  const r2 = await run(h.url, out2, ['--wait', '60'], t2, {
    fetch: async (input, init) => {
      pollStep++;
      if (pollStep === 1) return new Response(JSON.stringify(running()), { status: 200 });
      if (pollStep === 2) return new Response('过载', { status: 503, headers: { 'retry-after': '5' } });
      return globalThis.fetch(input, init);
    },
  });
  assert.equal(r2.code, 0, r2.stderr);
  assert.deepEqual(t2.pauses, [POLL_MS, 5_000]);

  const t3 = clock();
  const out3 = join(await mkdtemp(join(tmpdir(), 'cc-returns-wait-fail-')), 'out');
  const r3 = await run(h.url, out3, ['--wait', '12'], t3, {
    fetch: async () => new Response('Hub 繁忙', { status: 503 }),
  });
  assert.equal(r3.code, 1);
  assert.match(r3.stderr, /^暂时不可用：Hub 答复 503：Hub 繁忙，已等待 12 秒并尝试 4 次仍未恢复。请.*。$/m);
  await assert.rejects(readFile(join(out3, 'index.json')));
});
