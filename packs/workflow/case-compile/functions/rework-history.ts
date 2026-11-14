// Deterministic per-case prior-round history, device evidence extraction (with 12,000-char gateway
// truncation disclosure), gate refusal extraction, and consecutive same-error streak analysis.
// Strictly isolates a single original case and never generates model conclusions or similarity matches.
import { failureLine, LEADING_PROMPT, type RowAudit } from './delivery.ts';
import { isRecord } from './text.ts';

/** Gateway tail truncation limit in bytes/chars on retained session transcripts (compile-excel-server). */
export const SESSION_RETAINED_CHARS = 12_000;
/** Inline tail budget per session file inside structured/rendered briefs to protect context budget. */
export const INLINE_TAIL_CHARS = 6_000;
/** Maximum authoring rounds allowed before closing under delivery rules. */
export const MAX_ROUNDS = 3;
/** Maximum anomaly lines highlighted from logs/returns per round. */
export const MAX_ANOMALY_LINES = 5;

/** Required verbatim disclosure whenever a prior step command cannot be found in retained session transcripts. */
export const MISSING_STEP_TRUNCATION_MSG = '这一步的设备输出不在保留的末尾 12,000 个字符内';
export const UNCONFIRMED_HYPOTHESIS_NOTE =
  '以下归因结论均标记为未确认假设（confidence: "hypothesis"）；编写或复核前须对照上述原始设备输出独立核对后再采纳或推翻。';

export interface PlanStepSummary {
  index: number;
  object: string;
  method: string;
  args: string[];
  keywords?: Record<string, unknown>;
  description?: string;
  cleanup?: boolean;
  commandText: string;
  summary: string;
}

export interface PlanBlockSummary {
  id: string;
  kind: string;
  object?: string;
  method?: string;
  target?: string;
  commandText?: string;
  summary: string;
  isCleanup?: boolean;
}

export interface PlanExpectSummary {
  index: number;
  text: string;
  after?: number;
  op?: string;
  basis?: string;
  quoteText?: string;
  summary: string;
}

export interface PriorPlanSnapshot {
  item: string;
  handling: string;
  text: string;
  isBlocks: boolean;
  replacementsCount: number;
  steps: PlanStepSummary[];
  blocks: PlanBlockSummary[];
  expects: PlanExpectSummary[];
}

export interface PlanDiffSummary {
  fromRound: number;
  toRound: number;
  handlingChanged?: { from: string; to: string };
  replacementsChanged?: { from: number; to: number };
  added: string[];
  removed: string[];
  modified: string[];
  unchanged: boolean;
  lines: string[];
}

export interface SyntaxRejectionItem {
  session?: string;
  command: string;
  token?: string;
  prompt?: string;
}

export interface ExecutionRefusalItem {
  session?: string;
  command: string;
  prompt: string;
  reply: string[];
  echo_cut?: true;
}

export interface GateRefusalItem {
  round: number;
  source: 'hub_gate' | 'local_check';
  code: string;
  path: string;
  message: string;
  fix: string;
}

export interface PriorAttributionItem {
  round: number;
  sourceFile: string;
  confidence: 'hypothesis';
  judged: string;
  remedy: string;
  layer?: string;
  disposition?: string;
  fixDirection?: string;
  evidenceQuotes: string[];
  defectCandidate?: { repro: string; expected: string; actual: string };
  authorConflict?: { author: string; manual: string; reference: string };
}

export interface StepDeviceExcerpt {
  stepIndex?: number;
  stepSummary: string;
  commandText: string;
  source: 'syntax_rejected' | 'execution_refused' | 'pass_review' | 'log_step' | 'plan_step';
  found: boolean;
  sessionName?: string;
  sessionChars?: number;
  missingNotice?: string;
  excerpt?: string;
}

export interface DeviceReturnEvidence {
  round: number;
  verificationRun: string;
  job: string;
  verdict: string;
  runnerVerdict?: string;
  passReview: RowAudit | null;
  syntaxRejected: SyntaxRejectionItem[];
  executionRefused: ExecutionRefusalItem[];
  stepExcerpts: StepDeviceExcerpt[];
  anomalyLines: string[];
  inlineTail: string;
  logExcerpt: string;
  logFile: string | null;
  sessionFiles: Record<string, string | null>;
  sessionLengths: Record<string, number>;
  withheldNotes: string[];
  errorSignatures: string[];
}

export interface PriorRoundRecord {
  round: number;
  planSource?: string;
  plan?: PriorPlanSnapshot | null;
  deviceEvidence?: DeviceReturnEvidence | null;
  gateRefusals: GateRefusalItem[];
  attribution?: PriorAttributionItem | null;
  errorSignatures: string[];
}

export interface StreakAnalysis {
  currentRound: number;
  attemptLimit: number;
  remainingAttempts: number;
  finalAttempt: boolean;
  consecutiveSameError: number;
  repeatedCategory?: string;
  repeatedSignature?: string;
  varyFormRequired: boolean;
  roundChanges: PlanDiffSummary[];
}

const WAIT_ONLY_METHOD = /^(?:sleep|wait|pause|delay)$/i;
const ANSI_ESCAPE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const CTRL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

function cleanLineForMatch(line: string): string {
  const withoutAnsi = line.replace(ANSI_ESCAPE, '');
  const parts = withoutAnsi.split('\r');
  const collapsed = parts[parts.length - 1] ?? '';
  return collapsed.replace(CTRL_CHARS, '').trim();
}

function normalizeErrorToken(value: string): string {
  return value
    .replace(/\r/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\b/g, '<ts>')
    .replace(/\brun_[0-9a-z]{26}\b/g, '<run>')
    .replace(/\bjob_[0-9a-z]+\b/g, '<job>')
    .trim();
}

function commandSignatureHead(command: string): string {
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  return tokens.slice(0, Math.min(4, tokens.length)).join(' ').toLowerCase();
}

/** Expands known exact case identifiers from `--case` and optional item JSON; never fuzzy-matches other cases. */
export function buildCaseIdSet(caseRef: string, item?: unknown): Set<string> {
  const ids = new Set<string>();
  const trimmed = caseRef.trim();
  if (trimmed) {
    ids.add(trimmed);
    const firstToken = trimmed.split(/\s+/, 1)[0];
    if (firstToken && firstToken.length >= 2) ids.add(firstToken);
  }
  if (isRecord(item)) {
    if (typeof item.id === 'string' && item.id.trim()) ids.add(item.id.trim());
    if (isRecord(item.fields)) {
      if (typeof item.fields.autoid === 'string' && item.fields.autoid.trim()) ids.add(item.fields.autoid.trim());
      if (
        isRecord(item.fields.recomposition)
        && isRecord(item.fields.recomposition.record)
        && isRecord(item.fields.recomposition.record.case)
        && typeof item.fields.recomposition.record.case.id === 'string'
        && item.fields.recomposition.record.case.id.trim()
      ) {
        ids.add(item.fields.recomposition.record.case.id.trim());
      }
    }
  }
  return ids;
}

