// Bed-surface declarations. The shape and the judgment live here. A product pack fills in the probe seats,
// the parsed fields and the cleanup references. Nothing in this module names a product or matches wording.
import SHAPE from '../tables/bed-surface.json' with { type: 'json' };
import { parseIp, parseIpv4ish } from './addresses.ts';
import { isRecord } from './common.ts';

const ID = /^[a-z][a-z0-9-]{0,63}$/;
const FIELD = /^[a-z][a-z0-9_]{0,63}$/;
const POINTER = /^\/(?:[^~/]|~[01])+(?:\/(?:[^~/]|~[01])+)*$/;
const TEXT = 200;

export interface SurfaceExit {
  action: string;
  object: string;
  owner: string;
  deadline: string;
}

export interface SurfaceCleanup {
  residue: string;
  command: string;
  granularity: 'row' | 'table';
  confirm: 'none' | 'interactive';
  channel: 'single_shot';
  /** False when confirmation is interactive and the channel is a single shot. */
  automatic: boolean;
  exit: SurfaceExit | null;
}

export interface SurfaceField {
  name: string;
  pointer?: string;
  start?: number;
  end?: number;
  cidr?: boolean;
  role: 'baseline' | 'residue';
  from: 'interfaces' | 'config' | 'values';
  values: string[];
}

export interface SurfaceProbe {
  id: string;
  seat: string;
  parser: 'row_table' | 'text_table';
  output?: string;
  header?: string;
  manifest_device?: string;
  snapshot_only?: boolean;
  fields: SurfaceField[];
  empty: { kind: 'header_only'; header?: string; rows?: string };
  cleanups: SurfaceCleanup[];
}

export interface SurfaceDeclaration {
  schema: 'bed-surface@1';
  probes: SurfaceProbe[];
}

export interface SurfaceResidue {
  probe: string;
  field: string;
  identity: string;
}

export interface SurfaceAction {
  probe: string;
  seat: string;
  command: string;
  granularity: 'row' | 'table';
  identities: string[];
}

export type SurfaceJudgment =
  | {
      ok: true;
      occupancy: 'empty' | 'occupied';
      residues: SurfaceResidue[];
      automatic: boolean;
      cleanup: SurfaceAction[] | null;
      exits: SurfaceExit[];
    }
  | { ok: false; missing: string; next: string };

function problem(pointer: string, message: string): { pointer: string; message: string } {
  return { pointer, message };
}

function text(value: unknown, max = TEXT): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;
}

function oneOf<T extends string>(value: unknown, allowed: readonly string[]): T | null {
  return typeof value === 'string' && allowed.includes(value) ? (value as T) : null;
}

