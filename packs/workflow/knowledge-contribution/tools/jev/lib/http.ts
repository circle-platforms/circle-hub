// Client-only transport adapted from the removed Hub client.
// HttpJev: the client for the vendor's POST /v1/systemone. The API key comes from a caller-supplied function on every
// attempt and goes only into the Authorization header. Nothing here logs; no error carries a key, a request body or a
// response body (a 422 body echoes request content).
import type { JevClient, JevRequest, JevResponse } from './api.ts';
import { JevError } from './errors.ts';
import type { JevErrorCode } from './errors.ts';
import { DEFAULT_MAX_REQUEST_BYTES, VENDOR_MAX_REQUEST_BYTES, checkModel, checkRequest, checkResponse, isPlainObject, parseResponseText } from './validate.ts';
import type { CheckedRequest, ResponseContext } from './validate.ts';

export const DEFAULT_BASE_URL = 'https://api.typesafe.ai';
export const DEFAULT_TIMEOUT_MS = 60_000;
export const DEFAULT_RETRIES = 2;
export const DEFAULT_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
/** The longest wait the client accepts from Retry-After; when the service asks for more, the call fails at once. */
export const MAX_RETRY_AFTER_MS = 60_000;

const ENDPOINT = 'v1/systemone';
const REQUEST_ID_HEADER = 'x-typesafe-request-id';
const INITIAL_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 5_000;
const ERROR_BODY_BYTES = 64 * 1024;
const TOKEN_LIMIT_MARKER = 'max_tokens_exceeded';
// This many consecutive key characters in anything the service sent count as an echo of the key.
const KEY_ECHO_RUN = 12;
// RFC 6750 b64token: never escaped in JSON text and never able to break a header.
const API_KEY = /^[A-Za-z0-9._~+/-]+=*$/;
const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const REASON = /^[a-z][a-z0-9_.]{0,63}$/;
const SECONDS = /^\d+(?:\.\d+)?$/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH = MONTHS.join('|');
const CLOCK = '(\\d{2}):(\\d{2}):(\\d{2})';
// RFC 9110 5.6.7: IMF-fixdate, plus the obsolete rfc850-date and asctime-date that a recipient must still accept.
const IMF_FIXDATE = new RegExp(`^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), (\\d{2}) (${MONTH}) (\\d{4}) ${CLOCK} GMT$`);
const RFC850_DATE = new RegExp(`^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), (\\d{2})-(${MONTH})-(\\d{2}) ${CLOCK} GMT$`);
const ASCTIME_DATE = new RegExp(`^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (${MONTH}) ([ \\d]\\d) ${CLOCK} (\\d{4})$`);
const KEY_TIMEOUT = Symbol('key timeout');

export interface HttpJevOptions {
  onSending?: (event:{request:JevRequest;attempt:number})=>Promise<void>;
  onAttempt?: (event: {request:JevRequest;attempt:number;status:number|null;requestId:string|null;result:string}) => Promise<void>;
  /** Returns the API key; called once per attempt. Never stored, logged or put into an error. */
  apiKey: () => string | Promise<string>;
  /** A versioned model id such as jev-1.13.0. */
  model: string;
  /** Accept a moving alias (jev-latest, jev-preview); its judgments are not reusable and may lack an exact version. */
  allowAlias?: boolean;
  /** Default https://api.typesafe.ai. Plain http is accepted only for loopback hosts. */
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  /** Per attempt, from asking the key source to reading the body. Default 60000. */
  timeoutMs?: number;
  /** Retries after 429, 529, 408, 5xx, network errors and timeouts. Default 2. */
  retries?: number;
  /** Default 16 MiB; at most the service's 32 MiB. */
  maxRequestBytes?: number;
  /** Default 32 MiB. */
  maxResponseBytes?: number;
  /** Jitter source in [0, 1); default Math.random. */
  random?: () => number;
  /** Waits between attempts; default a timer. */
  sleep?: (ms: number) => Promise<void>;
  /** Clock in epoch milliseconds, for Retry-After dates; default Date.now. */
  now?: () => number;
}

