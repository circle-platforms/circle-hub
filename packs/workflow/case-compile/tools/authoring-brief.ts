// Internal library helpers for building authoring briefs (`briefs/<index>.md`) and single-case structured `compile-brief@1` context:
// `tools/download-run.ts` calls `writeBriefs`, and `tools/task-brief.ts` calls `loadRunStructuredContext` / `buildSingleCaseStructuredBrief`.
// It reads local files only, decides nothing, and never overwrites an existing brief file.
import { realpathSync } from 'node:fs';
import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  authoringBrief,
  buildCompileBrief,
  canonicalPath,
  parameterRows,
  policyOf,
  renderCompileBriefMd,
  type BriefKnowledge,
  type BriefNode,
  type BriefPolicy,
  type CompileBriefMode,
  type CompileBriefV1,
} from '../functions/authoring-brief.ts';
import { bedFacts, triggerTypesOf, type BedFacts } from '../functions/bed.ts';
import { parseManifest } from '../functions/manifest.ts';
import { parseProfile } from '../functions/profile.ts';
import { buildCaseIdSet, type PriorAttributionItem, type PriorRoundRecord } from '../functions/rework-history.ts';
import { extractScopeUserRulings } from '../functions/scope.ts';
import type { RunnerCleanup } from '../functions/runtime-contract.ts';
import { parseRuntimeContract } from '../functions/runtime-contract.ts';
import { CallFailure, isRecord } from '../functions/text.ts';
import { loadCasePriorRounds } from './rework-inputs.ts';
import {
  isInsideRoot,
  resolveExistingFileInsideCwd,
  resolveCwdRoots,
  resolveExistingDirInsideCwd,
  resolveInsideCwd,
} from './workspace-path.ts';

const parsed = (name: string, text: string): unknown => { try { return JSON.parse(text); } catch { throw new CallFailure("invalid_parameters", `${name} 不是完整的 JSON`, "重新下载该运行对应的完整 JSON 原件，再按原文件名生成简报"); } };

/** The command forms and the parameter a manual row states, when the entry's data carries them whole. */
const parameterOf = (data: unknown): { parameter?: { commands: string[]; name: string } } => {
  const stated = isRecord(data) && isRecord(data.parameter) ? data.parameter : null;
  if (!stated || typeof stated.name !== 'string' || !stated.name || !Array.isArray(stated.commands) || !stated.commands.length || !stated.commands.every((command) => typeof command === 'string' && command)) return {};
  return { parameter: { commands: stated.commands as string[], name: stated.name } };
};

