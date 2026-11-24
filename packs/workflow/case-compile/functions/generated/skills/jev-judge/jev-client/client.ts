// The Jev client: one POST of {state, model, questions} to the fixed endpoint, the answer checked before it is used. The key is the
// constructor's; it goes only into the Authorization header of the request handed to the transport and is held in a private field. Only a
// 429 or a 529 is sent again, once, after the wait the service asks for; a timeout or a broken connection is never sent again,
// because the service may already have processed (and billed) the request. Nothing here reads the environment or a file.
import { appendPrivateLine, checkAppendable } from './files.ts';
import { keyEchoTest, sha256Hex } from './redact.ts';
import { JevTransportError, httpsTransport, transportTag } from './transport.ts';
import { JEV_DEFAULT_MODEL, JEV_ENDPOINT, JevCallError } from './types.ts';
import type { JevClientConfig, JevRequest, JevResponse, JevTransport, JevTransportReply } from './types.ts';
import { MODEL_NAME_PATTERN, isPlainObject, parseJevJson, validateJevRequest, validateJevResponse } from './validate.ts';
import type { ValidatedJevRequest } from './validate.ts';

export const JEV_DEFAULT_TIMEOUT_MS = 30_000;
export const JEV_MAX_TIMEOUT_MS = 600_000;

const ENDPOINT_HOST = new URL(JEV_ENDPOINT).host;
// RFC 6750 b64token: never escaped in JSON text and never able to break a header.
const API_KEY_PATTERN = /^[A-Za-z0-9._~+/-]+=*$/;
/** The longest key the client takes, in characters; the tool reads no more of its standard input than this. */
export const MAX_KEY_LENGTH = 4096;
const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([429, 529]);
const MIN_WAIT_MS = 500;
const MAX_WAIT_MS = 30_000;
const DEFAULT_WAIT_MS = 2_000;
const MAX_ERROR_BODY_CHARS = 64 * 1024;
const CONFIG_FIELDS: ReadonlySet<string> = new Set(['apiKey', 'model', 'timeoutMs', 'auditPath', 'transport', 'now', 'sleep']);
const SECONDS = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/** The wait before the one retry, in milliseconds: Retry-After in seconds clamped to 0.5 to 30, 2 seconds when missing or unreadable. */
export function jevRetryAfterMilliseconds(value: string | undefined): number {
  const text = value?.trim();
  if (text === undefined || !SECONDS.test(text)) return DEFAULT_WAIT_MS;
  const seconds = Number(text);
  if (!Number.isFinite(seconds)) return DEFAULT_WAIT_MS;
  return Math.round(Math.min(Math.max(seconds, MIN_WAIT_MS / 1000), MAX_WAIT_MS / 1000) * 1000);
}

function headerOf(headers: Record<string, unknown>, name: string): string | undefined {
  for (const [key, value] of Object.entries(headers)) if (key.toLowerCase() === name && typeof value === 'string') return value;
  return undefined;
}

/** True when an error body of a refused request names the token limit as its machine-readable cause (the documented shapes only). */
function namesTokenLimit(body: string): boolean {
  if (body.length > MAX_ERROR_BODY_CHARS) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return false;
  }
  if (!isPlainObject(parsed)) return false;
  const places: unknown[] = [parsed];
  for (const member of ['detail', 'error']) {
    const value = parsed[member];
    if (Array.isArray(value)) places.push(...value.slice(0, 64));
    else if (typeof value !== 'string') places.push(value);
  }
  return places.some((place) => isPlainObject(place) && (place.type === 'max_tokens_exceeded' || place.code === 'max_tokens_exceeded'));
}

