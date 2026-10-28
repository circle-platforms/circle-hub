// Bed snapshots compare declared parser structure with frozen manifest fields. Wording is never a match.
import { isIP } from 'node:net';
import { at, type ExecutorDefinition } from './definition.ts';

export type BedState = NonNullable<ExecutorDefinition['bed_state']>;
export type BedItem = BedState['items'][number];
export const SHARED_BED_LIMIT = '未排除共享床影响';
export const UNRESTORED_LIMIT = '床面未恢复';
const BED_NAME = /^[a-z0-9-]{1,64}$/;

export interface Difference {
  item: string;
  kind: 'extra' | 'missing' | 'changed';
  identity: string;
  field?: string;
  pre_sha256?: string;
  post_sha256?: string;
  diff_lines?: string[];
}
export type Canonical = { kind: 'address_table'; addresses: string[] } | { kind: 'config_list'; rows: Array<{ id: string; values: Record<string, string> }> };
export type BedRead =
  | { id: string; ok: true; canonical: Canonical; text?: string; sha256?: string; reference?: string; value?: unknown; source: string }
  | { id: string; ok: false; value?: unknown; source: string | null };
export interface BedReport {
  bed: string;
  pre: 'passed';
  recovery: 'restored' | 'unrestored' | 'unknown';
  differences: Difference[];
  originals: { pre: string[]; post: string[] };
  limits: string[];
  next_action: string | null;
}

export interface BedBaselineRecord {
  executor: string;
  probe: string;
  sha256: string;
  reference: string;
  text: string;
  recorded_by: string;
  created_at: string;
  reason?: string | null;
}

export function captureText(raw: string, lead?: readonly string[], trail?: readonly string[]): string {
  const lines = raw.split(/\r?\n/).map(l => l.trimEnd());
  while (lines.length > 0 && lines[lines.length - 1].trim().length === 0) {
    lines.pop();
  }
  if (trail && trail.length > 0) {
    while (lines.length > 0 && trail.some(t => t === lines[lines.length - 1])) {
      lines.pop();
      while (lines.length > 0 && lines[lines.length - 1].trim().length === 0) {
        lines.pop();
      }
    }
  }
  if (lead && lead.length > 0) {
    while (lines.length > 0 && lead.some(s => s === lines[0])) {
      lines.shift();
      while (lines.length > 0 && lines[0].trim().length === 0) {
        lines.shift();
      }
    }
  }
  return lines.join('\n');
}

export function lineDiff(expected: string, actual: string): string[] {
  if (expected === actual) return [];
  const expLines = expected.split('\n');
  const actLines = actual.split('\n');
  const diffs: string[] = [];
  const max = Math.max(expLines.length, actLines.length);
  for (let i = 0; i < max; i++) {
    const exp = expLines[i];
    const act = actLines[i];
    if (exp !== act) {
      if (exp !== undefined && act !== undefined) {
        diffs.push(`第 ${i + 1} 行改变: - ${exp} / + ${act}`);
      } else if (act !== undefined) {
        diffs.push(`第 ${i + 1} 行新增: + ${act}`);
      } else {
        diffs.push(`第 ${i + 1} 行缺失: - ${exp}`);
      }
    }
  }
  return diffs;
}

export function unregisteredBaselineFact(ids?: readonly string[]): string {
  return ids?.length ? `未登记基线，无法判残留。来源探针 ${ids.join('、')}` : '未登记基线，无法判残留';
}

export function unregisteredBaselineNext(executorId: string, ids?: readonly string[]): string {
  const probes = ids?.length ? ids.join('、') : '<id>';
  return `由管理员在床干净时用 circle-hub bed baseline record ${executorId} --probe ${probes} 登记基线后重开`;
}

export function residueCaptureFact(diffs: readonly { item: string; diff_lines?: string[] }[]): string {
  const probes = diffs.map(d => d.item).join('、');
  const lines = diffs.flatMap(d => d.diff_lines ?? []).slice(0, 5).join('；');
  return `床面存在残留，与登记基线不一致。来源探针 ${probes}${lines ? `；${lines}` : ''}`;
}