type Outcome =
  | { ok: true; response: JevResponse }
  | {
      ok: false;
      code: JevErrorCode;
      message: string;
      retryable: boolean;
      status: number | null;
      requestId: string | null;
      reasons: readonly string[];
      headers: Headers | null;
      /** False when the request was never handed to fetch (the key source failed); such an attempt is not counted. */
      sent: boolean;
    };

type Fault = Extract<Outcome, { ok: false }>;

type BodyRead = { kind: 'ok'; bytes: Uint8Array; truncated: boolean } | { kind: 'too_large' } | { kind: 'error'; error: unknown };

function fault(code: JevErrorCode, message: string, retryable: boolean, extra: Partial<Fault> = {}): Fault {
  return { ok: false, code, message, retryable, status: null, requestId: null, reasons: [], headers: null, sent: true, ...extra };
}

function integerOption(value: unknown, fallback: number, min: number, max: number, name: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new TypeError(`${name} 必须是 ${min} 到 ${max} 之间的整数`);
  }
  return value;
}

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '[::1]' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
}

function endpointOf(baseUrl: unknown): URL {
  if (typeof baseUrl !== 'string') throw new TypeError('baseUrl 必须是字符串');
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new TypeError('baseUrl 不是合法的网址');
  }
  if (url.username !== '' || url.password !== '') throw new JevError('JEV_BAD_REQUEST', 'baseUrl 不能带用户名或密码');
  if (url.search !== '' || url.hash !== '') throw new TypeError('baseUrl 不能带查询串或片段');
  if (url.protocol === 'http:') {
    if (!isLoopback(url.hostname)) {
      throw new JevError('JEV_BAD_REQUEST', `${url.host} 必须用 HTTPS：明文 HTTP 只允许本机回环地址，否则 API 密钥会明文传输`);
    }
  } else if (url.protocol !== 'https:') {
    throw new TypeError('baseUrl 只能是 https 网址（本机回环地址可以用 http）');
  }
  return new URL(ENDPOINT, url.href.endsWith('/') ? url.href : `${url.href}/`);
}

// A test for text the service sent back (an echoing proxy or a misconfigured endpoint): true when it holds the key, a run
// of KEY_ECHO_RUN key characters, or is itself a piece of the key of at least 8 characters.
function keyEcho(key: string): (text: string) => boolean {
  const runs = new Set<string>();
  for (let at = 0; at + KEY_ECHO_RUN <= key.length; at++) runs.add(key.slice(at, at + KEY_ECHO_RUN));
  return (text) => {
    if (text.includes(key) || (text.length >= 8 && key.includes(text))) return true;
    for (let at = 0; at + KEY_ECHO_RUN <= text.length; at++) if (runs.has(text.slice(at, at + KEY_ECHO_RUN))) return true;
    return false;
  };
}

/** An RFC 9110 HTTP-date as epoch milliseconds, always GMT; null for anything else (Date.parse reads garbage as dates). */
function httpDate(value: string, now: number): number | null {
  let parts: string[];
  let match = IMF_FIXDATE.exec(value);
  if (match !== null) {
    parts = match.slice(1);
  } else if ((match = RFC850_DATE.exec(value)) !== null) {
    // A two-digit year more than 50 years ahead is the most recent past year with those digits (RFC 9110).
    const current = new Date(now).getUTCFullYear();
    let year = current - (current % 100) + Number(match[3]);
    if (year > current + 50) year -= 100;
    parts = [match[1], match[2], String(year), match[4], match[5], match[6]];
  } else if ((match = ASCTIME_DATE.exec(value)) !== null) {
    parts = [match[2].trim(), match[1], match[6], match[3], match[4], match[5]];
  } else {
    return null;
  }
  const [day, month, year, hour, minute, second] = parts.map((part, index) => (index === 1 ? MONTHS.indexOf(part) : Number(part)));
  const time = Date.UTC(year, month, day, hour, minute, second);
  const check = new Date(time);
  const exact =
    check.getUTCFullYear() === year &&
    check.getUTCMonth() === month &&
    check.getUTCDate() === day &&
    check.getUTCHours() === hour &&
    check.getUTCMinutes() === minute &&
    check.getUTCSeconds() === second;
  return exact ? time : null;
}

