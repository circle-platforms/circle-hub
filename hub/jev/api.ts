// Public surface of hub/jev: the judgment shapes used for knowledge placement (K04). Other packages import only from
// this file. Only yes/no (noul), single choice and score questions exist here (K04 R[0]); the type names were the
// vendor's API discriminators, not a vocabulary axis. The Hub calls no model (owner decision 2026-10-22): the HTTP
// client that talked to the judgment service is removed, and what remains is the scripted judge for tests and the
// pure shapes (validation, batching, judgment records, placement decisions) the Hub will use to verify the bot's
// placement proposals with deterministic rules.

/** JSON data as sent to and returned by the service. */
export type JevJson = null | boolean | number | string | JevJson[] | { [key: string]: JevJson };

/** The content every question of a request refers to; questions point into it with backticked paths. */
export type JevState = string | JevJson[] | { [key: string]: JevJson };

export interface JevNoulQuestion {
  type: 'noul';
  instructions: string;
  /** What counts as yes (true) and as no (false). */
  criteria?: { true?: string | null; false?: string | null } | null;
}

export interface JevChoiceQuestion {
  type: 'choice';
  instructions: string;
  /**
   * 1 to 255 options, each with a description or null, sent in this order. There is no abstain answer: add a 'none'
   * option. Names that are array indices ('0', '12') are refused: an object lists them first, in numeric order.
   */
  criteria: { [option: string]: string | null };
}

export interface JevScoreQuestion {
  type: 'score';
  instructions: string;
  /** 2 to 10 ordered level descriptions; level i means criteria[i]. */
  criteria: string[];
}

export type JevQuestion = JevNoulQuestion | JevChoiceQuestion | JevScoreQuestion;
export type JevQuestionType = JevQuestion['type'];

export interface JevRequest {
  /** Must equal the client's pinned model. */
  model: string;
  state: JevState;
  /** Question id -> question. Ids are 1-128 letters, digits, '_' or '-', and are never shown to the model. */
  questions: { [id: string]: JevQuestion };
}

export interface JevNoulAnswer {
  type: 'noul';
  /** Probability of yes. */
  noul: number;
}

export interface JevChoiceAnswer {
  type: 'choice';
  /** The most probable option. */
  choice: string;
  confidence: number;
  /** Exactly the question's options, in the question's order. */
  probabilities: { [option: string]: number };
}

export interface JevScoreAnswer {
  type: 'score';
  /** Expected level: sum of level * probability. */
  score: number;
  confidence: number;
  /** Level "0".."n-1" -> the level description as the service echoed it. */
  legend: { [level: string]: JevJson };
  /** Level "0".."n-1" -> probability. */
  probabilities: { [level: string]: number };
}

export type JevAnswer = JevNoulAnswer | JevChoiceAnswer | JevScoreAnswer;

export interface JevUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface JevResponse {
  /** The model name exactly as the service returned it. */
  model: string;
  /** One validated answer per question id, in the request's order. */
  answers: { [id: string]: JevAnswer };
  usage: JevUsage;
  /** The request id the service sent back, when it sent one. */
  requestId?: string;
}

export interface JevClient {
  /** The model every request of this client must name. */
  readonly pinnedModel: string;
  ask(request: JevRequest): Promise<JevResponse>;
}

export { JEV_ERROR_CODES, JevError, isJevError, isJevErrorCode } from './errors.ts';
export type { JevErrorCode, JevErrorOptions } from './errors.ts';

export {
  DEFAULT_MAX_REQUEST_BYTES,
  MAX_CHOICE_OPTIONS,
  MAX_JSON_DEPTH,
  MAX_SCORE_LEVELS,
  MIN_SCORE_LEVELS,
  MODEL_ALIASES,
  PROBABILITY_SUM_TOLERANCE,
  QUESTION_ID_PATTERN,
  VENDOR_MAX_REQUEST_BYTES,
  checkQuestion,
  checkRequest,
  checkResponse,
  isQuestionId,
  isVersionedModel,
} from './validate.ts';
export type { CheckedRequest, RequestLimits, ResponseContext } from './validate.ts';

export { SCRIPTED_MODEL, ScriptedJev } from './scripted.ts';
export type { ScriptedAnswer, ScriptedJevOptions, ScriptedSpec } from './scripted.ts';

export { estimateJsonTokens, estimateTokens } from './tokens.ts';

export {
  CONTEXT_TOKENS_PER_QUESTION,
  CONTEXT_TOKENS_PER_REQUEST,
  DEFAULT_CONCURRENCY,
  DEFAULT_MAX_ESTIMATED_TOKENS,
  DEFAULT_MAX_QUESTIONS_PER_REQUEST,
  DEFAULT_MAX_QUESTION_TOKENS,
  QUESTION_OVERHEAD_TOKENS,
  REQUEST_OVERHEAD_TOKENS,
  UNAVAILABLE_STREAK_LIMIT,
  askAll,
  batchRequest,
  planBatches,
} from './batch.ts';
export type { JevAnswered, JevAskAllOptions, JevAskAllResult, JevBatch, JevBatchItem, JevOversized, JevPlan, JevPlanOptions } from './batch.ts';

export { candidatesOf, inputDigest, judgmentRecord, reuseKey } from './record.ts';
export type { JevCandidate, JevJudgmentRecord, JudgmentInput, ReuseKeyInput } from './record.ts';

export { NONE_OPTION, shouldDescend, topChoice } from './decide.ts';
export type { DecideOptions, TopChoice } from './decide.ts';
