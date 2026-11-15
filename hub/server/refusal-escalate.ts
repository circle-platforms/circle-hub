// D5: escalate repeated refusals (Boss afternoon 1114).
// Count: same caller + tool + error code (参数无效 also field path); with a run → same run; without → last hour.
// Tier 1 = D1/D2 sentence unchanged; tier 2 adds count + schema-checked JSON; tier 3+ adds category closing line.
// No「替代路径」; no「按工具的输入模式改正这个参数后再调用」.
import type { z } from 'zod';
import type { ProtocolError } from '../../contracts/src/common.ts';
import type { CallLog } from '../records/api.ts';
import {
  callErrorCategoryOf,
  errorPresentationOf,
  isPackScopedCode,
  type CallErrorCategory,
} from './error-reasons.ts';

export { isPackScopedCode } from './error-reasons.ts';

export const ESCALATION_WINDOW_MS = 60 * 60 * 1000;

/**
 * Codes that never escalate (Boss 12:45 / 18:09):
 * - SOURCE_UNAVAILABLE: neutral unknown, not a five-category call error
 * - Hub-internal failures and cancellation
 * SOURCE_RETRYABLE is 暂时不可用 (a category); it escalates only when identity facts exist (Boss 18:09).
 */
const SKIP_CODES = new Set([
  'SOURCE_UNAVAILABLE',
  'INTERNAL_ERROR',
  'INTERNAL',
  'CANCELLED',
  'CANCELED',
  'REQUEST_CANCELLED',
  'REQUEST_CANCELED',
]);

/** Facts that prove two refusals are the same call (Boss 18:09). */
export type EscalationIdentity = {
  path?: string;
  objectKey?: string;
  requestDigest?: string;
};

/**
 * Identity required before any count: 参数无效 → field path; other categories → object or request digest.
 * No coarse「这个工具第 N 次参数无效」.
 */
export function escalationIdentityOf(
  errorCode: string,
  parts: { path?: string | null; objectKey?: string | null; requestDigest?: string | null },
): EscalationIdentity | null {
  const category = callErrorCategoryOf(errorCode);
  if (category === null) return null;
  if (category === '参数无效') {
    if (typeof parts.path === 'string' && parts.path.length > 0) return { path: parts.path };
    return null;
  }
  if (typeof parts.objectKey === 'string' && parts.objectKey.length > 0) return { objectKey: parts.objectKey };
  if (typeof parts.requestDigest === 'string' && parts.requestDigest.length > 0) {
    return { requestDigest: parts.requestDigest };
  }
  return null;
}

/** Whole-tool submit_result examples are useless for nested field-path refusals (Boss 17:58 F3). */
const USELESS_WHOLE_TOOL_EXAMPLE_PATH = /^\/items(\/|$)/;
const EXAMPLE_JSON_MAX_CHARS = 800;

/** True when a schema example would not help correct this field-path refusal. */
export function exampleUsefulForPath(path: string | null | undefined, exampleJson: string | null): boolean {
  if (exampleJson === null) return false;
  if (exampleJson.length > EXAMPLE_JSON_MAX_CHARS) return false;
  if (typeof path === 'string' && USELESS_WHOLE_TOOL_EXAMPLE_PATH.test(path)) return false;
  return true;
}

export type EscalationTier = 1 | 2 | 3;

export interface EscalationParts {
  /** This call's occurrence: prior matching call_logs + 1. */
  occurrence: number;
  tier: EscalationTier;
  /** 「这是一小时内第 N 次同样的错误」或参数无效无 path 时的工具级计数句 */
  countLabel: string;
  /** JSON text of a schema-checked example, or null when none is available. */
  exampleJson: string | null;
  /** Category closing line for tier 3+ (no「替代路径」). */
  categoryClose: string | null;
  /** Suffix sentences appended after the base next step (independent sentences). */
  fixSuffix: string | null;
}

export function countsTowardEscalation(code: string | null | undefined): boolean {
  if (typeof code !== 'string' || code.length === 0) return false;
  if (SKIP_CODES.has(code)) return false;
  // Only the five call-error categories escalate; unavailable / conclusion / unmapped do not.
  const presentation = errorPresentationOf(code);
  if (presentation.kind === 'unavailable') return false;
  if (callErrorCategoryOf(code) === null) return false;
  return true;
}

export function escalationTier(occurrence: number): EscalationTier {
  if (occurrence <= 1) return 1;
  if (occurrence === 2) return 2;
  return 3;
}

