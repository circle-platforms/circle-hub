// Shared local-only loader for single-case prior-round history inputs (plans, returns, answers, notes).
// Enforces working-directory containment and strict single-case isolation across all prior rounds.
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import {
  analyzeRoundHistory,
  extractCaseDeviceEvidence,
  parseHubAnswerNotices,
  parsePriorAttribution,
  parsePriorPlanSnapshot,
  type GateRefusalItem,
  type HubAnswerNotices,
  type PriorAttributionItem,
  type PriorPlanSnapshot,
  type PriorRoundRecord,
  type StreakAnalysis,
} from '../functions/rework-history.ts';
import { CallFailure, isRecord } from '../functions/text.ts';
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
    throw new CallFailure("invalid_parameters", `${flagName} 不能为空；如需省略某一轮请用 - 占位或省略该选项`, "提供该选项的历史路径；省略单轮时用 - 占位，不传历史时省略整个选项");
  }
  const tokens = raw.split(',').map((part) => {
    const t = part.trim();
    return !t || SKIP_SLOT.has(t.toLowerCase()) ? null : t;
  });
  if (tokens.every((t) => t === null)) {
    throw new CallFailure("invalid_parameters", `${flagName} 不能全部为空或占位符`, "至少提供一轮历史路径；所有轮次均无历史时省略整个选项");
  }
  if (priorRoundCount !== null && priorRoundCount > 0) {
    if (tokens.length === priorRoundCount) return tokens;
    if (tokens.length === 1) {
      return [...new Array<null>(priorRoundCount - 1).fill(null), tokens[0]];
    }
    throw new CallFailure("invalid_parameters", `${flagName} 传入了 ${tokens.length} 项，与前序轮次数 ${priorRoundCount} 不一致（只传 1 项默认指上一轮，传多项须按第 1..${priorRoundCount} 轮顺序对齐，空缺轮次用 - 占位）`, "按第 1 到上一轮顺序提供相同数量的逗号分隔路径，缺失轮次写 -；仅供上一轮时只给一个路径");
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
    throw new CallFailure("invalid_parameters", `${flagLabel} 路径 ${targetArg} 不能是符号链接`, "把上一轮计划路径指向工作目录内的普通文件或目录，不使用符号链接");
  }
  if (dirTry?.isDirectory()) {
    const dir = resolveExistingDirInsideCwd(cwd, targetArg, flagLabel);
    const names = (await readdir(dir.canonical)).filter((n) => n.endsWith('.json')).sort();
    for (const name of names) {
      const fileResolved = resolveExistingFileInsideCwd(cwd, join(dir.relative, name), flagLabel);
      const parsed = parsedPlanFile(fileResolved.relative, await readFile(fileResolved.canonical));
      if (!isRecord(parsed) || Array.isArray(parsed.items)) continue;
      if (typeof parsed.item === 'string' && caseIds.has(parsed.item)) {
        return {
          path: fileResolved.relative,
          snapshot: parsePriorPlanSnapshot(parsed, caseIds, fileResolved.relative),
        };
      }
    }
    throw new CallFailure("not_found", `在上一轮计划目录 ${dir.relative} 中未找到用例 ${[...caseIds][0]} 的单条计划文件`, "把 --prior-plans 指向含当前用例单条计划的目录或该计划文件，勿传整批 submission.json");
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
    throw new CallFailure("invalid_parameters", `${label} 文件 ${relPath} 解析后超出所属目录范围`, "把返还文件移回所属返还目录，并在索引中使用目录内的相对路径");
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
    throw new CallFailure("invalid_parameters", 'index.json 解析后超出返还目录', "使用返还目录自身的 index.json，不能以路径跳转读取其他目录");
  }
  const returnsIndex = parsedPlanFile(indexResolved.relative, await readFile(indexResolved.canonical));
  if (!isRecord(returnsIndex) || returnsIndex.schema !== 'device-returns@1' || !Array.isArray(returnsIndex.jobs)) {
    throw new CallFailure("invalid_parameters", `${indexResolved.relative} 不是合法的 device-returns@1 索引文件`, "使用原始 device-returns@1 索引，保留 schema 和 jobs 数组后重试");
  }

  // Locate matching job row first so only THIS single case's session/log files are read from disk.
  const jobs = returnsIndex.jobs.filter(isRecord);
  let matchedRow: Record<string, unknown> | null = null;
  for (let i = jobs.length - 1; i >= 0; i--) {
    const job = jobs[i];
    if (!Array.isArray(job.rows)) continue;
    const hit = job.rows.find(
      (r) =>
        isRecord(r)
        && ((typeof r.item === 'string' && caseIds.has(r.item))
          || (typeof r.autoid === 'string' && caseIds.has(r.autoid))),
    );
    if (isRecord(hit)) {
      matchedRow = hit;
      break;
    }
  }
  if (!matchedRow) {
    throw new CallFailure("invalid_parameters", `返还目录 ${returnsDir.relative} 的 index.json 中不含当前用例 ${[...caseIds][0]}（请检查 --prior-returns 是否传错运行或目录）`, "把 --prior-returns 指向当前用例对应运行的返还目录，核对索引 rows.item 或 rows.autoid");
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

function assertAnswerPayloadShape(text: string, label: string): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  const isWrongRecord = (obj: Record<string, unknown>): boolean =>
    Array.isArray(obj.items)
    || obj.schema === 'device-returns@1'
    || isRecord(obj.cases)
    || (
      !('errors' in obj)
      && !('result' in obj)
      && !('acceptance' in obj)
      && !('call_result' in obj)
      && !('original_cases' in obj)
    );

  if (label.endsWith('.json') || trimmed.startsWith('{') || trimmed.startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      if (label.endsWith('.json')) {
        throw new CallFailure("invalid_parameters", `--prior-answers 文件 ${label} 不是合法 JSON`, "把 --prior-answers 指向该轮完整 JSON 答复，勿使用截断文件");
      }
      parsed = null;
    }
    if (parsed !== null) {
      if (!isRecord(parsed) || isWrongRecord(parsed)) {
        throw new CallFailure("invalid_parameters", `--prior-answers 文件 ${label} 不是合法的 submit_result/answer 响应（禁止传入 submission.json、index.json 或 notes.json）`, "提供该轮 submit_result 或 answer 的响应文件，不传提交计划、设备索引或归因记录");
      }
      return;
    }
  }

  for (const rawLine of trimmed.replace(/\r/g, '').split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('{') || !line.endsWith('}')) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isRecord(parsed) && isWrongRecord(parsed)) {
        throw new CallFailure("invalid_parameters", `--prior-answers 文件 ${label} 内嵌的 JSON 不是合法的 submit_result/answer 响应`, "提供含真实 submit_result 或 answer 响应的答复文件，不混入其他类型的 JSON");
      }
    } catch (e) {
      if (e instanceof CallFailure) throw e;
    }
  }
}

