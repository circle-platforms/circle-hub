import { X509Certificate } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import type { TLSSocket } from 'node:tls';
import { URL } from 'node:url';
import { PlumbDiskCache, buildCacheKey } from './cache.ts';
import { PLUMB_GATEWAY_LIMITS, describePlumbRequestLimits, estimateExpandedPairs, planPlumbBatches } from './gateway-limits.ts';
import {
  appendPrivateLine,
  redactSecret,
  sha256Hex,
  stableStringify,
} from './redact.ts';
import {
  PlumbHttpError,
  formatPlumbCallError,
  type CallErrorCategory,
  type PlumbAnswer,
  type PlumbAnyJudgeResponse,
  type PlumbAuditRecord,
  type PlumbBatchAnswer,
  type PlumbBatchJudgeResponse,
  type PlumbBatchQuestion,
  type PlumbClientConfig,
  type PlumbGate,
  type PlumbJudgeRequest,
  type PlumbJudgeResponse,
  type PlumbKeyClaimResponse,
  type PlumbKeyRequestResponse,
  type PlumbModelsResponse,
  type PlumbNormalizedAnswer,
  type PlumbStatusResponse,
  type PlumbSystemOneRequest,
  type PlumbTiming,
  type PlumbWakeResponse,
} from './types.ts';

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_WAKE_TIMEOUT_MS = 720_000;
const DEFAULT_WAKE_POLL_MS = 5_000;
const DEFAULT_MAX_CONCURRENT = PLUMB_GATEWAY_LIMITS.maxConcurrentPerKey;
const DEFAULT_MAX_RPM = 60;
const DEFAULT_MAX_BODY_BYTES = PLUMB_GATEWAY_LIMITS.maxBodyBytes;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_CA_FILE_BYTES = 2 * 1024 * 1024;
const GET_BACKOFF_MS: readonly number[] = [1_000, 2_000, 4_000];
const MAX_POST_RATE_LIMIT_WAIT_MS = 15_000;

export const DEFAULT_PLUMB_TIMING: PlumbTiming = {
  now: () => Date.now(),
  pause: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
};

function isLoopbackHost(hostname: string): boolean {
  const lower = hostname.toLowerCase().replace(/\.+$/u, '');
  if (lower === 'localhost' || lower.endsWith('.localhost') || lower === '[::1]' || lower === '::1') return true;
  return /^127(?:\.\d{1,3}){3}$/u.test(lower);
}

export function validatePlumbBaseUrl(rawUrl: string, allowInsecureHttp = false): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    throw new Error(formatPlumbCallError('参数无效', '未提供 Plumb 网关地址（--base-url 或 PLUMB_BASE_URL）', '请配置有效网关地址后重试'));
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(formatPlumbCallError('参数无效', `网关地址格式无效（${redactSecret(trimmed)}）`, '请传入合法的 http(s) URL'));
  }
  if (parsed.username || parsed.password) {
    throw new Error(formatPlumbCallError('参数无效', '网关 URL 不允许包含内嵌用户名或密码', '请改用环境变量或 --key-stdin 传入 API Key'));
  }
  if (parsed.search || parsed.hash) {
    throw new Error(formatPlumbCallError('参数无效', '网关基准地址不允许包含查询参数或片段', '请仅保留协议、主机、端口与可选基础路径'));
  }
  if (parsed.protocol === 'https:') {
    return trimmed.replace(/\/+$/u, '');
  }
  if (parsed.protocol === 'http:') {
    if (!isLoopbackHost(parsed.hostname) && !allowInsecureHttp) {
      throw new Error(
        formatPlumbCallError(
          '无权限',
          `非回环地址禁止使用明文 HTTP（${parsed.hostname}）`,
          '请改用 https:// 与 --ca-file（或显式启用非安全本地调试选项）',
        ),
      );
    }
    return trimmed.replace(/\/+$/u, '');
  }
  throw new Error(formatPlumbCallError('参数无效', `不支持的网关协议 ${parsed.protocol}`, '仅支持 https:（及回环地址 http:）'));
}

export function normalizeCaSha256(raw?: string): string | undefined {
  if (!raw || !raw.trim()) return undefined;
  const cleaned = raw.trim().replace(/^sha256:/iu, '').replace(/:/gu, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/u.test(cleaned)) {
    throw new Error(formatPlumbCallError('参数无效', 'CA 指纹格式无效', '请提供 64 位 SHA-256 十六进制字符串'));
  }
  return cleaned;
}

async function readRegularFileUtf8(filePath: string, maxBytes: number, label: string): Promise<string> {
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile()) {
      throw new Error(formatPlumbCallError('参数无效', `${label} 不是常规文件`, '请指定真实文件路径'));
    }
    if (info.size > maxBytes) {
      throw new Error(formatPlumbCallError('参数无效', `${label} 超过最大允许大小`, '请检查路径是否正确'));
    }
    return await handle.readFile({ encoding: 'utf8' });
  } catch (error) {
    if (error instanceof Error && error.message.includes('：')) throw error;
    const code = (error as NodeJS.ErrnoException)?.code;
    const cat: CallErrorCategory = code === 'ENOENT' ? '不存在' : code === 'EACCES' ? '无权限' : '参数无效';
    throw new Error(formatPlumbCallError(cat, `无法读取${label}（${code ?? 'IO'}）`, '请确认文件存在且非符号链接'));
  } finally {
    await handle?.close().catch(() => {});
  }
}

