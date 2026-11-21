import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { main, recordFor, submissionFor } from './submit-records.ts';

const atom = (id: string, kind: string, text: string, after: string[] = []) => ({ id, kind, text, content: text, reference: `src:${'a'.repeat(64)}/kityminder@1/n/${id}`, selector: `n/${id}`, node_id: id, start: 0, end: text.length, labels: [], explicit_labels: [], number_label: null, after });
const item = (id = 'n/case') => ({ id, fields: { case_id: 'ORBIT-1', source_ref: 'src:' + 'a'.repeat(64), node: 'n/case', atoms: [atom('a1', 'action', '合成动作一'), atom('a2', 'action', '合成动作二'), atom('a3', 'expectation', '合成期望', ['a2'])] } });
const method = { kind: 'declared', text: '合成方法', sources: ['ref'], basis: '合成依据' };

test('the tool fills what the projection knows, so the model never retypes author text', () => {
  const record = recordFor(item(), { method }, 'scripted');
  assert.deepEqual(record.atoms.map((a: any) => a.text), ['合成动作一', '合成动作二', '合成期望']);
  assert.deepEqual(record.ledgers.original.map((a: any) => a.atom), ['a1', 'a2', 'a3']);
  assert.deepEqual(record.contract.intent, { text: '合成动作一', quote_ref: atom('a1', 'action', '').reference, verbatim: true });
  assert.equal(record.contract.expectation.text, '合成期望');
  assert.deepEqual(record.coverage, { author_atoms: ['a1', 'a2', 'a3'], mapped: { a2: ['e1'], a3: ['e1'] }, unmapped: ['a1'] });
  assert.deepEqual(record.expectation_slots.map((s: any) => [s.slot, s.atom, s.knowledge_location]), [['e1', 'a3', 'has_verification_knowledge']]);
  assert.deepEqual(record.sources.states.map((s: any) => s.state), ['settled', 'settled', 'settled']);
  assert.equal(record.status, 'complete');
});

test('what the model judged replaces only the atom it names', () => {
  const record = recordFor(item(), { method, states: [{ atom: 'a2', state: 'missing_prerequisite', reason: '功能默认关闭', prerequisites: ['先打开'] }], slots: [{ atom: 'a3', knowledge_location: 'genuinely_missing', proposal: '只有结果标签' }], unknowns: [{ missing: 'x', next_action: 'y', audience: 'z', due: 'w' }] }, 'scripted');
  assert.deepEqual(record.sources.states.map((s: any) => s.state), ['settled', 'missing_prerequisite', 'settled']);
  assert.equal(record.sources.states[1].exit.owner, '编写模型');
  assert.deepEqual(record.sources.states[1].prerequisites, ['先打开']);
  assert.equal(record.expectation_slots[0].knowledge_location, 'genuinely_missing');
  assert.equal(record.expectation_slots[0].slot, 'e1');
  assert.equal(record.unknowns.length, 1);
});

test('a candidate never signs, and an atom the case does not have is refused', () => {
  assert.equal(recordFor(item(), { method, candidates: [{ ref: 'x', signing_authority: true }] }, 'scripted').sources.candidates[0].signing_authority, false);
  assert.throws(() => recordFor(item(), { method, states: [{ atom: 'a9', state: 'conflict' }] }, 'scripted'), /没有这条原句/);
  assert.throws(() => recordFor(item(), { method, slots: [{ atom: 'a1' }] }, 'scripted'), /期望不是这条原始用例的原句/);
  assert.throws(() => recordFor(item(), {}, 'scripted'), /缺少用例重组的方法/);
});

test('a submission covers every frozen case, and only those', () => {
  const run = { run: 'run_x', items: [item('one'), item('two')] };
  assert.throws(() => submissionFor(run, [{ item: 'one', method }], 'scripted'), /还有 1 条原始用例没有重组后的用例/);
  assert.throws(() => submissionFor(run, [{ item: 'one', method }, { item: 'two', method }, { item: 'three', method }], 'scripted'), /不属于本次用例重组的原始用例/);
  const sent = submissionFor(run, [{ item: 'one', method }, { item: 'two', method }], 'scripted');
  assert.equal(sent.items.length, 2);
  assert.equal(sent.items[0].slots.record[0].quotes.length, 3);
});

