// D5: escalate repeated refusals (same account + tool + error code within one hour).
// Counts come from call_logs (not process memory). Examples must pass the tool input schema;
// pack codes take only pack-declared examples. Boss 12:45 / 12:55: structure first; Chinese copy is not a frozen product baseline.
import type { z } from 'zod';
import type { ProtocolError } from '../../contracts/src/common.ts';
import type { CallLog } from '../records/api.ts';

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
  /** Structural count marker (not a frozen product sentence). */
  countLabel: string;
  /** JSON text of a schema-checked example, or null when none is available. */
  exampleJson: string | null;
  /** Structural alternative-path marker for tier 3+. */
  alternative: string | null;
  /** Suffix merged into structuredContent.errors[].fix (and therefore into 下一步 text). */
  fixSuffix: string | null;
}

export function countsTowardEscalation(code: string | null | undefined): boolean {
  if (typeof code !== 'string' || code.length === 0) return false;
  if (SKIP_CODES.has(code)) return false;
  // Transport / cancel lines often leave error_code null; anything that looks cancelled still skips.
  if (/cancel/i.test(code) || /internal/i.test(code)) return false;
  return true;
}

export function escalationTier(occurrence: number): EscalationTier {
  if (occurrence <= 1) return 1;
  if (occurrence === 2) return 2;
  return 3;
}

export function countLabelOf(occurrence: number): string {
  return `最近一小时内第 ${occurrence} 次`;
}