function resolvePlanDataObject(raw: unknown): {
  item: string;
  handling: string;
  text: string;
  data: Record<string, unknown>;
} {
  if (!isRecord(raw)) {
    throw new Error('不是合法的计划 JSON 对象');
  }
  if (isRecord(raw.slots) && Array.isArray(raw.slots.plan) && raw.slots.plan.length > 0 && isRecord(raw.slots.plan[0])) {
    const stmt = raw.slots.plan[0];
    const data = isRecord(stmt.data) ? stmt.data : {};
    return {
      item: typeof raw.item === 'string' ? raw.item : '',
      handling: typeof raw.handling === 'string' ? raw.handling : 'handled',
      text: typeof stmt.text === 'string' ? stmt.text : '',
      data,
    };
  }
  if (isRecord(raw.data)) {
    return {
      item: typeof raw.item === 'string' ? raw.item : '',
      handling: typeof raw.handling === 'string' ? raw.handling : 'handled',
      text: typeof raw.text === 'string' ? raw.text : '',
      data: raw.data,
    };
  }
  if (Array.isArray(raw.steps) || Array.isArray(raw.blocks) || typeof raw.bucket === 'string') {
    return {
      item: typeof raw.item === 'string' ? raw.item : '',
      handling: typeof raw.handling === 'string' ? raw.handling : 'handled',
      text: typeof raw.text === 'string' ? raw.text : '',
      data: raw,
    };
  }
  return {
    item: typeof raw.item === 'string' ? raw.item : '',
    handling: typeof raw.handling === 'string' ? raw.handling : 'handled',
    text: '',
    data: {},
  };
}

function blockCommandText(block: Record<string, unknown>): string {
  for (const field of ['cmd', 'command']) {
    if (typeof block[field] === 'string' && block[field].trim()) return block[field].trim();
  }
  if (Array.isArray(block.commands) && typeof block.commands[0] === 'string') {
    return block.commands.filter((v): v is string => typeof v === 'string').join(' ; ');
  }
  if (Array.isArray(block.args) && typeof block.args[0] === 'string' && block.args[0].trim()) {
    return block.args[0].trim();
  }
  return '';
}

/** Parses one prior-round plan JSON into a normalized snapshot, refusing plans that belong to another case. */
export function parsePriorPlanSnapshot(
  raw: unknown,
  caseIds: ReadonlySet<string>,
  sourceLabel = '上一轮计划',
): PriorPlanSnapshot {
  const { item, handling, text, data } = resolvePlanDataObject(raw);
  if (item && caseIds.size > 0 && !caseIds.has(item)) {
    throw new Error(
      `参数无效：${sourceLabel} 属于原始用例 ${item}，与当前任务目标（${[...caseIds][0]}）不一致。禁止混入其他用例计划`,
    );
  }

  const replacementsCount = Array.isArray(data.replacements) ? data.replacements.length : 0;
  const rawSteps = Array.isArray(data.steps) ? data.steps.filter(isRecord) : [];
  const rawBlocks = Array.isArray(data.blocks) ? data.blocks.filter(isRecord) : [];
  const rawExpects = Array.isArray(data.expects) ? data.expects.filter(isRecord) : [];

  const steps: PlanStepSummary[] = rawSteps.map((step, i) => {
    const object = typeof step.object === 'string' ? step.object : '';
    const method = typeof step.method === 'string' ? step.method : '';
    const args = Array.isArray(step.args) ? step.args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))) : [];
    const keywords = isRecord(step.keywords) ? step.keywords : undefined;
    const description = typeof step.description === 'string' ? step.description.trim() : undefined;
    const cleanup = step.cleanup === true;
    const firstArg = args[0] ?? '';
    const isWait = WAIT_ONLY_METHOD.test(method) || WAIT_ONLY_METHOD.test(object);
    const commandText = !isWait && firstArg && !/^\d+$/.test(firstArg.trim()) ? firstArg.trim() : '';
    const kwNote = keywords && Object.keys(keywords).length > 0 ? ` ${JSON.stringify(keywords)}` : '';
    const cleanTag = cleanup ? ' [cleanup]' : '';
    const descTag = description ? ` // ${description}` : '';
    const summary = `[${i + 1}] ${object}.${method}(${args.map((a) => JSON.stringify(a)).join(', ')})${kwNote}${cleanTag}${descTag}`;
    return {
      index: i + 1,
      object,
      method,
      args,
      ...(keywords ? { keywords } : {}),
      ...(description ? { description } : {}),
      ...(cleanup ? { cleanup } : {}),
      commandText,
      summary,
    };
  });

  const blocks: PlanBlockSummary[] = rawBlocks.map((block, i) => {
    const id = typeof block.id === 'string' ? block.id : `b${i + 1}`;
    const kind = typeof block.kind === 'string' ? block.kind : 'unknown';
    const object = typeof block.object === 'string' ? block.object : typeof block.device === 'string' ? block.device : undefined;
    const method = typeof block.method === 'string' ? block.method : undefined;
    const target = typeof block.target === 'string' ? block.target : typeof block.for === 'string' ? block.for : undefined;
    const commandText = blockCommandText(block);
    const isCleanup = kind === 'RESTORE_FROM' || block.cleanup === true || block.phase === 'cleanup';
    const bodyParts = [
      `${id}:${kind}`,
      object || method ? `${object ?? ''}${method ? '.' + method : ''}` : '',
      commandText ? JSON.stringify(commandText) : '',
      typeof block.literal === 'string' ? `literal=${JSON.stringify(block.literal)}` : '',
      typeof block.text === 'string' ? `text=${JSON.stringify(block.text)}` : '',
      typeof block.pattern === 'string' ? `pattern=${JSON.stringify(block.pattern)}` : '',
      target ? `target=${target}` : '',
      typeof block.op === 'string' ? `op=${block.op}` : '',
    ].filter(Boolean);
    return {
      id,
      kind,
      ...(object ? { object } : {}),
      ...(method ? { method } : {}),
      ...(target ? { target } : {}),
      ...(commandText ? { commandText } : {}),
      ...(isCleanup ? { isCleanup } : {}),
      summary: `[块 ${i + 1}] ${bodyParts.join(' | ')}`,
    };
  });

  const expects: PlanExpectSummary[] = rawExpects.map((exp, i) => {
    const expText = typeof exp.text === 'string' ? exp.text : '';
    const after = typeof exp.after === 'number' ? exp.after : undefined;
    const op = typeof exp.op === 'string' ? exp.op : undefined;
    const basis = typeof exp.basis === 'string' ? exp.basis : undefined;
    const quoteText = isRecord(exp.quote) && typeof exp.quote.text === 'string' ? exp.quote.text : undefined;
    const flags = [
      after !== undefined ? `after=${after}` : '',
      op ? `op=${op}` : '',
      basis ? `basis=${basis}` : '',
    ].filter(Boolean).join(', ');
    const summary = `[期望 ${i + 1}] ${flags ? `(${flags}) ` : ''}${JSON.stringify(expText)}`;
    return {
      index: i + 1,
      text: expText,
      ...(after !== undefined ? { after } : {}),
      ...(op ? { op } : {}),
      ...(basis ? { basis } : {}),
      ...(quoteText ? { quoteText } : {}),
      summary,
    };
  });

  return {
    item,
    handling,
    text,
    isBlocks: blocks.length > 0 && steps.length === 0,
    replacementsCount,
    steps,
    blocks,
    expects,
  };
}

