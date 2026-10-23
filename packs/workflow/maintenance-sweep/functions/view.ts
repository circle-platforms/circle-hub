import { ENTRY_KIND, CHANGE_KIND } from './generated/vocabulary.ts';
// impact-view@1 as this pack reads it. The shape is contracts/src/views.ts; this parser does not import it, because a pack
// function may load only modules inside the pack. A view that is not that shape is refused, not guessed.

import { isRecord } from './text.ts';

const SHA = /^[0-9a-f]{64}$/;
const PATH = /^\/(?:[^/@]+(?:\/[^/@]+)*)?$/;
const TREE = /^tree:[0-9a-f]{64}\/(?:[^/@]+(?:\/[^/@]+)*)?@[0-9a-f]{64}$/;
const CATALOG = /^[a-z][a-z0-9_.-]*@(?:0|[1-9][0-9]*)$/;
const KINDS = new Set<string>(ENTRY_KIND);
const CHANGES = new Set<string>(CHANGE_KIND);

export interface Cited {
  entry: string;
  kind: string;
  reference: string;
}

export interface NormEntry extends Cited {
  statement: string;
  data: { [key: string]: unknown };
}

export interface NormChange {
  path: string;
  change: string;
  before: string[];
  after: string[];
}

export interface NormPlacement {
  path: string;
  from: string[];
  to: string[];
}

export interface NormView {
  product: string;
  fromBuild: string;
  fromRoot: string;
  toBuild: string;
  toRoot: string;
  changedKinds: string[];
  attachedKinds: string[];
  /** The catalog the view was filtered to (members compared by syntax); null: no catalog filter. */
  catalog: string | null;
  changes: NormChange[];
  placements: NormPlacement[];
  entries: Map<string, NormEntry>;
  changedPaths: number;
  truncated: boolean;
  skippedFrom: number;
  skippedTo: number;
  notes: string[];
}

export type ParseResult = { ok: true; view: NormView } | { ok: false; message: string };

const fail = (message: string): ParseResult => ({ ok: false, message });

function shaList(value: unknown, what: string): string[] | string {
  if (!Array.isArray(value)) return `${what} 不是数组`;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !SHA.test(item)) return `${what} 里有不是摘要的值`;
    out.push(item);
  }
  return out;
}

function kindList(value: unknown, what: string): string[] | string {
  if (!Array.isArray(value)) return `${what} 不是数组`;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !KINDS.has(item)) return `${what} 里有未知的条目种类`;
    out.push(item);
  }
  return out;
}

function count(value: unknown, what: string): number | string {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return `${what} 不是非负整数`;
  return value;
}

