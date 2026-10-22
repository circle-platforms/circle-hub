// Structural diff of definition data. Top-level names in ignoreFields are dropped before the comparison; a nested key
// of the same name is not. Both values are kept. A missing key is distinct from JSON null (absent says which side).

import { isRecord } from './text.ts';

export interface FieldDiff {
  path: string;
  before: unknown;
  after: unknown;
  absent?: 'before' | 'after';
}

function plain(value: unknown): value is { [key: string]: unknown } {
  return isRecord(value);
}

/** Canonical JSON text with object keys sorted, so key order is not a difference. */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical((value as { [key: string]: unknown })[key])}`).join(',')}}`;
}

function normalize(data: unknown, ignore: ReadonlySet<string>): unknown {
  let cloned: unknown;
  try {
    cloned = JSON.parse(JSON.stringify(data)) as unknown;
  } catch {
    return null;
  }
  if (plain(cloned)) for (const key of ignore) delete cloned[key];
  return cloned;
}

function token(part: string): string {
  return part.replaceAll('~', '~0').replaceAll('/', '~1');
}

function childPath(parent: string, part: string): string {
  return `${parent}/${token(part)}`;
}

function pushAbsent(out: FieldDiff[], path: string, before: unknown, after: unknown, absent: 'before' | 'after'): void {
  out.push({ path, before, after, absent });
}

function diffValue(before: unknown, after: unknown, path: string, out: FieldDiff[]): void {
  if (canonical(before) === canonical(after)) return;
  if (plain(before) && plain(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    for (const key of keys) {
      const next = childPath(path, key);
      const hasBefore = Object.hasOwn(before, key);
      const hasAfter = Object.hasOwn(after, key);
      if (hasBefore && hasAfter) diffValue(before[key], after[key], next, out);
      else if (!hasBefore) pushAbsent(out, next, null, after[key], 'before');
      else pushAbsent(out, next, before[key], null, 'after');
    }
    return;
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    const length = Math.max(before.length, after.length);
    for (let i = 0; i < length; i++) {
      const next = childPath(path, String(i));
      if (i >= before.length) pushAbsent(out, next, null, after[i], 'before');
      else if (i >= after.length) pushAbsent(out, next, before[i], null, 'after');
      else diffValue(before[i], after[i], next, out);
    }
    return;
  }
  out.push({ path: path === '' ? '/' : path, before, after });
}

/**
 * Diff of the definition entries on the two sides of one path. Each side is sorted by canonical text first, so the
 * order of entries in the view is not a difference and a swap of equal definitions is not a change. One definition on
 * each side is compared as a value (paths `/help`, `/args/0/type`). Any other count is compared as an array (`/0/...`).
 */
export function definitionDiff(before: readonly unknown[], after: readonly unknown[], ignoreFields: readonly string[]): FieldDiff[] {
  const ignore = new Set(ignoreFields);
  const left = before.map((data) => normalize(data, ignore)).sort((a, b) => (canonical(a) < canonical(b) ? -1 : canonical(a) > canonical(b) ? 1 : 0));
  const right = after.map((data) => normalize(data, ignore)).sort((a, b) => (canonical(a) < canonical(b) ? -1 : canonical(a) > canonical(b) ? 1 : 0));
  if (left.length === right.length && left.every((value, i) => canonical(value) === canonical(right[i]))) return [];
  const out: FieldDiff[] = [];
  if (left.length === 1 && right.length === 1) diffValue(left[0], right[0], '', out);
  else diffValue(left, right, '', out);
  return out;
}
