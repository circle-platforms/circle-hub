// Local-file CLI helpers only. They never read environment variables or contact a service.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
export const sha256 = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
export class InputFileError extends Error {readonly argument:string;readonly reason:'read'|'json'|'size';constructor(argument:string,reason:'read'|'json'|'size'){super(`${reason==='read'?'无法读取':reason==='json'?'不是完整的 UTF-8 JSON':'超过 16 MiB 上限'}：--${argument} 指定的输入；重新导出该运行对应输入的原始字节`);this.name='InputFileError';this.argument=argument;this.reason=reason;}}
export async function readBytes(path: string, argument='input'): Promise<Uint8Array> {
  let bytes: Buffer; try { bytes = await readFile(path); } catch { throw new InputFileError(argument,'read'); }
  if (bytes.length > 16 * 1024 * 1024) throw new InputFileError(argument,'size');
  return bytes;
}
export function jsonBytes(bytes: Uint8Array, argument='input'): unknown { try { return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)); } catch { throw new InputFileError(argument,'json'); } }
export async function writeNew(path: string, bytes: Uint8Array): Promise<void> { try { await writeFile(path, bytes, { flag: 'wx', mode: 0o600 }); } catch { throw new Error('输出文件无法新建；不覆盖已有文件，请另选中性文件名'); } }
export function argumentsOf(argv: string[], required: readonly string[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) { const key = argv[i]; if (!key?.startsWith('--') || !argv[i + 1] || Object.hasOwn(values, key.slice(2))) throw new Error('参数必须是唯一的 --名字 文件'); values[key.slice(2)] = argv[i + 1]; }
  if (required.some((name) => !values[name]) || Object.keys(values).some((key) => !required.includes(key))) throw new Error(`需要参数：${required.map((key) => '--' + key).join('、')}`);
  return values;
}
