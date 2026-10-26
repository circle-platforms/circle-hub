// Batching of independent questions about different pieces of one state. Item i's piece is sent as state[i.id] (beside
// any shared context), so its instructions refer to it as `<id>` in backticks. planBatches keeps every request under the
// service's context limits by a conservative estimate; askAll sends the batches with bounded concurrency, splits a
// failed batch in half once when its content can be the cause, and stops the plan when the cause is plan-wide.
import type { JevAnswer, JevClient, JevJson, JevQuestion, JevRequest, JevResponse } from './api.ts';
import { JevError } from './errors.ts';
import { estimateTokens } from './tokens.ts';
import { checkQuestion, isPlainObject, isQuestionId, jsonProblem } from './validate.ts';

/** The service's context limits: state plus all questions per request, state plus one question per question. */
export const CONTEXT_TOKENS_PER_REQUEST = 64_000;
export const CONTEXT_TOKENS_PER_QUESTION = 32_000;
export const DEFAULT_MAX_QUESTIONS_PER_REQUEST = 10;
/** Defaults keep a quarter of each limit in reserve for the estimate's error and the service's own framing. */
export const DEFAULT_MAX_ESTIMATED_TOKENS = 48_000;
export const DEFAULT_MAX_QUESTION_TOKENS = 24_000;
export const DEFAULT_CONCURRENCY = 2;
/** Fixed allowances for the request envelope and for each question's framing. */
export const REQUEST_OVERHEAD_TOKENS = 256;
export const QUESTION_OVERHEAD_TOKENS = 32;
/** askAll stops the plan after this many requests in a row end JEV_UNAVAILABLE: a batch and both its halves. */
export const UNAVAILABLE_STREAK_LIMIT = 3;

export interface JevBatchItem {
  /** Question id, and the state key its piece is sent under. */
  id: string;
  /** The part of the state this question is about. */
  piece: JevJson;
  question: JevQuestion;
}

export interface JevPlanOptions {
  /** Default 10. */
  maxQuestionsPerRequest?: number;
  /** Estimated tokens of a whole request (state plus all questions); default 48000, at most 64000. */
  maxEstimatedTokens?: number;
  /** Estimated tokens of the state plus any one question; default 24000, at most 32000. */
  maxQuestionTokens?: number;
  /** Context sent in every request's state beside the pieces; its keys must differ from every item id. */
  shared?: { [key: string]: JevJson };
}

export interface JevBatch {
  items: JevBatchItem[];
  estimatedTokens: number;
  /** The largest estimate of the state plus one question in this batch. */
  estimatedQuestionTokens: number;
}

export interface JevOversized {
  item: JevBatchItem;
  estimatedTokens: number;
}

export interface JevPlan {
  shared: { [key: string]: JevJson };
  batches: JevBatch[];
  /** Items that do not fit even alone; they are never sent. */
  oversized: JevOversized[];
  limits: { maxQuestionsPerRequest: number; maxEstimatedTokens: number; maxQuestionTokens: number };
}

export interface JevAskAllOptions {
  /** Requests in flight at once; default 2. */
  concurrency?: number;
}

export interface JevAnswered {
  answer: JevAnswer;
  /** The request and response the answer came from, for the judgment record. */
  request: JevRequest;
  response: JevResponse;
}

export interface JevAskAllResult {
  /** Answers by question id, in plan order. */
  answered: Map<string, JevAnswered>;
  /** Unanswered question ids with the error of their last attempt. */
  failed: Map<string, JevError>;
  /** Requests handed to the client, including split retries. */
  requestsSent: number;
}

