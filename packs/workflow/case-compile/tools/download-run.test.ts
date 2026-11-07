// Decision 160 step 1: the whole run on local disk before anything is submitted, so the model reads it with file tools instead
// of one Hub call per item. Synthetic Hub stub only.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { main } from './download-run.ts';
import { main as recomposeMain } from '../recompose/tools/download-run.ts';

const RUN = 'run_01aaaaaaaaaaaaaaaaaaaaaaaa';
const TOKEN = 'synthetic-token-1234';
const sha = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const mindmap = Buffer.from('{"root":{"data":{"text":"合成脑图"}}}'), contract = Buffer.from('{"contract":1}'), secret = Buffer.from('{"profile":1}');

async function hub(options: { tamper?: boolean; runAnswer?: (run: Record<string, unknown>) => unknown } = {}) {
  const items = Array.from({ length: 12 }, (_, index) => ({ id: `case-${index}`, fields: { atoms: [{ id: 'a1', kind: 'intent', content: `合成意图 ${index}` }] } }));
  const run = {
    run: RUN, items,
    sources: [
      { slot: 'subject', role: 'input', reference: `src:${sha(mindmap)}`, label: '合成脑图' },
      { role: 'expected', reference: `src:${sha(mindmap)}/kityminder@1/n/abc123` },
      { slot: 'contract', role: 'expected', reference: `src:${sha(contract)}`, media_type: 'application/json' },
      { slot: 'profile', role: 'expected', reference: `src:${sha(secret)}` },
      { role: 'expected', reference: `rec:${'d'.repeat(64)}` },
    ],
  };
  const paths: string[] = [];
  const server = createServer((request, response) => {
    paths.push(request.url ?? '');
    if (request.headers.authorization !== `Bearer ${TOKEN}`) { response.statusCode = 401; response.end('需要有效的 Bearer 令牌\n'); return; }
    if (request.url === `/run-export/${RUN}/run`) { response.end(JSON.stringify(options.runAnswer ? options.runAnswer(run) : { schema: 'run-export@1', run })); return; }
    if (request.url === `/run-export/${RUN}`) { response.statusCode = 409; response.end('这个运行还没有已受理的提交\n'); return; }
    const found = /^\/run-export\/[^/]+\/sources\/([0-9a-f]{64})$/.exec(request.url ?? '');
    if (found?.[1] === sha(secret)) { response.statusCode = 403; response.end('这份原件在你的读取层级不给字节\n'); return; }
    const bytes = [mindmap, contract].find((value) => found?.[1] === sha(value));
    if (bytes) { response.end(options.tamper && bytes === contract ? Buffer.from('{"contract":2}') : bytes); return; }
    response.statusCode = 404; response.end('没有这个运行或原件\n');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}/mcp`, paths, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}
async function outputOf(run: () => Promise<number>): Promise<{ code: number; stdout: string; stderr: string }> {
  const out: string[] = [], err: string[] = [];
  const stdout = process.stdout.write.bind(process.stdout), stderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array) => { out.push(String(chunk)); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => { err.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try { return { code: await run(), stdout: out.join(''), stderr: err.join('') }; } finally { process.stdout.write = stdout; process.stderr.write = stderr; }
}

test('a run with nothing submitted yet lands on disk: the record, one file per item and every bound original, checked', async (t) => {
  const h = await hub(); t.after(h.close); const out = join(await mkdtemp(join(tmpdir(), 'cc-download-')), 'run');
  const { code, stdout } = await outputOf(() => main(['--hub', h.url, '--run', RUN, '--out', out], async () => TOKEN));
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(stdout), { run: RUN, out, items: 12, sources: 2, withheld: [sha(secret)], written: 16 });
  assert.ok(!h.paths.includes(`/run-export/${RUN}`), 'only the run alone is asked for, which needs no accepted result');
  assert.equal(h.paths.filter((path) => path.endsWith(sha(mindmap))).length, 1, 'a fragment of an original already fetched is not fetched again');
  const record = await readFile(join(out, 'run.json'), 'utf8');
  assert.equal(JSON.parse(record).run, RUN); assert.ok(record.split('\n').length > 50, 'indented, so a file reader goes line by line');
  assert.deepEqual(await readdir(join(out, 'items')), Array.from({ length: 12 }, (_, index) => `${String(index).padStart(2, '0')}.json`));
  assert.equal(JSON.parse(await readFile(join(out, 'items', '07.json'), 'utf8')).fields.atoms[0].content, '合成意图 7');
  assert.deepEqual(await readFile(join(out, 'sources', sha(mindmap))), mindmap);
  assert.deepEqual(await readFile(join(out, 'sources', sha(contract))), contract);
  const bindings = JSON.parse(await readFile(join(out, 'sources.json'), 'utf8'));
  assert.equal(bindings.length, 5);
  assert.deepEqual(bindings[1], { slot: null, role: 'expected', reference: `src:${sha(mindmap)}/kityminder@1/n/abc123`, label: null, media_type: null, file: `sources/${sha(mindmap)}` });
  assert.deepEqual(bindings[3], { slot: 'profile', role: 'expected', reference: `src:${sha(secret)}`, label: null, media_type: null, file: null, withheld: '你的读取层级不给这份原件的字节' });
  assert.equal(bindings[4].file, null, 'a record reference has no original to download');
  const again = await outputOf(() => main(['--hub', h.url, '--run', RUN, '--out', out], async () => TOKEN));
  assert.equal(again.code, 1); assert.match(again.stderr, /已有文件.*不覆盖/);
});

test('bytes that do not match the bound digest write nothing at all', async (t) => {
  const h = await hub({ tamper: true }); t.after(h.close); const out = join(await mkdtemp(join(tmpdir(), 'cc-download-')), 'run');
  const { code, stderr } = await outputOf(() => main(['--hub', h.url, '--run', RUN, '--out', out], async () => TOKEN));
  assert.equal(code, 1); assert.match(stderr, /字节与运行绑定的摘要不符，什么都没有写入/);
  await assert.rejects(readdir(out), 'the directory is not even made');
});

test('another run in the answer, a malformed export or a placeholder token are refused before anything is written', async (t) => {
  const other = await hub({ runAnswer: (run) => ({ schema: 'run-export@1', run: { ...run, run: 'run_01bbbbbbbbbbbbbbbbbbbbbbbb' } }) }); t.after(other.close);
  const out = await mkdtemp(join(tmpdir(), 'cc-download-'));
  assert.match((await outputOf(() => main(['--hub', other.url, '--run', RUN, '--out', join(out, 'a')], async () => TOKEN))).stderr, /不是 --run 指定的/);
  const malformed = await hub({ runAnswer: () => ({ schema: 'something-else' }) }); t.after(malformed.close);
  assert.match((await outputOf(() => main(['--hub', malformed.url, '--run', RUN, '--out', join(out, 'b')], async () => TOKEN))).stderr, /运行导出不合式/);
  assert.match((await outputOf(() => main(['--hub', malformed.url, '--run', RUN, '--out', join(out, 'c')], async () => '%HUB_TOKEN%'))).stderr, /没有存密钥 HUB_TOKEN/);
  assert.deepEqual(await readdir(out), []);
});

test('a directory that already holds something is refused; recompose ships the same tool', async (t) => {
  const h = await hub(); t.after(h.close); const out = await mkdtemp(join(tmpdir(), 'cc-download-'));
  await writeFile(join(out, 'notes.txt'), '已有');
  const { code, stderr } = await outputOf(() => recomposeMain(['--hub', h.url, '--run', RUN, '--out', out], async () => TOKEN));
  assert.equal(code, 1); assert.match(stderr, /notes\.txt.*不覆盖/);
  assert.deepEqual(await readdir(out), ['notes.txt'], 'a refused directory is left as it was');
  const fresh = join(out, 'fresh');
  assert.equal((await outputOf(() => recomposeMain(['--hub', h.url, '--run', RUN, '--out', fresh], async () => TOKEN))).code, 0);
  assert.equal((await readdir(join(fresh, 'items'))).length, 12);
});