export function residueCaptureNext(items: readonly BedItem[], diffs: readonly { item: string }[], executorId: string): string {
  const map = new Map(items.map(i => [i.id, i]));
  const actions = diffs.map(d => {
    const item = map.get(d.item);
    if (!item) return '';
    return `由${item.cleanup.actor}按 ${item.cleanup.command} 处理后重开，或由管理员确认当前状态为新基线（circle-hub bed baseline record ${executorId} --probe ${item.id} --reason <理由>）`;
  }).filter(Boolean);
  return [...new Set(actions)].join('；');
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

export function undeclaredBaselineFact(ids?: readonly string[]): string {
  return ids?.length ? `未声明基线，无法判残留。来源探针 ${ids.join('、')}` : '未声明基线，无法判残留';
}

export function undeclaredBaselineNext(items: readonly BedItem[], ids: readonly string[]): string {
  const wanted = new Set(ids);
  return items.filter(item => wanted.has(item.id)).map(item => `由${item.cleanup.actor}在台架清单中声明 baseline 行或将通道声明为 snapshot_only 后重开`).join('；');
}

export function unrestoredFact(diffs: readonly Difference[]): string {
  return `该床尚未恢复，不能派发。来源探针 ${[...new Set(diffs.map(diff => diff.item))].join('、')}`;
}

export function missingProbeFact(ids: readonly string[]): string {
  return `床面探针缺失：${ids.join('、')}`;
}

/** Probes recorded on the open hold but absent from the current executor definition. */
export function ignoredHoldProbes(ids: readonly string[]): string {
  return `占用时的探针 ${ids.join('、')} 现在不在执行器定义里，没有比较`;
}

/** The hold cannot be compared because the probe sets no longer overlap. */
export function disjointHoldFact(job: string, held: readonly string[], current: readonly string[]): string {
  return `上一次派发（${job.slice(0, 12)}）留下的床面占用未结清，占用时的探针集与现在不同（占用时 ${held.join('、')}；现在 ${current.join('、')}）`;
}

export function holdClearNext(executorId: string): string {
  return `由管理员确认床面干净后运行 circle-hub bed hold clear ${executorId} --reason <理由>`;
}

/** Exit beside the cleanup steps when a hold is unrestored. The command is only for a state the administrator has already accepted as clean. */
export function unrestoredHoldNext(items: readonly BedItem[], ids: readonly string[], executorId: string): string {
  const cleanup = cleanupSteps(items, ids);
  const clear = `确认当前状态是干净的（例如设备已重启过、占用时的配置已不存在）才用 circle-hub bed hold clear ${executorId} --reason <理由>`;
  return [cleanup, clear].filter(Boolean).join('；');
}

export function holdMissingBaselineFact(ids: readonly string[]): string {
  return `无法比较床面占用：探针 ${ids.join('、')} 在占用时没有、现在有，没有登记基线`;
}

export interface HeldProbe { id: string; text?: string; sha256?: string }
export interface CurrentProbe { id: string; text?: string; sha256?: string }
export interface HeldComparison {
  outcome: 'clear' | 'unrestored' | 'unread' | 'no_baseline' | 'disjoint';
  differences: Difference[];
  unread: string[];
  missingBaseline: string[];
  ignored: string[];
  heldIds: string[];
  currentIds: string[];
}

/** Compare an open hold with the probes declared now. Overlap uses the held text; probes only in the current set use a registered baseline. */
export function compareHeldProbes(
  held: readonly HeldProbe[],
  current: readonly CurrentProbe[],
  baselines: ReadonlyMap<string, { text: string; sha256: string }>,
): HeldComparison {
  const heldIds = held.map(probe => probe.id);
  const currentIds = current.map(probe => probe.id);
  const heldSet = new Set(heldIds);
  const currentSet = new Set(currentIds);
  const ignored = heldIds.filter(id => !currentSet.has(id));
  const overlap = currentIds.filter(id => heldSet.has(id));
  const added = currentIds.filter(id => !heldSet.has(id));
  const base = { differences: [] as Difference[], unread: [] as string[], missingBaseline: [] as string[], ignored, heldIds, currentIds };
  if (overlap.length === 0) return { ...base, outcome: 'disjoint' };
  const heldById = new Map(held.map(probe => [probe.id, probe]));
  const currentById = new Map(current.map(probe => [probe.id, probe]));
  const unread: string[] = [];
  const differences: Difference[] = [];
  for (const id of overlap) {
    const prior = heldById.get(id);
    const now = currentById.get(id);
    if (prior?.text === undefined || now?.text === undefined) { unread.push(id); continue; }
    if (prior.text !== now.text) differences.push({ item: id, kind: 'changed', identity: id, diff_lines: lineDiff(prior.text, now.text), pre_sha256: prior.sha256, post_sha256: now.sha256 });
  }
  const missingBaseline: string[] = [];
  for (const id of added) {
    const now = currentById.get(id);
    if (now?.text === undefined) { unread.push(id); continue; }
    const baseline = baselines.get(id);
    if (!baseline) { missingBaseline.push(id); continue; }
    if (baseline.text !== now.text) differences.push({ item: id, kind: 'changed', identity: id, diff_lines: lineDiff(baseline.text, now.text), pre_sha256: baseline.sha256, post_sha256: now.sha256 });
  }
  if (unread.length) return { ...base, outcome: 'unread', differences, unread, missingBaseline };
  if (missingBaseline.length) return { ...base, outcome: 'no_baseline', differences, unread, missingBaseline };
  if (differences.length) return { ...base, outcome: 'unrestored', differences, unread, missingBaseline };
  return { ...base, outcome: 'clear', differences, unread, missingBaseline };
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

export function toCIDR(value: string): string | null {
  const trimmed = value.trim();
  const direct = interfaceKey(trimmed);
  if (direct !== null) return direct;
  const parts = trimmed.split(/\s+/);
  if (parts.length === 2) {
    const [ip, mask] = parts;
    const family = isIP(ip);
    if (family === 4) {
      const maskOctets = mask.split('.').map(Number);
      if (maskOctets.length === 4 && maskOctets.every(o => !Number.isNaN(o) && o >= 0 && o <= 255)) {
        const bits = maskOctets.map(o => o.toString(2).padStart(8, '0')).join('');
        if (/^1*0*$/.test(bits)) {
          const prefix = bits.indexOf('0') === -1 ? 32 : bits.indexOf('0');
          return interfaceKey(`${ip}/${prefix}`);
        }
      }
    }
    if (family === 6) {
      const bits = prefixBits(mask, 128);
      if (bits === null) return null;
      return interfaceKey(`${ip}/${bits}`);
    }
  }
  return null;
}

/** Decimal prefix length 0..max, or null. Two tokens only; this does not interpret the rest of a line. */
function prefixBits(text: string, max: number): number | null {
  if (text.length < 1 || text.length > 3) return null;
  let bits = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 48 || code > 57) return null;
    bits = bits * 10 + (code - 48);
  }
  if (bits > max) return null;
  return bits;
}

