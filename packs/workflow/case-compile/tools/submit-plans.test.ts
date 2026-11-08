// A run takes one complete submission; the model writes one file per case. Synthetic Hub stub only.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
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
async function hub(answer: unknown, status = 200) {
  const seen: Array<{ url?: string; authorization?: string; body: any }> = [];
  const server = createServer((request, response) => {
    if (request.method === 'GET' && request.url === `/run-export/${RUN}/run`) { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ schema: 'run-export@1', run: { run: RUN, items: RUN_ITEMS.map((id) => ({ id })) } })); return; }
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      seen.push({ url: request.url, authorization: request.headers.authorization, body: JSON.parse(body) });
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(typeof answer === 'string' ? answer : JSON.stringify(answer));
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as { port: number };
  return { seen, url: `http://127.0.0.1:${port}/mcp`, close: () => new Promise((done) => server.close(done)) };
}
async function run(url: string, directory: string, token = TOKEN) {
  const out: string[] = [], err: string[] = [];
  const stdout = process.stdout.write, stderr = process.stderr.write;
  process.stdout.write = ((text: string) => { out.push(text); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((text: string) => { err.push(text); return true; }) as typeof process.stderr.write;
  try {
    const code = await main(['--hub', url, '--run', RUN, '--model', 'synthetic-model', '--plans', directory], async () => token);
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
  assert.match(result.out, /2 个条目已提交/);
});

test('a skipped case passes through as written', async () => {
  const skipped = { item: 'doc:c', handling: 'skipped', reason: '合成理由' };
  assert.deepEqual(await planItems(await plans({ '01.json': skipped })), [skipped]);
});

test('nothing is sent when a file is not an item, two files name one item, or there are no files', async () => {
  for (const [files, message] of [[{ '01.json': { plan: [] } }, /不是一个条目/], [{ '01.json': item('doc:a'), '02.json': item('doc:a') }, /同一个条目/], [{}, /没有 \.json 文件/], [{ '01.json': 'not json' }, /提交失败/]] as const) {
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
  assert.match((await run(refused.url, await plans({ '01.json': item('doc:a') }))).err, /合成错误/);
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
    assert.match(result.out, /跳过 1 个不属于本运行的条目文件（本运行没有这些条目，例如被 parameters\.exclude 排除）：doc:b/);
    RUN_ITEMS = ['doc:z'];
    const stub2 = await hub(said('受理'));
    const none = await run(stub2.url, directory);
    await stub2.close();
    assert.equal(none.code, 1);
    assert.equal(stub2.seen.length, 0);
    assert.match(none.err, /--plans 目录里没有本运行的条目（本运行有 1 个条目）/);
  } finally { RUN_ITEMS = ['doc:a', 'doc:b']; }
});

test('a case file that is not valid JSON is named with the place and the text around it, and nothing is sent', async () => {
  const good = JSON.stringify(item('doc:a'));
  const directory = await plans({ '01.json': good, '02.json': JSON.stringify(item('doc:b')).slice(0, -1) });
  const stub = await hub(said('受理'));
  const result = await run(stub.url, directory);
  await stub.close();
  assert.equal(result.code, 1);
  assert.equal(stub.seen.length, 0);
  assert.match(result.err, /02\.json 不是合法的 JSON（[^）]*）；出错位置第 \d+ 个字符，附近原文：".*"。常见原因是括号或引号没有成对/);
  const bytes = await plans({ '01.json': Buffer.from([0x7b, 0xff, 0x7d]).toString('latin1') });
  await writeFile(join(bytes, '01.json'), Buffer.from([0x7b, 0xff, 0x7d]));
  const stub2 = await hub(said('受理'));
  const bad = await run(stub2.url, bytes);
  await stub2.close();
  assert.match(bad.err, /01\.json 不是合法的 UTF-8 文本/);
});
