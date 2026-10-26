// Client-side adaptation of the repository pure judgment rules; never imported by Hub runtime.
// Local validation shared by every Jev client: a request is checked before it is sent and a response before it is used,
// so every client accepts and refuses exactly the same things. Messages name question ids, positions and counts,
// never state content, option names or anything the service sent back.
import type { JevAnswer, JevJson, JevNoulQuestion, JevQuestion, JevRequest, JevResponse, JevState } from './api.ts';
import { JevError } from './errors.ts';

/** Moving aliases named by the vendor; any model id that is not versioned is treated the same way. */
export const MODEL_ALIASES: readonly string[] = Object.freeze(['jev-latest', 'jev-preview']);
export const MAX_CHOICE_OPTIONS = 255;
export const MIN_SCORE_LEVELS = 2;
export const MAX_SCORE_LEVELS = 10;
/** Nesting limit of the whole request body; the body object itself is level 1. */
export const MAX_JSON_DEPTH = 64;
export const VENDOR_MAX_REQUEST_BYTES = 32 * 1024 * 1024;
export const DEFAULT_MAX_REQUEST_BYTES = 16 * 1024 * 1024;
export const PROBABILITY_SUM_TOLERANCE = 1e-3;
export const QUESTION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

const VERSIONED_MODEL = /^[a-z][a-z0-9]*(?:-[a-z][a-z0-9]*)*-(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/;
const MODEL_NAME = /^[\x21-\x7e]{1,128}$/;
// An array index: JavaScript objects list such keys first, in numeric order, whatever order they were written in.
const ARRAY_INDEX = /^(?:0|[1-9][0-9]{0,9})$/;
const MAX_ARRAY_INDEX = 2 ** 32 - 2;
// A choice the service reports must be a most probable option; this absorbs float noise only.
const ARGMAX_EPSILON = 1e-9;
// score must equal sum(level * p) within this much per level (rounding of the returned probabilities).
const SCORE_TOLERANCE_PER_LEVEL = 0.01;
const REQUEST_FIELDS = new Set(['model', 'state', 'questions']);
const QUESTION_FIELDS = new Set(['type', 'instructions', 'criteria']);

export interface RequestLimits {
  pinnedModel: string;
  maxRequestBytes: number;
}

export interface CheckedRequest {
  /** Normalized copy of the request (state by reference): only known fields, criteria in the order sent. */
  request: JevRequest;
  /** The exact UTF-8 JSON text to send. */
  body: string;
  bytes: number;
}

export interface ResponseContext {
  pinnedModel: string;
  requestId?: string | null;
  attempts?: number;
  status?: number | null;
}

/** True for a pinned version id such as jev-1.13.0; false for aliases such as jev-latest. */
export function isVersionedModel(model: unknown): model is string {
  return typeof model === 'string' && VERSIONED_MODEL.test(model);
}

export function isQuestionId(id: unknown): id is string {
  return typeof id === 'string' && QUESTION_ID_PATTERN.test(id) && id !== '__proto__';
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** The constructor check of every client: a judgment must record an exact version, so aliases need allowAlias. */
export function checkModel(model: unknown, allowAlias: boolean): string {
  if (typeof model !== 'string' || !MODEL_NAME.test(model)) throw new TypeError('model 必须是模型名，例如 jev-1.13.0');
  if (!allowAlias && !isVersionedModel(model)) {
    throw new JevError(
      'JEV_BAD_REQUEST',
      `模型 ${model} 不是确切版本（${MODEL_ALIASES.join('、')} 这类别名会随新版本移动）；判断必须记录确切版本，请改用带版本号的模型，例如 jev-1.13.0`,
    );
  }
  return model;
}

function badRequest(message: string): never {
  throw new JevError('JEV_BAD_REQUEST', `Jev 请求不合格：${message}`);
}

function badResponse(context: ResponseContext, message: string, questionId: string | null = null): never {
  throw new JevError('JEV_BAD_RESPONSE', `Jev 响应不合格：${message}`, {
    status: context.status ?? null,
    requestId: context.requestId ?? null,
    attempts: context.attempts ?? 1,
    questionId,
  });
}

function shortText(value: string): string {
  return JSON.stringify(value.length > 40 ? `${value.slice(0, 40)}…` : value);
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '' && value.isWellFormed();
}

function isArrayIndex(name: string): boolean {
  return ARRAY_INDEX.test(name) && Number(name) <= MAX_ARRAY_INDEX;
}

/** The first reason `value` is not plain JSON data within the depth limit, or null. `depth` is its level in the body. */
export function jsonProblem(value: unknown, depth: number): string | null {
  if (value === null || typeof value === 'boolean') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? null : '有非有限数字（NaN 或无穷大）';
  if (typeof value === 'string') return value.isWellFormed() ? null : '有不成对的代理字符，不能编码为 UTF-8';
  if (typeof value !== 'object') return `有不是 JSON 数据的值（${typeof value}）`;
  if (depth > MAX_JSON_DEPTH) return `嵌套超过 ${MAX_JSON_DEPTH} 层`;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      if (!(index in value) || value[index] === undefined) return '有空位或 undefined 的数组元素';
      const problem = jsonProblem(value[index], depth + 1);
      if (problem !== null) return problem;
    }
    return null;
  }
  if (!isPlainObject(value)) return '有不是普通对象的值（例如 Date、Map 或类的实例）';
  for (const key of Object.keys(value)) {
    if (!key.isWellFormed()) return '有含不成对代理字符的键';
    const member = value[key];
    if (member === undefined) continue; // dropped by JSON, as in canonical JSON
    const problem = jsonProblem(member, depth + 1);
    if (problem !== null) return problem;
  }
  return null;
}

