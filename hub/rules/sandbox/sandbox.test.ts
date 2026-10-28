// Adversarial tests of the pack-function sandbox. Every pack here is synthetic and written to a temporary directory.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { SandboxError } from './errors.ts';
import { isolatedCommand, NODE, osIsolationAvailable } from './isolation.ts';
import { callPackFunction, type SandboxLimits } from './sandbox.ts';

// Real path: on macOS the temporary directory sits behind the /var symbolic link, which the permission model will not follow.
const root = realpathSync(mkdtempSync(join(tmpdir(), 'hub-rules-sandbox-')));
let counter = 0;
let os = false;

/** A pack directory with the given files (paths relative to the pack). */
function pack(files: Record<string, string>): string {
  const dir = join(root, `pack-${++counter}`);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

const call = (dir: string, input: unknown = null, limits: Partial<SandboxLimits> = {}, exportName?: string, module = 'fn.ts') =>
  callPackFunction({ packDir: dir, module, export: exportName }, input, limits, { requireOsIsolation: os });

async function failure(promise: Promise<unknown>): Promise<SandboxError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof SandboxError, `expected SandboxError, got ${String(error)}`);
    return error;
  }
  assert.fail('expected the call to fail');
}

/**
 * Kills every process whose command line names `dir` (the sandboxed child of one call and the shells that carry it) and
 * returns how many were killed: an exit by signal, without a result frame, for the tests that need one.
 */
async function killChildren(dir: string): Promise<number> {
  const listing = (): Promise<string> =>
    new Promise((resolve) => {
      const ps = spawn('/bin/ps', ['-eo', 'pid=,command='], { stdio: ['ignore', 'pipe', 'ignore'] });
      let text = '';
      ps.stdout.setEncoding('utf8');
      ps.stdout.on('data', (chunk: string) => (text += chunk));
      ps.on('error', () => resolve(text));
      ps.on('close', () => resolve(text));
    });
  for (let round = 0; round < 100; round++) {
    const pids: number[] = [];
    for (const line of (await listing()).split('\n')) {
      const match = /^\s*(\d+)\s+(.*)$/.exec(line);
      // The child's command line carries the pack directory as one read allowance; a sibling pack whose name starts with
      // the same characters must not match, so the allowance has to end there.
      const command = match?.[2] ?? '';
      const allowance = `--allow-fs-read=${dir}`;
      if (match !== null && (command.includes(`${allowance} `) || command.endsWith(allowance))) pids.push(Number(match[1]));
    }
    if (pids.length > 0) {
      for (const pid of pids) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // Already gone.
        }
      }
      return pids.length;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return 0;
}

