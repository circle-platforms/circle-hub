// A run takes one complete submission; the model writes one file per case. Synthetic Hub stub only.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fidelityBrief } from '../functions/fidelity.ts';
import { main, planItems } from './submit-plans.ts';

const RUN = 'run_01aaaaaaaaaaaaaaaaaaaaaaaa';
const TOKEN = 'synthetic-token-1234';
const item = (name: string) => ({ item: name, handling: 'handled', slots: { plan: [{ text: name, quotes: [], data: {} }] } });
async function plans(files: Record<string, unknown>) {
  const directory = await mkdtemp(join(tmpdir(), 'plans-'));
  for (const [name, value] of Object.entries(files)) await writeFile(join(directory, name), typeof value === 'string' ? value : JSON.stringify(value));
  return directory;
}
let RUN_ITEMS = ['doc:a', 'doc:b'];
let RUN_RECOMPOSITION: Record<string, unknown> | undefined;
const servers = new Set<ReturnType<typeof createServer>>();
after(async () => { for (const server of servers) { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); } });
async function hub(answer: unknown, status = 200) {
  const seen: Array<{ url?: string; authorization?: string; body: any }> = [];
  const server = createServer((request, response) => {
    if (request.method === 'GET' && request.url === `/run-export/${RUN}/run`) { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ schema: 'run-export@1', run: { run: RUN, items: RUN_ITEMS.map((id, index) => ({ id, fields: { autoid: `99000000000000010${index + 1}`, title: `合成用例 ${index + 1}`, ...(RUN_RECOMPOSITION ? { recomposition: { record: RUN_RECOMPOSITION } } : {}) } })) } })); return; }
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      seen.push({ url: request.url, authorization: request.headers.authorization, body: JSON.parse(body) });
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(typeof answer === 'string' ? answer : JSON.stringify(answer));
    });
  });
  servers.add(server);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as { port: number };
  return { seen, url: `http://127.0.0.1:${port}/mcp`, close: () => { servers.delete(server); server.closeAllConnections(); return new Promise(done => server.close(done)); } };
}
async function run(url: string, directory: string, token = TOKEN, retry?: Parameters<typeof main>[2]) {
  const out: string[] = [], err: string[] = [];
  const stdout = process.stdout.write, stderr = process.stderr.write;
  process.stdout.write = ((text: string) => { out.push(text); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((text: string) => { err.push(text); return true; }) as typeof process.stderr.write;
  try {
    const code = await main(['--hub', url, '--run', RUN, '--model', 'synthetic-model', '--plans', directory], async () => token, retry);
    return { code, out: out.join(''), err: err.join('') };
  } finally { process.stdout.write = stdout; process.stderr.write = stderr; }
}
const said = (text: string, isError = false) => ({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text }], ...(isError ? { isError } : {}) } });

test('the case files become one submit_result call in name order, with the token only in the header', async () => {
  const directory = await plans({ '02.json': item('doc:b'), '01.json': item('doc:a'), 'notes.txt': 'not a case' });
  const stub = await hub(said('受理'));
  const result = await run(stub.url, directory);
  await stub.close();
  assert.equal(result.code, 0);
  assert.equal(stub.seen.length, 1);
  assert.equal(stub.seen[0].url, '/mcp');
  assert.equal(stub.seen[0].authorization, `Bearer ${TOKEN}`);
  assert.equal(stub.seen[0].body.params.name, 'submit_result');
  assert.deepEqual(stub.seen[0].body.params.arguments, { run: RUN, model: 'synthetic-model', items: [item('doc:a'), item('doc:b')] });
  assert.doesNotMatch(result.out, new RegExp(TOKEN));
  assert.match(result.out, /2 份自动化用例已交给 Hub 做脚本合并/);
});

test('a skipped case passes through as written', async () => {
  const skipped = { item: 'doc:c', handling: 'skipped', reason: '合成理由' };
  assert.deepEqual(await planItems(await plans({ '01.json': skipped })), [skipped]);
});