/** Line-level LCS diff returning verbatim added/removed entries in chronological order. */
function diffLineLists(prevLines: readonly string[], currLines: readonly string[]): Array<{ kind: 'same' | 'del' | 'add'; line: string }> {
  const n = prevLines.length;
  const m = currLines.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = prevLines[i] === currLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops: Array<{ kind: 'same' | 'del' | 'add'; line: string }> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (prevLines[i] === currLines[j]) {
      ops.push({ kind: 'same', line: prevLines[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ kind: 'del', line: prevLines[i] });
      i++;
    } else {
      ops.push({ kind: 'add', line: currLines[j] });
      j++;
    }
  }
  while (i < n) ops.push({ kind: 'del', line: prevLines[i++] });
  while (j < m) ops.push({ kind: 'add', line: currLines[j++] });
  return ops;
}

/** Deterministic verbatim diff between two rounds of the same case's plan without model interpretation. */
export function diffPlanSnapshots(
  prev: PriorPlanSnapshot,
  curr: PriorPlanSnapshot,
  fromRound: number,
  toRound: number,
): PlanDiffSummary {
  const prevEntries = [
    ...(prev.isBlocks ? prev.blocks.map((b) => b.summary) : prev.steps.map((s) => s.summary)),
    ...prev.expects.map((e) => e.summary),
  ];
  const currEntries = [
    ...(curr.isBlocks ? curr.blocks.map((b) => b.summary) : curr.steps.map((s) => s.summary)),
    ...curr.expects.map((e) => e.summary),
  ];

  const ops = diffLineLists(prevEntries, currEntries);
  const added: string[] = [];
  const removed: string[] = [];
  const modified: string[] = [];
  const lines: string[] = [];

  const handlingChanged = prev.handling !== curr.handling ? { from: prev.handling, to: curr.handling } : undefined;
  const replacementsChanged =
    prev.replacementsCount !== curr.replacementsCount
      ? { from: prev.replacementsCount, to: curr.replacementsCount }
      : undefined;

  if (handlingChanged) lines.push(`~ handling: ${handlingChanged.from} -> ${handlingChanged.to}`);
  if (replacementsChanged) lines.push(`~ replacements 条数: ${replacementsChanged.from} -> ${replacementsChanged.to}`);

  let idx = 0;
  while (idx < ops.length) {
    if (ops[idx].kind === 'same') {
      idx++;
      continue;
    }
    const dels: string[] = [];
    const adds: string[] = [];
    while (idx < ops.length && ops[idx].kind !== 'same') {
      if (ops[idx].kind === 'del') dels.push(ops[idx].line);
      else adds.push(ops[idx].line);
      idx++;
    }
    const paired = Math.min(dels.length, adds.length);
    for (let k = 0; k < paired; k++) {
      modified.push(`${dels[k]} ==> ${adds[k]}`);
      lines.push(`~ 改动: ${dels[k]}  ==>  ${adds[k]}`);
    }
    for (let k = paired; k < dels.length; k++) {
      removed.push(dels[k]);
      lines.push(`- 删去: ${dels[k]}`);
    }
    for (let k = paired; k < adds.length; k++) {
      added.push(adds[k]);
      lines.push(`+ 新增: ${adds[k]}`);
    }
  }

  const unchanged = lines.length === 0;
  if (unchanged) lines.push('（与上一轮相比，steps/blocks/expects/handling 原文未变化）');

  return {
    fromRound,
    toRound,
    ...(handlingChanged ? { handlingChanged } : {}),
    ...(replacementsChanged ? { replacementsChanged } : {}),
    added,
    removed,
    modified,
    unchanged,
    lines,
  };
}

/**
 * Searches for a CLI command inside a retained device session transcript (`text`)
 * and returns a verbatim window (`<= ~1600` chars) from the session lines, or `{ found: false }`.
 */
export function findCommandInSession(
  sessionText: string,
  command: string,
): { found: boolean; lineIndex?: number; excerpt?: string } {
  const cmdTrim = cleanLineForMatch(command);
  if (!cmdTrim) return { found: false };
  const rawLines = sessionText.replace(/\r\n/g, '\n').split('\n');
  const shortPrefix = cmdTrim.length >= 16 ? cmdTrim.slice(0, 24) : '';

  let matchIndex = -1;
  for (let i = 0; i < rawLines.length; i++) {
    const cleaned = cleanLineForMatch(rawLines[i]);
    if (!cleaned) continue;
    const prompted = LEADING_PROMPT.exec(cleaned);
    const body = prompted ? cleaned.slice(prompted[1].length).trim() : cleaned;
    if (!body) continue;
    if (
      body === cmdTrim
      || cleaned === cmdTrim
      || (shortPrefix && body.startsWith(shortPrefix))
      || (body.length >= 16 && cmdTrim.startsWith(body) && prompted !== null)
    ) {
      matchIndex = i;
      break;
    }
  }

  if (matchIndex < 0) return { found: false };

  const start = Math.max(0, matchIndex - 1);
  let end = matchIndex + 1;
  while (end < rawLines.length && end < matchIndex + 18) {
    const cleaned = cleanLineForMatch(rawLines[end]);
    if (LEADING_PROMPT.test(cleaned) && end > matchIndex) {
      // Include one trailing prompt line so return-to-prompt is visible.
      end++;
      break;
    }
    end++;
  }
  const sliceText = rawLines.slice(start, end).map((l) => l.replace(/\r/g, '')).join('\n').trimEnd();
  const capped = sliceText.length > 1600 ? sliceText.slice(0, 1600) + '\n…（此步后续输出已按长度上限省略，完整原文见对应会话文件）' : sliceText;
  return { found: true, lineIndex: matchIndex, excerpt: capped };
}

