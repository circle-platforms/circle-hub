// Shared local-only loader for single-case prior-round history inputs (plans, returns, answers, notes).
// Enforces working-directory containment and strict single-case isolation across all prior rounds.
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import {
  analyzeRoundHistory,
  extractCaseDeviceEvidence,
  parseGateRefusalsFromAnswer,
  parsePriorAttribution,
  parsePriorPlanSnapshot,
  type GateRefusalItem,
  type PriorAttributionItem,
  type PriorPlanSnapshot,
  type PriorRoundRecord,
  type StreakAnalysis,
} from '../functions/rework-history.ts';
import { isRecord } from '../functions/text.ts';
import { parsedPlanFile } from './submit-plans.ts';
import {
  isInsideRoot,
  resolveExistingDirInsideCwd,
  resolveExistingFileInsideCwd,
  resolveInsideCwd,
  type ResolvedCwd,
} from './workspace-path.ts';

const SKIP_SLOT = new Set(['-', 'none', 'null']);

export function parseCommaRoundList(
  raw: string | undefined,
  priorRoundCount: number | null,
  flagName: string,
): Array<string | null> {
  if (raw === undefined) return [];
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error(`参数无效：${flagName} 不能为空；如需省略某一轮请用 - 占位或省略该选项`);
  }
  const tokens = raw.split(',').map((part) => {
    const t = part.trim();
    return !t || SKIP_SLOT.has(t.toLowerCase()) ? null : t;
  });
  if (tokens.every((t) => t === null)) {
    throw new Error(`参数无效：${flagName} 不能全部为空或占位符`);
  }
  if (priorRoundCount !== null && priorRoundCount > 0) {
    if (tokens.length === priorRoundCount) return tokens;
    if (tokens.length === 1) {
      return [...new Array<null>(priorRoundCount - 1).fill(null), tokens[0]];
    }
    throw new Error(
      `参数无效：${flagName} 传入了 ${tokens.length} 项，与前序轮次数 ${priorRoundCount} 不一致（只传 1 项默认指上一轮，传多项须按第 1..${priorRoundCount} 轮顺序对齐，空缺轮次用 - 占位）`,
    );
  }
  return tokens;
}

async function resolveCasePlanFromTarget(
  cwd: ResolvedCwd,
  targetArg: string,
  caseIds: ReadonlySet<string>,
  flagLabel: string,
): Promise<{ path: string; snapshot: PriorPlanSnapshot }> {
  const checked = resolveInsideCwd(cwd, targetArg, flagLabel);
  const dirTry = await lstat(checked.lexical).catch(() => null);
  if (dirTry?.isSymbolicLink()) {
    throw new Error(`参数无效：${flagLabel} 路径 ${targetArg} 不能是符号链接`);
  }
  if (dirTry?.isDirectory()) {
    const dir = resolveExistingDirInsideCwd(cwd, targetArg, flagLabel);
    const names = (await readdir(dir.canonical)).filter((n) => n.endsWith('.json')).sort();
    for (const name of names) {
      const fileResolved = resolveExistingFileInsideCwd(cwd, join(dir.relative, name), flagLabel);
      const parsed = parsedPlanFile(fileResolved.relative, await readFile(fileResolved.canonical));
      if (isRecord(parsed) && typeof parsed.item === 'string' && caseIds.has(parsed.item)) {
        return {
          path: fileResolved.relative,
          snapshot: parsePriorPlanSnapshot(parsed, caseIds, fileResolved.relative),
        };
      }
    }
    throw new Error(`不存在：在上一轮计划目录 ${dir.relative} 中未找到用例 ${[...caseIds][0]} 的计划文件`);
  }
  const fileResolved = resolveExistingFileInsideCwd(cwd, targetArg, flagLabel);
  const parsed = parsedPlanFile(fileResolved.relative, await readFile(fileResolved.canonical));
  return {
    path: fileResolved.relative,
    snapshot: parsePriorPlanSnapshot(parsed, caseIds, fileResolved.relative),
  };
}

async function readSafeFileUnderRoot(
  cwd: ResolvedCwd,
  rootCanonical: string,
  rootRelative: string,
  relPath: string,
  label: string,
): Promise<{ path: string; text: string } | null> {
  if (!relPath || /[\0\r\n]/.test(relPath)) return null;
  const candidateRel = join(rootRelative, relPath);
  const resolved = resolveExistingFileInsideCwd(cwd, candidateRel, label);
  if (!isInsideRoot(resolved.canonical, rootCanonical)) {
    throw new Error(`参数无效：${label} 文件 ${relPath} 解析后超出所属目录范围`);
  }
  return {
    path: resolved.relative,
    text: await readFile(resolved.canonical, 'utf8'),
  };
}