/** The call error of an HTTP status other than 200; the body is read for the one documented cause code and never shown. */
function statusError(status: number, body: string, attempts: number): JevCallError {
  const later = '请稍后再试';
  const retried = attempts > 1 ? '，按服务要求等待后重试了一次，仍被拒绝' : '';
  if (status === 401) return new JevCallError({ category: '无权限', code: 'unauthorized', status, attempts, fact: 'Jev 服务拒绝了 API 密钥（HTTP 401）', nextAction: '请核对 API 密钥是否有效、是否有权调用 Jev' });
  if (status === 403) return new JevCallError({ category: '无权限', code: 'forbidden', status, attempts, fact: 'Jev 服务不许这把 API 密钥这样调用（HTTP 403）', nextAction: '请核对 API 密钥是否有效、是否有权调用 Jev' });
  if (status === 413) return new JevCallError({ category: '参数无效', code: 'request_too_large', status, attempts, fact: '请求体超过 Jev 服务的上限（HTTP 413）', nextAction: '请缩小 state，或拆成几次请求' });
  if (status === 400 || status === 422) {
    if (namesTokenLimit(body)) {
      return new JevCallError({ category: '参数无效', code: 'context_too_long', status, attempts, fact: `请求超过 Jev 模型的上下文上限（HTTP ${status}，max_tokens_exceeded）`, nextAction: '请缩短 state 或题目，或拆成几次请求' });
    }
    return new JevCallError({
      category: '参数无效',
      code: 'request_rejected',
      status,
      attempts,
      fact: `Jev 服务拒绝了请求（HTTP ${status}）；服务的应答可能回显请求内容，这里不显示`,
      nextAction: '请核对题型、criteria 和 state，缩小请求后重试',
    });
  }
  if (status === 429) return new JevCallError({ category: '暂时不可用', code: 'rate_limited', status, attempts, retryable: true, fact: `Jev 服务限流（HTTP 429）${retried}`, nextAction: later });
  if (status === 529) return new JevCallError({ category: '暂时不可用', code: 'overloaded', status, attempts, retryable: true, fact: `Jev 服务过载（HTTP 529）${retried}`, nextAction: later });
  if (status >= 500 && status <= 599) {
    return new JevCallError({ category: '暂时不可用', code: 'service_error', status, attempts, fact: `Jev 服务出错（HTTP ${status}），服务可能已经处理了请求`, nextAction: '没有重发这个请求；请先确认是否要再问一次，反复出现请联系服务方' });
  }
  if (status >= 300 && status <= 399) {
    return new JevCallError({ category: '暂时不可用', code: 'unexpected_status', status, attempts, fact: `Jev 服务要求重定向（HTTP ${status}），没有跟随`, nextAction: '这个客户端的服务地址是固定的；请核对客户端版本' });
  }
  return new JevCallError({ category: '暂时不可用', code: 'unexpected_status', status, attempts, fact: `Jev 服务返回了意外的状态（HTTP ${status}）`, nextAction: '请稍后再试，反复出现请联系服务方' });
}

interface AuditRecord {
  ts: string;
  endpoint_host: string;
  questions: number;
  question_types: string[];
  body_bytes: number;
  body_sha256: string;
  attempt: number;
  http_status: number | null;
  model: string | null;
  usage: { input_tokens: number; output_tokens: number } | null;
  duration_ms: number;
  error_code: string | null;
}

type Step = { kind: 'answer'; response: JevResponse } | { kind: 'retry'; waitMs: number };

function configProblem(fact: string): JevCallError {
  return new JevCallError({ category: '参数无效', code: 'invalid_request', fact, nextAction: '请按模块说明改正客户端配置' });
}

export class JevClient {
  readonly #key: string;
  readonly #model: string;
  readonly #timeoutMs: number;
  readonly #auditPath: string | undefined;
  readonly #transport: JevTransport;
  readonly #now: () => Date;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #echoes: (text: string) => boolean;

  constructor(config: JevClientConfig) {
    if (!isPlainObject(config)) throw configProblem('客户端配置必须是对象');
    const unknownFields = Object.keys(config).filter((key) => !CONFIG_FIELDS.has(key) && config[key] !== undefined).length;
    if (unknownFields > 0) throw configProblem(`客户端配置有 ${unknownFields} 个不认识的选项（服务地址是固定的，不能配置）`);
    const key = config.apiKey;
    if (typeof key !== 'string' || key.length === 0 || key.length > MAX_KEY_LENGTH || !API_KEY_PATTERN.test(key)) {
      throw new JevCallError({
        category: '无权限',
        code: 'invalid_key',
        fact: 'Jev API 密钥没有通过本地检查（为空、太长或含不允许的字符），没有发出任何请求，不是服务拒绝',
        nextAction: '请提供有效的 Jev API 密钥（客户端里保存为 JEV_API_KEY，命令里只写占位符 %JEV_API_KEY%）',
      });
    }
    const model = config.model ?? JEV_DEFAULT_MODEL;
    if (typeof model !== 'string' || !MODEL_NAME_PATTERN.test(model)) throw configProblem('model 必须是模型名（1 到 128 个可见 ASCII 字符，不含空格）');
    const timeoutMs = config.timeoutMs ?? JEV_DEFAULT_TIMEOUT_MS;
    if (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > JEV_MAX_TIMEOUT_MS) {
      throw configProblem(`timeoutMs 必须是 1 到 ${JEV_MAX_TIMEOUT_MS} 之间的整数`);
    }
    if (config.auditPath !== undefined && (typeof config.auditPath !== 'string' || config.auditPath === '')) throw configProblem('auditPath 必须是非空文本');
    for (const name of ['transport', 'now', 'sleep'] as const) {
      if (config[name] !== undefined && typeof config[name] !== 'function') throw configProblem(`${name} 必须是函数`);
    }
    this.#key = key;
    this.#model = model;
    this.#timeoutMs = timeoutMs;
    this.#auditPath = config.auditPath;
    this.#transport = config.transport ?? httpsTransport;
    this.#now = config.now ?? (() => new Date());
    this.#sleep = config.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    this.#echoes = keyEchoTest(key);
  }