function collectCandidateLogLines(logText: string): string[] {
  const lines = logText
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length <= 24) return lines;
  const hitIndices = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    if (/(?:fail|error|refus|timeout|超时|未命中|拒绝|失败|mismatch|exception|caret|\^)/i.test(lines[i])) {
      for (let k = Math.max(0, i - 1); k <= Math.min(lines.length - 1, i + 1); k++) hitIndices.add(k);
    }
  }
  if (hitIndices.size > 0) {
    return [...hitIndices].sort((a, b) => a - b).slice(0, 24).map((i) => lines[i]);
  }
  return [...lines.slice(0, 8), '…（中间日志略）', ...lines.slice(-12)];
}

/**
 * Extracts deterministic single-case device evidence from `returns/index.json`, saved session texts,
 * and `log.txt`, disclosing `MISSING_STEP_TRUNCATION_MSG` whenever a prior/failing step is missing
 * from retained transcripts.
 */
export function extractCaseDeviceEvidence(params: {
  round: number;
  returnsIndex: unknown;
  caseIds: ReadonlySet<string>;
  sessionTexts: ReadonlyMap<string, { path: string; text: string }>;
  logText?: string | null;
  logPath?: string | null;
  priorPlan?: PriorPlanSnapshot | null;
  markers?: readonly string[];
}): DeviceReturnEvidence | null {
  if (!isRecord(params.returnsIndex) || !Array.isArray(params.returnsIndex.jobs)) return null;

  const jobs = params.returnsIndex.jobs.filter(isRecord);
  let matchedJob: Record<string, unknown> | null = null;
  let matchedRow: Record<string, unknown> | null = null;
  // Take the latest job row matching any exact ID of THIS single case.
  for (let ji = jobs.length - 1; ji >= 0; ji--) {
    const job = jobs[ji];
    if (!Array.isArray(job.rows)) continue;
    const row = job.rows.find((candidate) => isRecord(candidate) && typeof candidate.item === 'string' && params.caseIds.has(candidate.item));
    if (isRecord(row)) {
      matchedJob = job;
      matchedRow = row;
      break;
    }
  }
  if (!matchedJob || !matchedRow) return null;

  const syntaxRejected: SyntaxRejectionItem[] = Array.isArray(matchedRow.syntax_rejected)
    ? matchedRow.syntax_rejected
        .filter(isRecord)
        .filter((s) => typeof s.command === 'string' && s.command.trim())
        .map((s) => ({
          ...(typeof s.session === 'string' ? { session: s.session } : {}),
          command: String(s.command).trim(),
          ...(typeof s.token === 'string' ? { token: s.token } : {}),
          ...(typeof s.prompt === 'string' ? { prompt: s.prompt } : {}),
        }))
    : [];

  const executionRefused: ExecutionRefusalItem[] = Array.isArray(matchedRow.execution_refused)
    ? matchedRow.execution_refused
        .filter(isRecord)
        .filter((e) => typeof e.command === 'string' && e.command.trim())
        .map((e) => ({
          ...(typeof e.session === 'string' ? { session: e.session } : {}),
          command: String(e.command).trim(),
          prompt: typeof e.prompt === 'string' ? e.prompt : '',
          reply: Array.isArray(e.reply) ? e.reply.map(String) : [],
          ...(e.echo_cut === true ? { echo_cut: true as const } : {}),
        }))
    : [];

  const passReview: RowAudit | null =
    isRecord(matchedRow.pass_review) && typeof matchedRow.pass_review.where === 'string' && typeof matchedRow.pass_review.line === 'string'
      ? { where: matchedRow.pass_review.where, line: matchedRow.pass_review.line }
      : null;

  const sessionFiles: Record<string, string | null> = {};
  if (isRecord(matchedRow.sessions)) {
    for (const [key, val] of Object.entries(matchedRow.sessions)) {
      sessionFiles[key] = typeof val === 'string' ? val : null;
    }
  }

  const sessionLengths: Record<string, number> = {};
  for (const [name, entry] of params.sessionTexts.entries()) {
    sessionLengths[name] = entry.text.length;
  }
  const hasSavedSessions = params.sessionTexts.size > 0;

  // Build ordered commands to locate in session transcripts.
  const commandsToLocate: Array<{
    stepIndex?: number;
    stepSummary: string;
    commandText: string;
    source: StepDeviceExcerpt['source'];
    preferredSession?: string;
    important: boolean;
  }> = [];
  const seenCommands = new Set<string>();

  for (const sr of syntaxRejected) {
    const key = `syntax::${sr.command}`;
    if (seenCommands.has(key)) continue;
    seenCommands.add(key);
    commandsToLocate.push({
      stepSummary: `syntax_rejected (${sr.prompt ?? 'unknown prompt'})`,
      commandText: sr.command,
      source: 'syntax_rejected',
      preferredSession: sr.session,
      important: true,
    });
  }
  for (const er of executionRefused) {
    const key = `exec::${er.command}`;
    if (seenCommands.has(key)) continue;
    seenCommands.add(key);
    commandsToLocate.push({
      stepSummary: `execution_refused (${er.prompt})`,
      commandText: er.command,
      source: 'execution_refused',
      preferredSession: er.session,
      important: true,
    });
  }

  if (params.priorPlan) {
    if (!params.priorPlan.isBlocks) {
      for (const step of params.priorPlan.steps) {
        if (!step.commandText) continue;
        const already =
          seenCommands.has(`syntax::${step.commandText}`) || seenCommands.has(`exec::${step.commandText}`);
        if (already) continue;
        seenCommands.add(`plan::${step.index}::${step.commandText}`);
        commandsToLocate.push({
          stepIndex: step.index,
          stepSummary: step.summary,
          commandText: step.commandText,
          source: 'plan_step',
          important: !step.cleanup,
        });
      }
    } else {
      for (const block of params.priorPlan.blocks) {
        if (!block.commandText) continue;
        commandsToLocate.push({
          stepSummary: block.summary,
          commandText: block.commandText,
          source: 'plan_step',
          important: !block.isCleanup,
        });
      }
    }
  }

  const stepExcerpts: StepDeviceExcerpt[] = [];
  for (const target of commandsToLocate) {
    if (!hasSavedSessions) {
      if (target.source !== 'plan_step' || target.important) {
        stepExcerpts.push({
          ...(target.stepIndex !== undefined ? { stepIndex: target.stepIndex } : {}),
          stepSummary: target.stepSummary,
          commandText: target.commandText,
          source: target.source,
          found: false,
          missingNotice: '本次返还目录中未保存该用例的设备会话文本，无法逐行核对这一步的终端输出',
        });
      }
      continue;
    }

    const orderedSessions = [...params.sessionTexts.entries()];
    if (target.preferredSession) {
      orderedSessions.sort(([a], [b]) => (a === target.preferredSession ? -1 : b === target.preferredSession ? 1 : 0));
    }

    let matchedSessionName: string | undefined;
    let matchedSessionChars: number | undefined;
    let foundExcerpt: string | undefined;

    for (const [sessionName, entry] of orderedSessions) {
      const hit = findCommandInSession(entry.text, target.commandText);
      if (hit.found && hit.excerpt) {
        matchedSessionName = sessionName;
        matchedSessionChars = entry.text.length;
        foundExcerpt = hit.excerpt;
        break;
      }
    }

    if (foundExcerpt && matchedSessionName !== undefined) {
      stepExcerpts.push({
        ...(target.stepIndex !== undefined ? { stepIndex: target.stepIndex } : {}),
        stepSummary: target.stepSummary,
        commandText: target.commandText,
        source: target.source,
        found: true,
        sessionName: matchedSessionName,
        sessionChars: matchedSessionChars,
        excerpt: foundExcerpt,
      });
    } else {
      const firstSession = orderedSessions[0];
      stepExcerpts.push({
        ...(target.stepIndex !== undefined ? { stepIndex: target.stepIndex } : {}),
        stepSummary: target.stepSummary,
        commandText: target.commandText,
        source: target.source,
        found: false,
        ...(firstSession ? { sessionName: firstSession[0], sessionChars: firstSession[1].text.length } : {}),
        missingNotice: MISSING_STEP_TRUNCATION_MSG,
      });
    }
  }

  // Extract tail excerpt across sessions (prefer session with refusal or longest transcript), bounded to INLINE_TAIL_CHARS.
  const sessionEntries = [...params.sessionTexts.entries()];
  sessionEntries.sort(([a, ea], [b, eb]) => {
    const aRefused = syntaxRejected.some((s) => s.session === a) || executionRefused.some((e) => e.session === a) ? 1 : 0;
    const bRefused = syntaxRejected.some((s) => s.session === b) || executionRefused.some((e) => e.session === b) ? 1 : 0;
    return bRefused - aRefused || eb.text.length - ea.text.length;
  });
  let inlineTail = '';
  if (sessionEntries.length > 0) {
    const [primaryName, primary] = sessionEntries[0];
    const cleanText = primary.text.replace(/\r/g, '');
    const slice = cleanText.length > INLINE_TAIL_CHARS ? cleanText.slice(-INLINE_TAIL_CHARS) : cleanText;
    const prefixNote =
      cleanText.length > INLINE_TAIL_CHARS
        ? `[${primaryName} 仅展示末尾 ${INLINE_TAIL_CHARS} / ${cleanText.length} 字符] `
        : `[${primaryName} 共 ${cleanText.length} 字符] `;
    const candidateTail = `${prefixNote}\n${slice}`;
    inlineTail =
      candidateTail.length > INLINE_TAIL_CHARS
        ? candidateTail.slice(-INLINE_TAIL_CHARS)
        : candidateTail;
  }

  const logText = params.logText ?? '';
  const logLines = logText ? collectCandidateLogLines(logText) : [];
  const logExcerpt = logLines.join('\n').slice(0, 3000);

  const anomalyLines: string[] = [];
  const pushAnomaly = (line: string): void => {
    const clean = line.trim();
    if (!clean || anomalyLines.includes(clean) || anomalyLines.length >= MAX_ANOMALY_LINES) return;
    anomalyLines.push(clean);
  };
  if (passReview) pushAnomaly(`${passReview.where}: ${passReview.line}`);
  for (const sr of syntaxRejected) pushAnomaly(`syntax_rejected[${sr.prompt ?? '?'}]: ${sr.command}${sr.token ? ` (^ ${sr.token})` : ''}`);
  for (const er of executionRefused) pushAnomaly(`execution_refused[${er.prompt}]: ${er.command} => ${er.reply.join(' / ')}`);
  if (params.markers && params.markers.length > 0) {
    const markerTexts: Record<string, string> = {};
    if (logText) markerTexts['log.txt'] = logText;
    for (const [sName, entry] of params.sessionTexts.entries()) markerTexts[sName] = entry.text;
    const markerHit = failureLine(markerTexts, params.markers, []);
    if (markerHit) pushAnomaly(`${markerHit.where}: ${markerHit.line}`);
  }
  for (const line of logLines) {
    if (anomalyLines.length >= MAX_ANOMALY_LINES) break;
    if (/(?:fail|error|timeout|超时|未命中|拒绝|失败)/i.test(line)) pushAnomaly(line);
  }

  const verdict = typeof matchedRow.verdict === 'string' ? matchedRow.verdict : 'unknown';
  const runnerVerdict = typeof matchedRow.runner_verdict === 'string' ? matchedRow.runner_verdict : undefined;

  const withheldNotes: string[] = [];
  if (Array.isArray(params.returnsIndex.withheld)) {
    for (const entry of params.returnsIndex.withheld) {
      if (typeof entry === 'string' && [...params.caseIds].some((id) => entry.includes(id))) {
        withheldNotes.push(entry);
      }
    }
  }
  for (const [sName, pathVal] of Object.entries(sessionFiles)) {
    if (pathVal === null) withheldNotes.push(`会话 ${sName} 未保存或无权读取（sessions[${sName}]=null）`);
  }

  const errorSignatures: string[] = [];
  for (const sr of syntaxRejected) errorSignatures.push(`syntax:${commandSignatureHead(sr.command)}${sr.token ? `:${sr.token.toLowerCase()}` : ''}`);
  for (const er of executionRefused) errorSignatures.push(`exec_refused:${commandSignatureHead(er.command)}:${normalizeErrorToken(er.reply[0] ?? '')}`);
  if (passReview) errorSignatures.push(`pass_review:${normalizeErrorToken(passReview.line)}`);
  if (errorSignatures.length === 0 && verdict !== 'pass') {
    const firstAnomaly = anomalyLines[0];
    errorSignatures.push(firstAnomaly ? `device_fail:${normalizeErrorToken(firstAnomaly)}` : `device_verdict:${verdict}`);
  }

  return {
    round: params.round,
    verificationRun: typeof matchedJob.verification_run === 'string' ? matchedJob.verification_run : String(params.returnsIndex.run ?? ''),
    job: typeof matchedJob.job === 'string' ? matchedJob.job : '',
    verdict,
    ...(runnerVerdict ? { runnerVerdict } : {}),
    passReview,
    syntaxRejected,
    executionRefused,
    stepExcerpts,
    anomalyLines,
    inlineTail,
    logExcerpt,
    logFile: params.logPath ?? (typeof matchedRow.log === 'string' ? matchedRow.log : null),
    sessionFiles,
    sessionLengths,
    withheldNotes,
    errorSignatures,
  };
}

