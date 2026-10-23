// The Hub's own views of the knowledge tree, served as external objects of the system `knowledge` (contracts/src/views.ts):
//   knowledge:impact:<product>:<from build>..<to build>[?changed=<kinds>&attached=<kinds>][&catalog=<catalog>]   the entry-level
//     version difference with the entries filed on the changed nodes (K01 R[1]: the version difference is the regression scope);
//     with catalog (e.g. catalog=commands@1, a literal @ reads the same as %40) only the members of that catalog count as
//     changes, read per root like read.ts catalog() and compared by syntax (catalog-entry@1 without the descriptive fields,
//     references and signature ids, overloads as a set); changed may then be omitted (the catalog's kind) or must equal it
//   knowledge:facets:<product>:<build>?kind=<kind>&by=<fields>   counts of entries by the values of data fields,
//     placed rows and the unplaced rows of the root (K01 R[4]), an entry once, an unplaced entry cited at the root
//   knowledge:index:<product>:<build>?kind=<kind>&key=<field>[&only=<values>]   data value -> the entries that carry it,
//     the same entries; impact stays the entries on changed paths
// Products resolve by id or any name, builds of any name family through their aliases to the root they use. The answer is
// canonical JSON with deterministic list order, sized exactly against the byte budget, checked against its schema and stored
// as the original of the read (equal content, equal bytes); the revision is built from the root digests. A reader who may
// not read the product, an unknown product or build and a malformed id give ok:false with the real reason for the admin log
// (callers show the neutral SOURCE_UNAVAILABLE, D05 R[3]); a root without entries of the asked kind is a valid answer with a
// note, and so is a root whose listed sources were not all used: what they would give is unknown, never absent.
import { ENTRY_KIND, EntryKindSchema, labelOf, type EntryKind } from '../../contracts/generated/vocabulary.ts';
import { RunId, Versioned } from '../../contracts/src/common.ts';
import {
  DataFieldName,
  FacetView,
  ImpactView,
  IndexView,
  MAX_FACET_ROWS,
  MAX_IMPACT_ENTRIES,
  MAX_IMPACT_PATHS,
  MAX_INDEX_ENTRIES,
  MAX_INDEX_PER_KEY,
  type PathChange,
  type Placement,
  type ViewEntry,
} from '../../contracts/src/views.ts';
import type { ExternalRead, ExternalReadContext, ExternalReaderPort, PacksPort } from '../ports.ts';
import { canonicalBytes, canonicalize, CREDENTIAL_FINDING_LIMIT, type DerivedCoverage, type ActionBody, type SourceArtifact } from '../records/api.ts';
import { treeReference } from '../refs/api.ts';
import type { Builds } from './builds.ts';
import type { CompositionView, ReadRow } from './composition.ts';
import type { KnowledgeContext } from './context.ts';
import { canonicalSize, compareText, cutText, type EntryContent } from './digest.ts';
import { describeError } from './errors.ts';
import type { TreeReading } from './read.ts';
import { ACTION, COMPONENTS, Lru } from './store.ts';

/** The system of the Hub's own knowledge views in external object ids. */
export const VIEW_SYSTEM = 'knowledge';
/** Default kinds of an impact view: what counts as a change, and what is listed on the changed nodes. */
export const DEFAULT_CHANGED_KINDS: readonly EntryKind[] = EntryKindSchema.extract(['definition', 'behaviour']).options;
export const DEFAULT_ATTACHED_KINDS: readonly EntryKind[] = EntryKindSchema.extract(['case']).options;
/** Most values of one entry's field combinations a facet view counts (a cross product of list fields). */
export const MAX_FACET_COMBINATIONS = 4096;
/** Most values an index view's `only` names. */
export const MAX_ONLY_VALUES = 1000;
/** Bytes of an answer kept for its fixed fields and notes: the lists get maxViewBytes less this, counted exactly. */
const VIEW_MARGIN = 64 * 1024;
/** Most references a note names. */
const NOTE_REFERENCES = 10;
/** A key a JSON object member cannot carry for a parser that builds plain objects (it would set the prototype). */
const PROTO_KEY = '__proto__';

export type ViewRequest =
  | { type: 'impact'; product: string; from: string; to: string; changed: EntryKind[]; attached: EntryKind[]; attached_fields: string[] | null; catalog: string | null; revision: string | null }
  | { type: 'facets'; product: string; build: string; kind: EntryKind; by: string[]; revision: string | null }
  | { type: 'index'; product: string; build: string; kind: EntryKind; key: string; only: string[] | null; fields: string[] | null; revision: string | null };

type Parsed<T> = { ok: true; value: T } | { ok: false; reason: string };

/** The query keys each view takes, and which of them it needs. */
const QUERY = {
  impact: { keys: ['changed', 'attached', 'attached_fields', 'catalog'], required: [] },
  facets: { keys: ['kind', 'by'], required: ['kind', 'by'] },
  index: { keys: ['kind', 'key', 'only', 'fields'], required: ['kind', 'key'] },
} as const satisfies Record<ViewRequest['type'], { keys: readonly string[]; required: readonly string[] }>;

const ID = /^([a-z][a-z0-9-]*):([a-z][a-z0-9_-]*):([^:?@]+):([^?@]+)(?:\?([\s\S]*))?$/;
/** A revision is a root pair (impact) or one root (facets, index): it is cut off first, so a query value may hold a literal @. */
const REVISION = /@([0-9a-f]{64}(?:\.\.[0-9a-f]{64})?)$/;

/** Splits the trailing revision off a view id; the rest may hold literal @ characters (a catalog name does). */
export function splitRevision(id: string): { body: string; revision: string | null } {
  const match = REVISION.exec(id);
  return match === null ? { body: id, revision: null } : { body: id.slice(0, match.index), revision: match[1] };
}

/** A refusal of an impact-view request the caller may read as-is (a root without the catalog, a changed kind outside it). */
export class ImpactRefusal extends Error {}

function decode(text: string): string | null {
  try {
    return decodeURIComponent(text);
  } catch {
    return null;
  }
}

function kindsOf(values: string[], what: string): Parsed<EntryKind[]> {
  const out: EntryKind[] = [];
  for (const value of values) {
    const kind = EntryKindSchema.safeParse(value);
    if (!kind.success) return { ok: false, reason: `${what} 里的 ${cutText(value, 40)} 不是知识条目种类（${ENTRY_KIND.join('、')}）` };
    if (!out.includes(kind.data)) out.push(kind.data);
  }
  return { ok: true, value: out.sort(compareText) };
}