test("a user's ruling stays in the fields the file already has: the atom's state reason, the adapted step and who decided the value", () => {
  const ruling = '用户裁定：以手册为准，改成手册允许的写法';
  const record = recordFor(item(), {
    method,
    states: [{ atom: 'a2', state: 'settled', reason: ruling }],
    adapted: [{ atom: 'a2', action: 'parameter_change', text: '合成动作二（改名）', commands: ['widget name peer_b'], equivalence_reason: ruling, equivalence_refs: [`tree:${'b'.repeat(64)}/manual/guide/names@${'1'.repeat(64)}`] }],
    concretizations: [{ atom: 'a2', slot: 'peer_name', value: 'peer_b', value_ref: `tree:${'b'.repeat(64)}/manual/guide/names@${'1'.repeat(64)}`, decided_by: '用户', source_kind: 'catalog' }, { atom: 'a2', slot: 'mode', value: 'full', value_ref: 'ref', source_kind: 'catalog' }],
  }, 'scripted');
  assert.deepEqual(record.sources.states.map((s: any) => [s.state, s.reason]), [['settled', '模型没有提出缺口'], ['settled', ruling], ['settled', '模型没有提出缺口']]);
  assert.equal(record.sources.states[1].adjudicated_by, null, 'a user’s ruling names no independent adjudication');
  assert.equal(record.ledgers.adapted[0].equivalence_reason, ruling);
  assert.deepEqual(record.ledgers.concretizations.map((c: any) => c.decided_by), ['用户', 'scripted'], 'the model’s name is the default, the user is kept when the file names the user');
  // A case left for the author: an underdetermined atom and a gap with a named audience; the record stays complete.
  const waiting = recordFor(item(), { method, states: [{ atom: 'a2', state: 'underdetermined', reason: '用户裁定：保留作者原样，这条先不编，待作者裁定' }], unknowns: [{ missing: '作者步骤与手册冲突', next_action: '作者或用户裁定', audience: '作者或用户', due: '交付之前' }] }, 'scripted');
  assert.deepEqual([waiting.sources.states[1].state, waiting.status, waiting.unknowns.length], ['underdetermined', 'complete', 1]);
});

test('submit-records main retries GET /run and explicit non-execution 503 on submit, never ambiguous disconnect or 503', async (t) => {
  const RUN = 'run_01aaaaaaaaaaaaaaaaaaaaaaaa';
  const TOKEN = 'synthetic-token-1234';
  const makeDir = async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rc-submit-'));
    await writeFile(join(dir, '01.json'), JSON.stringify({ item: 'n/case', method }));
    return dir;
  };
  const runPayload = { schema: 'run-export@1', run: { run: RUN, items: [item('n/case')] } };

  let gets = 0, posts = 0;
  const serverRecover = createServer((request, response) => {
    if (request.headers.authorization !== `Bearer ${TOKEN}`) { response.statusCode = 401; response.end('unauth'); return; }
    if (request.method === 'GET' && request.url === `/run-export/${RUN}/run`) {
      gets++;
      if (gets === 1) { response.writeHead(503, { 'retry-after': '4' }); response.end('busy'); return; }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(runPayload));
      return;
    }
    request.resume();
    request.on('end', () => {
      posts++;
      if (posts === 1) { response.writeHead(503); response.end('Hub 重启中，这次调用没有执行'); return; }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '受理' }] } }));
    });
  });
  await new Promise<void>((done) => serverRecover.listen(0, '127.0.0.1', done));
  t.after(() => new Promise<void>((done) => serverRecover.close(() => done())));
  const recoverUrl = `http://127.0.0.1:${(serverRecover.address() as { port: number }).port}/mcp`;

  let now1 = 0; const pauses1: number[] = [];
  const out1: string[] = [], err1: string[] = [];
  const stdout = process.stdout.write.bind(process.stdout), stderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: string | Uint8Array) => { out1.push(String(c)); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((c: string | Uint8Array) => { err1.push(String(c)); return true; }) as typeof process.stderr.write;
  let code1 = -1;
  try {
    code1 = await main(['--hub', recoverUrl, '--run', RUN, '--model', 'scripted', '--records', await makeDir()], async () => TOKEN, {
      timing: { now: () => now1, pause: async (ms) => { pauses1.push(ms); now1 += ms; } },
    });
  } finally { process.stdout.write = stdout; process.stderr.write = stderr; }
  assert.equal(code1, 0, err1.join(''));
  assert.equal(gets, 2);
  assert.equal(posts, 2);
  assert.deepEqual(pauses1, [4_000, 2_000]);
  assert.match(out1.join(''), /1 条重组后的用例已交给 Hub 核对/);

  for (const mode of ['ambiguous-503', 'reset'] as const) {
    let failPosts = 0;
    const serverFail = createServer((request, response) => {
      if (request.method === 'GET' && request.url === `/run-export/${RUN}/run`) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(runPayload));
        return;
      }
      failPosts++;
      if (mode === 'reset') { request.socket.destroy(); return; }
      request.resume();
      request.on('end', () => { response.writeHead(503); response.end('连接排队，情况未知'); });
    });
    await new Promise<void>((done) => serverFail.listen(0, '127.0.0.1', done));
    t.after(() => new Promise<void>((done) => serverFail.close(() => done())));
    const failUrl = `http://127.0.0.1:${(serverFail.address() as { port: number }).port}/mcp`;
    let now2 = 0; const pauses2: number[] = [];
    const err2: string[] = [];
    process.stderr.write = ((c: string | Uint8Array) => { err2.push(String(c)); return true; }) as typeof process.stderr.write;
    let code2 = -1;
    try {
      code2 = await main(['--hub', failUrl, '--run', RUN, '--model', 'scripted', '--records', await makeDir()], async () => TOKEN, {
        timing: { now: () => now2, pause: async (ms) => { pauses2.push(ms); now2 += ms; } },
      });
    } finally { process.stderr.write = stderr; }
    assert.equal(code2, 1, mode);
    assert.equal(failPosts, 1, mode);
    assert.deepEqual(pauses2, [], mode);
    assert.match(err2.join(''), /^暂时不可用：.*没有自动重发。请先查回原调用.*。$/m, mode);
  }
});

