// Public, byte-accounted normalization only: two leading U+FFFF and a single-element wrapper array.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { isRecord } from '../functions/text.ts';
import { argumentsOf, readBytes, writeNew, sha256 } from './files.ts';
export function normalizeMindmap(bytes: Uint8Array): { bytes: Uint8Array; before_sha256: string; after_sha256: string; transformations: string[] } {
  let text: string; try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { throw new Error('脑图不是完整 UTF-8，不作猜测修复'); }
  const transformations: string[] = [];
  if (text.startsWith('\uffff\uffff')) { text = text.slice(2); transformations.push('删除文件头两个 U+FFFF'); }
  let value: unknown; try { value = JSON.parse(text); } catch { throw new Error('脑图不是有效 JSON；只允许声明的两种规整'); }
  if (Array.isArray(value)) {
    if (value.length !== 1 || !isRecord(value[0])) throw new Error('脑图外层数组必须恰好一个对象');
    // Preserve the original element spelling, including long numeric literals: never JSON-stringify the source body.
    const element = text.trim().slice(1, -1).trim();
    if (isRecord(value[0].root)) { text = element; value = value[0]; }
    else { text = `{"root":${element}}`; value = { root: value[0] }; }
    transformations.push('单元素数组改为 root 对象，元素原文不重写');
  }
  if (!isRecord(value) || !isRecord(value.root) || !isRecord(value.root.data) || value.root.children !== undefined && !Array.isArray(value.root.children)) throw new Error('规整后不是 KityMinder 的 {root:{data,children}} 形状');
  const output = Buffer.from(text, 'utf8'); return { bytes: output, before_sha256: sha256(bytes), after_sha256: sha256(output), transformations };
}
export async function main(argv: string[]): Promise<number> {
  try { const args = argumentsOf(argv, ['in', 'out']); const out = normalizeMindmap(await readBytes(args.in,'in')); await writeNew(args.out, out.bytes); process.stdout.write(JSON.stringify({ before_sha256: out.before_sha256, after_sha256: out.after_sha256, transformations: out.transformations, note: '客户端规整，不改用例内容' }) + '\n'); return 0; }
  catch (error) { process.stderr.write(`规整失败：${error instanceof Error ? error.message : '输入无效'}\n`); return 1; }
}
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) process.exitCode = await main(process.argv.slice(2));
