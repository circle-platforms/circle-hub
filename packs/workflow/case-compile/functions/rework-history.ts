// Deterministic per-case prior-round history, device evidence extraction (with 12,000-char gateway
// truncation disclosure), gate refusal extraction, and consecutive same-error streak analysis.
// Strictly isolates a single original case and never generates model conclusions or similarity matches.
import { recompositionRecordOf } from './late.ts';
import { failureLine, LEADING_PROMPT, type RowAudit } from './delivery.ts';
import { isAcceptance, type Acceptance } from './generated/vocabulary.ts';
import { CallFailure, isRecord, wrapProseLine } from './text.ts';

/** Gateway tail truncation limit in bytes/chars on retained session transcripts (compile-excel-server). */
export const SESSION_RETAINED_CHARS = 12_000;
/**
 * Lower char bound (90%+ of 12,000) recognizing real gateway 12,000-byte truncations whose
 * saved text measures slightly below 12,000 chars after CRLF/control normalization (e.g. ~11,371 chars).
 */
export const SESSION_RETENTION_NEAR_CHARS = 11_000;
/** Inline tail budget per session file inside structured/rendered briefs to protect context budget. */
export const INLINE_TAIL_CHARS = 6_000;
/** Total rendered budget for the prior-round history Markdown block (with deterministic omission order). */
export const MAX_PRIOR_HISTORY_CHARS = 48_000;
/** Total rendered ceiling for complete `renderTaskBrief()` output. */
export const MAX_TASK_BRIEF_CHARS = 80_000;
/** Maximum authoring rounds allowed before closing under delivery rules. */
export const MAX_ROUNDS = 3;
/** Maximum anomaly lines highlighted from logs/returns per round. */
export const MAX_ANOMALY_LINES = 5;

/** Disclosed ONLY when facts support that the session hit the 12,000-char retention cap before this step. */
export const MISSING_STEP_TRUNCATION_MSG = '这一步的设备输出不在保留的末尾 12,000 个字符内';
/** Disclosed when a step is absent from a retained session that did NOT truncate before it. */
export const MISSING_STEP_NOT_FOUND_MSG = '在保留的设备输出里没有找到这一步';
/** Disclosed when a step's command occurrence cannot be uniquely localized in a session transcript. */
export const AMBIGUOUS_STEP_MSG = '这一步的输出无法唯一定位';
/** Mandatory disclosure whenever any step or session evidence could not be retrieved. */
export const MISSING_EVIDENCE_CAVEAT = '取不到证据的步骤不要当作正确，也不要当作无关。';
export const UNCONFIRMED_HYPOTHESIS_NOTE =
  '以下失败分析结论均标记为未确认假设（confidence: "hypothesis"）；编写或核对前须对照上述原始设备输出独立核对后再采纳或推翻。';

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
  planRun?: string;
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
  /** The case's log shows the runner sending this command by itself, outside the plan's steps (runnerOwnLogCommands), or does not show it sent at all (unlogged). */
  runner_own?: true;
  /** The case's log lists the commands the runner sent and this one is none of them: the framework typed it beneath that line. */
  unlogged?: true;
}

export interface ExecutionRefusalItem {
  session?: string;
  command: string;
  prompt: string;
  reply: string[];
  echo_cut?: true;
  /** As in SyntaxRejectionItem. */
  runner_own?: true;
  unlogged?: true;
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
  round: number | null;
  roundRecorded?: boolean;
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
  ambiguous?: boolean;
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
  /** The dispatch held the case but the run never reached it (tools/download-returns.ts `not_executed`): no device observation, no attempt. */
  notExecuted?: { reason: string; next_action: string };
}

export interface HubAnswerNotices {
  /** True only when an explicit contract `acceptance` value or failure envelope was parsed from the Hub answer. */
  acceptanceParsed: boolean;
  /** Contract `Acceptance` value when `acceptanceParsed` is true; null when not parsed. */
  acceptance: Acceptance | null;
  refusals: GateRefusalItem[];
  acceptedNotices: GateRefusalItem[];
}

export interface PriorRoundRecord {
  round: number;
  planSource?: string;
  plan?: PriorPlanSnapshot | null;
  deviceEvidence?: DeviceReturnEvidence | null;
  gateRefusals: GateRefusalItem[];
  acceptedNotices?: GateRefusalItem[];
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

/** Strips ANSI CSI sequences and resolves terminal `\r` overwrites to the last non-empty segment. */
function collapseAnsiCrLine(rawLine: string): string {
  const withoutAnsi = rawLine.replace(ANSI_ESCAPE, '');
  const parts = withoutAnsi.split('\r');
  const tail = parts[parts.length - 1] ?? '';
  if (tail) return tail;
  for (let idx = parts.length - 1; idx >= 0; idx--) {
    if (parts[idx]) return parts[idx];
  }
  return '';
}

/**
 * Decodes terminal horizontal-scroll redraw lines (`BS` x W + `$<vis><spaces>` + `BS` x pad + `<chunk>`),
 * returning the reconstructed `prompt + fullCommand` line when scroll frames are present.
 * Returns `null` when the line does not follow a valid scroll-redraw sequence so callers never guess.
 */
export function decodeHorizontalScrollRedraw(rawLine: string): string | null {
  const lastCr = collapseAnsiCrLine(rawLine);
  if (!lastCr.includes('\x08')) return null;

  const prompted = LEADING_PROMPT.exec(lastCr);
  const tsPrefixed = !prompted
    ? /^(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+Z?)?\s+)/.exec(lastCr)
    : null;
  const prompt = prompted ? prompted[1] : tsPrefixed ? tsPrefixed[1] : '';
  const rest = lastCr.slice(prompt.length);
  const tokens: Array<{ bs: number } | { text: string }> = [];
  let i = 0;
  while (i < rest.length) {
    if (rest[i] === '\x08') {
      let j = i;
      while (j < rest.length && rest[j] === '\x08') j++;
      tokens.push({ bs: j - i });
      i = j;
    } else {
      let j = i;
      while (j < rest.length && rest[j] !== '\x08') j++;
      tokens.push({ text: rest.slice(i, j) });
      i = j;
    }
  }

  if (tokens.length < 3 || !('text' in tokens[0]) || !('bs' in tokens[1])) return null;
  const width = tokens[0].text.length;
  if (width < 20) return null;

  let out = tokens[0].text;
  let scrolled = false;
  let k = 1;

  const isEnterResetFrame = (txt: string): boolean =>
    txt.length >= Math.min(20, width - 2)
    && txt.length <= width
    && txt.endsWith('$')
    && out.startsWith(txt.slice(0, -1));

  while (k < tokens.length) {
    const t = tokens[k];
    if (!('bs' in t)) return null;
    const nxt = tokens[k + 1];
    if (!nxt) {
      // Trailing BS at very end of line
      k++;
      break;
    }
    if (!('text' in nxt)) return null;

    if (scrolled && isEnterResetFrame(nxt.text)) {
      k += 2;
      if (k === tokens.length - 1 && 'bs' in tokens[k]) k++;
      break;
    }

    if (t.bs === width && nxt.text.startsWith('$') && nxt.text.length === width) {
      scrolled = true;
      const after = tokens[k + 2];
      const nextChunk = tokens[k + 3];
      if (
        after
        && 'bs' in after
        && after.bs < width
        && nextChunk
        && 'text' in nextChunk
        && !isEnterResetFrame(nextChunk.text)
      ) {
        const pad = after.bs;
        const vis = nxt.text.slice(1, width - pad);
        if (!vis) return null;
        out += vis.slice(-1);
        out += nextChunk.text;
        k += 4;
        continue;
      }
      const nextIsScrollFrame = Boolean(
        after
        && 'bs' in after
        && after.bs === width
        && nextChunk
        && 'text' in nextChunk
        && nextChunk.text.startsWith('$')
        && !isEnterResetFrame(nextChunk.text),
      );
      const visTrimmed = nextIsScrollFrame ? nxt.text.slice(1) : nxt.text.slice(1).replace(/ +$/, '');
      if (!visTrimmed) return null;
      out += visTrimmed.slice(-1);
      k += 2;
      continue;
    }

    return null;
  }

  if (!scrolled || k !== tokens.length) return null;
  return prompt + out;
}

/**
 * Formats one terminal output line for rendered excerpts: decodes horizontal-scroll redraws first
 * and resolves any remaining `\x08` sequences via cursor overwrite so raw control bytes never leak.
 */
function sanitizeTerminalExcerptLine(rawLine: string): string {
  const decoded = decodeHorizontalScrollRedraw(rawLine);
  if (decoded !== null) return decoded.replace(CTRL_CHARS, '');
  const lastCr = collapseAnsiCrLine(rawLine);
  if (!lastCr.includes('\x08')) return lastCr.replace(CTRL_CHARS, '');
  const chars: string[] = [];
  let col = 0;
  for (const ch of lastCr) {
    if (ch === '\x08') {
      if (col > 0) col -= 1;
    } else {
      chars[col] = ch;
      col += 1;
    }
  }
  return chars.join('').replace(CTRL_CHARS, '').trimEnd();
}

function cleanLineForMatch(line: string): string {
  const withoutAnsi = line.replace(ANSI_ESCAPE, '');
  const parts = withoutAnsi.split('\r');
  let collapsed = parts[parts.length - 1] ?? '';
  if (!collapsed) {
    for (let idx = parts.length - 1; idx >= 0; idx--) {
      if (parts[idx]) {
        collapsed = parts[idx];
        break;
      }
    }
  }
  return collapsed.replace(CTRL_CHARS, '').trim();
}

function normalizeErrorToken(value: string): string {
  return value
    .replace(/\r/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\b/g, '<ts>')
    .replace(/\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}(?:\s+[A-Z]{2,5})?\s+\d{4}\b/g, '<ts>')
    .replace(/\brun_[0-9a-z]{26}\b/g, '<run>')
    .replace(/\bjob_[0-9a-z]+\b/g, '<job>')
    .replace(/\bid:\s*\d+\b/gi, 'id: <id>')
    .replace(/\bFail Num\s+\d+\s*:/gi, 'Fail Num <n>:')
    .replace(/\b[0-9a-f]{12,64}\b/gi, '<hex>')
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
      // The recomposition record of the item, the late overlay's when the item carries one (functions/late.ts).
      const record = recompositionRecordOf(item);
      if (record && isRecord(record.case) && typeof record.case.id === 'string' && record.case.id.trim()) {
        ids.add(record.case.id.trim());
      }
    }
  }
  return ids;
}

function resolvePlanDataObject(
  raw: unknown,
  sourceLabel = '上一轮计划',
): {
  item: string;
  planRun?: string;
  handling: string;
  text: string;
  data: Record<string, unknown>;
} {
  if (!isRecord(raw)) {
    throw new CallFailure("invalid_parameters", `${sourceLabel} 不是合法的单条用例计划 JSON 对象（期望 { item, handling, slots: { plan: [{ data: { steps|blocks } }] } } 或单条 data 对象）`, "提供单条计划对象，写成 {item,handling,slots:{plan:[{data:{steps或blocks}}]}} 或单条 data 对象");
  }
  if (Array.isArray(raw.items)) {
    throw new CallFailure("invalid_parameters", `${sourceLabel} 是整批 submission.json（含 items 数组），--prior-plans 需要单条用例的计划 JSON（如 plans/01.json）或 plans/ 目录，请勿直接传入整批 submission.json`, "把 --prior-plans 指向 plans/<序号>.json 或 plans/ 目录，不传包含 items 数组的整批提交");
  }
  const planRun =
    typeof raw.plan_run === 'string' && raw.plan_run.trim()
      ? raw.plan_run.trim()
      : typeof raw.run === 'string' && /^run_[0-9a-z]{26}$/.test(raw.run.trim())
        ? raw.run.trim()
        : undefined;
  const handling = typeof raw.handling === 'string' ? raw.handling : 'handled';
  const item = typeof raw.item === 'string' ? raw.item : '';

  if (isRecord(raw.slots) && Array.isArray(raw.slots.plan) && raw.slots.plan.length > 0 && isRecord(raw.slots.plan[0])) {
    const stmt = raw.slots.plan[0];
    if (!isRecord(stmt.data) || (!Array.isArray(stmt.data.steps) && !Array.isArray(stmt.data.blocks) && handling !== 'skipped')) {
      throw new CallFailure("invalid_parameters", `${sourceLabel} 的 slots.plan[0].data 缺少 steps 或 blocks 数组`, "为这条计划补齐 slots.plan[0].data.steps 或 blocks 数组，再读取上一轮计划");
    }
    return {
      item,
      ...(planRun ? { planRun } : {}),
      handling,
      text: typeof stmt.text === 'string' ? stmt.text : '',
      data: isRecord(stmt.data) ? stmt.data : {},
    };
  }
  if (isRecord(raw.slots) && handling === 'skipped') {
    return {
      item,
      ...(planRun ? { planRun } : {}),
      handling,
      text: '',
      data: {},
    };
  }
  if (isRecord(raw.data) && (Array.isArray(raw.data.steps) || Array.isArray(raw.data.blocks))) {
    return {
      item,
      ...(planRun ? { planRun } : {}),
      handling,
      text: typeof raw.text === 'string' ? raw.text : '',
      data: raw.data,
    };
  }
  if (Array.isArray(raw.steps) || Array.isArray(raw.blocks)) {
    return {
      item,
      ...(planRun ? { planRun } : {}),
      handling,
      text: typeof raw.text === 'string' ? raw.text : '',
      data: raw,
    };
  }
  throw new CallFailure("invalid_parameters", `${sourceLabel} 不是合法的单条用例计划 JSON（期望含 slots.plan[0].data.steps/blocks 的 plans/<序号>.json 或计划目录）`, "提供含 slots.plan[0].data.steps 或 blocks 的单条计划文件，或指向该计划所在目录");
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
  // A typed block keeps its command under call.args (CONFIG, CAPTURE, OBSERVE_ASSERT …).
  const call = isRecord(block.call) ? block.call : null;
  if (call && Array.isArray(call.args) && typeof call.args[0] === 'string' && call.args[0].trim()) {
    return call.args[0].trim();
  }
  return '';
}

