import { formatClientCallError } from '../functions/client-cli.ts';
// Public, byte-accounted normalization only: the KityMinder export head (U+FFFF then U+FEFF, bytes EF BF BF EF BB BF, as the
// platform's local export writes it) or two leading U+FFFF, and a single-element wrapper array.
import { realpathSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { CallFailure, isRecord, parseCliOptions } from '../functions/text.ts';
import { sha256 } from '../functions/generated/skills/run-tools/hub-client/index.ts';
export function normalizeMindmap(bytes: Uint8Array): { bytes: Uint8Array; before_sha256: string; after_sha256: string; transformations: string[] } {
  let text: string; try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { throw new CallFailure("invalid_parameters", '脑图不是完整 UTF-8，不作猜测修复', "重新导出完整 UTF-8 脑图后再规整，不手改或猜补无效字节"); }
  const transformations: string[] = [];
  if (text.startsWith('\uffff\ufeff')) { text = text.slice(2); transformations.push('删除 KityMinder 导出文件头 U+FFFF U+FEFF'); }
  else if (text.startsWith('\uffff\uffff')) { text = text.slice(2); transformations.push('删除文件头两个 U+FFFF'); }
  let value: unknown; try { value = JSON.parse(text); } catch { throw new CallFailure("invalid_parameters", '脑图不是有效 JSON；只允许声明的两种规整', "重新导出有效 JSON；仅支持移除已声明文件头和单元素外层数组"); }
  if (Array.isArray(value)) {
    if (value.length !== 1 || !isRecord(value[0])) throw new CallFailure("invalid_parameters", '脑图外层数组必须恰好一个对象', "提供单个脑图对象，或只含该对象的单元素数组后重试");
    // Preserve the original element spelling, including long numeric literals: never JSON-stringify the source body.
    const element = text.trim().slice(1, -1).trim();
    if (isRecord(value[0].root)) { text = element; value = value[0]; }
    else { text = `{"root":${element}}`; value = { root: value[0] }; }
    transformations.push('单元素数组改为 root 对象，元素原文不重写');
  }
  if (!isRecord(value) || !isRecord(value.root) || !isRecord(value.root.data) || value.root.children !== undefined && !Array.isArray(value.root.children)) throw new CallFailure("invalid_parameters", '规整后不是 KityMinder 的 {root:{data,children}} 形状', "提供包含 root.data 对象及可选 children 数组的原始脑图后重试");
  const output = Buffer.from(text, 'utf8'); return { bytes: output, before_sha256: sha256(bytes), after_sha256: sha256(output), transformations };
}
export async function main(argv: string[]): Promise<number> {
  try { const args = parseCliOptions(argv, { in: true, out: true }, 'normalize-mindmap.ts --in <原始脑图> --out <新文件>'); const bytes = await readFile(args.in!); if (bytes.length > 16 * 1024 * 1024) throw new CallFailure('invalid_parameters', '--in 原始脑图超过 16 MiB 上限', '提供 16 MiB 以内的完整单份脑图后重试', { path: args.in }); const out = normalizeMindmap(bytes); await writeFile(args.out!, out.bytes, { flag: 'wx', mode: 0o600 }); process.stdout.write(JSON.stringify({ before_sha256: out.before_sha256, after_sha256: out.after_sha256, transformations: out.transformations, note: '客户端规整，不改用例内容' }) + '\n'); return 0; }
  catch (error) { process.stderr.write(formatClientCallError(error) + '\n'); return 1; }
}
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) process.exitCode = await main(process.argv.slice(2));
