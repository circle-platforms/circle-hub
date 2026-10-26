// ScriptedJev: the deterministic judge for tests and development (K04 R[4]). A script answers each question; requests
// and responses pass through the same validation the removed service client had, so the scripted judge cannot abstain
// either: picking an explicit 'none' option is the only way to say "nothing fits".
import type { JevClient, JevQuestion, JevRequest, JevResponse, JevState } from './api.ts';
import { JevError, isJevErrorCode } from './errors.ts';
import type { JevErrorCode } from './errors.ts';
import { estimateTokens } from './tokens.ts';
import { DEFAULT_MAX_REQUEST_BYTES, VENDOR_MAX_REQUEST_BYTES, checkModel, checkRequest, checkResponse, isPlainObject } from './validate.ts';

/** Default model id of the scripted judge: versioned, and plainly not a vendor model. */
export const SCRIPTED_MODEL = 'jev-scripted-1.0.0';
// Every model name of the scripted judge carries this segment, so a record names it as the judge (A01 R[4]) and its
// judgments never share a model or a reuse key with the service's.
const SCRIPTED_SEGMENT = /(?:^|-)scripted(?:-|$)/;

function scriptedName(model: string, field: string): string {
  if (!SCRIPTED_SEGMENT.test(model)) {
    throw new JevError('JEV_BAD_REQUEST', `脚本化判断器的 ${field} 必须带 scripted 段（例如 ${SCRIPTED_MODEL}），不能用服务的模型名，否则判断记录分不出是谁判的`);
  }
  return model;
}

/**
 * What the script answers for one question.
 * - `{ noul }`: probability of yes.
 * - `{ choice, p }`: that option with probability p (default 1), the rest spread evenly over the other options.
 * - `{ level, p }`: the same for a score question.
 * - `{ probabilities }`: an explicit distribution (missing options are 0); choice or score follow from it.
 * - `{ fail, message? }`: the whole request fails with that error code, as the service fails whole requests.
 * - `{ raw }`: the answer object exactly as given, to exercise response validation.
 * `delayMs` adds latency; the request waits for the largest delay among its questions.
 */
export type ScriptedSpec =
  | { noul: number; delayMs?: number }
  | { choice: string; p?: number; delayMs?: number }
  | { level: number; p?: number; delayMs?: number }
  | { probabilities: { [name: string]: number }; delayMs?: number }
  | { fail: JevErrorCode; message?: string; delayMs?: number }
  | { raw: unknown; delayMs?: number };

export type ScriptedAnswer = (question: JevQuestion, state: JevState, id: string) => ScriptedSpec | Promise<ScriptedSpec>;

export interface ScriptedJevOptions {
  /** Default jev-scripted-1.0.0; must carry a 'scripted' segment. Aliases need allowAlias, as the removed client did. */
  model?: string;
  allowAlias?: boolean;
  /** The model name the scripted service reports; default the pinned model; must carry a 'scripted' segment. */
  returnedModel?: string;
  maxRequestBytes?: number;
  sleep?: (ms: number) => Promise<void>;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const member of Object.values(value)) deepFreeze(member);
  }
  return value;
}

