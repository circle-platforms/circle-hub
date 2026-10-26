// Bed snapshots compare declared parser structure with frozen manifest fields. Wording is never a match.
import { isIP } from 'node:net';
import { at, type ExecutorDefinition } from './definition.ts';

export type BedState = NonNullable<ExecutorDefinition['bed_state']>;
export type BedItem = BedState['items'][number];
export const SHARED_BED_LIMIT = '未排除共享床影响';
export const UNRESTORED_LIMIT = '床面未恢复';
const BED_NAME = /^[a-z0-9-]{1,64}$/;

export interface Difference { item: string; kind: 'extra' | 'missing' | 'changed'; identity: string; field?: string }
export type Canonical = { kind: 'address_table'; addresses: string[] } | { kind: 'config_list'; rows: Array<{ id: string; values: Record<string, string> }> };
export type BedRead = { id: string; ok: true; canonical: Canonical; value?: unknown; source: string } | { id: string; ok: false; value?: unknown; source: string | null };
export interface BedReport {
  bed: string;
  pre: 'passed';
  recovery: 'restored' | 'unrestored' | 'unknown';
  differences: Difference[];
  originals: { pre: string[]; post: string[] };
  limits: string[];
  next_action: string | null;
}

export function bedName(bed: unknown): string | null {
  if (!bed || typeof bed !== 'object' || Array.isArray(bed)) return null;
  const name = (bed as Record<string, unknown>).name;
  return typeof name === 'string' && BED_NAME.test(name) ? name : null;
}

export function bedLimits(recovery: BedReport['recovery']): string[] {
  if (recovery === 'restored') return [];
  return recovery === 'unrestored' ? [SHARED_BED_LIMIT, UNRESTORED_LIMIT] : [SHARED_BED_LIMIT];
}

export function cleanupSteps(items: readonly BedItem[], ids: readonly string[]): string {
  const wanted = new Set(ids);
  return items.filter(item => wanted.has(item.id)).map(item => `由${item.cleanup.actor}按 ${item.cleanup.command} 处理后重开`).join('；');
}

export function unknownSteps(items: readonly BedItem[], ids: readonly string[]): string {
  const wanted = new Set(ids);
  return items.filter(item => wanted.has(item.id)).map(item => `只读探针 ${item.id} 没有按声明解析出结构。由${item.cleanup.actor}重读 ${item.call.tool} 后再开`).join('；');
}

export function residueFact(diffs: readonly Difference[]): string {
  return `床面残留不属于基线。来源探针 ${[...new Set(diffs.map(diff => diff.item))].join('、')}`;
}

export function unrestoredFact(diffs: readonly Difference[]): string {
  return `该床尚未恢复，不能派发。来源探针 ${[...new Set(diffs.map(diff => diff.item))].join('、')}`;
}

export function missingProbeFact(ids: readonly string[]): string {
  return `床面探针缺失：${ids.join('、')}`;
}

function interfaceKey(value: string): string | null {
  const slash = value.lastIndexOf('/');
  if (slash <= 0) return null;
  const ip = value.slice(0, slash).trim();
  const prefix = value.slice(slash + 1);
  const family = isIP(ip);
  if (!family || !/^\d+$/.test(prefix)) return null;
  const bits = Number(prefix);
  if (bits > (family === 4 ? 32 : 128)) return null;
  const host = family === 6 ? new URL(`http://[${ip}]/`).hostname.slice(1, -1) : ip;
  return `${host}/${bits}`;
}

function addressSet(rows: unknown, address: string): string[] | null {
  if (!Array.isArray(rows)) return null;
  const found: string[] = [];
  for (const row of rows) {
    const value = at(row, address);
    if (typeof value !== 'string') return null;
    const key = interfaceKey(value);
    if (key === null) return null;
    found.push(key);
  }
  return [...new Set(found)].sort();
}