test('a case handed in as skipped is answered with the closing rule after the Hub\'s receipt, as the reference engine answers an exit when it is filed', async () => {
  const skipped = { item: 'doc:b', handling: 'skipped', reason: '合成理由：环境缺前置' };
  const stub = await hub(said('回执：已受理；未完成 1（修复轮数用完 1）'));
  const result = await run(stub.url, await plans({ '01.json': item('doc:a'), '02.json': skipped }));
  await stub.close();
  assert.equal(result.code, 0);
  assert.deepEqual(stub.seen[0].body.params.arguments.items, [item('doc:a'), skipped], 'the skip reaches the Hub as written');
  assert.match(result.out, /未完成 1（修复轮数用完 1）\n全文在 .+\n原始用例 990000000000000102 合成用例 2，还没有完成脚本编写，状态未知。原因缺资料，下一步由编写模型按原始用例继续编写；声明跳过不是已核验的不可编写结论；已有具名缺失事实出口时按出口处理，否则继续编写或补齐证据；计数只陈述已记录尝试，不证明失败归因。决定者程序。\n$/);
  // No skip, no note.
  const plain = await hub(said('受理'));
  assert.doesNotMatch((await run(plain.url, await plans({ '01.json': item('doc:a') }))).out, /还没有完成脚本编写/);
  await plain.close();
});

test('nothing is sent when a file is not an item, two files name one item, or there are no files', async () => {
  for (const [files, message] of [[{ '01.json': { plan: [] } }, /不是一个条目/], [{ '01.json': item('doc:a'), '02.json': item('doc:a') }, /同一个条目/], [{}, /没有 \.json 文件/], [{ '01.json': 'not json' }, /参数无效：/]] as const) {
    const stub = await hub(said('受理'));
    const result = await run(stub.url, await plans(files));
    await stub.close();
    assert.equal(result.code, 1);
    assert.match(result.err, message);
    assert.equal(stub.seen.length, 0);
  }
});

test('Circle\'s unexpanded placeholder is no token and is never sent', async () => {
  const stub = await hub(said('受理'));
  const result = await run(stub.url, await plans({ '01.json': item('doc:a') }), '%HUB_TOKEN%');
  await stub.close();
  assert.equal(result.code, 1);
  assert.equal(stub.seen.length, 0);
});

test('a refusal from the Hub is shown as it came and fails the command', async () => {
  const stub = await hub(said('未受理：引文不在片段里', true));
  const result = await run(stub.url, await plans({ '01.json': item('doc:a') }));
  await stub.close();
  assert.equal(result.code, 1);
  assert.match(result.out, /未受理：引文不在片段里/);
});

test('an HTTP failure and a protocol error say what happened', async () => {
  const down = await hub('no', 503);
  assert.match((await run(down.url, await plans({ '01.json': item('doc:a') }))).err, /Hub 答复 503/);
  await down.close();
  const refused = await hub({ jsonrpc: '2.0', id: 1, error: { code: -32603, message: '合成错误' } });
  assert.match((await run(refused.url, await plans({ '01.json': item('doc:a') }))).err, /JSON-RPC code -32603.*请核对原调用/);
  await refused.close();
});

test('a long answer is kept whole in a file beside the plans and shown clipped', async () => {
  const directory = await plans({ '01.json': item('doc:a') });
  const text = '答'.repeat(20_000);
  const stub = await hub(said(text));
  const result = await run(stub.url, directory);
  await stub.close();
  assert.equal(result.code, 0);
  assert.match(result.out, /共 20000 字符/);
  assert.ok(result.out.length < 13_000);
  const saved = (await readdir(directory)).find((name) => name.startsWith('answer-'));
  assert.equal(await readFile(join(directory, saved!), 'utf8'), text);
  assert.equal((await planItems(directory)).length, 1);
});

