// 只读生成可直接原文传给 Circle 内置 general-purpose 子代理（task 工具）的任务说明：
//   node <技能目录>/tools/task-brief.ts --role <用例重组|写计划|保真核对|失败分析> --case <用例或范围> --brief <简报或输入路径> --out <目标文件路径> [--scope <范围文件>] [--note <补充说明>] [--round <轮次>] [--brief-json <结构简报JSON>] [--prior-plans <路径...>] [--prior-returns <目录...>] [--prior-answers <路径...>] [--prior-notes <路径...>]
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  COMPILE_BRIEF_SCHEMA,
  validateCompileBrief,
  type CompileBriefV1,
} from '../functions/authoring-brief.ts';
import { buildCaseIdSet } from '../functions/rework-history.ts';
import { renderTaskBrief, resolveSubagentRole } from '../functions/subagent-roles.ts';
import { formatCallError, isRecord, parseCliOptions } from '../functions/text.ts';
import { loadCasePriorRounds } from './rework-inputs.ts';
import { parsedPlanFile } from './submit-plans.ts';
import {
  resolveCwdRoots,
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
  'brief-json': false,
  item: false,
  'prior-plans': false,
  'prior-returns': false,
  'prior-answers': false,
  'prior-notes': false,
};
const USAGE =
  'node <技能目录>/tools/task-brief.ts --role <用例重组|写计划|保真核对|失败分析> --case <用例或范围> --brief <简报或输入路径> --out <目标文件路径> [--scope <范围文件>] [--note <补充说明>] [--round <轮次>] [--brief-json <结构简报JSON>] [--item <条目JSON>] [--prior-plans <路径...>] [--prior-returns <目录...>] [--prior-answers <路径...>] [--prior-notes <路径...>]';
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

/**
 * Validates the subagent role, workspace-contained paths, verbatim `scope.md`,
 * and any round 2+ single-case prior history, then renders a complete `general-purpose` prompt.
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

  const hasExplicitPriorArgs =
    options.priorPlans !== undefined
    || options.priorReturns !== undefined
    || options.priorAnswers !== undefined
    || options.priorNotes !== undefined;
  if (role.key === 'fidelity' && (options.briefJsonPath !== undefined || hasExplicitPriorArgs)) {
    throw new Error('参数无效：保真核对（compile-fidelity）必须严格盲审，禁止传入 --brief-json 或 --prior-* 历史参数');
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
  const scopeText = readVerifiedScopeText(scopeBytes, scopeResolved.relative);

  const { item: siblingItem, caseIds } = await maybeReadSiblingItem(cwd, briefPath, options.itemPath, caseRef);

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
      // When `--brief` happens to be an arbitrary `.json` input (e.g. items/00.json), only fail if `--brief-json` was explicit
      // or the file declared `compile-brief@1`.
      if (options.briefJsonPath !== undefined) throw error;
      if (error instanceof Error && (error.message.includes('compile-brief@1') || error.message.includes('brief_sha256') || error.message.includes('与 --case 不一致'))) {
        throw error;
      }
    }
  }

  let priorRounds = compileBrief?.round_history.rounds;
  let streak = compileBrief?.round_history.streak;
  if (hasExplicitPriorArgs) {
    if (options.round === undefined) {
      throw new Error('参数无效：传入 --prior-plans/--prior-returns/--prior-answers/--prior-notes 时必须同时指定 --round <2|3|...>');
    }
    const loaded = await loadCasePriorRounds({
      cwd,
      round,
      caseIds,
      priorPlansArg: options.priorPlans,
      priorReturnsArg: options.priorReturns,
      priorAnswersArg: options.priorAnswers,
      priorNotesArg: options.priorNotes,
      markers: compileBrief?.materials.bed_facts.execution_failure_markers,
    });
    priorRounds = loaded.rounds;
    streak = loaded.streak;
  }

  if (round >= 2 && (role.key === 'plan' || role.key === 'attribute') && (!priorRounds || priorRounds.length === 0)) {
    throw new Error(
      `参数无效：第 ${round} 轮 ${role.stageLabel} 必须提供上一轮计划、设备返还或门禁/归因历史（--brief-json 或 --prior-plans/--prior-returns/--prior-answers/--prior-notes），禁止无历史重派`,
    );
  }

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
      ...(args.round !== undefined ? { round: args.round } : {}),
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