function assertAttributionPayloadShape(raw: unknown, label: string): void {
  if (!isRecord(raw) || (Array.isArray(raw.items) && !isRecord(raw.cases)) || raw.schema === 'device-returns@1') {
    throw new CallFailure("invalid_parameters", `--prior-notes 文件 ${label} 不是合法的 notes.json 或归因记录`, "把 --prior-notes 指向 notes.json 或该轮具名归因记录，不传计划或设备索引");
  }
  const hasNotesCases = isRecord(raw.cases);
  const hasAttrFields =
    typeof raw.judged === 'string'
    || typeof raw.conclusion === 'string'
    || typeof raw.summary === 'string'
    || typeof raw.remedy === 'string'
    || typeof raw.fix_direction === 'string'
    || typeof raw.next_step === 'string';
  if (!hasNotesCases && !hasAttrFields) {
    throw new CallFailure("invalid_parameters", `--prior-notes 文件 ${label} 缺少 cases 或归因字段（judged/remedy）`, "在 notes.json 提供 cases 对象，或在单条归因记录提供 judged、remedy 等声明字段");
  }
}

async function loadHubAnswerNoticesFromTarget(
  cwd: ResolvedCwd,
  answerArg: string,
  caseIds: ReadonlySet<string>,
  round: number,
): Promise<{ refusals: GateRefusalItem[]; acceptedNotices: GateRefusalItem[] }> {
  const checked = resolveInsideCwd(cwd, answerArg, '--prior-answers');
  const dirTry = await lstat(checked.lexical).catch(() => null);
  if (dirTry?.isSymbolicLink()) {
    throw new CallFailure("invalid_parameters", `--prior-answers 路径 ${answerArg} 不能是符号链接`, "把 --prior-answers 指向工作目录内的普通文件或目录，不使用符号链接");
  }
  const pushUnique = (target: GateRefusalItem[], items: readonly GateRefusalItem[]) => {
    for (const item of items) {
      if (!target.some((x) => x.code === item.code && x.path === item.path && x.message === item.message)) {
        target.push(item);
      }
    }
  };
  if (dirTry?.isDirectory()) {
    const dir = resolveExistingDirInsideCwd(cwd, answerArg, '--prior-answers');
    const names = (await readdir(dir.canonical)).filter((n) => /^answer-.*\.(?:txt|json)$/.test(n)).sort();
    const refusals: GateRefusalItem[] = [];
    const acceptedNotices: GateRefusalItem[] = [];
    for (const name of names) {
      const resolved = resolveExistingFileInsideCwd(cwd, join(dir.relative, name), '--prior-answers');
      const txt = await readFile(resolved.canonical, 'utf8');
      assertAnswerPayloadShape(txt, resolved.relative);
      const parsed: HubAnswerNotices = parseHubAnswerNotices(txt, caseIds, round);
      pushUnique(refusals, parsed.refusals);
      pushUnique(acceptedNotices, parsed.acceptedNotices);
    }
    return { refusals, acceptedNotices };
  }
  const resolved = resolveExistingFileInsideCwd(cwd, answerArg, '--prior-answers');
  const txt = await readFile(resolved.canonical, 'utf8');
  assertAnswerPayloadShape(txt, resolved.relative);
  const parsed: HubAnswerNotices = parseHubAnswerNotices(txt, caseIds, round);
  return { refusals: parsed.refusals, acceptedNotices: parsed.acceptedNotices };
}