/** Validates one question and returns a normalized copy (known fields only). */
export function checkQuestion(id: string, raw: unknown): JevQuestion {
  const where = `问题 ${id} `;
  if (!isPlainObject(raw)) badRequest(`${where}必须是对象`);
  for (const key of Object.keys(raw)) {
    if (!QUESTION_FIELDS.has(key) && raw[key] !== undefined) badRequest(`${where}有不认识的字段 ${shortText(key)}`);
  }
  const instructions = raw.instructions;
  if (!isText(instructions)) badRequest(`${where}的 instructions 必须是非空字符串`);
  const criteria = raw.criteria;
  switch (raw.type) {
    case 'noul': {
      const question: JevNoulQuestion = { type: 'noul', instructions };
      if (criteria === undefined || criteria === null) return question;
      if (!isPlainObject(criteria)) badRequest(`${where}的 criteria 必须是 {true, false} 对象`);
      const out: { true?: string | null; false?: string | null } = {};
      for (const key of Object.keys(criteria)) {
        const description = criteria[key];
        if (description === undefined) continue;
        if (key !== 'true' && key !== 'false') badRequest(`${where}的 criteria 只能有 true 和 false`);
        if (description !== null && (typeof description !== 'string' || !description.isWellFormed())) {
          badRequest(`${where}的 criteria.${key} 必须是字符串或 null`);
        }
        out[key] = description;
      }
      question.criteria = out;
      return question;
    }
    case 'choice': {
      if (!isPlainObject(criteria)) badRequest(`${where}的 criteria 必须是“选项 → 说明”对象`);
      const options = Object.keys(criteria);
      if (options.length < 1 || options.length > MAX_CHOICE_OPTIONS) {
        badRequest(`${where}有 ${options.length} 个选项，必须是 1 到 ${MAX_CHOICE_OPTIONS} 个（选项多时先按字面缩小）`);
      }
      const out: { [option: string]: string | null } = {};
      for (let index = 0; index < options.length; index++) {
        const option = options[index] as string;
        if (option === '__proto__' || !isText(option)) badRequest(`${where}的第 ${index + 1} 个选项名不合格`);
        // The option order is part of the question (the model favours earlier options) and must stay as written.
        if (isArrayIndex(option)) {
          badRequest(`${where}的第 ${index + 1} 个选项名是纯数字：对象会把这类键提到最前并按数值排序，打乱选项顺序；请加前缀，例如 n12`);
        }
        const description = criteria[option];
        if (description !== null && (typeof description !== 'string' || !description.isWellFormed())) {
          badRequest(`${where}的第 ${index + 1} 个选项的说明必须是字符串或 null`);
        }
        out[option] = description;
      }
      return { type: 'choice', instructions, criteria: out };
    }
    case 'score': {
      if (!Array.isArray(criteria)) badRequest(`${where}的 criteria 必须是按顺序排列的等级说明数组`);
      if (criteria.length < MIN_SCORE_LEVELS || criteria.length > MAX_SCORE_LEVELS) {
        badRequest(`${where}有 ${criteria.length} 个等级，必须是 ${MIN_SCORE_LEVELS} 到 ${MAX_SCORE_LEVELS} 个`);
      }
      const levels: string[] = [];
      for (let index = 0; index < criteria.length; index++) {
        const level: unknown = criteria[index];
        if (!isText(level)) badRequest(`${where}的第 ${index + 1} 个等级说明必须是非空字符串`);
        levels.push(level);
      }
      return { type: 'score', instructions, criteria: levels };
    }
    default:
      return badRequest(`${where}的类型必须是 noul、choice 或 score（只用是否、单选、打分）`);
  }
}

