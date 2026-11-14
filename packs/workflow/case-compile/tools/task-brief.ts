// 只读生成可直接原文传给 Circle 内置 general-purpose 子代理（task 工具）的任务说明：
//   node <技能目录>/tools/task-brief.ts --role <用例重组|脚本编写|保真核对|失败分析> --case <用例或范围> --brief <简报或输入路径> --out <目标文件路径> [--scope <范围文件>] [--note <补充说明>] [--round <轮次>] [--run <运行目录>] [--item <条目JSON>] [--brief-json <结构简报JSON>] [--prior-plans <路径...>] [--prior-returns <目录...>] [--prior-answers <路径...>] [--prior-notes <路径...>]
import { realpathSync } from 'node:fs';
import { lstat, readdir, readFile } from 'node:fs/promises';
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
  case: true,
  brief: true,
  out: true,
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
  'node <技能目录>/tools/task-brief.ts --role <用例重组|脚本编写|保真核对|失败分析> --case <用例或范围> --brief <简报或输入路径> --out <目标文件路径> [--scope <范围文件>] [--note <补充说明>] [--round <轮次>] [--run <运行目录>] [--item <条目JSON>] [--brief-json <结构简报JSON>] [--prior-plans <路径...>] [--prior-returns <目录...>] [--prior-answers <路径...>] [--prior-notes <路径...>]';
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