/** The knowledge root a run download wrote: every node by canonical path, and the line each node's block starts at in the text files. Null when the run brought no root. */
export async function readKnowledge(directory: string): Promise<BriefKnowledge | null> {
  let raw: string;
  try { raw = await readFile(join(directory, 'knowledge', 'nodes.jsonl'), 'utf8'); } catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null; throw error; }
  const [head, ...rows] = raw.split('\n').filter((line) => line.length > 0).map((line) => parsed('knowledge/nodes.jsonl', line));
  if (!isRecord(head) || head.schema !== 'run-knowledge@1' || typeof head.root !== 'string') throw new CallFailure("invalid_parameters", 'knowledge/nodes.jsonl 不是运行下载写的手册和命令树', "重新下载该运行的知识根，保留 run-knowledge@1 首行及锁定 root");
  const nodes = new Map<string, BriefNode>();
  for (const row of rows) {
    if (!isRecord(row) || typeof row.path !== 'string' || !Array.isArray(row.children) || !Array.isArray(row.entries)) throw new CallFailure("invalid_parameters", 'knowledge/nodes.jsonl 里有不合式的节点', "重新下载完整知识根；每个节点须有 path、children 数组和 entries 数组");
    nodes.set(canonicalPath(row.path), {
      path: row.path,
      children: row.children.filter(isRecord).map((child) => ({ name: String(child.name), path: String(child.path) })),
      entries: row.entries.filter(isRecord).filter((entry) => typeof entry.statement === 'string' && typeof entry.reference === 'string').map((entry) => ({
        ...(typeof entry.kind === 'string' ? { kind: entry.kind } : {}), statement: entry.statement as string, reference: entry.reference as string,
        ...(typeof entry.applicability === 'string' && entry.applicability ? { applicability: entry.applicability } : {}),
        ...parameterOf(entry.data),
      })),
    });
  }
  const lines: BriefKnowledge['lines'] = new Map();
  for (const file of (await readdir(join(directory, 'knowledge'))).filter((name) => name.endsWith('.txt')).sort()) {
    const text = (await readFile(join(directory, 'knowledge', file), 'utf8')).split('\n');
    // A block starts at `# <path of a node>` and runs to the blank line before the next one; the first such line is the block.
    const starts: Array<{ path: string; at: number }> = [];
    text.forEach((value, at) => { if (value.startsWith('# /')) { const path = canonicalPath(value.slice(2)); if (nodes.has(path)) starts.push({ path, at }); } });
    starts.forEach((start, order) => {
      if (lines.has(start.path)) return;
      let end = order + 1 < starts.length ? starts[order + 1].at : text.length;
      while (end > start.at + 1 && text[end - 1] === '') end--;
      lines.set(start.path, { file, line: start.at + 1, count: end - start.at });
    });
  }
  return { root: head.root, nodes, lines, parameters: parameterRows(nodes.values()) };
}

export interface BriefReport { briefs: number; kept: number; without_record: number }
/** Writes `briefs/<index>.md` for every item of the directory that carries a recomposition record; a brief already there is left as it is. */
export async function writeBriefs(directory: string): Promise<BriefReport> {
  const report: BriefReport = { briefs: 0, kept: 0, without_record: 0 };
  const knowledge = await readKnowledge(directory);
  if (!knowledge) return report;
  const run = parsed('run.json', await readFile(join(directory, 'run.json'), 'utf8'));
  const policy = policyOf(isRecord(run) ? run.command_policy : null);
  // The bed a plan's bucket must name is the one the run's bound profile selects.
  const groups = isRecord(run) && Array.isArray(run.groups) ? run.groups.filter(isRecord) : [];
  const bed = groups.map((group) => (isRecord(group.profile) && typeof group.profile.bed === 'string' ? group.profile.bed : null)).find((value) => value !== null) ?? null;
  const runnerCleanup = (await loadOptionalBoundSources(directory, bed)).runnerCleanup;
  const present = new Set(await readdir(join(directory, 'briefs')).catch(() => [] as string[]));
  for (const name of (await readdir(join(directory, 'items'))).filter((value) => /^\d+\.json$/.test(value)).sort()) {
    const index = name.slice(0, -'.json'.length);
    const brief = authoringBrief(parsed(`items/${name}`, await readFile(join(directory, 'items', name), 'utf8')), index, knowledge, policy, bed, runnerCleanup);
    if (!brief) { report.without_record++; continue; }
    if (present.has(`${index}.md`)) { report.kept++; continue; }
    await mkdir(join(directory, 'briefs'), { recursive: true, mode: 0o700 });
    await writeFile(join(directory, 'briefs', `${index}.md`), Buffer.from(brief.text), { flag: 'wx', mode: 0o600 });
    report.briefs++;
  }
  return report;
}

const VALID_MODES = new Set<CompileBriefMode>(['initial', 'rework_gate', 'rework_device', 'fidelity_fix']);

export interface WriteStructuredBriefsOptions {
  runDir: string;
  cwd?: string;
  round?: number;
  mode?: CompileBriefMode;
  priorPlans?: string;
  returns?: string;
  answers?: string;
  attributions?: string;
  briefOut?: string;
  caseFilter?: string;
}