test('H1/H3/H4: submit-records checks empty stdin, names --records and offending filename (never --plans or re-export), and enforces single lite shape', async (t) => {
  const runCapture = async (argv: string[], token: string) => {
    const out: string[] = [], err: string[] = [];
    const stdout = process.stdout.write.bind(process.stdout), stderr = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((chunk: string | Uint8Array) => { out.push(String(chunk)); return true; }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string | Uint8Array) => { err.push(String(chunk)); return true; }) as typeof process.stderr.write;
    try { return { code: await main(argv, async () => token), out: out.join(''), err: err.join('') }; } finally { process.stdout.write = stdout; process.stderr.write = stderr; }
  };

  // H4: method missing error names method & shows lite JSON shape while keeping existing substring
  assert.throws(
    () => recordFor(item(), {}, 'scripted'),
    (error: Error) => /缺少用例重组的方法/.test(error.message) && /\bmethod\b/.test(error.message) && /declared/.test(error.message),
  );
  // H4: rejects unknown/bogus method kind
  assert.throws(
    () => recordFor(item(), { method: { kind: 'bogus', text: 'x', sources: [], basis: 'y' } }, 'scripted'),
    /method\.kind/,
  );
  // H4: rejects full recompose-record@1 schema & handling wrapper
  assert.throws(
    () => recordFor(item(), { schema: 'recompose-record@1', case: { case_id: 'ORBIT-1' }, contract: { method } }, 'scripted'),
    /精简格式.*recompose-record@1/,
  );
  assert.throws(
    () => recordFor(item(), { method, handling: 'handled' }, 'scripted'),
    /精简格式.*handling/,
  );

  // H3 & H1 CLI paths
  const dirBadJson = await mkdtemp(join(tmpdir(), 'cc-rec-bad-'));
  await writeFile(join(dirBadJson, '11.json'), '{"item":"n/case","method":');
  const badJsonRes = await runCapture(['--hub', 'http://127.0.0.1:1/mcp', '--run', 'run_01aaaaaaaaaaaaaaaaaaaaaaaa', '--model', 'scripted', '--records', dirBadJson], 'synthetic-token-1234');
  assert.equal(badJsonRes.code, 1);
  assert.match(badJsonRes.err, /^参数无效：/);
  assert.match(badJsonRes.err, /--records/);
  assert.match(badJsonRes.err, /11\.json/);
  assert.doesNotMatch(badJsonRes.err, /--plans/);
  assert.doesNotMatch(badJsonRes.err, /重新导出该运行对应输入的原始字节/);

  const missingDir = join(tmpdir(), 'cc-rec-missing-nonexistent-dir');
  const missingDirRes = await runCapture(['--hub', 'http://127.0.0.1:1/mcp', '--run', 'run_01aaaaaaaaaaaaaaaaaaaaaaaa', '--model', 'scripted', '--records', missingDir], 'synthetic-token-1234');
  assert.equal(missingDirRes.code, 1);
  assert.match(missingDirRes.err, /--records/);
  assert.doesNotMatch(missingDirRes.err, /--plans/);

  const dirFullSchema = await mkdtemp(join(tmpdir(), 'cc-rec-full-'));
  await writeFile(join(dirFullSchema, '00.json'), JSON.stringify({ item: 'n/case', schema: 'recompose-record@1', contract: { method } }));
  const fullRes = await runCapture(['--hub', 'http://127.0.0.1:1/mcp', '--run', 'run_01aaaaaaaaaaaaaaaaaaaaaaaa', '--model', 'scripted', '--records', dirFullSchema], 'synthetic-token-1234');
  assert.equal(fullRes.code, 1);
  assert.match(fullRes.err, /00\.json.*精简格式/);

  const dirHandling = await mkdtemp(join(tmpdir(), 'cc-rec-wrap-'));
  await writeFile(join(dirHandling, '00.json'), JSON.stringify({ item: 'n/case', method, handling: 'handled' }));
  const handlingRes = await runCapture(['--hub', 'http://127.0.0.1:1/mcp', '--run', 'run_01aaaaaaaaaaaaaaaaaaaaaaaa', '--model', 'scripted', '--records', dirHandling], 'synthetic-token-1234');
  assert.equal(handlingRes.code, 1);
  assert.match(handlingRes.err, /00\.json.*精简格式.*handling/);

  const dirValid = await mkdtemp(join(tmpdir(), 'cc-rec-empty-tok-'));
  await writeFile(join(dirValid, '00.json'), JSON.stringify({ item: 'n/case', method }));
  const noTokRes = await runCapture(['--hub', 'http://127.0.0.1:1/mcp', '--run', 'run_01aaaaaaaaaaaaaaaaaaaaaaaa', '--model', 'scripted', '--records', dirValid], '');
  assert.equal(noTokRes.code, 1);
  assert.match(noTokRes.err, /^参数无效：标准输入里没有令牌/);
  assert.match(noTokRes.err, /切勿在 <<'EOF' 前换行/);
});