function isUnitInterval(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function specError(id: string, message: string): TypeError {
  return new TypeError(`脚本给问题 ${id} 的回答规格不合格：${message}`);
}

function peaked(id: string, names: readonly string[], chosen: string, p: unknown): { [name: string]: number } {
  if (!names.includes(chosen)) throw specError(id, '选的项不在问题的选项里');
  const probability = p === undefined ? 1 : p;
  if (!isUnitInterval(probability)) throw specError(id, 'p 必须是 0 到 1 之间的数');
  const rest = names.length > 1 ? (1 - probability) / (names.length - 1) : 0;
  const out: { [name: string]: number } = {};
  for (const name of names) out[name] = name === chosen ? probability : rest;
  return out;
}

function filled(id: string, names: readonly string[], given: unknown): { [name: string]: number } {
  if (!isPlainObject(given)) throw specError(id, 'probabilities 必须是对象');
  for (const key of Object.keys(given)) if (!names.includes(key)) throw specError(id, 'probabilities 有不是选项的键');
  const out: { [name: string]: number } = {};
  for (const name of names) out[name] = Object.hasOwn(given, name) ? (given[name] as number) : 0;
  return out;
}

function confidenceOf(top: number, n: number): number {
  if (!Number.isFinite(top)) return 0;
  if (n <= 1) return 1;
  return Math.min(Math.max((top - 1 / n) / (1 - 1 / n), 0), 1);
}

// Builds the answer object the scripted service sends for one question.
function answerFor(id: string, question: JevQuestion, spec: Record<string, unknown>): unknown {
  if ('raw' in spec) return spec.raw;
  if (question.type === 'noul') {
    if (!('noul' in spec)) throw specError(id, '是否题要用 {noul}');
    return { type: 'noul', noul: spec.noul };
  }
  const names = question.type === 'choice' ? Object.keys(question.criteria) : question.criteria.map((_, level) => String(level));
  let distribution: { [name: string]: number };
  if ('probabilities' in spec) distribution = filled(id, names, spec.probabilities);
  else if (question.type === 'choice' && 'choice' in spec) distribution = peaked(id, names, String(spec.choice), spec.p);
  else if (question.type === 'score' && 'level' in spec) distribution = peaked(id, names, String(spec.level), spec.p);
  else throw specError(id, question.type === 'choice' ? '单选题要用 {choice} 或 {probabilities}' : '打分题要用 {level} 或 {probabilities}');
  let top = names[0] as string;
  for (const name of names) if ((distribution[name] as number) > (distribution[top] as number)) top = name;
  const confidence = confidenceOf(distribution[top] as number, names.length);
  if (question.type === 'choice') {
    const choice = 'choice' in spec ? String(spec.choice) : top;
    return { type: 'choice', choice, confidence, probabilities: distribution };
  }
  const score = names.reduce((sum, name, level) => sum + level * (distribution[name] as number), 0);
  const legend = Object.fromEntries(question.criteria.map((text, level) => [String(level), text]));
  return { type: 'score', score, confidence, legend, probabilities: distribution };
}

export class ScriptedJev implements JevClient {
  readonly pinnedModel: string;
  /** Every request that passed local validation (what a service would have received), as deep-frozen copies. */
  readonly requests: JevRequest[] = [];
  #answer: ScriptedAnswer;
  #returnedModel: string;
  #maxRequestBytes: number;
  #sleep: (ms: number) => Promise<void>;
  #count = 0;

  constructor(answer: ScriptedAnswer, options: ScriptedJevOptions = {}) {
    if (typeof answer !== 'function') throw new TypeError('ScriptedJev 需要一个回答函数 (question, state, id) => 规格');
    this.pinnedModel = scriptedName(checkModel(options.model ?? SCRIPTED_MODEL, options.allowAlias === true), 'model');
    this.#answer = answer;
    if (options.returnedModel !== undefined && typeof options.returnedModel !== 'string') throw new TypeError('returnedModel 必须是字符串');
    this.#returnedModel = scriptedName(options.returnedModel ?? this.pinnedModel, 'returnedModel');
    const max = options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES;
    if (!Number.isInteger(max) || max < 1 || max > VENDOR_MAX_REQUEST_BYTES) {
      throw new TypeError(`maxRequestBytes 必须是 1 到 ${VENDOR_MAX_REQUEST_BYTES} 之间的整数`);
    }
    this.#maxRequestBytes = max;
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async ask(request: JevRequest): Promise<JevResponse> {
    const checked = checkRequest(request, { pinnedModel: this.pinnedModel, maxRequestBytes: this.#maxRequestBytes });
    const copy = deepFreeze(structuredClone(checked.request));
    this.requests.push(copy);
    const requestId = `scripted-${++this.#count}`;
    const answers: { [id: string]: unknown } = {};
    let delayMs = 0;
    let failure: { code: JevErrorCode; message: string | null } | null = null;
    for (const [id, question] of Object.entries(copy.questions)) {
      const spec: unknown = await this.#answer(question, copy.state, id);
      if (!isPlainObject(spec)) throw specError(id, '必须是对象');
      if (spec.delayMs !== undefined) {
        if (typeof spec.delayMs !== 'number' || !Number.isFinite(spec.delayMs) || spec.delayMs < 0) throw specError(id, 'delayMs 必须是非负数');
        delayMs = Math.max(delayMs, spec.delayMs);
      }
      if ('fail' in spec) {
        if (!isJevErrorCode(spec.fail)) throw specError(id, 'fail 必须是 JevError 的代码');
        failure ??= { code: spec.fail, message: typeof spec.message === 'string' ? spec.message : null };
        continue;
      }
      answers[id] = answerFor(id, question, spec);
    }
    if (delayMs > 0) await this.#sleep(delayMs);
    if (failure !== null) {
      throw new JevError(failure.code, failure.message ?? `脚本化 Jev 按脚本失败（${failure.code}）`, { attempts: 1, requestId });
    }
    const raw = {
      model: this.#returnedModel,
      answers,
      usage: { input_tokens: estimateTokens(checked.body), output_tokens: Object.keys(answers).length },
    };
    return checkResponse(checked.request, raw, { pinnedModel: this.pinnedModel, requestId, attempts: 1, status: 200 });
  }
}