  /** Asks the questions and returns the checked answers with the disclosure; a call that cannot end that way throws a JevCallError. */
  async ask(request: JevRequest): Promise<JevResponse> {
    const checked = validateJevRequest(request, this.#model);
    const digest = sha256Hex(checked.body);
    await this.#checkAudit();
    for (let attempt = 1; ; attempt += 1) {
      const step = await this.#attempt(checked, digest, attempt);
      if (step.kind === 'answer') return step.response;
      await this.#sleep(step.waitMs);
    }
  }

  async #checkAudit(): Promise<void> {
    if (this.#auditPath === undefined) return;
    try {
      await checkAppendable(this.#auditPath);
    } catch {
      throw new JevCallError({
        category: '参数无效',
        code: 'audit_failed',
        fact: '审计文件打不开或写不进（路径不可写、是链接或是目录），没有发出任何请求',
        nextAction: '请换一个可写的审计文件路径后重试',
      });
    }
  }

  /** Appends the record. A failure is the call's error when the call went well; behind another error it is dropped, that error is the news. */
  async #audit(record: AuditRecord, behind: JevCallError | null): Promise<void> {
    if (this.#auditPath === undefined) return;
    try {
      await appendPrivateLine(this.#auditPath, JSON.stringify(record));
    } catch {
      if (behind !== null) return;
      throw new JevCallError({
        category: '暂时不可用',
        code: 'audit_failed',
        status: record.http_status ?? 0,
        attempts: record.attempt,
        fact: '请求已发出并得到应答，但审计记录写不进文件，应答没有交付；服务可能已经计费',
        nextAction: '请先修好审计文件的位置和权限，再决定是否重新发起',
      });
    }
  }

  async #send(body: string): Promise<JevTransportReply> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    // The transport enforces the limit itself; this one covers a transport that does not.
    const watchdog = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new JevTransportError('timeout')), this.#timeoutMs);
    });
    try {
      return await Promise.race([
        this.#transport({
          url: JEV_ENDPOINT,
          headers: { Authorization: `Bearer ${this.#key}`, 'Content-Type': 'application/json', Accept: 'application/json' },
          body,
          timeoutMs: this.#timeoutMs,
        }),
        watchdog,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** The call error of a failed exchange; the request is not sent again, and the error says so. */
  #exchangeFailure(cause: unknown, attempt: number): JevCallError {
    const reason = cause instanceof JevTransportError ? cause.reason : 'connection';
    const found = cause instanceof JevTransportError ? cause.tag : transportTag(cause);
    const tag = found !== '' && !this.#echoes(found) ? found : '';
    if (reason === 'timeout') {
      return new JevCallError({
        category: '暂时不可用',
        code: 'timeout',
        attempts: attempt,
        fact: `Jev 请求超时（${this.#timeoutMs} 毫秒）；服务可能已经处理并计费`,
        nextAction: '没有重发这个请求；请先确认是否要再问一次，需要时调大超时',
      });
    }
    if (reason === 'response_too_large') {
      return new JevCallError({ category: '暂时不可用', code: 'invalid_response', attempts: attempt, fact: 'Jev 应答超过大小上限，已丢弃；服务可能已经计费', nextAction: '没有重发这个请求；请先确认是否要再问一次' });
    }
    if (reason === 'response_encoding') {
      return new JevCallError({ category: '暂时不可用', code: 'invalid_response', attempts: attempt, fact: 'Jev 应答不是合法的 UTF-8，已丢弃；服务可能已经计费', nextAction: '没有重发这个请求；请先确认是否要再问一次' });
    }
    return new JevCallError({
      category: '暂时不可用',
      code: 'connection_lost',
      attempts: attempt,
      fact: `与 Jev 服务的连接失败或中断${tag === '' ? '' : `（${tag}）`}；服务可能已经收到并处理了请求`,
      nextAction: '没有重发这个请求；请先确认是否要再问一次',
    });
  }