/** Parses an `answer-*.txt` file from `submit-plans.ts`, keeping ONLY errors relevant to THIS case. */
export function parseGateRefusalsFromAnswer(
  answerText: string,
  caseIds: ReadonlySet<string>,
  round: number,
): GateRefusalItem[] {
  const trimmed = answerText.trim();
  if (!trimmed) return [];
  const items: GateRefusalItem[] = [];
  const pushItem = (item: GateRefusalItem): void => {
    const dup = items.some((x) => x.code === item.code && x.path === item.path && x.message === item.message);
    if (!dup) items.push(item);
  };

  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (isRecord(parsed)) {
      const errorList = Array.isArray(parsed.errors)
        ? parsed.errors
        : isRecord(parsed.result) && Array.isArray(parsed.result.errors)
          ? parsed.result.errors
          : [];
      for (const err of errorList) {
        if (!isRecord(err)) continue;
        const itemField = typeof err.item === 'string' ? err.item : '';
        if (itemField && caseIds.size > 0 && !caseIds.has(itemField)) continue;
        const msg = typeof err.message === 'string' ? err.message : '';
        if (!itemField && caseIds.size > 0 && ![...caseIds].some((id) => msg.includes(id))) {
          // Include batch-level schema/protocol refusal only if error does not mention another item.
          if (/(?:item_|99\d{14,}|doc-\d+:c-\d+)/.test(msg)) continue;
        }
        pushItem({
          round,
          source: 'hub_gate',
          code: typeof err.code === 'string' ? err.code : 'GATE_REFUSAL',
          path: typeof err.pointer === 'string' ? err.pointer : typeof err.path === 'string' ? err.path : '',
          message: msg || JSON.stringify(err),
          fix: typeof err.fix === 'string' ? err.fix : '',
        });
      }
      if (items.length > 0) return items;
    }
  } catch {
    // Plain-text Hub answer format: scan line blocks matching caseIds.
  }

  const lines = trimmed.replace(/\r/g, '').split('\n');
  const ids = [...caseIds];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const matchesCase = ids.length === 0 || ids.some((id) => line.includes(id));
    if (!matchesCase) continue;
    const codeMatch = /\b([A-Z][A-Z0-9_]{2,}|case-compile\.[a-z0-9_]+)\b/.exec(line);
    const pointerMatch = /(\/[A-Za-z0-9_./[\]-]+)/.exec(line);
    const nextLine = i + 1 < lines.length && /^(?:修复|建议|fix[:：])/i.test(lines[i + 1].trim()) ? lines[i + 1].trim() : '';
    pushItem({
      round,
      source: 'hub_gate',
      code: codeMatch ? codeMatch[1] : 'GATE_REFUSAL',
      path: pointerMatch ? pointerMatch[1] : '',
      message: line,
      fix: nextLine,
    });
  }
  return items;
}