/** Count sentence once Hub proved the same call (Boss 18:09); no coarse tool-level wording. */
export function countLabelOf(occurrence: number): string {
  return `这是一小时内第 ${occurrence} 次同样的错误`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Chinese angle-bracket placeholder; never the letter "x". */
function stringPlaceholder(schema: Record<string, unknown>): string {
  if (schema.contentEncoding === 'base64' || (typeof schema.pattern === 'string' && schema.pattern.includes('A-Za-z0-9+/'))) {
    return 'YQ==';
  }
  if (typeof schema.pattern === 'string') {
    if (schema.pattern.includes('run_')) return 'run_01h2x3y4z5a6b7c8d9e0f1g2h3';
    if (/\[0-9a-f\]\{64\}/.test(schema.pattern)) return 'a'.repeat(64);
  }
  return '<取值>';
}

/**
 * Build one candidate value from a JSON Schema fragment: prefer `examples` / `const` / `enum` / `default`,
 * then required properties. Never a handwritten tool→example table. Never the letter "x" as a copyable stub.
 */
export function candidateFromInputSchema(schema: unknown, visibleValues?: ReadonlyMap<string, unknown>): unknown {
  if (!isRecord(schema)) return undefined;
  if (Array.isArray(schema.examples) && schema.examples.length > 0) return schema.examples[0];
  if (Object.hasOwn(schema, 'const')) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  if (Object.hasOwn(schema, 'default')) return schema.default;
  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
    for (const branch of schema.oneOf) {
      const value = candidateFromInputSchema(branch, visibleValues);
      if (value !== undefined) return value;
    }
  }
  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
    for (const branch of schema.anyOf) {
      const value = candidateFromInputSchema(branch, visibleValues);
      if (value !== undefined) return value;
    }
  }
  const types = Array.isArray(schema.type) ? schema.type : schema.type !== undefined ? [schema.type] : [];
  if (types.includes('object') || schema.properties !== undefined) {
    const properties = isRecord(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required) ? schema.required.filter((key): key is string => typeof key === 'string') : [];
    const out: Record<string, unknown> = {};
    for (const key of required) {
      const visible = visibleValues?.get(key);
      if (visible !== undefined) {
        out[key] = visible;
        continue;
      }
      const value = candidateFromInputSchema(properties[key], visibleValues);
      if (value !== undefined) out[key] = value;
    }
    return out;
  }
  if (types.includes('array')) return [];
  if (types.includes('boolean')) return false;
  if (types.includes('integer') || types.includes('number')) {
    return typeof schema.minimum === 'number' ? schema.minimum : 0;
  }
  if (types.includes('string') || types.length === 0) {
    return stringPlaceholder(schema);
  }
  return undefined;
}

function refineCandidates(schema: unknown, base: unknown, visibleValues?: ReadonlyMap<string, unknown>): unknown[] {
  if (!isRecord(schema) || !isRecord(schema.properties)) return [];
  const properties = schema.properties;
  const out: unknown[] = [];
  for (const [key, prop] of Object.entries(properties)) {
    const visible = visibleValues?.get(key);
    const value = visible !== undefined ? visible : candidateFromInputSchema(prop, visibleValues);
    if (value === undefined) continue;
    out.push({ ...(isRecord(base) ? base : {}), [key]: value });
  }
  if (isRecord(base) && typeof base.text === 'string') {
    if (properties.root !== undefined) {
      const root = candidateFromInputSchema(properties.root, visibleValues);
      if (root !== undefined) out.push({ ...base, root });
    }
    if (properties.run !== undefined) {
      const run = candidateFromInputSchema(properties.run, visibleValues);
      if (run !== undefined) out.push({ ...base, run });
    }
  }
  return out;
}

export function examplePassesInput(
  example: unknown,
  input: z.ZodType,
): example is Record<string, unknown> | unknown[] | string | number | boolean | null {
  return input.safeParse(example).success;
}

/**
 * A schema-checked example for a core tool parameter refusal.
 * `visibleValues` supplies caller-visible real values (e.g. first workflow id from list_task_packs).
 */