function addressSet(rows: unknown, address: string): string[] | null {
  if (!Array.isArray(rows)) return null;
  const found: string[] = [];
  for (const row of rows) {
    const value = at(row, address);
    if (typeof value !== 'string') return null;
    const key = toCIDR(value);
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
  if (!parser) return null;
  if (parser.kind === 'address_table') {
    const addresses = addressSet(at(reply, parser.rows), parser.address);
    return addresses === null ? null : { kind: 'address_table', addresses };
  }
  if (parser.kind === 'config_list') {
    const rows = configRows(at(reply, parser.rows), parser.identity, parser.fields);
    return rows === null ? null : { kind: 'config_list', rows };
  }
  if (parser.kind === 'text_table') {
    const textVal = at(reply, parser.text ?? item.output);
    if (typeof textVal !== 'string') return null;
    const lines = textVal.split(/\r?\n/).map(l => l.trimEnd());
    let dataLines: string[];
    if (parser.header !== undefined) {
      const idx = lines.findIndex(l => l === parser.header);
      if (idx === -1) return null; // Header not found! Parse failure.
      dataLines = lines.slice(idx + 1).filter(l => l.trim().length > 0);
    } else {
      dataLines = lines.filter(l => l.trim().length > 0);
    }
    const isAddress = parser.address !== undefined || parser.manifest_lists !== undefined || parser.manifest_device !== undefined || parser.manifest_devices !== undefined || parser.columns.some(c => c.cidr);
    if (isAddress) {
      if (dataLines.length === 0) return { kind: 'address_table', addresses: [] };
      const addresses: string[] = [];
      const addrCol = parser.columns.find(c => c.name === parser.address || c.cidr);
      for (const line of dataLines) {
        let rawVal: string;
        if (addrCol) {
          rawVal = line.length > addrCol.start ? line.slice(addrCol.start, addrCol.end).trim() : '';
        } else if (parser.columns.length === 0) {
          rawVal = line.trim();
        } else {
          rawVal = line.length > parser.columns[0].start ? line.slice(parser.columns[0].start, parser.columns[0].end).trim() : '';
        }
        const key = toCIDR(rawVal);
        if (key === null) return null;
        addresses.push(key);
      }
      return { kind: 'address_table', addresses: [...new Set(addresses)].sort() };
    } else {
      // Config list
      if (dataLines.length === 0) return { kind: 'config_list', rows: [] };
      const found: Array<{ id: string; values: Record<string, string> }> = [];
      const seen = new Set<string>();
      const idCol = parser.columns.find(c => c.name === parser.identity);
      for (const line of dataLines) {
        let id: string;
        if (idCol) {
          id = line.length > idCol.start ? line.slice(idCol.start, idCol.end).trim() : '';
        } else if (parser.columns.length === 0) {
          id = line.trim();
        } else {
          id = line.length > parser.columns[0].start ? line.slice(parser.columns[0].start, parser.columns[0].end).trim() : '';
        }
        if (id === '' || seen.has(id)) return null;
        seen.add(id);
        const values: Record<string, string> = {};
        for (const col of parser.columns) {
          if (col.name === idCol?.name) continue;
          const val = line.length > col.start ? line.slice(col.start, col.end).trim() : '';
          values[col.name] = col.cidr ? (toCIDR(val) ?? val) : val;
        }
        found.push({ id, values });
      }
      return { kind: 'config_list', rows: found.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) };
    }
  }
  return null;
}