export interface RunStructuredContext {
  directory: string;
  knowledge: BriefKnowledge;
  policy: BriefPolicy | null;
  runMeta: {
    run: string;
    product: string;
    version: string;
    build: string;
    exclusions: string[];
  };
  bedFactsData: BedFacts | null;
  triggerTypes: string[];
  failureMarkers: string[];
  runnerCleanup: RunnerCleanup | null;
}

export interface StructuredBriefReport {
  directory: string;
  round: number;
  mode: CompileBriefMode;
  json_files: string[];
  md_files: string[];
  kept: number;
  without_record: number;
}

async function loadOptionalBoundSources(
  directory: string,
  bedHint: string | null,
): Promise<{
  bedFactsData: BedFacts | null;
  triggerTypes: string[];
  failureMarkers: string[];
  runnerCleanup: RunnerCleanup | null;
}> {
  let rawSources: unknown;
  try {
    rawSources = parsed('sources.json', await readFile(join(directory, 'sources.json'), 'utf8'));
  } catch {
    return { bedFactsData: null, triggerTypes: [], failureMarkers: [], runnerCleanup: null };
  }
  if (!Array.isArray(rawSources)) return { bedFactsData: null, triggerTypes: [], failureMarkers: [], runnerCleanup: null };

  const root = realpathSync(directory);
  const readSlotJson = async (slot: string): Promise<unknown> => {
    const row = rawSources.find((v) => isRecord(v) && v.slot === slot && typeof v.file === 'string');
    if (!isRecord(row) || typeof row.file !== 'string') return null;
    try {
      const target = resolve(root, row.file);
      if (!isInsideRoot(target, root)) return null;
      return parsed(row.file, await readFile(target, 'utf8'));
    } catch {
      return null;
    }
  };

  const [invRaw, contractRaw, profileRaw] = await Promise.all([
    readSlotJson('inventory'),
    readSlotJson('contract'),
    readSlotJson('profile'),
  ]);

  const parsedInv = invRaw ? parseManifest(invRaw) : null;
  const beds = parsedInv?.ok ? parsedInv.beds : [];
  const parsedContract = contractRaw ? parseRuntimeContract(contractRaw) : null;
  const contract = parsedContract?.ok ? parsedContract.contract : null;
  const failureMarkers = contract?.failureMarkers?.lines ? [...contract.failureMarkers.lines] : [];

  const parsedProf = contract && profileRaw ? parseProfile(profileRaw, contract, beds) : null;
  const profile = parsedProf?.ok ? parsedProf.profile : null;
  const selectedBedName = profile?.bed ?? bedHint;
  const manifestBed = selectedBedName ? beds.find((b) => b.name === selectedBedName) ?? null : null;
  const triggerSet = triggerTypesOf(profile?.trigger_types);
  const bedFactsData = manifestBed ? bedFacts(manifestBed, triggerSet) : null;

  return {
    bedFactsData,
    triggerTypes: [...triggerSet].sort(),
    failureMarkers,
    runnerCleanup: contract?.cleanup ?? null,
  };
}

/**
 * Loads shared run metadata, frozen knowledge, bed facts, and failure markers once for a downloaded run directory.
 * Reusable by `task-brief.ts` for single-case in-memory `compile-brief@1` generation without touching sibling items.
 */
export async function loadRunStructuredContext(directory: string): Promise<RunStructuredContext | null> {
  const knowledge = await readKnowledge(directory);
  if (!knowledge) return null;

  const runRaw = parsed('run.json', await readFile(join(directory, 'run.json'), 'utf8'));
  const runRec = isRecord(runRaw) ? runRaw : {};
  const policy = policyOf(runRec.command_policy ?? null);
  const groups = Array.isArray(runRec.groups) ? runRec.groups.filter(isRecord) : [];
  const bedHint =
    groups.map((g) => (isRecord(g.profile) && typeof g.profile.bed === 'string' ? g.profile.bed : null)).find((v) => v !== null) ?? null;

  const { bedFactsData, triggerTypes, failureMarkers, runnerCleanup } = await loadOptionalBoundSources(directory, bedHint);
  const params = isRecord(runRec.parameters) ? runRec.parameters : {};
  const exclusions = Array.isArray(params.exclude) ? params.exclude.filter((v): v is string => typeof v === 'string') : [];
  const runMeta = {
    run: typeof runRec.run === 'string' ? runRec.run : '',
    product: typeof runRec.product === 'string' ? runRec.product : '',
    version: typeof runRec.version === 'string' ? runRec.version : '',
    build: typeof runRec.build === 'string' ? runRec.build : '',
    exclusions,
  };

  return {
    directory,
    knowledge,
    policy,
    runMeta,
    bedFactsData,
    triggerTypes,
    failureMarkers,
    runnerCleanup,
  };
}

