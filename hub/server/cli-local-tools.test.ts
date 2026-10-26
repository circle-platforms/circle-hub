import assert from 'node:assert/strict';
import { syncBuiltinESMExports } from 'node:module';
import { after, before, test } from 'node:test';
import fsp from 'node:fs/promises';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { canonicalBytes, sha256Hex } from '../records/api.ts';
import { workflowPack, withFiles, writePack } from '../runs/packs/testing/builder.ts';
import { createApp } from './app.ts';
import type { CliIo, ServerDeps } from './api.ts';
import { installLocalTools, localToolsCommand, verifyLocalTools, localHubAddress } from './cli-local-tools.ts';
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
  const output = io(); assert.equal(await localToolsCommand(['verify', target, '--digest', source.digest], output), 1); assert.match(output.out.join('\n'), /多出的文件 tools\/extra.ts/); assert.ok(!output.out.join('\n').includes('export'));
});
test('only loopback URLs are accepted and token is never read for invalid destinations', async () => {
  for (const bad of ['http://192.0.2.10', ["http:/","/user:","pass@1","27.0.0",".1"].join(''), 'file:///tmp/fixture', 'http://127.0.0.1/path', 'http://127.0.0.1/?x=y']) assert.throws(() => localHubAddress(bad, {}));
  assert.equal(localHubAddress(undefined, { CIRCLE_HUB_PORT: '7999' }).href, 'http://127.0.0.1:7999/'); assert.equal(localHubAddress('http://localhost:7999', {}).hostname, '127.0.0.1'); assert.equal(localHubAddress('http://[::1]:7999', {}).hostname, '[::1]');
  const output = io(); assert.equal(await localToolsCommand(['install', ref, '--digest', source.digest, '--into', 'no-write', '--hub', 'http://192.0.2.10'], output, { input: Readable.from([token]) }), 1); assert.ok(!output.err.join('\n').includes(token));
});
test('offline verify works through the built-in CLI without loading configuration database assembly or token', async () => {
  const target = join(root, 'installed', ref); const output = io();
  assert.equal(await main(['local-tools', 'verify', target, '--digest', source.digest], { io: output, assembly: async () => { throw new Error('must not load'); } }), 0);
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

const DIGEST_REQUIRED = '必须给出 --digest <包号>；从控制台任务包页或运行摘要的 pack_digest 抄下包号后再试';

test('verify requires the published digest and names a changed or deleted file', async () => {
  const into = join(root, 'pinned');
  assert.equal((await install(into)).code, 0);
  const target = join(into, ref);
  const missing = io();
  assert.equal(await localToolsCommand(['verify', target], missing), 1);
  assert.equal(missing.err.join('\n'), DIGEST_REQUIRED);
  const bareInstall = io();
  assert.equal(await localToolsCommand(['install', ref, '--into', 'nowhere'], bareInstall), 1);
  assert.equal(bareInstall.err.join('\n'), DIGEST_REQUIRED);
  const file = join(target, 'tools/task.ts');
  const original = await readFile(file);
  await writeFile(file, Buffer.concat([original, Buffer.from(' ')]));
  const changed = io();
  assert.equal(await localToolsCommand(['verify', target, '--digest', source.digest], changed), 1);
  assert.equal(changed.out.join('\n').includes('第一处不符 tools/task.ts'), true);
  assert.equal(changed.out.join('\n').includes('第一处不符 pack.json'), false);
  await rm(file);
  const deleted = io();
  assert.equal(await localToolsCommand(['verify', target, '--digest', source.digest], deleted), 1);
  assert.equal(deleted.out.join('\n').includes('第一处不符 tools/task.ts'), true);
  const fresh = join(root, 'rewritten');
  assert.equal((await install(fresh)).code, 0);
  const copy = join(fresh, ref);
  const bytes = Buffer.from('export const changed = 2;\n');
  await writeFile(join(copy, 'tools/task.ts'), bytes);
  const manifest = JSON.parse(await readFile(join(copy, 'pack.json'), 'utf8')) as { files: { path: string; size: number; sha256: string }[] };
  const entry = manifest.files.find((item) => item.path === 'tools/task.ts');
  assert.ok(entry);
  entry.size = bytes.length;
  entry.sha256 = sha256Hex(bytes);
  const canonical = canonicalBytes(manifest);
  await writeFile(join(copy, 'pack.json'), canonical);
  const drifted = io();
  assert.equal(await localToolsCommand(['verify', copy, '--digest', source.digest], drifted), 1);
  assert.equal(drifted.out.join('\n').includes('第一处不符 pack.json'), true);
  const resigned = io();
  assert.equal(await localToolsCommand(['verify', copy, '--digest', sha256Hex(canonical)], resigned), 0);
});

test('an existing different target is refused with the file path and is not overwritten', async () => {
  const into = join(root, 'different-target');
  assert.equal((await install(into)).code, 0);
  const file = join(into, ref, 'tools/task.ts');
  await writeFile(file, 'changed');
  const attempt = await install(into);
  assert.equal(attempt.code, 1);
  assert.equal(attempt.err.join('\n').includes('第一处不符 tools/task.ts'), true);
  assert.equal(await readFile(file, 'utf8'), 'changed');
});

test('a stopped hub, a bad token and an unassigned pack each say why', async () => {
  const { createServer } = await import('node:http');
  const closed = createServer();
  await new Promise<void>((done) => closed.listen(0, '127.0.0.1', done));
  const port = (closed.address() as import('node:net').AddressInfo).port;
  await new Promise<void>((done) => closed.close(() => done()));
  const unreachable = io();
  assert.equal(await localToolsCommand(['install', ref, '--digest', source.digest, '--into', join(root, 'down'), '--hub', `http://127.0.0.1:${port}`], unreachable, { input: Readable.from([token + '\n']) }), 1);
  assert.equal(unreachable.err.join('\n'), `Hub 连不上 http://127.0.0.1:${port}；确认本机 Hub 已在这个回环地址监听后再试`);
  const denied = io();
  assert.equal(await localToolsCommand(['install', ref, '--digest', source.digest, '--into', join(root, 'denied'), '--hub', url], denied, { input: Readable.from(['wrong-token\n']) }), 1);
  assert.equal(denied.err.join('\n'), '令牌无效或已撤销；重新领取令牌后再试');
  assert.equal(denied.err.join('\n').includes('wrong-token'), false);
  const absent = io();
  assert.equal(await localToolsCommand(['install', 'other-workflow@10.6.0', '--digest', 'ab'.repeat(32), '--into', join(root, 'absent'), '--hub', url], absent, { input: Readable.from([token + '\n']) }), 1);
  assert.equal(absent.err.join('\n'), '这个版本没有分给你、已下架或不存在；向管理员确认分配后再试');
  assert.equal(absent.err.join('\n').includes(token), false);
});

test('a local path that is not a directory reports the filesystem error', async () => {
  const blocker = join(root, 'not-a-directory');
  await writeFile(blocker, 'x');
  const output = io();
  assert.equal(await localToolsCommand(['install', ref, '--digest', source.digest, '--into', blocker, '--hub', url], output, { input: Readable.from([token + '\n']) }), 1);
  const err = output.err.join('\n');
  assert.equal(err.startsWith('本地目录无法写入 '), true);
  assert.equal(err.includes('（ENOTDIR）'), true);
  assert.equal(err.includes('第一处不符'), false);
  assert.equal(err.includes(token), false);
});

test('loopback downloads do not send the token through an environment proxy', async () => {
  const { createServer } = await import('node:http');
  const hits: string[] = [];
  const proxy = createServer((req, res) => {
    hits.push(req.url ?? 'request');
    res.writeHead(502);
    res.end();
  });
  proxy.on('connect', (req, socket) => {
    hits.push(`CONNECT ${req.url ?? ''}`);
    socket.destroy();
  });
  await new Promise<void>((done) => proxy.listen(0, '127.0.0.1', done));
  const port = (proxy.address() as import('node:net').AddressInfo).port;
  const previous = { NODE_USE_ENV_PROXY: process.env.NODE_USE_ENV_PROXY, HTTP_PROXY: process.env.HTTP_PROXY, http_proxy: process.env.http_proxy, HTTPS_PROXY: process.env.HTTPS_PROXY, https_proxy: process.env.https_proxy };
  process.env.NODE_USE_ENV_PROXY = '1';
  process.env.HTTP_PROXY = `http://127.0.0.1:${port}`;
  process.env.http_proxy = process.env.HTTP_PROXY;
  process.env.HTTPS_PROXY = process.env.HTTP_PROXY;
  process.env.https_proxy = process.env.HTTP_PROXY;
  try {
    const result = await install(join(root, 'proxied'));
    assert.equal(result.code, 0, result.err.join('\n'));
    assert.deepEqual(hits, []);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await new Promise<void>((done) => proxy.close(() => done()));
  }
});

test('a leftover lock and a dead staging directory are removed and a live one is kept', async () => {
  const { spawn } = await import('node:child_process');
  const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)']);
  const dead = sleeper.pid;
  assert.equal(typeof dead, 'number');
  sleeper.kill('SIGKILL');
  await new Promise((resolve) => sleeper.once('exit', resolve));
  const into = join(root, 'stuck');
  await mkdir(into);
  await mkdir(join(into, `.${ref}.install-lock`));
  const staging = join(into, `.${ref}-dead`);
  await mkdir(staging);
  await writeFile(join(staging, '.install-owner'), `${dead}\n`);
  await writeFile(join(staging, 'partial'), 'x');
  const live = join(into, `.${ref}-live`);
  await mkdir(live);
  await writeFile(join(live, '.install-owner'), `${process.pid}\n`);
  const result = await install(into);
  assert.equal(result.code, 0, result.err.join('\n'));
  const names = await readdir(into);
  assert.equal(names.includes(ref), true);
  assert.equal(names.includes(`.${ref}.install-lock`), false);
  assert.equal(names.includes(`.${ref}-dead`), false);
  assert.equal(names.includes(`.${ref}-live`), true);
  await rm(live, { recursive: true, force: true });
});

test('an install interrupted mid-download leaves nothing that blocks the next one', async () => {
  const { createServer } = await import('node:http');
  const { spawn } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const { digestHeader } = await import('./local-tools.ts');
  let releaseFile: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { releaseFile = resolve; });
  let fileRequested = false;
  const server = createServer(async (req, res) => {
    const base = `/local-tools/${ref}`;
    const path = req.url === base ? 'pack.json' : (req.url ?? '').slice(base.length + 1);
    if (path !== 'pack.json') { fileRequested = true; await gate; }
    const bytes = await readFile(join(source.dir, path));
    res.writeHead(200, { 'content-digest': digestHeader(bytes), etag: `"${sha256Hex(bytes)}"` });
    res.end(bytes);
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const port = (server.address() as import('node:net').AddressInfo).port;
  const into = join(root, 'interrupted');
  const repo = fileURLToPath(new URL('../../', import.meta.url));
  let childErr = '';
  const child = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', '-e', `
    import { Readable } from 'node:stream';
    import { localToolsCommand } from './hub/server/cli-local-tools.ts';
    const code = await localToolsCommand(${JSON.stringify(['install', ref, '--digest', source.digest, '--into', into, '--hub', `http://127.0.0.1:${port}`])}, { cwd: ${JSON.stringify(root)}, env: {}, stdout() {}, stderr() {} }, { input: Readable.from([${JSON.stringify(token + '\n')}]) });
    process.exit(code);
  `], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.on('data', (chunk) => { childErr += chunk; });
  const prefix = `.${ref}-`;
  try {
    let downloading = false;
    for (let i = 0; i < 50; i += 1) {
      if (fileRequested) { downloading = true; break; }
      if (child.exitCode !== null || child.signalCode !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(downloading, true, childErr);
    child.kill('SIGINT');
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
    const names = await readdir(into).catch(() => [] as string[]);
    assert.equal(names.some((name) => name.startsWith(prefix) || name === `.${ref}.install-lock`), false, `${names.join(',')} ${childErr}`);
    assert.equal(exit.code === 130 || exit.signal === 'SIGINT', true, JSON.stringify(exit));
    const again = await install(into);
    assert.equal(again.code, 0, again.err.join('\n'));
    assert.deepEqual(await readdir(into), [ref]);
  } finally {
    releaseFile?.();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await new Promise((resolve) => child.once('exit', resolve));
    }
    await new Promise<void>((done) => server.close(() => done()));
  }
});

test('a concurrent install keeps a live staging directory that has no owner file yet or anymore', async () => {
  const realMkdtemp = fsp.mkdtemp;
  const realRm = fsp.rm;
  const hub = new URL(url);
  const settle = <T>(promise: Promise<T>) => promise.then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));
  try {
    for (const phase of ['before-owner-write', 'before-verify'] as const) {
      let ready!: () => void;
      let release!: () => void;
      const entered = new Promise<void>((resolve) => { ready = resolve; });
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let held = false;
      const into = join(root, `race-${phase}`);
      if (phase === 'before-owner-write') {
        fsp.mkdtemp = (async (...args: Parameters<typeof realMkdtemp>) => {
          const path = await Reflect.apply(realMkdtemp, fsp, args) as string;
          if (!held && String(args[0]).startsWith(into)) { held = true; ready(); await gate; }
          return path;
        }) as typeof fsp.mkdtemp;
      } else {
        fsp.rm = (async (...args: Parameters<typeof realRm>) => {
          const value = await Reflect.apply(realRm, fsp, args);
          if (!held && String(args[0]).endsWith('.install-owner') && String(args[0]).startsWith(into)) { held = true; ready(); await gate; }
          return value;
        }) as typeof fsp.rm;
      }
      syncBuiltinESMExports();
      const first = settle(installLocalTools(ref, source.digest, into, hub, token));
      await entered;
      const second = await settle(installLocalTools(ref, source.digest, into, hub, token));
      release();
      const answer = await first;
      fsp.mkdtemp = realMkdtemp;
      fsp.rm = realRm;
      syncBuiltinESMExports();
      const detail = (error: unknown) => error instanceof Error ? error.message : String(error);
      assert.equal(answer.ok, true, answer.ok ? '' : detail(answer.error));
      assert.equal(second.ok, true, second.ok ? '' : detail(second.error));
      assert.equal((await verifyLocalTools(join(into, ref))).ok, true);
    }
  } finally {
    fsp.mkdtemp = realMkdtemp;
    fsp.rm = realRm;
    syncBuiltinESMExports();
  }
});
