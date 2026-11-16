import { CallFailure } from '../functions/text.ts';
// Shared working-directory containment and symlink-escape checks for pack CLI tools.
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';

export interface ResolvedCwd {
  lexical: string;
  canonical: string;
}

export interface ResolvedCwdPath {
  lexical: string;
  canonical: string;
  relative: string;
}

export function resolveCwdRoots(cwd?: string): ResolvedCwd {
  const lexical = resolve(cwd ?? process.cwd());
  const canonical = realpathSync(lexical);
  return { lexical, canonical };
}

export const isInsideRoot = (candidate: string, root: string): boolean => {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

function isInsideCwdLexical(candidate: string, cwd: ResolvedCwd): boolean {
  return isInsideRoot(candidate, cwd.canonical) || isInsideRoot(candidate, cwd.lexical);
}

/**
 * Resolves a candidate target or parent path inside `cwd`, rejecting lexical
 * escapes, control characters, dangling symlinks, and symlinks pointing outside `cwd`.
 */
export function resolveInsideCwd(
  cwd: ResolvedCwd,
  targetArg: string,
  label: string,
  hint?: string,
): ResolvedCwdPath {
  const suggestion = hint ? `（${hint}）` : '';
  if (!targetArg || /[\0\r\n]/.test(targetArg)) {
    throw new CallFailure('invalid_parameters', `参数无效：${label} 路径不能为空或包含控制字符。请改写相对工作目录路径后重试`, "请改用工作目录内的真实相对路径，并保留用户文件后重试");
  }
  const lexical = isAbsolute(targetArg) ? resolve(targetArg) : resolve(cwd.canonical, targetArg);
  if (!isInsideCwdLexical(lexical, cwd)) {
    throw new CallFailure('invalid_parameters', `参数无效：${label} 路径 ${targetArg} 超出当前工作目录。请改写工作目录下的相对路径${suggestion}`, "请改用工作目录内的真实相对路径，并保留用户文件后重试");
  }
  let probe = lexical;
  const tail: string[] = [];
  while (!existsSync(probe)) {
    try {
      if (lstatSync(probe).isSymbolicLink()) {
        throw new CallFailure('invalid_parameters', `参数无效：${label} 路径中存在悬空符号链接 ${basename(probe)}。请改用工作目录内的真实路径后重试`, "请改用工作目录内的真实相对路径，并保留用户文件后重试");
      }
    } catch (error) {
      if ((error as { code?: unknown })?.code !== 'ENOENT') throw error;
    }
    const parent = dirname(probe);
    if (parent === probe) break;
    tail.unshift(basename(probe));
    probe = parent;
  }
  const canonical = join(realpathSync(probe), ...tail);
  if (!isInsideRoot(canonical, cwd.canonical)) {
    throw new CallFailure('invalid_parameters', `参数无效：${label} 路径 ${targetArg} 解析后超出当前工作目录。请改用工作目录内的真实路径后重试`, "请改用工作目录内的真实相对路径，并保留用户文件后重试");
  }
  return {
    lexical,
    canonical,
    relative: relative(cwd.canonical, canonical) || '.',
  };
}

function resolveExistingEntryInsideCwd(
  cwd: ResolvedCwd,
  entryArg: string,
  label: string,
  kind: 'file' | 'directory',
  missingHint?: string,
): ResolvedCwdPath {
  const resolved = resolveInsideCwd(cwd, entryArg, label);
  const kindLabel = kind === 'file' ? '文件' : '目录';
  const expectedType = kind === 'file' ? '普通文件' : '普通目录';
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(resolved.lexical);
  } catch (error) {
    if ((error as { code?: unknown })?.code === 'ENOENT') {
      const next = missingHint ?? `请确认 ${entryArg} 已在当前工作目录存在后重试`;
      throw new CallFailure('not_found', `不存在：找不到 ${label} ${kindLabel} ${entryArg}。${next}`, "请改用工作目录内的真实相对路径，并保留用户文件后重试");
    }
    throw error;
  }
  if (st.isSymbolicLink()) {
    throw new CallFailure('invalid_parameters', `参数无效：${label} ${kindLabel} ${entryArg} 不能是符号链接。请改用工作目录内的真实${kindLabel}后重试`, "请改用工作目录内的真实相对路径，并保留用户文件后重试");
  }
  if (kind === 'file' ? !st.isFile() : !st.isDirectory()) {
    throw new CallFailure('invalid_parameters', `参数无效：${label} ${entryArg} 不是${expectedType}。请改用工作目录内的${expectedType}后重试`, "请改用工作目录内的真实相对路径，并保留用户文件后重试");
  }
  const canonical = realpathSync(resolved.lexical);
  if (!isInsideRoot(canonical, cwd.canonical)) {
    throw new CallFailure('invalid_parameters', `参数无效：${label} 路径 ${entryArg} 解析后超出当前工作目录。请改用工作目录内的真实路径后重试`, "请改用工作目录内的真实相对路径，并保留用户文件后重试");
  }
  return {
    lexical: resolved.lexical,
    canonical,
    relative: relative(cwd.canonical, canonical) || '.',
  };
}