function caPemMatchesFingerprint(caPem: string | undefined, expectedSha256: string): boolean {
  if (!caPem) return false;
  const blocks = caPem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/gu) ?? [];
  for (const block of blocks) {
    try {
      const hex = new X509Certificate(block).fingerprint256.replace(/:/gu, '').toLowerCase();
      if (hex === expectedSha256) return true;
    } catch {
    }
  }
  return false;
}

function peerChainMatchesFingerprint(socket: TLSSocket, expectedSha256: string, caPem?: string): boolean {
  let current = socket.getPeerCertificate(true);
  const visited = new Set<string>();
  while (current && typeof current.fingerprint256 === 'string') {
    const hex = current.fingerprint256.replace(/:/gu, '').toLowerCase();
    if (hex === expectedSha256) return true;
    const id = hex || current.serialNumber || '';
    if (!current.issuerCertificate || current.issuerCertificate === current || (id && visited.has(id))) {
      break;
    }
    if (id) visited.add(id);
    current = current.issuerCertificate;
  }
  return socket.authorized && caPemMatchesFingerprint(caPem, expectedSha256);
}

function parseRetryAfterMs(headerVal: string | string[] | undefined, nowMs: number): number | null {
  const raw = Array.isArray(headerVal) ? headerVal[0] : headerVal;
  if (!raw) return null;
  const trimmed = raw.trim();
  if (/^\d+(?:\.\d+)?$/u.test(trimmed)) {
    const sec = Number(trimmed);
    return Number.isFinite(sec) && sec >= 0 ? Math.min(60_000, Math.ceil(sec * 1000)) : null;
  }
  const dateMs = Date.parse(trimmed);
  if (Number.isFinite(dateMs)) {
    return Math.min(60_000, Math.max(0, dateMs - nowMs));
  }
  return null;
}

function categoryForStatus(status: number, code: string): CallErrorCategory {
  if (status === 401 || status === 403 || code === 'invalid_claim_code') return '无权限';
  if (status === 404 || code === 'not_found') return '不存在';
  if (status === 400 || status === 413 || status === 422) return '参数无效';
  if (status === 409) return '已被占用';
  return '暂时不可用';
}

function nextActionForError(status: number, code: string): string {
  if (status === 401 || status === 403) return '请检查 PLUMB_API_KEY 或权限范围后重试';
  if (status === 413 || code === 'request_too_large') return `请裁剪前序上下文或拆分批量题目（${describePlumbRequestLimits()}）`;
  if (code === 'version_mismatch') return '请联系管理员调整默认部署模型或传当前在服务模型版本重试';
  if (code === 'backend_down') return '请先执行 plumb wake --wait 等待后端就绪后再试';
  if (status === 429 || code === 'rate_limited') return '请降低并发（<= 2）并等待限流窗口恢复后重试';
  if (status === 408 || status === 504) return '禁止自动重发 POST；请检查服务端状态或日志后再决定是否重试';
  return '请核对请求参数与网关状态后重试';
}

function unwrapAnswerNode(raw: unknown): { answer: PlumbAnswer; gate?: PlumbGate } | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if ('answer' in obj && typeof obj.answer === 'object' && obj.answer !== null && !Array.isArray(obj.answer)) {
    const inner = obj.answer as PlumbAnswer;
    const gate = (obj.gate as PlumbGate | undefined) ?? inner.gate;
    return { answer: inner, ...(gate ? { gate } : {}) };
  }
  const ans = raw as PlumbAnswer;
  return { answer: ans, ...(ans.gate ? { gate: ans.gate } : {}) };
}

export function normalizeJudgeAnswer(raw: PlumbJudgeResponse | PlumbBatchAnswer): PlumbNormalizedAnswer {
  const unwrapped = unwrapAnswerNode(raw);
  if (!unwrapped) {
    throw new Error(formatPlumbCallError('暂时不可用', '网关响应缺少合法的 answer 对象', '请核对服务端版本是否受支持'));
  }
  const { answer, gate } = unwrapped;
  const rawType = typeof answer.type === 'string' ? answer.type : '';
  const isNoul = rawType === 'noul' || (answer.choice === undefined && typeof (answer.match ?? answer.value) === 'number');
  if (isNoul) {
    const score = Number(answer.match ?? answer.value ?? answer.probabilities?.yes ?? 0);
    return {
      kind: 'noul',
      choice: score >= 0.5 ? 'yes' : 'no',
      value: score,
      confidence: score,
      match: score,
      ...(answer.probabilities ? { probabilities: answer.probabilities } : {}),
      ...(gate ? { gate } : {}),
    };
  }
  const label = typeof answer.choice === 'string' ? answer.choice : (typeof answer.value === 'string' ? answer.value : '');
  const conf = typeof answer.confidence === 'number' && Number.isFinite(answer.confidence)
    ? answer.confidence
    : Number(answer.probabilities?.[label] ?? 0);
  return {
    kind: 'choice',
    choice: label,
    value: answer.value ?? label,
    confidence: conf,
    ...(answer.probabilities ? { probabilities: answer.probabilities } : {}),
    ...(gate ? { gate } : {}),
  };
}