export function checkedExampleFromInputSchema(
  inputSchema: Record<string, unknown>,
  input: z.ZodType,
  visibleValues?: ReadonlyMap<string, unknown>,
): string | null {
  const base = candidateFromInputSchema(inputSchema, visibleValues);
  const refined = refineCandidates(inputSchema, base, visibleValues);
  // Prefer the mode the caller actually used (e.g. file_path on upload_file, not memory_share).
  // Schema placeholders for those keys — do not paste refused bytes into「完整的正确写法」.
  const hintKeys = visibleValues && visibleValues.size > 0 ? [...visibleValues.keys()] : [];
  const preferredPlaceholders: unknown[] = [];
  if (hintKeys.length > 0 && isRecord(inputSchema.properties)) {
    const properties = inputSchema.properties;
    for (const key of hintKeys) {
      if (!Object.hasOwn(properties, key)) continue;
      const value = candidateFromInputSchema(properties[key], visibleValues);
      if (value === undefined) continue;
      preferredPlaceholders.push({ ...(isRecord(base) ? base : {}), [key]: value });
    }
  }
  const preferred: unknown[] = [];
  const rest: unknown[] = [];
  const hints = new Set(hintKeys);
  for (const candidate of refined) {
    if (hints.size > 0 && isRecord(candidate) && hintKeys.some((key) => Object.hasOwn(candidate, key))) {
      preferred.push(candidate);
    } else {
      rest.push(candidate);
    }
  }
  const tried: unknown[] = [...preferredPlaceholders, ...preferred, base, ...rest];
  for (const candidate of tried) {
    if (candidate === undefined) continue;
    if (examplePassesInput(candidate, input)) return JSON.stringify(candidate);
  }
  return null;
}

export function checkedPackDeclaredExample(declared: unknown, input: z.ZodType): string | null {
  if (declared === undefined || declared === null) return null;
  return examplePassesInput(declared, input) ? JSON.stringify(declared) : null;
}

/** Closing sentence by call-error category (tier 3+). */
export function categoryCloseOf(category: CallErrorCategory | null, retryAfterSeconds?: number): string | null {
  if (category === null) return null;
  switch (category) {
    case '参数无效':
      return '照原样重试不会成功。请按上面的输入格式示例核对并替换占位值；改后仍被拒绝，就停止重试，把这条错误原样报告给使用者';
    case '无权限':
      return '请按这次拒绝给出的具体授权出口处理；未给出对象和授权方式时，请维护者补齐，停止重复同一请求';
    case '不存在':
      return '请用本次返回的可读名称和列表覆盖范围核对对象；仍未找到时停止重试并报告使用者';
    case '已被占用':
      return '请核对这次返回的具体冲突对象和处置方式；缺少时请维护者补齐，不凭类别改订其他对象';
    case '暂时不可用': {
      return typeof retryAfterSeconds === 'number' && retryAfterSeconds > 0
        ? `请等待 ${retryAfterSeconds} 秒后原样重试一次；仍不可用，就停止重试并报告使用者`
        : '本次未给出重试时刻；请按已披露故障核对，缺少具体下一步时请维护者补齐';
    }
  }
}

export function buildEscalation(options: {
  occurrence: number;
  exampleJson: string | null;
  category?: CallErrorCategory | null;
  retryAfterSeconds?: number;
}): EscalationParts {
  const occurrence = Math.max(1, Math.floor(options.occurrence));
  const tier = escalationTier(occurrence);
  const countLabel = countLabelOf(occurrence);
  const exampleJson = options.exampleJson;
  if (tier === 1) {
    return { occurrence, tier, countLabel, exampleJson: null, categoryClose: null, fixSuffix: null };
  }
  const sentences: string[] = [countLabel];
  if (exampleJson !== null) sentences.push(`经输入格式核验的示例（需替换占位值）：${exampleJson}`);
  let categoryClose: string | null = null;
  // Without an example, the 参数无效 close ("请按上面的输入格式示例核对并替换占位值") must not be appended (Boss 17:58 F3).
  if (tier >= 3 && !(options.category === '参数无效' && exampleJson === null)) {
    categoryClose = categoryCloseOf(options.category ?? null, options.retryAfterSeconds);
    if (categoryClose !== null) sentences.push(categoryClose);
  }
  return {
    occurrence,
    tier,
    countLabel,
    exampleJson,
    categoryClose,
    fixSuffix: sentences.join('。'),
  };
}

/** Category word for a known call-refusal code; null when unmapped. */
export function categoryOfCallError(code: string): CallErrorCategory | null {
  return callErrorCategoryOf(code);
}

function asSentence(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return '';
  return /[。！？]$/.test(trimmed) ? trimmed : `${trimmed}。`;
}

export function factOfCallError(message: string, _category: CallErrorCategory): string { return message; }