/** Validates a request against the pinned model and the limits, and serializes it. */
export function checkRequest(request: unknown, limits: RequestLimits): CheckedRequest {
  if (!isPlainObject(request)) badRequest('请求必须是对象');
  for (const key of Object.keys(request)) {
    if (!REQUEST_FIELDS.has(key) && request[key] !== undefined) badRequest(`请求有不认识的字段 ${shortText(key)}`);
  }
  const model = request.model;
  if (typeof model !== 'string' || model === '') badRequest('缺少 model');
  if (model !== limits.pinnedModel) badRequest(`请求的模型 ${shortText(model)} 与客户端固定的模型 ${limits.pinnedModel} 不一致`);
  const state = request.state;
  if (typeof state !== 'string' && !Array.isArray(state) && !isPlainObject(state)) badRequest('state 必须是字符串、对象或数组');
  const problem = jsonProblem(state, 2);
  if (problem !== null) badRequest(`state ${problem}`);
  const questions = request.questions;
  if (!isPlainObject(questions)) badRequest('questions 必须是“问题标识 → 问题”对象');
  const ids = Object.keys(questions);
  if (ids.length === 0) badRequest('至少要有一个问题');
  const out: { [id: string]: JevQuestion } = {};
  for (const id of ids) {
    if (!isQuestionId(id)) badRequest(`问题标识 ${shortText(id)} 不合格：只能用 1 到 128 个字母、数字、下划线或连字符`);
    out[id] = checkQuestion(id, questions[id]);
  }
  const normalized: JevRequest = { model, state: state as JevState, questions: out };
  const body = JSON.stringify(normalized);
  const bytes = Buffer.byteLength(body, 'utf8');
  if (bytes > limits.maxRequestBytes) {
    throw new JevError('JEV_TOO_LARGE', `Jev 请求体有 ${bytes} 字节，超过上限 ${limits.maxRequestBytes} 字节；请拆成更小的请求`);
  }
  return { request: normalized, body, bytes };
}

/** True when some object in `text` (valid JSON) repeats a member name, which JSON.parse would silently collapse. */
export function hasDuplicateKey(text: string): boolean {
  const stack: Array<Set<string> | null> = []; // a Set per open object, null per open array
  let expectKey = false;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code === 0x22) {
      let end = index + 1;
      let escaped = false;
      while (end < text.length && text.charCodeAt(end) !== 0x22) {
        if (text.charCodeAt(end) === 0x5c) {
          escaped = true;
          end += 2;
        } else {
          end++;
        }
      }
      if (expectKey) {
        const key = escaped ? (JSON.parse(text.slice(index, end + 1)) as string) : text.slice(index + 1, end);
        const keys = stack[stack.length - 1];
        if (keys) {
          if (keys.has(key)) return true;
          keys.add(key);
        }
        expectKey = false;
      }
      index = end;
    } else if (code === 0x7b) {
      stack.push(new Set());
      expectKey = true;
    } else if (code === 0x5b) {
      stack.push(null);
      expectKey = false;
    } else if (code === 0x7d || code === 0x5d) {
      stack.pop();
      expectKey = false;
    } else if (code === 0x2c) {
      expectKey = stack[stack.length - 1] instanceof Set;
    }
  }
  return false;
}

/** JSON.parse that refuses invalid JSON and duplicate member names. */
export function parseResponseText(text: string, context: ResponseContext): unknown {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return badResponse(context, '不是合法的 JSON');
  }
  if (hasDuplicateKey(text)) badResponse(context, '同一对象里有重复的键（例如同一问题回答了两次）');
  return value;
}