/** Parses a knowledge view id; the reason says what is wrong (for the admin log). */
export function parseViewId(id: string): Parsed<ViewRequest> {
  if (typeof id !== 'string' || id.length > 8192) return { ok: false, reason: '不是外部对象标识' };
  const { body, revision } = splitRevision(id);
  const match = ID.exec(body);
  if (match === null || match[1] !== VIEW_SYSTEM) return { ok: false, reason: `${cutText(id, 120)} 不是知识视图的标识（knowledge:<视图>:<产品>:<构建>[?参数]）` };
  const type = match[2];
  if (!Object.hasOwn(QUERY, type)) return { ok: false, reason: `没有叫 ${cutText(type, 40)} 的知识视图（有 ${Object.keys(QUERY).join('、')}）` };
  const view = type as ViewRequest['type'];
  const malformed = { ok: false as const, reason: '产品或构建的写法不对（百分号转义有误或为空）' };
  const product = decode(match[3]);
  if (product === null || product === '') return malformed;
  // The two builds of an impact view are split at the first literal `..` before decoding, so an escaped `.` stays in a name.
  let build = '';
  let from = '';
  let to = '';
  if (view === 'impact') {
    const at = match[4].indexOf('..');
    if (at >= 0) {
      const [a, b] = [decode(match[4].slice(0, at)), decode(match[4].slice(at + 2))];
      if (a === null || b === null) return malformed;
      [from, to] = [a, b];
    }
  } else {
    const decoded = decode(match[4]);
    if (decoded === null || decoded === '') return malformed;
    build = decoded;
  }
  const query = new Map<string, string[]>();
  if (match[5] !== undefined && match[5] !== '') {
    for (const pair of match[5].split('&')) {
      const eq = pair.indexOf('=');
      const name = eq < 0 ? pair : pair.slice(0, eq);
      if (eq < 0) return { ok: false, reason: `参数 ${cutText(name, 40)} 没有取值` };
      if (!(QUERY[view].keys as readonly string[]).includes(name)) return { ok: false, reason: `视图 ${view} 不认识参数 ${cutText(name, 40)}（认识 ${QUERY[view].keys.join('、')}）` };
      if (query.has(name)) return { ok: false, reason: `参数 ${name} 写了两次` };
      const value = pair.slice(eq + 1);
      const values = value === '' ? [] : value.split(',').map(decode);
      if (values.some((v) => v === null || v === '')) return { ok: false, reason: `参数 ${name} 的取值写法不对（空值或百分号转义有误）` };
      query.set(name, values as string[]);
    }
  }
  for (const name of QUERY[view].required as readonly string[]) if (!query.has(name)) return { ok: false, reason: `视图 ${view} 要有参数 ${name}` };
  const one = (name: string): Parsed<string> => {
    const values = query.get(name) ?? [];
    return values.length === 1 ? { ok: true, value: values[0] } : { ok: false, reason: `参数 ${name} 只能有一个取值` };
  };
  if (view === 'impact') {
    if (from === '' || to === '') return { ok: false, reason: '版本差要写成 <起始构建>..<目标构建>' };
    let catalog: string | null = null;
    if (query.has('catalog')) {
      const value = one('catalog');
      if (!value.ok) return value;
      if (!Versioned.safeParse(value.value).success) return { ok: false, reason: `目录 ${cutText(value.value, 60)} 的写法不对（名字@主版本号，如 commands@1）` };
      catalog = value.value;
    }
    // With a catalog, changed may be omitted (the catalog's kind, decided when the declarations are read) or must equal it.
    const changed = kindsOf(query.get('changed') ?? (catalog === null ? [...DEFAULT_CHANGED_KINDS] : []), 'changed');
    if (!changed.ok) return changed;
    if (changed.value.length === 0 && catalog === null) return { ok: false, reason: 'changed 至少要有一个条目种类' };
    const attached = kindsOf(query.get('attached') ?? [...DEFAULT_ATTACHED_KINDS], 'attached');
    if (!attached.ok) return attached;
    let attached_fields: string[] | null = null;
    if (query.has('attached_fields')) {
      const raw = query.get('attached_fields') ?? [];
      if (raw.length === 0) return { ok: false, reason: 'attached_fields 要列至少一个字段名' };
      for (const field of raw) if (!DataFieldName.safeParse(field).success) return { ok: false, reason: `字段名 ${cutText(field, 40)} 不对（小写字母开头，只有小写字母、数字和下划线）` };
      attached_fields = [...new Set(raw)].sort(compareText);
    }
    return { ok: true, value: { type: 'impact', product, from, to, changed: changed.value, attached: attached.value, attached_fields, catalog, revision } };
  }
  const kindText = one('kind');
  if (!kindText.ok) return kindText;
  const kind = kindsOf([kindText.value], 'kind');
  if (!kind.ok) return kind;
  if (view === 'facets') {
    const by = query.get('by') ?? [];
    if (by.length < 1 || by.length > 6) return { ok: false, reason: 'by 要列 1 到 6 个数据字段' };
    for (const field of by) if (!DataFieldName.safeParse(field).success) return { ok: false, reason: `数据字段名 ${cutText(field, 40)} 不对（小写字母开头，只有小写字母、数字和下划线）` };
    if (new Set(by).size !== by.length) return { ok: false, reason: 'by 里有重复的字段' };
    return { ok: true, value: { type: 'facets', product, build, kind: kind.value[0], by, revision } };
  }
  const key = one('key');
  if (!key.ok) return key;
  if (!DataFieldName.safeParse(key.value).success) return { ok: false, reason: `数据字段名 ${cutText(key.value, 40)} 不对（小写字母开头，只有小写字母、数字和下划线）` };
  let only: string[] | null = null;
  if (query.has('only')) {
    only = [...new Set(query.get('only') ?? [])].sort(compareText);
    if (only.length === 0 || only.length > MAX_ONLY_VALUES) return { ok: false, reason: `only 要列 1 到 ${MAX_ONLY_VALUES} 个取值` };
  }
  let fields: string[] | null = null;
  if (query.has('fields')) {
    const raw = query.get('fields') ?? [];
    if (raw.length === 0) return { ok: false, reason: 'fields 要列至少一个字段名' };
    for (const field of raw) if (!DataFieldName.safeParse(field).success) return { ok: false, reason: `字段名 ${cutText(field, 40)} 不对（小写字母开头，只有小写字母、数字和下划线）` };
    fields = [...new Set(raw)].sort(compareText);
  }
  return { ok: true, value: { type: 'index', product, build, kind: kind.value[0], key: key.value, only, fields, revision } };
}

// ---------------------------------------------------------------- data values

type FacetValue = string | number | boolean | null;

const isScalar = (value: unknown): value is FacetValue =>
  value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));

/** Code-unit order of the canonical JSON text of the values (facet-view@1: rows sorted by the values in code-unit order). */
export function compareValues(a: FacetValue, b: FacetValue): number {
  return compareText(canonicalize(a), canonicalize(b));
}

/**
 * The values of a field a facet counts an entry under: one per distinct element of a list, the value itself otherwise;
 * a missing field, null and an empty list count as null; a value that is not a scalar counts as its canonical JSON text.
 */
function facetValues(data: Record<string, unknown>, field: string, odd: { count: number }): FacetValue[] {
  const value = Object.hasOwn(data, field) ? data[field] : undefined;
  const one = (v: unknown): FacetValue => {
    if (isScalar(v)) return v;
    odd.count++;
    return canonicalize(v);
  };
  if (value === undefined || value === null) return [null];
  if (!Array.isArray(value)) return [one(value)];
  if (value.length === 0) return [null];
  const seen = new Map<string, FacetValue>();
  for (const element of value) {
    const v = one(element);
    seen.set(canonicalize(v), v);
  }
  return [...seen.values()];
}

