import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { closeSync, openSync } from 'node:fs';
import { lstat, mkdtemp, open, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, PassThrough, Writable } from 'node:stream';
import { test } from 'node:test';
import { FileVault } from '../records/vault.ts';
import { runPlatformCommand } from './cli.ts';
import { ensureLayout, layoutAt } from './layout.ts';
import { DEFAULT_KEY_ACCOUNT, DEFAULT_KEY_SERVICE, fileKeyStore, keyDirectory, VAULT_KEY_ITEM } from './file-key.ts';
import { fdIsKeyPipe, readKeyStdin, writeKeyStdout, importVaultKey, exportVaultKey } from './key-transfer.ts';
import { newSettingsFile, writeSettingsFile } from './settings.ts';
import { captureIo, recordingRunner, removeDir, tempDir } from './test-support.ts';

/** The deployment's vault master key as the platform stores it on every platform: its key file under <root>/keys. */
function keyFile(root: string) {
  const store = fileKeyStore({ root, service: DEFAULT_KEY_SERVICE, account: DEFAULT_KEY_ACCOUNT, item: VAULT_KEY_ITEM });
  return {
    async hex(): Promise<string | undefined> {
      if (!(await store.status()).present) return undefined;
      const bytes = await store.read();
      try { return Buffer.from(bytes).toString('hex'); } finally { bytes.fill(0); }
    },
  };
}

async function deployment(parent: string, name: string) {
  const root = join(parent, name);
  const layout = layoutAt(root);
  await ensureLayout(layout);
  await writeSettingsFile(layout, newSettingsFile({ environment: 'test' }));
  // No host tool may run: the key moves between two key files, never through security or the keychain.
  const system = { ...recordingRunner(() => undefined, { real: false }), key: keyFile(root) };
  const env = { CIRCLE_HUB_DATA_DIR: root };
  const run = async (argv: string[], pipe?: { stdoutIsPipe?: boolean; stdinIsPipe?: boolean; writeKeyBytes?: (bytes: Uint8Array) => void; readKeyBytes?: () => Uint8Array }) => {
    const captured = captureIo(env, parent);
    const code = await runPlatformCommand(argv, { ...captured.io, ...(pipe ? { keyPipe: { stdoutIsPipe: false, stdinIsPipe: false, ...pipe } } : {}) }, { platform: 'darwin', runner: system.runner, home: parent, uid: 501 });
    const text = [...captured.out, ...captured.err].join('\n');
    return { code, text, out: captured.out, err: captured.err };
  };
  return { root, env, system, run };
}

/** Whether any file under `root` holds `needle`, outside the key directories in `keys` (where a key belongs). */
async function contains(root: string, needle: Buffer, keys: readonly string[] = []): Promise<boolean> {
  const pending = [root];
  while (pending.length > 0) {
    const dir = pending.pop()!;
    let names: string[] = [];
    try { names = await readdir(dir); } catch { continue; }
    for (const name of names) {
      const path = join(dir, name);
      const info = await lstat(path);
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) { if (!keys.includes(path)) pending.push(path); }
      else if ((await readFile(path)).includes(needle)) return true;
    }
  }
  return false;
}

