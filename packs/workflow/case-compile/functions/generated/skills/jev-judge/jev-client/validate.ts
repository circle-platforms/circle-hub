// Local validation of the Jev client: a request is checked before anything is sent and an answer before anything is used. Messages
// name question ids (kept to a safe alphabet), positions and counts, never state content, option names, the key or anything the
// service sent back.
import { JEV_DEFAULT_MODEL, JevCallError } from './types.ts';
import type { JevAnswer, JevQuestion } from './types.ts';

export const MAX_CHOICE_OPTIONS = 255;
export const MIN_SCORE_LEVELS = 2;
export const MAX_SCORE_LEVELS = 10;
/** Nesting limit of the whole body; the body object itself is level 1. */
export const MAX_JSON_DEPTH = 64;
export const MAX_BODY_BYTES = 32 * 1024 * 1024;
/** What the probabilities of one answer may differ from 1 by (rounding of the service). */
export const PROBABILITY_SUM_TOLERANCE = 1e-3;
export const QUESTION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
export const MODEL_NAME_PATTERN = /^[\x21-\x7e]{1,128}$/;

// An array index: a JavaScript object lists such keys first, in numeric order, whatever order they were written in.
const ARRAY_INDEX = /^(?:0|[1-9][0-9]{0,9})$/;
const MAX_ARRAY_INDEX = 2 ** 32 - 2;
// A choice the service reports must be a most probable option; this absorbs float noise only.
const ARGMAX_EPSILON = 1e-9;
const REQUEST_FIELDS = new Set(['state', 'questions', 'model']);
const QUESTION_FIELDS = new Set(['type', 'instructions', 'criteria']);

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

const isText = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '' && value.isWellFormed();
const isWellFormedString = (value: unknown): value is string => typeof value === 'string' && value.isWellFormed();
const isArrayIndex = (name: string): boolean => ARRAY_INDEX.test(name) && Number(name) <= MAX_ARRAY_INDEX;
const isProbability = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

export function isQuestionId(id: unknown): id is string {
  return typeof id === 'string' && QUESTION_ID_PATTERN.test(id) && id !== '__proto__';
}

function invalid(fact: string): never {
  throw new JevCallError({ category: '参数无效', code: 'invalid_request', fact, nextAction: '请按技能说明里的题型改正请求后重试' });
}

function badResponse(status: number, fact: string): never {
  throw new JevCallError({
    category: '暂时不可用',
    code: 'invalid_response',
    fact,
    nextAction: '不要使用这份应答，也不要猜它的内容；请稍后重试，反复出现请联系服务方',
    status,
  });
}

/** The first reason a value is not plain JSON data within the depth limit, or null. depth is its level in the body. */
export function jsonProblem(value: unknown, depth: number): string | null {
  if (value === null || typeof value === 'boolean') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? null : '有非有限数字（NaN 或无穷大）';
  if (typeof value === 'string') return value.isWellFormed() ? null : '有不成对的代理字符，不能编码为 UTF-8';
  if (typeof value !== 'object') return `有不是 JSON 数据的值（${typeof value}）`;
  if (depth > MAX_JSON_DEPTH) return `嵌套超过 ${MAX_JSON_DEPTH} 层`;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
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
    if (member === undefined) continue; // dropped by JSON.stringify
    const problem = jsonProblem(member, depth + 1);
    if (problem !== null) return problem;
  }
  return null;
}