async function loadAttributionFromTarget(
  cwd: ResolvedCwd,
  noteArg: string,
  caseIds: ReadonlySet<string>,
): Promise<PriorAttributionItem | null> {
  const checked = resolveInsideCwd(cwd, noteArg, '--prior-notes');
  const dirTry = await lstat(checked.lexical).catch(() => null);
  if (dirTry?.isSymbolicLink()) {
    throw new CallFailure("invalid_parameters", `--prior-notes 路径 ${noteArg} 不能是符号链接`, "把 --prior-notes 指向工作目录内的普通文件或目录，不使用符号链接");
  }
  if (dirTry?.isDirectory()) {
    const dir = resolveExistingDirInsideCwd(cwd, noteArg, '--prior-notes');
    const names = (await readdir(dir.canonical)).filter((n) => n.endsWith('.json')).sort();
    for (const name of names) {
      const resolved = resolveExistingFileInsideCwd(cwd, join(dir.relative, name), '--prior-notes');
      const raw = parsedPlanFile(resolved.relative, await readFile(resolved.canonical));
      assertAttributionPayloadShape(raw, resolved.relative);
      const matched = parsePriorAttribution(raw, caseIds, null, relative(cwd.canonical, resolved.canonical));
      if (matched) return matched;
    }
    return null;
  }
  const resolved = resolveExistingFileInsideCwd(cwd, noteArg, '--prior-notes');
  const raw = parsedPlanFile(resolved.relative, await readFile(resolved.canonical));
  assertAttributionPayloadShape(raw, resolved.relative);
  return parsePriorAttribution(raw, caseIds, null, resolved.relative);
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
}): Promise<{
  rounds: PriorRoundRecord[];
  streak: StreakAnalysis;
  unrecordedAttribution: PriorAttributionItem | null;
}> {
  const { cwd, round, caseIds, priorPlansArg, priorReturnsArg, priorAnswersArg, priorNotesArg, markers } = params;
  const rawLists = [
    parseCommaRoundList(priorPlansArg, null, '--prior-plans'),
    parseCommaRoundList(priorReturnsArg, null, '--prior-returns'),
    parseCommaRoundList(priorAnswersArg, null, '--prior-answers'),
    parseCommaRoundList(priorNotesArg, null, '--prior-notes'),
  ];
  const anySupplied = rawLists.some((l) => l.length > 0);
  if (round === 1 && anySupplied) {
    throw new CallFailure("invalid_parameters", '第 1 轮不应传入上一轮历史（--prior-*）；如需生成第 2 轮及以上返工任务说明请显式传入 --round 2', "第 1 轮省略 --prior-*；需要返工历史时明确 --round 2 或更大轮次");
  }

  const maxLen = Math.max(0, ...rawLists.map((l) => l.length));
  const priorCount = anySupplied ? Math.max(round - 1, maxLen) : Math.max(0, round - 1);
  if (priorCount === 0) {
    return {
      rounds: [],
      streak: analyzeRoundHistory({ currentRound: round, rounds: [] }),
      unrecordedAttribution: null,
    };
  }

  const plans = parseCommaRoundList(priorPlansArg, priorCount, '--prior-plans');
  const returns = parseCommaRoundList(priorReturnsArg, priorCount, '--prior-returns');
  const answers = parseCommaRoundList(priorAnswersArg, priorCount, '--prior-answers');
  const notes = parseCommaRoundList(priorNotesArg, priorCount, '--prior-notes');

  const roundMap = new Map<number, PriorRoundRecord>();
  const ensureRound = (r: number): PriorRoundRecord => {
    let rec = roundMap.get(r);
    if (!rec) {
      rec = {
        round: r,
        deviceEvidence: null,
        gateRefusals: [],
        acceptedNotices: [],
        attribution: null,
        errorSignatures: [],
      };
      roundMap.set(r, rec);
    }
    return rec;
  };
  let unrecordedAttribution: PriorAttributionItem | null = null;

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
    const hubNotices = answerArg
      ? await loadHubAnswerNoticesFromTarget(cwd, answerArg, caseIds, r)
      : { refusals: [], acceptedNotices: [] };
    const attribution = noteArg
      ? await loadAttributionFromTarget(cwd, noteArg, caseIds)
      : null;

    if (planArg || returnsArg || answerArg) {
      const rec = ensureRound(r);
      if (loadedPlan) {
        rec.planSource = loadedPlan.path;
        rec.plan = loadedPlan.snapshot;
      }
      if (deviceEvidence) rec.deviceEvidence = deviceEvidence;
      if (hubNotices.refusals.length > 0) rec.gateRefusals.push(...hubNotices.refusals);
      if (hubNotices.acceptedNotices.length > 0) {
        rec.acceptedNotices ??= [];
        rec.acceptedNotices.push(...hubNotices.acceptedNotices);
      }
      for (const g of hubNotices.refusals) rec.errorSignatures.push(`gate:${g.code}`);
      if (deviceEvidence) rec.errorSignatures.push(...deviceEvidence.errorSignatures);
    }

    if (attribution) {
      if (attribution.roundRecorded !== false && attribution.round !== null) {
        const targetRec = ensureRound(attribution.round);
        targetRec.attribution = attribution;
        if (targetRec.errorSignatures.length === 0 && attribution.judged) {
          targetRec.errorSignatures.push(
            `note:${attribution.layer ? attribution.layer + ':' : ''}${attribution.judged.slice(0, 64)}`,
          );
        }
      } else {
        // Notes JSON omitted `round`: keep strictly un-numbered so we never invent a `第 1 轮` claim.
        unrecordedAttribution = attribution;
      }
    }
  }

  const rounds = [...roundMap.values()].sort((a, b) => a.round - b.round);
  const streak = analyzeRoundHistory({ currentRound: round, rounds, unrecordedAttribution });
  return { rounds, streak, unrecordedAttribution };
}