/** Parses one prior-round plan JSON into a normalized snapshot, refusing plans that belong to another case. */
export function parsePriorPlanSnapshot(
  raw: unknown,
  caseIds: ReadonlySet<string>,
  sourceLabel = '上一轮计划',
): PriorPlanSnapshot {
  const { item, planRun, handling, text, data } = resolvePlanDataObject(raw, sourceLabel);
  if (item && caseIds.size > 0 && !caseIds.has(item)) {
    throw new CallFailure("invalid_parameters", `${sourceLabel} 属于原始用例 ${item}，与当前任务目标（${[...caseIds][0]}）不一致。禁止混入其他用例计划`, "选择当前用例 item 对应的单条计划文件，不混入其他用例的历史");
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
    ...(planRun ? { planRun } : {}),
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

type MatchKind = 'exact' | 'redraw' | 'ambiguous';

interface SessionLineCandidate {
  lineIndex: number;
  kind: MatchKind;
}

const normWs = (text: string): string => text.replace(/\s+/g, ' ').trim();
const unquoteSimpleTokens = (text: string): string => normWs(text).replace(/"([^"\s]+)"/g, '$1');
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function inspectSessionLine(rawLine: string): {
  rawNoAnsi: string;
  cleaned: string;
  body: string;
  promptMatched: boolean;
  isRedraw: boolean;
  redrawHead: string;
  redrawTail: string;
  collapsedAll: string;
} {
  const rawNoAnsi = rawLine.replace(ANSI_ESCAPE, '');
  const decodedScroll = decodeHorizontalScrollRedraw(rawLine);
  if (decodedScroll !== null) {
    const cleaned = decodedScroll.replace(CTRL_CHARS, '').trim();
    const prompted = LEADING_PROMPT.exec(cleaned);
    const body = prompted ? cleaned.slice(prompted[1].length).trim() : cleaned;
    return {
      rawNoAnsi,
      cleaned,
      body,
      promptMatched: prompted !== null,
      isRedraw: true,
      redrawHead: '',
      redrawTail: '',
      collapsedAll: normWs(cleaned),
    };
  }

  const crParts = rawNoAnsi.split('\r');
  let lastCr = crParts[crParts.length - 1] ?? '';
  if (!lastCr) {
    for (let idx = crParts.length - 1; idx >= 0; idx--) {
      if (crParts[idx]) {
        lastCr = crParts[idx];
        break;
      }
    }
  }
  const cleaned = lastCr.replace(CTRL_CHARS, '').trim();
  const prompted = LEADING_PROMPT.exec(cleaned);
  const body = prompted ? cleaned.slice(prompted[1].length).trim() : cleaned;

  const afterPromptRaw = prompted ? lastCr.slice(prompted[1].length) : lastCr;
  const spacedDollar = afterPromptRaw.search(/\s{2,}\$/);
  const tightDollar = afterPromptRaw.indexOf('$');
  const dollarPosInAfterPrompt = spacedDollar >= 0 ? spacedDollar : tightDollar >= 8 ? tightDollar : -1;
  const hasInlineCtrl = CTRL_CHARS.test(lastCr.replace(/\r/g, ''));
  const isRedraw =
    dollarPosInAfterPrompt >= 0
    || (crParts.length > 2 && lastCr.trim().length > 0)
    || hasInlineCtrl;
  let redrawHead = '';
  let redrawTail = '';
  if (dollarPosInAfterPrompt >= 0) {
    redrawHead = normWs(afterPromptRaw.slice(0, dollarPosInAfterPrompt).replace(CTRL_CHARS, ''));
    redrawTail = normWs(afterPromptRaw.slice(dollarPosInAfterPrompt + 1).replace(CTRL_CHARS, ''));
  } else if (prompted && hasInlineCtrl) {
    const ctrlPos = lastCr.slice(prompted[1].length).search(CTRL_CHARS);
    if (ctrlPos >= 0) {
      redrawHead = normWs(lastCr.slice(prompted[1].length, prompted[1].length + ctrlPos));
    }
  }
  const collapsedAll = normWs(lastCr.replace(/\s*\$/g, ' ').replace(CTRL_CHARS, ' '));
  return {
    rawNoAnsi,
    cleaned,
    body,
    promptMatched: prompted !== null,
    isRedraw,
    redrawHead,
    redrawTail,
    collapsedAll,
  };
}

function longestCommonPrefix(strings: readonly string[]): string {
  if (strings.length === 0) return '';
  let prefix = strings[0];
  for (let i = 1; i < strings.length; i++) {
    const s = strings[i];
    let j = 0;
    while (j < prefix.length && j < s.length && prefix[j] === s[j]) j++;
    prefix = prefix.slice(0, j);
    if (!prefix) break;
  }
  return prefix;
}

function findCommandCandidatesInSession(
  rawLines: readonly string[],
  command: string,
  competingCommands: readonly string[] = [],
): SessionLineCandidate[] {
  const cmdNorm = normWs(command);
  if (!cmdNorm) return [];
  const cmdUnq = unquoteSimpleTokens(cmdNorm);
  const peers = [...new Set(competingCommands.map(normWs).filter(Boolean))];
  if (!peers.includes(cmdNorm)) peers.push(cmdNorm);

  const candidates: SessionLineCandidate[] = [];
  for (let i = 0; i < rawLines.length; i++) {
    const info = inspectSessionLine(rawLines[i]);
    if (!info.cleaned || !info.body) continue;

    const bodyNorm = normWs(info.body);
    const cleanedNorm = normWs(info.cleaned);
    if (
      bodyNorm === cmdNorm
      || cleanedNorm === cmdNorm
      || unquoteSimpleTokens(info.body) === cmdUnq
      || unquoteSimpleTokens(info.cleaned) === cmdUnq
    ) {
      candidates.push({ lineIndex: i, kind: 'exact' });
      continue;
    }

    // Only permit redraw prefix matching when the terminal genuinely wrapped/truncated long echoes
    // (never match arbitrary prefixes across distinct complete commands like `-t A` vs `-t CNAME`).
    const redrawTailMatches = (): boolean => {
      if (!info.redrawTail) return true;
      const tailWords = info.redrawTail.split(/\s+/).filter((w) => w.length >= 2);
      if (tailWords.length === 0) return true;
      // Require the trailing suffix word(s) after `$` (ignoring a cut first fragment like `k`) to belong to cmdNorm.
      const significant = tailWords.length > 1 ? tailWords.slice(1) : tailWords;
      return significant.every((w) => cmdNorm.includes(w));
    };
    if (
      info.isRedraw
      && info.promptMatched
      && info.redrawHead.length >= 16
      && cmdNorm.startsWith(info.redrawHead)
      && redrawTailMatches()
    ) {
      const prefixPeers = peers.filter((p) => p.startsWith(info.redrawHead));
      if (prefixPeers.length <= 1) {
        candidates.push({ lineIndex: i, kind: 'redraw' });
        continue;
      }
      const lcp = longestCommonPrefix(prefixPeers);
      const tokenOf = (p: string) => p.slice(lcp.length).trim().split(/\s+/)[0] ?? '';
      const selfToken = tokenOf(cmdNorm);
      const otherTokens = prefixPeers.filter((p) => p !== cmdNorm).map(tokenOf).filter(Boolean);
      const hasToken = (tok: string) =>
        tok.length >= 2 && new RegExp(`(?:^|[\\s"'])${escapeRegExp(tok)}(?:$|[\\s"'])`).test(info.collapsedAll);
      const matchesSelf = Boolean(selfToken && hasToken(selfToken));
      const matchesOther = otherTokens.some((tok) => hasToken(tok));
      candidates.push({
        lineIndex: i,
        kind: matchesSelf && !matchesOther ? 'redraw' : 'ambiguous',
      });
    }
  }
  return candidates;
}

function extractExcerptAt(rawLines: readonly string[], matchIndex: number): string {
  const start = Math.max(0, matchIndex - 1);
  let end = matchIndex + 1;
  while (end < rawLines.length && end < matchIndex + 18) {
    const cleaned = cleanLineForMatch(rawLines[end]);
    const prompted = LEADING_PROMPT.exec(cleaned);
    if (prompted && end > matchIndex) {
      // Include a trailing bare return-to-prompt line, but stop before a non-empty next command.
      if (!cleaned.slice(prompted[1].length).trim()) end++;
      break;
    }
    end++;
  }
  const sliceText = rawLines
    .slice(start, end)
    .map(sanitizeTerminalExcerptLine)
    .join('\n')
    .trimEnd();
  return sliceText.length > 1600
    ? sliceText.slice(0, 1600) + '\n…（此步后续输出已按长度上限省略，完整原文见对应会话文件）'
    : sliceText;
}

/**
 * Searches for a CLI command inside a retained device session transcript (`text`)
 * and returns a verbatim window (`<= ~1600` chars) at the requested occurrence index,
 * without fuzzy 24-char prefix matching across different commands.
 */
export function findCommandInSession(
  sessionText: string,
  command: string,
  options?: { occurrence?: number; minLine?: number; competingCommands?: readonly string[] },
): { found: boolean; ambiguous?: boolean; lineIndex?: number; excerpt?: string } {
  const cmdTrim = cleanLineForMatch(command);
  if (!cmdTrim) return { found: false };
  const rawLines = sessionText.replace(/\r\n/g, '\n').split('\n');
  const minLine = options?.minLine ?? 0;
  const occurrence = options?.occurrence ?? 0;
  const candidates = findCommandCandidatesInSession(rawLines, cmdTrim, options?.competingCommands)
    .filter((c) => c.lineIndex >= minLine);
  if (candidates.length === 0 || occurrence >= candidates.length) return { found: false };
  const chosen = candidates[occurrence];
  if (chosen.kind === 'ambiguous') {
    return { found: false, ambiguous: true, lineIndex: chosen.lineIndex };
  }
  return {
    found: true,
    lineIndex: chosen.lineIndex,
    excerpt: extractExcerptAt(rawLines, chosen.lineIndex),
  };
}

const STRUCTURED_LOG_MARKER =
  /(?:^#{4,}\s+|^step\s+\d+\s+(?:dispatched|failed|timed out)\b|executes command:|end case:|\bdispatched\s+)/i;

function isExecutorFailureLogLine(line: string): boolean {
  const stripped = line.replace(/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\s+/, '').trim();
  return (
    /^#{4}\s+Fail Num\s+\d+\s*:/i.test(stripped)
    || /^#{4,}\s+The failed check point num:/i.test(stripped)
    || /^step\s+\d+\s+(?:failed|timed out)\b/i.test(stripped)
  );
}

function extractExecutedLogCommands(logText: string): string[] {
  const cmds: string[] = [];
  for (const raw of logText.replace(/\r/g, '').split('\n')) {
    const stripped = raw.replace(/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\s+/, '').trim();
    if (!stripped) continue;
    const execMatch = /executes command:\s*(.+)$/i.exec(stripped);
    if (execMatch?.[1]?.trim()) {
      cmds.push(execMatch[1].trim());
      continue;
    }
    const dispMatch = /^(?:step\s+\d+\s+dispatched|dispatched)\s+(.+)$/i.exec(stripped);
    if (dispMatch?.[1]?.trim()) {
      cmds.push(dispMatch[1].trim());
    }
  }
  return cmds;
}

/**
 * The commands a case's log shows the runner sending by itself: before the first step is announced (its own preparation) and
 * after the last announced step has sent its command (its own cleanup of the devices). The device's sessions hold them and a
 * device can refuse them, and they are in no plan, so a refused one says nothing about which plan ran. A command that a step
 * also sent as its own is not taken for the runner's. Nothing when the log announces no step.
 */
export function runnerOwnLogCommands(logText: string): Set<string> {
  const sent = (line: string): string | undefined => (/sends command in [^:]*:\s*(.+)$/.exec(line) ?? /executes command:\s*(.+)$/i.exec(line))?.[1]?.trim();
  const lines = logText.replace(/\r/g, '').split('\n');
  const marks = lines.flatMap((line, at) => (/#######\s+step\d+\s*:/.test(line) ? [at] : []));
  const own = new Set<string>();
  if (!marks.length) return own;
  const ofSteps = new Set<string>();
  marks.forEach((mark, n) => {
    const end = marks[n + 1] ?? lines.length;
    for (let at = mark + 1; at < end; at++) { const command = sent(lines[at]!); if (command) { ofSteps.add(normWs(command)); break; } }
  });
  for (let at = 0; at < marks[0]!; at++) { const command = sent(lines[at]!); if (command) own.add(normWs(command)); }
  let stepsOwn = true;
  for (let at = marks.at(-1)! + 1; at < lines.length; at++) {
    if (/#######\s+end case\b/.test(lines[at]!)) break;
    const command = sent(lines[at]!);
    if (!command) continue;
    if (stepsOwn) { stepsOwn = false; continue; }
    own.add(normWs(command));
  }
  for (const command of ofSteps) own.delete(command);
  return own;
}

/**
 * Every command the case's log shows the runner sending, for a step or by itself. The framework writes one such line for each
 * command of its two senders; what it types beneath them — entering and leaving configuration mode, the login — is in a
 * device's session only. A device can refuse that too ("conf ter" while another session holds configuration mode); it is in no
 * plan and under no step of the log, so it says nothing about which plan ran.
 */
export function runnerLoggedCommands(logText: string): string[] {
  const out: string[] = [];
  for (const line of logText.replace(/\r/g, '').split('\n')) {
    const command = (/sends command in [^:]*:\s*(.+)$/.exec(line) ?? /executes command:\s*(.+)$/i.exec(line))?.[1]?.trim();
    if (command) out.push(normWs(command));
  }
  return out;
}

function collectCandidateLogLines(logText: string): string[] {
  const lines = logText
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => sanitizeTerminalExcerptLine(line).trim())
    .filter(Boolean);
  if (lines.length <= 24) return lines;
  const hitIndices = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    const stripped = lines[i].replace(/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\s+/, '').trim();
    if (STRUCTURED_LOG_MARKER.test(stripped) || isExecutorFailureLogLine(lines[i])) {
      for (let k = Math.max(0, i - 1); k <= Math.min(lines.length - 1, i + 1); k++) hitIndices.add(k);
    }
  }
  if (hitIndices.size > 0) {
    return [...hitIndices].sort((a, b) => a - b).slice(0, 24).map((i) => lines[i]);
  }
  return [...lines.slice(0, 8), '…（中间日志略）', ...lines.slice(-12)];
}

function inferSessionCandidates(
  stepObject: string,
  stepMethod: string,
  preferredSession: string | undefined,
  sessionNames: readonly string[],
): string[] {
  if (preferredSession && sessionNames.includes(preferredSession)) return [preferredSession];
  const stemTokens = [stepMethod, stepObject]
    .map((s) => s.toLowerCase().replace(/[^a-z0-9]/g, ''))
    .filter((t) => t.length >= 2);
  const direct = sessionNames.filter((name) => {
    const fileStem = name.replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9]/g, '');
    return stemTokens.some((tok) => {
      const base = tok.replace(/\d+$/, '');
      return (
        fileStem === tok
        || fileStem.startsWith(tok)
        || (base.length >= 3 && fileStem.startsWith(base))
      );
    });
  });
  return direct.length > 0 ? direct : [...sessionNames];
}

export function commandMatchesPlanSet(
  cmd: string,
  planNorms: readonly string[],
  planUnqs: readonly string[],
  allowPrefixCut: boolean,
): boolean {
  const n = normWs(cmd);
  if (!n) return true;
  const u = unquoteSimpleTokens(n);
  if (planNorms.includes(n) || planUnqs.includes(u)) return true;
  // A plan command with the back-fill placeholder {} reached the device with a captured value in its place.
  const filled = planNorms.filter((pc) => pc.includes('{}'));
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (filled.some((pc) => new RegExp(`^${pc.split('{}').map(escape).join('.+')}$`).test(n))) return true;
  if (allowPrefixCut && n.length >= 16) {
    if (planNorms.some((pc) => pc.startsWith(n))) return true;
    // A cut echo of a filled command: the text before the first placeholder agrees as far as the echo goes.
    return filled.some((pc) => { const head = pc.split('{}')[0]!; return n.length <= head.length ? head.startsWith(n) : n.startsWith(head); });
  }
  return false;
}

/** Said beside a refused command the runner sent by itself: the plan has no step to change for it. */
const RUNNER_OWN_NOTE = '（日志显示这条是执行器在步骤之外自己发的，不在本计划的步骤里）';
/** Said beside a refused command the log does not show the runner sending at all. */
const RUNNER_UNLOGGED_NOTE = '（运行日志里没有发这条命令的记录：是执行器自己发的，例如进出配置模式，不在本计划的步骤里）';
const runnerNote = (item: { runner_own?: true; unlogged?: true }): string => (item.unlogged ? RUNNER_UNLOGGED_NOTE : item.runner_own ? RUNNER_OWN_NOTE : '');
const BOILERPLATE_PROMPT_CMD = /^(?:conf\s+ter|configure\s+terminal|exit|end|clear\s+slb\s+all)$/i;

/**
 * Extracts deterministic single-case device evidence from `returns/index.json`, saved session texts,
 * and `log.txt`, aligning step outputs by sequential occurrence order in the session, validating
 * plan-vs-returns consistency, and disclosing factually when 12,000-char gateway retention clipped early steps.
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

  // What the runner sent by itself, outside the plan's steps: a refusal of it is shown as that, and is not held against the plan.
  const runnerOwn = runnerOwnLogCommands(params.logText ?? '');
  const logged = runnerLoggedCommands(params.logText ?? ''), loggedUnquoted = logged.map(unquoteSimpleTokens);
  const unlogged = (command: string): boolean => logged.length > 0 && !commandMatchesPlanSet(command, logged, loggedUnquoted, true);
  const ownMark = (command: string): { runner_own?: true; unlogged?: true } => (runnerOwn.has(normWs(command)) ? { runner_own: true } : unlogged(command) ? { runner_own: true, unlogged: true } : {});
  const syntaxRejected: SyntaxRejectionItem[] = Array.isArray(matchedRow.syntax_rejected)
    ? matchedRow.syntax_rejected
        .filter(isRecord)
        .filter((s) => typeof s.command === 'string' && s.command.trim())
        .map((s) => ({
          ...(typeof s.session === 'string' ? { session: s.session } : {}),
          command: String(s.command).trim(),
          ...(typeof s.token === 'string' ? { token: s.token } : {}),
          ...(typeof s.prompt === 'string' ? { prompt: s.prompt } : {}),
          ...ownMark(String(s.command).trim()),
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
          ...ownMark(String(e.command).trim()),
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
  const sessionRawLines = new Map<string, string[]>();
  for (const [name, entry] of params.sessionTexts.entries()) {
    sessionLengths[name] = entry.text.length;
    sessionRawLines.set(name, entry.text.replace(/\r\n/g, '\n').split('\n'));
  }
  const hasSavedSessions = params.sessionTexts.size > 0;
  const sessionNames = [...params.sessionTexts.keys()];
  const logText = params.logText ?? '';

  // D2 mismatch guard: fail closed if the supplied plan and returns clearly belong to different runs.
  if (params.priorPlan && (params.priorPlan.steps.length > 0 || params.priorPlan.blocks.length > 0)) {
    const jobPlanRun = typeof matchedJob.plan_run === 'string' ? matchedJob.plan_run.trim() : '';
    if (params.priorPlan.planRun && jobPlanRun && params.priorPlan.planRun !== jobPlanRun) {
      throw new CallFailure("invalid_parameters", `传入的上一轮计划与设备返还不属于同一次运行（plan_run 不一致：${params.priorPlan.planRun} != ${jobPlanRun}），拒绝生成失配简报`, "成对选择同一 plan_run 的上一轮计划和设备返还后重新生成简报");
    }
    // The same run on both sides is the pair itself. What follows guesses the pair from the commands, for a plan that does not
    // say its run; twice it refused a right pair over a command the runner had sent by itself.
    const sameRun = Boolean(params.priorPlan.planRun && jobPlanRun && params.priorPlan.planRun === jobPlanRun);
    if (!sameRun) {
    const planCmdsNorm = [
      ...params.priorPlan.steps.map((s) => normWs(s.commandText)),
      ...params.priorPlan.blocks.map((b) => normWs(b.commandText ?? '')),
    ].filter(Boolean);
    const planCmdsUnq = planCmdsNorm.map(unquoteSimpleTokens);

    // A refused command the runner sent by itself is in no plan whichever plan ran (a compile stopped a case for good because
    // the peer device refused the runner's own cleanup after the last step): it is no sign of a wrong pair.
    for (const sr of syntaxRejected) {
      if (sr.runner_own) continue;
      if (!commandMatchesPlanSet(sr.command, planCmdsNorm, planCmdsUnq, true)) {
        throw new CallFailure("invalid_parameters", `传入的上一轮计划（--prior-plans）与设备返还（--prior-returns）不属于同一次运行（syntax_rejected 命令“${sr.command}”不在该计划步骤中），拒绝生成简报`, "按 syntax_rejected 所属运行重新选择 --prior-plans 和 --prior-returns，保留原始命令和计划");
      }
    }
    for (const er of executionRefused) {
      if (er.runner_own) continue;
      if (!commandMatchesPlanSet(er.command, planCmdsNorm, planCmdsUnq, er.echo_cut === true)) {
        throw new CallFailure("invalid_parameters", `传入的上一轮计划（--prior-plans）与设备返还（--prior-returns）不属于同一次运行（execution_refused 命令“${er.command}”不在该计划步骤中），拒绝生成简报`, "按 execution_refused 所属运行重新选择 --prior-plans 和 --prior-returns，保留原始命令和计划");
      }
    }
    for (const lc of extractExecutedLogCommands(logText)) {
      if (!commandMatchesPlanSet(lc, planCmdsNorm, planCmdsUnq, false)) {
        throw new CallFailure("invalid_parameters", `传入的上一轮计划（--prior-plans）与设备返还（--prior-returns）不属于同一次运行（log.txt 执行命令“${lc}”不在该计划步骤中），拒绝生成简报`, "核对 log.txt 所属运行，成对提供该次执行的原始计划与设备返还");
      }
    }
    if (planCmdsNorm.length > 0 && hasSavedSessions) {
      const anyTruncated = [...params.sessionTexts.values()].some((e) => e.text.length >= SESSION_RETENTION_NEAR_CHARS);
      if (!anyTruncated) {
        let matchedAnyPlanCmd = false;
        for (const cmd of planCmdsNorm) {
          for (const rawLines of sessionRawLines.values()) {
            if (findCommandCandidatesInSession(rawLines, cmd, planCmdsNorm).length > 0) {
              matchedAnyPlanCmd = true;
              break;
            }
          }
          if (matchedAnyPlanCmd) break;
        }
        if (!matchedAnyPlanCmd) {
          const otherPromptedCmds: string[] = [];
          for (const rawLines of sessionRawLines.values()) {
            for (const rawLine of rawLines) {
              const info = inspectSessionLine(rawLine);
              if (info.promptMatched && info.body.length >= 3 && !BOILERPLATE_PROMPT_CMD.test(info.body)) {
                otherPromptedCmds.push(info.body);
              }
            }
          }
          if (otherPromptedCmds.length > 0) {
            throw new CallFailure("invalid_parameters", `传入的上一轮计划（--prior-plans）与设备返还（--prior-returns）不属于同一次运行（未截断设备会话未命中任何计划命令，却执行了“${otherPromptedCmds[0]}”等其他命令），拒绝生成简报`, "核对设备会话所属运行，提供与上一轮计划对应的未截断返还，不改写原始命令");
          }
        }
      }
    }
    }
  }

  interface LocateTarget {
    slotIdx: number;
    stepIndex?: number;
    objectName: string;
    methodName: string;
    stepSummary: string;
    commandText: string;
    source: StepDeviceExcerpt['source'];
    preferredSession?: string;
    important: boolean;
  }

  const locateTargets: LocateTarget[] = [];
  const usedRefusalIndices = new Set<string>();
  const matchRefusalSource = (
    cmdText: string,
  ): { source: 'syntax_rejected' | 'execution_refused'; session?: string } | null => {
    const n = normWs(cmdText);
    const u = unquoteSimpleTokens(n);
    for (let i = 0; i < syntaxRejected.length; i++) {
      const key = `sr:${i}`;
      if (usedRefusalIndices.has(key)) continue;
      const srN = normWs(syntaxRejected[i].command);
      if (srN === n || unquoteSimpleTokens(srN) === u || (srN.length >= 16 && n.startsWith(srN))) {
        usedRefusalIndices.add(key);
        return { source: 'syntax_rejected', session: syntaxRejected[i].session };
      }
    }
    for (let i = 0; i < executionRefused.length; i++) {
      const key = `er:${i}`;
      if (usedRefusalIndices.has(key)) continue;
      const erN = normWs(executionRefused[i].command);
      if (
        erN === n
        || unquoteSimpleTokens(erN) === u
        || (executionRefused[i].echo_cut === true && erN.length >= 16 && n.startsWith(erN))
      ) {
        usedRefusalIndices.add(key);
        return { source: 'execution_refused', session: executionRefused[i].session };
      }
    }
    return null;
  };

  if (params.priorPlan) {
    if (!params.priorPlan.isBlocks) {
      for (const step of params.priorPlan.steps) {
        if (!step.commandText) continue;
        const refMatch = matchRefusalSource(step.commandText);
        locateTargets.push({
          slotIdx: locateTargets.length,
          stepIndex: step.index,
          objectName: step.object,
          methodName: step.method,
          stepSummary: step.summary,
          commandText: step.commandText,
          source: refMatch ? refMatch.source : 'plan_step',
          preferredSession: refMatch?.session,
          important: Boolean(refMatch) || !step.cleanup,
        });
      }
    } else {
      for (const block of params.priorPlan.blocks) {
        if (!block.commandText) continue;
        const refMatch = matchRefusalSource(block.commandText);
        locateTargets.push({
          slotIdx: locateTargets.length,
          objectName: block.object ?? '',
          methodName: block.method ?? '',
          stepSummary: block.summary,
          commandText: block.commandText,
          source: refMatch ? refMatch.source : 'plan_step',
          preferredSession: refMatch?.session,
          important: Boolean(refMatch) || !block.isCleanup,
        });
      }
    }
  }
  for (let i = 0; i < syntaxRejected.length; i++) {
    if (usedRefusalIndices.has(`sr:${i}`)) continue;
    const sr = syntaxRejected[i];
    locateTargets.push({
      slotIdx: locateTargets.length,
      objectName: '',
      methodName: '',
      stepSummary: `syntax_rejected (${sr.prompt ?? 'unknown prompt'})`,
      commandText: sr.command,
      source: 'syntax_rejected',
      preferredSession: sr.session,
      important: true,
    });
  }
  for (let i = 0; i < executionRefused.length; i++) {
    if (usedRefusalIndices.has(`er:${i}`)) continue;
    const er = executionRefused[i];
    locateTargets.push({
      slotIdx: locateTargets.length,
      objectName: '',
      methodName: '',
      stepSummary: `execution_refused (${er.prompt})`,
      commandText: er.command,
      source: 'execution_refused',
      preferredSession: er.session,
      important: true,
    });
  }

  const allCompetingCommands = locateTargets.map((t) => t.commandText);
  const resolvedExcerpts: Array<StepDeviceExcerpt | null> = new Array(locateTargets.length).fill(null);

  if (!hasSavedSessions) {
    for (const t of locateTargets) {
      if (t.source !== 'plan_step' || t.important) {
        resolvedExcerpts[t.slotIdx] = {
          ...(t.stepIndex !== undefined ? { stepIndex: t.stepIndex } : {}),
          stepSummary: t.stepSummary,
          commandText: t.commandText,
          source: t.source,
          found: false,
          missingNotice: '本次返还目录中未保存该用例的设备会话文本，无法逐行核对这一步的终端输出',
        };
      }
    }
  } else {
    // Precompute candidates per session x target, then assign each step cleanly to its session.
    const candidatesPerTargetSession = locateTargets.map((t) => {
      const m = new Map<string, SessionLineCandidate[]>();
      for (const sName of sessionNames) {
        const rawLines = sessionRawLines.get(sName)!;
        m.set(sName, findCommandCandidatesInSession(rawLines, t.commandText, allCompetingCommands));
      }
      return m;
    });

    // Learn dominant session for each (objectName, methodName) from affinity matches & candidate hits.
    const learnedObjectSession = new Map<string, string>();
    const byObjKey = new Map<string, Map<string, number>>();
    for (const t of locateTargets) {
      if (!t.objectName && !t.methodName) continue;
      const key = `${t.objectName}::${t.methodName}`;
      const counts = byObjKey.get(key) ?? new Map<string, number>();
      const affinity = inferSessionCandidates(t.objectName, t.methodName, t.preferredSession, sessionNames);
      for (const sName of affinity) {
        if ((candidatesPerTargetSession[t.slotIdx].get(sName)?.length ?? 0) > 0) {
          counts.set(sName, (counts.get(sName) ?? 0) + 1);
        }
      }
      byObjKey.set(key, counts);
    }
    for (const [objKey, counts] of byObjKey.entries()) {
      const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
      if (ranked.length === 1 || (ranked.length > 1 && ranked[0][1] > ranked[1][1])) {
        learnedObjectSession.set(objKey, ranked[0][0]);
      }
    }

    const targetsBySession = new Map<string, LocateTarget[]>();
    const ambiguousAcrossSessions = new Set<number>();

    for (const t of locateTargets) {
      const cMap = candidatesPerTargetSession[t.slotIdx];
      let chosenSession: string | undefined;
      if (t.preferredSession && sessionNames.includes(t.preferredSession)) {
        chosenSession = t.preferredSession;
      } else {
        const objKey = t.objectName || t.methodName ? `${t.objectName}::${t.methodName}` : '';
        const learned = objKey ? learnedObjectSession.get(objKey) : undefined;
        const sessionsWithHits = sessionNames.filter((s) => (cMap.get(s)?.length ?? 0) > 0);
        const affinity = inferSessionCandidates(t.objectName, t.methodName, undefined, sessionNames);
        const affinityWithHits = affinity.filter((s) => (cMap.get(s)?.length ?? 0) > 0);
        if (affinityWithHits.length === 1) {
          chosenSession = affinityWithHits[0];
        } else if (learned && affinity.includes(learned)) {
          chosenSession = learned;
        } else if (sessionsWithHits.length > 1) {
          ambiguousAcrossSessions.add(t.slotIdx);
        } else if (sessionsWithHits.length === 1) {
          chosenSession = sessionsWithHits[0];
        } else {
          chosenSession = learned ?? affinity[0] ?? sessionNames[0];
        }
      }

      if (ambiguousAcrossSessions.has(t.slotIdx) || !chosenSession) {
        resolvedExcerpts[t.slotIdx] = {
          ...(t.stepIndex !== undefined ? { stepIndex: t.stepIndex } : {}),
          stepSummary: t.stepSummary,
          commandText: t.commandText,
          source: t.source,
          found: false,
          ambiguous: true,
          missingNotice: AMBIGUOUS_STEP_MSG,
        };
        continue;
      }
      const list = targetsBySession.get(chosenSession) ?? [];
      list.push(t);
      targetsBySession.set(chosenSession, list);
    }

    for (const [sName, sTargets] of targetsBySession.entries()) {
      const rawLines = sessionRawLines.get(sName)!;
      const sLength = entryTextLength(params.sessionTexts.get(sName)!);
      const isTruncatedLen = sLength >= SESSION_RETENTION_NEAR_CHARS;

      // Count occurrences of each normalized command within THIS session's plan sequence.
      const cmdPlanCounts = new Map<string, number>();
      for (const t of sTargets) {
        const cn = normWs(t.commandText);
        cmdPlanCounts.set(cn, (cmdPlanCounts.get(cn) ?? 0) + 1);
      }

      // Unique single-occurrence anchors that match cleanly once in this session.
      const rawAnchors: Array<{ pos: number; lineIndex: number }> = [];
      for (let pos = 0; pos < sTargets.length; pos++) {
        const t = sTargets[pos];
        const cn = normWs(t.commandText);
        if ((cmdPlanCounts.get(cn) ?? 0) !== 1) continue;
        const cands = candidatesPerTargetSession[t.slotIdx].get(sName) ?? [];
        if (cands.length === 1 && cands[0].kind !== 'ambiguous') {
          rawAnchors.push({ pos, lineIndex: cands[0].lineIndex });
        }
      }

      // Enforce strictly increasing monotonic anchor chain.
      const anchors: Array<{ pos: number; lineIndex: number }> = [];
      for (const a of rawAnchors) {
        if (anchors.length === 0 || a.lineIndex > anchors[anchors.length - 1].lineIndex) {
          anchors.push(a);
        }
      }
      const anchorSet = new Map<number, number>(anchors.map((a) => [a.pos, a.lineIndex]));
      for (const a of anchors) {
        const t = sTargets[a.pos];
        resolvedExcerpts[t.slotIdx] = {
          ...(t.stepIndex !== undefined ? { stepIndex: t.stepIndex } : {}),
          stepSummary: t.stepSummary,
          commandText: t.commandText,
          source: t.source,
          found: true,
          sessionName: sName,
          sessionChars: sLength,
          excerpt: extractExcerptAt(rawLines, a.lineIndex),
        };
      }

      // Partition remaining positions into anchor-bracketed windows (lowLine, highLine).
      const windows: Array<{ startPos: number; endPos: number; lowLine: number; highLine: number }> = [];
      let prevPos = -1;
      let prevLine = -1;
      for (const a of anchors) {
        if (a.pos > prevPos + 1) {
          windows.push({ startPos: prevPos + 1, endPos: a.pos - 1, lowLine: prevLine, highLine: a.lineIndex });
        }
        prevPos = a.pos;
        prevLine = a.lineIndex;
      }
      if (prevPos + 1 <= sTargets.length - 1) {
        windows.push({ startPos: prevPos + 1, endPos: sTargets.length - 1, lowLine: prevLine, highLine: Number.POSITIVE_INFINITY });
      }

      for (const win of windows) {
        const groups = new Map<string, LocateTarget[]>();
        for (let pos = win.startPos; pos <= win.endPos; pos++) {
          if (anchorSet.has(pos)) continue;
          const t = sTargets[pos];
          const cn = normWs(t.commandText);
          const g = groups.get(cn) ?? [];
          g.push(t);
          groups.set(cn, g);
        }
        for (const [cn, grp] of groups.entries()) {
          const allCands = candidatesPerTargetSession[grp[0].slotIdx].get(sName) ?? [];
          const winCands = allCands.filter((c) => c.lineIndex > win.lowLine && c.lineIndex < win.highLine);
          if (winCands.some((c) => c.kind === 'ambiguous')) {
            for (const t of grp) {
              resolvedExcerpts[t.slotIdx] = {
                ...(t.stepIndex !== undefined ? { stepIndex: t.stepIndex } : {}),
                stepSummary: t.stepSummary,
                commandText: t.commandText,
                source: t.source,
                found: false,
                ambiguous: true,
                sessionName: sName,
                sessionChars: sLength,
                missingNotice: AMBIGUOUS_STEP_MSG,
              };
            }
            continue;
          }
          if (winCands.length === grp.length && winCands.length > 0) {
            for (let j = 0; j < grp.length; j++) {
              const t = grp[j];
              resolvedExcerpts[t.slotIdx] = {
                ...(t.stepIndex !== undefined ? { stepIndex: t.stepIndex } : {}),
                stepSummary: t.stepSummary,
                commandText: t.commandText,
                source: t.source,
                found: true,
                sessionName: sName,
                sessionChars: sLength,
                excerpt: extractExcerptAt(rawLines, winCands[j].lineIndex),
              };
            }
            continue;
          }
          if (winCands.length === 0) {
            // Only cite 12,000-char gateway head truncation when session reached retention cap,
            // is strictly absent from all retained session lines, and no earlier step was retained (`lowLine === -1`).
            const beforeRetained =
              isTruncatedLen
              && win.lowLine === -1
              && allCands.length === 0;
            const notice = beforeRetained ? MISSING_STEP_TRUNCATION_MSG : MISSING_STEP_NOT_FOUND_MSG;
            for (const t of grp) {
              resolvedExcerpts[t.slotIdx] = {
                ...(t.stepIndex !== undefined ? { stepIndex: t.stepIndex } : {}),
                stepSummary: t.stepSummary,
                commandText: t.commandText,
                source: t.source,
                found: false,
                sessionName: sName,
                sessionChars: sLength,
                missingNotice: notice,
              };
            }
            continue;
          }
          // Count mismatch in same window (e.g. repeated command appeared fewer/more times with no anchor separating them).
          for (const t of grp) {
            resolvedExcerpts[t.slotIdx] = {
              ...(t.stepIndex !== undefined ? { stepIndex: t.stepIndex } : {}),
              stepSummary: t.stepSummary,
              commandText: t.commandText,
              source: t.source,
              found: false,
              ambiguous: true,
              sessionName: sName,
              sessionChars: sLength,
              missingNotice: AMBIGUOUS_STEP_MSG,
            };
          }
        }
      }
    }
  }

  const stepExcerpts = resolvedExcerpts.filter((x): x is StepDeviceExcerpt => x !== null);

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
    const cleanText = primary.text
      .replace(/\r\n/g, '\n')
      .split('\n')
      .map(sanitizeTerminalExcerptLine)
      .join('\n');
    let slice = cleanText;
    if (cleanText.length > INLINE_TAIL_CHARS) {
      const rawSlice = cleanText.slice(-INLINE_TAIL_CHARS);
      const nlIdx = rawSlice.indexOf('\n');
      slice = nlIdx >= 0 && nlIdx < rawSlice.length - 1 ? rawSlice.slice(nlIdx + 1) : rawSlice;
    }
    const prefixNote =
      cleanText.length > INLINE_TAIL_CHARS
        ? `[${primaryName} 仅展示解码后末尾 ${slice.length} / ${cleanText.length} 字符] `
        : `[${primaryName} 共 ${cleanText.length} 字符（原始 ${primary.text.length} 字符）] `;
    const candidateTail = `${prefixNote}\n${slice}`;
    inlineTail =
      candidateTail.length > INLINE_TAIL_CHARS
        ? candidateTail.slice(-INLINE_TAIL_CHARS)
        : candidateTail;
  }

  const logLines = logText ? collectCandidateLogLines(logText) : [];
  const logExcerpt = logLines.join('\n').slice(0, 3000);

  // D5: Populate anomalies and error signatures STRICTLY from structured records, contract markers,
  // and executor framework failure marker lines (never free-text keyword regexes that falsely hit `NOERROR`).
  const anomalyLines: string[] = [];
  const pushAnomaly = (line: string): void => {
    const clean = line.trim();
    if (!clean || anomalyLines.includes(clean) || anomalyLines.length >= MAX_ANOMALY_LINES) return;
    anomalyLines.push(clean);
  };
  if (passReview) pushAnomaly(`${passReview.where}: ${passReview.line}`);
  for (const sr of syntaxRejected) pushAnomaly(`syntax_rejected[${sr.prompt ?? '?'}]: ${sr.command}${sr.token ? ` (^ ${sr.token})` : ''}`);
  for (const er of executionRefused) pushAnomaly(`execution_refused[${er.prompt}]: ${er.command} => ${er.reply.join(' / ')}`);

  let contractMarkerHitLine: string | null = null;
  if (params.markers && params.markers.length > 0) {
    const markerTexts: Record<string, string> = {};
    if (logText) markerTexts['log.txt'] = logText;
    for (const [sName, entry] of params.sessionTexts.entries()) markerTexts[sName] = entry.text;
    const markerHit = failureLine(markerTexts, params.markers, []);
    if (markerHit) {
      contractMarkerHitLine = markerHit.line;
      pushAnomaly(`${markerHit.where}: ${markerHit.line}`);
    }
  }

  const runnerFailLines: string[] = [];
  if (logText) {
    for (const raw of logText.replace(/\r/g, '').split('\n')) {
      const trimmedLine = raw.trim();
      if (!trimmedLine || !isExecutorFailureLogLine(trimmedLine)) continue;
      if (!runnerFailLines.includes(trimmedLine)) runnerFailLines.push(trimmedLine);
      if (anomalyLines.length < MAX_ANOMALY_LINES) pushAnomaly(trimmedLine);
    }
  }

  const verdict = typeof matchedRow.verdict === 'string' ? matchedRow.verdict : 'unknown';
  const runnerVerdict = typeof matchedRow.runner_verdict === 'string' ? matchedRow.runner_verdict : undefined;
  const notExecuted = isRecord(matchedRow.not_executed) && typeof matchedRow.not_executed.reason === 'string' && matchedRow.not_executed.reason.trim()
    ? { reason: matchedRow.not_executed.reason, next_action: typeof matchedRow.not_executed.next_action === 'string' ? matchedRow.not_executed.next_action : '' }
    : undefined;

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
  const pushSig = (sig: string): void => {
    if (sig && !errorSignatures.includes(sig)) errorSignatures.push(sig);
  };
  for (const sr of syntaxRejected) pushSig(`syntax:${commandSignatureHead(sr.command)}${sr.token ? `:${sr.token.toLowerCase()}` : ''}`);
  for (const er of executionRefused) pushSig(`exec_refused:${commandSignatureHead(er.command)}:${normalizeErrorToken(er.reply[0] ?? '')}`);
  if (passReview) pushSig(`pass_review:${normalizeErrorToken(passReview.line)}`);
  if (contractMarkerHitLine) pushSig(`contract_marker:${normalizeErrorToken(contractMarkerHitLine)}`);
  for (const rf of runnerFailLines.slice(0, MAX_ANOMALY_LINES)) {
    pushSig(`runner_fail:${normalizeErrorToken(rf)}`);
  }
  // A case the run never reached has no device error to repeat: it must not read as the same failure twice.
  if (errorSignatures.length === 0 && verdict !== 'pass' && !notExecuted) {
    pushSig(`device_verdict:${verdict}`);
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
    ...(notExecuted ? { notExecuted } : {}),
  };
}

function entryTextLength(entry: { path: string; text: string }): number {
  return entry.text.length;
}

function matchesItemIdentifier(candidate: unknown, caseIds: ReadonlySet<string>): boolean | null {
  if (typeof candidate !== 'string' || !candidate.trim()) return null;
  if (caseIds.size === 0) return true;
  return caseIds.has(candidate.trim());
}

function truncateAnswerField(value: string, maxChars: number): string {
  const clean = value.replace(/\r/g, '').trim();
  if (clean.length <= maxChars) return clean;
  return `${clean.slice(0, maxChars)}…（已截断 ${clean.length - maxChars} 字符）`;
}

function cleanPunctuationRuns(text: string): string {
  let out = text.replace(/\r/g, '');
  for (let i = 0; i < 3; i++) {
    out = out
      .replace(/[（(]\s*[，,；;：:、\s]*[）)]/g, '')
      .replace(/([（(])\s*[；;，,、]+/g, '$1')
      .replace(/[；;，,、]+\s*([）)])/g, '$1')
      .replace(/([；;，,])(?:\s*[；;，,])+/g, '$1')
      .replace(/\s+/g, ' ')
      .replace(/^[；;，,、：\s]+|[；;，,、\s]+$/g, '')
      .trim();
  }
  return out;
}

/**
 * Strips internal Hub transport identifiers (`rec:<hex>`, `usr_<id>`, ms UTC timestamps)
 * from `errors[].message` / `errors[].fix`, and drops duplicated `缺失事实：<message>` clauses inside `fix`.
 */
export function sanitizeHubAnswerField(raw: string, stripMissingFactText?: string): string {
  if (!raw) return '';
  let out = raw
    .replace(/\r/g, '')
    .replace(/(?:请求(?:摘要|记录|编号)?|审计(?:记录|摘要)?|凭据|trace)[：:\s]*rec:[0-9a-f]{16,64}(?:\/[^\s，。；,;）)]*)?/gi, '')
    .replace(/(?:受众|用户|使用者|操作者|发起人)[：:\s]*\busr_[0-9a-z_-]+\b/gi, '')
    .replace(/\brec:[0-9a-f]{16,64}(?:\/[^\s，。；,;）)]*)?/gi, '')
    .replace(/\busr_[0-9a-z_-]+\b/gi, '')
    .replace(/\b(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}):\d{2}\.\d{1,6}Z\b/g, '$1 $2 UTC');

  if (stripMissingFactText) {
    const cleanMsgExact = cleanPunctuationRuns(stripMissingFactText).replace(/[。；;，,]+$/, '').trim();
    if (cleanMsgExact) {
      const escapedMsg = cleanMsgExact.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      out = out.replace(new RegExp(`(?:^|[；;\\n])\\s*缺失事实[：:]\\s*${escapedMsg}[。；;]?`, 'g'), '');
    }
  }

  out = cleanPunctuationRuns(out);

  if (stripMissingFactText) {
    const cleanMsg = cleanPunctuationRuns(stripMissingFactText).replace(/[。；;，,]+$/, '').trim();
    if (cleanMsg) {
      const clauses = out
        .split(/(?<=[；;。\n])|[；;\n]+/)
        .map((c) => cleanPunctuationRuns(c))
        .filter(Boolean);
      const filtered: string[] = [];
      for (const clause of clauses) {
        const factM = /^缺失事实[：:]\s*(.+)$/.exec(clause);
        if (factM) {
          const factBody = cleanPunctuationRuns(factM[1]).replace(/[。；;，,]+$/, '').trim();
          const overlapPrefixLen = Math.min(cleanMsg.length, factBody.length, 16);
          if (
            factBody === cleanMsg
            || (overlapPrefixLen >= 8 && (cleanMsg.startsWith(factBody.slice(0, overlapPrefixLen)) || factBody.startsWith(cleanMsg.slice(0, overlapPrefixLen))))
          ) {
            continue;
          }
        }
        const stripped = clause.replace(/[。；;，,]+$/, '').trim();
        if (stripped === cleanMsg) continue;
        filtered.push(clause);
      }
      out = cleanPunctuationRuns(filtered.join('；'));
      const remainingNorm = out.replace(/[。；;，,]+$/, '').trim();
      if (remainingNorm === cleanMsg) return '';
    }
  }

  return out;
}

