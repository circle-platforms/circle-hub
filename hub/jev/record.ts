// Judgment records (K04 R[2]): every judgment keeps the exact model version, the question, the candidates, the input
// digest and the probabilities. The record is plain snake_case JSON for the knowledge package to store. Every question
// of a request is judged against the whole state (the vendor: all questions see the same state), so the record also
// keeps the digest of that state, and the reuse key rests on it: a judgment is reused only while what the model saw is
// unchanged (K04 R[2], C08 R[4]).
import type { JevAnswer, JevQuestion, JevQuestionType, JevRequest, JevResponse } from './api.ts';
import { canonicalize, sha256Hex } from '../records/api.ts';
import { checkQuestion, isVersionedModel } from './validate.ts';

const SHA256 = /^[0-9a-f]{64}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const REUSE_FORMAT = 'jev-reuse@2';

export interface JevCandidate {
  /** Option name; 'true'/'false' for a yes/no question; the level "0".."n-1" for a score question. */
  name: string;
  description: string | null;
}

export interface JevJudgmentRecord {
  requested_model: string;
  /** The model name the service returned. */
  returned_model: string;
  /** The returned model when it is a versioned id; null means the exact version is unknown (an alias came back). */
  exact_model: string | null;
  request_id: string | null;
  question_id: string;
  question_type: JevQuestionType;
  /** The question text as sent. */
  instructions: string;
  /** The candidates in the order sent; the service favours earlier options, so order is part of the question. */
  candidates: JevCandidate[];
  /** SHA-256 of the RFC 8785 canonical JSON of the input the caller names: the piece the question is about. */
  input_digest: string;
  /** SHA-256 of the RFC 8785 canonical JSON of the whole state the model saw: the pieces of the request and its shared context. */
  state_digest: string;
  /** Probability per candidate name; for a yes/no answer false is 1 - noul. */
  probabilities: { [name: string]: number };
  /** The validated answer as the service returned it. */
  answer: JevAnswer;
  /** Usage of the whole request, which may hold several questions. */
  usage: { input_tokens: number; output_tokens: number };
  /** Supplied by the caller (ISO 8601 UTC). */
  judged_at: string;
  /** Null when the judgment must not be reused (not an exact model). */
  reuse_key: string | null;
}

export interface JudgmentInput {
  request: JevRequest;
  response: JevResponse;
  questionId: string;
  /** The piece the question is about, as the caller identifies it (recorded as input_digest; the state is recorded too). */
  input: unknown;
  /** Timestamp of the judgment, ISO 8601 UTC ending in Z. */
  at: string;
}

export interface ReuseKeyInput {
  /** The requested (pinned) model. */
  model: string;
  question: JevQuestion;
  /** inputDigest(request.state): the digest of the whole state the question is (or was) judged against. */
  stateDigest: string;
}

/** SHA-256 of the RFC 8785 canonical JSON of a value. */
export function inputDigest(input: unknown): string {
  let text: string;
  try {
    text = canonicalize(input);
  } catch {
    throw new TypeError('输入不是可以规范化的 JSON 数据（RFC 8785）');
  }
  return sha256Hex(text);
}

/** The candidates of a question in the order they are sent. */
export function candidatesOf(question: JevQuestion): JevCandidate[] {
  if (question.type === 'noul') {
    return [
      { name: 'true', description: question.criteria?.true ?? null },
      { name: 'false', description: question.criteria?.false ?? null },
    ];
  }
  if (question.type === 'choice') {
    return Object.keys(question.criteria).map((name) => ({ name, description: question.criteria[name] ?? null }));
  }
  return question.criteria.map((description, level) => ({ name: String(level), description }));
}

/**
 * Key under which a judgment may be reused: the exact model, the question type and text, the ordered candidates and
 * the digest of the whole state (not the question id, which the model never sees). Null for a model that is not a
 * versioned id, whose judgments are never reused. It can be computed before asking, from batchRequest's state.
 */
export function reuseKey(input: ReuseKeyInput): string | null {
  if (!isVersionedModel(input.model)) return null;
  if (typeof input.stateDigest !== 'string' || !SHA256.test(input.stateDigest)) {
    throw new TypeError('stateDigest 必须是 64 位小写十六进制的 SHA-256');
  }
  const question = checkQuestion('reuse', input.question);
  return sha256Hex(
    canonicalize({
      format: REUSE_FORMAT,
      model: input.model,
      type: question.type,
      instructions: question.instructions,
      candidates: candidatesOf(question).map((candidate) => [candidate.name, candidate.description]),
      state_digest: input.stateDigest,
    }),
  );
}

function probabilitiesOf(answer: JevAnswer, candidates: readonly JevCandidate[]): { [name: string]: number } {
  if (answer.type === 'noul') return { true: answer.noul, false: 1 - answer.noul };
  const out: { [name: string]: number } = {};
  for (const candidate of candidates) {
    const p = answer.probabilities[candidate.name];
    if (typeof p !== 'number') throw new TypeError(`回答缺少候选 ${JSON.stringify(candidate.name)} 的概率`);
    out[candidate.name] = p;
  }
  return out;
}

/** The record of one judgment: one question of one validated response. */
export function judgmentRecord(input: JudgmentInput): JevJudgmentRecord {
  const { request, response, questionId, at } = input;
  if (!Object.hasOwn(request.questions, questionId)) throw new TypeError(`请求里没有问题 ${questionId}`);
  if (!Object.hasOwn(response.answers, questionId)) throw new TypeError(`响应里没有问题 ${questionId} 的回答`);
  const question = request.questions[questionId] as JevQuestion;
  const answer = response.answers[questionId] as JevAnswer;
  if (answer.type !== question.type) throw new TypeError(`问题 ${questionId} 的回答类型与问题不一致`);
  if (typeof at !== 'string' || !ISO_UTC.test(at) || Number.isNaN(Date.parse(at))) {
    throw new RangeError('at 必须是以 Z 结尾的 ISO 8601 UTC 时间');
  }
  const candidates = candidatesOf(question);
  const stateDigest = inputDigest(request.state);
  const exact = isVersionedModel(response.model) ? response.model : null;
  return {
    requested_model: request.model,
    returned_model: response.model,
    exact_model: exact,
    request_id: response.requestId ?? null,
    question_id: questionId,
    question_type: question.type,
    instructions: question.instructions,
    candidates,
    input_digest: inputDigest(input.input),
    state_digest: stateDigest,
    probabilities: probabilitiesOf(answer, candidates),
    answer: structuredClone(answer),
    usage: { input_tokens: response.usage.inputTokens, output_tokens: response.usage.outputTokens },
    judged_at: at,
    reuse_key: exact !== null && exact === request.model ? reuseKey({ model: request.model, question, stateDigest }) : null,
  };
}