function parseRoundNumber(raw: number | string | undefined): number {
  if (raw === undefined) return 1;
  if (typeof raw === 'number') {
    if (!Number.isInteger(raw) || raw < 1) {
      throw new Error(`参数无效：--round 必须是正整数（收到 ${raw}）`);
    }
    return raw;
  }
  const trimmed = raw.trim();
  if (!/^[1-9][0-9]{0,2}$/.test(trimmed)) {
    throw new Error(`参数无效：--round 必须是正整数（收到 ${raw}）`);
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
    throw new Error(
      `参数无效：范围文件 ${label} 按用例分节后，未找到当前用例 ${caseRef} 所属章节或全局正文（命中单用例分节 ${keptCaseSections} 个）`,
    );
  }
  return kept.join('\n').replace(/\n{3,}/g, '\n\n');
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
      throw new Error(
        `找不到 --brief ${kindLabel} ${briefRelative}（目录 ${parentRel} 下实际有：${listing}）。请先等待前置下载或生成完成，并用 ls 核对真实文件名（如总数不足 10 条时为 0.md 而非 00.md）后再调用 task-brief`,
      );
    }
    throw new Error(
      `找不到 --brief ${kindLabel} ${briefRelative}（所在目录 ${parentRel} 尚未生成）。请先完成前置 download-run / fidelity-brief / download-returns 步骤并确认文件落盘后再派发`,
    );
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`参数无效：--brief 路径 ${briefRelative} 不能是符号链接`);
  }
  if (stat.isDirectory()) {
    if (roleKey !== 'attribute') {
      throw new Error(`参数无效：--brief 路径 ${briefRelative} 是目录，必须指向具体文件（如 briefs/0.md）。请核对文件路径后重试`);
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
    throw new Error(`参数无效：--out 路径 ${outRelative} 不能是符号链接`);
  }
  if (existing?.isDirectory()) {
    throw new Error(`参数无效：--out 指向了已存在的目录 ${outRelative}，必须写具体输出文件路径（如 plans/0.json）。请补充文件名后重试`);
  }
  if ((role.key === 'recompose' || role.key === 'plan' || role.key === 'fidelity') && !outRelative.endsWith('.json')) {
    throw new Error(
      `参数无效：${role.stageLabel} 的 --out 必须是 .json 文件路径（当前收到 ${outRelative}，如 plans/0.json），不要只写目录名`,
    );
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
      throw new Error(`参数无效：--item ${resolved.relative} 不属于目标用例 ${caseRef}`);
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
    throw new Error(`参数无效：${resolved.relative} 不是 ${COMPILE_BRIEF_SCHEMA} 结构化简报`);
  }
  const checked = validateCompileBrief(raw, expectedItem);
  if (!checked.ok) {
    throw new Error(`参数无效：结构化简报 ${resolved.relative} 校验未通过：${checked.problems.join('；')}`);
  }
  const brief = raw as unknown as CompileBriefV1;
  const briefIds = [brief.identity.item_id, brief.identity.autoid].filter((v) => v.length > 0);
  if (caseIds.size > 0 && briefIds.length > 0 && !briefIds.some((id) => caseIds.has(id))) {
    throw new Error(
      `参数无效：结构化简报 ${resolved.relative} 属于用例 ${briefIds[0]}，与 --case 不一致`,
    );
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
      throw new Error(`不存在：--run 目录 ${resolved.relative} 中缺少 knowledge/nodes.jsonl，无法加载结构化简报上下文`);
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
 * and any round 2+ single-case prior history, then renders a complete `general-purpose` prompt.
 */
export async function buildTaskBrief(options: BuildTaskBriefOptions): Promise<string> {
  const role = resolveSubagentRole(options.role);
  if (!role) {
    throw new Error(
      `参数无效：未知子代理角色 ${options.role}。可用角色为 用例重组（recompose）、脚本编写（plan）、保真核对（fidelity）、失败分析（attribute）`,
    );
  }
  const caseRef = options.caseRef.trim();
  if (!caseRef || /[\0\r\n]/.test(options.caseRef)) {
    throw new Error('参数无效：--case 必须为非空单行用例或范围标识。请核对后重试');
  }
  if (options.note !== undefined && /[\0]/.test(options.note)) {
    throw new Error('参数无效：--note 不能包含空字节。请修改补充说明后重试');
  }

  const hasExplicitPriorArgs =
    options.priorPlans !== undefined
    || options.priorReturns !== undefined
    || options.priorAnswers !== undefined
    || options.priorNotes !== undefined;
  if (role.key === 'fidelity' && (options.briefJsonPath !== undefined || options.runDir !== undefined || hasExplicitPriorArgs)) {
    throw new Error('参数无效：保真核对（compile-fidelity）必须严格盲审，禁止传入 --brief-json、--run 或 --prior-* 历史参数');
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
    try {
      const candidateResolved = resolveExistingFileInsideCwd(cwd, briefJsonTarget, '--brief-json');
      const peek = parsedPlanFile(candidateResolved.relative, await readFile(candidateResolved.canonical));
      if (options.briefJsonPath !== undefined || (isRecord(peek) && peek.schema === COMPILE_BRIEF_SCHEMA)) {
        compileBrief = await loadValidatedCompileBrief(cwd, briefJsonTarget, caseIds, siblingItem);
        if (compileBrief.identity.item_id) caseIds.add(compileBrief.identity.item_id);
        if (compileBrief.identity.autoid) caseIds.add(compileBrief.identity.autoid);
        if (options.round === undefined) round = compileBrief.identity.round;
      }
    } catch (error) {
      if (options.briefJsonPath !== undefined) throw error;
      if (error instanceof Error && (error.message.includes('compile-brief@1') || error.message.includes('brief_sha256') || error.message.includes('与 --case 不一致'))) {
        throw error;
      }
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
      throw new Error('参数无效：传入 --prior-plans/--prior-returns/--prior-answers/--prior-notes 时必须同时指定 --round <2|3|...>');
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
    throw new Error(
      `参数无效：第 ${round} 轮 ${role.stageLabel} 必须提供上一轮计划、设备返还或机械规则/失败分析历史（--brief-json 或 --prior-plans/--prior-returns/--prior-answers/--prior-notes），禁止无历史重派`,
    );
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

  return renderTaskBrief({
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
  '注意事项：',
  '  1. 所有路径参数须在当前工作目录下，且不能为符号链接。',
  '  2. --brief 与 --scope 等输入文件必须已落盘；调用前先用 ls 核对实际文件名（总数 <10 条时通常为 0.md 而非 00.md）。',
  '  3. 第 2 轮及以后返工（脚本编写 / 失败分析）须配合 --round <n> 与 --brief-json 或 --prior-* 历史参数。',
].join('\n');

export async function main(argv: string[]): Promise<number> {
  try {
    if (argv.includes('--help') || argv.includes('-h')) {
      process.stdout.write(HELP_TEXT + '\n');
      return 0;
    }
    const args = parseCliOptions(argv, OPTIONS, USAGE);
    const brief = await buildTaskBrief({
      role: args.role!,
      caseRef: args.case!,
      briefPath: args.brief!,
      outPath: args.out!,
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