/** Builds an in-memory `compile-brief@1` for ONE case item using an already loaded `RunStructuredContext`. */
export function buildSingleCaseStructuredBrief(params: {
  ctx: RunStructuredContext;
  item: unknown;
  index: string;
  round: number;
  mode?: CompileBriefMode;
  targetPlanPath?: string;
  planExists?: boolean;
  priorRounds?: readonly PriorRoundRecord[];
  unrecordedAttribution?: PriorAttributionItem | null;
  scopeText?: string;
}): CompileBriefV1 | null {
  const mode: CompileBriefMode = params.mode ?? (params.round > 1 ? 'rework_device' : 'initial');
  const ids = buildCaseIdSet('', params.item);
  const itemFields = isRecord(params.item) && isRecord(params.item.fields) ? params.item.fields : {};
  const target = typeof itemFields.autoid === 'string' ? itemFields.autoid : isRecord(params.item) ? String(params.item.id) : '';
  return buildCompileBrief({
    item: params.item,
    index: params.index,
    knowledge: params.ctx.knowledge,
    policy: params.ctx.policy,
    runMeta: params.ctx.runMeta,
    bedFacts: params.ctx.bedFactsData,
    triggerTypes: params.ctx.triggerTypes,
    executionFailureMarkers: params.ctx.failureMarkers,
    ...(params.scopeText === undefined ? {} : {scopeRulings: extractScopeUserRulings(params.scopeText, ids, target)}),
    runnerCleanup: params.ctx.runnerCleanup,
    round: params.round,
    mode,
    ...(params.targetPlanPath !== undefined ? { targetPlanPath: params.targetPlanPath } : {}),
    ...(params.planExists !== undefined ? { planExists: params.planExists } : {}),
    ...(params.priorRounds ? { priorRounds: params.priorRounds } : {}),
    ...(params.unrecordedAttribution ? { unrecordedAttribution: params.unrecordedAttribution } : {}),
  });
}

/**
 * Generates versioned structured `compile-brief@1` JSON and round-scoped Markdown (`briefs/<index>.round-<n>.json` & `.md`),
 * leaving earlier round briefs untouched and injecting `bedFacts`, `prerequisites`, `prior_device_history`, and `round_history`.
 */