test('a length placeholder is expanded, written back to its file and sent as written back; a malformed one stops the submission', async () => {
  const withDomain = { item: 'doc:a', handling: 'handled', slots: { plan: [{ text: 'a', quotes: [], data: { steps: [{ args: ['sdns host name "{{domain:253}}" 60'] }, { args: ['dig {{domain:253}} A'] }] } }] } };
  const directory = await plans({ '01.json': withDomain, '02.json': item('doc:b') });
  const stub = await hub(said('受理'));
  const result = await run(stub.url, directory);
  await stub.close();
  assert.equal(result.code, 0);
  const written = JSON.parse(await readFile(join(directory, '01.json'), 'utf8'));
  const [config, query] = written.slots.plan[0].data.steps.map((step: any) => step.args[0]);
  const literal = /"([^"]+)"/.exec(config)![1];
  assert.equal(literal.length, 253);
  assert.ok(literal.split('.').every((label: string) => label.length <= 63));
  assert.equal(query, `dig ${literal} A`);
  assert.deepEqual(stub.seen[0].body.params.arguments.items[0], written);
  assert.match(result.out, /01\.json：\{\{domain:253\}\} → 253 字符，4 段，各段 63\/63\/63\/61/);
  assert.equal(JSON.parse(await readFile(join(directory, '02.json'), 'utf8')).item, 'doc:b');
  assert.deepEqual((await readdir(directory)).filter((name) => name.endsWith('.json')), ['01.json', '02.json']);

  const bad = await plans({ '01.json': { item: 'doc:a', handling: 'handled', slots: { plan: [{ text: '{{domain:253:x}}', quotes: [], data: {} }] } } });
  const stub2 = await hub(said('受理'));
  const refused = await run(stub2.url, bad);
  await stub2.close();
  assert.equal(refused.code, 1);
  assert.equal(stub2.seen.length, 0);
  assert.match(refused.err, /01\.json：长度占位写法不对/);
});

test('a final verification takes the same plan directory: files of items the run does not hold are left out and named', async () => {
  RUN_ITEMS = ['doc:a'];
  try {
    const directory = await plans({ '01.json': item('doc:a'), '02.json': item('doc:b') });
    const stub = await hub(said('受理'));
    const result = await run(stub.url, directory);
    await stub.close();
    assert.equal(result.code, 0, result.err);
    assert.deepEqual(stub.seen[0].body.params.arguments.items, [item('doc:a')]);
    assert.match(result.out, /另有 1 份自动化用例不属于本次脚本编写，未做脚本合并/);
    RUN_ITEMS = ['doc:z'];
    const stub2 = await hub(said('受理'));
    const none = await run(stub2.url, directory);
    await stub2.close();
    assert.equal(none.code, 1);
    assert.equal(stub2.seen.length, 0);
    assert.match(none.err, /--plans 目录里没有本次脚本编写的自动化用例，本次共有 1 条原始用例/);
  } finally { RUN_ITEMS = ['doc:a', 'doc:b']; }
});

test('invalid JSON is located by filename with explicit unknown offset, and nothing is sent', async () => {
  const good = JSON.stringify(item('doc:a'));
  const directory = await plans({ '01.json': good, '02.json': JSON.stringify(item('doc:b')).slice(0, -1) });
  const stub = await hub(said('受理'));
  const result = await run(stub.url, directory);
  await stub.close();
  assert.equal(result.code, 1);
  assert.equal(stub.seen.length, 0);
  assert.match(result.err, /02\.json 不是合法的 JSON.*具体字符位置未知.*JSON 结构.*位置：02\.json.*合法写法/);
  const bytes = await plans({ '01.json': Buffer.from([0x7b, 0xff, 0x7d]).toString('latin1') });
  await writeFile(join(bytes, '01.json'), Buffer.from([0x7b, 0xff, 0x7d]));
  const stub2 = await hub(said('受理'));
  const bad = await run(stub2.url, bytes);
  await stub2.close();
  assert.match(bad.err, /01\.json 不是合法的 UTF-8 文本/);
});