export function parseBaseline(item: BedItem, bed: unknown): Canonical | null {
  const parser = item.parser;
  if (!parser) return null;
  const isAddress = parser.kind === 'address_table' || (parser.kind === 'text_table' && (parser.address !== undefined || parser.manifest_lists !== undefined || parser.manifest_device !== undefined || parser.manifest_devices !== undefined || parser.columns.some(c => c.cidr)));
  if (isAddress) {
    let devices: unknown[];
    if (parser.manifest_device !== undefined) {
      const dev = at(bed, parser.manifest_device);
      if (!dev || typeof dev !== 'object' || Array.isArray(dev)) return null;
      devices = [dev];
    } else if (parser.manifest_devices !== undefined) {
      const devs = at(bed, parser.manifest_devices);
      if (!Array.isArray(devs)) return null;
      devices = devs;
    } else {
      return null;
    }
    const found: string[] = [];
    const lists = parser.manifest_lists ?? ['/ipv4', '/ipv6'];
    for (const device of devices) {
      for (const list of lists) {
        const entries = at(device, list);
        if (!Array.isArray(entries)) return null;
        for (const entry of entries) {
          if (typeof entry !== 'string') return null;
          const key = toCIDR(entry);
          if (key === null) return null;
          found.push(key);
        }
      }
    }
    return { kind: 'address_table', addresses: [...new Set(found)].sort() };
  }
  // Config list
  if ('snapshot_only' in parser && parser.snapshot_only) {
    return { kind: 'config_list', rows: [] };
  }
  if (!parser.manifest_rows || !parser.manifest_identity || !parser.manifest_fields) {
    return null;
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
    if (item.parser && 'snapshot_only' in item.parser && item.parser.snapshot_only) {
      continue;
    }
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
