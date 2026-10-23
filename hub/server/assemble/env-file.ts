// Bounded, strict environment-file reader. Only explicitly requested active keys leave this module.
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { CliError } from '../errors.ts';

const LIMIT = 64 * 1024;
export async function readNamedEnvironment(path: string, keys: readonly string[]): Promise<Map<string, string>> {
  let bytes: Buffer;
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > LIMIT) throw new Error();
      bytes = Buffer.alloc(LIMIT + 1);
      let size = 0;
      while (size < bytes.length) {
        const read = await file.read(bytes, size, bytes.length - size, null);
        if (read.bytesRead === 0) break;
        size += read.bytesRead;
      }
      if (size > LIMIT) throw new Error();
      bytes = bytes.subarray(0, size);
    } finally { await file.close(); }
  } catch { throw new CliError('环境文件不可读、不是普通文件或超过 64 KiB'); }
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new CliError('环境文件不是 UTF-8'); }
  if (text.includes('\0')) throw new CliError('环境文件含 NUL');
  const wanted = new Set(keys); const found = new Map<string, string>();
  for (const [i, line] of text.replace(/^\uFEFF/, '').split(/\r?\n/).entries()) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match || !wanted.has(match[1])) continue;
    if (found.has(match[1])) throw new CliError(`环境文件的键 ${match[1]} 在第 ${i + 1} 行重复`);
    found.set(match[1], match[2].replace(/^(["'])(.*)\1$/, '$2'));
  }
  return found;
}
