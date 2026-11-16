// What the Plumb gateway enforces on one `/v1/judge` request, and how to price and split a batch to stay inside it.
// The gateway publishes none of this: `/v1/models`, `/v1/status` and `/healthz` carry no limit, and a refusal states only
// the number that was left ("(24) exceed limit (16)" is the budget remaining after earlier questions of the same request, not
// a limit). So the numbers are pinned here, and gateway-limits.test.ts checks each of them against the gateway source and
// fails when the source says otherwise. Sources: plumb_api/config.py (GatewayConfig), plumb_api/judge_logic.py (execute_judge,
// _compile_and_run_single_judge), jev_cli/plumb_tasks.py (token budgets).
import { formatPlumbCallError, type PlumbBatchQuestion } from './types.ts';

export interface PlumbGatewayLimits {
  /** `max_questions`: questions in one request (`execute_judge`: "At most N questions per batch"). */
  readonly maxQuestions: number;
  /** `max_score_pairs`: judge pairs one request may expand to, summed over its questions in order (`remaining_pairs`). */
  readonly maxPairs: number;
  /** `max_body_bytes`: bytes of the request body. */
  readonly maxBodyBytes: number;
  /** `DEFAULT_STATE_EST_TOKEN_BUDGET`: estimated tokens of a state the gateway keeps for a non-fidelity task; beyond it the middle is cut. */
  readonly stateEstTokens: number;
  /** `DEFAULT_FIDELITY_STATE_EST_TOKEN_BUDGET`: the same for a `sequence` state, which is refused with 413 instead of being cut inside its command block. */
  readonly fidelityStateEstTokens: number;
  /** `max_concurrent_requests_per_key`: requests of one key in flight at once; a further one is answered 429. */
  readonly maxConcurrentPerKey: number;
}

export const PLUMB_GATEWAY_LIMITS: PlumbGatewayLimits = Object.freeze({
  maxQuestions: 32,
  maxPairs: 256,
  maxBodyBytes: 1_048_576,
  stateEstTokens: 1_400,
  fidelityStateEstTokens: 2_400,
  maxConcurrentPerKey: 2,
});

/** `CANONICAL_FAMILY_MAP` of judge_logic.py: the family a task name belongs to, which decides what a question costs. */
export const PLUMB_TASK_FAMILIES: Readonly<Record<string, string>> = Object.freeze({
  match: 'match',
  single_cmd_judge: 'match',
  steplist_judge: 'match',
  choice: 'choice',
  cmd_select: 'choice',
  manual_choice: 'choice',
  sequence: 'sequence',
  scenario_fidelity: 'sequence',
  placement: 'placement',
  rerank: 'rerank',
  expectation: 'expectation',
  criterion_coverage: 'criterion_coverage',
});

/** Families the gateway prices at one pair (`_compile_and_run_single_judge`: `pair_count=1`). */
const ONE_PAIR_FAMILIES: ReadonlySet<string> = new Set(['match', 'rerank', 'criterion_coverage']);

/** Options a question gets from the gateway when it lists none: `FIDELITY_SHORT_CRITERIA` and `EXPECTATION_FIXED_ORDER`. */
export const PLUMB_DEFAULT_OPTION_COUNTS: Readonly<{ sequence: number; expectation: number }> = Object.freeze({ sequence: 3, expectation: 3 });

function listedOptions(question: PlumbBatchQuestion): number {
  // The gateway reads `candidates`, and `criteria` only when there is no `candidates` (`_extract_candidates`).
  const raw = question.candidates ?? question.criteria;
  if (Array.isArray(raw)) return raw.length;
  if (typeof raw === 'object' && raw !== null) return Object.keys(raw).length;
  return 0;
}

/**
 * The judge pairs one question counts against the request budget. An upper bound of what the gateway charges: a match question
 * is one pair; a choice, sequence, placement or expectation question is one pair per option it lists. The gateway does not
 * charge the none option of a choice on a model with a none threshold, and charges a placement of over 25 options by groups,
 * both less than this count, so a batch that fits by this count fits at the gateway.
 */
export function estimateExpandedPairs(question: PlumbBatchQuestion, fallbackTask?: string): number {
  const task = (question.task ?? fallbackTask ?? '').trim().toLowerCase();
  const family = Object.hasOwn(PLUMB_TASK_FAMILIES, task) ? PLUMB_TASK_FAMILIES[task]! : '';
  if (ONE_PAIR_FAMILIES.has(family)) return 1;
  const listed = listedOptions(question);
  if (listed > 0) return listed;
  if (family === 'sequence') return PLUMB_DEFAULT_OPTION_COUNTS.sequence;
  if (family === 'expectation') return PLUMB_DEFAULT_OPTION_COUNTS.expectation;
  return 1;
}