function isProbability(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function sameKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function checkDistribution(context: ResponseContext, id: string, raw: unknown, keys: readonly string[]): { [key: string]: number } {
  if (!isPlainObject(raw)) badResponse(context, `问题 ${id} 缺少 probabilities`, id);
  if (!sameKeys(raw, keys)) badResponse(context, `问题 ${id} 的 probabilities 与问题的候选项不是同一组`, id);
  const out: { [key: string]: number } = {};
  let sum = 0;
  for (const key of keys) {
    const p = raw[key];
    if (!isProbability(p)) badResponse(context, `问题 ${id} 有不是 0 到 1 之间有限数的概率`, id);
    out[key] = p;
    sum += p;
  }
  if (!(Math.abs(sum - 1) <= PROBABILITY_SUM_TOLERANCE)) {
    badResponse(context, `问题 ${id} 的概率之和是 ${Number(sum.toPrecision(6))}，与 1 相差超过 ${PROBABILITY_SUM_TOLERANCE}`, id);
  }
  return out;
}

function checkAnswer(context: ResponseContext, id: string, question: JevQuestion, raw: unknown): JevAnswer {
  if (!isPlainObject(raw)) badResponse(context, `问题 ${id} 的回答不是对象`, id);
  if (raw.type !== question.type) badResponse(context, `问题 ${id} 的回答类型不是 ${question.type}`, id);
  if (question.type === 'noul') {
    const noul = raw.noul;
    if (!isProbability(noul)) badResponse(context, `问题 ${id} 的 noul 不是 0 到 1 之间的有限数`, id);
    return { type: 'noul', noul };
  }
  if (question.type === 'choice') {
    const options = Object.keys(question.criteria);
    const probabilities = checkDistribution(context, id, raw.probabilities, options);
    const choice = raw.choice;
    if (typeof choice !== 'string' || !Object.hasOwn(question.criteria, choice)) badResponse(context, `问题 ${id} 选的项不在所给的选项里`, id);
    if ((probabilities[choice] as number) < Math.max(...Object.values(probabilities)) - ARGMAX_EPSILON) {
      badResponse(context, `问题 ${id} 选的项不是概率最高的项`, id);
    }
    const confidence = raw.confidence;
    if (!isProbability(confidence)) badResponse(context, `问题 ${id} 的 confidence 不是 0 到 1 之间的有限数`, id);
    return { type: 'choice', choice, confidence, probabilities };
  }
  const n = question.criteria.length;
  const levels = Array.from({ length: n }, (_, level) => String(level));
  const probabilities = checkDistribution(context, id, raw.probabilities, levels);
  const legend = raw.legend;
  if (!isPlainObject(legend) || !sameKeys(legend, levels)) badResponse(context, `问题 ${id} 的 legend 的键不是 0 到 ${n - 1}`, id);
  const legendOut: { [level: string]: JevJson } = {};
  for (const level of levels) {
    const value = legend[level];
    if (value === null || (typeof value !== 'string' && typeof value !== 'object') || jsonProblem(value, 5) !== null) {
      badResponse(context, `问题 ${id} 的 legend 取值不合格`, id);
    }
    legendOut[level] = structuredClone(value) as JevJson;
  }
  const score = raw.score;
  if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > n - 1) {
    badResponse(context, `问题 ${id} 的 score 不在 0 到 ${n - 1} 之间`, id);
  }
  const expected = levels.reduce((sum, level, index) => sum + index * (probabilities[level] as number), 0);
  if (!(Math.abs(score - expected) <= SCORE_TOLERANCE_PER_LEVEL * Math.max(1, n - 1))) {
    badResponse(context, `问题 ${id} 的 score 与各等级的概率不符`, id);
  }
  const confidence = raw.confidence;
  if (!isProbability(confidence)) badResponse(context, `问题 ${id} 的 confidence 不是 0 到 1 之间的有限数`, id);
  return { type: 'score', score, confidence, legend: legendOut, probabilities };
}

/**
 * Validates a parsed response against the request it answers: every question answered exactly once, answer types equal
 * question types, choices within the options with probabilities over exactly those options, finite values in range,
 * probability sums within 1e-3 of 1, score legends keyed 0..n-1. A pinned versioned model must come back unchanged.
 */
export function checkResponse(request: JevRequest, raw: unknown, context: ResponseContext): JevResponse {
  if (!isPlainObject(raw)) badResponse(context, '不是 JSON 对象');
  const model = raw.model;
  if (typeof model !== 'string' || !MODEL_NAME.test(model)) badResponse(context, '缺少模型名或模型名不合格');
  if (isVersionedModel(context.pinnedModel) && model !== context.pinnedModel) {
    badResponse(context, `返回的模型不是固定的 ${context.pinnedModel}`);
  }
  const answers = raw.answers;
  if (!isPlainObject(answers)) badResponse(context, '缺少 answers 对象');
  const extra = Object.keys(answers).filter((key) => !Object.hasOwn(request.questions, key)).length;
  if (extra > 0) badResponse(context, `有 ${extra} 个回答不对应所问的问题`);
  const out: { [id: string]: JevAnswer } = {};
  for (const id of Object.keys(request.questions)) {
    if (!Object.hasOwn(answers, id)) badResponse(context, `问题 ${id} 没有回答`, id);
    out[id] = checkAnswer(context, id, request.questions[id] as JevQuestion, answers[id]);
  }
  const usage = raw.usage;
  const inputTokens = isPlainObject(usage) ? usage.input_tokens : undefined;
  const outputTokens = isPlainObject(usage) ? usage.output_tokens : undefined;
  if (!isCount(inputTokens) || !isCount(outputTokens)) badResponse(context, 'usage 缺失或不是非负整数');
  const response: JevResponse = { model, answers: out, usage: { inputTokens, outputTokens } };
  if (context.requestId) response.requestId = context.requestId;
  return response;
}
