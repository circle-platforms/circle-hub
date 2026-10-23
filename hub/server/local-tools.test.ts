import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { canonicalBytes, sha256Hex, type CallLogInput } from '../records/api.ts';
import type { ServerDeps } from './api.ts';
import { createApp } from './app.ts';
import { digestHeader } from './local-tools.ts';
const content = Buffer.from('export const fixture = 1;\r\n');
const manifest = { schema: 'pack@1', id: 'fixture-tools', version: '10.6.0', kind: 'product', title: '合成包', description: '合成下载测试', files: [{ path: 'product.json', size: 2, sha256: sha256Hex('{}') }, { path: 'tools/fixture.ts', size: content.length, sha256: sha256Hex(content) }] };
const digest = sha256Hex(canonicalBytes(manifest)); const calls: CallLogInput[] = []; const logs: string[] = [];
let directory: string; let url: string; let app: ReturnType<typeof createApp>; let revoked = false;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'local-tools-')); await mkdir(join(directory, 'tools')); await writeFile(join(directory, 'tools/fixture.ts'), content); await writeFile(join(directory, 'product.json'), '{}'); await writeFile(join(directory, 'pack.json'), canonicalBytes(manifest));
  const deps = { config: { host: '127.0.0.1', port: 0, limits: { maxRequestBytes: 1024 } }, records: { principals: { authenticate: async (token: string) => token === 'Bearer fixture-token' && !revoked ? { id: 'fixture-user', name: 'fixture', role: 'user' } : null }, callLog: { append: async (input: CallLogInput) => { calls.push(input); } } }, workflows: { forUser: async (_user: unknown, ref: string) => ref === 'fixture-tools@10.6.0' ? { pack: { digest, directory }, manifest } : ref === 'no-tools@10.6.0' ? { pack: { digest, directory }, manifest: { ...manifest, files: manifest.files.slice(0, 1) } } : null } } as unknown as ServerDeps;
  app = createApp(deps, { log: (line) => logs.push(line), codeRoot: directory }); url = (await app.listen()).url;
});
after(async () => { await app?.close(); await rm(directory, { recursive: true, force: true }); });
function get(path: string, method = 'GET', token: string | null = 'fixture-token', headers: Record<string, string> = {}) {
  return new Promise<{ status: number; headers: import('node:http').IncomingHttpHeaders; bytes: Buffer }>((resolve, reject) => {
    const req = request(url, { path, method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } }, (res) => { const chunks: Buffer[] = []; res.on('data', (chunk) => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, bytes: Buffer.concat(chunks) })); }); req.on('error', reject); req.end();
  });
}
test('authorized manifest and every listed dependency retain canonical identity and exact bytes', async () => {
  const result = await get('/local-tools/fixture-tools@10.6.0'); assert.equal(result.status, 200); assert.equal(sha256Hex(result.bytes), digest); assert.deepEqual(result.bytes, Buffer.from(canonicalBytes(manifest))); assert.equal(result.headers['content-digest'], digestHeader(result.bytes)); assert.equal(result.headers.etag, `"${digest}"`);
  const file = await get('/local-tools/fixture-tools@10.6.0/tools/fixture.ts'); assert.equal(file.status, 200); assert.deepEqual(file.bytes, content); assert.equal(file.headers['content-digest'], digestHeader(content));
  assert.equal((await get('/local-tools/fixture-tools@10.6.0/product.json')).bytes.toString(), '{}');
});
test('unassigned withdrawn absent no-tool outside traversal and encoded-slash requests have identical answers', async () => {
  const paths = ['unassigned@10.6.0', 'withdrawn@10.6.0', 'absent@10.6.0', 'no-tools@10.6.0', 'fixture-tools@10.6.0/tools/absent.ts', 'fixture-tools@10.6.0/../product.json', 'fixture-tools@10.6.0/tools%2ffixture.ts'];
  const results = await Promise.all(paths.map((path) => get('/local-tools/' + path)));
  for (const result of results) { assert.equal(result.status, 404); assert.deepEqual(result.bytes, results[0]!.bytes); assert.equal(result.headers['content-digest'], undefined); }
});
test('authentication is checked on every request and missing and revoked tokens are identical', async () => {
  const missing = await get('/local-tools/fixture-tools@10.6.0', 'GET', null); revoked = true;
  try { const result = await get('/local-tools/fixture-tools@10.6.0'); assert.equal(result.status, 401); assert.equal(missing.status, 401); assert.deepEqual(result.bytes, missing.bytes); } finally { revoked = false; }
});
test('corrupted file or canonical manifest returns 500 without source bytes', async () => {
  for (const path of ['tools/fixture.ts', 'pack.json']) {
    const original = await readFile(join(directory, path)); await writeFile(join(directory, path), Buffer.concat([original, Buffer.from('x')]));
    try { const result = await get('/local-tools/fixture-tools@10.6.0' + (path === 'pack.json' ? '' : '/' + path)); assert.equal(result.status, 500); assert.ok(!result.bytes.includes(content)); assert.equal(result.headers['content-digest'], undefined); } finally { await writeFile(join(directory, path), original); }
  }
  assert.ok(logs.some((line) => line.includes('存储被改动过')));
});
test('HEAD has no body POST is 405 and shared Host and Origin checks still apply', async () => {
  const head = await get('/local-tools/fixture-tools@10.6.0', 'HEAD'); assert.equal(head.status, 200); assert.equal(head.bytes.length, 0); assert.equal(Number(head.headers['content-length']), canonicalBytes(manifest).length);
  assert.equal((await get('/local-tools/fixture-tools@10.6.0', 'POST')).status, 405);
  assert.equal((await get('/local-tools/fixture-tools@10.6.0', 'GET', 'fixture-token', { origin: 'http://192.0.2.10' })).status, 403);
  assert.equal((await get('/local-tools/fixture-tools@10.6.0', 'GET', 'fixture-token', { host: '192.0.2.10' })).status, 403);
});
test('each endpoint request is logged without raw paths file contents or tokens', async () => {
  const count = calls.length; await get('/local-tools/fixture-tools@10.6.0/tools/fixture.ts'); assert.equal(calls.length, count + 1);
  const last = calls.at(-1)!; assert.equal(last.tool, 'local-tools'); const args = JSON.stringify(last.arguments); assert.ok(!args.includes('fixture') && !args.includes('export')); assert.match(args, /sha256/); assert.ok(!JSON.stringify(calls).includes('fixture-token'));
});