export async function writeStructuredBriefs(options: WriteStructuredBriefsOptions): Promise<StructuredBriefReport> {
  const cwd = resolveCwdRoots(options.cwd);
  const runResolved = resolveExistingDirInsideCwd(cwd, options.runDir, '--run');
  const directory = runResolved.canonical;
  const ctx = await loadRunStructuredContext(directory);
  if (!ctx) {
    throw new CallFailure("not_found", '运行目录中没有 knowledge/nodes.jsonl，无法生成结构化编写简报', "先下载该运行的知识根到 knowledge/nodes.jsonl，再生成结构化简报");
  }

  const round = options.round ?? 1;
  if (!Number.isInteger(round) || round < 1) {
    throw new CallFailure("invalid_parameters", `--round 必须为正整数（收到 ${round}）`, "把 --round 改为大于等于 1 的整数；第 1 轮不传上一轮历史");
  }
  const mode: CompileBriefMode = options.mode ?? (round > 1 ? 'rework_device' : 'initial');
  if (!VALID_MODES.has(mode)) {
    throw new CallFailure("invalid_parameters", `--mode 必须是 initial|rework_gate|rework_device|fidelity_fix`, "把 --mode 明确写为 initial、rework_gate、rework_device 或 fidelity_fix 之一");
  }

  const outRel = options.briefOut ? resolveInsideCwd(cwd, options.briefOut, '--brief-out').relative : join(runResolved.relative, 'briefs');
  const outDir = resolveInsideCwd(cwd, outRel, '--brief-out').canonical;
  await mkdir(outDir, { recursive: true, mode: 0o700 });
  const existing = new Set(await readdir(outDir).catch(() => [] as string[]));

  const report: StructuredBriefReport = {
    directory: outDir,
    round,
    mode,
    json_files: [],
    md_files: [],
    kept: 0,
    without_record: 0,
  };

  let scopeText: string | undefined;
  const scopeInfo = await lstat(join(cwd.canonical, 'scope.md')).catch((error: NodeJS.ErrnoException) => {if (error.code === 'ENOENT') return null; throw error;});
  if (scopeInfo) {
    const scope = resolveExistingFileInsideCwd(cwd, 'scope.md', '--scope');
    const bytes = await readFile(scope.canonical);
    if (bytes.length > 16_384 || bytes.includes(0)) throw new CallFailure('invalid_parameters','scope.md 超过16384字节或包含空字节','提供有效且在大小范围内的使用者范围原文后重试');
    try {scopeText = new TextDecoder('utf-8',{fatal:true}).decode(bytes);} catch {throw new CallFailure('invalid_parameters','scope.md 不是完整UTF-8','恢复范围原件后重试');}
  }

  const caseFilter = options.caseFilter?.trim();
  for (const name of (await readdir(join(directory, 'items'))).filter((value) => /^\d+\.json$/.test(value)).sort()) {
    const index = name.slice(0, -'.json'.length);
    const item = parsed(`items/${name}`, await readFile(join(directory, 'items', name), 'utf8'));
    const caseIds = buildCaseIdSet('', item);
    if (caseFilter && index !== caseFilter && !caseIds.has(caseFilter)) {
      continue;
    }

    let priorRounds: PriorRoundRecord[] = [];
    let unrecordedAttribution: PriorAttributionItem | null = null;
    const hasPriorInput =
      options.priorPlans !== undefined
      || options.returns !== undefined
      || options.answers !== undefined
      || options.attributions !== undefined;

    if (round >= 2 && hasPriorInput) {
      const loaded = await loadCasePriorRounds({
        cwd,
        round,
        caseIds,
        priorPlansArg: options.priorPlans,
        priorReturnsArg: options.returns,
        priorAnswersArg: options.answers,
        priorNotesArg: options.attributions,
        markers: ctx.failureMarkers,
      });
      priorRounds = loaded.rounds;
      unrecordedAttribution = loaded.unrecordedAttribution;
    }

    const compiled = buildSingleCaseStructuredBrief({
      ...(scopeText === undefined ? {} : {scopeText}),
      ctx,
      item,
      index,
      round,
      mode,
      priorRounds,
      unrecordedAttribution,
    });
    if (!compiled) {
      report.without_record++;
      continue;
    }

    const jsonName = `${index}.round-${round}.json`;
    const mdName = `${index}.round-${round}.md`;
    if (existing.has(jsonName) || existing.has(mdName)) {
      report.kept++;
      continue;
    }

    await writeFile(join(outDir, jsonName), Buffer.from(JSON.stringify(compiled, null, 2) + '\n'), { flag: 'wx', mode: 0o600 });
    await writeFile(join(outDir, mdName), Buffer.from(renderCompileBriefMd(compiled)), { flag: 'wx', mode: 0o600 });
    report.json_files.push(join(outDir, jsonName));
    report.md_files.push(join(outDir, mdName));
  }

  return report;
}
