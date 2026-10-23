import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { canonicalBytes, sha256Hex } from '../records/api.ts';
import { workflowPack, withFiles, writePack } from '../runs/packs/testing/builder.ts';
import { createApp } from './app.ts';
import type { CliIo, ServerDeps } from './api.ts';
import { localToolsCommand, verifyLocalTools, localHubAddress } from './cli-local-tools.ts';
import { main } from './cli.ts';
let root: string; let source: Awaited<ReturnType<typeof writePack>>; let app: ReturnType<typeof createApp>; let url: string; const token = 'synthetic-client-token';
const ref = 'synthetic-workflow@10.6.0';
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'tools-client-'));
  const fixture = withFiles(workflowPack({ id: 'synthetic-workflow', version: '10.6.0' }), { 'tools/task.ts': "import '../functions/helper.ts'; export {};\r\n", 'functions/helper.ts': 'export const fixture = 1;\n' });
  source = await writePack(join(root, 'source'), fixture); await writeFile(join(source.dir, 'pack.json'), canonicalBytes(source.manifest));
  const deps = { config: { host: '127.0.0.1', port: 0, limits: { maxRequestBytes: 1024 } }, records: { principals: { authenticate: async (v: string) => v === `Bearer ${token}` ? { id: 'synthetic-user', name: 'synthetic', role: 'user' } : null }, callLog: { append: async () => {} } }, workflows: { forUser: async (_user: unknown, named: string) => named === ref ? { manifest: source.manifest, pack: { digest: source.digest, directory: source.dir } } : null } } as unknown as ServerDeps;
  app = createApp(deps, { codeRoot: root, log: () => {} }); url = (await app.listen()).url;
});
after(async () => { await app?.close(); await rm(root, { recursive: true, force: true }); });
function io(): CliIo & { out: string[]; err: string[] } { const out: string[] = []; const err: string[] = []; return { out, err, cwd: root, env: {}, stdout: (s) => out.push(s), stderr: (s) => err.push(s) }; }
async function install(into: string, digest = source.digest) { const output = io(); const code = await localToolsCommand(['install', ref, '--digest', digest, '--into', into, '--hub', url], output, { input: Readable.from([token + '\n']) }); assert.ok(![...output.out, ...output.err].join('\n').includes(token)); return { ...output, code }; }
test('install writes only fully verified original files and canonical manifest and identical reinstall is idempotent', async () => {
  const into = join(root, 'installed'); const first = await install(into); assert.equal(first.code, 0, first.err.join('\n'));
  const target = join(into, ref); assert.equal((await verifyLocalTools(target)).digest, source.digest);
  for (const file of source.manifest.files) assert.deepEqual(await readFile(join(target, file.path)), await readFile(join(source.dir, file.path)));
  assert.deepEqual(await readFile(join(target, 'pack.json')), Buffer.from(canonicalBytes(source.manifest)));
  assert.deepEqual(await readdir(into), [ref]); const second = await install(into); assert.equal(second.code, 0); assert.match(second.out.join('\n'), /已安装/);
});
test('incorrect pinned digest writes nothing and server corruption leaves no installation or staging directory', async () => {
  const into = join(root, 'wrong-digest'); assert.equal((await install(into, 'f'.repeat(64))).code, 1); await assert.rejects(readdir(into));
  const file = join(source.dir, 'tools/task.ts'); const original = await readFile(file); await writeFile(file, Buffer.from('changed'));
  const badInto = join(root, 'corrupted');
  try { assert.equal((await install(badInto)).code, 1); await assert.rejects(readdir(badInto)); } finally { await writeFile(file, original); }
});
test('changed installed bytes are refused without overwrite and offline verification lists extra files', async () => {
  const into = join(root, 'modified'); assert.equal((await install(into)).code, 0); const target = join(into, ref); const file = join(target, 'tools/task.ts'); await writeFile(file, 'changed');
  const extra = join(target, 'tools/extra.ts'); await writeFile(extra, 'export {};'); const checked = await verifyLocalTools(target);
  assert.equal(checked.ok, false); assert.ok(checked.extras.includes('tools/extra.ts')); assert.equal(checked.digest, source.digest);
  const attempt = await install(into); assert.equal(attempt.code, 1); assert.equal(await readFile(file, 'utf8'), 'changed');
  const output = io(); assert.equal(await localToolsCommand(['verify', target], output), 1); assert.match(output.out.join('\n'), /多出的文件 tools\/extra.ts/); assert.ok(!output.out.join('\n').includes('export'));
});
test('only loopback URLs are accepted and token is never read for invalid destinations', async () => {
  for (const bad of ['http://192.0.2.10', 'http://user:pass@127.0.0.1', 'file:///tmp/fixture', 'http://127.0.0.1/path', 'http://127.0.0.1/?x=y']) assert.throws(() => localHubAddress(bad, {}));
  assert.equal(localHubAddress(undefined, { CIRCLE_HUB_PORT: '7999' }).href, 'http://127.0.0.1:7999/'); assert.equal(localHubAddress('http://localhost:7999', {}).hostname, '127.0.0.1'); assert.equal(localHubAddress('http://[::1]:7999', {}).hostname, '[::1]');
  const output = io(); assert.equal(await localToolsCommand(['install', ref, '--digest', source.digest, '--into', 'no-write', '--hub', 'http://192.0.2.10'], output, { input: Readable.from([token]) }), 1); assert.ok(!output.err.join('\n').includes(token));
});
test('offline verify works through the built-in CLI without loading configuration database assembly or token', async () => {
  const target = join(root, 'installed', ref); const output = io();
  assert.equal(await main(['local-tools', 'verify', target], { io: output, assembly: async () => { throw new Error('must not load'); } }), 0);
  assert.match(output.out.join('\n'), new RegExp(source.digest));
  assert.equal(await localToolsCommand(['install', ref, '--token', token], output), 2); assert.ok(!output.err.join('\n').includes(token));
});
test('existing symbolic-link destinations are refused and never followed', async () => {
  const into = join(root, 'symlinked'); await import('node:fs/promises').then((fs) => fs.mkdir(into)); await symlink(source.dir, join(into, ref));
  assert.equal((await install(into)).code, 1); assert.equal((await verifyLocalTools(join(into, ref))).ok, false);
});

test('client rejects changed wire bytes even with matching response headers and never follows redirects', async () => {
  const { createServer } = await import('node:http'); const { digestHeader } = await import('./local-tools.ts');
  let redirect = false;
  const server = createServer(async (req, res) => {
    if (redirect) { res.writeHead(302, { location: 'http://192.0.2.20/never-contact' }); res.end(); return; }
    const base = `/local-tools/${ref}`;
    const path = req.url === base ? 'pack.json' : (req.url ?? '').slice(base.length + 1);
    const bytes = path === 'tools/task.ts' ? Buffer.from('tampered wire bytes') : await readFile(join(source.dir, path));
    res.writeHead(200, { 'content-digest': digestHeader(bytes), etag: `"${sha256Hex(bytes)}"` }); res.end(bytes);
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done)); const port = (server.address() as import('node:net').AddressInfo).port;
  try {
    for (const mode of ['changed', 'redirect']) {
      redirect = mode === 'redirect'; const output = io(); const into = join(root, `wire-${mode}`);
      const result = await localToolsCommand(['install', ref, '--digest', source.digest, '--into', into, '--hub', `http://127.0.0.1:${port}`], output, { input: Readable.from([token]) });
      assert.equal(result, 1); await assert.rejects(readdir(into)); assert.ok(![...output.out, ...output.err].join('\n').includes(token));
    }
  } finally { await new Promise<void>((done) => server.close(() => done())); }
});
