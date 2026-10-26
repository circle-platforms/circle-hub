// Common frame of every core interpreter: schema validation with Chinese messages, semantic checks, and a run that is total.
// A table is validated once per content (admission, then cached by digest), not on every run.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { isCheckTier } from '../../../contracts/generated/vocabulary.ts';
import type { CheckOutcome } from '../../../contracts/src/tables.ts';
import { parseJsonPath, pointerOf } from '../json.ts';
import { hasBasis, unknown, type OutcomeBase } from '../outcome.ts';
import type { CheckRequest, Interpreter, TableIssue } from '../types.ts';

const chinese = z.locales.zhCN();

export function schemaIssues<T>(schema: z.ZodType<T>, table: unknown): { value: T; issues: [] } | { value: undefined; issues: TableIssue[] } {
  const parsed = schema.safeParse(table, { error: chinese.localeError });
  if (parsed.success) return { value: parsed.data, issues: [] };
  return {
    value: undefined,
    issues: parsed.error.issues.map((issue) => ({ path: pointerOf(issue.path.map((p) => (typeof p === 'symbol' ? String(p) : p))), message: issue.message })),
  };
}

/** Issues for JSONPath fields the schema's pattern accepts but the selector parser does not. */
export function pathIssues(paths: readonly [string, string | undefined][]): TableIssue[] {
  const issues: TableIssue[] = [];
  for (const [at, path] of paths) {
    if (path !== undefined && parseJsonPath(path) === null) issues.push({ path: at, message: `不是受支持的 JSONPath：${path}` });
  }
  return issues;
}

export function rangeIssue(at: string, min: number | undefined, max: number | undefined): TableIssue[] {
  return min !== undefined && max !== undefined && min > max ? [{ path: at, message: `下限 ${min} 大于上限 ${max}` }] : [];
}

/** C05 R[1]: a blocking tier needs the contract clause it relies on. */
export function basisIssue(at: string, tier: unknown, basis: unknown): TableIssue[] {
  return tier === 'blocking' && !hasBasis(basis) ? [{ path: at, message: '阻断档要写明所依据的验收合同条款（basis，C05 R[1]）；没有条款时只能是提示档' }] : [];
}

const looseBase = (table: unknown, tier: CheckRequest['tier']): OutcomeBase => {
  const own = (table as { tier?: unknown; basis?: unknown } | null) ?? {};
  return { tier: tier ?? (isCheckTier(own.tier) ? own.tier : hasBasis(own.basis) ? 'blocking' : 'advisory'), grounds: [] };
};

const messageOf = (error: unknown): string => {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return '未知错误';
  }
};

/**
 * Canonical text of a plain JSON-like value with a tag per type, so equal content gives equal text and an undefined member, a
 * null member and an absent member stay different. undefined for anything else (then the table is validated every time).
 */
function canonical(value: unknown, depth = 0): string | undefined {
  if (depth > 64) return undefined;
  if (value === null) return 'n';
  if (value === undefined) return 'u';
  switch (typeof value) {
    case 'boolean':
      return value ? 't' : 'f';
    case 'number':
      return `d${Object.is(value, -0) ? '-0' : String(value)}`;
    case 'string':
      return `s${JSON.stringify(value)}`;
    case 'object': {
      if (Array.isArray(value)) {
        const parts: string[] = [];
        for (let i = 0; i < value.length; i++) {
          const part = canonical(value[i], depth + 1);
          if (part === undefined) return undefined;
          parts.push(part);
        }
        return `[${parts.join(',')}]`;
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) return undefined;
      const parts: string[] = [];
      for (const key of Object.keys(value).sort()) {
        const part = canonical((value as Record<string, unknown>)[key], depth + 1);
        if (part === undefined) return undefined;
        parts.push(`${JSON.stringify(key)}:${part}`);
      }
      return `{${parts.join(',')}}`;
    }
    default:
      return undefined;
  }
}

function cacheKey(table: unknown): string | undefined {
  try {
    const text = canonical(table);
    return text === undefined ? undefined : createHash('sha256').update(text).digest('hex');
  } catch {
    return undefined;
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

const MAX_CACHED = 256;

export function defineInterpreter<T extends object>(spec: {
  id: string;
  codes: readonly string[];
  schema: z.ZodType<T>;
  check?: (table: T) => TableIssue[];
  run: (table: T, request: CheckRequest) => CheckOutcome[];
}): Interpreter {
  const uncached = (table: unknown): { value?: T; issues: TableIssue[] } => {
    const parsed = schemaIssues(spec.schema, table);
    if (parsed.value === undefined) return { issues: parsed.issues };
    const own = parsed.value as { tier?: unknown; basis?: unknown };
    const issues = [...basisIssue('/tier', own.tier, own.basis), ...(spec.check?.(parsed.value) ?? [])];
    // The parsed table is shared by later runs of the same content: nothing may change it.
    return issues.length > 0 ? { issues } : { value: deepFreeze(parsed.value), issues: [] };
  };
  const validated = new Map<string, { value?: T; issues: TableIssue[] }>();
  const validate = (table: unknown): { value?: T; issues: TableIssue[] } => {
    const key = cacheKey(table);
    const hit = key === undefined ? undefined : validated.get(key);
    if (hit) return hit;
    const result = uncached(table);
    if (key !== undefined) {
      if (validated.size >= MAX_CACHED) validated.delete(validated.keys().next().value as string);
      validated.set(key, result);
    }
    return result;
  };
  return {
    id: spec.id,
    codes: spec.codes,
    validateTable: (table) => validate(table).issues.map((i) => ({ ...i })),
    run(request) {
      const base = looseBase(request.table, request.tier);
      try {
        const { value, issues } = validate(request.table);
        if (value === undefined || issues.length > 0) {
          const first = issues[0];
          return [
            unknown(base, 'check_error', `表不符合 ${spec.id}：${first ? `${first.path || '/'} ${first.message}` : '无法读取'}`, { data: { issues: issues.map((i) => ({ ...i })) } }),
          ];
        }
        // A declared tier replaces the table's own; the interpreter still gives negative cases their negative tier.
        const table = request.tier === undefined ? value : ({ ...value, tier: request.tier } as T);
        const outcomes = spec.run(table, request);
        return outcomes.length > 0 ? outcomes : [unknown(base, 'check_error', `${spec.id} 没有给出结果`)];
      } catch (error) {
        return [unknown(base, 'check_error', `${spec.id} 检查出错：${messageOf(error)}`)];
      }
    },
  };
}