function at(value: unknown, pointer: string): unknown {
  if (!pointer.startsWith('/')) return undefined;
  let current = value;
  for (const raw of pointer.slice(1).split('/')) {
    if (!current || typeof current !== 'object') return undefined;
    const key = raw.replaceAll('~1', '/').replaceAll('~0', '~');
    if (Array.isArray(current)) {
      if (!/^(0|[1-9][0-9]*)$/.test(key)) return undefined;
      const index = Number(key);
      if (index >= current.length) return undefined;
      current = current[index];
    } else if (!Object.hasOwn(current, key)) return undefined;
    else current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function parseExit(value: unknown, pointer: string, problems: Array<{ pointer: string; message: string }>): SurfaceExit | null {
  if (!isRecord(value)) {
    problems.push(problem(pointer, '交互确认的单发通道必须给出出口'));
    return null;
  }
  const action = text(value.action);
  const object = text(value.object);
  const owner = text(value.owner);
  const deadline = text(value.deadline);
  if (!action || !object || !owner || !deadline) problems.push(problem(pointer, '出口要写 action、object、owner、deadline，每项都是非空短文字'));
  const extra = Object.keys(value).filter((key) => !['action', 'object', 'owner', 'deadline'].includes(key));
  if (extra.length) problems.push(problem(pointer, '出口只含 action、object、owner、deadline'));
  return action && object && owner && deadline ? { action, object, owner, deadline } : null;
}

function parseField(value: unknown, pointer: string, parserKind: SurfaceProbe['parser'], problems: Array<{ pointer: string; message: string }>): SurfaceField | null {
  if (!isRecord(value)) {
    problems.push(problem(pointer, '字段必须是对象'));
    return null;
  }
  const name = text(value.name, 64);
  const path = text(value.pointer, 200);
  const start = typeof value.start === 'number' && Number.isInteger(value.start) && value.start >= 0 ? value.start : (value.start === undefined ? 0 : null);
  const end = typeof value.end === 'number' && Number.isInteger(value.end) && value.end >= 0 ? value.end : (value.end === undefined ? undefined : null);
  const cidr = typeof value.cidr === 'boolean' ? value.cidr : (value.cidr === undefined ? false : null);
  const role = oneOf<SurfaceField['role']>(value.role, SHAPE.field_role);
  const from = oneOf<SurfaceField['from']>(value.from, SHAPE.baseline_from);
  if (!name || !FIELD.test(name)) problems.push(problem(`${pointer}/name`, '字段名须为小写标识'));
  if (parserKind === 'row_table') {
    if (!path || !POINTER.test(path)) problems.push(problem(`${pointer}/pointer`, '字段指针须是行内 JSON 指针'));
  } else {
    if (path !== null && path !== undefined && !POINTER.test(path)) problems.push(problem(`${pointer}/pointer`, '字段指针须是行内 JSON 指针'));
    if (start === null) problems.push(problem(`${pointer}/start`, '起始列须是非负整数'));
    if (end === null) problems.push(problem(`${pointer}/end`, '结束列须是非负整数'));
    if (cidr === null) problems.push(problem(`${pointer}/cidr`, 'cidr 须是布尔值'));
  }
  if (!role) problems.push(problem(`${pointer}/role`, `字段角色须是 ${SHAPE.field_role.join('、')}`));
  if (!from) problems.push(problem(`${pointer}/from`, `基线来源须是 ${SHAPE.baseline_from.join('、')}`));
  let values: string[] = [];
  if (from === 'values') {
    if (!Array.isArray(value.values) || value.values.length > 32 || value.values.some((item) => typeof item !== 'string' || item.length > TEXT)) {
      problems.push(problem(`${pointer}/values`, 'values 来源要给出至多 32 个短字符串，空数组表示没有任何基线值'));
    } else values = [...value.values];
  } else if (value.values !== undefined) problems.push(problem(`${pointer}/values`, '只有 values 来源才写 values'));
  if (!name || !FIELD.test(name) || !role || !from) return null;
  if (parserKind === 'row_table' && (!path || !POINTER.test(path))) return null;
  if (parserKind === 'text_table' && (start === null || end === null || cidr === null)) return null;
  return {
    name,
    ...(path ? { pointer: path } : {}),
    ...(parserKind === 'text_table' ? { start: typeof start === 'number' ? start : 0, ...(typeof end === 'number' ? { end } : {}), ...(cidr ? { cidr: true } : {}) } : {}),
    role,
    from,
    values,
  };
}

function parseCleanup(value: unknown, pointer: string, residueNames: ReadonlySet<string>, problems: Array<{ pointer: string; message: string }>): SurfaceCleanup | null {
  if (!isRecord(value)) {
    problems.push(problem(pointer, '清理引用必须是对象'));
    return null;
  }
  const residue = text(value.residue, 64);
  const command = text(value.command, 500);
  const granularity = oneOf<SurfaceCleanup['granularity']>(value.granularity, SHAPE.granularity);
  const confirm = oneOf<SurfaceCleanup['confirm']>(value.confirm, SHAPE.confirm);
  const channel = oneOf<SurfaceCleanup['channel']>(value.channel, SHAPE.channel);
  if (!residue || !FIELD.test(residue) || !residueNames.has(residue)) problems.push(problem(`${pointer}/residue`, '清理引用的残留类必须是本探针的残留字段'));
  if (!command) problems.push(problem(`${pointer}/command`, '清理引用要给出命令'));
  if (!granularity) problems.push(problem(`${pointer}/granularity`, `粒度须是 ${SHAPE.granularity.join('、')}`));
  if (!confirm) problems.push(problem(`${pointer}/confirm`, `确认方式须是 ${SHAPE.confirm.join('、')}`));
  if (!channel) problems.push(problem(`${pointer}/channel`, `通道须是 ${SHAPE.channel.join('、')}`));
  const interactive = confirm === 'interactive' && channel === 'single_shot';
  if (interactive && value.exit === undefined) problems.push(problem(`${pointer}/exit`, '需要交互确认而单发通道做不到，标成不可自动清理，必须给出口'));
  if (!interactive && value.exit !== undefined) problems.push(problem(`${pointer}/exit`, '可自动清理的引用不写出口'));
  const exit = interactive ? parseExit(value.exit, `${pointer}/exit`, problems) : null;
  if (!residue || !command || !granularity || !confirm || !channel || !FIELD.test(residue) || !residueNames.has(residue)) return null;
  if (interactive && !exit) return null;
  return { residue, command, granularity, confirm, channel, automatic: !interactive, exit };
}

/** Parse a bed-surface@1 document. Product names are data in the document, not in this parser. */
export function parseBedSurface(input: unknown): { ok: true; declaration: SurfaceDeclaration } | { ok: false; problems: Array<{ pointer: string; message: string }> } {
  const problems: Array<{ pointer: string; message: string }> = [];
  if (!isRecord(input) || input.schema !== SHAPE.document) return { ok: false, problems: [problem('/schema', `schema 须是 ${SHAPE.document}`)] };
  if (!Array.isArray(input.probes) || input.probes.length < 1 || input.probes.length > 20) problems.push(problem('/probes', '探针须是 1 到 20 项'));
  const probes: SurfaceProbe[] = [];
  const ids = new Set<string>();
  for (const [index, raw] of (Array.isArray(input.probes) ? input.probes : []).entries()) {
    const pointer = `/probes/${index}`;
    if (!isRecord(raw)) {
      problems.push(problem(pointer, '探针必须是对象'));
      continue;
    }
    const id = text(raw.id, 64);
    const seat = text(raw.seat);
    const parser = oneOf<SurfaceProbe['parser']>(raw.parser, SHAPE.parser);
    if (!id || !ID.test(id) || ids.has(id)) problems.push(problem(`${pointer}/id`, '探针 id 须唯一，且为小写短名'));
    else ids.add(id);
    if (!seat) problems.push(problem(`${pointer}/seat`, '要写读取命令所在的执行器座位'));
    if (!parser) problems.push(problem(`${pointer}/parser`, `解析器须是 ${SHAPE.parser.join('、')}`));
    const fields: SurfaceField[] = [];
    if (!Array.isArray(raw.fields) || raw.fields.length < 1 || raw.fields.length > 16) problems.push(problem(`${pointer}/fields`, '字段须是 1 到 16 项'));
    else for (const [fieldAt, field] of raw.fields.entries()) {
      const parsed = parseField(field, `${pointer}/fields/${fieldAt}`, parser ?? 'row_table', problems);
      if (parsed) fields.push(parsed);
    }
    if (new Set(fields.map((field) => field.name)).size !== fields.length) problems.push(problem(`${pointer}/fields`, '字段名不得重复'));
    const residueNames = new Set(fields.filter((field) => field.role === 'residue').map((field) => field.name));
    if (residueNames.size === 0) problems.push(problem(`${pointer}/fields`, '至少有一个残留字段'));
    let empty: SurfaceProbe['empty'] | null = null;
    if (!isRecord(raw.empty) || oneOf(raw.empty.kind, SHAPE.empty) !== 'header_only') problems.push(problem(`${pointer}/empty`, '空表判据须是 header_only'));
    else if (parser === 'row_table') {
      const header = text(raw.empty.header, 200);
      const rows = text(raw.empty.rows, 200);
      if (!header || !rows || !POINTER.test(header) || !POINTER.test(rows) || header === rows) problems.push(problem(`${pointer}/empty`, 'header_only 要给出不同的表头指针和行指针'));
      else empty = { kind: 'header_only', header, rows };
    } else {
      empty = { kind: 'header_only', ...(raw.empty.header ? { header: String(raw.empty.header) } : {}) };
    }
    const cleanups: SurfaceCleanup[] = [];
    if (!Array.isArray(raw.cleanups)) problems.push(problem(`${pointer}/cleanups`, '清理引用必须是数组'));
    else for (const [cleanupAt, cleanup] of raw.cleanups.entries()) {
      const parsed = parseCleanup(cleanup, `${pointer}/cleanups/${cleanupAt}`, residueNames, problems);
      if (parsed) cleanups.push(parsed);
    }
    for (const name of residueNames) if (cleanups.filter((cleanup) => cleanup.residue === name).length !== 1) problems.push(problem(`${pointer}/cleanups`, `残留字段 ${name} 要有且只有一条清理引用`));
    const probeHeader = text(raw.header, 500) ?? undefined;
    const probeOutput = text(raw.output, 200) ?? undefined;
    const probeManifestDevice = text(raw.manifest_device, 200) ?? undefined;
    const probeSnapshotOnly = typeof raw.snapshot_only === 'boolean' ? raw.snapshot_only : undefined;
    if (id && seat && parser && empty && ID.test(id) && fields.length) {
      probes.push({
        id,
        seat,
        parser,
        ...(probeHeader !== undefined ? { header: probeHeader } : {}),
        ...(probeOutput !== undefined ? { output: probeOutput } : {}),
        ...(probeManifestDevice !== undefined ? { manifest_device: probeManifestDevice } : {}),
        ...(probeSnapshotOnly !== undefined ? { snapshot_only: probeSnapshotOnly } : {}),
        fields,
        empty,
        cleanups,
      });
    }
  }
  return problems.length ? { ok: false, problems } : { ok: true, declaration: { schema: 'bed-surface@1', probes } };
}

function addressTexts(entry: unknown): string[] {
  if (typeof entry === 'string' && entry.length > 0 && entry.length <= 80) {
    const slash = entry.lastIndexOf('/');
    const bare = slash > 0 ? entry.slice(0, slash) : entry;
    return bare === entry ? [entry] : [entry, bare];
  }
  if (isRecord(entry) && typeof entry.address === 'string' && entry.address.length > 0 && entry.address.length <= 80) return [entry.address];
  return [];
}

export function toCIDR(value: string): string | null {
  const trimmed = value.trim();
  const slash = trimmed.lastIndexOf('/');
  if (slash > 0) {
    const ip = trimmed.slice(0, slash).trim();
    const prefix = trimmed.slice(slash + 1);
    if (/^\d+$/.test(prefix)) return `${ip}/${prefix}`;
  }
  const parts = trimmed.split(/\s+/);
  if (parts.length === 2) {
    const [ip, mask] = parts;
    const maskOctets = mask.split('.').map(Number);
    if (maskOctets.length === 4 && maskOctets.every((o) => !Number.isNaN(o) && o >= 0 && o <= 255)) {
      const bits = maskOctets.map((o) => o.toString(2).padStart(8, '0')).join('');
      if (/^1*0*$/.test(bits)) {
        const prefix = bits.indexOf('0') === -1 ? 32 : bits.indexOf('0');
        return `${ip}/${prefix}`;
      }
    }
    if (parseIp(ip) !== null && !parseIpv4ish(ip)) {
      const bits = prefixBits(mask, 128);
      if (bits === null) return null;
      return `${ip}/${bits}`;
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

/** Baseline strings for one field, taken from the frozen bed by the field's declared source. */
export function baselineOf(field: SurfaceField, bed: unknown, manifestDevice?: string): string[] | null {
  if (field.from === 'values') return [...field.values].sort();
  if (!isRecord(bed)) return null;
  if (field.from === 'interfaces') {
    let devices: unknown[];
    if (manifestDevice) {
      const dev = at(bed, manifestDevice);
      if (!dev || typeof dev !== 'object' || Array.isArray(dev)) return null;
      devices = [dev];
    } else {
      if (!Array.isArray(bed.devices)) return null;
      devices = bed.devices;
    }
    const found: string[] = [];
    for (const device of devices) {
      if (!isRecord(device)) return null;
      for (const key of ['ipv4', 'ipv6']) {
        const list = device[key];
        if (list === undefined) continue;
        if (!Array.isArray(list)) return null;
        for (const entry of list) found.push(...addressTexts(entry));
      }
    }
    return [...new Set(found)].sort();
  }
  const rows = bed.baseline === undefined ? [] : bed.baseline;
  if (!Array.isArray(rows)) return null;
  const found: string[] = [];
  for (const row of rows) {
    if (!isRecord(row) || !isRecord(row.values)) continue;
    const value = row.values[field.name];
    if (typeof value === 'string') found.push(value);
  }
  return [...new Set(found)].sort();
}

function headerOnly(probe: SurfaceProbe, value: unknown): boolean {
  if (probe.parser === 'text_table') return false;
  const header = at(value, probe.empty.header ?? '');
  const rows = at(value, probe.empty.rows ?? '');
  return Array.isArray(header) && header.length > 0 && header.length <= 16 && header.every((cell) => typeof cell === 'string' && cell.length > 0 && cell.length <= 80) && Array.isArray(rows) && rows.length === 0;
}

function rowsOf(probe: SurfaceProbe, value: unknown): unknown[] | null {
  if (probe.parser === 'text_table') return null;
  const rows = at(value, probe.empty.rows ?? '');
  if (!Array.isArray(rows) || rows.length > 64) return null;
  return rows;
}

/**
 * Judge one frozen bed against a declaration and the probe observations.
 * An empty header with no body rows is empty occupancy, not residue. Residue is a parsed field value
 * outside that field's baseline set. Interactive confirmation on a single-shot channel is not automatic.
 */
export function judgeBedSurface(declaration: unknown, bed: unknown, reads: readonly { id: string; value?: unknown }[]): SurfaceJudgment {
  const parsed = parseBedSurface(declaration);
  if (!parsed.ok) return { ok: false, missing: '床面声明无法解析', next: `下一步：按 ${SHAPE.document} 修正声明（${parsed.problems[0]?.pointer ?? '/'}：${parsed.problems[0]?.message ?? '形状不符'}）后重新冻结再派发` };
  const residues: SurfaceResidue[] = [];
  const blocked: SurfaceExit[] = [];
  const actions: SurfaceAction[] = [];
  for (const probe of parsed.declaration.probes) {
    const read = reads.find((item) => item.id === probe.id);
    if (!read || read.value === undefined) return { ok: false, missing: `床面探针缺失：${probe.id}`, next: `下一步：在座位 ${probe.seat} 重读探针 ${probe.id} 后再派发` };
    if (probe.parser === 'text_table') {
      const raw = isRecord(read.value) ? (at(read.value, probe.output ?? '/output') ?? at(read.value, '/text')) : (typeof read.value === 'string' ? read.value : null);
      if (typeof raw !== 'string') return { ok: false, missing: `探针 ${probe.id} 没有按声明解析出文本`, next: `下一步：在座位 ${probe.seat} 重读探针 ${probe.id} 后再派发` };
      const lines = raw.split(/\r?\n/).map((l) => l.trimEnd());
      const declaredHeader = probe.header ?? (probe.empty.header && !probe.empty.header.startsWith('/') ? probe.empty.header : undefined);
      let dataLines: string[];
      if (declaredHeader !== undefined) {
        const headerIdx = lines.findIndex((l) => l === declaredHeader);
        if (headerIdx === -1) {
          return { ok: false, missing: `探针 ${probe.id} 没有按声明找到表头`, next: `下一步：在座位 ${probe.seat} 重读探针 ${probe.id}，按声明的表头解析后再派发` };
        }
        dataLines = lines.slice(headerIdx + 1).filter((l) => l.trim().length > 0);
      } else {
        dataLines = lines.filter((l) => l.trim().length > 0);
      }
      if (dataLines.length === 0 || probe.snapshot_only) {
        continue;
      }
      const sets = new Map<string, Set<string>>();
      for (const field of probe.fields) {
        const baseline = baselineOf(field, bed, probe.manifest_device);
        if (!baseline) return { ok: false, missing: `探针 ${probe.id} 的字段 ${field.name} 缺少冻结基线`, next: '下一步：核对冻结台架的接口或基线配置后再派发' };
        sets.set(field.name, new Set(baseline));
      }
      const byField = new Map<string, string[]>();
      for (const line of dataLines) {
        for (const field of probe.fields) {
          let value: string;
          if (field.start !== undefined) {
            value = line.length > field.start ? (field.end !== undefined ? line.slice(field.start, field.end).trim() : line.slice(field.start).trim()) : '';
          } else if (probe.fields.length === 1) {
            value = line.trim();
          } else {
            value = line.trim();
          }
          if (field.cidr) {
            const cidr = toCIDR(value);
            value = cidr ?? value;
          }
          if (typeof value !== 'string' || value.length === 0 || value.length > TEXT) return { ok: false, missing: `探针 ${probe.id} 的字段 ${field.name} 没有解析成字符串`, next: `下一步：在座位 ${probe.seat} 重读探针 ${probe.id} 后再派发` };
          if (field.role !== 'residue') continue;
          const allowed = sets.get(field.name);
          if (allowed?.has(value)) continue;
          const held = byField.get(field.name) ?? [];
          held.push(value);
          byField.set(field.name, held);
        }
      }
      for (const [field, identities] of byField) {
        const unique = [...new Set(identities)].sort();
        for (const identity of unique) residues.push({ probe: probe.id, field, identity });
        const cleanup = probe.cleanups.find((item) => item.residue === field);
        if (!cleanup || !cleanup.automatic) {
          if (cleanup?.exit) blocked.push(cleanup.exit);
          else blocked.push({ action: '为该残留类补一条可执行的清理引用', object: `探针 ${probe.id} 的字段 ${field}`, owner: '声明维护者', deadline: '重新派发之前' });
          continue;
        }
        actions.push({ probe: probe.id, seat: probe.seat, command: cleanup.command, granularity: cleanup.granularity, identities: unique });
      }
      continue;
    }
    if (headerOnly(probe, read.value)) continue;
    const rows = rowsOf(probe, read.value);
    if (!rows || rows.length === 0 || rows.some((row) => !isRecord(row))) return { ok: false, missing: `探针 ${probe.id} 没有按声明解析出表`, next: `下一步：在座位 ${probe.seat} 重读探针 ${probe.id}，按声明的表头和行指针解析后再派发` };
    const sets = new Map<string, Set<string>>();
    for (const field of probe.fields) {
      const baseline = baselineOf(field, bed, probe.manifest_device);
      if (!baseline) return { ok: false, missing: `探针 ${probe.id} 的字段 ${field.name} 缺少冻结基线`, next: '下一步：核对冻结台架的接口或基线配置后再派发' };
      sets.set(field.name, new Set(baseline));
    }
    const byField = new Map<string, string[]>();
    for (const row of rows) {
      for (const field of probe.fields) {
        const value = at(row, field.pointer ?? '');
        if (typeof value !== 'string' || value.length === 0 || value.length > TEXT) return { ok: false, missing: `探针 ${probe.id} 的字段 ${field.name} 没有解析成字符串`, next: `下一步：在座位 ${probe.seat} 重读探针 ${probe.id} 后再派发` };
        if (field.role !== 'residue') continue;
        const allowed = sets.get(field.name);
        if (allowed?.has(value)) continue;
        const held = byField.get(field.name) ?? [];
        held.push(value);
        byField.set(field.name, held);
      }
    }
    for (const [field, identities] of byField) {
      const unique = [...new Set(identities)].sort();
      for (const identity of unique) residues.push({ probe: probe.id, field, identity });
      const cleanup = probe.cleanups.find((item) => item.residue === field);
      if (!cleanup || !cleanup.automatic) {
        if (cleanup?.exit) blocked.push(cleanup.exit);
        else blocked.push({ action: '为该残留类补一条可执行的清理引用', object: `探针 ${probe.id} 的字段 ${field}`, owner: '声明维护者', deadline: '重新派发之前' });
        continue;
      }
      actions.push({ probe: probe.id, seat: probe.seat, command: cleanup.command, granularity: cleanup.granularity, identities: unique });
    }
  }
  residues.sort((left, right) => (left.probe < right.probe ? -1 : left.probe > right.probe ? 1 : left.field < right.field ? -1 : left.field > right.field ? 1 : left.identity < right.identity ? -1 : left.identity > right.identity ? 1 : 0));
  if (!residues.length) return { ok: true, occupancy: 'empty', residues: [], automatic: false, cleanup: null, exits: [] };
  if (blocked.length) return { ok: true, occupancy: 'occupied', residues, automatic: false, cleanup: null, exits: blocked };
  return { ok: true, occupancy: 'occupied', residues, automatic: true, cleanup: actions, exits: [] };
}