function checkQuestion(id: string, raw: unknown): JevQuestion {
  const where = `题目 ${id} `;
  if (!isPlainObject(raw)) invalid(`${where}必须是对象`);
  const unknownFields = Object.keys(raw).filter((key) => !QUESTION_FIELDS.has(key) && raw[key] !== undefined).length;
  if (unknownFields > 0) invalid(`${where}有 ${unknownFields} 个不认识的字段（只认 type、instructions、criteria）`);
  const instructions = raw.instructions;
  if (!isText(instructions)) invalid(`${where}的 instructions 必须是非空字符串`);
  const criteria = raw.criteria;
  switch (raw.type) {
    case 'noul': {
      if (criteria === undefined || criteria === null) return { type: 'noul', instructions };
      if (!isPlainObject(criteria)) invalid(`${where}的 criteria 必须是 {true, false} 对象`);
      const described: { true?: string; false?: string } = {};
      for (const key of Object.keys(criteria)) {
        const description = criteria[key];
        if (description === undefined) continue;
        if (key !== 'true' && key !== 'false') invalid(`${where}的 criteria 只能有 true 和 false`);
        if (!isText(description)) invalid(`${where}的 criteria.${key} 必须是非空字符串`);
        described[key] = description;
      }
      return { type: 'noul', instructions, criteria: described };
    }
    case 'choice': {
      if (!isPlainObject(criteria)) invalid(`${where}的 criteria 必须是“选项 → 说明”对象`);
      const options = Object.keys(criteria);
      if (options.length < 1 || options.length > MAX_CHOICE_OPTIONS) invalid(`${where}有 ${options.length} 个选项，必须是 1 到 ${MAX_CHOICE_OPTIONS} 个`);
      const described: Record<string, string> = {};
      options.forEach((option, index) => {
        if (option === '__proto__' || !isText(option)) invalid(`${where}的第 ${index + 1} 个选项名不合格（必须是非空文本）`);
        // The option order is part of the question (the model favours earlier options) and must stay as written.
        if (isArrayIndex(option)) invalid(`${where}的第 ${index + 1} 个选项名是纯数字：对象会把这类键提到最前并按数值排序，打乱选项顺序；请加前缀，例如 n12`);
        const description = criteria[option];
        if (!isWellFormedString(description)) invalid(`${where}的第 ${index + 1} 个选项的说明必须是字符串`);
        described[option] = description;
      });
      return { type: 'choice', instructions, criteria: described };
    }
    case 'score': {
      if (!Array.isArray(criteria)) invalid(`${where}的 criteria 必须是按顺序排列的等级说明数组`);
      if (criteria.length < MIN_SCORE_LEVELS || criteria.length > MAX_SCORE_LEVELS) {
        invalid(`${where}有 ${criteria.length} 个等级，必须是 ${MIN_SCORE_LEVELS} 到 ${MAX_SCORE_LEVELS} 个`);
      }
      const levels: string[] = [];
      for (let index = 0; index < criteria.length; index += 1) {
        const level: unknown = criteria[index];
        if (!isText(level)) invalid(`${where}的第 ${index + 1} 个等级说明必须是非空字符串`);
        levels.push(level);
      }
      return { type: 'score', instructions, criteria: levels };
    }
    default:
      return invalid(`${where}的类型必须是 noul、choice 或 score`);
  }
}

export interface ValidatedJevRequest {
  model: string;
  /** The exact UTF-8 JSON text to send: {state, model, questions}, in that order. */
  body: string;
  bytes: number;
  /** Normalized copies of the questions: known fields only, options in the order written. */
  questions: Record<string, JevQuestion>;
  /** The question types in question order. */
  types: ReadonlyArray<JevQuestion['type']>;
}