/**
 * Parses prior attribution / delivery notes (`Notes` JSON `{ cases: { "<autoid>": ... } }` or single-case attribution JSON),
 * strictly matching ONLY `caseIds` and pinning `confidence: "hypothesis"`.
 */
export function parsePriorAttribution(
  raw: unknown,
  caseIds: ReadonlySet<string>,
  round: number,
  sourceFile: string,
): PriorAttributionItem | null {
  if (!isRecord(raw)) return null;

  // Format 1: Notes JSON from delivery (`{ cases: { [autoid]: { judged, remedy, evidence?, defect_candidate?, author_conflict? } } }`)
  if (isRecord(raw.cases)) {
    for (const id of caseIds) {
      const entry = raw.cases[id];
      if (!isRecord(entry)) continue;
      const evidenceQuotes = typeof entry.evidence === 'string' && entry.evidence.trim() ? [entry.evidence.trim()] : [];
      return {
        round,
        sourceFile,
        confidence: 'hypothesis',
        judged: typeof entry.judged === 'string' ? entry.judged.trim() : '',
        remedy: typeof entry.remedy === 'string' ? entry.remedy.trim() : '',
        evidenceQuotes,
        ...(isRecord(entry.defect_candidate)
          ? {
              defectCandidate: {
                repro: String(entry.defect_candidate.repro ?? ''),
                expected: String(entry.defect_candidate.expected ?? ''),
                actual: String(entry.defect_candidate.actual ?? ''),
              },
            }
          : {}),
        ...(isRecord(entry.author_conflict)
          ? {
              authorConflict: {
                author: String(entry.author_conflict.author ?? ''),
                manual: String(entry.author_conflict.manual ?? ''),
                reference: String(entry.author_conflict.reference ?? ''),
              },
            }
          : {}),
      };
    }
    return null;
  }

  // Format 2: Single-case attribution JSON (`compile-attributor` output or array of them)
  const record = raw;
  const itemKey = [record.item, record.item_id, record.autoid, record.case_id]
    .filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
  if (itemKey.length > 0 && caseIds.size > 0 && !itemKey.some((k) => caseIds.has(k.trim()))) {
    return null;
  }
  const judged =
    typeof record.judged === 'string'
      ? record.judged
      : typeof record.conclusion === 'string'
        ? record.conclusion
        : typeof record.summary === 'string'
          ? record.summary
          : '';
  const remedy =
    typeof record.remedy === 'string'
      ? record.remedy
      : typeof record.fix_direction === 'string'
        ? record.fix_direction
        : typeof record.next_step === 'string'
          ? record.next_step
          : '';
  if (!judged && !remedy) return null;

  const evidenceQuotes = Array.isArray(record.evidence_quotes)
    ? record.evidence_quotes.filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
    : typeof record.evidence === 'string' && record.evidence.trim()
      ? [record.evidence.trim()]
      : [];

  return {
    round,
    sourceFile,
    confidence: 'hypothesis',
    judged: judged.trim(),
    remedy: remedy.trim(),
    ...(typeof record.layer === 'string' ? { layer: record.layer } : {}),
    ...(typeof record.disposition === 'string' ? { disposition: record.disposition } : {}),
    ...(typeof record.fix_direction === 'string' ? { fixDirection: record.fix_direction } : {}),
    evidenceQuotes,
  };
}

