import { readSourceManifest } from '../functions/source-materials.ts';
import { CallFailure } from '../functions/text.ts';
// 只读装配单条或批量子代理任务说明写入 `--task-file`（或 `--batch` 批量写盘，不折叠逐字超长行并披露行号），stdout 只输出极短派发提示给 `task` 工具：
//   node <技能目录>/tools/task-brief.ts --role '<用例重组|脚本编写|保真核对|失败分析>' --case <用例或范围> --brief <简报或输入路径> --out <目标文件路径> --task-file <任务文件路径> [--scope <范围文件>] [--note '<补充说明>'] [--round <轮次>] [--run <运行目录>] [--item <条目JSON>] [--brief-json <结构简报JSON>] [--prior-plans <路径...>] [--prior-returns <目录...>] [--prior-answers <路径...>] [--prior-notes <路径...>]
//   node <技能目录>/tools/task-brief.ts --role '<用例重组|脚本编写|保真核对|失败分析>' --batch <批量清单JSON或核对目录> --task-dir <任务目录> [--out-dir <目标输出目录>] [--scope <范围文件>] [--note '<补充说明>']
import { realpathSync } from 'node:fs';
import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  COMPILE_BRIEF_SCHEMA,
  validateCompileBrief,
  type CompileBriefV1,
} from '../functions/authoring-brief.ts';
import { buildCaseIdSet, type PriorAttributionItem } from '../functions/rework-history.ts';
import { detectCaseHeadingMarkers, escapeRegExp } from '../functions/scope.ts';
import { renderTaskBrief, resolveSubagentRole } from '../functions/subagent-roles.ts';
import { formatCallError, isRecord, parseCliOptions } from '../functions/text.ts';
import {
  buildSingleCaseStructuredBrief,
  loadRunStructuredContext,
  type RunStructuredContext,
} from './authoring-brief.ts';
import { loadCasePriorRounds } from './rework-inputs.ts';
import { parsedPlanFile } from './submit-plans.ts';
import {
  resolveCwdRoots,
  resolveExistingDirInsideCwd,
  resolveExistingFileInsideCwd,
  resolveInsideCwd,
  type ResolvedCwd,
} from './workspace-path.ts';

const OPTIONS: Record<string, boolean> = {
  role: true,
  case: false,
  brief: false,
  out: false,
  'task-file': false,
  batch: false,
  'task-dir': false,
  'out-dir': false,
  scope: false,
  note: false,
  round: false,
  run: false,
  'brief-json': false,
  item: false,
  'prior-plans': false,
  'prior-returns': false,
  'prior-answers': false,
  'prior-notes': false,
};
const USAGE =
  "node <技能目录>/tools/task-brief.ts --role '<用例重组|脚本编写|保真核对|失败分析>' --case <用例或范围> --brief <简报或输入路径> --out <目标文件路径> --task-file <任务文件路径> [--scope <范围文件>] [--note '<补充说明>'] [--round <轮次>] [--run <运行目录>] [--item <条目JSON>] [--brief-json <结构简报JSON>] [--prior-plans <路径...>] [--prior-returns <目录...>] [--prior-answers <路径...>] [--prior-notes <路径...>] | --batch <批量清单或核对目录> --task-dir <核对任务目录>";
const DEFAULT_SCOPE = 'scope.md';
const MAX_SCOPE_BYTES = 16_384;
/** Threshold above which a raw verbatim line is disclosed at the top of `--task-file` without wrapping. */
export const VERBATIM_LINE_DISCLOSURE_THRESHOLD = 1_800;
const MAX_DISCLOSED_LONG_LINES = 50;
const DEFAULT_PACK_ROOT = realpathSync(resolve(fileURLToPath(new URL('..', import.meta.url))));

export interface BuildTaskBriefOptions {
  role: string;
  caseRef: string;
  briefPath: string;
  outPath: string;
  scopePath?: string;
  note?: string;
  round?: number | string;
  runDir?: string;
  briefJsonPath?: string;
  itemPath?: string;
  priorPlans?: string;
  priorReturns?: string;
  priorAnswers?: string;
  priorNotes?: string;
  cwd?: string;
  packRoot?: string;
}

export interface WriteTaskBriefOptions extends BuildTaskBriefOptions {
  taskFilePath: string;
}

export interface LongBriefLine {
  line: number;
  length: number;
}

export interface WriteTaskBriefResult {
  taskFile: string;
  lineCount: number;
  byteCount: number;
  longLines: LongBriefLine[];
  brief: string;
  dispatchPrompt: string;
}

function parseRoundNumber(raw: number | string | undefined): number {
  if (raw === undefined) return 1;
  if (typeof raw === 'number') {
    if (!Number.isInteger(raw) || raw < 1) {
      throw new CallFailure('invalid_parameters', `参数无效：--round 必须是正整数（收到 ${raw}）`, "请核对当前角色、工作目录内的输入输出路径和任务参数后重试 task-brief.ts");
    }
    return raw;
  }
  const trimmed = raw.trim();
  if (!/^[1-9][0-9]{0,2}$/.test(trimmed)) {
    throw new CallFailure('invalid_parameters', `参数无效：--round 必须是正整数（收到 ${raw}）`, "请核对当前角色、工作目录内的输入输出路径和任务参数后重试 task-brief.ts");
  }
  return Number(trimmed);
}

function hasMeaningfulScopeText(lines: readonly string[]): boolean {
  return lines.some((line) => {
    const t = line.trim();
    return t.length > 0 && !/^#{1,6}(?:\s|$)/.test(t);
  });
}

/**
 * Extracts global instructions plus sections matching THIS case (`caseIds`) from `scope.md`.
 * Supports optional per-case Markdown headings (`## <autoid>` / `## <item_id>`) while keeping
 * un-scoped global headings/paragraphs in full and excluding other cases' sections.
 */