test('local fidelity precheck blocks missing, stale, or malformed data.fidelity before calling Hub, while valid fidelity and skipped cases pass through', async () => {
  const record = {
    schema: 'recompose-record@1',
    atoms: [
      { id: 'A1', kind: 'action', text: 'Configure interval 60' },
      { id: 'E1', kind: 'expectation', text: 'Interval is 60' },
    ],
    ledgers: { original: [{ atom: 'A1', text: 'Configure interval 60' }], adapted: [], rebindings: [] },
    contract: { intent: { text: 'Configure interval' } },
  };
  const plan = { bucket: 'bed-0', blocks: [], steps: [{ object: 'Device_0', method: 'cli', args: ['interval 60'], keywords: {} }], expects: [{ text: '60', quote: { text: 'Interval is 60', reference: 'doc:a#1' }, after: 1 }], replacements: [] };
  const brief = fidelityBrief('doc:a', record, plan);
  assert.ok(brief !== null);
  RUN_ITEMS = ['doc:a'];
  RUN_RECOMPOSITION = record;
  try {
    // 1. Missing data.fidelity -> exit 1 locally, 0 POST /mcp requests, prints 3-step instructions
    const missingDir = await plans({ '01.json': { item: 'doc:a', handling: 'handled', slots: { plan: [{ text: 'p', quotes: [], data: plan }] } } });
    const stubMissing = await hub(said('受理'));
    const resMissing = await run(stubMissing.url, missingDir);
    await stubMissing.close();
    assert.equal(resMissing.code, 1);
    assert.equal(stubMissing.seen.length, 0);
    assert.match(resMissing.err, /990000000000000101 合成用例 1（doc:a）/);
    assert.match(resMissing.err, /fidelity-brief\.ts/);
    assert.match(resMissing.err, /\.verdict\.json/);
    assert.match(resMissing.err, /fidelity-apply\.ts/);
    // The two commands it prints take the run directory as --run, as every tool that reads a run does.
    assert.match(resMissing.err, /fidelity-plumb\.ts --run <脚本编写目录> --plans /);
    assert.match(resMissing.err, /fidelity-apply\.ts --run <脚本编写目录> --plans /);
    assert.doesNotMatch(resMissing.err, /run\.json/);

    // 2. Stale brief_sha256 -> exit 1 locally, 0 POST /mcp requests
    const stalePlan = { ...plan, steps: [{ object: 'Device_0', method: 'cli', args: ['interval 120'], keywords: {} }], fidelity: { brief_sha256: brief.brief_sha256, steps: [{ n: 'A1', verdict: 'preserved', step_indices: [1], rationale: 'ok' }], disclosure: '保住' } };
    const staleDir = await plans({ '01.json': { item: 'doc:a', handling: 'handled', slots: { plan: [{ text: 'p', quotes: [], data: stalePlan }] } } });
    const stubStale = await hub(said('受理'));
    const resStale = await run(stubStale.url, staleDir);
    await stubStale.close();
    assert.equal(resStale.code, 1);
    assert.equal(stubStale.seen.length, 0);
    assert.match(resStale.err, /不是这份计划的简报/);
    assert.match(resStale.err, /fidelity-apply\.ts/);

    // 3. Malformed shape -> exit 1 locally, 0 POST /mcp requests
    const badShapePlan = { ...plan, fidelity: { brief_sha256: brief.brief_sha256, steps: [], disclosure: '空步骤' } };
    const shapeDir = await plans({ '01.json': { item: 'doc:a', handling: 'handled', slots: { plan: [{ text: 'p', quotes: [], data: badShapePlan }] } } });
    const stubShape = await hub(said('受理'));
    const resShape = await run(stubShape.url, shapeDir);
    await stubShape.close();
    assert.equal(resShape.code, 1);
    assert.equal(stubShape.seen.length, 0);
    assert.match(resShape.err, /fidelity-brief\.ts/);

    // 4. Valid matching data.fidelity -> sent to Hub
    const validPlan = { ...plan, fidelity: { brief_sha256: brief.brief_sha256, steps: [{ n: 'A1', verdict: 'preserved', step_indices: [1], rationale: '第 1 步实现' }], disclosure: '已保住' } };
    const validDir = await plans({ '01.json': { item: 'doc:a', handling: 'handled', slots: { plan: [{ text: 'p', quotes: [], data: validPlan }] } } });
    const stubValid = await hub(said('受理'));
    const resValid = await run(stubValid.url, validDir);
    await stubValid.close();
    assert.equal(resValid.code, 0, resValid.err);
    assert.equal(stubValid.seen.length, 1);

    // 5. Skipped item -> passes through even without data.fidelity
    const skippedDir = await plans({ '01.json': { item: 'doc:a', handling: 'skipped', reason: '缺执行器声明' } });
    const stubSkipped = await hub(said('受理'));
    const resSkipped = await run(stubSkipped.url, skippedDir);
    await stubSkipped.close();
    assert.equal(resSkipped.code, 0, resSkipped.err);
    assert.equal(stubSkipped.seen.length, 1);
    assert.match(resSkipped.out, /还没有完成脚本编写/);
  } finally {
    RUN_ITEMS = ['doc:a', 'doc:b'];
    RUN_RECOMPOSITION = undefined;
  }
});