/**
 * The wait the service asked for in retry-after-ms or Retry-After (delay seconds or an HTTP date), in milliseconds and
 * not capped; null when absent or unreadable, so the caller falls back to its own backoff.
 */
export function retryAfterMs(headers: Headers, now: number): number | null {
  const ms = headers.get('retry-after-ms')?.trim();
  if (ms && SECONDS.test(ms)) return Math.round(Number(ms));
  const after = headers.get('retry-after')?.trim();
  if (!after) return null;
  if (SECONDS.test(after)) return Math.round(Number(after) * 1000);
  const date = httpDate(after, now);
  return date === null ? null : Math.max(date - now, 0);
}

// A short machine tag of a transport failure (for example ECONNREFUSED); never an error message, which may quote data.
function transportTag(error: unknown): string {
  const cause = error instanceof Error && error.cause !== undefined ? error.cause : error;
  const code = cause !== null && typeof cause === 'object' ? (cause as { code?: unknown }).code : undefined;
  if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,40}$/.test(code)) return code;
  const name = error instanceof Error ? error.name : '';
  return /^[A-Za-z]{1,40}$/.test(name) ? name : '未知原因';
}

async function readBody(response: Response, cap: number, truncate: boolean): Promise<BodyRead> {
  if (response.body === null) return { kind: 'ok', bytes: new Uint8Array(0), truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (size + value.byteLength > cap) {
        await reader.cancel().catch(() => undefined);
        if (!truncate) return { kind: 'too_large' };
        chunks.push(value.subarray(0, cap - size));
        size = cap;
        truncated = true;
        break;
      }
      chunks.push(value);
      size += value.byteLength;
    }
  } catch (error) {
    return { kind: 'error', error };
  }
  return { kind: 'ok', bytes: Buffer.concat(chunks, size), truncated };
}

interface ErrorScan {
  reasons: string[];
  tokenLimit: boolean;
  /** False when the body carried no machine-readable cause at all: nothing about the cause is claimed then. */
  causeObserved: boolean;
}

// The places where an error body names its cause with a machine-readable code: the documented 422 {detail: [{type, msg}]}
// and the usual envelopes {detail: {type, code}}, {error: {type, code, message}} and {type, code, message}. Only these
// structured members are read; a sentence in `detail`, `message` or `msg` names no cause here (owner rule 2026-10-24,
// sweep A81), and request content a body echoes (the documented `input` members, or a gateway's copy of the request) is
// never read.
function causesOf(body: unknown): string[] {
  const codes: string[] = [];
  if (!isPlainObject(body)) return codes;
  const places: unknown[] = [body];
  for (const member of ['detail', 'error']) {
    const value = body[member];
    if (Array.isArray(value)) places.push(...value.slice(0, 64));
    else if (typeof value !== 'string') places.push(value);
  }
  for (const place of places) {
    if (!isPlainObject(place)) continue;
    for (const member of ['type', 'code']) if (typeof place[member] === 'string') codes.push(place[member]);
  }
  return codes;
}

// Reads an error body for machine-readable cause codes only and discards it. A code is taken by exact equality with the
// value the service documents; nothing is searched for in text. A body cut at ERROR_BODY_BYTES is no longer JSON, so it
// carries no observable cause at all.
function scanErrorBody(bytes: Uint8Array): ErrorScan {
  const text = new TextDecoder('utf-8').decode(bytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { reasons: [], tokenLimit: false, causeObserved: false };
  }
  const codes = causesOf(parsed);
  const tokenLimit = codes.includes(TOKEN_LIMIT_MARKER);
  // REASON is this client's own declared shape for a code it echoes back as a diagnostic (lower-case letters, digits,
  // '_' and '.', 1 to 64 characters): it keeps foreign text out of a message. It classifies nothing.
  const reasons = [...new Set(codes.filter((code) => REASON.test(code)))].slice(0, 10);
  if (tokenLimit && !reasons.includes(TOKEN_LIMIT_MARKER)) reasons.push(TOKEN_LIMIT_MARKER);
  return { reasons, tokenLimit, causeObserved: codes.length > 0 };
}