function parseAcceptanceField(raw: unknown): Acceptance | null {
  if (typeof raw !== 'string') return null;
  const normalized = raw.trim().toLowerCase();
  if (isAcceptance(normalized)) return normalized;
  if (normalized === 'rejected') return 'not_accepted';
  return null;
}

function resolveAnswerAcceptance(parsed: Record<string, unknown>): Acceptance | null {
  const top = parseAcceptanceField(parsed.acceptance);
  if (top !== null) return top;
  const nested = isRecord(parsed.result) ? parseAcceptanceField(parsed.result.acceptance) : null;
  if (nested !== null) return nested;
  const callRes = typeof parsed.call_result === 'string' ? parsed.call_result.trim().toLowerCase() : '';
  if (callRes === 'error' || callRes === 'rejected') return 'not_accepted';
  return null;
}

function extractCompactGateErrorsFromObject(
  parsed: Record<string, unknown>,
  caseIds: ReadonlySet<string>,
  round: number,
  pushItem: (item: GateRefusalItem) => void,
  allowRootFallback = false,
): void {
  let emittedCount = 0;
  const emit = (item: GateRefusalItem): void => {
    emittedCount += 1;
    pushItem(item);
  };
  const originalCases = Array.isArray(parsed.original_cases)
    ? parsed.original_cases.filter((c): c is Record<string, unknown> => isRecord(c))
    : [];
  const otherCaseTokens: string[] = [];
  const indexToIds = new Map<number, string[]>();

  for (let i = 0; i < originalCases.length; i++) {
    const oc = originalCases[i];
    const rowIds = [oc.id, oc.item, oc.autoid, oc.item_id, oc.case_id]
      .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
      .map((s) => s.trim());
    indexToIds.set(i, rowIds);
    for (const id of rowIds) {
      if (caseIds.size > 0 && !caseIds.has(id)) otherCaseTokens.push(id);
    }
  }

  const belongsToCaseByPointer = (ptr: string): boolean | null => {
    const m = /^\/items\/(\d+)(?:\/|$)/.exec(ptr);
    if (!m) return null;
    const rowIds = indexToIds.get(Number(m[1]));
    if (!rowIds || rowIds.length === 0) return null;
    if (caseIds.size === 0) return true;
    return rowIds.some((id) => caseIds.has(id));
  };

  const acceptErrorRecord = (err: Record<string, unknown>, inheritedCode?: string): void => {
    const explicitItem =
      typeof err.item === 'string'
        ? err.item
        : typeof err.autoid === 'string'
          ? err.autoid
          : typeof err.item_id === 'string'
            ? err.item_id
            : typeof err.id === 'string'
              ? err.id
              : '';
    const itemMatch = matchesItemIdentifier(explicitItem, caseIds);
    if (itemMatch === false) return;

    const ptr =
      typeof err.pointer === 'string'
        ? err.pointer
        : typeof err.path === 'string'
          ? err.path
          : '';
    if (itemMatch === null) {
      const ptrMatch = belongsToCaseByPointer(ptr);
      if (ptrMatch === false) return;
      if (ptrMatch === null && caseIds.size > 0) {
        const msgRaw = typeof err.message === 'string' ? err.message : '';
        const mentionsOurs = [...caseIds].some((id) => msgRaw.includes(id) || ptr.includes(id));
        if (!mentionsOurs) {
          if (otherCaseTokens.some((tok) => msgRaw.includes(tok))) return;
          if (/(?:item_|99\d{14,}|doc-\d+:c-\d+)/.test(msgRaw)) return;
        }
      }
    }

    const code = typeof err.code === 'string' && err.code.trim()
      ? err.code.trim()
      : (inheritedCode ?? 'GATE_REFUSAL');
    const rawMsg = typeof err.message === 'string' && err.message.trim()
      ? err.message.trim()
      : typeof err.reason === 'string' && err.reason.trim()
        ? err.reason.trim()
        : typeof err.detail === 'string' && err.detail.trim()
          ? err.detail.trim()
          : '';
    const rawFix = typeof err.fix === 'string' ? err.fix : '';
    if (!rawMsg && !ptr && !rawFix && !err.code) return;

    const cleanMsg = sanitizeHubAnswerField(rawMsg);
    const cleanFix = sanitizeHubAnswerField(rawFix, cleanMsg || rawMsg);

    emit({
      round,
      source: 'hub_gate',
      code,
      path: truncateAnswerField(ptr, 200),
      message: truncateAnswerField(cleanMsg || rawMsg || code, 400),
      fix: truncateAnswerField(cleanFix, 300),
    });
  };

  const errorLists: unknown[][] = [];
  if (Array.isArray(parsed.errors)) errorLists.push(parsed.errors);
  if (Array.isArray(parsed.missing_input)) errorLists.push(parsed.missing_input);
  if (isRecord(parsed.result) && Array.isArray(parsed.result.errors)) errorLists.push(parsed.result.errors);
  if (isRecord(parsed.result) && Array.isArray(parsed.result.missing_input)) errorLists.push(parsed.result.missing_input);
  if (isRecord(parsed.acceptance) && Array.isArray(parsed.acceptance.errors)) errorLists.push(parsed.acceptance.errors);
  for (const list of errorLists) {
    for (const err of list) {
      if (isRecord(err)) acceptErrorRecord(err);
    }
  }

  // `submit_result` also groups outcome partitions inside `result.partitions` (array or keyed map).
  const partitions = isRecord(parsed.result) ? parsed.result.partitions : undefined;
  const inspectPartitionEntry = (entry: unknown, partitionKey?: string): void => {
    if (!isRecord(entry)) return;
    if (partitionKey && /^(?:accept|accepted|pass|passed|ok|success)$/i.test(partitionKey)) return;
    const status = typeof entry.status === 'string'
      ? entry.status
      : typeof entry.outcome === 'string'
        ? entry.outcome
        : typeof entry.verdict === 'string'
          ? entry.verdict
          : '';
    if (status && /^(?:accept|accepted|pass|passed|ok|success)$/i.test(status)) return;

    const code = typeof entry.code === 'string' ? entry.code : partitionKey;
    if (Array.isArray(entry.errors)) {
      for (const err of entry.errors) {
        if (isRecord(err)) acceptErrorRecord(err, code);
      }
    }
    const itemList = Array.isArray(entry.items)
      ? entry.items
      : Array.isArray(entry.cases)
        ? entry.cases
        : undefined;
    if (itemList) {
      for (const item of itemList) {
        if (isRecord(item)) {
          acceptErrorRecord(item, code);
        } else if (typeof item === 'string' && (caseIds.size === 0 || caseIds.has(item))) {
          acceptErrorRecord({
            item,
            code: code ?? 'GATE_REFUSAL',
            message: typeof entry.message === 'string' ? entry.message : `${partitionKey ?? 'partition'} 未受理`,
            fix: typeof entry.fix === 'string' ? entry.fix : '',
          });
        }
      }
      return;
    }
    if (
      typeof entry.item === 'string'
      || typeof entry.autoid === 'string'
      || typeof entry.item_id === 'string'
      || typeof entry.id === 'string'
    ) {
      acceptErrorRecord(entry, code);
    }
  };

  if (Array.isArray(partitions)) {
    for (const part of partitions) inspectPartitionEntry(part);
  } else if (isRecord(partitions)) {
    for (const [key, val] of Object.entries(partitions)) {
      if (Array.isArray(val)) {
        for (const entry of val) inspectPartitionEntry(entry, key);
      } else {
        inspectPartitionEntry(val, key);
      }
    }
  }

  if (
    emittedCount === 0
    && allowRootFallback
    && (
      typeof parsed.code === 'string'
      || typeof parsed.message === 'string'
      || typeof parsed.reason === 'string'
      || typeof parsed.pointer === 'string'
      || typeof parsed.path === 'string'
    )
  ) {
    acceptErrorRecord(parsed);
  }
}