test('submit_plans retries ONLY on 503 saying 这次调用没有执行, and never retries ambiguous 503, disconnect, timeout, or refused', async (t) => {
  const dir = await plans({ '01.json': item('doc:a'), '02.json': item('doc:b') });

  // 1. Recover when Hub explicitly replies 503 + 这次调用没有执行 (first with Retry-After, second without).
  let recoverPosts = 0;
  const serverRecover = createServer((request, response) => {
    if (request.method === 'GET' && request.url === `/run-export/${RUN}/run`) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ schema: 'run-export@1', run: { run: RUN, items: RUN_ITEMS.map((id, i) => ({ id, fields: { autoid: `99000000000000010${i + 1}`, title: `合成 ${i + 1}` } })) } }));
      return;
    }
    request.resume();
    request.on('end', () => {
      recoverPosts++;
      if (recoverPosts === 1) { response.writeHead(503, { 'retry-after': '5' }); response.end('Hub 正在重启，这次调用没有执行，请稍后重试'); return; }
      if (recoverPosts === 2) { response.writeHead(503); response.end('仍在重载，这次调用没有执行'); return; }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(said('受理')));
    });
  });
  await new Promise<void>((done) => serverRecover.listen(0, '127.0.0.1', done));
  t.after(() => new Promise<void>((done) => serverRecover.close(() => done())));
  const recoverUrl = `http://127.0.0.1:${(serverRecover.address() as { port: number }).port}/mcp`;
  let now1 = 0; const pauses1: number[] = [];
  const ok = await run(recoverUrl, dir, TOKEN, { timing: { now: () => now1, pause: async (ms) => { pauses1.push(ms); now1 += ms; } } });
  assert.equal(ok.code, 0, ok.err);
  assert.equal(recoverPosts, 3);
  assert.deepEqual(pauses1, [5_000, 2_000]);

  // 2. Exhausting 60s on explicit non-execution 503 reports wait duration and attempts.
  let exhaustPosts = 0;
  const serverExhaust = createServer((request, response) => {
    if (request.method === 'GET' && request.url === `/run-export/${RUN}/run`) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ schema: 'run-export@1', run: { run: RUN, items: RUN_ITEMS.map((id, i) => ({ id, fields: { autoid: `99000000000000010${i + 1}`, title: `合成 ${i + 1}` } })) } }));
      return;
    }
    request.resume();
    request.on('end', () => { exhaustPosts++; response.writeHead(503); response.end('排水中，这次调用没有执行'); });
  });
  await new Promise<void>((done) => serverExhaust.listen(0, '127.0.0.1', done));
  t.after(() => new Promise<void>((done) => serverExhaust.close(() => done())));
  const exhaustUrl = `http://127.0.0.1:${(serverExhaust.address() as { port: number }).port}/mcp`;
  let now2 = 0; const pauses2: number[] = [];
  const exhausted = await run(exhaustUrl, dir, TOKEN, { timing: { now: () => now2, pause: async (ms) => { pauses2.push(ms); now2 += ms; } } });
  assert.equal(exhausted.code, 1);
  assert.equal(exhaustPosts, 10);
  assert.deepEqual(pauses2, [2_000, 4_000, 8_000, 8_000, 8_000, 8_000, 8_000, 8_000, 6_000]);
  assert.match(exhausted.err, /^暂时不可用：Hub 答复 503：.*这次调用没有执行.*已等待 60 秒并尝试 10 次.*。请.*。$/m);

  // 3. Ambiguous 503, mid-flight socket reset, truncated JSON, TimeoutError, and ECONNREFUSED NEVER retry.
  for (const mode of ['ambiguous-503', 'reset', 'truncated'] as const) {
    let posts = 0;
    const server = createServer((request, response) => {
      if (request.method === 'GET' && request.url === `/run-export/${RUN}/run`) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ schema: 'run-export@1', run: { run: RUN, items: RUN_ITEMS.map((id, i) => ({ id, fields: { autoid: `99000000000000010${i + 1}`, title: `合成 ${i + 1}` } })) } }));
        return;
      }
      posts++;
      if (mode === 'reset') { request.socket.destroy(); return; }
      request.resume();
      request.on('end', () => {
        if (mode === 'ambiguous-503') { response.writeHead(503, { 'retry-after': '5' }); response.end('服务繁忙，请稍后再试'); return; }
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{"jsonrpc":"2.0"');
      });
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    t.after(() => new Promise<void>((done) => server.close(() => done())));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`;
    let now = 0; const pauses: number[] = [];
    const failed = await run(url, dir, TOKEN, { timing: { now: () => now, pause: async (ms) => { pauses.push(ms); now += ms; } } });
    assert.equal(failed.code, 1, mode);
    assert.equal(posts, 1, mode);
    assert.deepEqual(pauses, [], mode);
    assert.match(failed.err, /^暂时不可用：.*没有自动重发。请先查回原调用.*。$/m, mode);
  }

  for (const err of [
    new DOMException('signal timed out', 'TimeoutError'),
    new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) }),
  ]) {
    let postCalls = 0;
    const pauses: number[] = [];
    const h = await hub(said('受理')); t.after(h.close);
    const failed = await run(h.url, dir, TOKEN, {
      timing: { now: () => 0, pause: async (ms) => { pauses.push(ms); } },
      fetch: async (input, init) => {
        if (new URL(String(input)).pathname === '/mcp') { postCalls++; throw err; }
        return globalThis.fetch(input, init);
      },
    });
    assert.equal(failed.code, 1);
    assert.equal(postCalls, 1);
    assert.deepEqual(pauses, []);
    assert.match(failed.err, /^暂时不可用：.*没有自动重发。请先查回原调用.*。$/m);
  }
});

test('planItems reports offending filename without saying re-export bytes, and empty stdin fails with same-line heredoc guidance', async (t) => {
  const dir = await plans({ '01.json': item('doc:a'), '02.json': '{broken json' });
  await assert.rejects(
    () => planItems(dir),
    (error: Error) => /--plans/.test(error.message) && /02\.json/.test(error.message) && !/重新导出该运行对应输入的原始字节/.test(error.message),
  );
  const h = await hub(said('受理')); t.after(h.close);
  const okDir = await plans({ '01.json': item('doc:a') });
  const emptyTok = await run(h.url, okDir, '');
  assert.equal(emptyTok.code, 1);
  assert.match(emptyTok.err, /^参数无效：标准输入里没有令牌/);
  assert.match(emptyTok.err, /切勿在 <<'EOF' 前换行/);
});

test('a malformed Hub address is a parameter failure before reading files or a token', async () => {
  const reply = await run('not a URL', 'not-an-existing-plan-directory');
  assert.equal(reply.code, 1);
  assert.match(reply.err, /^参数无效：--hub/);
  assert.match(reply.err, /HTTP\(S\).*核对 Hub 地址/);
});