/** Checks a request before it is sent; throws 参数无效 with code invalid_request (or request_too_large) and sends nothing. */
export function validateJevRequest(request: unknown, defaultModel: string = JEV_DEFAULT_MODEL): ValidatedJevRequest {
  if (!isPlainObject(request)) invalid('请求必须是对象');
  const unknownFields = Object.keys(request).filter((key) => !REQUEST_FIELDS.has(key) && request[key] !== undefined).length;
  if (unknownFields > 0) invalid(`请求有 ${unknownFields} 个不认识的字段（只认 state、questions、model）`);
  const model = request.model === undefined ? defaultModel : request.model;
  if (typeof model !== 'string' || !MODEL_NAME_PATTERN.test(model)) invalid('model 必须是模型名（1 到 128 个可见 ASCII 字符，不含空格）');
  const state = request.state;
  if (state === undefined) invalid('缺少 state');
  if (typeof state !== 'string' && !Array.isArray(state) && !isPlainObject(state)) invalid('state 必须是文本、数组或对象');
  const problem = jsonProblem(state, 2);
  if (problem !== null) invalid(`state ${problem}`);
  const asked = request.questions;
  if (!isPlainObject(asked)) invalid('questions 必须是“题目标识 → 题目”对象');
  const ids = Object.keys(asked);
  if (ids.length === 0) invalid('至少要有一道题');
  const questions: Record<string, JevQuestion> = {};
  ids.forEach((id, index) => {
    if (!isQuestionId(id)) invalid(`第 ${index + 1} 道题的标识不合格：只能用 1 到 128 个字母、数字、下划线或连字符`);
    questions[id] = checkQuestion(id, asked[id]);
  });
  const body = JSON.stringify({ state, model, questions });
  const bytes = Buffer.byteLength(body, 'utf8');
  if (bytes > MAX_BODY_BYTES) {
    throw new JevCallError({
      category: '参数无效',
      code: 'request_too_large',
      fact: `请求体有 ${bytes} 字节，超过 ${MAX_BODY_BYTES} 字节的上限`,
      nextAction: '请缩小 state，或拆成几次请求',
    });
  }
  return { model, body, bytes, questions, types: Object.values(questions).map((question) => question.type) };
}

/** True when some object in text (valid JSON) repeats a member name, which JSON.parse would silently collapse. */
function hasDuplicateKey(text: string): boolean {
  const stack: Array<Set<string> | null> = []; // a Set per open object, null per open array
  let expectKey = false;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 0x22) {
      let end = index + 1;
      let escaped = false;
      while (end < text.length && text.charCodeAt(end) !== 0x22) {
        if (text.charCodeAt(end) === 0x5c) {
          escaped = true;
          end += 2;
        } else {
          end += 1;
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

/** JSON.parse that refuses text that is not JSON and text in which an object repeats a member name. */
export function parseJevJson(text: string): { ok: true; value: unknown } | { ok: false; problem: 'syntax' | 'duplicate_key' } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, problem: 'syntax' };
  }
  if (hasDuplicateKey(text)) return { ok: false, problem: 'duplicate_key' };
  return { ok: true, value };
}

function checkDistribution(status: number, id: string, raw: unknown, keys: readonly string[]): Record<string, number> {
  if (!isPlainObject(raw)) badResponse(status, `题目 ${id} 缺少 probabilities`);
  if (Object.keys(raw).length !== keys.length || !keys.every((key) => Object.hasOwn(raw, key))) {
    badResponse(status, `题目 ${id} 的 probabilities 与题目的候选项不是同一组`);
  }
  const out: Record<string, number> = {};
  let sum = 0;
  for (const key of keys) {
    const probability = raw[key];
    if (!isProbability(probability)) badResponse(status, `题目 ${id} 有不是 0 到 1 之间有限数的概率`);
    out[key] = probability;
    sum += probability;
  }
  if (!(Math.abs(sum - 1) <= PROBABILITY_SUM_TOLERANCE)) badResponse(status, `题目 ${id} 的概率之和与 1 相差超过 ${PROBABILITY_SUM_TOLERANCE}`);
  return out;
}