  async #attempt(checked: ValidatedJevRequest, digest: string, attempt: number): Promise<Step> {
    const started = this.#now();
    const record: AuditRecord = {
      ts: started.toISOString(),
      endpoint_host: ENDPOINT_HOST,
      questions: checked.types.length,
      question_types: [...checked.types],
      body_bytes: checked.bytes,
      body_sha256: digest,
      attempt,
      http_status: null,
      model: null,
      usage: null,
      duration_ms: 0,
      error_code: null,
    };
    const closeRecord = (): void => {
      record.duration_ms = Math.max(0, this.#now().getTime() - started.getTime());
    };
    const fail = async (error: JevCallError): Promise<never> => {
      closeRecord();
      record.error_code = error.code;
      await this.#audit(record, error);
      throw error;
    };

    let reply: JevTransportReply;
    try {
      reply = await this.#send(checked.body);
    } catch (cause) {
      return await fail(this.#exchangeFailure(cause, attempt));
    }
    const headers = reply?.headers ?? {};
    if (!isPlainObject(reply) || typeof reply.status !== 'number' || !Number.isInteger(reply.status) || reply.status < 100 || reply.status > 599 || typeof reply.body !== 'string' || !isPlainObject(headers)) {
      return await fail(new JevCallError({ category: '暂时不可用', code: 'invalid_response', attempts: attempt, fact: '传输层交回的应答对象不合格', nextAction: '没有重发这个请求；请先确认是否要再问一次' }));
    }
    record.http_status = reply.status;
    if (this.#echoes(reply.body) || Object.values(headers).some((value) => typeof value === 'string' && this.#echoes(value))) {
      return await fail(new JevCallError({ category: '暂时不可用', code: 'invalid_response', status: reply.status, attempts: attempt, fact: 'Jev 的应答里出现了 API 密钥，已整份丢弃', nextAction: '请联系服务方，并考虑更换这把密钥' }));
    }
    if (reply.status !== 200) {
      const error = statusError(reply.status, reply.body, attempt);
      if (attempt === 1 && RETRYABLE_STATUSES.has(reply.status)) {
        closeRecord();
        record.error_code = error.code;
        await this.#audit(record, error);
        return { kind: 'retry', waitMs: jevRetryAfterMilliseconds(headerOf(headers, 'retry-after')) };
      }
      return await fail(error);
    }

    let response: JevResponse;
    try {
      const parsed = parseJevJson(reply.body);
      if (!parsed.ok) {
        throw new JevCallError({
          category: '暂时不可用',
          code: 'invalid_response',
          status: 200,
          fact: parsed.problem === 'duplicate_key' ? 'Jev 应答里同一个对象有重复的键（例如同一道题回答了两次）' : 'Jev 应答不是合法的 JSON',
          nextAction: '不要使用这份应答；请稍后重试，反复出现请联系服务方',
        });
      }
      const checkedAnswers = validateJevResponse(checked.questions, parsed.value, 200);
      response = { model: checkedAnswers.model, model_version: checkedAnswers.model, status: '未确认', decided_by: '模型', answers: checkedAnswers.answers, usage: checkedAnswers.usage };
      if (this.#echoes(JSON.stringify(response))) {
        throw new JevCallError({ category: '暂时不可用', code: 'invalid_response', status: 200, fact: 'Jev 的应答里出现了 API 密钥，已整份丢弃', nextAction: '请联系服务方，并考虑更换这把密钥' });
      }
    } catch (error) {
      if (error instanceof JevCallError) return await fail(error.withAttempts(attempt));
      throw error;
    }
    closeRecord();
    record.model = response.model;
    record.usage = response.usage;
    await this.#audit(record, null);
    return { kind: 'answer', response };
  }
}
