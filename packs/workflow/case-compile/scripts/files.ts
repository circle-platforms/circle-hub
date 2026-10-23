// Local-file CLI helpers only. They never read environment variables or contact a service.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
export const sha256 = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
export async function readBytes(path: string): Promise<Uint8Array> {
  let bytes: Buffer; try { bytes = await readFile(path); } catch { throw new Error('无法读取输入文件'); }
  if (bytes.length > 16 * 1024 * 1024) throw new Error('输入文件超过本地脚本的 16 MiB 上限');
  return bytes;
}
export function jsonBytes(bytes: Uint8Array): unknown { try { return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)); } catch { throw new Error('输入文件不是完整的 UTF-8 JSON'); } }
export async function writeNew(path: string, bytes: Uint8Array): Promise<void> { try { await writeFile(path, bytes, { flag: 'wx', mode: 0o600 }); } catch { throw new Error('输出文件无法新建；不覆盖已有文件，请另选中性文件名'); } }
export function argumentsOf(argv: string[], required: readonly string[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) { const key = argv[i]; if (!key?.startsWith('--') || !argv[i + 1] || Object.hasOwn(values, key.slice(2))) throw new Error('参数必须是唯一的 --名字 文件'); values[key.slice(2)] = argv[i + 1]; }
  if (required.some((name) => !values[name]) || Object.keys(values).some((key) => !required.includes(key))) throw new Error(`需要参数：${required.map((key) => '--' + key).join('、')}`);
  return values;
}