/**
 * Parses an `answer-*.txt` file from `submit-plans.ts` or Hub `submit_result` output,
 * separating unaccepted gate refusals (`acceptance !== 'accepted'`) from accepted missing-input
 * notices (`acceptance === 'accepted'`, e.g. `missing_input`) while scrubbing internal Hub IDs and duplicates.
 */
export function parseHubAnswerNotices(
  answerText: string,
  caseIds: ReadonlySet<string>,
  round: number,
): HubAnswerNotices {
  const trimmed = answerText.trim();
  if (!trimmed) return { acceptanceParsed: false, acceptance: null, refusals: [], acceptedNotices: [] };

  const refusals: GateRefusalItem[] = [];
  const acceptedNotices: GateRefusalItem[] = [];
  const pushDedup = (target: GateRefusalItem[]) => (item: GateRefusalItem): void => {
    const dup = target.some((x) => x.code === item.code && x.path === item.path && x.message === item.message);
    if (!dup) target.push(item);
  };

  let overallAcceptance: Acceptance | null = null;
  const recordObject = (parsed: Record<string, unknown>): void => {
    const acc = resolveAnswerAcceptance(parsed);
    if (acc === 'not_accepted') overallAcceptance = 'not_accepted';
    else if (acc === 'accepted' && overallAcceptance !== 'not_accepted') overallAcceptance = 'accepted';
    const target = acc === 'accepted' ? acceptedNotices : refusals;
    extractCompactGateErrorsFromObject(parsed, caseIds, round, pushDedup(target), acc !== 'accepted');
  };

  let parsedStructuredJson = false;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (isRecord(parsed)) {
      parsedStructuredJson = true;
      recordObject(parsed);
      return {
        acceptanceParsed: overallAcceptance !== null,
        acceptance: overallAcceptance,
        refusals,
        acceptedNotices,
      };
    }
  } catch {
    // Multi-line `submit_result` text: inspect embedded single-line JSON payloads (e.g. after `供模型引用`).
  }

  const lines = trimmed.replace(/\r/g, '').split('\n');
  let markerLineIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const lineTrim = lines[i].trim();
    if (lineTrim === '供模型引用' || lineTrim.startsWith('供模型引用：') || lineTrim.startsWith('供模型引用:')) {
      markerLineIdx = i;
      continue;
    }
    if (!lineTrim.startsWith('{') || !lineTrim.endsWith('}')) continue;
    try {
      const parsed: unknown = JSON.parse(lineTrim);
      if (isRecord(parsed)) {
        parsedStructuredJson = true;
        recordObject(parsed);
      }
    } catch {
      // Not a standalone JSON object line.
    }
  }
  if (parsedStructuredJson) {
    return {
      acceptanceParsed: overallAcceptance !== null,
      acceptance: overallAcceptance,
      refusals,
      acceptedNotices,
    };
  }

  // Legacy plain-text Hub answer format (no structured JSON payload present): never emit raw JSON lines.
  const ids = [...caseIds];
  const scanLimit = markerLineIdx >= 0 ? markerLineIdx : lines.length;
  const pushRefusal = pushDedup(refusals);
  for (let i = 0; i < scanLimit; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('{') || line.startsWith('[')) continue;
    const matchesCase = ids.length === 0 || ids.some((id) => line.includes(id));
    if (!matchesCase) continue;
    const codeMatch = /\b([A-Z][A-Z0-9_]{2,}|case-compile\.[a-z0-9_]+)\b/.exec(line);
    const pointerMatch = /(\/[A-Za-z0-9_./[\]-]+)/.exec(line);
    const nextLine = i + 1 < scanLimit && /^(?:修复|建议|fix[:：])/i.test(lines[i + 1].trim())
      ? lines[i + 1].trim()
      : '';
    const cleanMsg = sanitizeHubAnswerField(line);
    const cleanFix = sanitizeHubAnswerField(nextLine, cleanMsg || line);
    pushRefusal({
      round,
      source: 'hub_gate',
      code: codeMatch ? codeMatch[1] : 'GATE_REFUSAL',
      path: pointerMatch ? truncateAnswerField(pointerMatch[1], 200) : '',
      message: truncateAnswerField(cleanMsg || line, 400),
      fix: truncateAnswerField(cleanFix, 300),
    });
  }
  return { acceptanceParsed: false, acceptance: null, refusals, acceptedNotices };
}

