// Decision 104: the client fetches its run's generation inputs from the Hub with its own token. Synthetic Hub stub only.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { main } from './fetch-run.ts';

const RUN = 'run_01aaaaaaaaaaaaaaaaaaaaaaaa';
const TOKEN = 'synthetic-token-1234';
const sha = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const originals = { contract: Buffer.from('{"contract":1}'), profile: Buffer.from('{"profile":1}'), inventory: Buffer.from('{"inventory":1}') };
async function hub(change: (sources: Map<string, Buffer>) => void = () => {}) {
  const sources = new Map(Object.values(originals).map((bytes) => [sha(bytes), bytes] as const)); change(sources);
  const exported = { schema: 'run-export@1', run: { run: RUN, sources: Object.entries(originals).map(([slot, bytes]) => ({ slot, role: 'expected', reference: `src:${sha(bytes)}` })) }, result: { run: RUN, acceptance: 'accepted' }, submission: { run: RUN, items: [] } };
  const server = createServer((request, response) => {
    if (request.headers.authorization !== `Bearer ${TOKEN}`) { response.statusCode = 401; response.end('需要有效的 Bearer 令牌\n'); return; }
    if (request.url === `/run-export/${RUN}`) { response.end(JSON.stringify(exported)); return; }
    const found = /^\/run-export\/[^/]+\/sources\/([0-9a-f]{64})$/.exec(request.url ?? '');
    const bytes = found ? [...sources.entries()].find(([key]) => key === found[1])?.[1] : undefined;
    if (bytes) { response.end(bytes); return; }
    response.statusCode = 404; response.end('没有这个运行或原件\n');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}/mcp`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

test('fetches the run, result, submission and the three bound originals with the token from standard input', async (t) => {
  const h = await hub(); t.after(h.close); const out = await mkdtemp(join(tmpdir(), 'cc-fetch-'));
  assert.equal(await main(['--hub', h.url, '--run', RUN, '--out', out], async () => TOKEN), 0);
  for (const [slot, bytes] of Object.entries(originals)) assert.deepEqual(await readFile(join(out, `${slot}.json`)), bytes);
  assert.deepEqual(JSON.parse(await readFile(join(out, 'submission.json'), 'utf8')), { run: RUN, items: [] });
  assert.equal(JSON.parse(await readFile(join(out, 'run.json'), 'utf8')).run, RUN);
  assert.equal(await main(['--hub', h.url, '--run', RUN, '--out', out], async () => TOKEN), 1, 'existing files are never overwritten');
});

test('a source whose bytes do not match the bound digest, a missing token and a refused token fail', async (t) => {
  const h = await hub((sources) => { const [key] = [...sources.keys()]; sources.set(key, Buffer.from('changed')); }); t.after(h.close);
  assert.equal(await main(['--hub', h.url, '--run', RUN, '--out', await mkdtemp(join(tmpdir(), 'cc-fetch-'))], async () => TOKEN), 1);
  assert.equal(await main(['--hub', h.url, '--run', RUN, '--out', await mkdtemp(join(tmpdir(), 'cc-fetch-'))], async () => ''), 1);
  assert.equal(await main(['--hub', h.url, '--run', RUN, '--out', await mkdtemp(join(tmpdir(), 'cc-fetch-'))], async () => 'wrong-token-5678'), 1);
});
