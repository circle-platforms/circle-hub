// 只读生成可直接原文传给 Circle 内置 general-purpose 子代理（task 工具）的任务说明：
//   node <技能目录>/tools/task-brief.ts --role <用例重组|写计划|保真核对|失败分析> --case <用例或范围> --brief <简报或输入路径> --out <目标文件路径> [--scope <范围文件>] [--note <补充说明>]
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderTaskBrief, resolveSubagentRole } from '../functions/subagent-roles.ts';
import { formatCallError, parseCliOptions } from '../functions/text.ts';
import { resolveCwdRoots, resolveExistingFileInsideCwd, resolveInsideCwd } from './workspace-path.ts';

const OPTIONS: Record<string, boolean> = {
  role: true,
  case: true,
  brief: true,
  out: true,
  scope: false,
  note: false,
};
const USAGE =
  'node <技能目录>/tools/task-brief.ts --role <用例重组|写计划|保真核对|失败分析> --case <用例或范围> --brief <简报或输入路径> --out <目标文件路径> [--scope <范围文件>] [--note <补充说明>]';
const DEFAULT_SCOPE = 'scope.md';
const MAX_SCOPE_BYTES = 16_384;
const DEFAULT_PACK_ROOT = realpathSync(resolve(fileURLToPath(new URL('..', import.meta.url))));

export interface BuildTaskBriefOptions {
  role: string;
  caseRef: string;
  briefPath: string;
  outPath: string;
  scopePath?: string;
  note?: string;
  cwd?: string;
  packRoot?: string;
}

function readVerifiedScopeText(scopeBytes: Buffer, scopeRelative: string): string {
  if (scopeBytes.byteLength > MAX_SCOPE_BYTES) {
    throw new Error(
      `参数无效：范围文件 ${scopeRelative} 超过 ${MAX_SCOPE_BYTES} 字节上限（实际 ${scopeBytes.byteLength} 字节）。请精简为使用者原话后重试`,
    );
  }
  if (scopeBytes.includes(0)) {
    throw new Error(`参数无效：范围文件 ${scopeRelative} 包含空字节，不是有效 UTF-8 文本。请改写纯文本范围文件后重试`);
  }
  const text = scopeBytes.toString('utf8');
  const meaningful = text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^#{1,6}(?:\s|$)/.test(line));
  if (!meaningful.length) {
    throw new Error(
      `参数无效：范围文件 ${scopeRelative} 为空或只有标题，缺少使用者原话。请先逐字写入使用者的范围原话后再派发`,
    );
  }
  return text;
}

function resolveRelativeTarget(cwdRoot: ReturnType<typeof resolveCwdRoots>, value: string, flag: string, hint: string): string {
  const resolved = resolveInsideCwd(cwdRoot, value, flag, hint);
  if (resolved.relative === '.') {
    throw new Error(`参数无效：${flag} 必须指向工作目录下的具体文件或子路径（${hint}）。请修改参数后重试`);
  }
  return resolved.relative;
}

/**
 * Validates the subagent role, workspace-contained paths, and verbatim `scope.md`
 * recorded by the main session, then renders a complete `general-purpose` prompt.
 */
export async function buildTaskBrief(options: BuildTaskBriefOptions): Promise<string> {
  const role = resolveSubagentRole(options.role);
  if (!role) {
    throw new Error(
      `参数无效：未知子代理角色 ${options.role}。可用角色为 用例重组（recompose）、写计划（plan）、保真核对（fidelity）、失败分析（attribute）`,
    );
  }
  const caseRef = options.caseRef.trim();
  if (!caseRef || /[\0\r\n]/.test(options.caseRef)) {
    throw new Error('参数无效：--case 必须为非空单行用例或范围标识。请核对后重试');
  }
  if (options.note !== undefined && /[\0]/.test(options.note)) {
    throw new Error('参数无效：--note 不能包含空字节。请修改补充说明后重试');
  }

  const cwd = resolveCwdRoots(options.cwd);
  const packReal = realpathSync(options.packRoot ?? DEFAULT_PACK_ROOT);
  const briefPath = resolveRelativeTarget(cwd, options.briefPath, '--brief', '如 briefs/01.md');
  const outPath = resolveRelativeTarget(cwd, options.outPath, '--out', '如 plans/01.json');
  const scopeResolved = resolveExistingFileInsideCwd(
    cwd,
    options.scopePath ?? DEFAULT_SCOPE,
    '--scope',
    '请主会话先在当前工作目录创建 scope.md 并逐字写入使用者的范围原话后重试',
  );
  const scopeBytes = await readFile(scopeResolved.canonical);
  const scopeText = readVerifiedScopeText(scopeBytes, scopeResolved.relative);

  return renderTaskBrief({
    role,
    caseRef,
    briefPath,
    outPath,
    skillDir: packReal,
    scopeText,
    note: options.note,
  });
}

export async function main(argv: string[]): Promise<number> {
  try {
    const args = parseCliOptions(argv, OPTIONS, USAGE);
    const brief = await buildTaskBrief({
      role: args.role!,
      caseRef: args.case!,
      briefPath: args.brief!,
      outPath: args.out!,
      ...(args.scope !== undefined ? { scopePath: args.scope } : {}),
      ...(args.note !== undefined ? { note: args.note } : {}),
    });
    process.stdout.write(brief);
    return 0;
  } catch (error) {
    process.stderr.write(formatCallError(error) + '\n');
    return 1;
  }
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await main(process.argv.slice(2));
}