/**
 * Extracts only unaccepted Hub gate refusals (`acceptance !== 'accepted'`) for THIS case.
 * Accepted responses containing `missing_input` return `[]` here; inspect `parseHubAnswerNotices` for accepted gaps.
 */
export function parseGateRefusalsFromAnswer(
  answerText: string,
  caseIds: ReadonlySet<string>,
  round: number,
): GateRefusalItem[] {
  return parseHubAnswerNotices(answerText, caseIds, round).refusals;
}

function parsePositiveRoundValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : null;
}

/**
 * Parses prior attribution / delivery notes (`Notes` JSON `{ cases: { "<autoid>": ... } }` or single-case attribution JSON),
 * strictly matching ONLY `caseIds` and pinning `confidence: "hypothesis"`.
 * Never fabricates a round number when `notes.json` omits `round` (CLI positional round arguments are ignored for attribution).
 */
export function parsePriorAttribution(
  raw: unknown,
  caseIds: ReadonlySet<string>,
  _cliRoundHint: number | null,
  sourceFile: string,
): PriorAttributionItem | null {
  if (!isRecord(raw)) return null;

  // Format 1: Notes JSON from delivery (`{ round?, cases: { [autoid]: { round?, judged, remedy, evidence?, defect_candidate?, author_conflict? } } }`)
  if (isRecord(raw.cases)) {
    const topRound = parsePositiveRoundValue(raw.round);
    for (const id of caseIds) {
      const entry = raw.cases[id];
      if (!isRecord(entry)) continue;
      const entryRound = parsePositiveRoundValue(entry.round) ?? topRound;
      const evidenceQuotes = typeof entry.evidence === 'string' && entry.evidence.trim() ? [entry.evidence.trim()] : [];
      return {
        round: entryRound,
        roundRecorded: entryRound !== null,
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

  // Format 2: Single-case attribution JSON (`compile-attributor` output)
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
  const recordRound = parsePositiveRoundValue(record.round);

  return {
    round: recordRound,
    roundRecorded: recordRound !== null,
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
  const isSpecificSignature = (s: string): boolean => !s.startsWith('device_verdict:');
  const prevSpecific = prevSigs.filter(isSpecificSignature);
  const currSpecific = currSigs.filter(isSpecificSignature);
  for (const sig of currSpecific) {
    if (prevSpecific.includes(sig)) return sig;
  }
  // Fallback: match same syntax command root or same execution_refused command root across parameter retries.
  const coarse = (s: string): string => {
    const parts = s.split(':');
    if (parts[0] === 'syntax' || parts[0] === 'exec_refused' || parts[0] === 'gate') {
      return `${parts[0]}:${parts[1] ?? ''}`;
    }
    return s;
  };
  for (const sig of currSpecific) {
    const c = coarse(sig);
    if (prevSpecific.some((p) => coarse(p) === c)) return c;
  }
  return null;
}

/**
 * Returns Hub refusal codes that appeared sequentially in at least two trailing prior rounds
 * (only unaccepted responses in `gateRefusals`; never counts `acceptedNotices` or multiple errors in a single round).
 */
export function consecutiveRepeatedGateCodes(rounds: readonly PriorRoundRecord[]): string[] {
  const ordered = [...rounds].sort((a, b) => a.round - b.round);
  if (ordered.length < 2) return [];
  const latest = ordered[ordered.length - 1];
  const candidateCodes = [...new Set(latest.gateRefusals.map((g) => g.code).filter(Boolean))];
  const repeated: string[] = [];
  for (const code of candidateCodes) {
    let streak = 1;
    for (let i = ordered.length - 2; i >= 0; i--) {
      if (ordered[i].gateRefusals.some((g) => g.code === code)) {
        streak++;
      } else {
        break;
      }
    }
    if (streak >= 2) repeated.push(code);
  }
  return repeated;
}

/**
 * Computes round-to-round plan diffs and detects trailing consecutive rounds hitting the same error class.
 * InfoTest provenance (`InfoTest_Engine/main/ist_core/compile_engine/`):
 * - `finalAttempt`: marks the last retry budget slot (`briefs.py:2982-2985`, rendered in Chinese).
 * - `varyFormRequired`: triggers ONLY when InfoTest itself requires changing approach:
 *   1) two or more consecutive unaccepted Hub gate refusals share the same code
 *      (`briefs.py:2681-2690`, `rejection_history.py:3-40`, `nodes.py:9532-9594`), OR
 *   2) failure attribution carries `disposition === "frozen"` (`remedies.py:39-42`).
 * - General device failures (`runner_fail:`, `exec_refused:`, `syntax:`) still report `consecutiveSameError`
 *   as a factual observation without auto-forcing `varyFormRequired` (no matching InfoTest rule in `briefs.py:2792-2820`).
 */
export function analyzeRoundHistory(params: {
  currentRound: number;
  attemptLimit?: number;
  rounds: readonly PriorRoundRecord[];
  unrecordedAttribution?: PriorAttributionItem | null;
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

  const repeatedGateCodes = consecutiveRepeatedGateCodes(ordered);
  const latestAttr =
    [...ordered].reverse().find((r) => r.attribution)?.attribution
    ?? params.unrecordedAttribution
    ?? null;
  const hasFrozenDisposition =
    typeof latestAttr?.disposition === 'string' && latestAttr.disposition.trim().toLowerCase() === 'frozen';
  const hasConsecutiveGateSignature =
    consecutiveSameError >= 2 && Boolean(repeatedSignature?.startsWith('gate:'));
  const varyFormRequired =
    repeatedGateCodes.length > 0
    || hasConsecutiveGateSignature
    || hasFrozenDisposition;

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

function clipTextHeadTail(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= 60) return text.slice(0, maxChars);
  const headLen = Math.floor(maxChars * 0.58);
  const tailLen = Math.max(0, maxChars - headLen - 24);
  const skipped = text.length - headLen - tailLen;
  return `${text.slice(0, headLen)}\n…（中间省略 ${skipped} 字符）\n${text.slice(text.length - tailLen)}`;
}

function clipTextTail(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const skipped = text.length - maxChars;
  return `…（前略 ${skipped} 字符）\n${text.slice(text.length - maxChars)}`;
}

function renderAttributionLines(attr: PriorAttributionItem, heading: string): string[] {
  const lines: string[] = ['', heading];
  lines.push(`- 注意：${UNCONFIRMED_HYPOTHESIS_NOTE}`);
  lines.push(`- 来源文件：${attr.sourceFile}`);
  if (attr.layer || attr.disposition) {
    lines.push(`- 排查层级 / 处置：${[attr.layer, attr.disposition].filter(Boolean).join(' / ')}`);
  }
  if (attr.judged) lines.push(...wrapProseLine('- 失败分析结论（未确认）：', attr.judged));
  if (attr.remedy) lines.push(...wrapProseLine('- 建议下一步：', attr.remedy));
  if (attr.evidenceQuotes.length > 0) {
    for (const q of attr.evidenceQuotes) lines.push(`- 引用证据原句：${q}`);
  }
  if (attr.defectCandidate) {
    lines.push(`- 曾提出的 defect_candidate（待证）：期望=${attr.defectCandidate.expected}；实际=${attr.defectCandidate.actual}`);
  }
  if (attr.authorConflict) {
    lines.push(`- 曾提出的 author_conflict（待证）：作者=${attr.authorConflict.author}；手册=${attr.authorConflict.manual}`);
  }
  return lines;
}

/**
 * Renders the deterministic round 2+ prior-round history Markdown block embedded directly into
 * `task-brief.ts` stdout and round-specific `.round-<n>.md` briefs.
 * Enforces `maxChars` (default `MAX_PRIOR_HISTORY_CHARS`) via fixed priority omission order with explicit disclosure.
 */
export function renderPriorRoundsMarkdown(params: {
  caseRef: string;
  currentRound: number;
  rounds: readonly PriorRoundRecord[];
  streak: StreakAnalysis;
  unrecordedAttribution?: PriorAttributionItem | null;
  maxChars?: number;
}): string {
  const ordered = [...params.rounds].sort((a, b) => a.round - b.round);
  const latest = ordered.at(-1);
  const budget = params.maxChars ?? MAX_PRIOR_HISTORY_CHARS;

  interface RenderState {
    inlineTailMode: 'full' | 'trim' | 'omit';
    logMode: 'full' | 'trim' | 'omit';
    excerptMaxChars: number | 'omit';
    planMode: 'full' | 'compact' | 'omit';
    keepHistoryFromIndex: number;
    gateLimit: number;
  }

  const assemble = (state: RenderState): { text: string; omissions: string[] } => {
    const omissions: string[] = [];
    const headerLines: string[] = [
      '## 上一轮与连续错误历史（同一原始用例，仅本案，程序生成）',
      `- 当前轮次：第 ${params.currentRound} 轮（上限 ${params.streak.attemptLimit} 轮，剩余机会 ${params.streak.remainingAttempts} 次${params.streak.finalAttempt ? '；最后一次机会（已达本案重试上限，须充分核查再重交）' : ''}）`,
    ];
    if (params.streak.consecutiveSameError >= 2) {
      headerLines.push(
        `- ⚠️ 连续同类错误提醒：同一原始用例已连续 ${params.streak.consecutiveSameError} 轮命中同类错误（${params.streak.repeatedSignature ?? params.streak.repeatedCategory ?? '未知类别'}）。下方仅原样列出历轮实际改动与报错对照，不替代编写模型/分析模型的独立判断。`,
      );
    }
    if (params.streak.varyFormRequired) {
      headerLines.push('- 须改换实现路径：连续两轮触发同码机械规则未受理或失败分析标记为已冻结，本轮须核查手册命令形态或前置条件后改换做法，勿仅微调字词重试。');
    }

    const historyLines: string[] = [];
    if (ordered.length > 0) {
      historyLines.push('', '### 历轮变更与失败摘要（仅同一原始用例，按轮次顺序）');
      const startIdx = Math.min(state.keepHistoryFromIndex, ordered.length - 1);
      if (startIdx > 0) {
        const omittedRounds = ordered.slice(0, startIdx).map((r) => `第 ${r.round} 轮`).join('、');
        omissions.push(`早期轮次变更摘要：${omittedRounds}（共 ${startIdx} 轮）`);
      }
      for (let idx = startIdx; idx < ordered.length; idx++) {
        const r = ordered[idx];
        const errLabel = r.errorSignatures.length ? r.errorSignatures.join('；') : '未记录报错签名';
        historyLines.push(`- 第 ${r.round} 轮（${r.planSource ? `计划 ${r.planSource}` : '未附计划文件'}）：报错标识 ${errLabel}`);
        if (idx === startIdx && r.plan) {
          const entries = r.plan.isBlocks ? r.plan.blocks.map((b) => b.summary) : r.plan.steps.map((s) => s.summary);
          for (const line of entries.slice(0, 12)) historyLines.push(`  · 初始步骤 ${line}`);
          if (entries.length > 12) historyLines.push(`  · …（共 ${entries.length} 步，仅摘前 12 步）`);
          for (const exp of r.plan.expects.slice(0, 8)) historyLines.push(`  · 初始期望 ${exp.summary}`);
        } else {
          const diff = params.streak.roundChanges.find((d) => d.toRound === r.round);
          if (diff) {
            for (const line of diff.lines) historyLines.push(`  ${line}`);
          } else if (r.plan) {
            historyLines.push(`  · 计划摘要：handling=${r.plan.handling}，共 ${r.plan.isBlocks ? r.plan.blocks.length + ' 块' : r.plan.steps.length + ' 步'}，${r.plan.expects.length} 条期望`);
          }
        }
        const acceptedNotices = r.acceptedNotices ?? [];
        if (r === latest) {
          if (r.gateRefusals.length > 0) {
            const codes = [...new Set(r.gateRefusals.map((g) => g.code))].join('、');
            historyLines.push(`  · Hub 没有受理，原因（共 ${r.gateRefusals.length} 条：${codes}，详见下方）`);
          }
          if (acceptedNotices.length > 0) {
            const codes = [...new Set(acceptedNotices.map((g) => g.code))].join('、');
            historyLines.push(`  · Hub 已受理，还缺（共 ${acceptedNotices.length} 项：${codes}，详见下方）`);
          }
        } else {
          if (r.gateRefusals.length > 0) {
            const limit = Math.min(state.gateLimit, r.gateRefusals.length);
            for (const g of r.gateRefusals.slice(0, limit)) {
              historyLines.push(`  · Hub 没有受理，原因 [${g.code}${g.path ? ` @ ${g.path}` : ''}]：${g.message}${g.fix ? `（修复：${g.fix}）` : ''}`);
            }
            if (r.gateRefusals.length > limit) {
              omissions.push(`第 ${r.round} 轮历轮摘要内未受理原因：保留前 ${limit} 条，省略 ${r.gateRefusals.length - limit} 条`);
            }
          }
          if (acceptedNotices.length > 0) {
            const limit = Math.min(state.gateLimit, acceptedNotices.length);
            for (const g of acceptedNotices.slice(0, limit)) {
              historyLines.push(`  · Hub 已受理，还缺 [${g.code}${g.path ? ` @ ${g.path}` : ''}]：${g.message}${g.fix ? `（待补：${g.fix}）` : ''}`);
            }
            if (acceptedNotices.length > limit) {
              omissions.push(`第 ${r.round} 轮历轮摘要内已受理待补项：保留前 ${limit} 条，省略 ${acceptedNotices.length - limit} 条`);
            }
          }
        }
      }
    }

    const planLines: string[] = [];
    if (latest?.plan) {
      const plan = latest.plan;
      const fullPlanLines: string[] = [
        '',
        `### 上一轮（第 ${latest.round} 轮）自动化用例全文摘要`,
        `- handling: ${plan.handling}${plan.text ? `；计划说明：${plan.text}` : ''}；replacements=${plan.replacementsCount}`,
      ];
      const list = plan.isBlocks ? plan.blocks.map((b) => b.summary) : plan.steps.map((s) => s.summary);
      fullPlanLines.push(plan.isBlocks ? '- 分块列表（blocks）：' : '- 顺序步骤（steps）：');
      if (list.length === 0) fullPlanLines.push('  （无步骤）');
      for (const line of list) fullPlanLines.push(`  ${line}`);
      fullPlanLines.push('- 断言期望（expects）：');
      if (plan.expects.length === 0) fullPlanLines.push('  （无期望）');
      for (const exp of plan.expects) fullPlanLines.push(`  ${exp.summary}`);

      if (state.planMode === 'omit') {
        const origChars = fullPlanLines.join('\n').length;
        omissions.push(`上一轮自动化用例全文摘要（原 ${origChars} 字符）`);
      } else if (state.planMode === 'compact') {
        const keptSteps = list.slice(0, 8);
        const keptExpects = plan.expects.slice(0, 5);
        planLines.push(
          '',
          `### 上一轮（第 ${latest.round} 轮）自动化用例摘要（已压缩）`,
          `- handling: ${plan.handling}；总计 ${list.length} 项、${plan.expects.length} 条期望`,
          ...keptSteps.map((l) => `  ${l}`),
          ...(list.length > keptSteps.length ? [`  …（省略其余 ${list.length - keptSteps.length} 项）`] : []),
          ...keptExpects.map((e) => `  ${e.summary}`),
          ...(plan.expects.length > keptExpects.length ? [`  …（省略其余 ${plan.expects.length - keptExpects.length} 条期望）`] : []),
        );
        const origChars = fullPlanLines.join('\n').length;
        const keptChars = planLines.join('\n').length;
        if (origChars > keptChars) {
          omissions.push(`上一轮自动化用例步骤与期望（原 ${origChars} 字符 -> 保留 ${keptChars} 字符，省略 ${origChars - keptChars} 字符）`);
        }
      } else {
        planLines.push(...fullPlanLines);
      }
    }

    const deviceLines: string[] = [];
    if (latest?.deviceEvidence) {
      const dev = latest.deviceEvidence;
      deviceLines.push('', `### 上一轮（第 ${latest.round} 轮）上机验证设备返回与报错步逐字输出`);
      deviceLines.push(
        `- index.json 结论：run=${dev.verificationRun}，job=${dev.job}，verdict=${dev.verdict}${dev.runnerVerdict ? `，runner_verdict=${dev.runnerVerdict}` : ''}${dev.logFile ? `，log=${dev.logFile}` : ''}`,
      );
      if (dev.notExecuted) deviceLines.push(`- 本轮没有在设备上执行，不算一次上机：${dev.notExecuted.reason}${dev.notExecuted.next_action ? `。下一步：${dev.notExecuted.next_action}` : ''}`);
      deviceLines.push(`- 证据边界：${MISSING_EVIDENCE_CAVEAT}`);
      if (dev.passReview) {
        deviceLines.push(`- pass_review 降级依据：${dev.passReview.where} -> ${dev.passReview.line}`);
      }
      if (Object.keys(dev.sessionLengths).length > 0) {
        const summary = Object.entries(dev.sessionLengths)
          .map(([name, chars]) => `${name}: ${chars} 字符`)
          .join('、');
        deviceLines.push(`- 已保存设备会话长度（网关上限保留末尾 ${SESSION_RETAINED_CHARS} 字符）：${summary}`);
      }
      if (dev.syntaxRejected.length > 0) {
        deviceLines.push('- 语法拒绝（syntax_rejected）：');
        for (const sr of dev.syntaxRejected) {
          deviceLines.push(`  · [${sr.session ?? '未知会话'}] ${sr.prompt ?? '(未知提示符)'} ${sr.command}${sr.token ? `（脱字符指向：${sr.token}）` : ''}${runnerNote(sr)}`);
        }
      }
      if (dev.executionRefused.length > 0) {
        deviceLines.push('- 执行拒绝（execution_refused）：');
        for (const er of dev.executionRefused) {
          deviceLines.push(`  · [${er.session ?? '未知会话'}] ${er.prompt} ${er.command}${er.echo_cut ? ' [长命令回显被终端重绘截断]' : ''}${runnerNote(er)} => ${er.reply.join(' | ')}`);
        }
      }
      if (dev.anomalyLines.length > 0) {
        deviceLines.push('- 关键异常行（最多 5 条）：');
        for (const line of dev.anomalyLines) deviceLines.push(`  · ${line}`);
      }

      if (dev.stepExcerpts.length > 0) {
        deviceLines.push('- 各关键步骤/命令在设备会话中的逐字摘录（区分 12,000 字符保留截断、输出无法唯一定位与未找到命令）：');
        let excerptOmittedChars = 0;
        let excerptTrimmedCount = 0;
        for (const step of dev.stepExcerpts) {
          const header = step.stepIndex !== undefined ? `第 ${step.stepIndex} 步` : step.source;
          if (step.found && step.excerpt) {
            if (state.excerptMaxChars === 'omit') {
              excerptOmittedChars += step.excerpt.length;
              excerptTrimmedCount++;
              deviceLines.push(`  · ${header} \`${step.commandText}\`（来自 ${step.sessionName}）：已省略原文 ${step.excerpt.length} 字符`);
            } else if (step.excerpt.length > state.excerptMaxChars) {
              const clipped = clipTextHeadTail(step.excerpt, state.excerptMaxChars);
              excerptOmittedChars += step.excerpt.length - clipped.length;
              excerptTrimmedCount++;
              deviceLines.push(`  · ${header} \`${step.commandText}\`（来自 ${step.sessionName}）：`);
              deviceLines.push('```text', clipped, '```');
            } else {
              deviceLines.push(`  · ${header} \`${step.commandText}\`（来自 ${step.sessionName}）：`);
              deviceLines.push('```text', step.excerpt, '```');
            }
          } else {
            deviceLines.push(`  · ${header} \`${step.commandText}\`：${step.missingNotice ?? MISSING_STEP_NOT_FOUND_MSG}`);
          }
        }
        if (excerptOmittedChars > 0) {
          omissions.push(`关键步骤设备逐字摘录（共 ${excerptTrimmedCount} 步，省略 ${excerptOmittedChars} 字符）`);
        }
      }

      if (dev.logExcerpt) {
        if (state.logMode === 'omit') {
          omissions.push(`上一轮 log.txt 摘要（原 ${dev.logExcerpt.length} 字符）`);
        } else if (state.logMode === 'trim' && dev.logExcerpt.length > 1500) {
          const clipped = clipTextTail(dev.logExcerpt, 1500);
          omissions.push(`上一轮 log.txt 摘要（原 ${dev.logExcerpt.length} 字符 -> 保留 ${clipped.length} 字符）`);
          deviceLines.push('- log.txt 摘要：', '```text', clipped, '```');
        } else {
          deviceLines.push('- log.txt 摘要：', '```text', dev.logExcerpt, '```');
        }
      }
      if (dev.inlineTail) {
        if (state.inlineTailMode === 'omit') {
          omissions.push(`设备会话末尾原话摘录（原 ${dev.inlineTail.length} 字符）`);
        } else if (state.inlineTailMode === 'trim' && dev.inlineTail.length > 1200) {
          const clipped = clipTextTail(dev.inlineTail, 1200);
          omissions.push(`设备会话末尾原话摘录（原 ${dev.inlineTail.length} 字符 -> 保留 ${clipped.length} 字符）`);
          deviceLines.push('- 设备会话末尾原话摘录（仅作上下文对照）：', '```text', clipped, '```');
        } else {
          deviceLines.push('- 设备会话末尾原话摘录（仅作上下文对照）：', '```text', dev.inlineTail, '```');
        }
      }
      if (dev.withheldNotes.length > 0) {
        deviceLines.push('- 权限受限或未保存的返回项：');
        for (const w of dev.withheldNotes) deviceLines.push(`  · ${w}`);
      }
    } else if (latest && latest.gateRefusals.length === 0) {
      deviceLines.push('', `### 上一轮（第 ${latest.round} 轮）设备返回`);
      deviceLines.push('- 未传入上一轮设备返还目录（returns），无法展示设备终端输出。');
      deviceLines.push(`- 证据边界：${MISSING_EVIDENCE_CAVEAT}`);
    } else if (!latest) {
      deviceLines.push(`- 证据边界：${MISSING_EVIDENCE_CAVEAT}`);
    }

    const gateLines: string[] = [];
    if (latest && latest.gateRefusals.length > 0) {
      gateLines.push('', `### 上一轮（第 ${latest.round} 轮）Hub 没有受理，原因`);
      const limit = Math.min(state.gateLimit, latest.gateRefusals.length);
      for (const g of latest.gateRefusals.slice(0, limit)) {
        gateLines.push(`- [${g.code}]${g.path ? ` 路径 ${g.path}` : ''}：${g.message}${g.fix ? `；修复要求：${g.fix}` : ''}`);
      }
      if (latest.gateRefusals.length > limit) {
        omissions.push(`上一轮 Hub 没有受理原因（保留前 ${limit} 条，省略 ${latest.gateRefusals.length - limit} 条）`);
      }
    }
    const latestAcceptedNotices = latest?.acceptedNotices ?? [];
    if (latest && latestAcceptedNotices.length > 0) {
      gateLines.push('', `### 上一轮（第 ${latest.round} 轮）Hub 已受理，还缺`);
      const limit = Math.min(state.gateLimit, latestAcceptedNotices.length);
      for (const g of latestAcceptedNotices.slice(0, limit)) {
        gateLines.push(`- [${g.code}]${g.path ? ` 路径 ${g.path}` : ''}：${g.message}${g.fix ? `；待补说明：${g.fix}` : ''}`);
      }
      if (latestAcceptedNotices.length > limit) {
        omissions.push(`上一轮 Hub 已受理待补项（保留前 ${limit} 条，省略 ${latestAcceptedNotices.length - limit} 条）`);
      }
    }

    const attrLines: string[] = [];
    if (latest?.attribution) {
      const attr = latest.attribution;
      const heading = attr.roundRecorded !== false && attr.round !== null
        ? `### 上一轮（第 ${attr.round} 轮）失败分析结论与下一步（confidence: "${attr.confidence}"，未确认假设）`
        : `### 最近一次失败分析（轮次未记录）（confidence: "${attr.confidence}"，未确认假设）`;
      attrLines.push(...renderAttributionLines(attr, heading));
    }
    if (params.unrecordedAttribution) {
      const sameAsLatest =
        latest?.attribution
        && latest.attribution.sourceFile === params.unrecordedAttribution.sourceFile
        && latest.attribution.judged === params.unrecordedAttribution.judged;
      if (!sameAsLatest) {
        attrLines.push(
          ...renderAttributionLines(
            params.unrecordedAttribution,
            `### 最近一次失败分析（轮次未记录）（confidence: "${params.unrecordedAttribution.confidence}"，未确认假设）`,
          ),
        );
      }
    }

    const allLines = [
      ...headerLines,
      ...historyLines,
      ...planLines,
      ...deviceLines,
      ...gateLines,
      ...attrLines,
    ];
    if (omissions.length > 0) {
      allLines.push(
        '',
        `### 历史上下文篇幅控制与省略披露（上限 ${budget} 字符）`,
        '- 触发篇幅上限，已按固定顺序缩减以下低优先级原文（关键报错、机械规则未受理条文与待证失败分析已优先保留）：',
        ...omissions.map((o) => `- 已省略/缩减：${o}`),
      );
    }
    return { text: allLines.join('\n'), omissions };
  };

  const state: RenderState = {
    inlineTailMode: 'full',
    logMode: 'full',
    excerptMaxChars: Number.POSITIVE_INFINITY,
    planMode: 'full',
    keepHistoryFromIndex: 0,
    gateLimit: Number.POSITIVE_INFINITY,
  };

  let rendered = assemble(state);
  if (budget <= 0 || rendered.text.length <= budget) {
    return rendered.text;
  }

  // Fixed omission order (never shuffle):
  // 1. inlineTail (trim -> omit)
  // 2. logExcerpt (trim -> omit)
  // 3. stepExcerpts verbatim bodies (600 -> 240 -> omit)
  // 4. latest.plan body (compact -> omit)
  // 5. older rounds in historyLines (drop oldest rounds while retaining latest)
  // 6. excess gate refusals beyond top 5
  const steps: Array<() => void> = [
    () => { state.inlineTailMode = 'trim'; },
    () => { state.inlineTailMode = 'omit'; },
    () => { state.logMode = 'trim'; },
    () => { state.logMode = 'omit'; },
    () => { state.excerptMaxChars = 600; },
    () => { state.excerptMaxChars = 240; },
    () => { state.excerptMaxChars = 'omit'; },
    () => { state.planMode = 'compact'; },
    () => { state.planMode = 'omit'; },
    ...ordered.slice(0, Math.max(0, ordered.length - 1)).map((_, idx) => () => {
      state.keepHistoryFromIndex = Math.max(state.keepHistoryFromIndex, idx + 1);
    }),
    () => { state.gateLimit = 5; },
    () => { state.gateLimit = 2; },
  ];

  for (const applyStep of steps) {
    applyStep();
    rendered = assemble(state);
    if (rendered.text.length <= budget) return rendered.text;
  }

  // Last-resort hard slice only if caller passed an unusually tiny budget.
  const marker = `\n…（已达篇幅上限 ${budget} 字符，截断 ${Math.max(0, rendered.text.length - budget + 48)} 字符）`;
  const keep = Math.max(0, budget - marker.length);
  return `${rendered.text.slice(0, keep)}${marker}`;
}