function validateAnswerInvariants(rawItem: unknown, label: string): void {
  const unwrapped = unwrapAnswerNode(rawItem);
  if (!unwrapped) {
    throw new Error(formatPlumbCallError('暂时不可用', `网关 ${label} 不是有效的 answer 对象`, '请核对服务端版本是否受支持'));
  }
  const { answer } = unwrapped;
  const rawType = typeof answer.type === 'string' ? answer.type : '';
  const isNoul = rawType === 'noul' || (answer.choice === undefined && typeof (answer.match ?? answer.value) === 'number');
  if (isNoul) {
    const score = answer.match ?? answer.value;
    if (typeof score !== 'number' || !Number.isFinite(score) || score < -1e-6 || score > 1 + 1e-6) {
      throw new Error(formatPlumbCallError('暂时不可用', `网关 ${label} 的 noul 匹配分数非法`, '请核对服务端返回'));
    }
  } else {
    const picked = answer.choice ?? answer.value;
    if (typeof picked !== 'string' || picked === '') {
      throw new Error(formatPlumbCallError('暂时不可用', `网关 ${label} 缺少 answer.choice/value`, '请核对服务端版本是否受支持'));
    }
    if (typeof answer.confidence !== 'number' || !Number.isFinite(answer.confidence)) {
      throw new Error(formatPlumbCallError('暂时不可用', `网关 ${label} 的 confidence 非法`, '请核对服务端返回'));
    }
  }
  if (answer.probabilities !== undefined) {
    let sum = 0;
    for (const [k, v] of Object.entries(answer.probabilities)) {
      if (typeof v !== 'number' || !Number.isFinite(v) || v < -1e-6 || v > 1 + 1e-6) {
        throw new Error(formatPlumbCallError('暂时不可用', `网关概率分布项 ${k} 非法`, '请核对服务端模型输出'));
      }
      sum += v;
    }
    if (Object.keys(answer.probabilities).length > 0 && Math.abs(sum - 1) > 1e-3) {
      throw new Error(formatPlumbCallError('暂时不可用', `网关概率分布和异常（${sum.toFixed(6)}）`, '请核对服务端校准配置'));
    }
  }
}

export function verifyJudgeDisclosure<T extends PlumbAnyJudgeResponse>(
  payload: unknown,
): T {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error(formatPlumbCallError('暂时不可用', '网关判别响应不是 JSON 对象', '请核对网关健康状态'));
  }
  const obj = payload as Record<string, unknown>;
  if (obj.status !== '未确认' || obj.decided_by !== '模型') {
    throw new Error(formatPlumbCallError('暂时不可用', '网关响应缺少合法的未确认模型披露字段（status=未确认, decided_by=模型）', '严禁消费未带模型披露的响应'));
  }
  if (typeof obj.model_version !== 'string' || obj.model_version.trim() === '') {
    throw new Error(formatPlumbCallError('暂时不可用', '网关响应缺少 model_version 字段', '请核对网关响应版本'));
  }
  if ('answer' in obj && obj.answer !== undefined) {
    validateAnswerInvariants(obj.answer, 'answer');
  } else if ('answers' in obj && typeof obj.answers === 'object' && obj.answers !== null && !Array.isArray(obj.answers)) {
    const answers = obj.answers as Record<string, PlumbBatchAnswer & Record<string, unknown>>;
    for (const [qid, item] of Object.entries(answers)) {
      validateAnswerInvariants(item, `answers[${qid}]`);
      if (item.status === undefined) item.status = '未确认';
      if (item.decided_by === undefined) item.decided_by = '模型';
      if (item.model_version === undefined) item.model_version = obj.model_version;
    }
  } else {
    throw new Error(formatPlumbCallError('暂时不可用', '网关响应既无 answer 也无 answers', '请检查任务参数或服务端版本'));
  }
  return payload as T;
}

class AsyncLimiter {
  private readonly maxConcurrent: number;
  private readonly maxRpm: number;
  private readonly timing: PlumbTiming;
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  private readonly timestamps: number[] = [];
  private rateQueue: Promise<void> = Promise.resolve();

  constructor(maxConcurrent: number, maxRpm: number, timing: PlumbTiming) {
    this.maxConcurrent = Math.max(1, maxConcurrent);
    this.maxRpm = Math.max(1, maxRpm);
    this.timing = timing;
  }

  private acquireSlot(): Promise<void> {
    if (this.active < this.maxConcurrent) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.waiters.push(() => {
        this.active += 1;
        resolve();
      });
    });
  }

  private releaseSlot(): void {
    this.active = Math.max(0, this.active - 1);
    const next = this.waiters.shift();
    if (next) next();
  }

  private async waitForRateWindow(): Promise<void> {
    const previous = this.rateQueue;
    let releaseRate!: () => void;
    this.rateQueue = new Promise<void>((resolve) => {
      releaseRate = resolve;
    });
    await previous;
    try {
      while (true) {
        const now = this.timing.now();
        const cutoff = now - 60_000;
        while (this.timestamps.length > 0 && this.timestamps[0] <= cutoff) {
          this.timestamps.shift();
        }
        if (this.timestamps.length < this.maxRpm) {
          this.timestamps.push(now);
          return;
        }
        const waitMs = Math.max(1, this.timestamps[0] + 60_000 - now);
        await this.timing.pause(waitMs);
      }
    } finally {
      releaseRate();
    }
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquireSlot();
    try {
      await this.waitForRateWindow();
      return await fn();
    } finally {
      this.releaseSlot();
    }
  }
}