/** One entry of a kind, once: a placed row keeps its path; an unplaced row is cited at the root (K01 R[4]). */
type KindEntry = { entry: string; path: string; content: EntryContent; unplaced: boolean };

/**
 * Distinct entries of one kind. Placed rows come first, so an entry that is also unplaced keeps the path it hangs on and
 * is counted once. Unplaced entries are cited at `/`, the root.
 */
async function* entriesOfKind(composition: CompositionView, kind: string): AsyncGenerator<KindEntry> {
  const seen = new Set<string>();
  for await (const row of composition.contentRows(new Set([kind]))) {
    if (seen.has(row.entry)) continue;
    seen.add(row.entry);
    yield { entry: row.entry, path: row.path, content: row.content, unplaced: false };
  }
  for await (const row of composition.unplacedContent(kind)) {
    if (seen.has(row.entry)) continue;
    seen.add(row.entry);
    yield { entry: row.entry, path: '/', content: row.content, unplaced: true };
  }
}

/** The keys an index files an entry under: the text of each distinct element of a list or of the value; null and missing give none. */
function indexKeys(data: Record<string, unknown>, field: string): string[] {
  const value = Object.hasOwn(data, field) ? data[field] : undefined;
  const text = (v: unknown): string | null => (v === null || v === undefined ? null : typeof v === 'string' ? v : canonicalize(v));
  const list = Array.isArray(value) ? value : [value];
  return [...new Set(list.map(text).filter((k): k is string => k !== null))];
}

// ---------------------------------------------------------------- the views

interface At {
  build: string;
  root: string;
}

function viewEntry(digest: string, content: EntryContent, root: string, path: string): ViewEntry {
  return { entry: digest, kind: EntryKindSchema.parse(content.kind), statement: content.statement, data: content.data, reference: treeReference(root, path, digest) };
}

/** Exact bytes of one member `"<key>":<value>,` of an object in the canonical answer (the last member has no comma: one byte to spare). */
const memberBytes = (key: string, value: unknown): number => canonicalSize(key) + 1 + canonicalSize(value) + 1;
/** Exact bytes of one element `<value>,` of an array. */
const elementBytes = (value: unknown): number => canonicalSize(value) + 1;

/** The first references of a list for a note, and how many more there are. */
function referencesNote(references: readonly string[]): string {
  const shown = references.slice(0, NOTE_REFERENCES).join('、');
  return references.length > NOTE_REFERENCES ? `${shown} 等 ${references.length} 个` : shown;
}

/** How many listed sources of a root were not used (0 when it has no composition). */
const skippedCount = (composition: CompositionView | null): number => composition?.body.skipped_count ?? 0;

/** The note on a root whose listed sources were not all used, or null. */
function skippedNote(side: At, composition: CompositionView | null): string | null {
  const count = composition?.body.skipped_count ?? 0;
  if (composition === null || count === 0) return null;
  const kept = composition.body.skipped ?? [];
  const producers = [...new Set(kept.map((s) => s.producer))].sort(compareText);
  return `构建 ${side.build} 的根有 ${count} 份列出的来源没有用上（生产器 ${producers.join('、')}${count > kept.length ? ' 等' : ''}），这些来源会给出的条目不在这个根里，是未知，不是没有`;
}

/** The note on entries left out because their own text has credential scan hits. */
const credentialNote = (references: readonly string[]): string =>
  `${references.length} 个条目的文字有凭据扫描命中，没有放进这个视图（${referencesNote(references)}）；它们在树上照常可读（get_nodes）`;

/** Throws when a computed answer does not fit its schema: that is a bug here, never the caller's. */
function conforming<T>(schema: { safeParse(value: unknown): { success: boolean; error?: { issues: Array<{ path: PropertyKey[]; message: string }> } } }, view: T, what: string): T {
  const checked = schema.safeParse(view);
  if (!checked.success) {
    const issue = checked.error?.issues[0];
    throw new Error(`computed ${what} is not valid: ${issue === undefined ? '' : `${issue.path.join('/')} ${issue.message}`}`);
  }
  // The object as built is what is stored (a schema's parsed copy could leave out a member it does not carry).
  return view;
}

export class KnowledgeViews {
  readonly #context: KnowledgeContext;
  readonly #builds: Builds;
  readonly #reading: TreeReading;
  /** Canonical bytes of computed views by request and roots (a root's content never changes). */
  readonly #cache = new Lru<string, Uint8Array>(4);

  constructor(context: KnowledgeContext, builds: Builds, reading: TreeReading) {
    this.#context = context;
    this.#builds = builds;
    this.#reading = reading;
  }