function limit(value: unknown, fallback: number, min: number, max: number, name: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} 必须是 ${min} 到 ${max} 之间的整数`);
  }
  return value;
}

interface OpenBatch {
  items: JevBatchItem[];
  state: number;
  questions: number;
  largest: number;
}

function closed(open: OpenBatch): JevBatch {
  return { items: open.items, estimatedTokens: open.state + open.questions, estimatedQuestionTokens: open.state + open.largest };
}

/**
 * Packs items, in their order, into requests: a request takes items while it stays within the question count, the
 * per-request estimate and the per-question estimate. Ids must be unique; questions are validated and normalized.
 */
export function planBatches(items: readonly JevBatchItem[], options: JevPlanOptions = {}): JevPlan {
  if (!Array.isArray(items)) throw new TypeError('items 必须是数组');
  const maxQuestionsPerRequest = limit(options.maxQuestionsPerRequest, DEFAULT_MAX_QUESTIONS_PER_REQUEST, 1, 10_000, 'maxQuestionsPerRequest');
  const maxEstimatedTokens = limit(options.maxEstimatedTokens, DEFAULT_MAX_ESTIMATED_TOKENS, 1, CONTEXT_TOKENS_PER_REQUEST, 'maxEstimatedTokens');
  const maxQuestionTokens = limit(options.maxQuestionTokens, DEFAULT_MAX_QUESTION_TOKENS, 1, CONTEXT_TOKENS_PER_QUESTION, 'maxQuestionTokens');
  const shared = options.shared ?? {};
  if (!isPlainObject(shared)) throw new TypeError('shared 必须是普通对象');
  if (Object.hasOwn(shared, '__proto__')) throw new TypeError('shared 不能有 __proto__ 键');
  const sharedProblem = jsonProblem(shared, 2);
  if (sharedProblem !== null) throw new JevError('JEV_BAD_REQUEST', `Jev 请求不合格：shared ${sharedProblem}`);
  const base = estimateTokens(JSON.stringify(shared)) + REQUEST_OVERHEAD_TOKENS;
  const alone = Math.min(maxEstimatedTokens, maxQuestionTokens);
  const seen = new Set<string>();
  const batches: JevBatch[] = [];
  const oversized: JevOversized[] = [];
  let open: OpenBatch | null = null;
  for (const raw of items) {
    if (!isPlainObject(raw)) throw new TypeError('每个条目必须是 {id, piece, question} 对象');
    const id = raw.id;
    if (!isQuestionId(id)) throw new TypeError('条目标识只能用 1 到 128 个字母、数字、下划线或连字符');
    if (seen.has(id)) throw new TypeError(`条目标识 ${id} 重复`);
    if (Object.hasOwn(shared, id)) throw new TypeError(`条目标识 ${id} 与 shared 的键重名`);
    seen.add(id);
    const question = checkQuestion(id, raw.question);
    const piece = raw.piece;
    const problem = piece === undefined ? '缺失' : jsonProblem(piece, 3);
    if (problem !== null) throw new JevError('JEV_BAD_REQUEST', `Jev 请求不合格：条目 ${id} 的 piece ${problem}`, { questionId: id });
    const item: JevBatchItem = { id, piece: piece as JevJson, question };
    const pieceTokens = estimateTokens(`${JSON.stringify(id)}:${JSON.stringify(piece)},`);
    const questionTokens = estimateTokens(`${JSON.stringify(id)}:${JSON.stringify(question)},`) + QUESTION_OVERHEAD_TOKENS;
    if (base + pieceTokens + questionTokens > alone) {
      oversized.push({ item, estimatedTokens: base + pieceTokens + questionTokens });
      continue;
    }
    if (open !== null) {
      const state = open.state + pieceTokens;
      const fits =
        open.items.length < maxQuestionsPerRequest &&
        state + open.questions + questionTokens <= maxEstimatedTokens &&
        state + Math.max(open.largest, questionTokens) <= maxQuestionTokens;
      if (fits) {
        open.items.push(item);
        open.state = state;
        open.questions += questionTokens;
        open.largest = Math.max(open.largest, questionTokens);
        continue;
      }
      batches.push(closed(open));
    }
    open = { items: [item], state: base + pieceTokens, questions: questionTokens, largest: questionTokens };
  }
  if (open !== null) batches.push(closed(open));
  return { shared, batches, oversized, limits: { maxQuestionsPerRequest, maxEstimatedTokens, maxQuestionTokens } };
}

/** The request for some items of a plan: shared context plus each item's piece under its id. */
export function batchRequest(model: string, plan: Pick<JevPlan, 'shared'>, items: readonly JevBatchItem[]): JevRequest {
  const state: { [key: string]: JevJson } = {};
  for (const [key, value] of Object.entries(plan.shared)) state[key] = value;
  const questions: { [id: string]: JevQuestion } = {};
  for (const item of items) {
    state[item.id] = item.piece;
    questions[item.id] = item.question;
  }
  return { model, state, questions };
}

type Outcome =
  | { items: readonly JevBatchItem[]; request: JevRequest; response: JevResponse; error: null }
  | { items: readonly JevBatchItem[]; error: JevError };

// True when a failure comes from the key, the account, the quota, the endpoint or the pinned model rather than from the
// batch's content: splitting cannot help, and every later request would fail the same way. The client has already
// retried what retrying can fix.
function planWide(error: JevError): boolean {
  switch (error.code) {
    case 'JEV_UNAUTHORIZED':
    case 'JEV_RATE_LIMITED':
      // Halves would also go out right after the service asked for a pause.
      return true;
    case 'JEV_BAD_RESPONSE':
      // One malformed answer is isolated in its half; a response unusable as a whole (another model, the key echoed, a
      // malformed body) would come back for every request, and each one is billed.
      return error.questionId === null;
    case 'JEV_BAD_REQUEST':
      // A refused body (400, 422) or a local refusal may come from one question; another 4xx is the endpoint or the account.
      return error.status !== null && error.status !== 400 && error.status !== 422;
    case 'JEV_UNAVAILABLE':
      // A redirect (never followed) is the endpoint. An outage and one request the service cannot finish look alike;
      // the halves and the streak tell them apart.
      return error.status !== null && error.status >= 300 && error.status < 400;
    case 'JEV_TOO_LARGE':
      return false;
  }
}

/**
 * Sends every batch of the plan. A failed batch of two or more items is retried once as two halves (not further) when
 * its content can be the cause: JEV_TOO_LARGE, a JEV_BAD_RESPONSE naming a question, a refused body (JEV_BAD_REQUEST
 * from a 400, a 422 or local validation) and JEV_UNAVAILABLE. A plan-wide cause stops the plan: no split, no batch
 * started after it (JEV_UNAUTHORIZED, JEV_RATE_LIMITED, a JEV_BAD_RESPONSE naming no question, another 4xx, a redirect,
 * and UNAVAILABLE_STREAK_LIMIT requests in a row ending JEV_UNAVAILABLE). Items never sent fail with the stop's code
 * and attempts 0. Errors that are not JevError propagate.
 */
export async function askAll(client: JevClient, plan: JevPlan, options: JevAskAllOptions = {}): Promise<JevAskAllResult> {
  const concurrency = limit(options.concurrency, DEFAULT_CONCURRENCY, 1, 64, 'concurrency');
  const outcomes: Array<Outcome[] | undefined> = new Array(plan.batches.length);
  const run = {
    next: 0,
    sent: 0,
    // Requests in a row that ended JEV_UNAVAILABLE.
    unavailable: 0,
    // Set once the plan stops: the error of every item not sent after that.
    stopped: null as JevError | null,
    crashed: false,
    crash: undefined as unknown,
  };

  const stop = (error: JevError): void => {
    run.stopped ??= new JevError(error.code, `计划已停止，这一批没有发出（${error.message}）`);
  };

  const send = async (items: readonly JevBatchItem[]): Promise<Outcome> => {
    const request = batchRequest(client.pinnedModel, plan, items);
    run.sent++;
    try {
      const response = await client.ask(request);
      run.unavailable = 0;
      return { items, request, response, error: null };
    } catch (error) {
      if (!(error instanceof JevError)) throw error;
      run.unavailable = error.code === 'JEV_UNAVAILABLE' ? run.unavailable + 1 : 0;
      if (planWide(error) || run.unavailable >= UNAVAILABLE_STREAK_LIMIT) stop(error);
      return { items, error };
    }
  };

  // A plan-wide failure has stopped the plan in send(), so only a failure the content can cause is split.
  const attempt = async (items: readonly JevBatchItem[]): Promise<Outcome[]> => {
    const first = await send(items);
    if (first.error === null || run.stopped !== null || items.length < 2) return [first];
    const middle = Math.ceil(items.length / 2);
    const results: Outcome[] = [];
    for (const half of [items.slice(0, middle), items.slice(middle)]) {
      results.push(run.stopped !== null ? { items: half, error: run.stopped } : await send(half));
    }
    return results;
  };

  const worker = async (): Promise<void> => {
    while (run.stopped === null && !run.crashed) {
      const index = run.next++;
      const batch = plan.batches[index];
      if (batch === undefined) return;
      try {
        outcomes[index] = await attempt(batch.items);
      } catch (error) {
        run.crashed = true;
        run.crash = error;
        return;
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, plan.batches.length) }, () => worker()));
  if (run.crashed) throw run.crash;

  const answered = new Map<string, JevAnswered>();
  const failed = new Map<string, JevError>();
  plan.batches.forEach((batch, index) => {
    const results = outcomes[index];
    if (results === undefined) {
      const reason = run.stopped ?? new JevError('JEV_UNAVAILABLE', 'Jev 批次没有发出');
      for (const item of batch.items) failed.set(item.id, reason);
      return;
    }
    for (const outcome of results) {
      for (const item of outcome.items) {
        if (outcome.error === null) {
          answered.set(item.id, { answer: outcome.response.answers[item.id] as JevAnswer, request: outcome.request, response: outcome.response });
        } else {
          failed.set(item.id, outcome.error);
        }
      }
    }
  });
  for (const { item, estimatedTokens } of plan.oversized) {
    failed.set(
      item.id,
      new JevError('JEV_TOO_LARGE', `Jev 条目 ${item.id} 估算约 ${estimatedTokens} 个令牌，单独成请求也超过上限，没有发送`, { questionId: item.id }),
    );
  }
  return { answered, failed, requestsSent: run.sent };
}
