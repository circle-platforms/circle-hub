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
async function hub(answer: unknown, status = 200) {
  const seen: Array<{ url?: string; authorization?: string; body: any }> = [];
  const server = createServer((request, response) => {
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