function errorSignatureCategory(sig: string): string {
  const colon = sig.indexOf(':');
  return colon > 0 ? sig.slice(0, colon) : sig;
}

function signaturesMatchAsSameError(prevSigs: readonly string[], currSigs: readonly string[]): string | null {
  for (const sig of currSigs) {
    if (prevSigs.includes(sig)) return sig;
  }
  // Fallback: match same syntax command root or same execution_refused command root across parameter retries.
  const coarse = (s: string): string => {
    const parts = s.split(':');
    if (parts[0] === 'syntax' || parts[0] === 'exec_refused' || parts[0] === 'gate') {
      return `${parts[0]}:${parts[1] ?? ''}`;
    }
    return s;
  };
  for (const sig of currSigs) {
    const c = coarse(sig);
    if (prevSigs.some((p) => coarse(p) === c)) return c;
  }
  return null;
}

/**
 * Computes round-to-round plan diffs and detects trailing consecutive rounds hitting the same error class.
 * Sets `varyFormRequired` when `>= 2` consecutive prior rounds hit the same error or repeated syntax/exec refusal.
 */
export function analyzeRoundHistory(params: {
  currentRound: number;
  attemptLimit?: number;
  rounds: readonly PriorRoundRecord[];
}): StreakAnalysis {
  const attemptLimit = params.attemptLimit ?? MAX_ROUNDS;
  const remainingAttempts = Math.max(0, attemptLimit - params.currentRound);
  const finalAttempt = params.currentRound >= attemptLimit;

  const ordered = [...params.rounds].sort((a, b) => a.round - b.round);
  const roundChanges: PlanDiffSummary[] = [];
  for (let i = 1; i < ordered.length; i++) {
    const prev = ordered[i - 1];
    const curr = ordered[i];
    if (prev.plan && curr.plan) {
      roundChanges.push(diffPlanSnapshots(prev.plan, curr.plan, prev.round, curr.round));
    }
  }

  let consecutiveSameError = ordered.length > 0 && ordered.at(-1)!.errorSignatures.length > 0 ? 1 : 0;
  let repeatedSignature: string | undefined = ordered.at(-1)?.errorSignatures[0];
  let repeatedCategory: string | undefined = repeatedSignature ? errorSignatureCategory(repeatedSignature) : undefined;

  if (ordered.length >= 2) {
    const latest = ordered[ordered.length - 1];
    for (let i = ordered.length - 2; i >= 0; i--) {
      const matched = signaturesMatchAsSameError(ordered[i].errorSignatures, latest.errorSignatures);
      if (!matched) break;
      consecutiveSameError++;
      repeatedSignature = matched;
      repeatedCategory = errorSignatureCategory(matched);
    }
  }

  const latestSyntaxOrExec =
    (ordered.at(-1)?.deviceEvidence?.syntaxRejected.length ?? 0) > 0
    || (ordered.at(-1)?.deviceEvidence?.executionRefused.length ?? 0) > 0;
  const varyFormRequired =
    consecutiveSameError >= 2
    || (ordered.length >= 2 && latestSyntaxOrExec && ordered.at(-2)?.errorSignatures.some((s) => s.startsWith('syntax:') || s.startsWith('exec_refused:')) === true);

  return {
    currentRound: params.currentRound,
    attemptLimit,
    remainingAttempts,
    finalAttempt,
    consecutiveSameError,
    ...(repeatedCategory ? { repeatedCategory } : {}),
    ...(repeatedSignature ? { repeatedSignature } : {}),
    varyFormRequired,
    roundChanges,
  };
}

/**
 * Renders the deterministic round 2+ prior-round history Markdown block embedded directly into
 * `task-brief.ts` stdout and round-specific `.round-<n>.md` briefs.
 */