async function loadDeviceEvidenceFromDir(
  cwd: ResolvedCwd,
  returnsArg: string,
  round: number,
  caseIds: ReadonlySet<string>,
  priorPlan: PriorPlanSnapshot | null,
  markers?: readonly string[],
) {
  const returnsDir = resolveExistingDirInsideCwd(cwd, returnsArg, '--prior-returns');
  const indexResolved = resolveExistingFileInsideCwd(
    cwd,
    join(returnsDir.relative, 'index.json'),
    '--prior-returns/index.json',
    '返还目录中缺少 index.json',
  );
  if (!isInsideRoot(indexResolved.canonical, returnsDir.canonical)) {
    throw new Error('参数无效：index.json 解析后超出返还目录');
  }
  const returnsIndex = parsedPlanFile(indexResolved.relative, await readFile(indexResolved.canonical));
  if (!isRecord(returnsIndex) || !Array.isArray(returnsIndex.jobs)) {
    throw new Error(`参数无效：${indexResolved.relative} 不是合法的 device-returns@1 索引文件`);
  }

  // Locate matching job row first so only THIS single case's session/log files are read from disk.
  const jobs = returnsIndex.jobs.filter(isRecord);
  let matchedRow: Record<string, unknown> | null = null;
  for (let i = jobs.length - 1; i >= 0; i--) {
    const job = jobs[i];
    if (!Array.isArray(job.rows)) continue;
    const hit = job.rows.find((r) => isRecord(r) && typeof r.item === 'string' && caseIds.has(r.item));
    if (isRecord(hit)) {
      matchedRow = hit;
      break;
    }
  }
  if (!matchedRow) {
    return null;
  }

  let logText: string | null = null;
  let logPath: string | null = null;
  if (typeof matchedRow.log === 'string' && matchedRow.log) {
    try {
      const read = await readSafeFileUnderRoot(
        cwd,
        returnsDir.canonical,
        returnsDir.relative,
        matchedRow.log,
        '--prior-returns log',
      );
      if (read) {
        logText = read.text;
        logPath = read.path;
      }
    } catch {
      // Unreadable or escaped path in row metadata: leave null rather than failing silently on missing evidence.
      logText = null;
    }
  }

  const sessionTexts = new Map<string, { path: string; text: string }>();
  if (isRecord(matchedRow.sessions)) {
    for (const [sName, rel] of Object.entries(matchedRow.sessions)) {
      if (typeof rel !== 'string' || !rel) continue;
      try {
        const read = await readSafeFileUnderRoot(
          cwd,
          returnsDir.canonical,
          returnsDir.relative,
          rel,
          `--prior-returns session ${sName}`,
        );
        if (read) sessionTexts.set(sName, read);
      } catch {
        // Invalid or missing session path stays noted via withheldNotes / null sessionFiles.
      }
    }
  }

  return extractCaseDeviceEvidence({
    round,
    returnsIndex,
    caseIds,
    sessionTexts,
    logText,
    logPath,
    priorPlan,
    markers,
  });
}

async function loadGateRefusalsFromTarget(
  cwd: ResolvedCwd,
  answerArg: string,
  caseIds: ReadonlySet<string>,
  round: number,
): Promise<GateRefusalItem[]> {
  const checked = resolveInsideCwd(cwd, answerArg, '--prior-answers');
  const dirTry = await lstat(checked.lexical).catch(() => null);
  if (dirTry?.isSymbolicLink()) {
    throw new Error(`参数无效：--prior-answers 路径 ${answerArg} 不能是符号链接`);
  }
  if (dirTry?.isDirectory()) {
    const dir = resolveExistingDirInsideCwd(cwd, answerArg, '--prior-answers');
    const names = (await readdir(dir.canonical)).filter((n) => /^answer-.*\.(?:txt|json)$/.test(n)).sort();
    const collected: GateRefusalItem[] = [];
    for (const name of names) {
      const resolved = resolveExistingFileInsideCwd(cwd, join(dir.relative, name), '--prior-answers');
      const txt = await readFile(resolved.canonical, 'utf8');
      collected.push(...parseGateRefusalsFromAnswer(txt, caseIds, round));
    }
    return collected;
  }
  const resolved = resolveExistingFileInsideCwd(cwd, answerArg, '--prior-answers');
  const txt = await readFile(resolved.canonical, 'utf8');
  return parseGateRefusalsFromAnswer(txt, caseIds, round);
}

