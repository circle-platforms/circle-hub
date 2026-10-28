// The vault key crosses only a pipe or socket. It is never rendered, logged, placed in argv or environment, or stored in a
// temporary plaintext file. The operator is responsible for the other end of the pipe and its authenticated transport.
import { fstatSync } from 'node:fs';
import type { Readable, Writable } from 'node:stream';
import { KEY_BYTES, type KeychainStore } from './keychain.ts';
import { PlatformError } from './errors.ts';

export interface KeyTransferIo {
  inputIsPipe(): boolean;
  outputIsPipe(): boolean;
  read(): Promise<Uint8Array>;
  write(value: Uint8Array): Promise<void>;
}

function pipeOrSocket(fd: number): boolean {
  try { const stat = fstatSync(fd); return stat.isFIFO() || stat.isSocket(); } catch { return false; }
}

/** The bounded binary channel is separate from ordinary line-oriented CLI output. */
export function processKeyTransferIo(input: Readable = process.stdin, output: Writable = process.stdout): KeyTransferIo {
  return {
    inputIsPipe: () => pipeOrSocket(0),
    outputIsPipe: () => pipeOrSocket(1),
    read: () => new Promise((resolve, reject) => {
      const bytes = Buffer.alloc(KEY_BYTES); let used = 0; let finished = false;
      const finish = (error?: Error) => {
        if (finished) return; finished = true; clearTimeout(timer);
        input.removeListener('data', data); input.removeListener('end', end); input.removeListener('error', failed); input.removeListener('close', closed);
        input.pause();
        if (error) { bytes.fill(0); reject(error); } else resolve(bytes);
      };
      const data = (chunk: Buffer | string) => {
        if (typeof chunk === 'string' || !Buffer.isBuffer(chunk)) { finish(new Error('binary input required')); return; }
        if (used + chunk.length > KEY_BYTES) { chunk.fill(0); finish(new Error('input too long')); return; }
        chunk.copy(bytes, used); used += chunk.length; chunk.fill(0);
      };
      const end = () => finish(used === KEY_BYTES ? undefined : new Error('input too short'));
      const failed = () => finish(new Error('input failed'));
      const closed = () => finish(new Error('input closed'));
      const timer = setTimeout(() => finish(new Error('input timed out')), 30_000);
      input.on('data', data); input.once('end', end); input.once('error', failed); input.once('close', closed); input.resume();
    }),
    write: (value) => new Promise((resolve, reject) => {
      const failed = () => { output.removeListener('error', failed); reject(new Error('output failed')); };
      output.once('error', failed);
      output.write(value, (error) => {
        // On a broken pipe Node may emit 'error' after the write callback. Keep the listener until that event so it cannot
        // become an unhandled process error; the CLI turns either path into the same fixed, non-secret diagnostic.
        if (error) reject(new Error('output failed'));
        else { output.removeListener('error', failed); resolve(); }
      });
    }),
  };
}

/** Refuse before reading either the key store or the input when the transport is unsuitable. */
export async function exportVaultKey(store: KeychainStore, channel: KeyTransferIo): Promise<void> {
  if (!channel.outputIsPipe()) throw new PlatformError('密钥只能输出到管道或套接字，不能输出到终端或文件');
  let value: Uint8Array | undefined;
  try {
    value = await store.read();
    if (value.byteLength !== KEY_BYTES) throw new Error('bad key length');
    await channel.write(value);
  } catch {
    throw new PlatformError('密钥导出未完成；检查主密钥是否可读以及管道是否可用');
  } finally { value?.fill(0); }
}

export async function importVaultKey(store: KeychainStore, channel: KeyTransferIo): Promise<void> {
  if (!channel.inputIsPipe()) throw new PlatformError('密钥只能从管道或套接字读取，不能从终端或文件读取');
  let value: Uint8Array | undefined;
  try {
    if ((await store.status()).present) throw new PlatformError('主密钥已存在，不覆盖');
    value = await channel.read();
    if (value.byteLength !== KEY_BYTES) throw new Error('bad key length');
    await store.write(value);
  } catch (error) {
    if (error instanceof PlatformError && error.message === '主密钥已存在，不覆盖') throw error;
    throw new PlatformError('密钥导入未完成；检查输入长度、管道和密钥存储状态，已有主密钥不会覆盖');
  } finally { value?.fill(0); }
}