function statusFault(status: number, scan: ErrorScan, requestId: string | null, headers: Headers): Fault {
  const extra = { status, requestId, reasons: scan.reasons, headers };
  if (status === 401 || status === 403) return fault('JEV_UNAUTHORIZED', `Jev 服务拒绝了 API 密钥（HTTP ${status}）`, false, extra);
  if (status === 429) return fault('JEV_RATE_LIMITED', 'Jev 服务限流（HTTP 429）', true, extra);
  if (status === 529) return fault('JEV_RATE_LIMITED', 'Jev 服务过载（HTTP 529）', true, extra);
  if (status === 413) return fault('JEV_TOO_LARGE', 'Jev 请求体过大（HTTP 413）；请拆成更小的请求', false, extra);
  if ((status === 400 || status === 422) && scan.tokenLimit) {
    return fault('JEV_TOO_LARGE', `Jev 请求超过上下文上限（HTTP ${status}，max_tokens_exceeded）；请拆成更小的请求`, false, extra);
  }
  if (status === 408 || status >= 500) return fault('JEV_UNAVAILABLE', `Jev 服务暂不可用（HTTP ${status}）`, true, extra);
  if (status >= 300 && status < 400) {
    return fault('JEV_UNAVAILABLE', `Jev 服务要求重定向（HTTP ${status}），没有跟随；请检查 baseUrl`, false, extra);
  }
  if (status >= 400) {
    const what = status === 422 ? '，请求校验不通过' : '';
    // No machine-readable cause code in the body: say that instead of naming a cause read out of a sentence.
    const cause = scan.causeObserved ? '' : '；正文里没有可核对的结构化原因码，不推断原因（缺的事实：服务的结构化原因码；下一步：缩小请求后重跑，或由集成者向服务方索取带原因码的错误正文）';
    return fault('JEV_BAD_REQUEST', `Jev 服务拒绝了请求（HTTP ${status}${what}）；响应正文可能回显请求内容，不予显示${cause}`, false, extra);
  }
  return fault('JEV_BAD_RESPONSE', `Jev 服务返回了意外的状态（HTTP ${status}）`, false, extra);
}

export class HttpJev implements JevClient {
  readonly pinnedModel: string;
  #onAttempt: HttpJevOptions["onAttempt"];
  #onSending: HttpJevOptions["onSending"];
  #apiKey: () => string | Promise<string>;
  #endpoint: URL;
  #fetch: typeof globalThis.fetch;
  #timeoutMs: number;
  #retries: number;
  #maxRequestBytes: number;
  #maxResponseBytes: number;
  #random: () => number;
  #sleep: (ms: number) => Promise<void>;
  #now: () => number;

