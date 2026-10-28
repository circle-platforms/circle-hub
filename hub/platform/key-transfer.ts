// Moves the vault master key through a pipe: `circle-hub key export --confirm | ssh <host> circle-hub key import`.
// The bytes are the raw 32-byte key, never hex, never a command argument, never an environment value, and never a
// regular file. A terminal or a file redirect is refused before the key is read. The destination store's write refuses
// to replace an existing key (the macOS keychain store, or the Linux file store of the same KeychainStore interface).
import { fstatSync } from 'node:fs';
import type { Readable, Writable } from 'node:stream';
import { PlatformError } from './errors.ts';
import { KEY_BYTES, type KeychainStore } from './keychain.ts';

/** How export and import reach the process streams. Tests supply the pipe ends; they are not the line-oriented stdout. */
export interface KeyPipe {
  /** True only for a FIFO or a socket, never a terminal or a regular file. */
  stdoutIsPipe: boolean;
  /** True only for a FIFO or a socket, never a terminal or a regular file. */
  stdinIsPipe: boolean;
  /** Copies the bytes into the pipe. Must not retain the buffer it is given. */
  writeKeyBytes?: (bytes: Uint8Array) => void | Promise<void>;
  /** Exactly the bytes read from the pipe, or a shorter or longer buffer that import refuses. */
  readKeyBytes?: () => Uint8Array | Promise<Uint8Array>;
}

function exportRefused(): PlatformError {
  return new PlatformError('导出主密钥只在带 --confirm、且标准输出是管道时进行', '用管道传给目标的 circle-hub key import，不要接到终端或文件');
}
function importRefused(): PlatformError {
  return new PlatformError('导入主密钥只从管道读标准输入', '用 circle-hub key export --confirm 的管道作为标准输入，不要在终端里粘贴，也不要从文件重定向');
}

/** True when this file descriptor is a pipe or a socket, so a key would not land on a terminal or in a file. */
export function fdIsKeyPipe(fd: number): boolean {
  try {
    const stat = fstatSync(fd);
    return stat.isFIFO() || stat.isSocket();
  } catch {
    return false;
  }
}

/** Reads at most one key and requires EOF within the deadline. */
export function readKeyStdin(input: Readable = process.stdin, timeoutMs = 30_000): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
      const bytes = Buffer.alloc(KEY_BYTES); let used = 0; let finished = false;
      const finish = (error?: Error) => {
        if (finished) return; finished = true; clearTimeout(timer);
        input.removeListener('data', data); input.removeListener('end', end); input.removeListener('error', failed); input.removeListener('close', closed);
        input.pause();
        if (error) { input.on('error', () => {}); input.destroy(); bytes.fill(0); reject(error); } else resolve(bytes);
      };
      const data = (chunk: Buffer | string) => {
        if (typeof chunk === 'string' || !Buffer.isBuffer(chunk)) { finish(new Error('binary input required')); return; }
        if (used + chunk.length > KEY_BYTES) { chunk.fill(0); finish(new Error('input too long')); return; }
        chunk.copy(bytes, used); used += chunk.length; chunk.fill(0);
      };
      const end = () => finish(used === KEY_BYTES ? undefined : new Error('input too short'));
      const failed = () => finish(new Error('input failed'));
      const closed = () => finish(new Error('input closed'));
      const timer = setTimeout(() => finish(new Error('input timed out')), timeoutMs);
      input.on('data', data); input.once('end', end); input.once('error', failed); input.once('close', closed); input.resume();
    });
}

/** Waits for the write callback; timeout destroys the stream before the key can be wiped. */
export function writeKeyStdout(value: Uint8Array, output: Writable = process.stdout, timeoutMs = 30_000): Promise<void> {
  return new Promise((resolve, reject) => {
    let finished = false;
    // Keep a non-secret listener after failure: Node can emit error after the callback or destroy.
    const absorb = () => {};
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      output.removeListener('error', failed);
      if (error) {
        output.on('error', absorb);
        output.destroy();
        reject(new Error('output failed'));
      } else resolve();
    };
    const failed = () => finish(new Error('output failed'));
    const timer = setTimeout(() => finish(new Error('output timed out')), timeoutMs);
    output.once('error', failed);
    try { output.write(value, error => finish(error ?? undefined)); }
    catch { finish(new Error('output failed')); }
  });
}

/** Writes the raw key to the pipe. Refuses before reading when the pipe is not a pipe or --confirm was not given. */
export async function exportVaultKey(store: KeychainStore, pipe: KeyPipe, confirmed: boolean): Promise<void> {
  if (!confirmed || !pipe.stdoutIsPipe || pipe.writeKeyBytes === undefined) throw exportRefused();
  let key: Uint8Array | undefined;
  try {
    key = await store.read();
    if (key.length !== KEY_BYTES) throw new PlatformError('主密钥长度不对，没有写出');
    await pipe.writeKeyBytes(key);
  } catch {
    throw new PlatformError('密钥导出未完成；目标是否已导入未知', '下一步先在目标运行 circle-hub key status，再用 circle-hub records verify --vault 核验，勿盲目重试');
  } finally {
    key?.fill(0);
  }
}

/** Reads a raw key from the pipe and stores it. An existing key is left as it is. The buffer is wiped either way. */
export async function importVaultKey(store: KeychainStore, pipe: KeyPipe): Promise<void> {
  if (!pipe.stdinIsPipe || pipe.readKeyBytes === undefined) throw importRefused();
  let received: Uint8Array | undefined;
  try {
    if ((await store.status()).present) throw new PlatformError('主密钥已存在，不覆盖');
    received = await pipe.readKeyBytes();
    if (received.length !== KEY_BYTES) throw new Error('invalid input');
    await store.write(received);
  } catch (error) {
    if (error instanceof PlatformError && error.message === '主密钥已存在，不覆盖') throw error;
    throw new PlatformError('密钥导入未完成；检查输入长度、管道和密钥存储状态，已有主密钥不会覆盖');
  } finally {
    received?.fill(0);
  }
}

/** The live process pipes. Absent from a captured CLI, so a test cannot write a key to the operator's terminal. */
export function liveKeyPipe(): KeyPipe {
  return {
    stdoutIsPipe: fdIsKeyPipe(1),
    stdinIsPipe: fdIsKeyPipe(0),
    async writeKeyBytes(bytes) {
      if (!fdIsKeyPipe(1)) throw exportRefused();
      await writeKeyStdout(bytes);
    },
    readKeyBytes: () => readKeyStdin(),
  };
}