export class PlumbClient {
  readonly baseUrl: string;
  readonly baseOrigin: string;
  readonly defaultModel?: string;
  private readonly apiKey?: string;
  private readonly caFile?: string;
  private readonly caSha256?: string;
  private readonly timeoutMs: number;
  private readonly wakeTimeoutMs: number;
  private readonly maxBodyBytes: number;
  private readonly userAgent: string;
  private readonly timing: PlumbTiming;
  private readonly limiter: AsyncLimiter;
  private readonly cache: PlumbDiskCache | null;
  private readonly auditOut?: string;
  private cachedCaPem?: string;

  constructor(config: PlumbClientConfig) {
    this.baseUrl = validatePlumbBaseUrl(config.baseUrl, config.allowInsecureHttp === true);
    this.baseOrigin = new URL(this.baseUrl).origin;
    this.apiKey = config.apiKey?.trim() || undefined;
    this.defaultModel = config.model?.trim() || undefined;
    this.caFile = config.caFile?.trim() || undefined;
    this.caSha256 = normalizeCaSha256(config.caSha256);
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.wakeTimeoutMs = config.wakeTimeoutMs ?? DEFAULT_WAKE_TIMEOUT_MS;
    this.maxBodyBytes = config.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    this.userAgent = config.userAgent ?? 'circle-hub-plumb-client/1.0.0';
    this.timing = config.timing ?? DEFAULT_PLUMB_TIMING;
    this.limiter = new AsyncLimiter(
      config.maxConcurrent ?? DEFAULT_MAX_CONCURRENT,
      config.maxRpm ?? DEFAULT_MAX_RPM,
      this.timing,
    );
    this.cache = config.noCache ? null : config.cacheDir ? new PlumbDiskCache(config.cacheDir) : null;
    this.auditOut = config.auditOut?.trim() || undefined;
  }

  static configFromEnv(overrides: Partial<PlumbClientConfig> = {}, env: NodeJS.ProcessEnv = process.env): PlumbClientConfig {
    return {
      baseUrl: overrides.baseUrl ?? env.PLUMB_BASE_URL ?? '',
      apiKey: overrides.apiKey ?? env.PLUMB_API_KEY,
      model: overrides.model ?? env.PLUMB_MODEL,
      caFile: overrides.caFile ?? env.PLUMB_CA_FILE,
      caSha256: overrides.caSha256 ?? env.PLUMB_CA_SHA256,
      allowInsecureHttp: overrides.allowInsecureHttp,
      cacheDir: overrides.cacheDir,
      noCache: overrides.noCache,
      auditOut: overrides.auditOut,
      timeoutMs: overrides.timeoutMs,
      wakeTimeoutMs: overrides.wakeTimeoutMs,
      maxConcurrent: overrides.maxConcurrent,
      maxRpm: overrides.maxRpm,
      maxBodyBytes: overrides.maxBodyBytes,
      userAgent: overrides.userAgent,
      timing: overrides.timing,
    };
  }

  private async loadCaPem(): Promise<string | undefined> {
    if (!this.caFile) return undefined;
    if (this.cachedCaPem === undefined) {
      this.cachedCaPem = await readRegularFileUtf8(this.caFile, MAX_CA_FILE_BYTES, 'PLUMB CA 证书文件');
    }
    return this.cachedCaPem;
  }

  private requireAuthKey(): string {
    if (!this.apiKey) {
      throw new Error(formatPlumbCallError('无权限', '未提供 PLUMB_API_KEY', '请通过 --key-stdin 或环境配置注入有效密钥'));
    }
    return this.apiKey;
  }

