// D5: escalate repeated refusals (Boss afternoon 1114).
// Count: same caller + tool + error code (参数无效 also field path); with a run → same run; without → last hour.
// Tier 1 = D1/D2 sentence unchanged; tier 2 adds count + schema-checked JSON; tier 3+ adds category closing line.
// No「替代路径」; no「按工具的输入模式改正这个参数后再调用」.
import type { z } from 'zod';
import type { ProtocolError } from '../../contracts/src/common.ts';
import type { CallLog } from '../records/api.ts';
import { callErrorCategoryOf, isPackScopedCode, type CallErrorCategory } from './error-reasons.ts';

export { isPackScopedCode } from './error-reasons.ts';

export const ESCALATION_WINDOW_MS = 60 * 60 * 1000;

/** Codes that never escalate (Boss 12:45): neutral unavailable, Hub-internal failures, cancellation. */
const SKIP_CODES = new Set([
  'SOURCE_UNAVAILABLE',
  'INTERNAL_ERROR',
  'INTERNAL',
  'CANCELLED',
  'CANCELED',
  'REQUEST_CANCELLED',
  'REQUEST_CANCELED',
]);

export type EscalationTier = 1 | 2 | 3;

export interface EscalationParts {
  /** This call's occurrence: prior matching call_logs + 1. */
  occurrence: number;
  tier: EscalationTier;
  /** 「这是一小时内第 N 次同样的错误」 */
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
  if (/cancel/i.test(code) || /internal/i.test(code)) return false;
  return true;
}

export function escalationTier(occurrence: number): EscalationTier {
  if (occurrence <= 1) return 1;
  if (occurrence === 2) return 2;
  return 3;
}

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
  const desc = typeof schema.description === 'string' ? schema.description : '';
  if (/pack|工作流|任务包/i.test(desc) || schema.title === 'pack') return '<工作流编号>';
  if (/kind/i.test(desc)) return 'workflow';
  if (/reference|引用/i.test(desc)) return '<引用>';
  if (/cursor|游标/i.test(desc)) return '<游标>';
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
  const tried: unknown[] = [base, ...refineCandidates(inputSchema, base, visibleValues)];
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
      return '照原样重试不会成功。请照上面的完整写法改；改后仍被拒绝，就停止重试，把这条错误原样报告给使用者';
    case '无权限':
      return '这不是写法问题，重试没有用。请停止重试，告诉使用者联系管理员分配；当前账户可用的工作流和技能用 list_task_packs 查看';
    case '不存在':
      return '请先用列表工具核对名称；列表里没有，就停止重试并报告使用者';
    case '已被占用':
      return '请等待持有者释放，或改订空闲的测试环境；不要重复预订同一个';
    case '暂时不可用': {
      const n = typeof retryAfterSeconds === 'number' && retryAfterSeconds > 0 ? retryAfterSeconds : 60;
      return `请等待 ${n} 秒后原样重试一次；仍不可用，就停止重试并报告使用者`;
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
  if (exampleJson !== null) sentences.push(`完整的正确写法：${exampleJson}`);
  let categoryClose: string | null = null;
  if (tier >= 3) {
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

export function factOfCallError(message: string, category: CallErrorCategory): string {
  const trimmed = message.trim();
  const prefix = `${category}：`;
  if (trimmed.startsWith(prefix)) return trimmed.slice(prefix.length).trim();
  for (const word of ['参数无效', '无权限', '不存在', '已被占用', '暂时不可用'] as const) {
    const other = `${word}：`;
    if (trimmed.startsWith(other)) return trimmed.slice(other.length).trim();
  }
  return trimmed;
}

export function formatCategoryCallError(options: {
  category: CallErrorCategory;
  message: string;
  fix: string | null | undefined;
}): string {
  const fact = asSentence(factOfCallError(options.message, options.category));
  const next = asSentence(
    typeof options.fix === 'string' && options.fix.trim().length > 0
      ? options.fix
      : '由使用者核对输入资料',
  );
  return `${options.category}：${fact}${next}`;
}

export function fixHasEscalation(fix: string | null | undefined): boolean {
  return typeof fix === 'string' && /这是一小时内第 \d+ 次同样的错误/.test(fix);
}

export function withEscalatedFix(error: ProtocolError, parts: EscalationParts): ProtocolError {
  if (parts.fixSuffix === null) return error;
  const base = typeof error.fix === 'string' && error.fix.length > 0 ? error.fix : '由使用者核对输入资料';
  if (fixHasEscalation(base)) return error;
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
  /** For 参数无效, also match this field path when the count port supports it. */
  path?: string | null;
  now?: Date;
}): Promise<number | null> {
  if (!countsTowardEscalation(options.errorCode)) return null;
  if (typeof options.userId !== 'string' || options.userId.length === 0) return null;
  const callLog = options.callLog;
  if (callLog?.countRecentErrors === undefined) return null;
  const now = options.now ?? new Date();
  const since = new Date(now.getTime() - ESCALATION_WINDOW_MS).toISOString();
  const query: {
    userId: string;
    tool: string;
    errorCode: string;
    since: string;
    runId?: string;
    path?: string;
  } = {
    userId: options.userId,
    tool: options.tool,
    errorCode: options.errorCode,
    since,
  };
  if (typeof options.runId === 'string' && options.runId.length > 0) query.runId = options.runId;
  if (typeof options.path === 'string' && options.path.length > 0 && callErrorCategoryOf(options.errorCode) === '参数无效') {
    query.path = options.path;
  }
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
      now: options.now,
    });
    if (occurrence === null) {
      out.push(error);
      continue;
    }
    const exampleJson = isPackScopedCode(error.code)
      ? checkedPackDeclaredExample(options.packDeclaredExample, options.input)
      : schemaExample;
    out.push(
      withEscalatedFix(
        error,
        buildEscalation({
          occurrence,
          exampleJson,
          category: callErrorCategoryOf(error.code),
          retryAfterSeconds: options.retryAfterSeconds,
        }),
      ),
    );
  }
  return out;
}