function configRows(rows: unknown, identity: string, fields: readonly { name: string; pointer: string }[]): Array<{ id: string; values: Record<string, string> }> | null {
  if (!Array.isArray(rows)) return null;
  const found: Array<{ id: string; values: Record<string, string> }> = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const id = at(row, identity);
    if (typeof id !== 'string' || id === '' || seen.has(id)) return null;
    seen.add(id);
    const values: Record<string, string> = {};
    for (const field of fields) {
      const value = at(row, field.pointer);
      if (typeof value !== 'string') return null;
      values[field.name] = value;
    }
    found.push({ id, values });
  }
  return found.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

export function parseReply(item: BedItem, reply: unknown): Canonical | null {
  const parser = item.parser;
  if (parser.kind === 'address_table') {
    const addresses = addressSet(at(reply, parser.rows), parser.address);
    return addresses === null ? null : { kind: 'address_table', addresses };
  }
  const rows = configRows(at(reply, parser.rows), parser.identity, parser.fields);
  return rows === null ? null : { kind: 'config_list', rows };
}

export function parseBaseline(item: BedItem, bed: unknown): Canonical | null {
  const parser = item.parser;
  if (parser.kind === 'address_table') {
    const devices = at(bed, parser.manifest_devices);
    if (!Array.isArray(devices)) return null;
    const found: string[] = [];
    for (const device of devices) {
      for (const list of parser.manifest_lists) {
        const entries = at(device, list);
        if (!Array.isArray(entries)) return null;
        for (const entry of entries) {
          if (typeof entry !== 'string') return null;
          const key = interfaceKey(entry);
          if (key === null) return null;
          found.push(key);
        }
      }
    }
    return { kind: 'address_table', addresses: [...new Set(found)].sort() };
  }
  const rows = configRows(at(bed, parser.manifest_rows), parser.manifest_identity, parser.manifest_fields);
  return rows === null ? null : { kind: 'config_list', rows };
}

export function differences(item: string, expected: Canonical, actual: Canonical): Difference[] | null {
  if (expected.kind !== actual.kind) return null;
  if (expected.kind === 'address_table' && actual.kind === 'address_table') {
    const before = new Set(expected.addresses);
    const after = new Set(actual.addresses);
    return [
      ...[...after].filter(identity => !before.has(identity)).map(identity => ({ item, kind: 'extra' as const, identity })),
      ...[...before].filter(identity => !after.has(identity)).map(identity => ({ item, kind: 'missing' as const, identity })),
    ];
  }
  if (expected.kind !== 'config_list' || actual.kind !== 'config_list') return null;
  const before = new Map(expected.rows.map(row => [row.id, row.values]));
  const after = new Map(actual.rows.map(row => [row.id, row.values]));
  const diffs: Difference[] = [];
  for (const [identity, values] of after) {
    const prior = before.get(identity);
    if (!prior) { diffs.push({ item, kind: 'extra', identity }); continue; }
    for (const field of Object.keys(values)) if (values[field] !== prior[field]) diffs.push({ item, kind: 'changed', identity, field });
  }
  for (const identity of before.keys()) if (!after.has(identity)) diffs.push({ item, kind: 'missing', identity });
  return diffs;
}

export function againstBaseline(items: readonly BedItem[], bed: unknown, reads: readonly BedRead[]): Difference[] | null {
  const diffs: Difference[] = [];
  for (const item of items) {
    const read = reads.find(entry => entry.id === item.id);
    if (!read?.ok) return null;
    const baseline = parseBaseline(item, bed);
    if (baseline === null) return null;
    const part = differences(item.id, baseline, read.canonical);
    if (part === null) return null;
    diffs.push(...part);
  }
  return diffs;
}

export function againstStored(items: readonly BedItem[], stored: Readonly<Record<string, Canonical>>, reads: readonly BedRead[]): Difference[] | null {
  const diffs: Difference[] = [];
  for (const item of items) {
    const read = reads.find(entry => entry.id === item.id);
    const prior = stored[item.id];
    if (!read?.ok || !prior) return null;
    const part = differences(item.id, prior, read.canonical);
    if (part === null) return null;
    diffs.push(...part);
  }
  return diffs;
}
