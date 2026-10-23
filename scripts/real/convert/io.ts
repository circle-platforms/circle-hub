// Offline staging only. Never log source values or exception messages.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join, resolve, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
export const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
export class FactError extends Error {}
export function requireFact(ok: unknown, message: string): asserts ok { if (!ok) throw new FactError(message); }
export const sha256 = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');
export const jsonBytes = (value: unknown): string => JSON.stringify(value, null, 2) + '\n';
export const readJson = (file: string): unknown => JSON.parse(readFileSync(file, 'utf8'));
export function staging(directory: string): string {
  requireFact(directory, '缺少 --out 暂存目录；指定仓库外的新目录');
  const target = resolve(directory); let ancestor = target;
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  let current = realpathSync(ancestor);
  for (;;) {
    requireFact(!existsSync(join(current, '.git')), '输出目录位于仓库；改用仓库外的暂存目录');
    const parent = dirname(current); if (parent === current) break; current = parent;
  }
  mkdirSync(target, { recursive: true, mode: 0o700 });
  return realpathSync(target);
}
export function output(directory: string, file: string, value: Uint8Array | string): void {
  requireFact(basename(file) === file, '输出文件必须是暂存目录中的文件名');
  writeFileSync(join(staging(directory), file), value, { flag: 'wx', mode: 0o600 });
}
export function summary(count: number, bytes: Uint8Array | string, doc?: { name: string; file: string }): void {
  process.stdout.write(JSON.stringify({ count, sha256: sha256(bytes) }) + '\n');
  if (doc) process.stdout.write(`circle-hub doc put ${doc.name} ${doc.file}\n`);
}
export function argumentsOf(args: string[], positional: number, flags: string[]): { files: string[]; options: Record<string, string> } {
  const files: string[] = []; const options: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith('--')) {
      requireFact(flags.includes(arg) && options[arg] === undefined, '参数不认识或重复；查看 README 用法');
      const next = args[++i]; requireFact(next && !next.startsWith('--'), '参数缺值；查看 README 用法'); options[arg] = next;
    } else files.push(arg);
  }
  requireFact(files.length === positional, '输入文件个数不符；查看 README 用法');
  return { files, options };
}
export function main(url: string, fn: (args: string[]) => void): void {
  if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === url) {
    try { fn(process.argv.slice(2)); } catch (error) {
      // Only our own fact errors are safe; input/parser/OS errors may contain deployment values.
      process.stderr.write((error instanceof FactError ? error.message : '转换未完成；核对输入形状、身份和暂存目录；详见 README') + '\n'); process.exitCode = 1;
    }
  }
}
