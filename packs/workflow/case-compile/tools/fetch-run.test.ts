// Decision 104: the client fetches its run's generation inputs from the Hub with its own token. Synthetic Hub stub only.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { main } from './fetch-run.ts';

const RUN = 'run_01aaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER = 'run_01bbbbbbbbbbbbbbbbbbbbbbbb';
const TOKEN = 'synthetic-token-1234';
const sha = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const originals = { contract: Buffer.from('{"contract":1}'), profile: Buffer.from('{"profile":1}'), inventory: Buffer.from('{"inventory":1}') };
interface Exported { schema: string; run: { run: string; sources: unknown[] }; result: { run: string; acceptance: string }; submission: { run: string; items: unknown[] } }
async function hub(change: (sources: Map<string, Buffer>) => void = () => {}, alter: (exported: Exported) => void = () => {}) {
  const sources = new Map(Object.values(originals).map((bytes) => [sha(bytes), bytes] as const)); change(sources);
  const exported: Exported = { schema: 'run-export@1', run: { run: RUN, sources: Object.entries(originals).map(([slot, bytes]) => ({ slot, role: 'expected', reference: `src:${sha(bytes)}` })) }, result: { run: RUN, acceptance: 'accepted' }, submission: { run: RUN, items: [] } };
  alter(exported);
  let requests = 0;
  const server = createServer((request, response) => {
    requests++;
    if (request.headers.authorization !== `Bearer ${TOKEN}`) { response.statusCode = 401; response.end('需要有效的 Bearer 令牌\n'); return; }
    if (request.url === `/run-export/${RUN}`) { response.end(JSON.stringify(exported)); return; }
    const found = /^\/run-export\/[^/]+\/sources\/([0-9a-f]{64})$/.exec(request.url ?? '');
    const bytes = found ? [...sources.entries()].find(([key]) => key === found[1])?.[1] : undefined;
    if (bytes) { response.end(bytes); return; }
    response.statusCode = 404; response.end('没有这个运行或原件\n');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}/mcp`, requests: () => requests, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}
async function stderrOf(run: () => Promise<number>): Promise<{ code: number; text: string }> {
  const written: string[] = []; const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => { written.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try { return { code: await run(), text: written.join('') }; } finally { process.stderr.write = write; }
}

test('fetches the run, result, submission and the three bound originals with the token from standard input', async (t) => {
  const h = await hub(); t.after(h.close); const out = await mkdtemp(join(tmpdir(), 'cc-fetch-'));
  assert.equal(await main(['--hub', h.url, '--run', RUN, '--out', out], async () => TOKEN), 0);
  for (const [slot, bytes] of Object.entries(originals)) assert.deepEqual(await readFile(join(out, `${slot}.json`)), bytes);
  assert.deepEqual(JSON.parse(await readFile(join(out, 'submission.json'), 'utf8')), { run: RUN, items: [] });
  assert.equal(JSON.parse(await readFile(join(out, 'run.json'), 'utf8')).run, RUN);
  assert.equal(await main(['--hub', h.url, '--run', RUN, '--out', out], async () => TOKEN), 1, 'existing files are never overwritten');
});

test('an unreachable Hub is reported as unreachable, never as a malformed answer', async () => {
  const closed = createServer(); await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
  const { port } = closed.address() as { port: number }; await new Promise<void>((resolve) => closed.close(() => resolve()));
  const written: string[] = []; const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => { written.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try { assert.equal(await main(['--hub', `http://127.0.0.1:${port}/mcp`, '--run', RUN, '--out', await mkdtemp(join(tmpdir(), 'cc-fetch-'))], async () => TOKEN), 1); }
  finally { process.stderr.write = write; }
  assert.match(written.join(''), /Hub 不可达（ECONNREFUSED）/);
});

test('a source whose bytes do not match the bound digest, a missing token and a refused token fail', async (t) => {
  const h = await hub((sources) => { const [key] = [...sources.keys()]; sources.set(key, Buffer.from('changed')); }); t.after(h.close);
  assert.equal(await main(['--hub', h.url, '--run', RUN, '--out', await mkdtemp(join(tmpdir(), 'cc-fetch-'))], async () => TOKEN), 1);
  assert.equal(await main(['--hub', h.url, '--run', RUN, '--out', await mkdtemp(join(tmpdir(), 'cc-fetch-'))], async () => ''), 1);
  assert.equal(await main(['--hub', h.url, '--run', RUN, '--out', await mkdtemp(join(tmpdir(), 'cc-fetch-'))], async () => 'wrong-token-5678'), 1);
});

test('a secret Circle does not store arrives as its placeholder: nothing is sent and the answer says to store HUB_TOKEN', async (t) => {
  const h = await hub(); t.after(h.close); const out = await mkdtemp(join(tmpdir(), 'cc-fetch-'));
  const { code, text } = await stderrOf(() => main(['--hub', h.url, '--run', RUN, '--out', out], async () => '%HUB_TOKEN%'));
  assert.equal(code, 1); assert.match(text, /Circle 里没有存密钥 HUB_TOKEN/); assert.match(text, /\/secrets HUB_TOKEN/);
  assert.equal(h.requests(), 0, 'the placeholder never reaches the Hub'); assert.deepEqual(await readdir(out), []);
  const missing = await stderrOf(() => main(['--hub', h.url, '--run', RUN, '--out', out], async () => ''));
  assert.equal(missing.code, 1); assert.match(missing.text, /<<'EOF'/); assert.doesNotMatch(missing.text, /<<</);
});

test('an export of another run is refused and nothing is written', async () => {
  for (const alter of [(e: Exported) => { e.run.run = OTHER; }, (e: Exported) => { e.result.run = OTHER; }, (e: Exported) => { e.submission.run = OTHER; }]) {
    const h = await hub(undefined, alter); const out = join(await mkdtemp(join(tmpdir(), 'cc-fetch-')), 'fresh');
    try {
      const { code, text } = await stderrOf(() => main(['--hub', h.url, '--run', RUN, '--out', out], async () => TOKEN));
      assert.equal(code, 1); assert.match(text, new RegExp(`不属于 --run 指定的 ${RUN}`)); assert.equal(existsSync(out), false);
    } finally { await h.close(); }
  }
});

test('a source that fails its digest leaves no file behind, and a directory that already holds an input is left as it was', async (t) => {
  // The last original fails, after the first two were fetched and checked.
  const h = await hub((sources) => { const keys = [...sources.keys()]; sources.set(keys[2], Buffer.from('changed')); }); t.after(h.close);
  const out = join(await mkdtemp(join(tmpdir(), 'cc-fetch-')), 'fresh');
  const failed = await stderrOf(() => main(['--hub', h.url, '--run', RUN, '--out', out], async () => TOKEN));
  assert.equal(failed.code, 1); assert.match(failed.text, /inventory 原件摘要与运行绑定不符/); assert.equal(existsSync(out), false);
  const good = await hub(); t.after(good.close); const taken = await mkdtemp(join(tmpdir(), 'cc-fetch-'));
  await writeFile(join(taken, 'profile.json'), 'kept');
  const refused = await stderrOf(() => main(['--hub', good.url, '--run', RUN, '--out', taken], async () => TOKEN));
  assert.equal(refused.code, 1); assert.match(refused.text, /已有 profile\.json/);
  assert.deepEqual(await readdir(taken), ['profile.json']); assert.equal(await readFile(join(taken, 'profile.json'), 'utf8'), 'kept');
});
