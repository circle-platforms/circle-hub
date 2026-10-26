import type { Reason as UnknownReason } from '../../../contracts/generated/vocabulary.ts';
// Values a table selects from the subject, and closed sets resolved by value, by reference or by name.
import type { ClosedSet } from '../../../contracts/src/tables.ts';
import { locate, type Selected } from '../json.ts';
import type { CheckRequest } from '../types.ts';

export interface Selection {
  /** Selected values with arrays flattened one level, so `$.tags` and `$.tags[*]` select the same members. */
  values: Selected[];
  /** Paths whose location is missing (not merely empty), in table order. */
  missing: string[];
}

export function selectLocations(subject: unknown, paths: readonly string[]): Selection {
  const values: Selected[] = [];
  const missing: string[] = [];
  for (const path of paths) {
    const found = locate(subject, path);
    if (found.missing) missing.push(path);
    for (const selected of found.selected) {
      if (Array.isArray(selected.value)) selected.value.forEach((value, i) => values.push({ pointer: `${selected.pointer}/${i}`, value }));
      else values.push(selected);
    }
  }
  return { values, missing };
}

/** Selected values only, for locations that are optional by nature (declared skips). */
export function selectValues(subject: unknown, paths: readonly string[]): Selected[] {
  return selectLocations(subject, paths).values;
}

/** Statement suffix and data for locations a table does not require that are missing. */
export function missingNote(missing: readonly string[]): { text: string; data: { missing?: string[] } } {
  if (missing.length === 0) return { text: '', data: {} };
  return { text: `；${missing.join('、')} 缺失，表没有要求必须存在`, data: { missing: [...missing] } };
}

/** Text of a scalar for set and pattern comparison: strings as they are, finite numbers and booleans as JSON text. */
export function scalarText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if ((typeof value === 'number' && Number.isFinite(value)) || typeof value === 'boolean') return JSON.stringify(value);
  return undefined;
}

export type ResolvedSet = { ok: true; values: string[]; ground?: string } | { ok: false; reason: Extract<UnknownReason, 'missing_input' | 'check_error'>; detail: string };

/** Members of a closed set. A reference must resolve to a bound fragment whose text is a JSON array of scalars. */
export function resolveSet(set: ClosedSet, request: CheckRequest): ResolvedSet {
  if ('values' in set) return { ok: true, values: [...set.values] };
  if ('name' in set) {
    const values = request.context.sets?.[set.name];
    if (!values) return { ok: false, reason: 'missing_input', detail: `调用方没有提供封闭集合 ${set.name}` };
    return { ok: true, values: [...values] };
  }
  const text = request.sources?.text(set.reference);
  if (text === undefined) return { ok: false, reason: 'missing_input', detail: `集合引用 ${set.reference} 没有绑定到本次运行` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'check_error', detail: `集合引用 ${set.reference} 的内容不是 JSON` };
  }
  if (!Array.isArray(parsed)) return { ok: false, reason: 'check_error', detail: `集合引用 ${set.reference} 的内容不是数组` };
  const values: string[] = [];
  for (const v of parsed) {
    const s = scalarText(v);
    if (s === undefined) return { ok: false, reason: 'check_error', detail: `集合引用 ${set.reference} 含有非标量成员` };
    values.push(s);
  }
  return { ok: true, values, ground: set.reference };
}