/** A loopback server that counts connections, to prove a denial against a port that really listens. */
async function listening(): Promise<{ server: Server; port: number; connections: () => number }> {
  let connections = 0;
  const server = createServer((socket) => {
    connections += 1;
    socket.on('error', () => {
      // The probe hangs up at once; a reset is expected.
    });
    socket.end('hello');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return { server, port: address.port, connections: () => connections };
}

before(async () => {
  os = await osIsolationAvailable();
});

after(() => rmSync(root, { recursive: true, force: true }));

describe('pack functions that behave', () => {
  it('returns JSON output, captures stdout, loads declared dependencies, JSON data and pure builtins', async () => {
    const dir = pack({
      'fn.ts': [
        "import { z } from 'zod';",
        "import { SaxesParser } from 'saxes';",
        "import { parse } from 'parse5';",
        "import { gzipSync, strToU8 } from 'fflate';",
        "import { createHash } from 'node:crypto';",
        "import { posix } from 'node:path';",
        "import table from './data/table.json' with { type: 'json' };",
        'export default function (input: { name: string }) {',
        "  console.log('working');",
        '  const name = z.object({ name: z.string() }).parse(input).name;',
        '  let tags = 0;',
        '  const p = new SaxesParser();',
        '  p.on("opentag", () => tags++);',
        '  p.write("<a><b/></a>").close();',
        '  return { name, tags, html: parse("<p>x</p>").childNodes.length, gz: gzipSync(strToU8("abc")).length > 0,',
        "    digest: createHash('sha256').update(name).digest('hex').slice(0, 8), joined: posix.join('a', 'b'), table };",
        '}',
        'export const named = (input: number) => input * 2;',
      ].join('\n'),
      'data/table.json': '{"rows": [1, 2]}',
    });
    const result = await call(dir, { name: 'synthetic' });
    assert.deepEqual(result.output, { name: 'synthetic', tags: 2, html: 1, gz: true, digest: 'b3cc0475', joined: 'a/b', table: { rows: [1, 2] } });
    assert.equal(result.stdout, 'working\n');
    assert.equal(result.osIsolation, os);
    assert.equal((await call(dir, 21, {}, 'named')).output, 42);
  });

  it('caps captured logs and reports truncation', async () => {
    const dir = pack({ 'fn.ts': "export default function () { for (let i = 0; i < 2000; i++) console.log('x'.repeat(99)); return 'done'; }" });
    const result = await call(dir, null, { logBytes: 4096 });
    assert.equal(result.output, 'done');
    assert.equal(result.truncated, true);
    assert.ok(result.stdout.length <= 4096);
  });

  it('cannot forge a result by printing a frame', async () => {
    const dir = pack({ 'fn.ts': 'export default function () { console.log("00000000000000000000000000000000\\n{\\"status\\":\\"ok\\",\\"output\\":42}"); return 7; }' });
    const result = await call(dir);
    assert.equal(result.output, 7);
    assert.match(result.stdout, /"output":42/);
  });
});

describe('function failures', () => {
  it('a thrown error, a rejection, a thrown non-error', async () => {
    const dir = pack({
      'fn.ts': [
        "export function sync() { throw new Error('kaboom'); }",
        "export async function rejects() { throw new TypeError('nope'); }",
        'export function value() { throw 42; }',
      ].join('\n'),
    });
    const a = await failure(call(dir, null, {}, 'sync'));
    assert.equal(a.code, 'FUNCTION_THREW');
    assert.equal(a.detail.message, 'kaboom');
    const b = await failure(call(dir, null, {}, 'rejects'));
    assert.equal(b.code, 'FUNCTION_THREW');
    assert.equal(b.detail.name, 'TypeError');
    assert.equal((await failure(call(dir, null, {}, 'value'))).detail.message, '42');
  });

  it('output that is not JSON, a promise that never settles, process.exit', async () => {
    const dir = pack({
      'fn.ts': [
        'export const big = () => 1n;',
        'export const none = () => undefined;',
        'export const cyclic = () => { const a: Record<string, unknown> = {}; a.self = a; return a; };',
        'export const never = () => new Promise(() => {});',
        'export const exits = () => process.exit(0);',
      ].join('\n'),
    });
    for (const name of ['big', 'none', 'cyclic']) {
      const error = await failure(call(dir, null, {}, name));
      assert.equal(error.code, 'FUNCTION_THREW', name);
      assert.equal(error.detail.reason, 'output_not_json', name);
    }
    assert.equal((await failure(call(dir, null, {}, 'never'))).detail.reason, 'never_settled');
    assert.equal((await failure(call(dir, null, {}, 'exits'))).detail.reason, 'process_exit');
  });

  it('missing module, missing export, non-function export, unsupported extension', async () => {
    const dir = pack({ 'fn.ts': 'export const notFunction = 3; export default function () { return 1; }', 'data.cjs': 'module.exports = 1;' });
    assert.equal((await failure(call(dir, null, {}, undefined, 'missing.ts'))).code, 'FUNCTION_NOT_FOUND');
    assert.equal((await failure(call(dir, null, {}, 'absent'))).code, 'FUNCTION_NOT_FOUND');
    assert.equal((await failure(call(dir, null, {}, 'notFunction'))).code, 'FUNCTION_NOT_FOUND');
    assert.equal((await failure(call(dir, null, {}, undefined, 'data.cjs'))).code, 'FUNCTION_NOT_FOUND');
    assert.equal((await failure(call(dir, null, {}, 'bad-name'))).code, 'FUNCTION_NOT_FOUND');
    assert.equal((await failure(call(join(root, 'no-such-pack'), null))).code, 'FUNCTION_NOT_FOUND');
  });

  it('refuses input that is not JSON before starting a child', async () => {
    const dir = pack({ 'fn.ts': 'export default (x: unknown) => x;' });
    await assert.rejects(call(dir, 1n), TypeError);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    await assert.rejects(call(dir, cyclic), TypeError);
    await assert.rejects(call(dir, 'x'.repeat(4096), { inputBytes: 1024 }), RangeError);
  });

  it('a violation recorded while the result or a thrown value is read is still reported as a violation', async () => {
    const attempt = "try { (process as unknown as { binding: (n: string) => unknown }).binding('fs'); } catch { /* hidden? */ }";
    const dir = pack({
      'output.ts': `export default () => ({ toJSON() { ${attempt} throw new Error('after the attempt'); } });`,
      'message.ts': `export default () => { throw { get message() { ${attempt} return 'x'; } }; };`,
      'code.ts': `export default () => { throw { get code() { ${attempt} return 'E_OTHER'; } }; };`,
    });
    for (const module of ['output.ts', 'message.ts', 'code.ts']) {
      const error = await failure(call(dir, null, {}, undefined, module));
      assert.equal(error.code, 'SANDBOX_VIOLATION', module);
      assert.equal(error.detail.what, 'process.binding', module);
    }
  });

  it('a CommonJS pack module is refused', async () => {
    const dir = pack({ 'fn.js': 'module.exports = function () { return require("node:fs").readdirSync("/"); };' });
    const error = await failure(call(dir, null, {}, undefined, 'fn.js'));
    assert.equal(error.code, 'SANDBOX_VIOLATION');
    assert.match(String(error.detail.what), /format commonjs/);
  });
});

describe('boundaries', () => {
  it('fetch() to a listening loopback server fails and the server sees no connection', async () => {
    const { server, port, connections } = await listening();
    try {
      const dir = pack({
        'fn.ts': `export default async function () { const r = await fetch('http://127.0.0.1:${port}/'); return r.status; }`,
        'ws.ts': `export default function () { return new WebSocket('ws://127.0.0.1:${port}/'); }`,
        'dispatch.ts': [
          'export default function () {',
          "  new Response('loads the HTTP client');",
          "  const d = (globalThis as Record<symbol, { dispatch: (o: unknown, h: unknown) => unknown }>)[Symbol.for('undici.globalDispatcher.1')];",
          `  return d.dispatch({ origin: 'http://127.0.0.1:${port}', path: '/', method: 'GET' }, {});`,
          '}',
        ].join('\n'),
      });
      const error = await failure(call(dir));
      assert.equal(error.code, 'SANDBOX_VIOLATION');
      assert.equal(error.detail.what, 'fetch');
      assert.equal((await failure(call(dir, null, {}, undefined, 'ws.ts'))).code, 'SANDBOX_VIOLATION');
      assert.equal((await failure(call(dir, null, {}, undefined, 'dispatch.ts'))).code, 'SANDBOX_VIOLATION');
      assert.equal(connections(), 0);
    } finally {
      server.close();
    }
  });

  it('a socket to a listening loopback server fails and the server sees no connection', async () => {
    const { server, port, connections } = await listening();
    try {
      const dir = pack({
        'builtin.ts': `export default function () { const net = process.getBuiltinModule('node:net') as typeof import('node:net'); net.connect(${port}, '127.0.0.1'); return 1; }`,
        'imported.ts': `export default async function () { const net = await import('node:net'); net.connect(${port}, '127.0.0.1'); return 1; }`,
        'http.ts': `export default async function () { const http = await import('node:http'); http.get('http://127.0.0.1:${port}/'); return 1; }`,
        'handle.ts': [
          '// Reaching a native pipe or socket handle through the standard streams.',
          'export default function () {',
          '  const handle = (process.stdout as unknown as { _handle?: { constructor: new (t: number) => unknown } })._handle;',
          "  if (!handle) throw new Error('no handle');",
          '  return String(new handle.constructor(0));',
          '}',
        ].join('\n'),
      });
      for (const module of ['builtin.ts', 'imported.ts', 'http.ts']) {
        assert.equal((await failure(call(dir, null, {}, undefined, module))).code, 'IMPORT_NOT_DECLARED', module);
      }
      assert.equal((await failure(call(dir, null, {}, undefined, 'handle.ts'))).code, 'FUNCTION_THREW');
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(connections(), 0);
    } finally {
      server.close();
    }
  });

  it('a file write fails and leaves no file', async () => {
    const target = join(root, `written-${counter}.txt`);
    const dir = pack({
      'fn.ts': `export default function () { (process.getBuiltinModule('node:fs') as typeof import('node:fs')).writeFileSync(${JSON.stringify(target)}, 'x'); return 1; }`,
      'report.ts': `export default function () { return process.report.writeReport(${JSON.stringify(join(root, 'report.json'))}); }`,
    });
    assert.equal((await failure(call(dir))).code, 'IMPORT_NOT_DECLARED');
    assert.equal((await failure(call(dir, null, {}, undefined, 'report.ts'))).code, 'SANDBOX_VIOLATION');
    assert.equal(existsSync(target), false);
    assert.equal(existsSync(join(root, 'report.json')), false);
  });

  it('spawning a process, signalling the parent and native bindings fail', async () => {
    const dir = pack({
      'static.ts': "import { spawnSync } from 'node:child_process'; export default function () { return spawnSync('/bin/echo', ['x']).status; }",
      'dynamic.ts': "export default async function () { const cp = await import('node:child_process'); return cp.execSync('id').toString(); }",
      'kill.ts': "export default function () { process.kill(process.ppid, 'SIGKILL'); return 'sent'; }",
      'debug.ts': 'export default function () { (process as unknown as { _debugProcess: (pid: number) => void })._debugProcess(process.ppid); return 1; }',
      'binding.ts': "export default function () { return (process as unknown as { binding: (n: string) => unknown }).binding('spawn_sync'); }",
      'worker.ts': "export default async function () { const w = await import('node:worker_threads'); return new w.Worker('1', { eval: true }).threadId; }",
    });
    const static_ = await failure(call(dir, null, {}, undefined, 'static.ts'));
    assert.equal(static_.code, 'IMPORT_NOT_DECLARED');
    assert.equal(static_.detail.what, 'node:child_process');
    assert.equal((await failure(call(dir, null, {}, undefined, 'dynamic.ts'))).code, 'IMPORT_NOT_DECLARED');
    assert.equal((await failure(call(dir, null, {}, undefined, 'kill.ts'))).code, 'SANDBOX_VIOLATION');
    assert.equal((await failure(call(dir, null, {}, undefined, 'debug.ts'))).code, 'SANDBOX_VIOLATION');
    assert.equal((await failure(call(dir, null, {}, undefined, 'binding.ts'))).code, 'SANDBOX_VIOLATION');
    assert.equal((await failure(call(dir, null, {}, undefined, 'worker.ts'))).code, 'IMPORT_NOT_DECLARED');
  });

  it('an undeclared package fails, even an installed one, and catching the error does not hide it', async () => {
    const dir = pack({
      'pg.ts': "import pg from 'pg'; export default function () { return typeof pg; }",
      'absent.ts': "export default async function () { await import('left-pad'); return 1; }",
      'caught.ts': "export default async function () { try { await import('node:fs'); } catch { /* ignored */ } return 'fine'; }",
      'data.ts': "export default async function () { return (await import('data:text/javascript,export default 1')).default; }",
      'own-modules.ts': "import x from 'shadow'; export default function () { return x; }",
      'node_modules/shadow/package.json': '{"name":"shadow","type":"module","main":"index.js"}',
      'node_modules/shadow/index.js': 'export default 1;',
    });
    for (const module of ['pg.ts', 'absent.ts', 'caught.ts', 'data.ts', 'own-modules.ts']) {
      assert.equal((await failure(call(dir, null, {}, undefined, module))).code, 'IMPORT_NOT_DECLARED', module);
    }
  });

  it('reading outside the pack fails: ../, absolute paths, symbolic links and hard links', async () => {
    const outside = join(root, 'outside');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'secret.json'), '{"secret": true}');
    const dir = pack({
      'up.ts': "export default async function () { return (await import('../outside/secret.json', { with: { type: 'json' } })).default; }",
      'absolute.ts': `export default async function () { return (await import(${JSON.stringify(join(outside, 'secret.json'))}, { with: { type: 'json' } })).default; }`,
      'url.ts': "export default async function () { return (await import('file:///etc/hosts')).default; }",
    });
    for (const module of ['up.ts', 'absolute.ts', 'url.ts']) {
      const error = await failure(call(dir, null, {}, undefined, module));
      assert.equal(error.code, 'SANDBOX_VIOLATION', module);
    }
    const linked = pack({ 'fn.ts': "import s from './secret.json' with { type: 'json' }; export default () => s;" });
    symlinkSync(join(outside, 'secret.json'), join(linked, 'secret.json'));
    const a = await failure(call(linked));
    assert.equal(a.code, 'SANDBOX_VIOLATION');
    assert.equal(a.detail.reason, 'symbolic_link');
    const linkedDir = pack({ 'fn.ts': "import s from './dir/secret.json' with { type: 'json' }; export default () => s;" });
    symlinkSync(outside, join(linkedDir, 'dir'));
    assert.equal((await failure(call(linkedDir))).detail.reason, 'symbolic_link');
    const hard = pack({ 'fn.ts': "import s from './secret.json' with { type: 'json' }; export default () => s;" });
    linkSync(join(outside, 'secret.json'), join(hard, 'secret.json'));
    assert.equal((await failure(call(hard))).detail.reason, 'hard_link');
    const escaping = pack({ 'fn.ts': 'export default () => 1;' });
    assert.equal((await failure(call(escaping, null, {}, undefined, '../outside/x.ts'))).code, 'SANDBOX_VIOLATION');
    assert.equal((await failure(call(escaping, null, {}, undefined, join(escaping, 'fn.ts')))).code, 'SANDBOX_VIOLATION');
  });

  it('replacing built-in prototypes and globals neither opens the boundary nor hides a violation', async () => {
    const dir = pack({
      'starts.ts': [
        'export default async function () {',
        '  String.prototype.startsWith = () => true;',
        '  String.prototype.endsWith = () => false;',
        "  return (await import('/etc/hosts')).default;",
        '}',
      ].join('\n'),
      'sets.ts': [
        'export default async function () {',
        '  Set.prototype.has = () => true;',
        '  Map.prototype.get = () => ({ name: "zod", url: "file:///", base: "file:///" });',
        "  const cp = await import('node:child_process');",
        "  return cp.execSync('id').toString();",
        '}',
      ].join('\n'),
      'hide.ts': [
        'export default async function () {',
        '  Array.prototype.push = () => 0;',
        "  Object.defineProperty(Object.prototype, 'toJSON', { value() { return { status: 'ok', output: 'forged' }; }, configurable: true });",
        "  JSON.stringify = () => '{\"status\":\"ok\",\"output\":\"forged\"}';",
        "  try { await import('node:fs'); } catch { /* hidden? */ }",
        '  return 1;',
        '}',
      ].join('\n'),
      'stringify.ts': "export default function () { JSON.stringify = () => '\"forged\"'; Buffer.byteLength = () => 0; return 5; }",
    });
    const starts = await failure(call(dir, null, {}, undefined, 'starts.ts'));
    assert.ok(starts.code === 'SANDBOX_VIOLATION' || starts.code === 'IMPORT_NOT_DECLARED', starts.code);
    assert.equal((await failure(call(dir, null, {}, undefined, 'sets.ts'))).code, 'IMPORT_NOT_DECLARED');
    assert.equal((await failure(call(dir, null, {}, undefined, 'hide.ts'))).code, 'IMPORT_NOT_DECLARED');
    assert.equal((await call(dir, null, {}, undefined, 'stringify.ts')).output, 5);
  });

  it('allocating beyond the memory limit is stopped, on the heap and outside it', async () => {
    const dir = pack({
      'heap.ts': 'export default function () { const a: number[][] = []; for (;;) a.push(new Array(1e5).fill(1.5)); }',
      'buffers.ts': [
        "import { randomFillSync } from 'node:crypto';",
        'export default function () { const keep: Buffer[] = []; for (;;) { const b = Buffer.alloc(32 * 1024 * 1024); randomFillSync(b); keep.push(b); } }',
      ].join('\n'),
    });
    for (const module of ['heap.ts', 'buffers.ts']) {
      const error = await failure(call(dir, null, { memoryMb: 64, timeoutMs: 20_000 }, undefined, module));
      assert.equal(error.code, 'SANDBOX_VIOLATION', module);
      assert.equal(error.detail.limit, 'memory', module);
      // The cause is a measurement of the parent's poller, not a sentence of the child's: the observed bytes are kept.
      assert.equal(typeof error.detail.residentBytes, 'number', module);
    }
  });

  it('text about the heap in the streams is not a memory observation', async () => {
    // Reproduces the retired rule: a child that died without a result frame while the runtime's heap message stood in its
    // stderr was reported as a memory limit on the strength of that text alone. Only a measurement of the parent's own
    // poller may name the limit; an exit without a frame reports the exit and says the resource observation is absent.
    const dir = pack({
      'victim.ts': [
        'export default function () {',
        '  const until = Date.now() + 30_000;',
        '  while (Date.now() < until) { /* hold the call open until the test kills this child */ }',
        '  return 1;',
        '}',
      ].join('\n'),
      'printer.ts': "export default function () { process.stderr.write('FATAL ERROR: Reached heap limit - JavaScript heap out of memory\\n'); return 7; }",
      'liar.ts': "export default function () { process.stderr.write('Reached heap limit\\n'); throw new Error('JavaScript heap out of memory'); }",
    });
    const pending = failure(call(dir, null, { memoryMb: 1024, timeoutMs: 60_000 }, undefined, 'victim.ts'));
    const killed = await killChildren(dir);
    assert.ok(killed > 0, 'the sandboxed child of this pack was not found among the processes');
    const aborted = await pending;
    assert.equal(aborted.code, 'SANDBOX_VIOLATION');
    assert.equal(aborted.detail.reason, 'signal');
    assert.notEqual(aborted.detail.limit, 'memory');
    assert.equal(aborted.detail.resourceObservation, 'absent');
    // The same words from a function's own stream are carried as data: the call succeeds and no reason is derived.
    const printed = await call(dir, null, {}, undefined, 'printer.ts');
    assert.equal(printed.output, 7);
    assert.ok(printed.stderr.includes('heap out of memory'), printed.stderr);
    const threw = await failure(call(dir, null, {}, undefined, 'liar.ts'));
    assert.equal(threw.code, 'FUNCTION_THREW');
    assert.notEqual(threw.detail.limit, 'memory');
  });

  it('an infinite loop is killed at the time limit', async () => {
    const dir = pack({ 'fn.ts': 'export default function () { for (;;) {} }' });
    const started = Date.now();
    const error = await failure(call(dir, null, { timeoutMs: 1000 }));
    assert.equal(error.code, 'SANDBOX_TIMEOUT');
    assert.ok(Date.now() - started < 5000);
  });

  it('100 MB of output fails, as a result and as printed text', async () => {
    const dir = pack({
      'result.ts': "export default function () { return 'x'.repeat(100 * 1024 * 1024); }",
      'printed.ts': "export default function () { process.stdout.write('y'.repeat(100 * 1024 * 1024)); return 1; }",
      'logged.ts': "export default function () { const line = 'z'.repeat(1024 * 1024); for (let i = 0; i < 100; i++) console.error(line); return 1; }",
    });
    for (const module of ['result.ts', 'printed.ts', 'logged.ts']) {
      const error = await failure(call(dir, null, { memoryMb: 768, timeoutMs: 30_000 }, undefined, module));
      assert.equal(error.code, 'SANDBOX_OUTPUT_TOO_LARGE', module);
    }
  });

  it('the parent keeps working after failures, also with several at once', async () => {
    const dir = pack({
      'ok.ts': 'export default (x: number) => x + 1;',
      'loop.ts': 'export default function () { for (;;) {} }',
      'boom.ts': "export default function () { throw new Error('x'); }",
      'net.ts': "export default async function () { await import('node:net'); return 1; }",
    });
    const results = await Promise.allSettled([
      call(dir, 1, {}, undefined, 'ok.ts'),
      call(dir, null, { timeoutMs: 800 }, undefined, 'loop.ts'),
      call(dir, null, {}, undefined, 'boom.ts'),
      call(dir, null, {}, undefined, 'net.ts'),
      call(dir, 41, {}, undefined, 'ok.ts'),
    ]);
    assert.deepEqual(
      results.map((r) => (r.status === 'fulfilled' ? r.value.output : (r.reason as SandboxError).code)),
      [2, 'SANDBOX_TIMEOUT', 'FUNCTION_THREW', 'IMPORT_NOT_DECLARED', 42],
    );
    assert.equal((await call(dir, 9, {}, undefined, 'ok.ts')).output, 10);
  });

  it('a call waiting for a slot holds no serialized copy of its input', async () => {
    const dir = pack({
      'slow.ts': 'export default () => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 800); return 1; };',
      'echo.ts': 'export default (x: unknown) => x;',
    });
    // Sixteen holders fill every slot (at most eight) and the queue in front of the waiter.
    const holders = Array.from({ length: 16 }, () => call(dir, null, {}, undefined, 'slow.ts'));
    await new Promise((resolve) => setTimeout(resolve, 300));
    const started = Date.now();
    let serializedAfter: number | undefined;
    const input = {
      toJSON() {
        serializedAfter ??= Date.now() - started;
        return 'payload';
      },
    };
    const waiter = call(dir, input, {}, undefined, 'echo.ts');
    try {
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(serializedAfter, undefined, 'not serialized while it waits');
      assert.equal((await waiter).output, 'payload');
      assert.deepEqual(
        (await Promise.all(holders)).map((r) => r.output),
        Array(16).fill(1),
      );
      assert.ok(serializedAfter !== undefined && serializedAfter >= 300, `serialized after ${serializedAfter} ms`);
    } finally {
      // Settle every call before the directory is removed, also when an assertion failed.
      await Promise.allSettled([...holders, waiter]);
    }
  });
});