export function formatCategoryCallError(options: {
  category: CallErrorCategory;
  message: string;
  fix: string | null | undefined;
}): string {
  const fact = asSentence(factOfCallError(options.message, options.category));
  const next = asSentence(
    typeof options.fix === 'string' && options.fix.trim().length > 0
      ? options.fix
      : '缺少本次拒绝的具体下一步，请维护者补齐后按原请求核对',
  );
  return `${options.category}：${fact}${next}`;
}


export function withEscalatedFix(error: ProtocolError, parts: EscalationParts): ProtocolError {
  if (parts.fixSuffix === null) return error;
  const base = typeof error.fix === 'string' && error.fix.length > 0 ? error.fix : '缺少本次拒绝的具体下一步，请维护者补齐后按原请求核对';
  // Independent sentences: base already ends with 。 or we add one, then escalation sentences.
  const head = /[。！？]$/.test(base.trim()) ? base.trim() : `${base.trim()}。`;
  return { ...error, fix: `${head}${parts.fixSuffix}。` };
}

export async function occurrenceOf(options: {
  callLog: Pick<CallLog, 'countRecentErrors'> | null | undefined;
  userId: string | null | undefined;
  tool: string;
  errorCode: string;
  /** When set, count only within this run (Boss afternoon). */
  runId?: string | null;
  path?: string | null;
  objectKey?: string | null;
  requestDigest?: string | null;
  now?: Date;
}): Promise<number | null> {
  if (!countsTowardEscalation(options.errorCode)) return null;
  if (typeof options.userId !== 'string' || options.userId.length === 0) return null;
  const callLog = options.callLog;
  if (callLog?.countRecentErrors === undefined) return null;
  const identity = escalationIdentityOf(options.errorCode, {
    path: options.path,
    objectKey: options.objectKey,
    requestDigest: options.requestDigest,
  });
  // Boss 18:09: without a sameness fact, do not count and do not append.
  if (identity === null) return null;
  const now = options.now ?? new Date();
  const since = new Date(now.getTime() - ESCALATION_WINDOW_MS).toISOString();
  const query: {
    userId: string;
    tool: string;
    errorCode: string;
    since: string;
    path?: string;
    objectKey?: string;
    requestDigest?: string;
  } = {
    userId: options.userId,
    tool: options.tool,
    errorCode: options.errorCode,
    since,
    ...identity,
  };
  // Call through the object so PgCallLog keeps its private #db (do not extract the method).
  const prior = await callLog.countRecentErrors(query);
  return prior + 1;
}

export async function escalateProtocolErrors(options: {
  callLog: Pick<CallLog, 'countRecentErrors'> | null | undefined;
  userId: string | null | undefined;
  tool: string;
  errors: ProtocolError[];
  input: z.ZodType;
  inputSchema: Record<string, unknown>;
  packDeclaredExample?: unknown;
  /** Caller-visible values for object fields in the example JSON. */
  visibleValues?: ReadonlyMap<string, unknown>;
  runId?: string | null;
  /** Optional object key / request digest when the caller already computed sameness facts. */
  objectKey?: string | null;
  requestDigest?: string | null;
  now?: Date;
  retryAfterSeconds?: number;
}): Promise<ProtocolError[]> {
  if (options.errors.length === 0) return options.errors;
  const schemaExample = checkedExampleFromInputSchema(options.inputSchema, options.input, options.visibleValues);
  const out: ProtocolError[] = [];
  for (const error of options.errors) {
    const occurrence = await occurrenceOf({
      callLog: options.callLog,
      userId: options.userId,
      tool: options.tool,
      errorCode: error.code,
      runId: options.runId,
      path: error.path,
      objectKey: options.objectKey,
      requestDigest: options.requestDigest,
      now: options.now,
    });
    if (occurrence === null) {
      out.push(error);
      continue;
    }
    const category = callErrorCategoryOf(error.code);
    // Belt-and-suspenders: never escalate when the code has no call-error category.
    if (category === null || errorPresentationOf(error.code).kind === 'unavailable') {
      out.push(error);
      continue;
    }
    const rawExample = isPackScopedCode(error.code)
      ? checkedPackDeclaredExample(options.packDeclaredExample, options.input)
      : schemaExample;
    const exampleJson = exampleUsefulForPath(error.path, rawExample) ? rawExample : null;
    out.push(
      withEscalatedFix(
        error,
        buildEscalation({
          occurrence,
          exampleJson,
          category,
          retryAfterSeconds: options.retryAfterSeconds,
        }),
      ),
    );
  }
  return out;
}
