// Local tool retry wrappers for Hub HTTP calls without modifying the embedded run-tools skill module.
import { lstat, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  HubReplyError,
  knowledgeFiles,
  sha256,
  writeNew,
  type RunKnowledge,
} from './generated/skills/run-tools/hub-client/index.ts';
import { isRecord, failCall, CallFailure, formatCallError } from './text.ts';
import { localSourceCache } from './source-cache.ts';
import { assertEmptySourceOutput, sourceMaterialNames, type SourceMaterial } from './source-materials.ts';
export { sourceFileName } from './source-materials.ts';

export const MAX_BYTES = 16 * 1024 * 1024;
export const KNOWLEDGE_MAX_BYTES = 256 * 1024 * 1024;
export const READ_TIMEOUT_MS = 120_000;
export const KNOWLEDGE_TIMEOUT_MS = 300_000;
export const SUBMIT_TIMEOUT_MS = 300_000;
export const READ_RETRY_BUDGET_MS = 60_000;
export const SUBMIT_RETRY_BUDGET_MS = 60_000;
export const BACKOFF_STEPS_MS: readonly number[] = [2_000, 4_000, 8_000];
export const RETRY_BODY_MARKER = '这次调用没有执行';
const MAX_ZERO_DELAY_RETRIES = 3;

const SOURCE_REFERENCE = /^src:([0-9a-f]{64})(?:\/|$)/;
const json = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + '\n');

export interface RetryTiming {
  now: () => number;
  pause: (ms: number) => Promise<void>;
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface RetryControl {
  timing?: RetryTiming;
  fetch?: FetchLike;
  maxWaitMs?: number;
  timeoutMs?: number;
  /** Explicit cache location after a fresh run read; false disables local reuse. */
  sourceCacheDirectory?: string | false;
}

export const DEFAULT_TIMING: RetryTiming = {
  now: () => Date.now(),
  pause: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** 503 reply carrying optional parsed Retry-After duration and concise fact summary. */
export class TransientHubReplyError extends HubReplyError {
  readonly retryAfterMs: number | null;
  readonly summary: string;

  constructor(status: number, summary: string, retryAfterMs: number | null) {
    super(status, summary);
    this.name = 'TransientHubReplyError';
    this.retryAfterMs = retryAfterMs;
    this.summary = summary;
  }
}

/** Transient Hub outage or rate-limit rejection that exceeded the configured wait ceiling. */
export class RetryExhaustedError extends CallFailure {
  readonly status?: number;
  readonly code?: string;
  readonly waitedMs: number;
  readonly attempts: number;

  constructor(failure: CallFailure, details: { status?: number; code?: string; waitedMs: number; attempts: number; cause?: unknown }) {
    super(failure.category, failure.fact, failure.next_action);
    this.message = formatCallError(failure);
    if (details.cause !== undefined) Object.defineProperty(this, 'cause', { value: details.cause });
    this.name = 'RetryExhaustedError';
    this.status = details.status;
    this.code = details.code;
    this.waitedMs = details.waitedMs;
    this.attempts = details.attempts;
  }
}

function errorWithCode(fact: string, next: string, code?: string, cause?: unknown): Error {
  const failure = new CallFailure('temporarily_unavailable', fact, next);
  failure.message = formatCallError(failure);
  if (cause !== undefined) Object.defineProperty(failure, 'cause', { value: cause });
  return Object.assign(failure, code ? { code } : {});
}

function formatSecondsValue(ms: number): string {
  if (ms <= 0) return '0';
  if (ms < 100) return '0.1';
  const rounded = Math.round(ms / 100) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function directErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && code.length > 0 ? code : undefined;
}

export function extractErrorCode(error: unknown, seen = new Set<unknown>()): string | undefined {
  if (typeof error !== 'object' || error === null || seen.has(error)) return undefined;
  seen.add(error);
  const direct = directErrorCode(error);
  if (direct) return direct;
  const errors = (error as { errors?: unknown }).errors;
  if (Array.isArray(errors)) {
    for (const inner of errors) {
      const code = extractErrorCode(inner, seen);
      if (code === 'ECONNREFUSED') return 'ECONNREFUSED';
    }
    for (const inner of errors) {
      const code = extractErrorCode(inner, seen);
      if (code) return code;
    }
  }
  const cause = (error as { cause?: unknown }).cause;
  return cause !== undefined ? extractErrorCode(cause, seen) : undefined;
}

export function isConnectionRefused(error: unknown, stack = new Set<unknown>()): boolean {
  if (typeof error !== 'object' || error === null || stack.has(error)) return false;
  stack.add(error);
  try {
    if (directErrorCode(error) === 'ECONNREFUSED') return true;
    const errors = (error as { errors?: unknown }).errors;
    if (Array.isArray(errors) && errors.length > 0) {
      // Handle Happy Eyeballs AggregateError on localhost (::1 + 127.0.0.1) without treating post-connect errors as refused.
      const allPreConnect = errors.every((inner) => isConnectionRefused(inner, stack) || directErrorCode(inner) === 'EADDRNOTAVAIL');
      const anyRefused = errors.some((inner) => isConnectionRefused(inner, stack));
      if (allPreConnect && anyRefused) return true;
    }
    const cause = (error as { cause?: unknown }).cause;
    return cause !== undefined ? isConnectionRefused(cause, stack) : false;
  } finally {
    stack.delete(error);
  }
}

function networkReasonText(error: unknown): string {
  const code = extractErrorCode(error);
  if (code) return code.slice(0, 120);
  if (error instanceof Error && error.message) return error.message.slice(0, 120);
  return '未知原因';
}

function sanitizeSnippet(text: string): string {
  return text.trim().replace(/[。\r\n]+/g, '；').slice(0, 300);
}

/** Parses HTTP Retry-After (non-negative seconds or HTTP-date relative to `nowMs`); returns null when absent or invalid. */
export function parseRetryAfterMs(header: string | null, nowMs: number): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (!trimmed) return null;
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds * 1000) : null;
  }
  if (!/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)[, ]/i.test(trimmed)) {
    return null;
  }
  const timestamp = Date.parse(trimmed);
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, timestamp - nowMs);
}