  constructor(options: HttpJevOptions) {
    if (options === null || typeof options !== 'object') throw new TypeError('HttpJev 需要选项对象');
    if (typeof options.apiKey !== 'function') throw new TypeError('apiKey 必须是返回 API 密钥的函数');
    this.pinnedModel = checkModel(options.model, false);
    this.#apiKey = options.apiKey;
    this.#onAttempt = options.onAttempt;this.#onSending=options.onSending;
    this.#endpoint = endpointOf(options.baseUrl ?? DEFAULT_BASE_URL);
    if (this.pinnedModel.includes('scripted') && !isLoopback(this.#endpoint.hostname)) throw new JevError('JEV_BAD_REQUEST', 'scripted 版本只能用于本机回环');
    for (const name of ['fetch', 'random', 'sleep', 'now'] as const) {
      if (options[name] !== undefined && typeof options[name] !== 'function') throw new TypeError(`${name} 必须是函数`);
    }
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.#timeoutMs = integerOption(options.timeoutMs, DEFAULT_TIMEOUT_MS, 1, 600_000, 'timeoutMs');
    this.#retries = integerOption(options.retries, DEFAULT_RETRIES, 0, 10, 'retries');
    this.#maxRequestBytes = integerOption(options.maxRequestBytes, DEFAULT_MAX_REQUEST_BYTES, 1, VENDOR_MAX_REQUEST_BYTES, 'maxRequestBytes');
    this.#maxResponseBytes = integerOption(options.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES, 1, 256 * 1024 * 1024, 'maxResponseBytes');
    this.#random = options.random ?? Math.random;
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#now = options.now ?? Date.now;
  }

  async ask(request: JevRequest): Promise<JevResponse> {
    const checked = checkRequest(request, { pinnedModel: this.pinnedModel, maxRequestBytes: this.#maxRequestBytes });
    let sent = 0;
    // The failure of the last request that was sent: the cause when a later attempt fails before sending.
    let previous: Fault | null = null;
    for (;;) {
      let outcome:Outcome;try{outcome=await this.#attempt(checked,sent+1);}catch(error){if(error instanceof JevError)await this.#onAttempt?.({request:checked.request,attempt:sent+1,status:error.status,requestId:error.requestId,result:error.code});throw error;}
      if (outcome.ok || outcome.sent) await this.#onAttempt?.({request:checked.request,attempt:sent+1,status:outcome.ok?200:outcome.status,requestId:outcome.ok?outcome.response.requestId??null:outcome.requestId,result:outcome.ok?'validated':outcome.code});
      if (outcome.ok) return outcome.response;
      let note = '';
      let cause = outcome;
      if (outcome.sent) {
        sent++;
        previous = outcome;
      } else if (previous !== null) {
        cause = previous;
        note = `；重试时${outcome.message}，没有再发送`;
      }
      if (outcome.sent && outcome.retryable && sent <= this.#retries) {
        const asked = outcome.headers === null ? null : retryAfterMs(outcome.headers, this.#now());
        if (asked === null || asked <= MAX_RETRY_AFTER_MS) {
          await this.#sleep(asked ?? this.#backoff(sent - 1));
          continue;
        }
        note = `；服务要求等待 ${Math.ceil(asked / 1000)} 秒，超过最多等待的 ${MAX_RETRY_AFTER_MS / 1000} 秒，没有重试`;
      }
      throw new JevError(cause.code, `${cause.message}${note}${sent > 1 ? `；已尝试 ${sent} 次` : ''}`, {
        status: cause.status,
        requestId: cause.requestId,
        attempts: sent,
        reasons: cause.reasons,
      });
    }
  }

  // Exponential backoff 0.5 s doubling to 5 s, minus up to 25 % jitter, when the service did not ask for a wait.
  #backoff(retryIndex: number): number {
    const base = Math.min(INITIAL_BACKOFF_MS * 2 ** retryIndex, MAX_BACKOFF_MS);
    const r = this.#random();
    const jitter = Number.isFinite(r) ? Math.min(Math.max(r, 0), 1) : 0;
    return Math.round(base * (1 - 0.25 * jitter));
  }

  // The key for one attempt, raced against the attempt's timer. A failure here sends nothing.
  async #key(signal: AbortSignal): Promise<string | Fault> {
    let supplied: unknown;
    try {
      supplied = await new Promise<unknown>((resolve, reject) => {
        const expire = (): void => reject(KEY_TIMEOUT);
        signal.addEventListener('abort', expire, { once: true });
        Promise.resolve()
          .then(() => this.#apiKey())
          .then(resolve, reject)
          .finally(() => signal.removeEventListener('abort', expire));
      });
    } catch (error) {
      const message = error === KEY_TIMEOUT ? `取 Jev API 密钥超时（${this.#timeoutMs} 毫秒）` : '取 Jev API 密钥失败';
      return fault('JEV_UNAUTHORIZED', message, false, { sent: false });
    }
    if (typeof supplied !== 'string' || supplied.length>4096 || !API_KEY.test(supplied)) {
      return fault('JEV_UNAUTHORIZED', 'Jev API 密钥为空或含不允许的字符', false, { sent: false });
    }
    return supplied;
  }

  // One HTTP exchange; its timer runs from asking the key source to reading the body. The key lives only in this scope;
  // a 200 body is parsed and validated here, so anything that carries the key back is refused before it can reach a
  // response, a record or an error.
  async #attempt(checked: CheckedRequest, attempt: number): Promise<Outcome> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.#timeoutMs);
    try {
      const key = await this.#key(controller.signal);
      if (typeof key !== 'string') return key;
      const echoes = keyEcho(key);
      const lost = (error: unknown): Fault =>
        timedOut
          ? fault('JEV_UNAVAILABLE', `Jev 请求超时（${this.#timeoutMs} 毫秒）`, true)
          : fault('JEV_UNAVAILABLE', `连不上 Jev 服务（${transportTag(error)}）`, true);
      await this.#onSending?.({request:checked.request,attempt});
      let response: Response;
      try {
        response = await this.#fetch(this.#endpoint, {
          method: 'POST',
          headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json' },
          body: checked.body,
          redirect: 'manual',
          signal: controller.signal,
        });
      } catch (error) {
        return lost(error);
      }
      if([...response.headers.values()].some(value=>echoes(value))){await response.body?.cancel().catch(()=>{});return fault('JEV_BAD_RESPONSE','Jev 应答头回显密钥，整份丢弃',false,{status:response.status});}
      const header = response.headers.get(REQUEST_ID_HEADER);
      const requestId = header !== null && REQUEST_ID.test(header) && !echoes(header) ? header : null;
      const status = response.status;
      if (status !== 200) {
        const read = await readBody(response, ERROR_BODY_BYTES, true);
        if(read.kind==='ok'){const text=new TextDecoder().decode(read.bytes);if(echoes(text))return fault('JEV_BAD_RESPONSE','Jev 应答回显密钥，整份丢弃',false,{status,requestId});try{if(echoes(JSON.stringify(JSON.parse(text))))return fault('JEV_BAD_RESPONSE','Jev 应答回显密钥，整份丢弃',false,{status,requestId});}catch{}}
        const scan = read.kind === 'ok' ? scanErrorBody(read.bytes) : { reasons: [], tokenLimit: false, causeObserved: false };
        scan.reasons = scan.reasons.filter((reason) => !echoes(reason));
        return statusFault(status, scan, requestId, response.headers);
      }
      const read = await readBody(response, this.#maxResponseBytes, false);
      if (read.kind === 'error') return lost(read.error);
      if (read.kind === 'too_large') {
        return fault('JEV_BAD_RESPONSE', `Jev 响应超过 ${this.#maxResponseBytes} 字节`, false, { status, requestId });
      }
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(read.bytes);
      } catch {
        return fault('JEV_BAD_RESPONSE', 'Jev 响应不合格：不是合法的 UTF-8', false, { status, requestId });
      }
      const echoed = fault('JEV_BAD_RESPONSE', 'Jev 响应不合格：响应里出现了 API 密钥，已整体丢弃', false, { status, requestId });
      if (echoes(text)) return echoed;
      const context: ResponseContext = { pinnedModel: this.pinnedModel, requestId, attempts: attempt, status };
      let validated: JevResponse;
      try {
        const parsed=parseResponseText(text,context);if(echoes(JSON.stringify(parsed)))return echoed;
        validated = checkResponse(checked.request, parsed, context);
      } catch (error) {
        // Validation messages quote nothing the service sent; the check stays as a guard.
        if (error instanceof JevError && !echoes(error.message)) throw error;
        return echoed;
      }
      // An escaped echo decodes into the parsed values; the JSON text of the result shows any run of the key verbatim.
      if (echoes(JSON.stringify(validated))) return echoed;
      return { ok: true, response: validated };
    } finally {
      clearTimeout(timer);
    }
  }
}