test('a key pipe is a fifo, not a regular file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ch-key-pipe-'));
  try {
    const file = join(directory, 'regular');
    const handle = await open(file, 'w', 0o600);
    await handle.close();
    const regular = openSync(file, 'r');
    try { assert.equal(fdIsKeyPipe(regular), false); } finally { closeSync(regular); }
    const fifo = join(directory, 'fifo');
    spawnSync('mkfifo', [fifo]);
    const piped = openSync(fifo, 'r+');
    try { assert.equal(fdIsKeyPipe(piped), true); } finally { closeSync(piped); }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('stdin shorter or longer than a key is refused and wiped', async () => {
  await assert.rejects(readKeyStdin(Readable.from([Buffer.from('short')])));
  await assert.rejects(readKeyStdin(Readable.from([randomBytes(40)])));
  await assert.rejects(readKeyStdin(Readable.from([randomBytes(32), Buffer.alloc(1)])));
  const exact = randomBytes(32), expected = Buffer.from(exact);
  const read = await readKeyStdin(Readable.from([exact]));
  assert.ok(timingSafeEqual(read, expected));
  read.fill(0); expected.fill(0);
});

test('export and import move a raw key only through the pipe and the imported key opens the vault', async () => {
  const parent = await tempDir('ch-key-transfer-');
  const secret = `synthetic-${randomBytes(8).toString('hex')}`;
  const planted = 'ab'.repeat(32);
  try {
    const source = await deployment(parent, 'source');
    const destination = await deployment(parent, 'destination');
    const before = source.system.calls.length;
    const noConfirm = await source.run(['key', 'export']);
    const terminal = await source.run(['key', 'export', '--confirm']);
    const plantedArg = await source.run(['key', 'export', planted]);
    assert.equal(noConfirm.code, 2);
    assert.equal(terminal.code, 1);
    assert.equal(plantedArg.code, 2);
    assert.equal(plantedArg.text.includes(planted), false);
    assert.equal(source.system.calls.length, before, 'a refused export does not read the key');

    assert.equal((await source.run(['key', 'init'])).code, 0);
    const absent = await source.system.key.hex();
    assert.equal(absent?.length, 64);
    const piped: Buffer[] = [];
    const exported = await source.run(['key', 'export', '--confirm'], { stdoutIsPipe: true, writeKeyBytes: (bytes) => { piped.push(Buffer.from(bytes)); } });
    assert.equal(exported.code, 0, exported.text);
    assert.equal(piped.length, 1);
    assert.equal(piped[0]!.length, 32);
    assert.equal(piped[0]!.toString('hex'), absent);
    assert.equal(exported.text.includes(absent!), false);
    assert.equal(exported.out.some((line) => line.includes(absent!)), false);
    for (const call of source.system.calls) assert.equal(call.args.some((arg) => arg.includes(absent!)), false);
    assert.equal(JSON.stringify(source.env).includes(absent!), false);

    const short = await destination.run(['key', 'import'], { stdinIsPipe: true, readKeyBytes: () => Buffer.alloc(31) });
    assert.equal(short.code, 1);
    assert.equal(await destination.system.key.hex(), undefined);
    const callsBeforeRefusedTransport = destination.system.calls.length;
    const typed = await destination.run(['key', 'import']);
    assert.equal(typed.code, 1);
    assert.equal(destination.system.calls.length, callsBeforeRefusedTransport);

    const imported = await destination.run(['key', 'import'], { stdinIsPipe: true, readKeyBytes: () => piped[0]! });
    assert.equal(imported.code, 0, imported.text);
    assert.equal(imported.text.includes(absent!), false);
    assert.equal(await destination.system.key.hex(), absent);
    for (const call of destination.system.calls) assert.equal(call.args.some((arg) => arg.includes(absent!)), false);
    const again = await destination.run(['key', 'import'], { stdinIsPipe: true, readKeyBytes: () => randomBytes(32) });
    assert.equal(again.code, 1);
    assert.match(again.text, /不覆盖/);
    assert.equal(await destination.system.key.hex(), absent);

    assert.ok(piped[0]!.every(byte => byte === 0), 'consumed transport bytes are wiped');
    const provider = { getKey: async () => Buffer.from((await destination.system.key.hex())!, 'hex') };
    const vault = new FileVault(join(parent, 'vault'), provider);
    await vault.put('agile.token', secret);
    assert.equal(await vault.getText('agile.token'), secret);
    assert.deepEqual(await vault.verify(), {checked: 1, failed: 0, unknown: false});
    assert.equal((await readFile(join(parent, 'vault', 'agile.token.sealed'), 'utf8')).includes(secret), false);
    const wrong = { getKey: async () => randomBytes(32) };
    const wrongResult = await new FileVault(join(parent, 'vault'), wrong).verify();
    assert.ok(wrongResult.failed > 0);
    // The key is in the two key files only (0600 under a 0700 directory), never anywhere else under either root.
    assert.equal(await contains(parent, Buffer.from(absent!, 'hex'), [keyDirectory(source.root), keyDirectory(destination.root)]), false);
    for (const root of [source.root, destination.root]) {
      const [file] = await readdir(keyDirectory(root));
      assert.equal((await lstat(keyDirectory(root))).mode & 0o777, 0o700);
      assert.equal((await lstat(join(keyDirectory(root), file!))).mode & 0o777, 0o600);
    }
    assert.deepEqual([...source.system.calls, ...destination.system.calls], [], 'no host tool ran');
    assert.equal(await contains(parent, Buffer.from(secret)), false);
    piped[0]!.fill(0);
  } finally {
    await removeDir(parent);
  }
});

test('real inherited pipe transfers binary key bytes without writing a file or command argument',async()=>{
 const moduleUrl=new URL('./key-transfer.ts',import.meta.url).href;
 const producer=`import {liveKeyPipe} from ${JSON.stringify(moduleUrl)};const io=liveKeyPipe();if(!io.stdoutIsPipe)process.exit(2);const value=Uint8Array.from({length:32},(_,i)=>i);await io.writeKeyBytes(value);value.fill(0);`;
 const consumer=`import {liveKeyPipe} from ${JSON.stringify(moduleUrl)};const io=liveKeyPipe();if(!io.stdinIsPipe)process.exit(2);const value=await io.readKeyBytes();const ok=value.length===32&&value.every((v,i)=>v===i);value.fill(0);process.exitCode=ok?0:3;`;
 const left=spawn(process.execPath,['--input-type=module','-e',producer],{stdio:['ignore','pipe','pipe']});
 const right=spawn(process.execPath,['--input-type=module','-e',consumer],{stdio:['pipe','ignore','pipe']});
 left.stdout.pipe(right.stdin);let errors='';left.stderr.on('data',chunk=>errors+=chunk);right.stderr.on('data',chunk=>errors+=chunk);
 const [a,b]=await Promise.all([new Promise<number|null>(r=>left.on('exit',r)),new Promise<number|null>(r=>right.on('exit',r))]);
 assert.equal(a,0,errors);assert.equal(b,0,errors);assert.equal(errors,'');
});


test('output callback controls key lifetime and timeouts fail closed', async () => {
  const value = Buffer.alloc(32, 19);
  let callback: ((error?: Error | null) => void) | undefined;
  const output = new Writable({write(chunk, _encoding, done) { assert.equal(chunk[0], 19); callback = done; }});
  let complete = false;
  const pending = writeKeyStdout(value, output, 1000).then(() => { complete = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(complete, false); assert.equal(value[0], 19);
  callback!(); await pending;
  const blocked = new Writable({write() {}});
  await assert.rejects(writeKeyStdout(value, blocked, 10), /output failed/);
  assert.equal(blocked.destroyed, true);
  const broken = new Writable({write(_chunk, _encoding, done) { done(new Error('EPIPE synthetic private')); }});
  await assert.rejects(writeKeyStdout(value, broken, 100), /output failed/);
  await new Promise(resolve => setImmediate(resolve));
  const input = new PassThrough();
  await assert.rejects(readKeyStdin(input, 10), /input timed out/);
  input.destroy(); value.fill(0);
});

test('export keeps bytes until callback and overflow import never calls the store writer', async () => {
  const value = Buffer.alloc(32, 29);
  let writes = 0;
  const store = {
    service: 'synthetic', account: 'vault',
    init: async () => {}, delete: async () => false,
    status: async () => ({present: false}),
    read: async () => value,
    write: async (_bytes: Uint8Array) => { writes++; },
  };
  let callback: ((error?: Error | null) => void) | undefined;
  const output = new Writable({write(chunk, _encoding, done) {
    assert.equal(chunk[0], 29); callback = done;
  }});
  const pending = exportVaultKey(store, {
    stdinIsPipe: false, stdoutIsPipe: true,
    writeKeyBytes: bytes => writeKeyStdout(bytes, output, 1000),
  }, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(value[0], 29, 'export cannot wipe bytes before output completes');
  callback!(); await pending;
  assert.ok(value.every(byte => byte === 0));
  await assert.rejects(importVaultKey(store, {
    stdinIsPipe: true, stdoutIsPipe: false,
    readKeyBytes: () => readKeyStdin(Readable.from([Buffer.alloc(32, 29), Buffer.alloc(1, 29)])),
  }), /密钥导入未完成/);
  assert.equal(writes, 0);
});


test('destination can import before source output timeout or EPIPE and must not be overwritten', async () => {
  for (const outcome of ['timeout', 'EPIPE'] as const) {
    const original = Buffer.alloc(32, 37);
    let stored: Buffer | undefined;
    let writes = 0;
    const source = {
      service: 'synthetic', account: 'vault', init: async () => {}, delete: async () => false,
      status: async () => ({present: true}), read: async () => Buffer.from(original),
      write: async (_bytes: Uint8Array) => { throw new Error('source is read-only'); },
    };
    const target = {
      ...source, status: async () => ({present: stored !== undefined}),
      write: async (bytes: Uint8Array) => {
        if (stored) throw new Error('synthetic existing-key diagnostic');
        stored = Buffer.from(bytes); writes++;
      },
    };
    const input = new PassThrough();
    const imported = importVaultKey(target, {
      stdinIsPipe: true, stdoutIsPipe: false, readKeyBytes: () => readKeyStdin(input, 1000),
    });
    const output = new Writable({write(bytes, _encoding, done) {
      // Model transport delivery independently of the source-side acknowledgement.
      input.end(Buffer.from(bytes));
      if (outcome === 'EPIPE') {
        void imported.then(() => done(new Error('EPIPE synthetic private diagnostic')));
      }
      // In the timeout case the destination commits but this callback never arrives.
    }});
    await assert.rejects(exportVaultKey(source, {
      stdinIsPipe: false, stdoutIsPipe: true,
      writeKeyBytes: bytes => writeKeyStdout(bytes, output, 50),
    }, true), (error: unknown) => {
      assert.ok(error instanceof Error);
      const diagnostic = error.message + ('hint' in error ? String(error.hint) : '');
      assert.match(diagnostic, /目标是否已导入未知/);
      assert.match(diagnostic, /key status/);
      assert.match(diagnostic, /records verify --vault/);
      assert.match(diagnostic, /勿盲目重试/);
      assert.equal(diagnostic.includes('synthetic private diagnostic'), false);
      assert.equal(diagnostic.includes(original.toString('hex')), false);
      return true;
    });
    await imported;
    assert.deepEqual(stored, original); assert.equal(writes, 1);
    let readAgain = false;
    await assert.rejects(importVaultKey(target, {
      stdinIsPipe: true, stdoutIsPipe: false,
      readKeyBytes: () => { readAgain = true; return Buffer.alloc(32, 38); },
    }), /已存在，不覆盖/);
    assert.equal(readAgain, false); assert.equal(writes, 1); assert.deepEqual(stored, original);
    stored!.fill(0); original.fill(0);
  }
});