export function extractCaseScopeText(
  scopeText: string,
  caseRef: string,
  caseIds: ReadonlySet<string>,
  options: { allowAll?: boolean; scopeRelative?: string } = {},
): string {
  const normalized = scopeText.replace(/\r\n/g, '\n');
  if (options.allowAll) return normalized;

  const lines = normalized.split('\n');
  interface ScopeSection {
    headingDepth: number;
    caseTokens: string[];
    lines: string[];
  }
  const sections: ScopeSection[] = [];
  let current: ScopeSection = { headingDepth: 0, caseTokens: [], lines: [] };
  let sawCaseSection = false;

  const isGlobalHeading = (text: string): boolean => /^(?:全局|通用|整体|测试范围|使用者原话)/.test(text.trim());

  const matchesCaseSet = (tokens: readonly string[], headingText: string): boolean => {
    for (const tok of tokens) {
      if (caseIds.has(tok)) return true;
    }
    for (const id of caseIds) {
      if (id.length >= 2 && new RegExp(`(?:^|[\\s（(\\[：:、/])${escapeRegExp(id)}(?:$|[\\s）)\\]：:、/])`).test(headingText)) {
        return true;
      }
    }
    return false;
  };

  for (const line of lines) {
    const headingMatch = /^(#{1,6})\s+(.+)$/.exec(line);
    if (headingMatch) {
      const depth = headingMatch[1].length;
      const headingText = headingMatch[2].trim();
      const detected = isGlobalHeading(headingText) ? [] : detectCaseHeadingMarkers(headingText);
      const explicitMatch = detected.length > 0 || matchesCaseSet([], headingText);
      const isCaseHeader = !isGlobalHeading(headingText) && (detected.length > 0 || matchesCaseSet(detected, headingText));

      if (current.caseTokens.length > 0 && depth > current.headingDepth && !isCaseHeader) {
        // Subheading inside an active case-specific section belongs to that same case.
        current.lines.push(line);
        continue;
      }

      if (current.lines.length > 0) sections.push(current);
      if (isCaseHeader || explicitMatch) {
        sawCaseSection = true;
        const matchedTokens = detected.length > 0
          ? detected
          : [...caseIds].filter((id) => headingText.includes(id));
        current = { headingDepth: depth, caseTokens: matchedTokens, lines: [line] };
      } else {
        current = { headingDepth: depth, caseTokens: [], lines: [line] };
      }
      continue;
    }
    current.lines.push(line);
  }
  if (current.lines.length > 0) sections.push(current);

  if (!sawCaseSection) {
    return normalized;
  }

  const kept: string[] = [];
  let keptCaseSections = 0;
  for (const sec of sections) {
    if (sec.caseTokens.length === 0) {
      kept.push(...sec.lines);
    } else if (sec.caseTokens.some((tok) => caseIds.has(tok))) {
      keptCaseSections++;
      kept.push(...sec.lines);
    }
  }

  if (!hasMeaningfulScopeText(kept)) {
    const label = options.scopeRelative ?? DEFAULT_SCOPE;
    throw new CallFailure('invalid_parameters', `参数无效：范围文件 ${label} 按用例分节后，未找到当前用例 ${caseRef} 所属章节或全局正文（命中单用例分节 ${keptCaseSections} 个）`, "请核对当前角色、工作目录内的输入输出路径和任务参数后重试 task-brief.ts");
  }
  return kept.join('\n').replace(/\n{3,}/g, '\n\n');
}

function readVerifiedScopeText(scopeBytes: Buffer, scopeRelative: string): string {
  if (scopeBytes.byteLength > MAX_SCOPE_BYTES) {
    throw new CallFailure('invalid_parameters', `参数无效：范围文件 ${scopeRelative} 超过 ${MAX_SCOPE_BYTES} 字节上限（实际 ${scopeBytes.byteLength} 字节）。请精简为使用者原话后重试`, "请核对当前角色、工作目录内的输入输出路径和任务参数后重试 task-brief.ts");
  }
  if (scopeBytes.includes(0)) {
    throw new CallFailure('invalid_parameters', `参数无效：范围文件 ${scopeRelative} 包含空字节，不是有效 UTF-8 文本。请改写纯文本范围文件后重试`, "请核对当前角色、工作目录内的输入输出路径和任务参数后重试 task-brief.ts");
  }
  const text = scopeBytes.toString('utf8');
  const meaningful = text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^#{1,6}(?:\s|$)/.test(line));
  if (!meaningful.length) {
    throw new CallFailure('invalid_parameters', `参数无效：范围文件 ${scopeRelative} 为空或只有标题，缺少使用者原话。请先逐字写入使用者的范围原话后再派发`, "请核对当前角色、工作目录内的输入输出路径和任务参数后重试 task-brief.ts");
  }
  return text;
}

function resolveRelativeTarget(cwdRoot: ReturnType<typeof resolveCwdRoots>, value: string, flag: string, hint: string): string {
  const resolved = resolveInsideCwd(cwdRoot, value, flag, hint);
  if (resolved.relative === '.') {
    throw new CallFailure('invalid_parameters', `参数无效：${flag} 必须指向工作目录下的具体文件或子路径（${hint}）。请修改参数后重试`, "请核对当前角色、工作目录内的输入输出路径和任务参数后重试 task-brief.ts");
  }
  return resolved.relative;
}

type ResolvedRoleSpec = NonNullable<ReturnType<typeof resolveSubagentRole>>;

async function assertExistingBriefPath(
  cwd: ReturnType<typeof resolveCwdRoots>,
  briefRelative: string,
  roleKey: ResolvedRoleSpec['key'],
): Promise<void> {
  const resolved = resolveInsideCwd(cwd, briefRelative, '--brief');
  let stat: Awaited<ReturnType<typeof lstat>>;
  try {
    stat = await lstat(resolved.canonical);
  } catch {
    const parentRel = dirname(resolved.relative);
    const parentCanonical = dirname(resolved.canonical);
    let entries: string[] | null = null;
    try {
      entries = (await readdir(parentCanonical)).filter((name) => !name.startsWith('.')).sort();
    } catch {
      entries = null;
    }
    const kindLabel = roleKey === 'attribute' ? '路径' : '文件';
    if (entries !== null) {
      const listing = entries.length
        ? entries.slice(0, 10).join('、') + (entries.length > 10 ? ` 等 ${entries.length} 项` : '')
        : '目录为空';
      throw new CallFailure('not_found', `不存在：找不到 --brief ${kindLabel} ${briefRelative}（目录 ${parentRel} 下实际有：${listing}）。请先等待前置下载或生成完成，并用 ls 核对真实文件名（如总数不足 10 条时为 0.md 而非 00.md）后再调用 task-brief`, "请核对当前角色、工作目录内的输入输出路径和任务参数后重试 task-brief.ts");
    }
    throw new CallFailure('not_found', `不存在：找不到 --brief ${kindLabel} ${briefRelative}（所在目录 ${parentRel} 尚未生成）。请先完成前置 download-run / fidelity-brief / download-returns 步骤并确认文件落盘后再派发`, "请核对当前角色、工作目录内的输入输出路径和任务参数后重试 task-brief.ts");
  }
  if (stat.isSymbolicLink()) {
    throw new CallFailure('invalid_parameters', `参数无效：--brief 路径 ${briefRelative} 不能是符号链接`, "请核对当前角色、工作目录内的输入输出路径和任务参数后重试 task-brief.ts");
  }
  if (stat.isDirectory()) {
    if (roleKey !== 'attribute') {
      throw new CallFailure('invalid_parameters', `参数无效：--brief 路径 ${briefRelative} 是目录，必须指向具体文件（如 briefs/0.md）。请核对文件路径后重试`, "请核对当前角色、工作目录内的输入输出路径和任务参数后重试 task-brief.ts");
    }
    resolveExistingDirInsideCwd(cwd, briefRelative, '--brief');
    return;
  }
  resolveExistingFileInsideCwd(cwd, briefRelative, '--brief');
}

async function assertValidOutPath(
  cwd: ReturnType<typeof resolveCwdRoots>,
  outRelative: string,
  role: ResolvedRoleSpec,
): Promise<void> {
  const resolved = resolveInsideCwd(cwd, outRelative, '--out');
  const existing = await lstat(resolved.canonical).catch(() => null);
  if (existing?.isSymbolicLink()) {
    throw new CallFailure('invalid_parameters', `参数无效：--out 路径 ${outRelative} 不能是符号链接`, "请核对当前角色、工作目录内的输入输出路径和任务参数后重试 task-brief.ts");
  }
  if (existing?.isDirectory()) {
    throw new CallFailure('invalid_parameters', `参数无效：--out 指向了已存在的目录 ${outRelative}，必须写具体输出文件路径（如 plans/0.json）。请补充文件名后重试`, "请核对当前角色、工作目录内的输入输出路径和任务参数后重试 task-brief.ts");
  }
  if ((role.key === 'recompose' || role.key === 'plan' || role.key === 'fidelity') && !outRelative.endsWith('.json')) {
    throw new CallFailure('invalid_parameters', `参数无效：${role.stageLabel} 的 --out 必须是 .json 文件路径（当前收到 ${outRelative}，如 plans/0.json），不要只写目录名`, "请核对当前角色、工作目录内的输入输出路径和任务参数后重试 task-brief.ts");
  }
}

async function maybeReadSiblingItem(
  cwd: ResolvedCwd,
  briefRelative: string,
  itemPathArg: string | undefined,
  caseRef: string,
): Promise<{ item: unknown; caseIds: Set<string> }> {
  const baseIds = buildCaseIdSet(caseRef);
  if (itemPathArg !== undefined) {
    const resolved = resolveExistingFileInsideCwd(cwd, itemPathArg, '--item');
    const item = parsedPlanFile(resolved.relative, await readFile(resolved.canonical));
    const itemIds = buildCaseIdSet('', item);
    if (itemIds.size > 0 && ![...baseIds].some((id) => itemIds.has(id))) {
      throw new CallFailure('invalid_parameters', `参数无效：--item ${resolved.relative} 不属于目标用例 ${caseRef}`, "请核对当前角色、工作目录内的输入输出路径和任务参数后重试 task-brief.ts");
    }
    return { item, caseIds: buildCaseIdSet(caseRef, item) };
  }

  // Opportunistically enrich item_id <-> autoid mapping from sibling `items/<seq>.json` if it matches this exact case.
  const idxMatch = /^(\d+)(?:\.round-\d+)?\.(?:md|json)$/.exec(basename(briefRelative));
  const parentDir = dirname(briefRelative);
  if (idxMatch && basename(parentDir) === 'briefs') {
    const runDir = dirname(parentDir);
    const candidateRel = join(runDir, 'items', `${idxMatch[1]}.json`);
    try {
      const resolved = resolveExistingFileInsideCwd(cwd, candidateRel, 'items');
      const item = parsedPlanFile(resolved.relative, await readFile(resolved.canonical));
      const itemIds = buildCaseIdSet('', item);
      if ([...baseIds].some((id) => itemIds.has(id))) {
        return { item, caseIds: buildCaseIdSet(caseRef, item) };
      }
    } catch {
      // Missing optional sibling item JSON is normal when a brief path is passed standalone.
    }
  }
  return { item: undefined, caseIds: baseIds };
}

async function loadValidatedCompileBrief(
  cwd: ResolvedCwd,
  briefJsonArg: string,
  caseIds: ReadonlySet<string>,
  expectedItem?: unknown,
): Promise<CompileBriefV1> {
  const resolved = resolveExistingFileInsideCwd(cwd, briefJsonArg, '--brief-json');
  const raw = parsedPlanFile(resolved.relative, await readFile(resolved.canonical));
  if (!isRecord(raw) || raw.schema !== COMPILE_BRIEF_SCHEMA) {
    throw new CallFailure('invalid_parameters', `参数无效：${resolved.relative} 不是 ${COMPILE_BRIEF_SCHEMA} 结构化简报`, "请核对当前角色、工作目录内的输入输出路径和任务参数后重试 task-brief.ts");
  }
  const checked = validateCompileBrief(raw, expectedItem);
  if (!checked.ok) {
    throw new CallFailure('invalid_parameters', `参数无效：结构化简报 ${resolved.relative} 校验未通过：${checked.problems.join('；')}`, "请核对当前角色、工作目录内的输入输出路径和任务参数后重试 task-brief.ts");
  }
  const brief = raw as unknown as CompileBriefV1;
  const briefIds = [brief.identity.item_id, brief.identity.autoid].filter((v) => v.length > 0);
  if (caseIds.size > 0 && briefIds.length > 0 && !briefIds.some((id) => caseIds.has(id))) {
    throw new CallFailure('invalid_parameters', `参数无效：结构化简报 ${resolved.relative} 属于用例 ${briefIds[0]}，与 --case 不一致`, "请核对当前角色、工作目录内的输入输出路径和任务参数后重试 task-brief.ts");
  }
  return brief;
}

function inferItemIndex(
  briefRelative: string,
  itemPathArg: string | undefined,
  siblingItem: unknown,
): string {
  const fromBrief = /^(\d+)(?:\.round-\d+)?\.(?:md|json)$/.exec(basename(briefRelative));
  if (fromBrief) return fromBrief[1];
  if (itemPathArg) {
    const fromItem = /^(\d+)\.json$/.exec(basename(itemPathArg));
    if (fromItem) return fromItem[1];
  }
  if (isRecord(siblingItem) && typeof siblingItem.index === 'string' && siblingItem.index.trim()) {
    return siblingItem.index.trim();
  }
  return '01';
}

async function resolveOptionalRunContext(
  cwd: ResolvedCwd,
  options: BuildTaskBriefOptions,
  briefRelative: string,
): Promise<RunStructuredContext | null> {
  if (options.runDir !== undefined) {
    const resolved = resolveExistingDirInsideCwd(cwd, options.runDir, '--run');
    const ctx = await loadRunStructuredContext(resolved.canonical);
    if (!ctx) {
      throw new CallFailure('not_found', `不存在：--run 目录 ${resolved.relative} 中缺少 knowledge/nodes.jsonl，无法加载结构化简报上下文`, "请核对当前角色、工作目录内的输入输出路径和任务参数后重试 task-brief.ts");
    }
    return ctx;
  }

  const candidateDirs: string[] = [];
  const briefParent = dirname(briefRelative);
  if (basename(briefParent) === 'briefs') {
    candidateDirs.push(dirname(briefParent));
  }
  if (options.itemPath !== undefined) {
    const itemRel = resolveInsideCwd(cwd, options.itemPath, '--item').relative;
    const itemParent = dirname(itemRel);
    if (basename(itemParent) === 'items') {
      candidateDirs.push(dirname(itemParent));
    }
  }
  for (const relDir of candidateDirs) {
    try {
      const resolved = resolveExistingDirInsideCwd(cwd, relDir, '--run');
      const ctx = await loadRunStructuredContext(resolved.canonical);
      if (ctx) return ctx;
    } catch {
      // Optional opportunistic inference: ignore standalone non-run parent dirs.
    }
  }
  return null;
}

/**
 * Validates the subagent role, workspace-contained paths, verbatim (and case-filtered) `scope.md`,
 * in-memory `compile-brief@1` context (when run data exists for plan/attribute roles),
 * and any round 2+ single-case prior history, returning rendered Markdown plus resolved metadata.
 */
async function buildTaskBriefWithMeta(options: BuildTaskBriefOptions): Promise<{
  brief: string;
  cwd: ResolvedCwd;
  role: ResolvedRoleSpec;
  caseRef: string;
  round: number;
  briefPath: string;
  outPath: string;
  scopeRelative: string;
  skillDir: string;
}> {
  const role = resolveSubagentRole(options.role);
  if (!role) {
    throw new CallFailure('invalid_parameters', `参数无效：未知子代理角色 ${options.role}。可用角色为 用例重组（recompose）、脚本编写（plan）、保真核对（fidelity）、失败分析（attribute）`, "请核对当前角色、工作目录内的输入输出路径和任务参数后重试 task-brief.ts");
  }
  const caseRef = options.caseRef.trim();
  if (!caseRef || /[\0\r\n]/.test(options.caseRef)) {
    throw new CallFailure('invalid_parameters', '参数无效：--case 必须为非空单行用例或范围标识。请核对后重试', "请核对当前角色、工作目录内的输入输出路径和任务参数后重试 task-brief.ts");
  }
  if (options.note !== undefined && /[\0]/.test(options.note)) {
    throw new CallFailure('invalid_parameters', '参数无效：--note 不能包含空字节。请修改补充说明后重试', "请核对当前角色、工作目录内的输入输出路径和任务参数后重试 task-brief.ts");
  }

  const hasExplicitPriorArgs =
    options.priorPlans !== undefined
    || options.priorReturns !== undefined
    || options.priorAnswers !== undefined
    || options.priorNotes !== undefined;
  if (role.key === 'fidelity' && (options.briefJsonPath !== undefined || options.runDir !== undefined || hasExplicitPriorArgs)) {
    throw new CallFailure('invalid_parameters', '参数无效：保真核对（compile-fidelity）必须严格盲审，禁止传入 --brief-json、--run 或 --prior-* 历史参数', "请核对当前角色、工作目录内的输入输出路径和任务参数后重试 task-brief.ts");
  }

  let round = parseRoundNumber(options.round);
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
  const rawScopeText = readVerifiedScopeText(scopeBytes, scopeResolved.relative);
  await assertExistingBriefPath(cwd, briefPath, role.key);
  await assertValidOutPath(cwd, outPath, role);

  const { item: siblingItem, caseIds } = await maybeReadSiblingItem(cwd, briefPath, options.itemPath, caseRef);

  // Load run structured context first for plan/attribute roles so `executionFailureMarkers` feed history analysis
  // and single-case `compile-brief@1` can be built directly in memory inside this single `task-brief.ts` entrypoint.
  const runCtx = role.key === 'plan' || role.key === 'attribute'
    ? await resolveOptionalRunContext(cwd, options, briefPath)
    : null;

  // Detect if `--brief` itself is a `.json` `compile-brief@1` file when `--brief-json` is not separately set.
  let compileBrief: CompileBriefV1 | undefined;
  const briefJsonTarget = options.briefJsonPath ?? (role.key !== 'fidelity' && briefPath.endsWith('.json') ? briefPath : undefined);
  if (briefJsonTarget) {
    const candidateResolved = resolveExistingFileInsideCwd(cwd, briefJsonTarget, '--brief-json');
    const peek = parsedPlanFile(candidateResolved.relative, await readFile(candidateResolved.canonical));
    if (options.briefJsonPath !== undefined || (isRecord(peek) && peek.schema === COMPILE_BRIEF_SCHEMA)) {
      compileBrief = await loadValidatedCompileBrief(cwd, briefJsonTarget, caseIds, siblingItem);
      if (compileBrief.identity.item_id) caseIds.add(compileBrief.identity.item_id);
      if (compileBrief.identity.autoid) caseIds.add(compileBrief.identity.autoid);
      if (options.round === undefined) round = compileBrief.identity.round;
    }
  }

  let priorRounds = compileBrief?.round_history.rounds;
  let streak = compileBrief?.round_history.streak;
  let unrecordedAttribution: PriorAttributionItem | null = compileBrief?.round_history.unrecorded_attribution
    ? {
        round: null,
        roundRecorded: false,
        sourceFile: compileBrief.round_history.unrecorded_attribution.source_file,
        confidence: 'hypothesis' as const,
        judged: compileBrief.round_history.unrecorded_attribution.judged,
        remedy: compileBrief.round_history.unrecorded_attribution.fix_direction,
        evidenceQuotes: compileBrief.round_history.unrecorded_attribution.evidence_quotes,
      }
    : null;

  if (hasExplicitPriorArgs) {
    if (options.round === undefined) {
      throw new CallFailure('invalid_parameters', '参数无效：传入 --prior-plans/--prior-returns/--prior-answers/--prior-notes 时必须同时指定 --round <2|3|...>', "请核对当前角色、工作目录内的输入输出路径和任务参数后重试 task-brief.ts");
    }
    const markers = compileBrief?.materials.bed_facts.execution_failure_markers ?? runCtx?.failureMarkers;
    const loaded = await loadCasePriorRounds({
      cwd,
      round,
      caseIds,
      priorPlansArg: options.priorPlans,
      priorReturnsArg: options.priorReturns,
      priorAnswersArg: options.priorAnswers,
      priorNotesArg: options.priorNotes,
      markers,
    });
    priorRounds = loaded.rounds;
    streak = loaded.streak;
    unrecordedAttribution = loaded.unrecordedAttribution;
  }

  if (round >= 2 && (role.key === 'plan' || role.key === 'attribute') && (!priorRounds || priorRounds.length === 0) && !unrecordedAttribution) {
    throw new CallFailure('invalid_parameters', `参数无效：第 ${round} 轮 ${role.stageLabel} 必须提供上一轮计划、设备返还或机械规则/失败分析历史（--brief-json 或 --prior-plans/--prior-returns/--prior-answers/--prior-notes），禁止无历史重派`, "请核对当前角色、工作目录内的输入输出路径和任务参数后重试 task-brief.ts");
  }

  if (!compileBrief && runCtx && siblingItem !== undefined && (role.key === 'plan' || role.key === 'attribute')) {
    const inferredMode = options.priorAnswers && !options.priorReturns
      ? 'rework_gate'
      : round > 1
        ? 'rework_device'
        : 'initial';
    const built = buildSingleCaseStructuredBrief({
      ctx: runCtx,
      item: siblingItem,
      index: inferItemIndex(briefPath, options.itemPath, siblingItem),
      round,
      mode: inferredMode,
      targetPlanPath: outPath,
      ...(priorRounds ? { priorRounds } : {}),
      ...(unrecordedAttribution ? { unrecordedAttribution } : {}),
    });
    if (built) {
      compileBrief = built;
      if (compileBrief.identity.item_id) caseIds.add(compileBrief.identity.item_id);
      if (compileBrief.identity.autoid) caseIds.add(compileBrief.identity.autoid);
    }
  }

  const allowAllScope = role.key === 'recompose' && /^(?:all|全部|整份|整批)$/i.test(caseRef);
  const scopeText = extractCaseScopeText(rawScopeText, caseRef, caseIds, {
    allowAll: allowAllScope,
    scopeRelative: scopeResolved.relative,
  });

  let brief = renderTaskBrief({
    role,
    caseRef,
    briefPath,
    outPath,
    skillDir: packReal,
    scopeText,
    note: options.note,
    round,
    ...(compileBrief ? { compileBrief } : {}),
    ...(priorRounds && streak ? { priorRounds, streak } : {}),
    ...(unrecordedAttribution ? { unrecordedAttribution } : {}),
  });
  if (options.runDir !== undefined) {
    const sourceDir = resolveExistingDirInsideCwd(cwd, options.runDir, '--run');
    const manifestStat = await lstat(join(sourceDir.canonical, 'sources.json')).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
    if (manifestStat) {
      const materials = await readSourceManifest(sourceDir.canonical);
      brief += '\n\n## 本次已核验的来源文件\n' + materials.map(material => JSON.stringify({ slot: material.slot, reference: material.reference, path: material.file === null ? null : join(sourceDir.relative, material.file), sha256: material.sha256, ...(material.withheld ? { missing: material.withheld } : {}) })).join('\n');
    } else brief += '\n\n## 来源文件清单缺口\nsources.json 不存在；不能据来源槽名猜测本地文件名。主代理需补齐本次下载的来源清单。';
  }
  return {
    brief,
    cwd,
    role,
    caseRef,
    round,
    briefPath,
    outPath,
    scopeRelative: scopeResolved.relative,
    skillDir: packReal,
  };
}

/**
 * Validates the subagent role, workspace-contained paths, verbatim (and case-filtered) `scope.md`,
 * in-memory `compile-brief@1` context (when run data exists for plan/attribute roles),
 * and any round 2+ single-case prior history, then renders transient task input for the installed named role.
 */
export async function buildTaskBrief(options: BuildTaskBriefOptions): Promise<string> {
  return (await buildTaskBriefWithMeta(options)).brief;
}

async function assertValidTaskFilePath(
  cwd: ResolvedCwd,
  taskFileArg: string,
  protectedPaths: readonly (string | undefined)[],
): Promise<{ relative: string; canonical: string }> {
  const resolved = resolveInsideCwd(cwd, taskFileArg, '--task-file', '如 briefs/0.task.md');
  if (resolved.relative === '.') {
    throw new CallFailure('invalid_parameters', '参数无效：--task-file 必须指向工作目录下的具体 .md 文件（如 briefs/0.task.md）。请修改参数后重试', "请核对当前角色、工作目录内的输入输出路径和任务参数后重试 task-brief.ts");
  }
  // Refuse symlinks along the lexical path inside cwd before checking canonical collision.
  let probePath = resolved.lexical;
  while (probePath !== cwd.canonical && probePath !== cwd.lexical) {
    const st = await lstat(probePath).catch(() => null);
    if (st?.isSymbolicLink()) {
      throw new CallFailure('invalid_parameters', `参数无效：--task-file 路径包含符号链接 ${probePath.slice(probePath.lastIndexOf('/') + 1)}`, "请核对当前角色、工作目录内的输入输出路径和任务参数后重试 task-brief.ts");
    }
    if (probePath === resolved.lexical && st?.isDirectory()) {
      throw new CallFailure('invalid_parameters', `参数无效：--task-file 指向了已存在的目录 ${resolved.relative}，必须写具体 .md 文件路径`, "请核对当前角色、工作目录内的输入输出路径和任务参数后重试 task-brief.ts");
    }
    const parent = dirname(probePath);
    if (parent === probePath) break;
    probePath = parent;
  }
  const rel = resolved.relative;
  if (!rel.endsWith('.md')) {
    throw new CallFailure('invalid_parameters', `参数无效：--task-file 必须是 .md 文件路径（当前收到 ${rel}，如 briefs/0.task.md）`, "请核对当前角色、工作目录内的输入输出路径和任务参数后重试 task-brief.ts");
  }
  const normalizedProtected = new Set(
    protectedPaths
      .filter((p): p is string => typeof p === 'string' && p.length > 0)
      .map((p) => resolveInsideCwd(cwd, p, '--task-file').relative),
  );
  if (normalizedProtected.has(rel)) {
    throw new CallFailure('invalid_parameters', `参数无效：--task-file 路径 ${rel} 不能与输入、范围或目标输出文件相同`, "请核对当前角色、工作目录内的输入输出路径和任务参数后重试 task-brief.ts");
  }
  return resolved;
}

/**
 * Preserves every line > 1,800 chars byte-for-byte without wrapping, prepending a header with exact
 * shifted 1-based line numbers so readers know when Circle `read_file` will clip a verbatim line at 2,000 chars.
 */
export function formatTaskBriefFileContent(rawBrief: string): {
  content: string;
  lineCount: number;
  longLines: LongBriefLine[];
} {
  const bodyWithNewline = rawBrief.endsWith('\n') ? rawBrief : `${rawBrief}\n`;
  const rawLines = bodyWithNewline.slice(0, -1).split('\n');
  const longIndices: number[] = [];
  for (let i = 0; i < rawLines.length; i++) {
    if (rawLines[i]!.length > VERBATIM_LINE_DISCLOSURE_THRESHOLD) longIndices.push(i);
  }
  if (longIndices.length === 0) {
    return { content: bodyWithNewline, lineCount: rawLines.length, longLines: [] };
  }
  const shown = longIndices.slice(0, MAX_DISCLOSED_LONG_LINES);
  const omitted = longIndices.length - shown.length;
  const headerCount = 1 + shown.length + (omitted > 0 ? 1 : 0) + 1;
  const headerLines: string[] = [
    `> 注意：本任务文件包含 ${longIndices.length} 行超过 ${VERBATIM_LINE_DISCLOSURE_THRESHOLD} 字符的逐字原始内容（未折行，逐字节保留）。\`read_file\` 单行只展示前 2000 字符；如须完整查看被截断的逐字行，请在允许范围内按下列 1 起始行号读取或核对原始来源文件：`,
  ];
  const longLines: LongBriefLine[] = [];
  for (const idx of shown) {
    const lineNo = headerCount + idx + 1;
    const len = rawLines[idx]!.length;
    longLines.push({ line: lineNo, length: len });
    headerLines.push(`- 第 ${lineNo} 行（${len} 字符）`);
  }
  if (omitted > 0) {
    const maxOmitted = Math.max(...longIndices.slice(shown.length).map((idx) => rawLines[idx]!.length));
    headerLines.push(`- 其余 ${omitted} 行同样超过 ${VERBATIM_LINE_DISCLOSURE_THRESHOLD} 字符（最长 ${maxOmitted} 字符）`);
  }
  headerLines.push('');
  return {
    content: `${headerLines.join('\n')}\n${bodyWithNewline}`,
    lineCount: headerCount + rawLines.length,
    longLines,
  };
}

/** Fixed short dispatch notice emitted to stdout (`~350-450` chars, zero case content). */
export function renderTaskDispatchPrompt(params: {
  roleAgentName: string;
  roleStageLabel: string;
  caseRef: string;
  round: number;
  taskFile: string;
  outPath: string;
  lineCount: number;
  longLineCount: number;
  skillDir?: string;
}): string {
  const longHint = params.longLineCount > 0
    ? `；含 ${params.longLineCount} 行超 ${VERBATIM_LINE_DISCLOSURE_THRESHOLD} 字符逐字行，见文件开头行号提示`
    : '';
  return [
    `请以 \`subagent_type="${params.roleAgentName}"\`（角色 \`${params.roleAgentName}\`）执行 \`${params.caseRef}\` 第 ${params.round} 轮${params.roleStageLabel}。`,
    `- 任务文件：${params.taskFile}（共 ${params.lineCount} 行${longHint}）`,
    `- 目标输出：${params.outPath}`,
    `用 \`read_file\` 完整读完 \`${params.taskFile}\` 后按要求只写 \`${params.outPath}\`，完工简复路径。`,
  ].join('\n');
}

/** Validates, formats, and prepares one task brief without writing to disk yet. */
async function stageTaskBrief(options: WriteTaskBriefOptions): Promise<{
  canonical: string;
  bytes: Buffer;
  result: WriteTaskBriefResult;
}> {
  const meta = await buildTaskBriefWithMeta(options);
  const taskResolved = await assertValidTaskFilePath(meta.cwd, options.taskFilePath, [
    meta.briefPath,
    meta.outPath,
    meta.scopeRelative,
    options.briefJsonPath,
    options.itemPath,
  ]);
  const formatted = formatTaskBriefFileContent(meta.brief);
  const bytes = Buffer.from(formatted.content, 'utf8');
  const dispatchPrompt = renderTaskDispatchPrompt({
    roleAgentName: meta.role.agentName,
    roleStageLabel: meta.role.stageLabel,
    caseRef: meta.caseRef,
    round: meta.round,
    taskFile: taskResolved.relative,
    outPath: meta.outPath,
    lineCount: formatted.lineCount,
    longLineCount: formatted.longLines.length,
    skillDir: meta.skillDir,
  });
  return {
    canonical: taskResolved.canonical,
    bytes,
    result: {
      taskFile: taskResolved.relative,
      lineCount: formatted.lineCount,
      byteCount: bytes.byteLength,
      longLines: formatted.longLines,
      brief: formatted.content,
      dispatchPrompt,
    },
  };
}

/** Writes the full brief to `--task-file` inside cwd and returns a short dispatch prompt for stdout. */
export async function writeTaskBrief(options: WriteTaskBriefOptions): Promise<WriteTaskBriefResult> {
  const staged = await stageTaskBrief(options);
  await mkdir(dirname(staged.canonical), { recursive: true });
  await writeFile(staged.canonical, staged.bytes);
  return staged.result;
}

function optionalTaskField(entry: Record<string, unknown>, key: string): string | undefined {
  const val = entry[key];
  if (val === undefined) return undefined;
  if (typeof val !== 'string' || !val.trim()) {
    throw new CallFailure('invalid_parameters', `参数无效：批量任务项字段 ${key} 必须是非空字符串。请修改批量清单后重试`, "请核对当前角色、工作目录内的输入输出路径和任务参数后重试 task-brief.ts");
  }
  return val;
}

async function resolveBatchItems(
  args: Partial<Record<string, string>>,
  cwd: ResolvedCwd,
  packReal: string,
): Promise<WriteTaskBriefOptions[]> {
  const role = resolveSubagentRole(args.role!);
  if (!role) {
    throw new CallFailure('invalid_parameters', `参数无效：未知子代理角色 ${args.role}。可用：用例重组、脚本编写、保真核对、失败分析`, "请核对当前角色、工作目录内的输入输出路径和任务参数后重试 task-brief.ts");
  }
  const batchTarget = resolveInsideCwd(cwd, args.batch!, '--batch');
  const st = await lstat(batchTarget.lexical).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') {
      throw new CallFailure('not_found', `不存在：找不到 --batch 路径 ${args.batch}。请核对路径并确认文件或目录已生成后重试`, "请核对当前角色、工作目录内的输入输出路径和任务参数后重试 task-brief.ts");
    }
    throw err;
  });
  if (st.isSymbolicLink()) {
    throw new CallFailure('invalid_parameters', `参数无效：--batch 路径 ${args.batch} 不能是符号链接。请改用工作目录内的真实路径后重试`, "请核对当前角色、工作目录内的输入输出路径和任务参数后重试 task-brief.ts");
  }

  const baseDefaults = {
    ...(args.scope !== undefined ? { scopePath: args.scope } : {}),
    ...(args.note !== undefined ? { note: args.note } : {}),
    ...(args.round !== undefined ? { round: args.round } : {}),
    ...(args.run !== undefined ? { runDir: args.run } : {}),
    packRoot: packReal,
    cwd: cwd.canonical,
  };

  if (st.isDirectory()) {
    if (role.key !== 'fidelity') {
      throw new CallFailure('invalid_parameters', '参数无效：目录形式的 --batch 目前仅支持保真核对（--role 保真核对，扫描 *.brief.json）；脚本编写/重组请传入批量任务清单 JSON', "请核对当前角色、工作目录内的输入输出路径和任务参数后重试 task-brief.ts");
    }
    if (!args['task-dir']) {
      throw new CallFailure('invalid_parameters', '参数无效：使用目录形式的 --batch 时必须同时指定 --task-dir <核对任务目录>', "请核对当前角色、工作目录内的输入输出路径和任务参数后重试 task-brief.ts");
    }
    if (args.run !== undefined || args['brief-json'] !== undefined || args['prior-plans'] !== undefined || args['prior-returns'] !== undefined || args['prior-answers'] !== undefined || args['prior-notes'] !== undefined) {
      throw new CallFailure('invalid_parameters', '参数无效：保真核对（compile-fidelity）必须严格盲审，禁止传入 --brief-json、--run 或 --prior-* 历史参数', "请核对当前角色、工作目录内的输入输出路径和任务参数后重试 task-brief.ts");
    }
    const batchDir = resolveExistingDirInsideCwd(cwd, args.batch!, '--batch');
    const taskDir = resolveInsideCwd(cwd, args['task-dir'], '--task-dir');
    const outDir = args['out-dir'] ? resolveInsideCwd(cwd, args['out-dir'], '--out-dir') : batchDir;
    const files = (await readdir(batchDir.canonical)).filter((n) => n.endsWith('.brief.json')).sort();
    if (!files.length) {
      throw new CallFailure('not_found', `不存在：--batch 目录 ${batchDir.relative} 下没有 .brief.json 文件。请先运行 fidelity-brief.ts 生成核对目录后再试`, "请核对当前角色、工作目录内的输入输出路径和任务参数后重试 task-brief.ts");
    }
    const jobs: WriteTaskBriefOptions[] = [];
    for (const fileName of files) {
      const briefFile = resolveExistingFileInsideCwd(cwd, join(batchDir.relative, fileName), '--batch');
      const parsed = parsedPlanFile(fileName, await readFile(briefFile.canonical));
      if (!isRecord(parsed)) {
        throw new CallFailure('invalid_parameters', `参数无效：${briefFile.relative} 不是合法的 JSON 对象。请检查并重新生成该 .brief.json 后重试`, "请核对当前角色、工作目录内的输入输出路径和任务参数后重试 task-brief.ts");
      }
      const stem = fileName.slice(0, -'.brief.json'.length);
      const caseStem = stem.replace(/\.[0-9a-f]{8}$/, '');
      const caseRef =
        typeof parsed.autoid === 'string' && parsed.autoid
          ? parsed.autoid
          : typeof parsed.item === 'string' && parsed.item
            ? parsed.item
            : caseStem;
      jobs.push({
        ...baseDefaults,
        role: args.role!,
        caseRef,
        briefPath: briefFile.relative,
        outPath: join(outDir.relative, `${stem}.verdict.json`),
        taskFilePath: join(taskDir.relative, `${stem}.task.md`),
      });
    }
    return jobs;
  }

  if (!st.isFile()) {
    throw new CallFailure('invalid_parameters', `参数无效：--batch ${args.batch} 必须是普通 JSON 文件或保真核对目录。请核对 --batch 路径后重试`, "请核对当前角色、工作目录内的输入输出路径和任务参数后重试 task-brief.ts");
  }
  const batchFile = resolveExistingFileInsideCwd(cwd, args.batch!, '--batch');
  const parsed = parsedPlanFile(basename(batchFile.canonical), await readFile(batchFile.canonical));
  let rawTasks: unknown[];
  let fileDefaults: Record<string, unknown> = {};
  if (Array.isArray(parsed)) {
    rawTasks = parsed;
  } else if (isRecord(parsed) && Array.isArray(parsed.tasks)) {
    rawTasks = parsed.tasks;
    if (isRecord(parsed.defaults)) fileDefaults = parsed.defaults;
  } else {
    throw new CallFailure('invalid_parameters', `参数无效：--batch 清单 ${batchFile.relative} 必须是任务数组或含 tasks 数组的对象。请修改清单格式后重试`, "请核对当前角色、工作目录内的输入输出路径和任务参数后重试 task-brief.ts");
  }
  if (!rawTasks.length) {
    throw new CallFailure('invalid_parameters', `参数无效：--batch 清单 ${batchFile.relative} 为空。请至少填入一项任务后重试`, "请核对当前角色、工作目录内的输入输出路径和任务参数后重试 task-brief.ts");
  }
  return rawTasks.map((entry, idx) => {
    if (!isRecord(entry)) {
      throw new CallFailure('invalid_parameters', `参数无效：--batch 第 ${idx + 1} 项必须是对象。请修改批量清单后重试`, "请核对当前角色、工作目录内的输入输出路径和任务参数后重试 task-brief.ts");
    }
    const merged: Record<string, unknown> = { ...fileDefaults, ...entry };
    const caseRef = optionalTaskField(merged, 'case');
    const briefPath = optionalTaskField(merged, 'brief');
    const outPath = optionalTaskField(merged, 'out');
    const taskFilePath = optionalTaskField(merged, 'task_file');
    if (!caseRef || !briefPath || !outPath || !taskFilePath) {
      throw new CallFailure('invalid_parameters', `参数无效：--batch 第 ${idx + 1} 项必须包含 case、brief、out、task_file 字段。请补齐必填字段后重试`, "请核对当前角色、工作目录内的输入输出路径和任务参数后重试 task-brief.ts");
    }
    const roundRaw = merged.round;
    const round =
      typeof roundRaw === 'number' || typeof roundRaw === 'string'
        ? roundRaw
        : baseDefaults.round;
    return {
      ...baseDefaults,
      role: typeof merged.role === 'string' && merged.role ? merged.role : args.role!,
      caseRef,
      briefPath,
      outPath,
      taskFilePath,
      ...(optionalTaskField(merged, 'scope') !== undefined ? { scopePath: optionalTaskField(merged, 'scope') } : {}),
      ...(optionalTaskField(merged, 'note') !== undefined ? { note: optionalTaskField(merged, 'note') } : {}),
      ...(round !== undefined ? { round } : {}),
      ...(optionalTaskField(merged, 'run') !== undefined ? { runDir: optionalTaskField(merged, 'run') } : {}),
      ...(optionalTaskField(merged, 'brief_json') !== undefined ? { briefJsonPath: optionalTaskField(merged, 'brief_json') } : {}),
      ...(optionalTaskField(merged, 'item') !== undefined ? { itemPath: optionalTaskField(merged, 'item') } : {}),
      ...(optionalTaskField(merged, 'prior_plans') !== undefined ? { priorPlans: optionalTaskField(merged, 'prior_plans') } : {}),
      ...(optionalTaskField(merged, 'prior_returns') !== undefined ? { priorReturns: optionalTaskField(merged, 'prior_returns') } : {}),
      ...(optionalTaskField(merged, 'prior_answers') !== undefined ? { priorAnswers: optionalTaskField(merged, 'prior_answers') } : {}),
      ...(optionalTaskField(merged, 'prior_notes') !== undefined ? { priorNotes: optionalTaskField(merged, 'prior_notes') } : {}),
    };
  });
}