const bytesOf = (text: string): number => Buffer.byteLength(text, 'utf8');
const entryBytes = (qid: string, question: PlumbBatchQuestion): number => bytesOf(JSON.stringify(qid)) + 1 + bytesOf(JSON.stringify(question));

/** The bytes of the request body for `frame` (model, task, state: everything but the questions) and these questions, as `JSON.stringify` sends them. */
export function requestBodyBytes(frame: Readonly<Record<string, unknown>>, entries: ReadonlyArray<readonly [string, PlumbBatchQuestion]>): number {
  let bytes = bytesOf(JSON.stringify({ ...frame, questions: {} }));
  entries.forEach(([qid, question], i) => {
    bytes += entryBytes(qid, question) + (i > 0 ? 1 : 0);
  });
  return bytes;
}

export interface PlumbBatchPlanOptions {
  /** Everything a request carries besides its questions (model, task, shared state): it is sent with every request. */
  frame: Readonly<Record<string, unknown>>;
  /** The task of the batch, for a question that names none. */
  fallbackTask?: string;
  /** At most this many questions in a request (never above the gateway's). */
  maxQuestions?: number;
  /** Limits other than the pinned ones, for a client configured with a smaller body limit. */
  limits?: Partial<PlumbGatewayLimits>;
}

/**
 * Splits questions, in order, into the fewest consecutive requests that each stay inside the gateway's three request limits:
 * the number of questions, the pairs they expand to together, and the bytes of the body. Throws, before anything is sent, when
 * one question alone cannot fit a request.
 */
export function planPlumbBatches(
  entries: ReadonlyArray<readonly [string, PlumbBatchQuestion]>,
  options: PlumbBatchPlanOptions,
): Array<Array<[string, PlumbBatchQuestion]>> {
  const limits = { ...PLUMB_GATEWAY_LIMITS, ...options.limits };
  const maxQuestions = Math.max(1, Math.min(limits.maxQuestions, options.maxQuestions ?? limits.maxQuestions));
  const frameBytes = bytesOf(JSON.stringify({ ...options.frame, questions: {} }));
  const chunks: Array<Array<[string, PlumbBatchQuestion]>> = [];
  let chunk: Array<[string, PlumbBatchQuestion]> = [];
  let pairs = 0;
  let bytes = frameBytes;
  for (const [qid, question] of entries) {
    const cost = estimateExpandedPairs(question, options.fallbackTask);
    const own = entryBytes(qid, question);
    if (cost > limits.maxPairs) {
      throw new Error(formatPlumbCallError('参数无效', `题目 ${qid} 估算展开 ${cost} 个打分对，超过单次请求上限 ${limits.maxPairs} 个`, '请减少这道题的候选数后重试'));
    }
    if (frameBytes + own > limits.maxBodyBytes) {
      throw new Error(formatPlumbCallError('参数无效', `题目 ${qid} 连同请求框架共 ${frameBytes + own} 字节，超过单次请求上限 ${limits.maxBodyBytes} 字节`, '请缩短这道题的上下文后重试'));
    }
    const next = bytes + (chunk.length > 0 ? 1 : 0) + own;
    if (chunk.length > 0 && (chunk.length >= maxQuestions || pairs + cost > limits.maxPairs || next > limits.maxBodyBytes)) {
      chunks.push(chunk);
      chunk = [];
      pairs = 0;
      bytes = frameBytes;
    }
    bytes += (chunk.length > 0 ? 1 : 0) + own;
    pairs += cost;
    chunk.push([qid, question]);
  }
  if (chunk.length > 0) chunks.push(chunk);
  return chunks;
}

/** The three request limits as one sentence, for the next step of a refusal. */
export function describePlumbRequestLimits(limits: Pick<PlumbGatewayLimits, 'maxQuestions' | 'maxPairs' | 'maxBodyBytes'> = PLUMB_GATEWAY_LIMITS): string {
  const mib = limits.maxBodyBytes / 1_048_576;
  const body = Number.isInteger(mib) ? `${mib} MiB` : `${limits.maxBodyBytes} 字节`;
  return `单次请求不超过 ${limits.maxQuestions} 题、展开后不超过 ${limits.maxPairs} 个打分对（选择题每个候选算一个）、请求体不超过 ${body}`;
}
