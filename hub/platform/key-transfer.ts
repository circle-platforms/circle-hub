// Moves the vault master key through a pipe: `circle-hub key export --confirm | ssh <host> circle-hub key import`.
// The bytes are the raw 32-byte key, never hex, never a command argument, never an environment value, and never a
// regular file. A terminal or a file redirect is refused before the key is read. The destination store's write refuses
// to replace an existing key (the macOS keychain store, or the Linux file store of the same KeychainStore interface).
import { fstatSync } from 'node:fs';
import type { Readable } from 'node:stream';
import { PlatformError } from './errors.ts';
import { KEY_BYTES, type KeychainStore } from './keychain.ts';

/** How export and import reach the process streams. Tests supply the pipe ends; they are not the line-oriented stdout. */
export interface KeyPipe {
  /** True only for a FIFO or a socket, never a terminal or a regular file. */
  stdoutIsPipe: boolean;
  /** True only for a FIFO or a socket, never a terminal or a regular file. */
  stdinIsPipe: boolean;
  /** Copies the bytes into the pipe. Must not retain the buffer it is given. */
  writeKeyBytes?: (bytes: Uint8Array) => void;
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

/** Reads one stdin to the end. A buffer longer than the key is wiped and still returned so the caller can refuse it. */
export async function readKeyStdin(input: Readable = process.stdin): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let size = 0;
  let overflow = false;
  for await (const chunk of input) {
    const buffer = Buffer.from(chunk as Uint8Array);
    if (overflow || size + buffer.length > KEY_BYTES) {
      overflow = true;
      buffer.fill(0);
      continue;
    }
    size += buffer.length;
    chunks.push(buffer);
  }
  const all = Buffer.concat(chunks);
  for (const chunk of chunks) chunk.fill(0);
  if (overflow) all.fill(0);
  return all;
}

function copyAndWipe(bytes: Uint8Array, write: (bytes: Uint8Array) => void): void {
  const copy = Buffer.from(bytes);
  try {
    write(copy);
  } finally {
    copy.fill(0);
  }
}

/** Writes the raw key to the pipe. Refuses before reading when the pipe is not a pipe or --confirm was not given. */
export async function exportVaultKey(store: KeychainStore, pipe: KeyPipe, confirmed: boolean): Promise<void> {
  if (!confirmed || !pipe.stdoutIsPipe || pipe.writeKeyBytes === undefined) throw exportRefused();
  const key = Buffer.from(await store.read());
  try {
    if (key.length !== KEY_BYTES) throw new PlatformError('主密钥长度不对，没有写出');
    copyAndWipe(key, pipe.writeKeyBytes);
  } finally {
    key.fill(0);
  }
}

/** Reads a raw key from the pipe and stores it. An existing key is left as it is. The buffer is wiped either way. */
export async function importVaultKey(store: KeychainStore, pipe: KeyPipe): Promise<void> {
  if (!pipe.stdinIsPipe || pipe.readKeyBytes === undefined) throw importRefused();
  const received = Buffer.from(await pipe.readKeyBytes());
  try {
    if (received.length !== KEY_BYTES) throw new PlatformError('标准输入不是 32 字节的主密钥，没有写入');
    await store.write(received);
  } finally {
    received.fill(0);
  }
}

/** The live process pipes. Absent from a captured CLI, so a test cannot write a key to the operator's terminal. */
export function liveKeyPipe(): KeyPipe {
  return {
    stdoutIsPipe: fdIsKeyPipe(1),
    stdinIsPipe: fdIsKeyPipe(0),
    writeKeyBytes(bytes) {
      if (!fdIsKeyPipe(1)) throw exportRefused();
      const copy = Buffer.from(bytes);
      const queued = process.stdout.write(copy);
      if (queued) copy.fill(0);
      else process.stdout.once('drain', () => copy.fill(0));
    },
    readKeyBytes: () => readKeyStdin(),
  };
}