function backoffStepMs(index: number): number {
  return BACKOFF_STEPS_MS[Math.min(index, BACKOFF_STEPS_MS.length - 1)];
}

type WaitDecision =
  | { retry: true; waitMs: number }
  | { retry: false; reason: 'exceeds_budget'; elapsedMs: number; requestedMs: number }
  | { retry: false; reason: 'exhausted'; elapsedMs: number };

function decideRetryWait(
  retryAfterMs: number | null,
  elapsedMs: number,
  maxWaitMs: number,
  state: { backoffIndex: number; zeroDelayRetries: number },
): WaitDecision {
  const remainingMs = Math.max(0, maxWaitMs - elapsedMs);
  if (remainingMs <= 0) return { retry: false, reason: 'exhausted', elapsedMs };
  if (retryAfterMs !== null) {
    if (retryAfterMs > remainingMs) {
      return { retry: false, reason: 'exceeds_budget', elapsedMs, requestedMs: retryAfterMs };
    }
    if (retryAfterMs === 0) {
      if (state.zeroDelayRetries < MAX_ZERO_DELAY_RETRIES) {
        state.zeroDelayRetries++;
        return { retry: true, waitMs: 0 };
      }
      // Guard against infinite zero-delay loops by falling through to bounded backoff without resetting zeroDelayRetries.
    } else {
      state.zeroDelayRetries = 0;
      return { retry: true, waitMs: retryAfterMs };
    }
  } else {
    state.zeroDelayRetries = 0;
  }
  const stepMs = backoffStepMs(state.backoffIndex++);
  return { retry: true, waitMs: Math.min(stepMs, remainingMs) };
}