export function renderPriorRoundsMarkdown(params: {
  caseRef: string;
  currentRound: number;
  rounds: readonly PriorRoundRecord[];
  streak: StreakAnalysis;
}): string {
  const ordered = [...params.rounds].sort((a, b) => a.round - b.round);
  const latest = ordered.at(-1);
  const out: string[] = [
    '## 上一轮与连续错误历史（同一原始用例，仅本案，程序生成）',
    `- 当前轮次：第 ${params.currentRound} 轮（上限 ${params.streak.attemptLimit} 轮，剩余机会 ${params.streak.remainingAttempts} 次${params.streak.finalAttempt ? '；FINAL attempt：本轮为最后一次机会' : ''}）`,
  ];

  if (params.streak.consecutiveSameError >= 2) {
    out.push(
      `- ⚠️ 连续同类错误提醒：同一原始用例已连续 ${params.streak.consecutiveSameError} 轮命中同类错误（${params.streak.repeatedSignature ?? params.streak.repeatedCategory ?? '未知类别'}）。下方仅原样列出历轮实际改动与报错对照，不替代编写模型/分析模型的独立判断。`,
    );
  }
  if (params.streak.varyFormRequired) {
    out.push('- vary_form_required = true：连续多轮命中同类问题或真机拒收，禁止只改小词重试同一写法，必须核查手册命令形态或前置条件后改换实现路径。');
  }

  // Always show chronological round-by-round history & verbatim plan changes when >= 1 prior round has diffs or errors.
  if (ordered.length > 0) {
    out.push('', '### 历轮变更与失败摘要（仅同一原始用例，按轮次顺序）');
    for (const r of ordered) {
      const errLabel = r.errorSignatures.length ? r.errorSignatures.join('；') : '未记录报错签名';
      out.push(`- 第 ${r.round} 轮（${r.planSource ? `计划 ${r.planSource}` : '未附计划文件'}）：报错标识 ${errLabel}`);
      if (r.round === ordered[0].round && r.plan) {
        const entries = r.plan.isBlocks ? r.plan.blocks.map((b) => b.summary) : r.plan.steps.map((s) => s.summary);
        for (const line of entries.slice(0, 12)) out.push(`  · 初始步骤 ${line}`);
        if (entries.length > 12) out.push(`  · …（共 ${entries.length} 步，仅摘前 12 步）`);
        for (const exp of r.plan.expects.slice(0, 8)) out.push(`  · 初始期望 ${exp.summary}`);
      } else {
        const diff = params.streak.roundChanges.find((d) => d.toRound === r.round);
        if (diff) {
          for (const line of diff.lines) out.push(`  ${line}`);
        } else if (r.plan) {
          out.push(`  · 计划摘要：handling=${r.plan.handling}，共 ${r.plan.isBlocks ? r.plan.blocks.length + ' 块' : r.plan.steps.length + ' 步'}，${r.plan.expects.length} 条期望`);
        }
      }
      if (r.gateRefusals.length > 0) {
        for (const g of r.gateRefusals.slice(0, 5)) {
          out.push(`  · Hub 门禁拒绝 [${g.code}${g.path ? ` @ ${g.path}` : ''}]：${g.message}${g.fix ? `（修复：${g.fix}）` : ''}`);
        }
      }
    }
  }

  // Detailed snapshot of the immediately preceding round's automation plan.
  if (latest?.plan) {
    const plan = latest.plan;
    out.push('', `### 上一轮（第 ${latest.round} 轮）自动化用例全文摘要`);
    out.push(`- handling: ${plan.handling}${plan.text ? `；计划说明：${plan.text}` : ''}；replacements=${plan.replacementsCount}`);
    const list = plan.isBlocks ? plan.blocks.map((b) => b.summary) : plan.steps.map((s) => s.summary);
    out.push(plan.isBlocks ? '- 分块列表（blocks）：' : '- 顺序步骤（steps）：');
    if (list.length === 0) out.push('  （无步骤）');
    for (const line of list) out.push(`  ${line}`);
    out.push('- 断言期望（expects）：');
    if (plan.expects.length === 0) out.push('  （无期望）');
    for (const exp of plan.expects) out.push(`  ${exp.summary}`);
  }

  // Detailed device evidence & verbatim failing step excerpts with 12,000-char truncation check.
  if (latest?.deviceEvidence) {
    const dev = latest.deviceEvidence;
    out.push('', `### 上一轮（第 ${latest.round} 轮）上机验证设备返回与报错步逐字输出`);
    out.push(
      `- index.json 结论：run=${dev.verificationRun}，job=${dev.job}，verdict=${dev.verdict}${dev.runnerVerdict ? `，runner_verdict=${dev.runnerVerdict}` : ''}${dev.logFile ? `，log=${dev.logFile}` : ''}`,
    );
    if (dev.passReview) {
      out.push(`- pass_review 降级依据：${dev.passReview.where} -> ${dev.passReview.line}`);
    }
    if (Object.keys(dev.sessionLengths).length > 0) {
      const summary = Object.entries(dev.sessionLengths)
        .map(([name, chars]) => `${name}: ${chars} 字符`)
        .join('、');
      out.push(`- 已保存设备会话长度（网关上限保留末尾 ${SESSION_RETAINED_CHARS} 字符）：${summary}`);
    }
    if (dev.syntaxRejected.length > 0) {
      out.push('- 语法拒绝（syntax_rejected）：');
      for (const sr of dev.syntaxRejected) {
        out.push(`  · [${sr.session ?? '未知会话'}] ${sr.prompt ?? '(未知提示符)'} ${sr.command}${sr.token ? `（脱字符指向：${sr.token}）` : ''}`);
      }
    }
    if (dev.executionRefused.length > 0) {
      out.push('- 执行拒绝（execution_refused）：');
      for (const er of dev.executionRefused) {
        out.push(`  · [${er.session ?? '未知会话'}] ${er.prompt} ${er.command}${er.echo_cut ? ' [长命令回显被终端重绘截断]' : ''} => ${er.reply.join(' | ')}`);
      }
    }
    if (dev.anomalyLines.length > 0) {
      out.push('- 关键异常行（最多 5 条）：');
      for (const line of dev.anomalyLines) out.push(`  · ${line}`);
    }

    if (dev.stepExcerpts.length > 0) {
      out.push('- 各关键步骤/命令在设备会话中的逐字摘录（找不到的步明确标出不在 12,000 字符截断范围内）：');
      for (const step of dev.stepExcerpts) {
        const header = step.stepIndex !== undefined ? `第 ${step.stepIndex} 步` : step.source;
        if (step.found && step.excerpt) {
          out.push(`  · ${header} \`${step.commandText}\`（来自 ${step.sessionName}）：`);
          out.push('```text');
          out.push(step.excerpt);
          out.push('```');
        } else {
          out.push(`  · ${header} \`${step.commandText}\`：${step.missingNotice ?? MISSING_STEP_TRUNCATION_MSG}`);
        }
      }
    }

    if (dev.logExcerpt) {
      out.push('- log.txt 摘要：', '```text', dev.logExcerpt, '```');
    }
    if (dev.inlineTail) {
      out.push('- 设备会话末尾原话摘录（仅作上下文对照）：', '```text', dev.inlineTail, '```');
    }
    if (dev.withheldNotes.length > 0) {
      out.push('- 权限受限或未保存的返回项：');
      for (const w of dev.withheldNotes) out.push(`  · ${w}`);
    }
  } else if (latest && latest.gateRefusals.length === 0) {
    out.push('', `### 上一轮（第 ${latest.round} 轮）设备返回`);
    out.push('- 未传入上一轮设备返还目录（returns），无法展示设备终端输出。');
  }

  // Gate refusals in latest round.
  if (latest && latest.gateRefusals.length > 0) {
    out.push('', `### 上一轮（第 ${latest.round} 轮）Hub 门禁拒绝`);
    for (const g of latest.gateRefusals) {
      out.push(`- [${g.code}]${g.path ? ` 路径 ${g.path}` : ''}：${g.message}${g.fix ? `；修复要求：${g.fix}` : ''}`);
    }
  }

  // Prior failure attribution (always unconfirmed hypothesis!).
  if (latest?.attribution) {
    const attr = latest.attribution;
    out.push('', `### 上一轮（第 ${latest.round} 轮）失败分析结论与下一步（confidence: "${attr.confidence}"，未确认假设）`);
    out.push(`- 注意：${UNCONFIRMED_HYPOTHESIS_NOTE}`);
    out.push(`- 来源文件：${attr.sourceFile}`);
    if (attr.layer || attr.disposition) {
      out.push(`- 排查层级 / 处置：${[attr.layer, attr.disposition].filter(Boolean).join(' / ')}`);
    }
    if (attr.judged) out.push(`- 上一轮结论（未确认）：${attr.judged}`);
    if (attr.remedy) out.push(`- 上一轮建议下一步：${attr.remedy}`);
    if (attr.evidenceQuotes.length > 0) {
      for (const q of attr.evidenceQuotes) out.push(`- 引用证据原句：${q}`);
    }
    if (attr.defectCandidate) {
      out.push(`- 曾提出的 defect_candidate（待证）：期望=${attr.defectCandidate.expected}；实际=${attr.defectCandidate.actual}`);
    }
    if (attr.authorConflict) {
      out.push(`- 曾提出的 author_conflict（待证）：作者=${attr.authorConflict.author}；手册=${attr.authorConflict.manual}`);
    }
  }

  return out.join('\n');
}
