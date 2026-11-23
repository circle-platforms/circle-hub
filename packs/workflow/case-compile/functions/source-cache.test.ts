import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile, readdir, rm, symlink, unlink, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchBytesRetrying, downloadRunRetrying } from './hub-retry.ts';
import { sha256 } from './generated/skills/run-tools/hub-client/index.ts';
const bytes = Buffer.from('synthetic immutable source');
const digest = sha256(bytes);
const url = `http://127.0.0.1:1/run-export/run_${'a'.repeat(26)}/sources/${digest}`;
const credential = 'synthetic-cache-credential';
function entry(root: string) { return join(root, 'sources-v1', sha256(Buffer.from(new URL(url).origin + '\0' + credential)), `${digest}.bytes`); }
function control(root: string | false) {
  let calls = 0;
  return { value: { sourceCacheDirectory: root, fetch: async () => { calls++; return new Response(bytes); } }, calls: () => calls };
}
test('low-level source reads are uncached by default and never manufacture an HTTP digest', async () => {
  let calls = 0; const options = { fetch: async () => { calls++; return new Response(bytes); } };
  await fetchBytesRetrying(url, credential, 100, options); await fetchBytesRetrying(url, credential, 100, options);
  assert.equal(calls, 2);
  const root = await mkdtemp(join(tmpdir(), 'cc-cache-off-'));
  try {
    const c = control(root); await fetchBytesRetrying(url, credential, 100, c.value);
    const cached = await fetchBytesRetrying(url, credential, 100, c.value);
    assert.equal(c.calls(), 1); assert.equal(cached.cached, true); assert.equal(cached.digest, null); assert.deepEqual(Buffer.from(cached.bytes), bytes);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('scope includes both origin and credential while state routes and disabled caching always read remotely', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cc-cache-scope-'));
  try {
    const c = control(root); await fetchBytesRetrying(url, credential, 100, c.value);
    await fetchBytesRetrying(url.replace(':1/', ':2/'), credential, 100, c.value);
    await fetchBytesRetrying(url, 'another-synthetic-credential', 100, c.value);
    assert.equal(c.calls(), 3);
    const state = url.replace(/sources\/[a-f0-9]+$/, 'jobs');
    await fetchBytesRetrying(state, credential, 100, c.value); await fetchBytesRetrying(state, credential, 100, c.value); assert.equal(c.calls(), 5);
    await fetchBytesRetrying(url, credential, 100, { ...c.value, sourceCacheDirectory: false }); assert.equal(c.calls(), 6);
    assert.ok(!(await readdir(join(root, 'sources-v1'))).some(name => name.includes(credential)));
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('a corrupt owned regular cache entry refetches and recovers without trusting the corrupt bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cc-cache-repair-'));
  try {
    const c = control(root); await fetchBytesRetrying(url, credential, 100, c.value); await writeFile(entry(root), 'corrupt');
    assert.deepEqual(Buffer.from((await fetchBytesRetrying(url, credential, 100, c.value)).bytes), bytes); assert.equal(c.calls(), 2);
    await fetchBytesRetrying(url, credential, 100, c.value); assert.equal(c.calls(), 2); assert.deepEqual(await readFile(entry(root)), bytes);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('symlinked cache roots and entries are never read through or overwritten', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cc-cache-link-'));
  try {
    const cache = join(root, 'cache'), outside = join(root, 'outside'); await writeFile(outside, 'outside untouched');
    const c = control(cache); await fetchBytesRetrying(url, credential, 100, c.value); await unlink(entry(cache)); await symlink(outside, entry(cache));
    await fetchBytesRetrying(url, credential, 100, c.value); assert.equal(c.calls(), 2); assert.equal(await readFile(outside, 'utf8'), 'outside untouched');
    await unlink(entry(cache)); await link(outside, entry(cache)); await fetchBytesRetrying(url, credential, 100, c.value); assert.equal(c.calls(), 3); assert.equal(await readFile(outside, 'utf8'), 'outside untouched');
    const linkedRoot = join(root, 'linked'); await symlink(cache, linkedRoot); const linked = control(linkedRoot); await fetchBytesRetrying(url, credential, 100, linked.value); assert.equal(linked.calls(), 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('cache hits obey the current read limit and a wrong network source is never cached', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cc-cache-limit-'));
  try {
    const c = control(root); await fetchBytesRetrying(url, credential, 100, c.value);
    await assert.rejects(() => fetchBytesRetrying(url, credential, 1, c.value)); assert.equal(c.calls(), 2);
    const other = join(root, 'wrong'); await assert.rejects(() => fetchBytesRetrying(url, credential, 100, { sourceCacheDirectory: other, fetch: async () => new Response('different source') }));
    assert.deepEqual(await readdir(root), ['sources-v1']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('download reauthenticates current metadata before source reuse and survives explicit cache cleanup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cc-cache-download-'));
  const cache = join(root, 'cache');
  const run = 'run_' + 'a'.repeat(26), origin = 'http://127.0.0.1:1';
  let metadata = 0, sources = 0, deny = false;
  const control = { sourceCacheDirectory: cache, fetch: async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/run')) { metadata++; return deny ? new Response('', { status: 403 }) : Response.json({ schema: 'run-export@1', run: { run, items: [], sources: [{ slot: 'subject', reference: 'src:' + digest, media_type: 'text/plain' }] } }); }
    if (path.includes('/sources/')) { sources++; return new Response(bytes); }
    return new Response('', { status: 404 });
  } };
  try {
    await downloadRunRetrying(origin, credential, run, join(root, 'one'), control);
    await downloadRunRetrying(origin, credential, run, join(root, 'two'), control);
    assert.equal(metadata, 2); assert.equal(sources, 1);
    deny = true;
    await assert.rejects(() => downloadRunRetrying(origin, credential, run, join(root, 'denied'), control));
    assert.equal(metadata, 3); assert.equal(sources, 1);
    deny = false; await rm(cache, { recursive: true });
    await downloadRunRetrying(origin, credential, run, join(root, 'three'), control);
    assert.equal(metadata, 4); assert.equal(sources, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});