function readExhaustedMessage(
  factSummary: string,
  attempts: number,
  maxWaitMs: number,
  decision: Extract<WaitDecision, { retry: false }>,
): CallFailure {
  if (decision.reason === 'exceeds_budget') {
    return new CallFailure('temporarily_unavailable', `${factSummary}，已等待 ${formatSecondsValue(decision.elapsedMs)} 秒并尝试 ${attempts} 次，Hub 要求等待 ${formatSecondsValue(decision.requestedMs)} 秒超过最多等待 ${formatSecondsValue(maxWaitMs)} 秒上限`, '请等待 Hub 恢复后用同一命令重试');
  }
  return new CallFailure('temporarily_unavailable', `${factSummary}，已等待 ${formatSecondsValue(decision.elapsedMs)} 秒并尝试 ${attempts} 次仍未恢复`, '请等待 Hub 恢复或确认网络可达后用同一命令重试');
}

/** Single GET attempt without retry; throws `TransientHubReplyError` on 503 with parsed `Retry-After`. */
export async function fetchBytesOnce(
  url: string,
  bearer: string,
  limit: number,
  options?: { fetch?: FetchLike; timeoutMs?: number; timing?: RetryTiming; oversizeMessage?: string },
): Promise<{ bytes: Uint8Array; digest: string | null }> {
  const fetchFn = options?.fetch ?? fetch;
  const timeoutMs = options?.timeoutMs ?? READ_TIMEOUT_MS;
  const nowMs = (options?.timing ?? DEFAULT_TIMING).now();

  let reply: Response;
  let connected = false;
  try {
    reply = await fetchFn(url, {
      headers: { authorization: `Bearer ${bearer}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    connected = true;
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw errorWithCode(`Hub ${formatSecondsValue(timeoutMs)} 秒内没有答复`, '请稍后用同一命令重试', 'ETIMEDOUT', error);
    }
    if (isConnectionRefused(error)) {
      throw errorWithCode('Hub 不可达（ECONNREFUSED）', '请确认 --hub 地址与网络连接后用同一命令重试', 'ECONNREFUSED', error);
    }
    const reason = networkReasonText(error);
    throw errorWithCode(`未取得 Hub 答复（${reason}）`, '请核对 --hub 地址与网络可达后用同一命令重试', extractErrorCode(error), error);
  }

  if (reply.status === 503) {
    const retryAfterMs = parseRetryAfterMs(reply.headers.get('retry-after'), nowMs);
    let snippet = '';
    try { snippet = sanitizeSnippet(await reply.text()); } catch { snippet = ''; }
    const summary = snippet ? `Hub 答复 503：${snippet}` : 'Hub 答复 503';
    throw new TransientHubReplyError(503, summary, retryAfterMs);
  }

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await reply.arrayBuffer());
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw errorWithCode(`Hub ${formatSecondsValue(timeoutMs)} 秒内没有传完答复`, '请稍后用同一命令重试', 'ETIMEDOUT', error);
    }
    const reason = networkReasonText(error);
    throw errorWithCode(`未完整取得 Hub 答复（${reason}）`, '请稍后用同一命令重试', extractErrorCode(error), error);
  }

  if (!reply.ok) {
    const snippet = sanitizeSnippet(new TextDecoder().decode(bytes));
    throw new HubReplyError(reply.status, `Hub 答复 ${reply.status}：${snippet}`);
  }
  if (bytes.length > limit) {
    failCall('invalid_parameters', options?.oversizeMessage ?? `Hub 答复超过 ${Math.floor(limit / (1024 * 1024))} MiB 上限`, '按本次读取限额缩小来源，或由维护者核对声明后重试');
  }
  const digest = /^sha-256=:([A-Za-z0-9+/=]+):$/.exec(reply.headers.get('content-digest') ?? '');
  return { bytes, digest: digest ? Buffer.from(digest[1], 'base64').toString('hex') : null };
}

export async function getOnce(
  url: string,
  bearer: string,
  options?: { fetch?: FetchLike; timeoutMs?: number; timing?: RetryTiming },
): Promise<Uint8Array> {
  return (await fetchBytesOnce(url, bearer, MAX_BYTES, options)).bytes;
}

/** Metadata reads are never cached; each download still authenticates its current run. */
export function downloadRetryControl(_out: string, control?: RetryControl): RetryControl {
  return { ...control, sourceCacheDirectory: control?.sourceCacheDirectory ?? join(tmpdir(), `circle-hub-source-cache-${process.getuid!()}`) };
}

/** Retries read-only Hub GETs on HTTP 503 or ECONNREFUSED using Retry-After or 2/4/8s backoff up to 60s total. */
export async function fetchBytesRetrying(
  url: string,
  bearer: string,
  limit: number,
  control?: RetryControl & { oversizeMessage?: string },
): Promise<{ bytes: Uint8Array; digest: string | null; cached?: true }> {
  const cache = localSourceCache(url, bearer, limit, control?.sourceCacheDirectory);
  const hit = await cache?.load();
  if (hit) return { bytes: hit, digest: null, cached: true };
  const timing = control?.timing ?? DEFAULT_TIMING;
  const maxWaitMs = control?.maxWaitMs ?? READ_RETRY_BUDGET_MS;
  const startedAt = timing.now();
  const state = { backoffIndex: 0, zeroDelayRetries: 0 };
  let attempts = 0;

  while (true) {
    attempts++;
    try {
      const result = await fetchBytesOnce(url, bearer, limit, {
        fetch: control?.fetch,
        timeoutMs: control?.timeoutMs ?? READ_TIMEOUT_MS,
        timing,
        oversizeMessage: control?.oversizeMessage,
      });
      if (cache && sha256(result.bytes) !== cache.digest) failCall('invalid_parameters', '来源字节与运行绑定摘要不一致', '重新获取与声明摘要一致的原件，核对运行绑定后重试');
      if (cache && result.digest !== null && result.digest !== sha256(result.bytes)) failCall('invalid_parameters', '来源响应的摘要头与字节不一致', '恢复摘要头与来源字节一致的原件后重试');
      await cache?.save(result.bytes);
      return result;
    } catch (error) {
      const transient = error instanceof TransientHubReplyError;
      const refused = isConnectionRefused(error);
      if (!transient && !refused) throw error;

      const elapsedMs = Math.max(0, timing.now() - startedAt);
      const retryAfterMs = transient ? error.retryAfterMs : null;
      const decision = decideRetryWait(retryAfterMs, elapsedMs, maxWaitMs, state);
      if (!decision.retry) {
        const fact = transient ? error.summary : 'Hub 不可达（ECONNREFUSED）';
        throw new RetryExhaustedError(
          readExhaustedMessage(fact, attempts, maxWaitMs, decision),
          {
            status: transient ? 503 : undefined,
            code: refused ? 'ECONNREFUSED' : undefined,
            waitedMs: decision.elapsedMs,
            attempts,
            cause: error,
          },
        );
      }
      await timing.pause(decision.waitMs);
    }
  }
}

export async function getRetrying(url: string, bearer: string, control?: RetryControl): Promise<Uint8Array> {
  return (await fetchBytesRetrying(url, bearer, MAX_BYTES, control)).bytes;
}

/** Downloads run.json, items/*, sources/*, and locked knowledge/* using retrying read calls before writing disk. */
export async function downloadRunRetrying(
  origin: string,
  bearer: string,
  run: string,
  out: string,
  control?: RetryControl,
): Promise<{ run: string; out: string; items: number; sources: number; withheld: string[]; knowledge: RunKnowledge | null; files: Record<string, string> }> {
  await assertEmptySourceOutput(out);
  const raw = await getRetrying(`${origin}/run-export/${run}/run`, bearer, control);
  let exported: unknown;
  try {
    exported = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
  } catch {
    failCall('invalid_parameters', 'Hub 的运行导出不是完整的 UTF-8 JSON', '重新下载完整运行导出，核对编码与协议版本后重试');
  }
  if (!isRecord(exported) || exported.schema !== 'run-export@1' || !isRecord(exported.run)) failCall('invalid_parameters', 'Hub 的运行导出不合式', '按 run-export@1 核对运行导出与协议版本后重新下载');
  const record = exported.run;
  if (record.run !== run) failCall('invalid_parameters', 'Hub 导出的运行不是 --run 指定的运行，什么都没有写入', '核对本次运行号和导出身份后重新下载');
  const items = Array.isArray(record.items) ? record.items : [];
  const bindings = Array.isArray(record.sources) ? record.sources.filter(isRecord) : [];
  const outputs: Array<{ name: string; bytes: Uint8Array }> = [{ name: 'run.json', bytes: json(record) }];
  const width = String(Math.max(items.length - 1, 0)).length;
  items.forEach((item, index) => outputs.push({ name: join('items', `${String(index).padStart(width, '0')}.json`), bytes: json(item) }));

  const readControl = downloadRetryControl(out, control);
  const fetched = new Map<string, Uint8Array | 'withheld'>();
  const names = sourceMaterialNames(bindings);
  const manifest: SourceMaterial[] = [];
  const withheld: string[] = [];
  for (const [index, binding] of bindings.entries()) {
    const digest = SOURCE_REFERENCE.exec(String(binding.reference))?.[1];
    if (typeof binding.reference !== 'string') failCall('invalid_parameters', '来源清单缺少可核验的引用身份', '重新下载正确运行记录，按原声明绑定来源后重试');
    if (!digest) { manifest.push({ slot: typeof binding.slot === 'string' ? binding.slot : null, role: typeof binding.role === 'string' ? binding.role : null, reference: binding.reference, label: typeof binding.label === 'string' ? binding.label : null, media_type: typeof binding.media_type === 'string' ? binding.media_type : null, file: null, sha256: null }); continue; }
    if (!fetched.has(digest)) {
      try {
        const bytes = await getRetrying(`${origin}/run-export/${run}/sources/${digest}`, bearer, readControl);
        if (sha256(bytes) !== digest) failCall('invalid_parameters', '来源字节与运行绑定摘要不一致', '重新获取与声明摘要一致的原件后重试');
        fetched.set(digest, bytes);
      } catch (error) {
        if (!(error instanceof HubReplyError && error.status === 403)) throw error;
        fetched.set(digest, 'withheld'); withheld.push(digest);
      }
    }
    const bytes = fetched.get(digest)!;
    const file = bytes === 'withheld' ? null : names[index];
    if (file && !outputs.some(output => output.name === file)) outputs.push({ name: file, bytes: bytes as Uint8Array });
    manifest.push({ slot: typeof binding.slot === 'string' ? binding.slot : null, role: typeof binding.role === 'string' ? binding.role : null, reference: String(binding.reference), label: typeof binding.label === 'string' ? binding.label : null, media_type: typeof binding.media_type === 'string' ? binding.media_type : null, file, sha256: digest, ...(bytes === 'withheld' ? { withheld: '你的读取层级不给这份原件的字节' } : {}) });
  }
  outputs.push({ name: 'sources.json', bytes: json(manifest) });

  let knowledge: RunKnowledge | null = null;
  try {
    const batch = await fetchBytesRetrying(`${origin}/run-export/${run}/knowledge`, bearer, KNOWLEDGE_MAX_BYTES, control);
    if (batch.digest === null || sha256(batch.bytes) !== batch.digest) failCall('invalid_parameters', '知识根的字节与 Hub 给的摘要不符，什么都没有写入', '按绑定摘要恢复知识根原件，核对完整性后重新下载');
    let made: ReturnType<typeof knowledgeFiles>;
    try { made = knowledgeFiles(batch.bytes, run); } catch (error) { failCall('invalid_parameters', error instanceof Error ? error.message : '知识根批量资料格式不完整', '按锁定运行与知识根声明恢复完整批量资料后重试'); }
    outputs.push(...made.outputs);
    knowledge = made.knowledge;
  } catch (error) {
    if (!(error instanceof HubReplyError && error.status === 404)) throw error;
  }

  const present = await readdir(out).catch(() => []);
  if (present.length) failCall('occupied', '输出目录在下载期间出现已有文件，不覆盖', '另选新的空目录下载', { path: out });
  await mkdir(join(out, 'items'), { recursive: true, mode: 0o700 });
  await mkdir(join(out, 'sources'), { recursive: true, mode: 0o700 });
  if (knowledge) await mkdir(join(out, 'knowledge'), { recursive: true, mode: 0o700 });
  const files: Record<string, string> = {};
  const written: string[] = [];
  try {
    for (const { name, bytes } of outputs) {
      const path = join(out, name);
      await writeNew(path, bytes);
      written.push(path);
      files[name] = sha256(bytes);
    }
  } catch (error) {
    await Promise.all(written.map((path) => rm(path, { force: true })));
    throw error;
  }
  return {
    run,
    out,
    items: items.length,
    sources: [...fetched.values()].filter(value => value !== 'withheld').length,
    withheld,
    knowledge,
    files,
  };
}

function submitExhaustedMessage(
  factSummary: string,
  attempts: number,
  maxWaitMs: number,
  decision: Extract<WaitDecision, { retry: false }>,
): CallFailure {
  if (decision.reason === 'exceeds_budget') {
    return new CallFailure('temporarily_unavailable', `${factSummary}（这次提交没有执行），已等待 ${formatSecondsValue(decision.elapsedMs)} 秒并尝试 ${attempts} 次，Hub 要求等待 ${formatSecondsValue(decision.requestedMs)} 秒超过最多等待 ${formatSecondsValue(maxWaitMs)} 秒上限`, '请等待 Hub 恢复后原样重交');
  }
  return new CallFailure('temporarily_unavailable', `${factSummary}（这次提交没有执行），已等待 ${formatSecondsValue(decision.elapsedMs)} 秒并尝试 ${attempts} 次仍未恢复`, '请待 Hub 恢复后原样重交');
}

/**
 * Calls MCP `tools/call` (`submit_result`), retrying ONLY when Hub explicitly returns 503 with `"这次调用没有执行"`.
 * On connection refused, mid-connection disconnect, timeout, or ambiguous HTTP failure, never retries automatically.
 */
export async function submitResultRetrying(
  origin: string,
  bearer: string,
  submission: unknown,
  control?: RetryControl,
): Promise<{ text: string; failed: boolean }> {
  const fetchFn = control?.fetch ?? fetch;
  const timing = control?.timing ?? DEFAULT_TIMING;
  const timeoutMs = control?.timeoutMs ?? SUBMIT_TIMEOUT_MS;
  const maxWaitMs = control?.maxWaitMs ?? SUBMIT_RETRY_BUDGET_MS;
  const payload = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'submit_result', arguments: submission },
  });
  const startedAt = timing.now();
  const state = { backoffIndex: 0, zeroDelayRetries: 0 };
  let attempts = 0;

  while (true) {
    attempts++;
    let reply: Response;
    let body: string;
    try {
      reply = await fetchFn(`${origin}/mcp`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${bearer}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: payload,
        signal: AbortSignal.timeout(timeoutMs),
      });
      body = await reply.text();
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw errorWithCode(
          `Hub ${formatSecondsValue(timeoutMs)} 秒内没有答复，核验可能还在进行，没有自动重发`, '请先查回原调用读运行记录确认是否已受理再决定是否重交',
          'ETIMEDOUT',
          error,
        );
      }
      if (isConnectionRefused(error)) {
        throw errorWithCode(
          'Hub 不可达（ECONNREFUSED），连接被拒且提交未确认，没有自动重发', '请先查回原调用或确认 Hub 恢复后再决定是否重交',
          'ECONNREFUSED',
          error,
        );
      }
      const reason = networkReasonText(error);
      throw errorWithCode(
        `未完整取得提交答复（${reason}），这次提交结果不明，没有自动重发`, '请先查回原调用确认是否已受理再决定是否重交',
        extractErrorCode(error),
        error,
      );
    }

    if (reply.status === 503 && body.includes(RETRY_BODY_MARKER)) {
      const retryAfterMs = parseRetryAfterMs(reply.headers.get('retry-after'), timing.now());
      const elapsedMs = Math.max(0, timing.now() - startedAt);
      const decision = decideRetryWait(retryAfterMs, elapsedMs, maxWaitMs, state);
      const snippet = sanitizeSnippet(body);
      const summary = snippet ? `Hub 答复 503：${snippet}` : 'Hub 答复 503';
      if (!decision.retry) {
        throw new RetryExhaustedError(submitExhaustedMessage(summary, attempts, maxWaitMs, decision), {
          status: 503,
          waitedMs: decision.elapsedMs,
          attempts,
        });
      }
      await timing.pause(decision.waitMs);
      continue;
    }

    if (!reply.ok) {
      const snippet = sanitizeSnippet(body);
      const summary = snippet ? `Hub 答复 ${reply.status}：${snippet}` : `Hub 答复 ${reply.status}`;
      if (reply.status === 503) {
        failCall('temporarily_unavailable', `${summary}，未能确认这次调用是否执行，没有自动重发`, '请先查回原调用确认是否已受理再决定是否重交');
      }
      if (reply.status >= 500 || reply.status === 408 || reply.status === 429) {
        failCall('temporarily_unavailable', `${summary}，提交结果不明，没有自动重发`, '请先查回原调用确认是否已受理再决定是否重交');
      }
      throw new HubReplyError(reply.status, summary);
    }

    let answer: unknown;
    try {
      answer = JSON.parse(body);
    } catch {
      failCall('temporarily_unavailable', 'Hub 的答复不是完整的 JSON，提交结果不明，没有自动重发', '请先查回原调用确认是否已受理再决定是否重交');
    }
    if (isRecord(answer) && isRecord(answer.error)) {
      failCall('temporarily_unavailable', `Hub 以 JSON-RPC code ${typeof answer.error.code === 'number' ? answer.error.code : '未声明'} 拒绝本次调用`, '请核对原调用的结构化 RPC 错误和运行记录；没有明确未执行证明时先查回原调用，不自动重发');
    }
    const result = isRecord(answer) && isRecord(answer.result) ? answer.result : null;
    const content = Array.isArray(result?.content) ? result.content : [];
    const text = content.flatMap((part) => (isRecord(part) && typeof part.text === 'string' ? [part.text] : [])).join('\n');
    if (result === null || !text) failCall('temporarily_unavailable', 'Hub 的答复没有文字内容，提交结果未确认', '请先查回原调用的运行记录确认结果，不自动重交');
    return { text, failed: result.isError === true };
  }
}

/**
 * Reads the bearer token from standard input; returns empty immediately on a TTY
 * so interactive mistakes fail immediately with same-line heredoc guidance instead of hanging.
 */
export async function readTokenFromStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8').trim();
}

/**
 * Validates the bearer token from standard input, refusing unexpanded Circle secret placeholders
 * and empty/malformed stdin caused by missing <<'EOF' or inserting a newline before <<'EOF'.
 */
export async function requireBearerToken(readToken: () => Promise<string> = readTokenFromStdin): Promise<string> {
  const bearer = await readToken();
  const placeholder = /^%([A-Z][A-Z0-9_]*)%$/.exec(bearer);
  if (placeholder) {
    failCall('permission_denied', `Circle 里没有存密钥 ${placeholder[1]}（标准输入收到的是原样的占位符），什么都没有发出`, `请所有者/管理员用 /secrets ${placeholder[1]} 存入 Hub 令牌后，再重跑本命令`);
  }
  if (!/^[\x21-\x7e]{8,4096}$/.test(bearer)) {
    const detail = bearer.length
      ? '标准输入收到的令牌包含空白、换行或长度不在 8..4096 可见 ASCII 范围内'
      : "标准输入为空，常见原因是 node 命令行与 <<'EOF' 之间多打了换行或漏了 <<'EOF'";
    failCall('invalid_parameters', `标准输入里没有令牌（${detail}）`, `请把 node 命令行与 <<'EOF' 写在同一行（空格隔开，切勿在 <<'EOF' 前换行），下一行只写 %HUB_TOKEN%，再一行只写 EOF`);
  }
  return bearer;
}

export interface SubmittedItemFilesOptions {
  flag: string;
  itemKind: string;
  repairHint: string;
  validateItem: (value: unknown, fileName: string) => { [key: string]: unknown };
}

/** Reads a single regular file up to 16 MiB for a CLI `--<flag>` path without "re-export raw bytes" advice. */
export async function readSubmittedFileBytes(filePath: string, flag: string): Promise<Buffer> {
  const info = await lstat(filePath);
  if (info.isSymbolicLink() || !info.isFile()) failCall('invalid_parameters', `--${flag} 指定的路径不是普通文件`, `请为 --${flag} 提供工作目录内的普通文件后重试`, { path: filePath });
  if (info.size > MAX_BYTES) failCall('invalid_parameters', `--${flag} 文件超过 16 MiB 上限`, '请拆分或精简该文件后重试', { path: filePath });
  const bytes = await readFile(filePath);
  if (bytes.length > MAX_BYTES) failCall('invalid_parameters', `--${flag} 文件超过 16 MiB 上限`, '请拆分或精简该文件后重试', { path: filePath });
  return bytes;
}

/** Parses UTF-8 JSON bytes for a model-authored submission file, naming `--<flag>` and `<fileName>`. */
export function parseSubmittedJson(
  flag: string,
  fileName: string,
  bytes: Uint8Array,
  repairHint: string,
): unknown {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    failCall('invalid_parameters', `--${flag} 目录下的 ${fileName} 不是有效的 UTF-8 JSON 文本`, `请检查编码并用 UTF-8 重写该文件后${repairHint}`, { path: fileName });
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : '无法解析';
    const at = /position (\d+)/.exec(message);
    const position = at ? Number(at[1]) : null;
    const around =
      position === null
        ? ''
        : `；出错位置第 ${position} 个字符，附近原文：${JSON.stringify(text.slice(Math.max(0, position - 60), position + 20))}`;
    failCall('invalid_parameters', `--${flag} 目录下的 ${fileName} 不是合法的 UTF-8 JSON（${message}）${around}`, `请按 JSON 格式修改该文件后${repairHint}`, { path: fileName });
  }
}

/**
 * Reads and validates every `.json` submission file under `directory` in sorted filename order.
 * Uses caller-declared `--<flag>` and item validator so `--records` errors never report `--plans`.
 */
export async function readSubmittedItemFiles(
  directory: string,
  options: SubmittedItemFilesOptions,
): Promise<Array<{ [key: string]: unknown }>> {
  const names = (await readdir(directory)).filter(name => name.endsWith('.json')).sort();
  if (!names.length) failCall('not_found', `--${options.flag} 目录里没有 .json 文件`, `请先写入${options.itemKind} JSON 文件再${options.repairHint}`, { path: directory });
  const items: Array<{ [key: string]: unknown }> = [];
  const seen = new Map<string, string>();
  for (const name of names) {
    const bytes = await readSubmittedFileBytes(join(directory, name), options.flag);
    const parsed = parseSubmittedJson(options.flag, name, bytes, options.repairHint);
    const validated = options.validateItem(parsed, name);
    const itemId = validated.item;
    if (typeof itemId !== 'string' || !itemId) {
      failCall('invalid_parameters', `--${options.flag} 目录下的 ${name} 缺少非空字符串字段 "item"`, `请补齐后${options.repairHint}`, { path: name });
    }
    const earlier = seen.get(itemId);
    if (earlier !== undefined) {
      failCall('occupied', `${earlier} 和 ${name} 是同一个条目`, '每个条目只留一个文件后重试', { path: name });
    }
    seen.set(itemId, name);
    items.push(validated);
  }
  return items;
}