/**
 * Resolves an existing regular non-symlink file inside `cwd`.
 */
export function resolveExistingFileInsideCwd(
  cwd: ResolvedCwd,
  fileArg: string,
  label: string,
  missingHint?: string,
): ResolvedCwdPath {
  return resolveExistingEntryInsideCwd(cwd, fileArg, label, 'file', missingHint);
}

/**
 * Resolves an existing non-symlink directory inside `cwd`.
 */
export function resolveExistingDirInsideCwd(
  cwd: ResolvedCwd,
  dirArg: string,
  label: string,
  missingHint?: string,
): ResolvedCwdPath {
  return resolveExistingEntryInsideCwd(cwd, dirArg, label, 'directory', missingHint);
}

/** The one-line correct form every refused `--run` is answered with (printed as `合法写法：…`). */
export const RUN_DIRECTORY_FORM = "--run '<运行目录>'（放 run.json 的目录，不是 run.json 文件）";
/** What a run directory without a readable run.json is told to do, unless the tool has a more exact next step. */
export const RUN_DOWNLOAD_AGAIN = '用 tools/download-run.ts 或 tools/fetch-run.ts 重新下载本次运行，run.json 留在运行目录里';

/**
 * Every refusal of a `--run` value names the correct form beside its fact. The helpers above word their facts with the category
 * word in front, and the formatter writes it too: it is taken off here so that every tool prints it once.
 */
function withRunForm(error: unknown): unknown {
  if (!(error instanceof CallFailure)) return error;
  const fact = error.fact.replace(/^(参数无效|无权限|不存在|已被占用|暂时不可用)：/u, '');
  return new CallFailure(error.category, fact, error.next_action, { ...(error.path === undefined ? {} : { path: error.path }), legal_form: RUN_DIRECTORY_FORM });
}
/** The file system root as the working directory: a path anywhere is inside it. */
const anywhere = (): ResolvedCwd => resolveCwdRoots(parse(process.cwd()).root);

/**
 * The run directory a `--run` names: the folder download-run.ts or fetch-run.ts wrote, which holds run.json, knowledge/ and sources/.
 * It is a real directory, not a link, and never a file: the run.json file is refused in the words of any other path that is no
 * directory, plus the one-line correct form, whichever tool asks (the one resolver of `--run`).
 *
 * With `cwd` the directory must lie under the working directory (the tools that bound every path to it, as task-brief.ts does).
 * Without it the value is taken as given, relative to the process's own directory, as the tools that never bounded their paths
 * always did; the Circle guard keeps those inside the working directory.
 */
export function resolveRunDirectory(value: string, cwd?: ResolvedCwd): ResolvedCwdPath {
  try { return cwd === undefined ? resolveExistingDirInsideCwd(anywhere(), resolve(value), '--run') : resolveExistingDirInsideCwd(cwd, value, '--run'); }
  catch (error) { throw withRunForm(error); }
}

/** The run.json of a run directory, the regular file it must be (never a link), with the hint of where to get one when it is missing. */
export function resolveRunFile(directory: ResolvedCwdPath, cwd?: ResolvedCwd, missingHint: string = RUN_DOWNLOAD_AGAIN): ResolvedCwdPath {
  try {
    return cwd === undefined
      ? resolveExistingFileInsideCwd(anywhere(), join(directory.lexical, 'run.json'), '--run 目录里的 run.json', missingHint)
      : resolveExistingFileInsideCwd(cwd, join(directory.relative, 'run.json'), '--run 目录里的 run.json', missingHint);
  } catch (error) { throw withRunForm(error); }
}

/** A `--run` value as the run it names: its directory and the run.json in it. */
export function resolveRun(value: string, cwd?: ResolvedCwd, missingHint?: string): { directory: ResolvedCwdPath; file: ResolvedCwdPath } {
  const directory = resolveRunDirectory(value, cwd);
  return { directory, file: resolveRunFile(directory, cwd, missingHint) };
}