const HELP_TEXT = [
  `用法：${USAGE}`,
  '',
  '可用角色（--role）：',
  '  用例重组（recompose）   生成单条或整批原始用例重组子代理任务简报（--out 须为 .json 文件路径）',
  '  脚本编写（plan）        生成单条自动化用例编写子代理任务简报（--out 须为 .json 文件路径）',
  '  保真核对（fidelity）    生成盲审保真核对子代理任务简报（--out 须为 .json 文件路径；禁传 --brief-json/--run/--prior-*）',
  '  失败分析（attribute）   生成单条上机失败分析子代理任务简报',
  '',
  '批量模式：',
  '  --batch <清单.json>                         一次为数组/tasks 清单中的多条用例生成任务文件，stdout 输出 task-brief-batch@1 JSON',
  '  --role 保真核对 --batch <核对目录> --task-dir <目录>   一次为核对目录内全部 .brief.json 生成盲审任务文件（可用 --out-dir 指定 .verdict.json 输出目录）',
  '',
  '注意事项：',
  '  1. 所有路径参数须在当前工作目录下，且不能为符号链接；--task-file 须为工作目录下不冲突的 .md 路径。',
  '  2. --brief 与 --scope 等输入文件必须已落盘；调用前先用 ls 核对实际文件名（总数 <10 条时通常为 0.md 而非 00.md）。',
  '  3. 完整任务说明写入 --task-file（超 1800 字符逐字行不折行并在文件开头提示行号）；stdout 只输出极短派发提示（路径相对工作目录）。',
  '  4. 第 2 轮及以后返工（脚本编写 / 失败分析）须配合 --round <n> 与 --brief-json 或 --prior-* 历史参数。',
  "  5. 含中文或空格的参数值（如 --role、--note）用单引号括起，如 --role '脚本编写'；或使用英文标识 recompose|plan|fidelity|attribute。",
].join('\n');