function checkAnswer(status: number, id: string, question: JevQuestion, raw: unknown): JevAnswer {
  if (!isPlainObject(raw)) badResponse(status, `题目 ${id} 的回答不是对象`);
  if (raw.type !== question.type) badResponse(status, `题目 ${id} 的回答类型不是 ${question.type}`);
  if (question.type === 'noul') {
    const noul = raw.noul;
    if (!isProbability(noul)) badResponse(status, `题目 ${id} 的 noul 不是 0 到 1 之间的有限数`);
    return { type: 'noul', noul };
  }
  if (question.type === 'choice') {
    const options = Object.keys(question.criteria);
    const probabilities = checkDistribution(status, id, raw.probabilities, options);
    const choice = raw.choice;
    if (typeof choice !== 'string' || !Object.hasOwn(question.criteria, choice)) badResponse(status, `题目 ${id} 选的项不在所给的选项里`);
    if ((probabilities[choice] as number) < Math.max(...Object.values(probabilities)) - ARGMAX_EPSILON) {
      badResponse(status, `题目 ${id} 选的项不是概率最高的项`);
    }
    const confidence = raw.confidence;
    if (!isProbability(confidence)) badResponse(status, `题目 ${id} 的 confidence 不是 0 到 1 之间的有限数`);
    return { type: 'choice', choice, probabilities, confidence };
  }
  const levels = question.criteria.map((_, level) => String(level));
  const probabilities = checkDistribution(status, id, raw.probabilities, levels);
  const legend = raw.legend;
  if (!isPlainObject(legend) || Object.keys(legend).length !== levels.length || !levels.every((level) => Object.hasOwn(legend, level))) {
    badResponse(status, `题目 ${id} 的 legend 的键不是 0 到 ${levels.length - 1}`);
  }
  const echoed: Record<string, string> = {};
  for (const level of levels) {
    const description = legend[level];
    if (!isWellFormedString(description)) badResponse(status, `题目 ${id} 的 legend 取值不是文本`);
    echoed[level] = description;
  }
  const score = raw.score;
  if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > levels.length - 1) {
    badResponse(status, `题目 ${id} 的 score 不在 0 到 ${levels.length - 1} 之间`);
  }
  const confidence = raw.confidence;
  if (!isProbability(confidence)) badResponse(status, `题目 ${id} 的 confidence 不是 0 到 1 之间的有限数`);
  return { type: 'score', score, legend: echoed, probabilities, confidence };
}

export interface ValidatedJevAnswers {
  model: string;
  answers: Record<string, JevAnswer>;
  usage: { input_tokens: number; output_tokens: number };
}

/**
 * Checks a parsed answer against the questions it answers: every question answered exactly once, the type of each answer the
 * type of its question, a choice among the options of its question with probabilities over exactly those options, finite
 * values in range, probabilities that sum to 1. The result holds protocol fields only; nothing is repaired or guessed, and
 * anything that is not valid throws 暂时不可用 with code invalid_response.
 */
export function validateJevResponse(questions: Readonly<Record<string, JevQuestion>>, raw: unknown, status = 200): ValidatedJevAnswers {
  if (!isPlainObject(raw)) badResponse(status, '应答不是 JSON 对象');
  const model = raw.model;
  if (typeof model !== 'string' || !MODEL_NAME_PATTERN.test(model)) badResponse(status, '应答缺少模型名，或模型名不合格');
  const answers = raw.answers;
  if (!isPlainObject(answers)) badResponse(status, '应答缺少 answers 对象');
  const asked = new Set(Object.keys(questions));
  const extra = Object.keys(answers).filter((key) => !asked.has(key)).length;
  if (extra > 0) badResponse(status, `应答里有 ${extra} 个回答不对应所问的题目`);
  const checked: Record<string, JevAnswer> = {};
  for (const id of Object.keys(questions)) {
    if (!Object.hasOwn(answers, id)) badResponse(status, `题目 ${id} 没有回答`);
    checked[id] = checkAnswer(status, id, questions[id] as JevQuestion, answers[id]);
  }
  const usage = raw.usage;
  const inputTokens = isPlainObject(usage) ? usage.input_tokens : undefined;
  const outputTokens = isPlainObject(usage) ? usage.output_tokens : undefined;
  if (!isCount(inputTokens) || !isCount(outputTokens)) badResponse(status, 'usage 缺失，或 input_tokens、output_tokens 不是非负整数');
  return { model, answers: checked, usage: { input_tokens: inputTokens, output_tokens: outputTokens } };
}