  private async rawRequest(params: {
    method: 'GET' | 'POST';
    path: string;
    authRequired: boolean;
    extraHeaders?: Record<string, string>;
    body?: string;
    timeoutMs?: number;
  }): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
    const target = new URL(`${this.baseUrl}${params.path}`);
    if (target.origin !== this.baseOrigin) {
      throw new Error(formatPlumbCallError('无权限', '请求路径试图离开已锁定的 Plumb 网关主机', '请核对路径参数'));
    }
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'User-Agent': this.userAgent,
      ...(params.extraHeaders ?? {}),
    };
    if (params.authRequired) {
      headers.Authorization = `Bearer ${this.requireAuthKey()}`;
    }
    let bodyBytes: Buffer | undefined;
    if (params.body !== undefined) {
      bodyBytes = Buffer.from(params.body, 'utf8');
      if (bodyBytes.byteLength > this.maxBodyBytes) {
        throw new PlumbHttpError({
          message: formatPlumbCallError('参数无效', `请求体 ${bodyBytes.byteLength} 字节超出上限 ${this.maxBodyBytes} 字节`, '请拆分题目或缩减上下文后重试'),
          status: 413,
          code: 'request_too_large',
          retryable: false,
          retryAfterMs: null,
          category: '参数无效',
        });
      }
      headers['Content-Type'] = 'application/json; charset=utf-8';
      headers['Content-Length'] = String(bodyBytes.byteLength);
    }

    const caPem = target.protocol === 'https:' ? await this.loadCaPem() : undefined;
    const timeoutMs = params.timeoutMs ?? this.timeoutMs;
    const caSha = this.caSha256;

    return await new Promise((resolve, reject) => {
      let settled = false;
      const done = (fn: () => void) => {
        if (settled) return;
        settled = true;
        fn();
      };
      const reqOptions: https.RequestOptions = {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method: params.method,
        headers,
        timeout: timeoutMs,
      };
      if (target.protocol === 'https:') {
        reqOptions.rejectUnauthorized = true;
        if (caPem !== undefined) reqOptions.ca = caPem;
      }

      const transport = target.protocol === 'https:' ? https : http;
      const req = transport.request(reqOptions, (res) => {
        if (target.protocol === 'https:' && caSha) {
          const sock = res.socket as TLSSocket;
          if (!sock || typeof sock.getPeerCertificate !== 'function' || !peerChainMatchesFingerprint(sock, caSha, caPem)) {
            res.resume();
            req.destroy();
            done(() =>
              reject(
                new PlumbHttpError({
                  message: formatPlumbCallError('无权限', '网关 TLS 证书链路指纹与预设 --ca-sha256 不匹配', '请核对网关证书后再连接'),
                  status: 0,
                  code: 'ca_fingerprint_mismatch',
                  retryable: false,
                  retryAfterMs: null,
                  category: '无权限',
                }),
              ),
            );
            return;
          }
        }
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          res.resume();
          done(() =>
            reject(
              new PlumbHttpError({
                message: formatPlumbCallError('暂时不可用', `网关返回重定向状态 ${status}，客户端拒绝跨源跟踪`, '请直接配置最终 HTTPS 地址'),
                status,
                code: 'redirect_refused',
                retryable: false,
                retryAfterMs: null,
                category: '暂时不可用',
              }),
            ),
          );
          return;
        }
        const chunks: Buffer[] = [];
        let totalBytes = 0;
        res.on('data', (chunk: Buffer) => {
          totalBytes += chunk.byteLength;
          if (totalBytes > MAX_RESPONSE_BYTES) {
            res.destroy();
            req.destroy();
            done(() =>
              reject(
                new PlumbHttpError({
                  message: formatPlumbCallError('暂时不可用', '网关响应体超过 16 MiB 上限', '请缩小批处理规模后重试'),
                  status: 502,
                  code: 'response_too_large',
                  retryable: false,
                  retryAfterMs: null,
                  category: '暂时不可用',
                }),
              ),
            );
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          done(() => resolve({ status, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
        });
        res.on('error', (error) => {
          done(() =>
            reject(
              new PlumbHttpError({
                message: formatPlumbCallError('暂时不可用', `读取网关响应失败（${redactSecret(error.message, [this.apiKey])}）`, '请确认网关连接状态后再试'),
                status: 0,
                code: (error as NodeJS.ErrnoException).code ?? 'stream_error',
                retryable: params.method === 'GET',
                retryAfterMs: null,
                category: '暂时不可用',
                cause: error,
              }),
            ),
          );
        });
      });

      req.on('timeout', () => {
        req.destroy();
        done(() =>
          reject(
            new PlumbHttpError({
              message: formatPlumbCallError(
                '暂时不可用',
                `Plumb 请求超时（${timeoutMs} ms，方法 ${params.method}）`,
                params.method === 'POST' ? '禁止自动重发 POST，请先确认服务端状态再手动重试' : '请确认网关网络可达后重试',
              ),
              status: 504,
              code: 'timeout',
              retryable: params.method === 'GET',
              retryAfterMs: null,
              category: '暂时不可用',
            }),
          ),
        );
      });

      req.on('error', (error) => {
        const errno = (error as NodeJS.ErrnoException).code ?? 'network_error';
        const isTlsFailure = /CERT|TLS|SSL|HOSTNAME|UNABLE_TO_VERIFY|SELF_SIGNED/iu.test(errno) || /certificate|self-signed/iu.test(error.message);
        const category: CallErrorCategory = isTlsFailure ? '无权限' : '暂时不可用';
        const safeFact = isTlsFailure
          ? `TLS 证书校验失败（${errno}）`
          : `连接 Plumb 网关失败（${errno}：${redactSecret(error.message, [this.apiKey])}）`;
        const nextAction = isTlsFailure
          ? '请确认 --ca-file（或 PLUMB_CA_FILE）与网关主机匹配'
          : params.method === 'POST'
            ? 'POST 失败不自动重发；请先排查网关可达性后再决定是否重试'
            : '请确认网关地址与网络连通后重试';
        done(() =>
          reject(
            new PlumbHttpError({
              message: formatPlumbCallError(category, safeFact, nextAction),
              status: 0,
              code: errno,
              retryable: params.method === 'GET' && !isTlsFailure,
              retryAfterMs: null,
              category,
              cause: error,
            }),
          ),
        );
      });

      if (bodyBytes !== undefined) req.write(bodyBytes);
      req.end();
    });
  }

  private async requestJson<T>(params: {
    method: 'GET' | 'POST';
    path: string;
    authRequired: boolean;
    extraHeaders?: Record<string, string>;
    bodyObj?: unknown;
    timeoutMs?: number;
  }): Promise<T> {
    const bodyText = params.bodyObj !== undefined ? JSON.stringify(params.bodyObj) : undefined;
    const maxAttempts = params.method === 'GET' ? 4 : 3;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let resp: { status: number; headers: http.IncomingHttpHeaders; body: string };
      try {
        resp = await this.limiter.run(() =>
          this.rawRequest({
            method: params.method,
            path: params.path,
            authRequired: params.authRequired,
            extraHeaders: params.extraHeaders,
            body: bodyText,
            timeoutMs: params.timeoutMs,
          }),
        );
      } catch (error) {
        if (error instanceof PlumbHttpError && params.method === 'GET' && error.retryable && attempt < maxAttempts) {
          const delayMs = GET_BACKOFF_MS[Math.min(attempt - 1, GET_BACKOFF_MS.length - 1)];
          await this.timing.pause(delayMs);
          continue;
        }
        throw error;
      }

      if (resp.status >= 200 && resp.status < 300) {
        try {
          return JSON.parse(resp.body) as T;
        } catch {
          throw new PlumbHttpError({
            message: formatPlumbCallError('暂时不可用', '网关返回非 JSON 成功响应', '请核对网关健康检查接口'),
            status: resp.status,
            code: 'invalid_json',
            retryable: false,
            retryAfterMs: null,
            category: '暂时不可用',
          });
        }
      }

      let errCode = `http_${resp.status}`;
      let errMsg = `HTTP ${resp.status}`;
      let reqId: string | undefined;
      let retryAfterMs = parseRetryAfterMs(resp.headers['retry-after'], this.timing.now());
      try {
        const parsed = JSON.parse(resp.body) as Record<string, unknown>;
        const errObj = typeof parsed.error === 'object' && parsed.error !== null ? (parsed.error as Record<string, unknown>) : parsed;
        if (typeof errObj.code === 'string' && errObj.code) errCode = errObj.code;
        else if (typeof errObj.type === 'string' && errObj.type) errCode = errObj.type;
        if (typeof errObj.message === 'string' && errObj.message) errMsg = redactSecret(errObj.message, [this.apiKey]);
        if (typeof parsed.request_id === 'string') reqId = parsed.request_id;
        if (retryAfterMs === null && typeof errObj.retry_after === 'number' && Number.isFinite(errObj.retry_after)) {
          retryAfterMs = Math.min(60_000, Math.max(0, Math.ceil(errObj.retry_after * 1000)));
        }
      } catch {
        errMsg = redactSecret(resp.body.slice(0, 240) || errMsg, [this.apiKey]);
      }

      const isPostRateLimit = params.method === 'POST' && resp.status === 429;
      const isGetTransient = params.method === 'GET' && (resp.status === 429 || resp.status === 503);
      const canRetry = (isGetTransient || isPostRateLimit) && attempt < maxAttempts;
      if (canRetry) {
        const fallbackWait = GET_BACKOFF_MS[Math.min(attempt - 1, GET_BACKOFF_MS.length - 1)];
        const waitMs = retryAfterMs ?? fallbackWait;
        if (params.method === 'GET' || waitMs <= MAX_POST_RATE_LIMIT_WAIT_MS) {
          await this.timing.pause(waitMs);
          continue;
        }
      }

      const category = categoryForStatus(resp.status, errCode);
      throw new PlumbHttpError({
        message: formatPlumbCallError(category, `Plumb 网关拒绝（${resp.status} ${errCode}）：${errMsg}`, nextActionForError(resp.status, errCode)),
        status: resp.status,
        code: errCode,
        retryable: resp.status === 429 || errCode === 'backend_down' || errCode === 'backend_busy',
        retryAfterMs,
        category,
        requestId: reqId,
      });
    }

    throw new Error(formatPlumbCallError('暂时不可用', 'Plumb 请求重试耗尽', '请稍后检查网关状态'));
  }

  private async appendAudit(record: PlumbAuditRecord): Promise<void> {
    if (!this.auditOut) return;
    const sanitized = redactSecret(JSON.stringify(record), [this.apiKey]);
    await appendPrivateLine(this.auditOut, sanitized);
  }

  async models(): Promise<PlumbModelsResponse> {
    return await this.requestJson<PlumbModelsResponse>({
      method: 'GET',
      path: '/v1/models',
      authRequired: true,
    });
  }

  async status(model?: string): Promise<PlumbStatusResponse> {
    const resolvedModel = model?.trim() || this.defaultModel;
    const query = resolvedModel ? `?model=${encodeURIComponent(resolvedModel)}` : '';
    return await this.requestJson<PlumbStatusResponse>({
      method: 'GET',
      path: `/v1/status${query}`,
      authRequired: true,
    });
  }

  async wake(model?: string): Promise<PlumbWakeResponse> {
    const resolvedModel = model?.trim() || this.defaultModel;
    const bodyObj = resolvedModel ? { model: resolvedModel } : {};
    return await this.requestJson<PlumbWakeResponse>({
      method: 'POST',
      path: '/v1/wake',
      authRequired: true,
      bodyObj,
    });
  }

  async wakeAndWait(options?: { model?: string; timeoutMs?: number; pollIntervalMs?: number }): Promise<PlumbStatusResponse> {
    const resolvedModel = options?.model?.trim() || this.defaultModel;
    const deadlineMs = this.timing.now() + (options?.timeoutMs ?? this.wakeTimeoutMs);
    const pollMs = options?.pollIntervalMs ?? DEFAULT_WAKE_POLL_MS;
    const initial = await this.status(resolvedModel);
    if (initial.status === 'ready') return initial;
    if (initial.status !== 'waking') {
      await this.wake(resolvedModel);
    }
    while (this.timing.now() < deadlineMs) {
      await this.timing.pause(pollMs);
      const current = await this.status(resolvedModel);
      if (current.status === 'ready') return current;
      if (current.status === 'version_mismatch' || current.status === 'error') {
        throw new PlumbHttpError({
          message: formatPlumbCallError('暂时不可用', `网关状态异常（${current.status}）`, nextActionForError(503, current.status)),
          status: 503,
          code: current.status,
          retryable: false,
          retryAfterMs: null,
          category: '暂时不可用',
        });
      }
    }
    throw new PlumbHttpError({
      message: formatPlumbCallError('暂时不可用', '等待 Plumb 后端唤醒超时', '请检查后端服务状态或延长 --timeout-sec 后重试'),
      status: 504,
      code: 'wake_timeout',
      retryable: false,
      retryAfterMs: null,
      category: '暂时不可用',
    });
  }

  async requestKey(params: { name: string; purpose: string; contact?: string }): Promise<PlumbKeyRequestResponse> {
    if (!params.name.trim() || !params.purpose.trim()) {
      throw new Error(formatPlumbCallError('参数无效', '申请密钥必须提供 --name 与 --purpose', '请补全申请信息后重试'));
    }
    return await this.requestJson<PlumbKeyRequestResponse>({
      method: 'POST',
      path: '/v1/keys/requests',
      authRequired: false,
      bodyObj: { name: params.name.trim(), purpose: params.purpose.trim(), contact: params.contact?.trim() ?? '' },
    });
  }

  async claimKey(params: { requestId: string; claimCode: string }): Promise<PlumbKeyClaimResponse> {
    if (!params.requestId.trim() || params.requestId.includes('/')) {
      throw new Error(formatPlumbCallError('参数无效', 'requestId 无效', '请提供有效的申请编号'));
    }
    if (!params.claimCode.trim()) {
      throw new Error(formatPlumbCallError('参数无效', '缺少 claimCode', '请通过标准输入传入 claim code'));
    }
    return await this.requestJson<PlumbKeyClaimResponse>({
      method: 'GET',
      path: `/v1/keys/requests/${encodeURIComponent(params.requestId.trim())}`,
      authRequired: false,
      extraHeaders: { 'x-claim-code': params.claimCode.trim() },
    });
  }

  async judge<T extends PlumbAnyJudgeResponse = PlumbJudgeResponse>(request: PlumbJudgeRequest): Promise<T> {
    if (request.state !== undefined && request.node !== undefined) {
      throw new Error(formatPlumbCallError('参数无效', '/v1/judge 不能同时传入 state 与 node', '请仅保留其中一种输入形态'));
    }
    if (request.questions) {
      const entries = Object.entries(request.questions);
      if (entries.length > PLUMB_GATEWAY_LIMITS.maxQuestions) {
        throw new Error(
          formatPlumbCallError(
            '参数无效',
            `单次 /v1/judge 题目数 ${entries.length} 超过上限 ${PLUMB_GATEWAY_LIMITS.maxQuestions}`,
            '请改用 judgeBatched 自动分片发送',
          ),
        );
      }
      const pairs = entries.reduce((sum, [, question]) => sum + estimateExpandedPairs(question, request.task), 0);
      if (pairs > PLUMB_GATEWAY_LIMITS.maxPairs) {
        throw new Error(
          formatPlumbCallError(
            '参数无效',
            `单次 /v1/judge 估算展开 ${pairs} 个打分对，超过上限 ${PLUMB_GATEWAY_LIMITS.maxPairs}（同一请求的各题共用这一个预算）`,
            '请改用 judgeBatched 自动分片发送',
          ),
        );
      }
    }
    const model = (request.model ?? this.defaultModel ?? '').trim();
    const wireRequest: PlumbJudgeRequest = model ? { ...request, model } : { ...request };
    const reqHash = sha256Hex(stableStringify(wireRequest));
    const cacheKey = this.cache
      ? buildCacheKey({ endpoint: '/v1/judge', baseOrigin: this.baseOrigin, model: model || '(default)', request: wireRequest })
      : null;

    if (this.cache && cacheKey) {
      const hit = await this.cache.get(cacheKey, model || '(default)');
      if (hit) {
        const single = 'answer' in hit ? normalizeJudgeAnswer(hit) : undefined;
        await this.appendAudit({
          ts: new Date(this.timing.now()).toISOString(),
          endpoint: '/v1/judge',
          task: hit.task ?? request.task ?? 'unknown',
          model_version: hit.model_version,
          request_sha256: reqHash,
          request_id: hit.request_id ?? null,
          status: '未确认',
          decided_by: '模型',
          choice: single?.choice,
          confidence: single?.confidence,
          gate_action: single?.gate?.action,
          cache_hit: true,
        });
        return hit as T;
      }
    }

    try {
      const raw = await this.requestJson<unknown>({
        method: 'POST',
        path: '/v1/judge',
        authRequired: true,
        bodyObj: wireRequest,
      });
      const verified = verifyJudgeDisclosure<T>(raw);
      if (this.cache && cacheKey) {
        await this.cache.put(cacheKey, model || '(default)', verified);
      }
      const single = 'answer' in verified ? normalizeJudgeAnswer(verified) : undefined;
      await this.appendAudit({
        ts: new Date(this.timing.now()).toISOString(),
        endpoint: '/v1/judge',
        task: verified.task ?? request.task ?? 'unknown',
        model_version: verified.model_version,
        request_sha256: reqHash,
        request_id: verified.request_id ?? null,
        status: '未确认',
        decided_by: '模型',
        choice: single?.choice,
        confidence: single?.confidence,
        gate_action: single?.gate?.action,
        cache_hit: false,
      });
      return { ...verified, cache_hit: false };
    } catch (error) {
      await this.appendAudit({
        ts: new Date(this.timing.now()).toISOString(),
        endpoint: '/v1/judge',
        task: request.task ?? 'unknown',
        model_version: model || '(default)',
        request_sha256: reqHash,
        request_id: error instanceof PlumbHttpError ? (error.requestId ?? null) : null,
        status: '未确认',
        decided_by: '模型',
        cache_hit: false,
        error_code: error instanceof PlumbHttpError ? error.code : 'client_error',
      }).catch(() => {});
      throw error;
    }
  }

  private requestFrame(params: { model?: string; task?: string; state?: PlumbJudgeRequest['state'] }): Record<string, unknown> {
    const model = (params.model ?? this.defaultModel ?? '').trim();
    return {
      ...(model ? { model } : {}),
      ...(params.task ? { task: params.task } : {}),
      ...(params.state !== undefined ? { state: params.state } : {}),
    };
  }

  exceedsRequestLimits(request: PlumbJudgeRequest): boolean {
    if (!request.questions) return false;
    const { questions, ...rest } = request;
    return planPlumbBatches(Object.entries(questions), {
      frame: { ...rest, ...this.requestFrame(rest) },
      fallbackTask: request.task,
      limits: { maxBodyBytes: this.maxBodyBytes },
    }).length > 1;
  }

  async judgeBatched(params: {
    model?: string;
    task?: string;
    state?: string | Record<string, unknown> | unknown[];
    questions: Record<string, PlumbBatchQuestion>;
    batchSize?: number;
  }): Promise<PlumbBatchJudgeResponse> {
    const entries = Object.entries(params.questions);
    if (entries.length === 0) {
      throw new Error(formatPlumbCallError('参数无效', '批量判别题目列表为空', '请至少传入 1 道待判题目'));
    }
    const chunks = planPlumbBatches(entries, {
      frame: this.requestFrame(params),
      fallbackTask: params.task,
      maxQuestions: params.batchSize,
      limits: { maxBodyBytes: this.maxBodyBytes },
    });

    const perChunkResults = await Promise.all(
      chunks.map(async (chunk) => {
        const qMap: Record<string, PlumbBatchQuestion> = {};
        for (const [k, v] of chunk) qMap[k] = v;
        return await this.judge<PlumbBatchJudgeResponse>({
          ...(params.model ? { model: params.model } : {}),
          ...(params.task ? { task: params.task } : {}),
          ...(params.state !== undefined ? { state: params.state } : {}),
          questions: qMap,
        });
      }),
    );

    const mergedAnswers: PlumbBatchJudgeResponse['answers'] = {};
    const versions = new Set<string>();
    const reqIds: string[] = [];
    let allCacheHit = true;
    for (const res of perChunkResults) {
      versions.add(res.model_version);
      if (res.request_id) reqIds.push(res.request_id);
      if (!res.cache_hit) allCacheHit = false;
      for (const [qid, ans] of Object.entries(res.answers)) {
        mergedAnswers[qid] = ans;
      }
    }
    if (versions.size > 1) {
      throw new Error(
        formatPlumbCallError(
          '暂时不可用',
          `分片批调期间服务端模型版本发生切换（${[...versions].join(', ')}）`,
          '请显式传入锁定 --model 版本并重跑全部批次以保证结果一致性',
        ),
      );
    }
    const first = perChunkResults[0];
    return {
      status: '未确认',
      decided_by: '模型',
      model_version: first.model_version,
      task: first.task ?? params.task,
      request_id: reqIds.join(',') || undefined,
      answers: mergedAnswers,
      cache_hit: allCacheHit,
    };
  }

  async ask(request: PlumbSystemOneRequest): Promise<PlumbAnyJudgeResponse> {
    const model = (request.model ?? this.defaultModel ?? '').trim();
    const wireRequest: PlumbSystemOneRequest = model ? { ...request, model } : { ...request };
    const reqHash = sha256Hex(stableStringify(wireRequest));
    const cacheKey = this.cache
      ? buildCacheKey({ endpoint: '/v1/systemone', baseOrigin: this.baseOrigin, model: model || '(default)', request: wireRequest })
      : null;

    if (this.cache && cacheKey) {
      const hit = await this.cache.get(cacheKey, model || '(default)');
      if (hit) {
        await this.appendAudit({
          ts: new Date(this.timing.now()).toISOString(),
          endpoint: '/v1/systemone',
          task: hit.task ?? 'systemone',
          model_version: hit.model_version,
          request_sha256: reqHash,
          request_id: hit.request_id ?? null,
          status: '未确认',
          decided_by: '模型',
          cache_hit: true,
        });
        return hit;
      }
    }

    const raw = await this.requestJson<unknown>({
      method: 'POST',
      path: '/v1/systemone',
      authRequired: true,
      bodyObj: wireRequest,
    });
    const verified = verifyJudgeDisclosure<PlumbAnyJudgeResponse>(raw);
    if (this.cache && cacheKey) {
      await this.cache.put(cacheKey, model || '(default)', verified);
    }
    await this.appendAudit({
      ts: new Date(this.timing.now()).toISOString(),
      endpoint: '/v1/systemone',
      task: verified.task ?? 'systemone',
      model_version: verified.model_version,
      request_sha256: reqHash,
      request_id: verified.request_id ?? null,
      status: '未确认',
      decided_by: '模型',
      cache_hit: false,
    });
    return { ...verified, cache_hit: false };
  }
}