describe('isolation layers', () => {
  /** Runs a probe script (outside the bootstrap, so without its JS lockdown) under the sandbox command line. */
  function probe(source: string, isolated: { os: boolean } | null): Promise<Record<string, string>> {
    const dir = pack({ 'probe.mjs': source });
    const entry = join(dir, 'probe.mjs');
    const command = isolated
      ? isolatedCommand({ entry, reads: [dir], heapMb: 256, cpuSeconds: 10, os: isolated.os })
      : { command: NODE, args: [entry], os: false };
    return new Promise((resolve, reject) => {
      const child = spawn(command.command, command.args, { cwd: dir, env: {}, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (err += d));
      child.on('error', reject);
      child.on('close', () => {
        try {
          resolve(JSON.parse(out) as Record<string, string>);
        } catch {
          reject(new Error(`probe printed ${JSON.stringify(out)} ${err}`));
        }
      });
    });
  }

  const probeSource = (port: number, target: string, secret: string): string =>
    [
      "import net from 'node:net';",
      "import { writeFileSync, readFileSync } from 'node:fs';",
      "import { spawnSync } from 'node:child_process';",
      'const result = {};',
      'const attempt = (name, fn) => { try { result[name] = String(fn()); } catch (e) { result[name] = e.code ?? e.message; } };',
      `attempt('write', () => { writeFileSync(${JSON.stringify(target)}, 'x'); return 'ok'; });`,
      "attempt('spawn', () => { const r = spawnSync('/bin/echo', ['x']); if (r.error) throw r.error; return 'ok'; });",
      `attempt('read', () => { readFileSync(${JSON.stringify(secret)}); return 'ok'; });`,
      'await new Promise((done) => {',
      `  const s = net.connect(${port}, '127.0.0.1');`,
      "  s.on('connect', () => { result.connect = 'ok'; s.destroy(); done(); });",
      "  s.on('error', (e) => { result.connect = e.code; done(); });",
      '});',
      'process.stdout.write(JSON.stringify(result));',
    ].join('\n');

  it('without isolation the probe connects, writes, spawns and reads (the control)', async () => {
    const { server, port, connections } = await listening();
    const secret = join(root, 'probe-secret.txt');
    writeFileSync(secret, 's');
    try {
      const result = await probe(probeSource(port, join(root, `control-${counter}.txt`), secret), null);
      assert.deepEqual(result, { write: 'ok', spawn: 'ok', read: 'ok', connect: 'ok' });
      assert.equal(connections(), 1);
    } finally {
      server.close();
    }
  });

  it('the permission model alone denies writes, spawns and reads but not the network (Node 24)', async () => {
    const { server, port, connections } = await listening();
    const secret = join(root, 'probe-secret.txt');
    writeFileSync(secret, 's');
    try {
      const target = join(root, `permission-${counter}.txt`);
      const result = await probe(probeSource(port, target, secret), { os: false });
      assert.equal(result.write, 'ERR_ACCESS_DENIED');
      assert.equal(result.spawn, 'ERR_ACCESS_DENIED');
      assert.equal(result.read, 'ERR_ACCESS_DENIED');
      assert.equal(result.connect, 'ok', 'if this fails, Node now restricts the network itself: update the README');
      assert.equal(connections(), 1);
      assert.equal(existsSync(target), false);
    } finally {
      server.close();
    }
  });

  it('with sandbox-exec the connection to a listening loopback server is denied', async (t) => {
    if (!os) return t.skip('sandbox-exec is not available here');
    const { server, port, connections } = await listening();
    const secret = join(root, 'probe-secret.txt');
    writeFileSync(secret, 's');
    try {
      const target = join(root, `os-${counter}.txt`);
      const result = await probe(probeSource(port, target, secret), { os: true });
      assert.equal(result.connect, process.platform === 'linux' ? 'EACCES' : 'EPERM');
      assert.equal(result.write, 'ERR_ACCESS_DENIED');
      assert.equal(result.spawn, 'ERR_ACCESS_DENIED');
      assert.equal(result.read, 'ERR_ACCESS_DENIED');
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(connections(), 0);
      assert.equal(existsSync(target), false);
    } finally {
      server.close();
    }
  });

  it('without sandbox-exec the default refuses to run', async (t) => {
    if (os) return t.skip('sandbox-exec is available here');
    const dir = pack({ 'fn.ts': 'export default () => 1;' });
    const error = await failure(callPackFunction({ packDir: dir, module: 'fn.ts' }, null));
    assert.equal(error.code, 'SANDBOX_UNAVAILABLE');
  });
});