/** Pack-scoped codes look like `<pack-id>.<local>` (not bare PROTOCOL_CODES). */
export function isPackScopedCode(code: string): boolean {
  return /^[a-z][a-z0-9-]{0,40}\.[A-Za-z0-9_.:-]+$/.test(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Build one candidate value from a JSON Schema fragment: prefer `examples` / `const` / `enum` / `default`,
 * then required properties. Never a handwritten tool→example table.
 */
export function candidateFromInputSchema(schema: unknown): unknown {
  if (!isRecord(schema)) return undefined;
  if (Array.isArray(schema.examples) && schema.examples.length > 0) return schema.examples[0];
  if (Object.hasOwn(schema, 'const')) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  if (Object.hasOwn(schema, 'default')) return schema.default;
  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
    for (const branch of schema.oneOf) {
      const value = candidateFromInputSchema(branch);
      if (value !== undefined) return value;
    }
  }
  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
    for (const branch of schema.anyOf) {
      const value = candidateFromInputSchema(branch);
      if (value !== undefined) return value;
    }
  }
  const types = Array.isArray(schema.type) ? schema.type : schema.type !== undefined ? [schema.type] : [];
  if (types.includes('object') || schema.properties !== undefined) {
    const properties = isRecord(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required) ? schema.required.filter((key): key is string => typeof key === 'string') : [];
    const out: Record<string, unknown> = {};
    for (const key of required) {
      const value = candidateFromInputSchema(properties[key]);
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
    if (schema.contentEncoding === 'base64' || (typeof schema.pattern === 'string' && schema.pattern.includes('A-Za-z0-9+/'))) {
      return 'YQ==';
    }
    if (typeof schema.pattern === 'string') {
      if (schema.pattern.includes('run_')) return 'run_01h2x3y4z5a6b7c8d9e0f1g2h3';
      if (/\[0-9a-f\]\{64\}/.test(schema.pattern)) return 'a'.repeat(64);
      if (schema.pattern.startsWith('^[a-z]')) return 'a';
    }
    const min = typeof schema.minLength === 'number' ? schema.minLength : 1;
    return 'x'.repeat(Math.max(1, min));
  }
  return undefined;
}

/**
 * When the empty/required-only candidate fails a refine (upload_file modes, resolve_reference run|root),
 * try each top-level property alone or combined with an optional companion from the same schema.
 */
function refineCandidates(schema: unknown, base: unknown): unknown[] {
  if (!isRecord(schema) || !isRecord(schema.properties)) return [];
  const properties = schema.properties;
  const out: unknown[] = [];
  for (const [key, prop] of Object.entries(properties)) {
    const value = candidateFromInputSchema(prop);
    if (value === undefined) continue;
    out.push({ ...(isRecord(base) ? base : {}), [key]: value });
  }
  // resolve_reference: text + root/run
  if (isRecord(base) && typeof base.text === 'string') {
    if (properties.root !== undefined) {
      const root = candidateFromInputSchema(properties.root);
      if (root !== undefined) out.push({ ...base, root });
    }
    if (properties.run !== undefined) {
      const run = candidateFromInputSchema(properties.run);
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
 * A schema-checked example for a core tool parameter refusal: generated from inputSchema (or its examples),
 * accepted only when `input.safeParse` succeeds.
 */
export function checkedExampleFromInputSchema(
  inputSchema: Record<string, unknown>,
  input: z.ZodType,
): string | null {
  const tried: unknown[] = [candidateFromInputSchema(inputSchema), ...refineCandidates(inputSchema, candidateFromInputSchema(inputSchema))];
  for (const candidate of tried) {
    if (candidate === undefined) continue;
    if (examplePassesInput(candidate, input)) return JSON.stringify(candidate);
  }
  return null;
}

/**
 * Pack-scoped codes: only a pack-declared example body is allowed (Boss 12:45). Still must pass the tool input.
 */
export function checkedPackDeclaredExample(declared: unknown, input: z.ZodType): string | null {
  if (declared === undefined || declared === null) return null;
  return examplePassesInput(declared, input) ? JSON.stringify(declared) : null;
}

function alternativePath(hasExample: boolean): string {
  if (hasExample) {
    return '替代路径：换写法（按完整正确示例改参数再调用）；找谁（权限或分配请管理员）；收尾（同一写法再试无益，改不了就停下）';
  }
  return '替代路径：换写法（先用 list_task_packs 或 get_nodes 核对允许的写法再调用）；找谁（权限或分配请管理员）；收尾（同一写法再试无益，改不了就停下）';
}

export function buildEscalation(options: {
  occurrence: number;
  exampleJson: string | null;
}): EscalationParts {
  const occurrence = Math.max(1, Math.floor(options.occurrence));
  const tier = escalationTier(occurrence);
  const countLabel = countLabelOf(occurrence);
  const exampleJson = options.exampleJson;
  if (tier === 1) {
    return { occurrence, tier, countLabel, exampleJson: null, alternative: null, fixSuffix: null };
  }
  if (tier === 2) {
    const parts = [countLabel];
    if (exampleJson !== null) parts.push(`完整正确示例：${exampleJson}`);
    return { occurrence, tier, countLabel, exampleJson, alternative: null, fixSuffix: parts.join('；') };
  }
  const alternative = alternativePath(exampleJson !== null);
  const parts = [countLabel, alternative];
  if (exampleJson !== null) parts.splice(1, 0, `完整正确示例：${exampleJson}`);
  return { occurrence, tier, countLabel, exampleJson, alternative, fixSuffix: parts.join('；') };
}

/** Merge escalation into an error's fix so structuredContent and 下一步 text stay aligned (Boss 12:10). */
export function withEscalatedFix(error: ProtocolError, parts: EscalationParts): ProtocolError {
  if (parts.fixSuffix === null) return error;
  const base = typeof error.fix === 'string' && error.fix.length > 0 ? error.fix : '由使用者核对输入资料';
  return { ...error, fix: `${base}；${parts.fixSuffix}` };
}

/**
 * Prior matching refusals in the window, then +1 for the current call (not yet in call_logs).
 * Returns null when the code does not escalate or the count port is missing.
 */
export async function occurrenceOf(options: {
  callLog: Pick<CallLog, 'countRecentErrors'> | null | undefined;
  userId: string | null | undefined;
  tool: string;
  errorCode: string;
  now?: Date;
}): Promise<number | null> {
  if (!countsTowardEscalation(options.errorCode)) return null;
  if (typeof options.userId !== 'string' || options.userId.length === 0) return null;
  const countRecent = options.callLog?.countRecentErrors;
  if (countRecent === undefined) return null;
  const now = options.now ?? new Date();
  const since = new Date(now.getTime() - ESCALATION_WINDOW_MS).toISOString();
  const prior = await countRecent({
    userId: options.userId,
    tool: options.tool,
    errorCode: options.errorCode,
    since,
  });
  return prior + 1;
}

export async function escalateProtocolErrors(options: {
  callLog: Pick<CallLog, 'countRecentErrors'> | null | undefined;
  userId: string | null | undefined;
  tool: string;
  errors: ProtocolError[];
  /** Tool Zod input; used to verify generated or pack-declared examples. */
  input: z.ZodType;
  /** Published JSON Schema for the tool (generation source for parameter refusals). */
  inputSchema: Record<string, unknown>;
  /**
   * Pack-declared example for a pack-scoped code (from the pack's examples/).
   * Required for pack codes; ignored for protocol codes.
   */
  packDeclaredExample?: unknown;
  now?: Date;
}): Promise<ProtocolError[]> {
  if (options.errors.length === 0) return options.errors;
  const schemaExample = checkedExampleFromInputSchema(options.inputSchema, options.input);
  const out: ProtocolError[] = [];
  for (const error of options.errors) {
    const occurrence = await occurrenceOf({
      callLog: options.callLog,
      userId: options.userId,
      tool: options.tool,
      errorCode: error.code,
      now: options.now,
    });
    if (occurrence === null) {
      out.push(error);
      continue;
    }
    const exampleJson = isPackScopedCode(error.code)
      ? checkedPackDeclaredExample(options.packDeclaredExample, options.input)
      : schemaExample;
    out.push(withEscalatedFix(error, buildEscalation({ occurrence, exampleJson })));
  }
  return out;
}