async function loadAttributionFromTarget(
  cwd: ResolvedCwd,
  noteArg: string,
  caseIds: ReadonlySet<string>,
  round: number,
): Promise<PriorAttributionItem | null> {
  const checked = resolveInsideCwd(cwd, noteArg, '--prior-notes');
  const dirTry = await lstat(checked.lexical).catch(() => null);
  if (dirTry?.isSymbolicLink()) {
    throw new Error(`参数无效：--prior-notes 路径 ${noteArg} 不能是符号链接`);
  }
  if (dirTry?.isDirectory()) {
    const dir = resolveExistingDirInsideCwd(cwd, noteArg, '--prior-notes');
    const names = (await readdir(dir.canonical)).filter((n) => n.endsWith('.json')).sort();
    for (const name of names) {
      const resolved = resolveExistingFileInsideCwd(cwd, join(dir.relative, name), '--prior-notes');
      const raw = parsedPlanFile(resolved.relative, await readFile(resolved.canonical));
      const matched = parsePriorAttribution(raw, caseIds, round, relative(cwd.canonical, resolved.canonical));
      if (matched) return matched;
    }
    return null;
  }
  const resolved = resolveExistingFileInsideCwd(cwd, noteArg, '--prior-notes');
  const raw = parsedPlanFile(resolved.relative, await readFile(resolved.canonical));
  return parsePriorAttribution(raw, caseIds, round, resolved.relative);
}

export async function loadCasePriorRounds(params: {
  cwd: ResolvedCwd;
  round: number;
  caseIds: ReadonlySet<string>;
  priorPlansArg?: string;
  priorReturnsArg?: string;
  priorAnswersArg?: string;
  priorNotesArg?: string;
  markers?: readonly string[];
}): Promise<{ rounds: PriorRoundRecord[]; streak: StreakAnalysis }> {
  const { cwd, round, caseIds, priorPlansArg, priorReturnsArg, priorAnswersArg, priorNotesArg, markers } = params;
  const rawLists = [
    parseCommaRoundList(priorPlansArg, null, '--prior-plans'),
    parseCommaRoundList(priorReturnsArg, null, '--prior-returns'),
    parseCommaRoundList(priorAnswersArg, null, '--prior-answers'),
    parseCommaRoundList(priorNotesArg, null, '--prior-notes'),
  ];
  const anySupplied = rawLists.some((l) => l.length > 0);
  if (round === 1 && anySupplied) {
    throw new Error('参数无效：第 1 轮不应传入上一轮历史（--prior-*）；如需生成第 2 轮及以上返工任务说明请显式传入 --round 2');
  }

  const maxLen = Math.max(0, ...rawLists.map((l) => l.length));
  const priorCount = anySupplied ? Math.max(round - 1, maxLen) : Math.max(0, round - 1);
  if (priorCount === 0) {
    return {
      rounds: [],
      streak: analyzeRoundHistory({ currentRound: round, rounds: [] }),
    };
  }

  const plans = parseCommaRoundList(priorPlansArg, priorCount, '--prior-plans');
  const returns = parseCommaRoundList(priorReturnsArg, priorCount, '--prior-returns');
  const answers = parseCommaRoundList(priorAnswersArg, priorCount, '--prior-answers');
  const notes = parseCommaRoundList(priorNotesArg, priorCount, '--prior-notes');

  const rounds: PriorRoundRecord[] = [];
  for (let i = 0; i < priorCount; i++) {
    const r = i + 1;
    const planArg = plans[i] ?? null;
    const returnsArg = returns[i] ?? null;
    const answerArg = answers[i] ?? null;
    const noteArg = notes[i] ?? null;

    if (!planArg && !returnsArg && !answerArg && !noteArg) continue;

    const loadedPlan = planArg
      ? await resolveCasePlanFromTarget(cwd, planArg, caseIds, '--prior-plans')
      : null;
    const deviceEvidence = returnsArg
      ? await loadDeviceEvidenceFromDir(cwd, returnsArg, r, caseIds, loadedPlan?.snapshot ?? null, markers)
      : null;
    const gateRefusals = answerArg
      ? await loadGateRefusalsFromTarget(cwd, answerArg, caseIds, r)
      : [];
    const attribution = noteArg
      ? await loadAttributionFromTarget(cwd, noteArg, caseIds, r)
      : null;

    const sigs: string[] = [];
    for (const g of gateRefusals) sigs.push(`gate:${g.code}`);
    if (deviceEvidence) sigs.push(...deviceEvidence.errorSignatures);
    if (sigs.length === 0 && attribution?.judged) {
      sigs.push(`note:${attribution.layer ? attribution.layer + ':' : ''}${attribution.judged.slice(0, 64)}`);
    }

    rounds.push({
      round: r,
      ...(loadedPlan ? { planSource: loadedPlan.path, plan: loadedPlan.snapshot } : {}),
      deviceEvidence,
      gateRefusals,
      attribution,
      errorSignatures: sigs,
    });
  }

  const streak = analyzeRoundHistory({ currentRound: round, rounds });
  return { rounds, streak };
}