export async function main(argv: string[]): Promise<number> {
  try {
    if (argv.includes('--help') || argv.includes('-h')) {
      process.stdout.write(HELP_TEXT + '\n');
      return 0;
    }
    const args = parseCliOptions(argv, OPTIONS, USAGE);
    if (args.batch !== undefined) {
      if (args.case !== undefined || args.brief !== undefined || args.out !== undefined || args['task-file'] !== undefined) {
        throw new CallFailure('invalid_parameters', '参数无效：--batch 模式不能同时传入单条参数 --case/--brief/--out/--task-file', "请核对当前角色、工作目录内的输入输出路径和任务参数后重试 task-brief.ts");
      }
      const cwd = resolveCwdRoots();
      const jobSpecs = await resolveBatchItems(args, cwd, DEFAULT_PACK_ROOT);
      const stagedList: Array<Awaited<ReturnType<typeof stageTaskBrief>>> = [];
      const seenTaskFiles = new Set<string>();
      for (const spec of jobSpecs) {
        const staged = await stageTaskBrief(spec);
        if (seenTaskFiles.has(staged.canonical)) {
          throw new CallFailure('invalid_parameters', `参数无效：批量任务中存在重复的目标任务文件 ${staged.result.taskFile}`, "请核对当前角色、工作目录内的输入输出路径和任务参数后重试 task-brief.ts");
        }
        seenTaskFiles.add(staged.canonical);
        stagedList.push(staged);
      }
      for (const staged of stagedList) {
        await mkdir(dirname(staged.canonical), { recursive: true });
        await writeFile(staged.canonical, staged.bytes);
      }
      const firstRole = resolveSubagentRole(args.role!)!;
      process.stdout.write(
        JSON.stringify(
          {
            schema: 'task-brief-batch@1',
            role: firstRole.agentName,
            skill_dir: DEFAULT_PACK_ROOT,
            written: stagedList.length,
            tasks: stagedList.map((s, index) => ({
              case: jobSpecs[index]!.caseRef,
              out: jobSpecs[index]!.outPath,
              task_file: s.result.taskFile,
              line_count: s.result.lineCount,
              byte_count: s.result.byteCount,
              dispatch_prompt: s.result.dispatchPrompt,
            })),
          },
          null,
          2,
        ) + '\n',
      );
      return 0;
    }

    if (args['task-dir'] !== undefined || args['out-dir'] !== undefined) {
      throw new CallFailure('invalid_parameters', '参数无效：--task-dir 与 --out-dir 只能配合 --batch 使用', "请核对当前角色、工作目录内的输入输出路径和任务参数后重试 task-brief.ts");
    }
    const missingSingle = (['case', 'brief', 'out', 'task-file'] as const).filter((k) => !args[k]);
    if (missingSingle.length) {
      throw new CallFailure('invalid_parameters', `参数无效：缺少 ${missingSingle.map((k) => '--' + k).join('、')}。用法：${USAGE}`, "请核对当前角色、工作目录内的输入输出路径和任务参数后重试 task-brief.ts");
    }

    const written = await writeTaskBrief({
      role: args.role!,
      caseRef: args.case!,
      briefPath: args.brief!,
      outPath: args.out!,
      taskFilePath: args['task-file']!,
      ...(args.scope !== undefined ? { scopePath: args.scope } : {}),
      ...(args.note !== undefined ? { note: args.note } : {}),
      ...(args.round !== undefined ? { round: args.round } : {}),
      ...(args.run !== undefined ? { runDir: args.run } : {}),
      ...(args['brief-json'] !== undefined ? { briefJsonPath: args['brief-json'] } : {}),
      ...(args.item !== undefined ? { itemPath: args.item } : {}),
      ...(args['prior-plans'] !== undefined ? { priorPlans: args['prior-plans'] } : {}),
      ...(args['prior-returns'] !== undefined ? { priorReturns: args['prior-returns'] } : {}),
      ...(args['prior-answers'] !== undefined ? { priorAnswers: args['prior-answers'] } : {}),
      ...(args['prior-notes'] !== undefined ? { priorNotes: args['prior-notes'] } : {}),
    });
    process.stdout.write(`${written.dispatchPrompt}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(formatCallError(error) + '\n');
    return 1;
  }
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await main(process.argv.slice(2));
}