test('a partial submission covers the cases written so far; a whole one still refuses a missing case', () => {
  const run = { run: 'run_x', items: [item('one'), item('two')] };
  assert.throws(() => submissionFor(run, [{ item: 'one', method }], 'scripted'), /还有 1 条原始用例没有重组后的用例/);
  const sent = submissionFor(run, [{ item: 'one', method }], 'scripted', true);
  assert.deepEqual(sent.items.map((row: any) => row.item), ['one']);
  assert.throws(() => submissionFor(run, [{ item: 'three', method }], 'scripted', true), /不属于本次用例重组的原始用例/);
});

test('parallel per-case submissions take turns, each reading the directory inside the lock, so the later one holds every record', async () => {
  const RUN = 'run_01lockedlockedlocked0000';
  const run = { run: RUN, items: [item('one'), item('two')] };
  const seen: string[][] = [];
  let release!: () => void; const firstHeld = new Promise<void>((done) => { release = done; });
  let calls = 0;
  const server = createServer((request, response) => {
    if (request.method === 'GET') { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ schema: 'run-export@1', run })); return; }
    let body = ''; request.on('data', (c) => { body += c; });
    request.on('end', async () => {
      const sent = JSON.parse(body).params.arguments;
      seen.push(sent.items.map((row: any) => row.item));
      if (++calls === 1) await firstHeld;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '受理' }] } }));
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`;
  const directory = await mkdtemp(join(tmpdir(), 'records-'));
  await writeFile(join(directory, '00.json'), JSON.stringify({ item: 'one', method }));
  const quiet = process.stdout.write; process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    const args = ['--hub', url, '--run', RUN, '--model', 'scripted', '--records', directory, '--partial', 'yes'];
    const lock = { waitMs: 10_000, staleMs: 60_000, stepMs: 20 };
    const first = main(args, async () => 'synthetic-token-1234', undefined, lock);
    while (seen.length < 1) await new Promise((done) => setTimeout(done, 10));
    // The second case finishes while the first submission is still with the Hub.
    await writeFile(join(directory, '01.json'), JSON.stringify({ item: 'two', method }));
    const second = main(args, async () => 'synthetic-token-1234', undefined, lock);
    await new Promise((done) => setTimeout(done, 200));
    assert.equal(seen.length, 1, 'the second submission waits for the lock');
    release();
    assert.deepEqual([await first, await second], [0, 0]);
    assert.deepEqual(seen, [['one'], ['one', 'two']]);
    await assert.rejects(readFile(join(directory, '.submit.lock')), 'the lock is gone afterwards');
  } finally { process.stdout.write = quiet; server.closeAllConnections(); await new Promise((done) => server.close(done)); }
});
