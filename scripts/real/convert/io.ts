// Offline staging only. Never log source values or exception messages.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
export const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
interface ParserProblem { pointer: string; message?: string; fix?: string }
interface ParserDetails { component: string; problems: ReadonlyArray<ParserProblem> }
export class FactError extends Error {
  readonly diagnostics?: ReadonlyArray<ParserDetails>;
  constructor(message: string, diagnostics?: ReadonlyArray<ParserDetails>) { super(message); this.diagnostics = diagnostics; }
}
export function requireFact(ok: unknown, message: string): asserts ok { if (!ok) throw new FactError(message); }
export const sha256 = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');
export const jsonBytes = (value: unknown): string => JSON.stringify(value, null, 2) + '\n';
export function readJson(file: string, label = '输入'): unknown {
  let bytes: string;
  try { bytes = readFileSync(file, 'utf8'); } catch { throw new FactError(`${label}文件不可读；请集成者核对本次参数的路径和读取权限，补齐原件后重跑`); }
  try { return JSON.parse(bytes); } catch { throw new FactError(`${label}文件的 JSON 语法不完整；请集成者重新导出完整原件后重跑，不从损坏文本猜内容`); }
}
/** Only the two runtime parsers publish fixed safe messages; manifest details remain private. */
export function parserDiagnostics(component: string, problems: ReadonlyArray<ParserProblem>, next: string): string {
  const fields = new Set('schema complete beds name devices type product ipv4 ipv6 installed build base services host ip proto port reserved runtime minimum_version contract_sha256 source_hashes entries objects e f status signature parameters required optional kind default dispatch minimum_runtime source path line status_authority execute_actions atlas_snapshot certification synthetic bed device_count max_wait_seconds fold_newlines workbook sheet header identity_marker range_name closing_row autoid_pattern seats object method device ordinal hosts allowed denied reviewed'.split(' '));
  const safe = (pointer: string) => pointer === '' ? '整份' : pointer.split('/').map((part, i) => i === 0 ? '' : fields.has(part) || /^\d+$/.test(part) ? part : '<字段>').join('/');
  const runtime = component === 'runtime-contract' || component === 'runtime-profile';
  const rows = problems.length ? problems : [{ pointer: '' }];
  return rows.map(problem => {
    const field = problem.pointer.split('/').at(-1);
    const action = runtime && (field === 'dispatch' || field === 'status' || field === 'kind') ? '集成者只读核对原件与 case-compile 格式表；确需扩展则另开格式表任务，发布后新开运行'
      : runtime && field === 'contract_sha256' ? '集成者重新只读取得网关钉住的原合约与摘要，核对同一副本后重跑'
      : runtime ? [problem.fix, next].filter(Boolean).join('；') : next;
    return `${component} ${safe(problem.pointer)}：${runtime ? problem.message ?? '缺少解析器问题说明' : '清单字段约束未满足，完整原因见私有 parser-diagnostics.json'}；下一步：${action}`;
  }).join('\n');
}
export function parserRefusal(component: string, problems: ReadonlyArray<ParserProblem>, next: string): FactError {
  return new FactError(parserDiagnostics(component, problems, next), component === 'runtime-contract' || component === 'runtime-profile' ? undefined : [{ component, problems }]);
}
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
  let entry = false;
  try { entry = !!process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(url)); } catch { /* An imported helper need not have a file argv entry. */ }
  if (entry) {
    try { fn(process.argv.slice(2)); } catch (error) {
      // Only our own fact errors are safe; input/parser/OS errors may contain deployment values.
      const code = error !== null && typeof error === 'object' && 'code' in error ? String(error.code) : '';
      const diagnosis = code === 'ENOENT' || code === 'EACCES' ? '本命令的输入或暂存路径不可读；请集成者补齐指定文件并核对路径权限后重跑' : code === 'EEXIST' ? '暂存输出已存在；请集成者换一个新暂存目录重跑，不覆盖原件' : error instanceof SyntaxError ? '输入 JSON 语法不完整；请集成者重新导出完整原件后重跑' : '转换步骤未完成；请集成者按 README 核对本命令的输入格式和完整原件后重跑，不猜补缺失字段';
      if (error instanceof FactError && error.diagnostics) {
        const index = process.argv.indexOf('--out');
        try { output(index >= 0 ? process.argv[index + 1] ?? '' : '', 'parser-diagnostics.json', jsonBytes(error.diagnostics)); }
        catch { process.stderr.write('解析器完整问题列表未能保存；请集成者指定可写的新 --out 暂存目录后重跑，不覆盖已有记录\n'); }
      }
      process.stderr.write((error instanceof FactError ? error.message : diagnosis) + '\n'); process.exitCode = 1;
    }
  }
}