  get #packs(): PacksPort {
    return this.#context.packs;
  }

  get #budget(): number {
    return Math.max(0, this.#context.limits.maxViewBytes - VIEW_MARGIN);
  }

  async #content(row: ReadRow | null, digest: string): Promise<EntryContent | null> {
    return row?.content ?? (await this.#context.store.entry(digest));
  }

  /**
   * The impact view of two roots (K01 R[1]): changed paths of the changed kinds, the attached entries filed there. Paths are
   * kept in path order while they fit the limits, counted exactly; the content of an entry is read only for kept paths.
   * `exclude` names entries left out (their text has credential scan hits): a changed one takes its path out, an attached
   * one only itself. With `catalog` only the catalog's members count as changes, read per root and compared by syntax:
   * a path whose members differ only in the descriptive fields or the overload order is not a change, counted in the notes.
   */
  async impact(product: string, from: At, to: At, changed: readonly EntryKind[], attached: readonly EntryKind[], attachedFields: readonly string[] | null = null, catalog: string | null = null, exclude: ReadonlySet<string> = new Set()): Promise<ImpactView> {
    let membersFrom: ReadonlyMap<string, string> | null = null;
    let membersTo: ReadonlyMap<string, string> | null = null;
    let catalogKind: EntryKind | null = null;
    if (catalog !== null) {
      const [cf, ct] = await Promise.all([this.#reading.catalogMembers(from.root, catalog), this.#reading.catalogMembers(to.root, catalog)]);
      if (cf === null) throw new ImpactRefusal(`构建 ${from.build} 的根没有目录 ${catalog}，算不出目录成员的变化`);
      if (ct === null) throw new ImpactRefusal(`构建 ${to.build} 的根没有目录 ${catalog}，算不出目录成员的变化`);
      const kind = cf.declaration.entry_kind as EntryKind;
      if (ct.declaration.entry_kind !== kind) throw new ImpactRefusal(`两个根里目录 ${catalog} 的成员种类不同（${cf.declaration.entry_kind}、${ct.declaration.entry_kind}），算不出目录成员的变化`);
      if (changed.length > 0 && (changed.length !== 1 || changed[0] !== kind)) {
        throw new ImpactRefusal(`带了目录 ${catalog} 时 changed 只能不写或写 ${kind}（目录的成员种类），写了 ${changed.join('、')}`);
      }
      catalogKind = kind;
      membersFrom = new Map([...cf.members].map(([digest, member]) => [digest, member.canon]));
      membersTo = new Map([...ct.members].map(([digest, member]) => [digest, member.canon]));
    }
    const effectiveChanged: readonly EntryKind[] = catalogKind !== null ? [catalogKind] : changed;
    const changedSet = new Set<string>(effectiveChanged);
    const attachedSet = new Set<string>(attached);
    // With attached_fields, entries of the attached kinds carry only those data fields and an empty statement; the changed
    // entries keep their full data (a diff needs it). The byte accounting uses the slimmed size.
    const slim = (content: EntryContent): EntryContent => {
      if (attachedFields === null || !attachedSet.has(content.kind as EntryKind)) return content;
      const data: Record<string, unknown> = {};
      for (const field of attachedFields) if (Object.hasOwn(content.data, field)) data[field] = content.data[field];
      return { kind: content.kind, statement: '', data, applicability: content.applicability };
    };
    const nodes = (await this.#reading.changedNodes(from.root, to.root)) ?? [];
    const [fromComposition, toComposition] = await Promise.all([this.#reading.compositionOf(from.root), this.#reading.compositionOf(to.root)]);
    const budget = this.#budget;
    interface Item {
      change: PathChange;
      placement: Placement | null;
      /** Every entry the item names. */
      named: string[];
    }
    /** An entry named by a kept path: its content, and the root and path its reference cites. */
    interface Named {
      content: EntryContent;
      root: string;
      path: string;
      bytes: number;
    }
    const kept: Item[] = [];
    const named = new Map<string, Named>();
    const sized = (digest: string, value: Omit<Named, 'bytes'>): Named => {
      const content = slim(value.content);
      return { ...value, content, bytes: memberBytes(digest, viewEntry(digest, content, value.root, value.path)) };
    };
    let bytes = 0;
    let full = false;
    let changedPaths = 0;
    let attachedFrom = 0;
    let attachedTo = 0;
    let syntaxOnly = 0;
    const excludedPaths: string[] = [];
    const excludedEntries = new Map<string, string>();
    for (const node of nodes) {
      const [a, b] = await Promise.all([this.#reading.kindsAt(fromComposition, node.path, node.before), this.#reading.kindsAt(toComposition, node.path, node.after)]);
      const pick = (list: readonly string[], kinds: Map<string, { kind: string }>, set: ReadonlySet<string>): string[] => list.filter((e) => set.has(kinds.get(e)?.kind ?? '')).sort(compareText);
      let before = pick(node.before, a, changedSet);
      let after = pick(node.after, b, changedSet);
      if (before.length === after.length && before.every((e, i) => after[i] === e)) continue;
      if (membersFrom !== null && membersTo !== null) {
        before = before.filter((e) => membersFrom.has(e));
        after = after.filter((e) => membersTo.has(e));
        if (before.length === after.length && before.every((e, i) => after[i] === e)) continue;
        // Members that differ only in the descriptive fields or the overload order are not a change, counted in the notes.
        const canonBefore = before.map((e) => membersFrom.get(e) as string).sort(compareText);
        const canonAfter = after.map((e) => membersTo.get(e) as string).sort(compareText);
        if (canonBefore.length === canonAfter.length && canonBefore.every((canon, i) => canon === canonAfter[i])) {
          syntaxOnly++;
          continue;
        }
      }
      const fromAll = pick(node.before, a, attachedSet);
      const toAll = pick(node.after, b, attachedSet);
      changedPaths++;
      attachedFrom += fromAll.length;
      attachedTo += toAll.length;
      if (full) continue;
      const flaggedChange = [...before, ...after].filter((d) => exclude.has(d));
      if (flaggedChange.length > 0) {
        excludedPaths.push(node.path);
        for (const digest of flaggedChange) excludedEntries.set(digest, treeReference(after.includes(digest) ? to.root : from.root, node.path, digest));
        continue;
      }
      for (const digest of fromAll) if (exclude.has(digest)) excludedEntries.set(digest, treeReference(from.root, node.path, digest));
      for (const digest of toAll) if (exclude.has(digest)) excludedEntries.set(digest, treeReference(to.root, node.path, digest));
      const fromAttached = fromAll.filter((d) => !exclude.has(d));
      const toAttached = toAll.filter((d) => !exclude.has(d));
      const change: PathChange = { path: node.path, change: before.length === 0 ? 'added' : after.length === 0 ? 'removed' : 'modified', before, after };
      const placement: Placement | null = fromAttached.length + toAttached.length > 0 ? { path: node.path, from: fromAttached, to: toAttached } : null;
      // The entries this path adds to the answer; one met before on the earlier side is cited in the later root now.
      const additions = new Map<string, Named>();
      let size = elementBytes(change) + (placement === null ? 0 : elementBytes(placement));
      for (const [digests, list, root] of [
        [[...after, ...toAttached], b, to.root],
        [[...before, ...fromAttached], a, from.root],
      ] as const) {
        for (const digest of digests) {
          const held = named.get(digest) ?? additions.get(digest);
          if (held !== undefined && (held.root === to.root || root === from.root)) continue;
          const content = held?.content ?? (await this.#content(list.get(digest)?.row ?? null, digest));
          if (content === null) continue;
          const next = sized(digest, { content, root, path: node.path });
          size += next.bytes - (held?.bytes ?? 0);
          additions.set(digest, next);
        }
      }
      const fresh = [...additions.keys()].filter((d) => !named.has(d)).length;
      if (kept.length + 1 > MAX_IMPACT_PATHS || named.size + fresh > MAX_IMPACT_ENTRIES || bytes + size > budget) {
        full = true;
        continue;
      }
      for (const [digest, value] of additions) named.set(digest, value);
      kept.push({ change, placement, named: [...new Set([...before, ...after, ...fromAttached, ...toAttached])] });
      bytes += size;
    }
    // An entry named only on the earlier side of the kept paths is cited in the later root when it is there at another path
    // (its first path there); only the rows of those entries' kinds are read, until every one is found.
    const earlierOnly = new Map([...named].filter(([, value]) => value.root === from.root));
    if (earlierOnly.size > 0 && toComposition !== null && from.root !== to.root) {
      const kinds = new Set([...earlierOnly.values()].map((value) => value.content.kind));
      for await (const row of toComposition.rows(kinds)) {
        const value = earlierOnly.get(row.entry);
        if (value === undefined) continue;
        named.set(row.entry, sized(row.entry, { content: value.content, root: to.root, path: row.path }));
        earlierOnly.delete(row.entry);
        if (earlierOnly.size === 0) break;
      }
    }
    const notesOf = async (count: number): Promise<string[]> => {
      const notes: string[] = [];
      if (count < kept.length || full) {
        notes.push(`列表按路径顺序截在第 ${count} 个变化路径（共 ${changedPaths} 个，上限 ${MAX_IMPACT_PATHS} 个路径、${MAX_IMPACT_ENTRIES} 个条目、约 ${this.#context.limits.maxViewBytes} 字节）；totals 计入全部`);
      }
      if (excludedEntries.size > 0) {
        notes.push(credentialNote([...excludedEntries.values()]));
        if (excludedPaths.length > 0) notes.push(`变化路径 ${referencesNote(excludedPaths)} 上变化的条目有凭据扫描命中，这些路径没有列出`);
      }
      if (syntaxOnly > 0) notes.push(`${syntaxOnly} 个路径的目录成员只有说明性内容（参数说明、条目摘要）或签名顺序的差异，不算变更`);
      if (attachedFields !== null) notes.push(`附着的${attached.map((k) => labelOf('entry_kind', k)).join('、')}条目只带字段 ${attachedFields.join('、')}（attached_fields 参数），陈述为空；变更的条目不受影响`);
      if (from.root === to.root) notes.push(`两个构建用的是同一个根 ${to.root}，没有版本差`);
      for (const [side, composition] of [
        [from, fromComposition],
        [to, toComposition],
      ] as const) {
        const counts = composition === null ? new Map<string, number>() : await composition.kindCounts();
        const missingAttached = attached.filter((kind) => (counts.get(kind) ?? 0) === 0);
        if (missingAttached.length > 0) notes.push(`构建 ${side.build} 的根里没有${missingAttached.map((k) => labelOf('entry_kind', k)).join('、')}种类的条目`);
        if (effectiveChanged.every((kind) => (counts.get(kind) ?? 0) === 0)) notes.push(`构建 ${side.build} 的根里没有${effectiveChanged.map((k) => labelOf('entry_kind', k)).join('、')}种类的条目，算不出变化`);
        const skipped = skippedNote(side, composition);
        if (skipped !== null) notes.push(skipped);
      }
      return notes;
    };
    const build = async (count: number): Promise<ImpactView> => {
      const items = kept.slice(0, count);
      const digests = [...new Set(items.flatMap((item) => item.named))].filter((d) => named.has(d)).sort(compareText);
      const entries: Record<string, ViewEntry> = {};
      for (const digest of digests) {
        const value = named.get(digest) as Named;
        entries[digest] = viewEntry(digest, value.content, value.root, value.path);
      }
      return {
        schema: 'impact-view@1',
        product,
        from,
        to,
        changed_kinds: [...effectiveChanged],
        attached_kinds: [...attached],
        ...(attachedFields !== null ? { attached_fields: [...attachedFields] } : {}),
        ...(catalog !== null ? { catalog } : {}),
        changes: items.map((item) => item.change),
        placements: items.flatMap((item) => (item.placement === null ? [] : [item.placement])),
        entries,
        totals: { changed_paths: changedPaths, attached_from: attachedFrom, attached_to: attachedTo },
        truncated: count < changedPaths || excludedEntries.size > 0,
        skipped: { from: skippedCount(fromComposition), to: skippedCount(toComposition) },
        notes: await notesOf(count),
      };
    };
    // Sized exactly above; a later-root citation can lengthen a reference, so the answer is checked once more as a whole.
    let count = kept.length;
    let view = await build(count);
    while (count > 0 && canonicalBytes(view).byteLength > this.#context.limits.maxViewBytes) {
      count = Math.max(0, Math.min(count - 1, Math.floor(count * 0.95)));
      view = await build(count);
    }
    return conforming(ImpactView, view, 'impact-view@1');
  }

  /**
   * Counts of the entries of one kind by the values of data fields (a list field counts the entry once per element),
   * placed rows and the unplaced rows of the root. An entry counts once; one that is also placed keeps the path it hangs
   * on, and `total` includes the unplaced ones. At most `facetCombinations` distinct combinations are collected (later new
   * ones are left out, flagged); rows are kept in value order while they fit MAX_FACET_ROWS and the byte budget, counted
   * exactly. `exclude` names rows left out (by the canonical JSON of their values) because their values have credential
   * scan hits.
   */
  async facets(product: string, at: At, kind: EntryKind, by: readonly string[], exclude: ReadonlySet<string> = new Set()): Promise<FacetView> {
    const composition = await this.#reading.compositionOf(at.root);
    const seen = new Set<string>();
    const counts = new Map<string, { values: FacetValue[]; count: number }>();
    const odd = { count: 0 };
    const limit = Math.max(1, this.#context.limits.facetCombinations);
    let cut = 0;
    let unlisted = 0;
    let unplacedCount = 0;
    if (composition !== null) {
      for await (const row of entriesOfKind(composition, kind)) {
        seen.add(row.entry);
        if (row.unplaced) unplacedCount++;
        const lists = by.map((field) => facetValues(row.content.data, field, odd));
        if (lists.reduce((n, list) => n * list.length, 1) > MAX_FACET_COMBINATIONS) {
          cut++;
          continue;
        }
        let combos: FacetValue[][] = [[]];
        for (const list of lists) combos = combos.flatMap((combo) => list.map((value) => [...combo, value]));
        let left = false;
        for (const combo of combos) {
          const key = canonicalize(combo);
          const held = counts.get(key);
          if (held !== undefined) held.count++;
          else if (counts.size < limit) counts.set(key, { values: combo, count: 1 });
          else left = true;
        }
        if (left) unlisted++;
      }
    }
    const compareRows = (a: FacetValue[], b: FacetValue[]): number => {
      for (let i = 0; i < a.length; i++) {
        const c = compareValues(a[i], b[i]);
        if (c !== 0) return c;
      }
      return 0;
    };
    const all = [...counts.entries()].filter(([key]) => !exclude.has(key)).sort(([, a], [, b]) => compareRows(a.values, b.values));
    const excluded = counts.size - all.length;
    const budget = this.#budget;
    const rows: FacetView['rows'] = [];
    let bytes = 0;
    for (const [, { values, count }] of all) {
      const row = { values: Object.fromEntries(by.map((field, i) => [field, values[i]])), count };
      const size = elementBytes(row);
      if (rows.length + 1 > MAX_FACET_ROWS || bytes + size > budget) break;
      rows.push(row);
      bytes += size;
    }
    const notes: string[] = [];
    if (seen.size === 0) notes.push(`构建 ${at.build} 的根里没有${labelOf('entry_kind', kind)}种类的条目`);
    if (unplacedCount > 0) notes.push(`未归位条目 ${unplacedCount} 个，标在根下，计入合计`);
    if (rows.length < all.length) notes.push(`取值组合有 ${all.length} 种，只列出按取值排序的前 ${rows.length} 种（上限 ${MAX_FACET_ROWS} 行、约 ${this.#context.limits.maxViewBytes} 字节）`);
    if (unlisted > 0) notes.push(`取值组合超过 ${limit} 种以后出现的新组合没有收集：${unlisted} 个条目有组合没有计入任何一行（total 里计入），列出的行是先遇到的组合`);
    if (cut > 0) notes.push(`${cut} 个条目的列表字段组合超过 ${MAX_FACET_COMBINATIONS} 种，没有计入任何一行（total 里计入）`);
    if (odd.count > 0) notes.push(`${odd.count} 个取值不是标量，按其规范 JSON 文本计`);
    if (excluded > 0) notes.push(`${excluded} 种取值组合的文字有凭据扫描命中，没有列出`);
    const skipped = skippedNote(at, composition);
    if (skipped !== null) notes.push(skipped);
    const view: FacetView = {
      schema: 'facet-view@1',
      product,
      build: at,
      kind,
      by: [...by],
      rows,
      total: seen.size,
      truncated: rows.length < all.length || cut > 0 || unlisted > 0 || excluded > 0,
      skipped: skippedCount(composition),
      notes,
    };
    return conforming(FacetView, view, 'facet-view@1');
  }

  /**
   * The entries of one kind by the values of a data field (a list field by each element), placed rows and the unplaced rows
   * of the root; only the listed values when given. An entry is filed once, an unplaced one at the root. Keys are kept in
   * code-unit order while they fit the limits, counted exactly. The content of an entry is held during the scan only while
   * the held entries fit the byte budget; a listed entry not held is read in a second scan. `exclude` names entries left
   * out because their text has credential scan hits.
   */
  async index(product: string, at: At, kind: EntryKind, key: string, only: readonly string[] | null, fields: readonly string[] | null = null, exclude: ReadonlySet<string> = new Set()): Promise<IndexView> {
    // With fields, entries carry only those data fields and an empty statement; the identity (entry digest) and the
    // reference are unchanged. The truncation accounting uses the slimmed size: the fields decide what an entry costs.
    const slim = (content: EntryContent): EntryContent => {
      if (fields === null) return content;
      const data: Record<string, unknown> = {};
      for (const field of fields) if (Object.hasOwn(content.data, field)) data[field] = content.data[field];
      return { kind: content.kind, statement: '', data, applicability: content.applicability };
    };
    const composition = await this.#reading.compositionOf(at.root);
    const onlySet = only === null ? null : new Set(only);
    const budget = this.#budget;
    const seen = new Set<string>();
    const keys = new Map<string, string[]>();
    /** Every carrier: the path it is cited at and the exact bytes of its member in `entries`. */
    const carriers = new Map<string, { path: string; bytes: number }>();
    const held = new Map<string, EntryContent>();
    let heldBytes = 0;
    let ofKind = 0;
    let unplacedCount = 0;
    const excluded = new Map<string, string>();
    if (composition !== null) {
      for await (const row of entriesOfKind(composition, kind)) {
        seen.add(row.entry);
        ofKind++;
        if (row.unplaced) unplacedCount++;
        const values = indexKeys(row.content.data, key).filter((value) => onlySet === null || onlySet.has(value));
        if (values.length === 0) continue;
        const entryBytes = memberBytes(row.entry, viewEntry(row.entry, slim(row.content), at.root, row.path));
        carriers.set(row.entry, { path: row.path, bytes: entryBytes });
        if (exclude.has(row.entry)) excluded.set(row.entry, treeReference(at.root, row.path, row.entry));
        else if (heldBytes + entryBytes <= budget) {
          held.set(row.entry, row.content);
          heldBytes += entryBytes;
        }
        for (const value of values) {
          const list = keys.get(value);
          if (list === undefined) keys.set(value, [row.entry]);
          else list.push(row.entry);
        }
      }
    }
    interface Kept {
      value: string;
      listed: string[];
      /** Entries this key names first. */
      fresh: string[];
      cut: boolean;
    }
    const kept: Kept[] = [];
    const listedAll = new Set<string>();
    let bytes = 0;
    let stoppedAt: string | null = null;
    let proto = 0;
    for (const value of [...keys.keys()].sort(compareText)) {
      if (value === PROTO_KEY) {
        proto = (keys.get(value) as string[]).length;
        continue;
      }
      const all = (keys.get(value) as string[]).filter((d) => !exclude.has(d)).sort(compareText);
      if (all.length === 0) continue;
      const listed = all.slice(0, MAX_INDEX_PER_KEY);
      const fresh = listed.filter((d) => !listedAll.has(d));
      const size = memberBytes(value, listed) + fresh.reduce((sum, d) => sum + (carriers.get(d) as { bytes: number }).bytes, 0);
      if (listedAll.size + fresh.length > MAX_INDEX_ENTRIES || bytes + size > budget) {
        stoppedAt = value;
        break;
      }
      kept.push({ value, listed, fresh, cut: all.length > listed.length });
      for (const digest of fresh) listedAll.add(digest);
      bytes += size;
    }
    // Listed entries whose content was not held during the scan are read in a second one.
    const wanted = new Set([...listedAll].filter((d) => !held.has(d)));
    if (wanted.size > 0 && composition !== null) {
      for await (const row of entriesOfKind(composition, kind)) {
        if (!wanted.has(row.entry)) continue;
        held.set(row.entry, row.content);
        wanted.delete(row.entry);
        if (wanted.size === 0) break;
      }
    }
    const notes = (count: number): string[] => {
      const out: string[] = [];
      if (ofKind === 0) out.push(`构建 ${at.build} 的根里没有${labelOf('entry_kind', kind)}种类的条目`);
      else if (keys.size === 0) out.push(`没有${labelOf('entry_kind', kind)}条目在数据字段 ${key} 上有${only === null ? '取值' : '所列的取值'}`);
      if (only !== null) {
        const absent = only.filter((value) => !keys.has(value));
        if (absent.length > 0 && keys.size > 0) out.push(`这些取值没有条目：${cutText(absent.slice(0, 20).join('、'), 500)}${absent.length > 20 ? ` 等 ${absent.length} 个` : ''}`);
      }
      const perKeyCut = kept.slice(0, count).filter((item) => item.cut).length;
      if (perKeyCut > 0) out.push(`${perKeyCut} 个取值的条目超过 ${MAX_INDEX_PER_KEY} 个，只列出按摘要排序的前 ${MAX_INDEX_PER_KEY} 个`);
      if (fields !== null) out.push(`条目只带字段 ${fields.join('、')}（fields 参数），陈述为空`);
      const stop = count < kept.length ? kept[count].value : stoppedAt;
      if (stop !== null) out.push(`取值按顺序列到 ${cutText(stop, 80)} 之前为止（上限 ${MAX_INDEX_ENTRIES} 个条目、约 ${this.#context.limits.maxViewBytes} 字节）`);
      if (unplacedCount > 0) out.push(`未归位条目 ${unplacedCount} 个，标在根下`);
      if (proto > 0) out.push(`取值 ${PROTO_KEY} 不能作为这个视图的键（读成 JSON 对象时会被当作原型），带它的 ${proto} 个条目没有按它列出`);
      if (excluded.size > 0) out.push(credentialNote([...excluded.values()]));
      const skipped = skippedNote(at, composition);
      if (skipped !== null) out.push(skipped);
      return out;
    };
    const build = (count: number): IndexView => {
      const items = kept.slice(0, count);
      const entries: Record<string, ViewEntry> = {};
      for (const digest of items.flatMap((item) => item.fresh).sort(compareText)) {
        entries[digest] = viewEntry(digest, slim(held.get(digest) as EntryContent), at.root, (carriers.get(digest) as { path: string }).path);
      }
      return {
        schema: 'index-view@1',
        product,
        build: at,
        kind,
        key,
        ...(fields !== null ? { fields: [...fields] } : {}),
        // Built from pairs: a key is always an own member, never an assignment to a prototype.
        keys: Object.fromEntries(items.map((item) => [item.value, item.listed])),
        entries,
        ...(only !== null ? { only: [...new Set(only)].sort(compareText) } : {}),
        cut_keys: items.filter((item) => item.cut).map((item) => item.value),
        total_keys: keys.size,
        total_entries: carriers.size,
        truncated: count < kept.length || items.some((item) => item.cut) || stoppedAt !== null || proto > 0 || excluded.size > 0,
        skipped: skippedCount(composition),
        notes: notes(count),
      };
    };
    let count = kept.length;
    let view = build(count);
    while (count > 0 && canonicalBytes(view).byteLength > this.#context.limits.maxViewBytes) {
      count = Math.max(0, Math.min(count - 1, Math.floor(count * 0.95)));
      view = build(count);
    }
    return conforming(IndexView, view, 'index-view@1');
  }

  /** ExternalReaderPort.read for a knowledge view id: never throws, ok:false with the real reason for the admin log. */
  async read(id: string, context: ExternalReadContext): Promise<ExternalRead> {
    const startedAt = this.#context.now().toISOString();
    try {
      return await this.#read(id, context, startedAt);
    } catch (error) {
      if (error instanceof ImpactRefusal) return { ok: false, id: splitRevision(id).body, reason: error.message };
      return { ok: false, id, reason: `知识视图出错：${describeError(error)}` };
    }
  }

  async #read(id: string, context: ExternalReadContext, startedAt: string): Promise<ExternalRead> {
    const parsed = parseViewId(id);
    const bare = splitRevision(id).body;
    if (!parsed.ok) return { ok: false, id: bare, reason: parsed.reason };
    const request = parsed.value;
    const handle = (await this.#packs.productById(request.product)) ?? (await this.#packs.productByName(request.product));
    if (handle === null) return { ok: false, id: bare, reason: `没有产品 ${cutText(request.product, 80)}` };
    const product = handle.product.id;
    const principal = context.principal;
    if (!(await this.#reading.mayReadProducts(principal, [product]))) return { ok: false, id: bare, reason: `账号 ${principal?.id ?? '（无）'} 不能读产品 ${product} 的知识` };
    const resolve = async (name: string): Promise<At | string> => {
      const named = await this.#builds.named(product, name);
      if (named === null) return `产品 ${product} 没有构建 ${cutText(name, 80)}`;
      const root = await this.#builds.rootOfBuild(product, name);
      if (root === null) return `构建 ${named.name} 还没有知识树的根`;
      return { build: named.name, root: root.root };
    };
    let roots: string[];
    let key: string;
    let compute: (exclude: ReadonlySet<string>) => Promise<ImpactView | FacetView | IndexView>;
    let title: string;
    if (request.type === 'impact') {
      const from = await resolve(request.from);
      if (typeof from === 'string') return { ok: false, id: bare, reason: from };
      const to = await resolve(request.to);
      if (typeof to === 'string') return { ok: false, id: bare, reason: to };
      roots = [from.root, to.root];
      key = canonicalize({ type: request.type, product, from, to, changed: request.changed, attached: request.attached, attached_fields: request.attached_fields, catalog: request.catalog });
      compute = (exclude) => this.impact(product, from, to, request.changed, request.attached, request.attached_fields, request.catalog, exclude);
      title = `版本差 ${from.build} → ${to.build}（${product}）`;
    } else {
      const at = await resolve(request.build);
      if (typeof at === 'string') return { ok: false, id: bare, reason: at };
      roots = [at.root];
      if (request.type === 'facets') {
        key = canonicalize({ type: request.type, product, at, kind: request.kind, by: request.by });
        compute = (exclude) => this.facets(product, at, request.kind, request.by, exclude);
        title = `${labelOf('entry_kind', request.kind)}按 ${request.by.join('、')} 计数（${at.build}）`;
      } else {
        key = canonicalize({ type: request.type, product, at, kind: request.kind, key: request.key, only: request.only, fields: request.fields });
        compute = (exclude) => this.index(product, at, request.kind, request.key, request.only, request.fields, exclude);
        title = `${labelOf('entry_kind', request.kind)}按 ${request.key} 索引（${at.build}）`;
      }
    }
    const revision = roots.join('..');
    if (request.revision !== null && request.revision !== revision) return { ok: false, id: bare, reason: `要求修订 ${cutText(request.revision, 140)}，现在是 ${revision}` };
    const compositions = await Promise.all([...new Set(roots)].map(root => this.#reading.compositionOf(root)));
    const inputs = [...new Set(roots)].map((root) => `tree:${root}/`);
    const derivedSources = new Set<string>();
    for (const composition of compositions) {
      if (composition === null) continue;
      // Pin the actual composition, not any other production with the same root content.
      inputs.push(`rec:${composition.record}`);
      for (const source of await composition.sources()) {
        // Records selects only current accepted coverage; the product reader need not be
        // allowed to read the raw source itself, and no source text crosses this boundary.
        derivedSources.add(source.sha256);
      }
    }
    const origin = {generated:{generator:COMPONENTS.views,inputs}};
    const coverage = await this.#context.records.artifacts.prepareDerived({origin,author:{user:null},derivedSources:[...derivedSources]});
    const visibility = { readers: [principal.id], admins: true, packs: [], shareable: false };
    const ingest = (bytes: Uint8Array): Promise<SourceArtifact> =>
      this.#context.records.artifacts.ingest({
        bytes,
        mediaType: 'application/json',
        origin,
        derivedCoverage:coverage,
        author: { user: null },
        provenanceType: 'projected',
        visibility,
        name: `${request.type}-view.json`,
      });
    const tooLarge = (bytes: Uint8Array): string | null => (bytes.byteLength > this.#context.limits.maxViewBytes ? `视图有 ${bytes.byteLength} 字节，超过 ${this.#context.limits.maxViewBytes} 字节` : null);
    let originalBytes = this.#cache.get(key);
    let view: ImpactView | FacetView | IndexView;
    if (originalBytes === undefined) {
      view = await compute(new Set());
      originalBytes = canonicalBytes(view);
      const large = tooLarge(originalBytes);
      if (large !== null) return {ok:false,id:bare,reason:large};
      // Cache the unfiltered answer only. Every use rechecks source acceptance and omissions.
      this.#cache.set(key,originalBytes);
    } else view = JSON.parse(Buffer.from(originalBytes).toString('utf8')) as ImpactView | FacetView | IndexView;
    const flagged = flaggedParts(view,coverage);
    if (flagged.excluded.size > 0) view = await compute(flagged.excluded);
    const annotate = (value: ImpactView | FacetView | IndexView, covered: number, limited: number, fallback = 0): void => {
      const unit = value.schema === 'facet-view@1' ? '计数行' : '条目';
      if (covered > 0) value.notes.push(`有 ${covered} 个${unit}的凭据命中由来源的受理覆盖；每次读取重新核对受理仍有效`);
      if (limited > 0) value.notes.push(`有 ${limited} 个${unit}因整份扫描的命中上限没有留下；截断扫描不能被覆盖`);
      if (fallback > 0) value.notes.push(`有 ${fallback} 个${unit}原已由来源的受理覆盖，因整份入库扫描仍被截断，在回退时剔掉`);
    };
    const finalKeys = partKeys(view);
    const covered = [...flagged.kept].filter(key => finalKeys.has(key)).length;
    annotate(view,covered,flagged.limited.size);
    let bytes = canonicalBytes(view);
    let large = tooLarge(bytes);
    if (large !== null) return {ok:false,id:bare,reason:large};
    let artifact = await ingest(bytes);
    // Keys or other surrounding content can add hits beyond the per-part budget.
    // Fall back once to the previous safe omission behavior, never scan every prefix.
    if (artifact.body.scan.truncated && flagged.eligible.size > 0) {
      view = await compute(flagged.allHits);
      annotate(view,0,flagged.limited.size,covered);
      bytes = canonicalBytes(view);
      large = tooLarge(bytes);
      if (large !== null) return {ok:false,id:bare,reason:large};
      artifact = await ingest(bytes);
    }
    if (artifact.body.read_tier !== 'model_readable') {
      return { ok: false, id: bare, reason: `视图 ${artifact.body.sha256} 的凭据扫描有命中（读取档位“${labelOf('read_tier', artifact.body.read_tier)}”），不交给任务包` };
    }
    const meta = await this.#context.records.artifacts.ingest({
      bytes: canonicalBytes({ title, view: request.type, product, roots, revision }),
      mediaType: 'application/json',
      origin,
      derivedCoverage:coverage,
      author: { user: null },
      provenanceType: 'projected',
      visibility,
      name: `${request.type}-view-meta.json`,
    });
    const run = RunId.safeParse(context.run).success ? (context.run as string) : null;
    const body: ActionBody = {
      action: ACTION.generate,
      run,
      item: null,
      inputs,
      component: COMPONENTS.views,
      lease: null,
      started_at: startedAt,
      ended_at: this.#context.now().toISOString(),
      result: 'completed',
      error_code: null,
      acceptance: null,
      codes: [],
      detail: {
        external: bare,
        view: request.type,
        product,
        roots,
        revision,
        artifact: artifact.digest,
        sha256: artifact.body.sha256,
        size: artifact.body.size,
        reader: principal.id,
        purpose: cutText(typeof context.purpose === 'string' ? context.purpose : '', 200),
      },
    };
    const manifest = await this.#context.store.putAction(body, []);
    return {
      ok: true,
      id: bare,
      revision,
      artifacts: [
        { name: 'original', artifact },
        { name: 'meta', artifact: meta },
      ],
      manifest: manifest.digest,
    };
  }
}

/**
 * The parts of an answer whose own text has credential scan hits: entries by digest (impact and index), rows by the
 * canonical JSON of their values (facets).
 */
function partKeys(view: ImpactView | FacetView | IndexView): Set<string> {
  return new Set(view.schema === 'facet-view@1' ? view.rows.map(row => canonicalize(view.by.map(field => row.values[field] ?? null))) : Object.keys(view.entries));
}

function flaggedParts(view: ImpactView | FacetView | IndexView, coverage: DerivedCoverage): {excluded:Set<string>;limited:Set<string>;eligible:Set<string>;kept:Set<string>;allHits:Set<string>} {
  const excluded = new Set<string>(), limited = new Set<string>(), eligible = new Set<string>(), kept = new Set<string>(), allHits = new Set<string>();
  const parts: Array<[string,unknown]> = view.schema === 'facet-view@1'
    ? view.rows.map(row => [canonicalize(view.by.map(field => row.values[field] ?? null)),row])
    : Object.entries(view.entries);
  parts.sort(([a],[b]) => compareText(a,b));
  const skeleton = view.schema === 'facet-view@1' ? {...view,rows:[]} : view.schema === 'index-view@1' ? {...view,entries:{},keys:{}} : {...view,entries:{}};
  const overhead = coverage.assess(canonicalBytes(skeleton));
  let findings = overhead.scan.findings.length, full = overhead.scan.truncated;
  // An index key can itself contain a hit. Assess it once and charge it only the
  // first time a retained entry uses it, including when fields omits the key data.
  const keys = new Map<string,ReturnType<DerivedCoverage['assess']>>();
  const memberships = new Map<string,string[]>();
  if (view.schema === 'index-view@1') for (const [key,entries] of Object.entries(view.keys)) {
    keys.set(key,coverage.assess(canonicalBytes(key)));
    for (const entry of entries) { const list=memberships.get(entry) ?? []; list.push(key); memberships.set(entry,list); }
  }
  const charged = new Set<string>();
  for (const [key,value] of parts) {
    const assessment = coverage.assess(canonicalBytes(value));
    const associated = memberships.get(key) ?? [];
    const hitKeys = associated.filter(k => keys.get(k)!.scan.findings.length > 0);
    if (!assessment.scan.findings.length && !hitKeys.length) continue;
    allHits.add(key);
    if (assessment.scan.findings.length > 0 && !assessment.derived || hitKeys.some(k => !keys.get(k)!.derived)) { excluded.add(key); continue; }
    eligible.add(key);
    const cost = assessment.scan.findings.length + hitKeys.filter(k => !charged.has(k)).reduce((n,k) => n+keys.get(k)!.scan.findings.length,0);
    if (full || findings + cost > CREDENTIAL_FINDING_LIMIT) { full=true; excluded.add(key); limited.add(key); continue; }
    findings += cost;
    for (const k of associated) charged.add(k);
    kept.add(key);
  }
  return {excluded,limited,eligible,kept,allHits};
}

/** The ExternalReaderPort of the knowledge views (`knowledge:impact|facets|index:...`). */
export function viewReader(views: KnowledgeViews): ExternalReaderPort {
  return {
    // Any id of a known view type: a malformed one is then refused by read() with its reason in the admin log.
    accepts: async (id: string) => {
      if (typeof id !== 'string') return false;
      const [system, type] = id.split(':', 3);
      return system === VIEW_SYSTEM && type !== undefined && Object.hasOwn(QUERY, type) && id.length > system.length + type.length + 2;
    },
    read: (id: string, context: ExternalReadContext) => views.read(id, context),
  };
}

/**
 * One ExternalReaderPort over two: ids of the system `knowledge` go to the knowledge views, every other id to `other`
 * (the connectors). For the run engine; the knowledge service's own reads must use the connectors alone.
 */
export function routeKnowledgeViews(views: ExternalReaderPort, other: ExternalReaderPort): ExternalReaderPort {
  const ours = (id: string): boolean => typeof id === 'string' && id.startsWith(`${VIEW_SYSTEM}:`);
  return {
    accepts: (id: string) => (ours(id) ? views.accepts(id) : other.accepts(id)),
    read: (id: string, context: ExternalReadContext) => (ours(id) ? views.read(id, context) : other.read(id, context)),
  };
}