/** Parses an impact-view@1 value. `message` says what is wrong, in Chinese. */
export function parseView(value: unknown): ParseResult {
  if (!isRecord(value) || value.schema !== 'impact-view@1') return fail('绑定的源文件不是 impact-view@1');
  if (typeof value.product !== 'string' || value.product === '') return fail('影响视图没有产品');
  if (!isRecord(value.from) || typeof value.from.build !== 'string' || value.from.build === '' || typeof value.from.root !== 'string' || !SHA.test(value.from.root)) {
    return fail('影响视图的起始构建不对');
  }
  if (!isRecord(value.to) || typeof value.to.build !== 'string' || value.to.build === '' || typeof value.to.root !== 'string' || !SHA.test(value.to.root)) {
    return fail('影响视图的目标构建不对');
  }
  const changedKinds = kindList(value.changed_kinds, '变更种类');
  if (typeof changedKinds === 'string') return fail(changedKinds);
  if (changedKinds.length === 0) return fail('影响视图没有变更种类');
  const attachedKinds = kindList(value.attached_kinds, '附着种类');
  if (typeof attachedKinds === 'string') return fail(attachedKinds);
  if (value.catalog !== undefined && (typeof value.catalog !== 'string' || !CATALOG.test(value.catalog))) return fail('影响视图的目录名不对');
  if (!Array.isArray(value.changes)) return fail('影响视图没有变更列表');
  if (!Array.isArray(value.placements)) return fail('影响视图没有放置列表');
  if (!isRecord(value.entries)) return fail('影响视图没有条目表');
  if (!isRecord(value.totals)) return fail('影响视图没有合计');
  const changedPaths = count(value.totals.changed_paths, '变更路径条数');
  if (typeof changedPaths === 'string') return fail(changedPaths);
  if (typeof value.truncated !== 'boolean') return fail('影响视图没有说明是否被截断');
  if (!isRecord(value.skipped)) return fail('影响视图没有跳过的来源数');
  const skippedFrom = count(value.skipped.from, '起始构建跳过的来源数');
  const skippedTo = count(value.skipped.to, '目标构建跳过的来源数');
  if (typeof skippedFrom === 'string') return fail(skippedFrom);
  if (typeof skippedTo === 'string') return fail(skippedTo);
  if (!Array.isArray(value.notes) || value.notes.some((note) => typeof note !== 'string')) return fail('影响视图的说明不是字符串列表');

  const changes: NormChange[] = [];
  for (const raw of value.changes) {
    if (!isRecord(raw) || typeof raw.path !== 'string' || !PATH.test(raw.path)) return fail('有一条变更的路径写法不对');
    if (typeof raw.change !== 'string' || !CHANGES.has(raw.change)) return fail(`路径 ${raw.path} 的变更种类未知`);
    const before = shaList(raw.before, `路径 ${raw.path} 的变更前条目`);
    const after = shaList(raw.after, `路径 ${raw.path} 的变更后条目`);
    if (typeof before === 'string') return fail(before);
    if (typeof after === 'string') return fail(after);
    changes.push({ path: raw.path, change: raw.change, before, after });
  }
  const placements: NormPlacement[] = [];
  for (const raw of value.placements) {
    if (!isRecord(raw) || typeof raw.path !== 'string' || !PATH.test(raw.path)) return fail('有一条放置的路径写法不对');
    const from = shaList(raw.from, `路径 ${raw.path} 的较早放置`);
    const to = shaList(raw.to, `路径 ${raw.path} 的较后放置`);
    if (typeof from === 'string') return fail(from);
    if (typeof to === 'string') return fail(to);
    placements.push({ path: raw.path, from, to });
  }
  const entries = new Map<string, NormEntry>();
  for (const [key, raw] of Object.entries(value.entries)) {
    if (!SHA.test(key) || !isRecord(raw)) return fail('条目表的键或值不对');
    if (raw.entry !== key) return fail(`条目 ${key.slice(0, 12)} 的摘要和键不一致`);
    if (typeof raw.kind !== 'string' || !KINDS.has(raw.kind)) return fail(`条目 ${key.slice(0, 12)} 的种类未知`);
    if (typeof raw.statement !== 'string') return fail(`条目 ${key.slice(0, 12)} 没有陈述`);
    if (!isRecord(raw.data)) return fail(`条目 ${key.slice(0, 12)} 的数据不是对象`);
    if (typeof raw.reference !== 'string' || !TREE.test(raw.reference)) return fail(`条目 ${key.slice(0, 12)} 的引用不是树引用`);
    entries.set(key, { entry: key, kind: raw.kind, statement: raw.statement, data: raw.data, reference: raw.reference });
  }
  return {
    ok: true,
    view: {
      product: value.product,
      fromBuild: value.from.build,
      fromRoot: value.from.root,
      toBuild: value.to.build,
      toRoot: value.to.root,
      changedKinds,
      attachedKinds,
      catalog: typeof value.catalog === 'string' ? value.catalog : null,
      changes,
      placements,
      entries,
      changedPaths,
      truncated: value.truncated,
      skippedFrom,
      skippedTo,
      notes: value.notes as string[],
    },
  };
}
