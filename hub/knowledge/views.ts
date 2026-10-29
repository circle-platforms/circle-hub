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
import { RunId, Sha256, Versioned } from '../../contracts/src/common.ts';
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
  type UnversionedView,
} from '../../contracts/src/views.ts';
import type { ExternalRead, ExternalReadContext, ExternalReaderPort, PacksPort, ReadRoot, ReadRootQuery } from '../ports.ts';
import { readRootNote } from './root-note.ts';
import {KnowledgeError} from './errors.ts';
import {seedlingOfRoot} from './seedling.ts';
import type { FeedingCut } from './feeding-types.ts';

/** The feeding-layer context a view read carries: the run's frozen cut (null offset: everything now in the layer). */
type FeedingNotes = { context: ExternalReadContext | undefined; cut: FeedingCut | null; identity: string | null };
import { sha256Hex, canonicalBytes, canonicalByteLength, createCanonicalEncoder, canonicalize, MAX_ADMIN_FINDINGS, type DerivedCoverage, type ActionBody, type SourceArtifact } from '../records/api.ts';
import { pathSegments, srcFragment, treeReference } from '../refs/api.ts';
import { LinksView } from '../../contracts/src/views.ts';
import { LinkReading,RelationReadError,LinkRefusal } from './links.ts';
import { CompositionView } from './composition.ts';
import type { Builds } from './builds.ts';
import type { ReadRow } from './composition.ts';
import type { KnowledgeContext } from './context.ts';
import { canonicalSize, compareText, cutText, type EntryContent } from './digest.ts';
import {requestKnowledgeFact} from './requests.ts';
import {documentScope} from './scope.ts';
import type {KnowledgeViewScope,ScopedDocument} from '../../contracts/src/views.ts';
import {keepProblemRows} from './problem-journal.ts';
import { describeError } from './errors.ts';
import type { TreeReading } from './read.ts';
import { withReadCache } from './read-cache.ts';
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
  | { type: 'impact'; after?: string | null; product: string; from: string; to: string; changed: EntryKind[]; attached: EntryKind[]; attached_fields: string[] | null; catalog: string | null; revision: string | null }
  | { type: 'facets'; after?: string | null; product: string; build: string; kind: EntryKind; by: string[]; revision: string | null }
  | { type: 'links'; product: string; build: string; prefix: string; target: string | null; rule: string | null; composition: string | null; cursor: string | null; limit: number; revision: string | null }
  | { type: 'index'; after?: string | null; product: string; build: string; kind: EntryKind; key: string; only: string[] | null; fields: string[] | null; revision: string | null };

type Parsed<T> = { ok: true; value: T } | { ok: false; reason: string };

/** The query keys each view takes, and which of them it needs. */
const QUERY = {
  impact: { keys: ['after', 'changed', 'attached', 'attached_fields', 'catalog'], required: [] },
  facets: { keys: ['after', 'kind', 'by'], required: ['kind', 'by'] },
  links: {keys:['prefix','target','rule','composition','cursor','limit'],required:[]},
  index: { keys: ['after', 'kind', 'key', 'only', 'fields'], required: ['kind', 'key'] },
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
class BuildNameRefusal extends ImpactRefusal {
  readonly fix='使用候选的完整原样构建名重新读取';
}

interface PageCursor { offset: number; next(offset: number): string }
function pageState(after: string | null, identity: unknown): PageCursor {
  const q=sha256Hex(canonicalize(identity));
  let offset=0;
  if(after!==null){
    try{const cursor=JSON.parse(Buffer.from(after,'base64url').toString('utf8'));if(cursor.q!==q||!Number.isSafeInteger(cursor.at)||cursor.at<1)throw new Error();offset=cursor.at;}
    catch{throw new ImpactRefusal('续读游标不属于当前查询或组成，或格式已损坏；请从不带 after 的首页重新读取');}
  }
  return {offset,next:at=>Buffer.from(JSON.stringify({q,at})).toString('base64url')};
}
function continuationId(id:string,cursor:string,revision:string):string{
 const {body}=splitRevision(id),at=body.indexOf('?');
 const base=at<0?body:body.slice(0,at),query=at<0?[]:body.slice(at+1).split('&').filter(pair=>!pair.startsWith('after='));
 query.push(`after=${encodeURIComponent(cursor)}`);return `${base}?${query.join('&')}@${revision}`;
}

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
  let after: string | null = null;
  if(query.has('after')){const got=one('after');if(!got.ok)return got;after=got.value;}
  if(view==='links'){
    const values:Record<string,string|null>={prefix:'/',target:null,rule:null,composition:null,cursor:null,limit:'100'};
    for(const name of Object.keys(values))if(query.has(name)){const got=one(name);if(!got.ok)return got;values[name]=got.value;}
    try{pathSegments(values.prefix!);if(values.target!==null)pathSegments(values.target);}catch{return {ok:false,reason:'链接视图的前缀或目标不是规范路径'};}
    if(values.composition!==null&&!Sha256.safeParse(values.composition).success)return {ok:false,reason:'组成摘要写法不对'};
    const limit=Number(values.limit);if(!Number.isInteger(limit)||limit<1||limit>200)return {ok:false,reason:'每页要取 1 到 200 项'};
    if(revision!==null&&!Sha256.safeParse(revision).success)return {ok:false,reason:'链接视图修订是一份组成摘要'};
    return {ok:true,value:{type:'links',product,build,prefix:values.prefix!,target:values.target,rule:values.rule,composition:values.composition,cursor:values.cursor,limit,revision}};
  }
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
    return { ok: true, value: { type: 'impact', after, product, from, to, changed: changed.value, attached: attached.value, attached_fields, catalog, revision } };
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
    return { ok: true, value: { type: 'facets', after, product, build, kind: kind.value[0], by, revision } };
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
  return { ok: true, value: { type: 'index', after, product, build, kind: kind.value[0], key: key.value, only, fields, revision } };
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
type KindEntry = { entry: string; path: string; content: EntryContent; unplaced: boolean; root?:string; unversioned?:boolean; reference?:string|null };
type ScopeRoot = {root:string;composition:string};

/**
 * Distinct entries of one kind. Placed rows come first, so an entry that is also unplaced keeps the path it hangs on and
 * is counted once. Unplaced entries are cited at `/`, the root.
 */
async function* entriesOfKind(composition: CompositionView, kind: string): AsyncGenerator<KindEntry> {
  const seen = new Set<string>();
  for await (const row of composition.contentRows(new Set([kind]))) {
    if (seen.has(row.entry)) continue;
    const entry = detachedText(row.entry);
    seen.add(entry);
    yield { entry, path: detachedText(row.path), content: row.content, unplaced: false };
  }
  for await (const row of composition.unplacedContent(kind)) {
    if (seen.has(row.entry)) continue;
    const entry = detachedText(row.entry);
    seen.add(entry);
    yield { entry, path: '/', content: row.content, unplaced: true };
  }
}

async function* scopedEntries(main: CompositionView | null, scope: CompositionView | null, kind: string): AsyncGenerator<KindEntry> {
  const seen = new Set<string>();
  for (const composition of [main, scope]) {
    if (composition === null) continue;
    for await (const row of entriesOfKind(composition, kind)) {
      if (seen.has(row.entry)) continue;
      seen.add(row.entry);
      yield {...row,root:composition.body.root,unversioned:composition===scope};
    }
  }
}

// JSON.parse may represent a short member as a slice of its large input. Retained index metadata
// must own its bytes, so a digest/path/key cannot keep an otherwise streamed composition part alive.
const detachedText = (text: string): string => Buffer.from(text, 'utf8').toString('utf8');

/** The keys an index files an entry under: the text of each distinct element of a list or of the value; null and missing give none. */
function indexKeys(data: Record<string, unknown>, field: string): string[] {
  const value = Object.hasOwn(data, field) ? data[field] : undefined;
  const text = (v: unknown): string | null => (v === null || v === undefined ? null : typeof v === 'string' ? v : canonicalize(v));
  const list = Array.isArray(value) ? value : [value];
  return [...new Set(list.map(text).filter((k): k is string => k !== null))];
}

// ---------------------------------------------------------------- the views

interface IndexEncoding {
  fields: Array<{ key: string; bytes: Uint8Array | null }>;
  entries: Array<{ digest: string; key: string; bytes: Uint8Array }>;
  length: number;
}

interface At {
  composition?: string;
  build: string;
  root: string;
  /** The resolved root is the line's seedling, so fed-case rows of this root join the case counts. */
  seedling?: boolean;
  /** Set when this seedling and the sync root are different digests. */
  seedlingNote?: string;
}

type ReadRootFn = (product: string, query: ReadRootQuery) => Promise<ReadRoot | null>;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** A view's feeding cut is separate from the tree digest and depends on the current reader's readable records. */
function feedingIdentity(cut:FeedingCut,reader:string):string {
  const objects=[...cut.objects.entries()].map(([id,body])=>cut.casesByRoot===undefined?[id,body]:[id,body.schema]).sort((a,b)=>compareText(String(a[0]),String(b[0])));
  const cases=[...cut.casesByRoot?.entries()??[]].flatMap(([root,byObject])=>[...byObject.entries()].flatMap(([id,bySource])=>[...bySource.entries()].map(([source,value])=>canonicalize([root,id,source,value.record,value.position])))).sort(compareText);
  const bindings=[...cut.bindings.entries()].map(([id,values])=>[id,values.map(value=>canonicalize({state:value.state,line:value.line,candidates:value.candidates})).sort(compareText)]).sort((a,b)=>compareText(String(a[0]),String(b[0])));
  return sha256Hex(canonicalize({reader,offset:cut.offset,objects,cases,bindings,retracted:[...cut.retracted].sort(compareText),contradicted:[...cut.contradicted].sort(compareText)}));
}

function rootlessCases(cut:FeedingCut,root:string,key?:string,only?:ReadonlySet<string>|null):number {
  const rooted=cut.casesByRoot?.get(root),unrooted=cut.casesByRoot?.get(null);
  if(cut.casesByRoot){
    let missing=0;
    for(const [id,sources] of unrooted??[]){
      const rootSources=rooted?.get(id);
      for(const [sourceKey,projection] of sources){
        if(rootSources?.has(sourceKey))continue;
        const source=record(projection.body.source);
        if(key==='document'&&only&&typeof source?.document==='string'&&!only.has(source.document))continue;
        missing++;break;
      }
    }
    return missing;
  }
  let missing=0;
  for(const object of cut.objects.values()){
    if(object.schema!=='fed-case@1'||object.root!==null)continue;
    const source=record(object.source);
    if(key==='document'&&only&&typeof source?.document==='string'&&!only.has(source.document))continue;
    missing++;
  }
  return missing;
}

/** Facets count content once; indexes preserve the separately citable sources of that content. */
function fedCaseRows(root: string, cut: FeedingCut, sourceEntries=false): KindEntry[] {
  const rows: KindEntry[] = [];
  const cases=cut.casesByRoot?.get(root);
  const objects=cut.casesByRoot===undefined?[...cut.objects.values()].map(body=>({body,record:null,position:0})):[...cases?.values()??[]].flatMap(sources=>{const values=[...sources.values()].sort((a,b)=>a.position-b.position);return sourceEntries?values:values.slice(-1);});
  for (const {body:object,record:recordDigest} of objects) {
    if (object.schema !== 'fed-case@1' || object.root !== root) continue;
    const declaration = record(object.resource_declaration);
    const declared = declaration?.status === 'declared';
    const types = Array.isArray(declaration?.types) ? declaration.types : [];
    const expects = Array.isArray(object.expects) ? object.expects : [];
    const lines = Array.isArray(object.document_lines) ? object.document_lines.filter((line): line is string => typeof line === 'string') : [];
    const steps = Array.isArray(object.steps) ? object.steps : [];
    const first = steps.map(record).find((step) => step !== null && typeof step.text === 'string');
    const source=record(object.source),identities=Array.isArray(object.commands)?object.commands.map(record).filter((value):value is Record<string,unknown>=>value!==null):[];
    const paths=[...new Set(identities.flatMap(value=>typeof value.path==='string'?[value.path]:[]))].sort(compareText);
    const treeRoots=[...new Set(identities.flatMap(value=>typeof value.tree_root==='string'?[value.tree_root]:[]))];
    let rawResource:unknown;
    if(typeof declaration?.raw_json==='string')try{rawResource=JSON.parse(declaration.raw_json);}catch{/* The stored declaration stays unknown. */}
    const tags=Array.isArray(rawResource)?rawResource.filter((value):value is string=>typeof value==='string'):[];
    const resourceEmpty=declaration?.present===false?true:Array.isArray(rawResource)?rawResource.length===0:rawResource!==undefined?false:null;
    const caseLocation=typeof source?.bytes==='string'&&typeof object.node_parser==='string'&&typeof object.node_selector==='string'?srcFragment(source.bytes,object.node_parser,object.node_selector):null;
    rows.push({
      entry: sourceEntries&&recordDigest!==null?recordDigest:object.object,
      path: typeof object.path === 'string' ? object.path : '/',
      unplaced: object.path === null,
      root,
      unversioned: false,
      reference: recordDigest===null?null:`rec:${recordDigest}`,
      content: {
        kind: 'case',
        statement: first && typeof first.text === 'string' ? first.text : '',
        data: {
          line: lines.length===1?lines[0]:null,
          ...(lines.length>1?{line_candidates:lines}:{}),
          module: typeof object.module==='string'?object.module:null,
          has_expected: typeof object.has_expected==='boolean'?object.has_expected:expects.length===0?false:null,
          test_type_status: declared ? 'declared' : 'undeclared',
          negative: declared ? types.includes('negative') : null,
          object: object.object,
          ...(typeof source?.document==='string'?{document:source.document}:{}),
          ...(typeof object.node_key==='string'?{node:object.node_key}:{}),
          ...(typeof object.title==='string'?{title:object.title}:{}),
          ...(Array.isArray(object.path_labels)?{path_labels:object.path_labels}:{}),
          ...(Array.isArray(object.stories)?{stories:object.stories}:{}),
          ...(Array.isArray(object.defects)?{defects:object.defects}:{}),
          ...(caseLocation?{case_location:caseLocation}:{}),
          ...(typeof source?.bytes==='string'?{source_sha256:source.bytes}:{}),
          ...(object.unparsed_steps===0?{commands:paths,command_identities:identities}:{}),
          command_tree_root: typeof object.command_tree_root==='string'?object.command_tree_root:treeRoots.length===1?treeRoots[0]:null,
          ...(typeof object.unparsed_steps==='number'?{unparsed_steps:object.unparsed_steps}:{}),
          ...(declaration?{...(rawResource!==undefined?{tags}:{}),resource_empty:resourceEmpty,tag_valid:Array.isArray(declaration.violations)?declaration.violations.length===0:null}:{}),
        },
        applicability: null,
      },
    });
  }
  return rows;
}

function viewEntry(digest: string, content: EntryContent, root: string, path: string, unversioned = false, reference?: string): ViewEntry {
  return { ...(unversioned ? {root,build:null} : {}), entry: digest, kind: EntryKindSchema.parse(content.kind), statement: content.statement, data: content.data, reference: reference??treeReference(root, path, digest) };
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
  readonly #relations: LinkReading;
  readonly #readRoot: ReadRootFn | null;
  /** Canonical bytes of computed views by request and roots (a root's content never changes). */
  readonly #cache = new Lru<string, Uint8Array | { view: IndexView; entries: Map<string, Uint8Array> ;}>(4,Number.POSITIVE_INFINITY,true);
  /** Encodings belong to these immutable projected entries only; never cache credential decisions. */
  readonly #entryBytes = new WeakMap<ViewEntry, Uint8Array>();
  readonly #encodedIndexes = new WeakMap<IndexView, Map<string, Uint8Array>>();
  readonly #completeIndexes = new WeakMap<IndexView, { bytes: Uint8Array; notes: number ;}>();

  #encoding(view: IndexView): IndexEncoding | null {
    const entries = []; let entryLength = 2;
    const encoded = this.#encodedIndexes.get(view);
    for (const digest of [...(encoded?.keys() ?? Object.keys(view.entries))].sort()) {
      const bytes = encoded?.get(digest) ?? this.#entryBytes.get(view.entries[digest]);
      if(bytes===undefined){if(encoded)throw new Error('索引投影条目缺失，不能输出不完整的答复');return null;}
      const key = JSON.stringify(digest) + ':'; entries.push({ key, bytes, digest }); entryLength += Buffer.byteLength(key) + bytes.length;
    }
    entryLength += Math.max(0, entries.length - 1);
    const fields = []; let length = 2;
    for (const name of Object.keys(view).sort()) {
      const value = (view as unknown as Record<string, unknown>)[name]; if (value === undefined) continue;
      const key = JSON.stringify(name) + ':', bytes = name === 'entries' ? null : canonicalBytes(value);
      fields.push({ key, bytes }); length += Buffer.byteLength(key) + (bytes === null ? entryLength : bytes.length);
    }
    length += Math.max(0, fields.length - 1); return { fields, entries, length };
  }

  #length(view: IndexView): number { return this.#encoding(view)?.length ?? canonicalByteLength(view); }

  #bytes(view: ImpactView | FacetView | IndexView): Uint8Array {
    const complete = view.schema === 'index-view@1' ? this.#completeIndexes.get(view) : undefined;
    if (complete && complete.notes === view.notes.length) return complete.bytes;
    const encoding = view.schema === 'index-view@1' ? this.#encoding(view) : null;
    if (encoding === null) return canonicalBytes(view);
    const out = Buffer.allocUnsafe(encoding.length); let offset = 0;
    const packed=new Map<string,Uint8Array>();
    const text = (value: string) => { offset += out.write(value, offset, 'utf8'); };
    const bytes = (value: Uint8Array) => { out.set(value, offset); offset += value.length; };
    text('{');
    encoding.fields.forEach((field, i) => {
      if (i) text(','); text(field.key);
      if (field.bytes !== null) { bytes(field.bytes); return; }
      text('{'); encoding.entries.forEach((entry, j) => { if (j) text(','); text(entry.key);packed.set(entry.digest,out.subarray(offset,offset+entry.bytes.length)); bytes(entry.bytes); }); text('}');
    });
    text('}');
    if(view.schema==='index-view@1'){this.#encodedIndexes.set(view,packed);this.#completeIndexes.set(view,{bytes:out,notes:view.notes.length});}
    return out;
  }

  constructor(context: KnowledgeContext, builds: Builds, reading: TreeReading, relations:LinkReading=new LinkReading(context,builds), readRoot?: ReadRootFn) {
    this.#context = context;
    this.#builds = builds;
    this.#reading = reading;
    this.#relations = relations;
    this.#readRoot = readRoot ?? null;
  }

  /**
   * Notes of the feeding layer for a view over a product (the kb-feeding task): the layer beside seedlings is read at
   * the run's frozen offset (or everything, when no run context froze one). Undeclared-version and contradicted objects
   * are counted apart and never enter version differences; a fed kind the roots hold nothing of falls back to the
   * layer, and when the layer holds nothing either, the view says so plainly and names the way in (used = fed).
   */
  async #feedingNotes(product: string, context: ExternalReadContext | undefined, kindEmpty: readonly EntryKind[], rootCaseCount: number, feeding: FeedingNotes | null = null): Promise<string[]> {
    void product; void context; void rootCaseCount;
    if (feeding === null) return kindEmpty.map((kind) => `这个版本的${labelOf('entry_kind', kind)}还没有被用到过：喂入层还没有记录；在运行里经 Hub 读到或上传后即进入喂入层`);
    const cut = feeding.cut;
    if (cut === null) return kindEmpty.map((kind) => `这个版本的${labelOf('entry_kind', kind)}还没有被用到过：喂入层为空；在运行里经 Hub 读到或上传后即进入`);
    const notes: string[] = [];
    let undeclared = 0;
    for (const bindings of cut.bindings.values()) if (bindings.some((binding) => binding.state === 'undeclared')) undeclared++;
    if (undeclared > 0) notes.push(`喂入层里 ${undeclared} 个对象版本未声明，单列计数，不进版本差`);
    if (cut.contradicted.size > 0) notes.push(`喂入层里 ${cut.contradicted.size} 个对象有矛盾（contradicts），单列`);
    for (const kind of kindEmpty) {
      const inLayer = kind === 'case' ? [...cut.objects.values()].filter(object=>object.schema==='fed-case@1').length : 0;
      notes.push(inLayer > 0
        ? `根里没有${labelOf('entry_kind', kind)}种类的条目；喂入层（冻结序号之前）有 ${inLayer} 个对象，按锁定树苗 + 喂入层读`
        : `这个版本的${labelOf('entry_kind', kind)}还没有被用到过：根和喂入层都没有；在运行里经 Hub 读到或上传后即进入喂入层`);
    }
    return notes;
  }

  get #packs(): PacksPort {
    return this.#context.packs;
  }

  async #composition(product:string,at:At):Promise<CompositionView|null>{
    const chosen=this.#readRoot?await this.#readRoot(product,{build:at.build}):null;
    if(chosen&&chosen.info.root===at.root){const body=await this.#context.store.composition(chosen.info.composition);if(body?.product===product&&body.root===at.root)return new CompositionView(this.#context.store,chosen.info.composition,body);}
    const named=await this.#builds.rootOfBuild(product,at.build);
    if(named?.root===at.root){const body=await this.#context.store.composition(named.composition);if(body?.product===product)return new CompositionView(this.#context.store,named.composition,body);}
    const all=(await this.#reading.compositionsOf(at.root)).filter(composition=>composition.body.product===product);
    return all.find(composition=>composition.body.build?.name===at.build)??all[0]??null;
  }

  #budget(reserve=VIEW_MARGIN):number {return Math.max(0,this.#context.limits.maxViewBytes-reserve);}
  async #scope(product: string, context?: ExternalReadContext, declared?: readonly ScopeRoot[]): Promise<ScopeRoot | null> {
    if (context?.run) {
      const lock = await this.#relations.runLock(context.run, context.principal);
      if (!lock.found) return context.unversioned ?? null;
      if (lock.product !== product) throw new ImpactRefusal('没有可读的运行产品范围；按本次运行的产品重读');
      if(context.unversioned!==undefined && canonicalize(context.unversioned)!==canonicalize(lock.unversioned??null)) throw new ImpactRefusal('读取上下文与运行的不分版本快照不同；按已存运行锁重读');
      return lock.unversioned ?? null;
    }
    const roots:ScopeRoot[]=[];
    for(const ref of declared ?? await this.#context.additionalScopeRoots?.(product) ?? []) {
      const body=await this.#context.store.composition(ref.composition);
      if(!body||body.product!==product||body.root!==ref.root)throw new ImpactRefusal('额外根缺少匹配的组成；管理员修正根与产品声明后重读');
      // Build-root declarations retain their original omission-only meaning.
      if(body.version===null&&body.build===null)roots.push(ref);
    }
    if (roots.length > 1) throw new ImpactRefusal('产品有多个不分版本的当前根；修复指针后重读');
    return roots[0] ?? null;
  }

  async #scopeView(product: string, scope: ScopeRoot | null): Promise<CompositionView | null> {
    if (scope === null) return null;
    const body = await this.#context.store.composition(scope.composition);
    if (!body || body.product !== product || body.root !== scope.root || body.version !== null || body.build !== null) throw new ImpactRefusal('不分版本的根缺少匹配的组成；恢复组成后重读');
    return new CompositionView(this.#context.store,scope.composition,body);
  }

  async #buildView(product: string, at: At): Promise<CompositionView | null> {
    if(at.composition===undefined)return this.#composition(product,at);
    const body=await this.#context.store.composition(at.composition);
    if(!body||body.product!==product||body.root!==at.root||body.build===null)throw new ImpactRefusal('构建根缺少匹配的组成；恢复组成后重读');
    return new CompositionView(this.#context.store,at.composition,body);
  }

  async #scopeSummary(scope: CompositionView | null, kinds: readonly string[], include: (row: KindEntry) => boolean = () => true, observe?: (row: KindEntry) => void): Promise<UnversionedView | null> {
    if (scope === null) return null;
    const entries=new Set<string>(), documents=new Set<string>();
    for (const kind of kinds) for await(const row of entriesOfKind(scope,kind)) {
      observe?.(row);
      if(!include(row))continue;
      entries.add(row.entry);
      const document=row.content.data.document;
      if (typeof document==='string' && document!=='') documents.add(document);
    }
    return {root:scope.body.root,composition:scope.record,build:null,skipped_sources:skippedCount(scope),totals:{entries:entries.size,documents:documents.size}};
  }

  #scopeCounts(summary: UnversionedView | null) {
    return summary===null ? {} : {unversioned_entries:summary.totals.entries,unversioned_documents:summary.totals.documents};
  }

  #scopeNote(summary: UnversionedView | null, scopeLocked = false, scope?: CompositionView | null): string {
    if(summary===null)return scopeLocked
      ? '本次锁定范围没有不分版本的根；下一步：以同样输入新开运行，非运行读取请从首页重读当前范围（需要时先同步这条产品线）'
      : '这条产品线还没有不分版本的根；下一步：同步这条产品线';
    let note=`不分版本的根 ${summary.root}：构建未声明；${summary.totals.entries} 个条目，${summary.totals.documents} 份文档`;
    if(summary.skipped_sources>0){
      const producers=[...new Set((scope?.body.skipped??[]).map(row=>row.producer))].sort(compareText);
      const detail=producers.length?`摘要中记录的生产器：${producers.join('、')}`:'旧组成未记录生产器明细，请按该组成的生产动作读取完整问题记录';
      note+=`；不分版本的根有 ${summary.skipped_sources} 份列出的来源未使用（${detail}）；缺少这些来源经核验的入根产出，不能据此当作没有条目。下一步：管理员恢复读取条件或修正资料/生产器，下轮同步自动重读重产，完成后以新运行核验`;
    }
    return note;
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
  async impact(product: string, from: At, to: At, changed: readonly EntryKind[], attached: readonly EntryKind[], attachedFields: readonly string[] | null = null, catalog: string | null = null, exclude: ReadonlySet<string> = new Set(), after: string | null = null,pinned?:{from:CompositionView|null;to:CompositionView|null;reserve?:number},scopeRoot?: ScopeRoot | null, scopeLocked = scopeRoot === null, feeding: FeedingNotes | null = null): Promise<ImpactView> {
    const scope = await this.#scopeView(product,scopeRoot === undefined ? await this.#scope(product) : scopeRoot);
    const summary = await this.#scopeSummary(scope,attached);
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
    const [fromComposition, toComposition] = pinned?[pinned.from,pinned.to]:await Promise.all([this.#buildView(product,from),this.#buildView(product,to)]);
    const page=pageState(after,{product,from,to,changed,attached,attachedFields,catalog,compositions:[fromComposition?.record,toComposition?.record],scope:scope?.record??null,exclude:[...exclude].sort(),...(feeding?.identity?{feeding:feeding.identity}:{})});
    const budget = this.#budget(pinned?.reserve);
    interface Item {
      position:number;
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
      const flaggedChange = [...before, ...after].filter((d) => exclude.has(d));
      if (flaggedChange.length > 0) {
        excludedPaths.push(node.path);
        for (const digest of flaggedChange) excludedEntries.set(digest, treeReference(after.includes(digest) ? to.root : from.root, node.path, digest));
        continue;
      }
      for (const digest of fromAll) if (exclude.has(digest)) excludedEntries.set(digest, treeReference(from.root, node.path, digest));
      for (const digest of toAll) if (exclude.has(digest)) excludedEntries.set(digest, treeReference(to.root, node.path, digest));
      if (full || changedPaths <= page.offset) continue;
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
        if(kept.length===0)throw new ImpactRefusal('单个变化路径超过视图页上限；用 attached_fields 收窄附着条目后重读');
        full = true;
        continue;
      }
      for (const [digest, value] of additions) named.set(digest, value);
      kept.push({ position:changedPaths-1, change, placement, named: [...new Set([...before, ...after, ...fromAttached, ...toAttached])] });
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
      for (const side of [from, to]) if (side.seedlingNote && !notes.includes(side.seedlingNote)) notes.push(side.seedlingNote);
      const missingAttachedOverall: EntryKind[] = [];
      {
        const countsBySide = await Promise.all([fromComposition, toComposition].map(async (composition) => composition === null ? new Map<string, number>() : await composition.kindCounts()));
        for (const kind of attached) if (countsBySide.every((counts) => (counts.get(kind) ?? 0) === 0)) missingAttachedOverall.push(kind);
      }
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
      if (feeding !== null && missingAttachedOverall.length > 0) notes.push(...await this.#feedingNotes(product, feeding.context, missingAttachedOverall, 0, feeding));
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
      const mainDone = !full && count === kept.length;
      let nextOffset=items.length ? items.at(-1)!.position+1 : page.offset;
      if(mainDone)nextOffset=Math.max(nextOffset,changedPaths);
      let scopeTruncated=false;
      if(scope !== null && mainDone) {
        const unique=new Map<string,KindEntry>();
        for(const kind of attached)for await(const row of entriesOfKind(scope,kind))unique.set(row.entry,row);
        const rows=[...unique.values()].sort((a,b)=>compareText(a.entry,b.entry));
        let bytes=Object.entries(entries).reduce((n,[key,value])=>n+memberBytes(key,value),0)+items.reduce((n,item)=>n+elementBytes(item.change)+(item.placement?elementBytes(item.placement):0),0);
        for(let i=Math.max(0,page.offset-changedPaths);i<rows.length;i++) {
          const row=rows[i];
          if(entries[row.entry]||exclude.has(row.entry)){nextOffset=changedPaths+i+1;continue;}
          const value=viewEntry(row.entry,slim(row.content),scope.body.root,row.path,true),size=memberBytes(row.entry,value);
          if(Object.keys(entries).length>=MAX_IMPACT_ENTRIES||bytes+size>budget){
            if(items.length===0&&Object.keys(entries).length===0)throw new ImpactRefusal('单条不分版本内容超过视图页上限；用 attached_fields 收窄条目后重读');
            scopeTruncated=true;break;
          }
          entries[row.entry]=value;bytes+=size;nextOffset=changedPaths+i+1;
        }
      }
      return {
        schema: 'impact-view@1',
        next: nextOffset<changedPaths||scopeTruncated?page.next(nextOffset):null,
        unversioned: summary,
        product,
        from: {build:from.build,root:from.root},
        to: {build:to.build,root:to.root},
        changed_kinds: [...effectiveChanged],
        attached_kinds: [...attached],
        ...(attachedFields !== null ? { attached_fields: [...attachedFields] } : {}),
        ...(catalog !== null ? { catalog } : {}),
        changes: items.map((item) => item.change),
        placements: items.flatMap((item) => (item.placement === null ? [] : [item.placement])),
        entries,
        totals: { ...this.#scopeCounts(summary), changed_paths: changedPaths, attached_from: attachedFrom, attached_to: attachedTo },
        truncated: scopeTruncated || nextOffset < changedPaths || excludedEntries.size > 0 || (scope !== null && exclude.size > 0),
        skipped: { from: skippedCount(fromComposition) + skippedCount(scope), to: skippedCount(toComposition) + skippedCount(scope) },
        notes: [...await notesOf(count), this.#scopeNote(summary,scopeLocked,scope)],
      };
    };
    // Sized exactly above; a later-root citation can lengthen a reference, so the answer is checked once more as a whole.
    let count = kept.length;
    let view = await build(count);
    while (count > 0 && canonicalByteLength(view) > this.#context.limits.maxViewBytes) {
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
  async facets(product: string, at: At, kind: EntryKind, by: readonly string[], exclude: ReadonlySet<string> = new Set(), after: string | null = null,pinned?:{composition:CompositionView|null;reserve?:number},scopeRoot?: ScopeRoot | null, scopeLocked = scopeRoot === null, feeding: FeedingNotes | null = null): Promise<FacetView> {
    const composition = pinned===undefined?await this.#buildView(product,at):pinned.composition;
    const scope = await this.#scopeView(product,scopeRoot === undefined ? await this.#scope(product) : scopeRoot);
    // The existing scope scan records positions without changing the build-preferred reference carrier.
    const scopePlaced = composition !== null && scope !== null ? new Set<string>() : null;
    const summary = await this.#scopeSummary(scope, [kind], undefined, scopePlaced === null ? undefined : row => {
      if (!row.unplaced) scopePlaced.add(row.entry);
    });
    const page=pageState(after,{product,at,kind,by,composition:composition?.record,scope:scope?.record??null,exclude:[...exclude].sort(),...(feeding?.identity?{feeding:feeding.identity}:{})});
    const seen = new Set<string>();
    const counts = new Map<string, { values: FacetValue[]; count: number; unversioned: number }>();
    const empty = Object.fromEntries(by.map(field => [field, 0]));
    const odd = { count: 0 };
    const unrooted=at.seedling&&kind==='case'&&feeding?.cut?rootlessCases(feeding.cut,at.root):0;
    const limit = Math.max(1, this.#context.limits.facetCombinations);
    let cut = 0;
    let unlisted = 0;
    let unplacedCount = 0;
    const take = (row: KindEntry): void => {
      if (seen.has(row.entry)) return;
      seen.add(row.entry);
      if (row.unplaced && !scopePlaced?.has(row.entry)) unplacedCount++;
      const lists = by.map((field) => facetValues(row.content.data, field, odd));
      // Count membership of each null group before collecting combinations or applying any row limit.
      lists.forEach((values, i) => { if (values.includes(null)) empty[by[i]]++; });
      if (lists.reduce((n, list) => n * list.length, 1) > MAX_FACET_COMBINATIONS) {
        throw new ImpactRefusal('单个条目的分面字段组合超过上限；减少 by 字段后重读，未返回部分计数');
      }
      let combos: FacetValue[][] = [[]];
      for (const list of lists) combos = combos.flatMap((combo) => list.map((value) => [...combo, value]));
      let left = false;
      for (const combo of combos) {
        const key = canonicalize(combo);
        const held = counts.get(key);
        if (held !== undefined) { held.count++; if(row.unversioned) held.unversioned++; }
        else if (counts.size < limit) counts.set(key, { values: combo, count: 1, unversioned: row.unversioned ? 1 : 0 });
        else throw new ImpactRefusal('分面取值组合超过可计算上限；减少 by 字段后重读，未返回部分计数');
      }
      if (left) unlisted++;
    };
    if (composition !== null || scope !== null) {
      for await (const row of scopedEntries(composition, scope, kind)) take(row);
    }
    let feedingConflicts=0,feedingUnknown=0,feedingCommandsUnknown=0;
    if (at.seedling && kind === 'case' && feeding?.cut) {
      const groups=new Map<string,KindEntry[]>();
      for(const row of fedCaseRows(at.root,feeding.cut,true)){const id=row.content.data.object;if(typeof id!=='string')continue;const group=groups.get(id)??[];group.push(row);groups.set(id,group);}
      for(const [id,group] of groups){
        if(group.some(row=>Array.isArray(row.content.data.line_candidates)&&row.content.data.line_candidates.length>1)){feedingConflicts++;continue;}
        if(by.includes('has_expected')&&group.some(row=>typeof row.content.data.has_expected!=='boolean')){feedingUnknown++;continue;}
        if((by.includes('commands')||by.includes('command_identities'))&&group.some(row=>typeof row.content.data.unparsed_steps==='number'&&row.content.data.unparsed_steps>0)){feedingCommandsUnknown++;continue;}
        const signature=(row:KindEntry)=>canonicalize(by.map(field=>facetValues(row.content.data,field,{count:0}).map(value=>canonicalize(value)).sort()));
        if(new Set(group.map(signature)).size!==1){feedingConflicts++;continue;}
        const selected=group.find(row=>!row.unplaced)??group[0];take({...selected,entry:id,unplaced:group.every(row=>row.unplaced)});
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
    const budget = this.#budget(pinned?.reserve);
    const rows: FacetView['rows'] = [];
    let bytes = 0;
    if(page.offset>all.length)throw new ImpactRefusal('续读游标已超出分面结果；从首页重新读取');
    for (const [, { values, count, unversioned }] of all.slice(page.offset)) {
      const row = { values: Object.fromEntries(by.map((field, i) => [field, values[i]])), count, ...(unversioned>0 ? {unversioned_count:unversioned,unversioned_root:scope!.body.root} : {}) };
      const size = elementBytes(row);
      if (rows.length + 1 > MAX_FACET_ROWS || bytes + size > budget) break;
      rows.push(row);
      bytes += size;
    }
    const entryCounts = { total: seen.size, placed: seen.size - unplacedCount, unplaced: unplacedCount };
    const notes: string[] = [];
    if (seen.size === 0 && feeding !== null) notes.push(...await this.#feedingNotes(product, feeding.context, [kind], 0, feeding));
    if (seen.size === 0 && feeding === null) notes.push(`构建 ${at.build} 的根里没有${labelOf('entry_kind', kind)}种类的条目`);
    if (unplacedCount > 0) notes.push(`${labelOf('knowledge_count', 'tree_unplaced_entries')} ${unplacedCount} 个，标在根下，计入合计`);
    if (page.offset>0 || page.offset+rows.length < all.length) notes.push(`取值组合有 ${all.length} 种，按取值排序；本页跳过前 ${page.offset} 种，列出 ${rows.length} 种（上限 ${MAX_FACET_ROWS} 行、约 ${this.#context.limits.maxViewBytes} 字节）`);
    if (unlisted > 0) notes.push(`取值组合超过 ${limit} 种以后出现的新组合没有收集：${unlisted} 个条目有组合没有计入任何一行（total 里计入），列出的行是先遇到的组合`);
    if (cut > 0) notes.push(`${cut} 个条目的列表字段组合超过 ${MAX_FACET_COMBINATIONS} 种，没有计入任何一行（total 里计入）`);
    if (odd.count > 0) notes.push(`${odd.count} 个取值不是标量，按其规范 JSON 文本计`);
    if (excluded > 0) notes.push(`${excluded} 种取值组合的文字有凭据扫描命中，没有列出`);
    const skipped = skippedNote(at, composition);
    if (skipped !== null) notes.push(skipped);
    if (at.seedlingNote) notes.push(at.seedlingNote);
    if(feedingConflicts)notes.push(`${feedingConflicts} 个喂入对象的多个来源在请求字段上不一致，未计入本页；缺少一致的来源事实，下一步由来源维护者核对后重新读取`);
    if(feedingUnknown)notes.push(`${feedingUnknown} 个用例缺期望节点的结构判定，未计入本页；下一步用新版产品包按锁定树苗重读原件`);
    if(feedingCommandsUnknown)notes.push(`${feedingCommandsUnknown} 个用例缺完整命令身份，未计入命令分面；下一步核对锁定命令树或补完整命令后重读，不把未知当作没有命令`);
    if(unrooted)notes.push(`${unrooted} 个用例缺所查树苗的投影，未计入本页；下一步用绑定树苗的运行重读原件，不把未核命令当作没有命令`);
    const view: FacetView = {
      schema: 'facet-view@1',
      next: page.offset+rows.length<all.length?page.next(page.offset+rows.length):null,
      unversioned: summary,
      product,
      build: {build:at.build,root:at.root},
      kind,
      by: [...by],
      rows,
      total: seen.size,
      totals: { empty, entry_counts: entryCounts, ...this.#scopeCounts(summary) },
      truncated: page.offset + rows.length < all.length || cut > 0 || unlisted > 0 || excluded > 0 || feedingConflicts>0 || feedingUnknown>0 || feedingCommandsUnknown>0 || unrooted>0,
      skipped: skippedCount(composition) + skippedCount(scope),
      notes: [...notes,this.#scopeNote(summary,scopeLocked,scope)],
    };
    if(rows.length===0&&page.offset<all.length)throw new ImpactRefusal('单行分面超过视图页上限；减少 by 字段后重读');
    return conforming(FacetView, view, 'facet-view@1');
  }

  /**
   * The entries of one kind by the values of a data field (a list field by each element), placed rows and the unplaced rows
   * of the root; only the listed values when given. An entry is filed once, an unplaced one at the root. Keys are kept in
   * code-unit order while they fit the limits, counted exactly. The content of an entry is held during the scan only while
   * the held entries fit the byte budget; a listed entry not held is read in a second scan. `exclude` names entries left
   * out because their text has credential scan hits.
   */
  async index(product: string, at: At, kind: EntryKind, key: string, only: readonly string[] | null, fields: readonly string[] | null = null, exclude: ReadonlySet<string> = new Set(), after: string | null = null,pinned?:{composition:CompositionView|null;reserve?:number},scopeRoot?: ScopeRoot | null, scopeLocked = scopeRoot === null, feeding: FeedingNotes | null = null): Promise<IndexView> {
    return withReadCache(()=>this.#index(product, at, kind, key, only, fields, exclude, after, pinned, scopeRoot, scopeLocked, false, feeding));
  }
  async #index(product: string, at: At, kind: EntryKind, key: string, only: readonly string[] | null, fields: readonly string[] | null = null, exclude: ReadonlySet<string> = new Set(), after: string | null = null,pinned?:{composition:CompositionView|null;reserve?:number},scopeRoot?: ScopeRoot | null, scopeLocked = scopeRoot === null, encodedOnly = false, feeding: FeedingNotes | null = null): Promise<IndexView> {
    // With fields, entries carry only those data fields and an empty statement; the identity (entry digest) and the
    // reference are unchanged. The truncation accounting uses the slimmed size: the fields decide what an entry costs.
    const slim = (content: EntryContent): EntryContent => {
      if (fields === null) return content;
      const data: Record<string, unknown> = {};
      for (const field of fields) if (Object.hasOwn(content.data, field)) data[field] = content.data[field];
      return { kind: content.kind, statement: '', data, applicability: content.applicability };
    };
    const composition = pinned===undefined?await this.#buildView(product,at):pinned.composition;
    const scope = await this.#scopeView(product,scopeRoot === undefined ? await this.#scope(product) : scopeRoot);
    const page=pageState(after,{product,at,kind,key,only,fields,composition:composition?.record,scope:scope?.record??null,exclude:[...exclude].sort(),...(feeding?.identity?{feeding:feeding.identity}:{})});
    const onlySet = only === null ? null : new Set(only);
    const unrooted=at.seedling&&kind==='case'&&feeding?.cut?rootlessCases(feeding.cut,at.root,key,onlySet):0;
    // Position membership is collected before the index-key filter; the count covers every entry of the kind.
    const scopePlaced = composition !== null && scope !== null ? new Set<string>() : null;
    const summary = await this.#scopeSummary(scope, [kind], row => indexKeys(row.content.data, key).some(value => onlySet === null || onlySet.has(value)), scopePlaced === null ? undefined : row => {
      if (!row.unplaced) scopePlaced.add(row.entry);
    });
    const budget = this.#budget(pinned?.reserve);
    const seen = new Set<string>();
    const encoder = createCanonicalEncoder();
    const validatedParts = this.#context.store?.rowsRead();
    const keys = new Map<string, string[]>();
    /** Every carrier: the path it is cited at and the exact bytes of its member in `entries`. */
    const carriers = new Map<string, number>();
    let entryKeyBytes: number | undefined;
    const held = new Map<string, Uint8Array>();
    let heldBytes = 0;
    const heldGroups = new Map<string, { digests: string[]; bytes: number; largest:string }>();
    let largestHeld: string | null = null, cacheFull = false;
    let previousPath = '', previousRoot = '', referencePrefix = '';
    let previousKind = '', parsedKind: EntryKind = kind;
    const projected = (row: KindEntry): ViewEntry => {
      if (row.path !== previousPath || row.root !== previousRoot) { previousPath = row.path; previousRoot = row.root!; referencePrefix = treeReference(row.root!, row.path, row.entry).slice(0, -64); }
      if (row.content.kind !== previousKind) { previousKind = row.content.kind; parsedKind = EntryKindSchema.parse(row.content.kind); }
      const content = slim(row.content);
      return { ...(row.unversioned ? { root: row.root!, build: null } : {}), entry: row.entry, kind: parsedKind, statement: content.statement, data: content.data, reference: row.reference??referencePrefix + row.entry };
    };
    let ofKind = 0;
    let unplacedCount = 0;
    let feedingRecords=0,keyFactsUnknown=0;
    const feedingObjects=new Set<string>();
    const excluded = new Map<string, string>();
    const seenScope = scope === null ? null : new Set<string>();
    const absorb = (row: KindEntry): void => {
        if(row.reference===null)throw new ImpactRefusal('缺喂入用例对应的可引用记录；请维护者补完整记录后重读索引');
        if (seen.has(row.entry)) return;
        seen.add(row.entry);
        ofKind++;
        if (row.unplaced && !scopePlaced?.has(row.entry)) unplacedCount++;
        if(kind==='case'&&['stories','defects','commands','command_identities'].includes(key)&&!Array.isArray(row.content.data[key]))keyFactsUnknown++;
        const values = indexKeys(row.content.data, key).filter((value) => onlySet === null || onlySet.has(value));
        if (values.length === 0) return;
        if(typeof row.reference==='string'&&row.reference.startsWith('rec:')){feedingRecords++;if(typeof row.content.data.object==='string')feedingObjects.add(row.content.data.object);}
        const value = projected(row);
        const serialized = encoder.text(value);
        const entryBytes = (entryKeyBytes ??= encoder.size(row.entry) + 2) + Buffer.byteLength(serialized);
        carriers.set(row.entry, entryBytes);
        if (exclude.has(row.entry)) excluded.set(row.entry, row.reference??treeReference(row.root!, row.path, row.entry));
        else {
          // Cache an ordered prefix of index values rather than whichever paths happened to be scanned first.
          // This bounds retained candidate bytes; final selection and the second-scan fallback below stay unchanged.
          const rank = values.reduce((first, value) => compareText(first, value) <= 0 ? first : value);
          if (!cacheFull || largestHeld === null || compareText(rank, largestHeld) <= 0) {
            let group = heldGroups.get(rank);
            if (group === undefined) { group = { digests: [], bytes: 0, largest:row.entry }; heldGroups.set(detachedText(rank), group); }
            // The final view can use only the first MAX_INDEX_PER_KEY digests of a value. Do not let a high-fanout
            // value evict every useful cached entry of the next value.
            let keep=true;
            if(group.digests.length>=MAX_INDEX_PER_KEY){
              if(compareText(row.entry,group.largest)>=0)keep=false;
              else{
                const removed=group.largest,fee=carriers.get(removed)!;held.delete(removed);heldBytes-=fee;group.bytes-=fee;
                group.digests.splice(group.digests.indexOf(removed),1);group.largest=group.digests.reduce((a,b)=>compareText(a,b)>0?a:b);
              }
            }
            if(keep){
              held.set(row.entry,Buffer.from(serialized));heldBytes+=entryBytes;group.digests.push(row.entry);group.bytes+=entryBytes;
              if(compareText(row.entry,group.largest)>0)group.largest=row.entry;
            }
            if (largestHeld === null || compareText(rank, largestHeld) > 0) largestHeld = detachedText(rank);
            while (heldBytes > budget && largestHeld !== null) {
              const removed = heldGroups.get(largestHeld)!;
              for (const digest of removed.digests) held.delete(digest);
              heldBytes -= removed.bytes; heldGroups.delete(largestHeld); cacheFull = true; largestHeld = null;
              for (const value of heldGroups.keys()) if (largestHeld === null || compareText(value, largestHeld) > 0) largestHeld = value;
            }
          }
        }
        for (const value of values) {
          const list = keys.get(value);
          if (list === undefined) keys.set(detachedText(value), [row.entry]);
          else list.push(row.entry);
        }
    };
    for (const source of [composition, scope]) {
      if (source === null) continue;
      await source.forEachEntry(kind, (entry, path, content, unplaced) => {
        if (seenScope?.has(entry)) return;
        seenScope?.add(entry);
        absorb({ entry, path, content, unplaced, root: source.body.root, unversioned: source === scope });
      }, validatedParts);
    }
    let feedingConflicts=0,feedingCommandsUnknown=0;
    if (at.seedling && kind === 'case' && feeding?.cut) for (const row of fedCaseRows(at.root, feeding.cut,true)) {
      if(Array.isArray(row.content.data.line_candidates)&&row.content.data.line_candidates.length>1){if(key!=='document'||!onlySet||typeof row.content.data.document!=='string'||onlySet.has(row.content.data.document))feedingConflicts++;continue;}
      const needsCommands=key==='commands'||key==='command_identities'||fields===null||fields.includes('commands')||fields.includes('command_identities');
      const selectedDocument=key!=='document'||!onlySet||typeof row.content.data.document!=='string'||onlySet.has(row.content.data.document);
      if(needsCommands&&selectedDocument&&typeof row.content.data.unparsed_steps==='number'&&row.content.data.unparsed_steps>0)feedingCommandsUnknown++;
      absorb(row);
    }
    const entryCounts = { total: seen.size, placed: seen.size - unplacedCount, unplaced: unplacedCount };
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
    let position=0;
    let available=0;
    for(const value of [...keys.keys()].sort(compareText)) {
      if(value===PROTO_KEY)throw new ImpactRefusal('索引含 JSON 原型保留键 __proto__；改用 only 列出需要的普通取值，或让生产器改正此字段后重新同步');
      const all=(keys.get(value)??[]).filter(d=>!exclude.has(d)).sort(compareText);
      available+=all.length;
      for(const digest of all){
        const ordinal=position++;
        if(ordinal<page.offset||stoppedAt!==null)continue;
        let item=kept.at(-1);
        const same=item?.value===value;
        const fresh=listedAll.has(digest)?[]:[digest];
        const size=(same?elementBytes(digest):memberBytes(value,[digest]))+fresh.reduce((sum,d)=>sum+carriers.get(d)!,0);
        if((same&&item!.listed.length>=MAX_INDEX_PER_KEY)||listedAll.size+fresh.length>MAX_INDEX_ENTRIES||bytes+size>budget){
          if(kept.length===0)throw new ImpactRefusal('单条索引内容超过视图页上限；用 fields 收窄条目字段后重读');
          stoppedAt=value;break;
        }
        if(!same){item={value,listed:[],fresh:[],cut:false};kept.push(item);}
        item!.listed.push(digest);item!.fresh.push(...fresh);fresh.forEach(d=>listedAll.add(d));bytes+=size;
      }
    }
    if(page.offset>available)throw new ImpactRefusal('续读游标已超出索引结果；从首页重新读取');
    // Listed entries whose content was not held during the scan are read in a second one.
    const wanted = new Set([...listedAll].filter((d) => !held.has(d)));
    if (wanted.size > 0 && (composition !== null || scope !== null)) {
      for await (const row of scopedEntries(composition, scope, kind)) {
        if (!wanted.has(row.entry)) continue;
        held.set(row.entry, encoder.bytes(viewEntry(row.entry, slim(row.content), row.root!, row.path, row.unversioned, row.reference??undefined)));
        wanted.delete(row.entry);
        if (wanted.size === 0) break;
      }
    }
    if (wanted.size > 0 && at.seedling && kind === 'case' && feeding?.cut) {
      for (const row of fedCaseRows(at.root, feeding.cut,true)) {
        if (!wanted.has(row.entry)) continue;
        if(row.reference===null)throw new ImpactRefusal('缺喂入用例对应的可引用记录；请维护者补完整记录后重读索引');
        held.set(row.entry, encoder.bytes(viewEntry(row.entry, slim(row.content), row.root!, row.path, row.unversioned, row.reference??undefined)));
        wanted.delete(row.entry);
      }
    }
    if(wanted.size>0)throw new Error('第二遍读取缺少不可变索引条目');
    // The selection is fixed. Drop unselected serialized candidates before materializing the answer.
    for (const digest of held.keys()) if (!listedAll.has(digest)) held.delete(digest);
    const decoded = new Map<string, ViewEntry>();
    const decode = (digest: string): ViewEntry => {
      let entry = decoded.get(digest);
      if (entry === undefined) { const bytes = held.get(digest)!; entry = JSON.parse(Buffer.from(bytes).toString('utf8')) as ViewEntry; this.#entryBytes.set(entry, bytes); decoded.set(digest, entry); held.delete(digest); }
      return entry;
    }
    const feedingNotes: string[] = ofKind === 0 && feeding !== null ? await this.#feedingNotes(product, feeding.context, [kind], 0, feeding) : [];
    const notes = (count: number): string[] => {
      const out: string[] = [];
      if (ofKind === 0) { out.push(`构建 ${at.build} 的根里没有${labelOf('entry_kind', kind)}种类的条目`); out.push(...feedingNotes); }
      else if (keys.size === 0) out.push(`${feedingCommandsUnknown||feedingConflicts||unrooted?'当前没有可列出的':'没有'}${labelOf('entry_kind', kind)}条目在数据字段 ${key} 上有${only === null ? '取值' : '所列的取值'}`);
      if(feedingRecords)out.push(`喂入索引列出 ${feedingRecords} 条来源记录、${feedingObjects.size} 个内容身份；同一内容的多个出处分别引用记录，data.object 是共享身份`);
      if(feedingConflicts)out.push(`${feedingConflicts} 条用例来源的版本层有冲突，未计入本索引；下一步由来源维护者核对目录后重读`);
      if(feedingCommandsUnknown)out.push(`${feedingCommandsUnknown} 条用例来源缺完整命令身份，不能认为命令集合为空；下一步核对锁定命令树或补完整命令后重读`);
      if(keyFactsUnknown)out.push(`${keyFactsUnknown} 个用例缺少索引字段 ${key} 的结构事实，不能据此判断键不存在；下一步由作者补声明或用新版生产器重读原件`);
      if(unrooted)out.push(`${unrooted} 个用例缺所查树苗的投影，未计入本索引；下一步用绑定树苗的运行重读原件`);
      if (only !== null) {
        const absent = only.filter((value) => !keys.has(value));
        if (absent.length > 0 && keys.size > 0) out.push(`这些取值没有条目：${cutText(absent.slice(0, 20).join('、'), 500)}${absent.length > 20 ? ` 等 ${absent.length} 个` : ''}`);
      }
      const perKeyCut = kept.slice(0, count).filter((item) => item.cut).length;
      if (perKeyCut > 0) out.push(`${perKeyCut} 个取值的条目超过 ${MAX_INDEX_PER_KEY} 个，只列出按摘要排序的前 ${MAX_INDEX_PER_KEY} 个`);
      if (fields !== null) out.push(`条目只带字段 ${fields.join('、')}（fields 参数），陈述为空`);
      const stop = count < kept.length ? kept[count].value : stoppedAt;
      if (stop !== null) out.push(`本页在取值 ${cutText(stop, 80)} 处停止，按 next 续读剩余条目（上限 ${MAX_INDEX_ENTRIES} 个条目、约 ${this.#context.limits.maxViewBytes} 字节）`);
      if (unplacedCount > 0) out.push(`${labelOf('knowledge_count', 'tree_unplaced_entries')} ${unplacedCount} 个，标在根下`);
      if (proto > 0) out.push(`取值 ${PROTO_KEY} 不能作为这个视图的键（读成 JSON 对象时会被当作原型），带它的 ${proto} 个条目没有按它列出`);
      if (excluded.size > 0) out.push(credentialNote([...excluded.values()]));
      const skipped = skippedNote(at, composition);
      if (skipped !== null) out.push(skipped);
      if (at.seedlingNote) out.push(at.seedlingNote);
      out.push(this.#scopeNote(summary,scopeLocked,scope));
      return out;
    };
    const build = (count: number): IndexView => {
      const items = kept.slice(0, count);
      const entries: Record<string, ViewEntry> = {};
      const digests = items.flatMap(item => item.fresh).sort(compareText);
      if (!encodedOnly) for (const digest of digests) entries[digest] = decode(digest);
      const truncated=page.offset+items.reduce((sum,item)=>sum+item.listed.length,0)<available || excluded.size > 0 || unrooted>0 || feedingConflicts>0 || feedingCommandsUnknown>0 || keyFactsUnknown>0;
      const keySpaceComplete=only===null&&skippedCount(composition)+skippedCount(scope)===0&&unrooted===0&&feedingConflicts===0&&keyFactsUnknown===0&&keys.size===items.length;
      const discloseKeySpace=kind==='case'&&(Boolean(feeding?.cut)||keyFactsUnknown>0||!truncated||keySpaceComplete);
      const answer: IndexView = {
        schema: 'index-view@1',
        next: page.offset+items.reduce((sum,item)=>sum+item.listed.length,0)<available?page.next(page.offset+items.reduce((sum,item)=>sum+item.listed.length,0)):null,
        unversioned: summary,
        totals: { ...this.#scopeCounts(summary), entry_counts: entryCounts },
        product,
        build: {build:at.build,root:at.root},
        kind,
        key,
        ...(fields !== null ? { fields: [...fields] } : {}),
        // Built from pairs: a key is always an own member, never an assignment to a prototype.
        keys: Object.fromEntries(items.map((item) => [item.value, item.listed])),
        entries,
        ...(only !== null ? { only: [...new Set(only)].sort(compareText) } : {}),
        cut_keys: items.filter((item) => item.cut).map((item) => item.value),
        ...(discloseKeySpace?{key_space_complete:keySpaceComplete}:{}),
        total_keys: keys.size,
        total_entries: carriers.size,
        truncated,
        skipped: skippedCount(composition) + skippedCount(scope),
        notes: notes(count),
      };
      if (encodedOnly) this.#encodedIndexes.set(answer, new Map(digests.map(digest => [digest, held.get(digest)!])));
      return answer;
    };
    let count = kept.length;
    let view = build(count);
    while (count > 0 && this.#length(view) > this.#context.limits.maxViewBytes) {
      count = Math.max(0, Math.min(count - 1, Math.floor(count * 0.95)));
      view = build(count);
    }
    // Validate entry batches without retaining Zod's deep clone of the whole answer.
    conforming(IndexView, { ...view, entries: {} }, 'index-view@1');
    // Encoded entries are built only from schema-checked composition rows and a fully validated tree reference.
    // Decoding and cloning that same data again here defeats streaming. The public object API still validates its graph.
    if (!this.#encodedIndexes.has(view)) {
      const entries = Object.entries(view.entries);
      for (let i = 0; i < entries.length; i += 128)conforming(IndexView.shape.entries, Object.fromEntries(entries.slice(i, i + 128)), 'index-view@1.entries');
    }
    return view;
  }

  /** ExternalReaderPort.read for a knowledge view id: never throws, ok:false with the real reason for the admin log. */
  async read(id: string, context: ExternalReadContext): Promise<ExternalRead> {
    const startedAt = this.#context.now().toISOString();
    try {
      return await withReadCache(()=>this.#read(id, context, startedAt));
    } catch (error) {
      if(error instanceof RelationReadError)return {ok:false,id:splitRevision(id).body,reason:error.message+'；下一步：'+error.nextAction};
      if (error instanceof LinkRefusal) return {ok:false,id:splitRevision(id).body,reason:error.message};
      if(error instanceof BuildNameRefusal)return {ok:false,id:splitRevision(id).body,reason:error.message,inputError:{message:error.message,fix:error.fix}};
      if (error instanceof ImpactRefusal) return {ok:false,id:splitRevision(id).body,reason:error.message};
      return { ok: false, id, reason: `知识视图出错：${describeError(error)}` };
    }
  }

  async #readLinks(bare:string,request:Extract<ViewRequest,{type:'links'}>,context:ExternalReadContext,startedAt:string):Promise<ExternalRead>{
    const handle=await this.#packs.productById(request.product)??await this.#packs.productByName(request.product);
    if(!handle||!await this.#reading.mayReadProducts(context.principal,[handle.product.id]))return {ok:false,id:bare,reason:'产品不存在或不可读'};
    const scopeLocked=Boolean(context.run)||request.cursor!==null;
    let scopeRoot=await this.#scope(handle.product.id,context);
    let pageCursor=request.cursor, cursorComposition:string|undefined, savedScopeCut:number|undefined;
    if(pageCursor!==null){
      let decoded:unknown;
      try{decoded=JSON.parse(Buffer.from(pageCursor,'base64url').toString('utf8'));}catch{}
      if(decoded!==null&&typeof decoded==='object'&&'cursor' in decoded){
        const wrapper=decoded as Record<string,unknown>, value=wrapper.scope;
        if(typeof wrapper.cursor!=='string'||!Sha256.safeParse(wrapper.c).success||!(value===null||value!==null&&typeof value==='object'&&'root' in value&&'composition' in value&&Sha256.safeParse(value.root).success&&Sha256.safeParse(value.composition).success))throw new LinkRefusal('分页游标缺少有效的不分版本快照；从第一页重新读取');
        const saved=value===null?null:value as ScopeRoot;
        if(context.run&&canonicalize(saved)!==canonicalize(scopeRoot))throw new LinkRefusal('分页游标与运行的不分版本快照不同；从本次运行的第一页重新读取');
        if(wrapper.scope_cut!==undefined&&(!Number.isSafeInteger(wrapper.scope_cut)||Number(wrapper.scope_cut)<0))throw new LinkRefusal('分页游标的不分版本截断计数无效；从首页重新读取');
        savedScopeCut=wrapper.scope_cut as number|undefined;
        scopeRoot=saved;pageCursor=wrapper.cursor;cursorComposition=String(wrapper.c);
      }
    }
    const fold=(name:string)=>name.normalize('NFC').toLowerCase();
    let locked=context.composition,lockedRoot:string|null=null,selectedBuild=context.build,selectedProduct:string|null=null;
    let storedRun=false,storedComposition:string|null|undefined;
    if(context.run){
      const run=await this.#relations.runLock(context.run,context.principal);storedRun=run.found;
      if(run.found){selectedBuild=run.build??selectedBuild;selectedProduct=run.product??null;storedComposition=run.composition;locked=run.composition;lockedRoot=run.root;}
      else if(locked===undefined)return {ok:false,id:bare,reason:'运行尚未存下；读取必须透传已选定的组成'};
    }
    const lockedBody=locked?await this.#context.store.composition(locked):null;
    selectedProduct??=lockedBody?.product??null;
    const frozenSelector=!!context.run&&selectedBuild!==undefined&&fold(request.build)===fold(selectedBuild)&&lockedBody?.product===handle.product.id;
    let named=frozenSelector?{...lockedBody!.build,name:selectedBuild!}:await this.#builds.named(handle.product.id,request.build);
    const history=async()=>this.#context.store.buildsOf(handle.product.id);
    if(named===null){const saved=(await history()).find(row=>fold(row.body.build.name)===fold(request.build));named=saved?.body.build??null;}
    const target=!!context.run&&named!==null&&selectedBuild!==undefined&&fold(named.name)===fold(selectedBuild)&&selectedProduct===handle.product.id;
    const useRunLock=named===null||target;
    if(storedRun&&useRunLock&&context.composition&&context.composition!==storedComposition)return {ok:false,id:bare,reason:'读取上下文的组成与已存运行锁定的组成不同；按运行记录的组成重读'};

    if(context.run&&named!==null&&!storedRun&&locked&&selectedBuild===undefined)return {ok:false,id:bare,reason:'运行尚未存下，命名构建读取缺少 build 上下文；下一步：透传运行选定的规范构建名'};
    if(context.run&&useRunLock&&storedRun&&lockedRoot!==null&&!locked)return {ok:false,id:bare,reason:'这个运行没有锁定组成快照；下一步：以同样输入新开运行再读关联'};
    const effectiveLock=context.run?(useRunLock?locked:undefined):locked;
    if(effectiveLock&&request.composition&&effectiveLock!==request.composition)return {ok:false,id:bare,reason:'请求的组成与运行锁定的组成不同；按锁定组成重读'};
    const supplied=Boolean(effectiveLock||request.composition||cursorComposition);
    let composition=effectiveLock??request.composition??cursorComposition??(scopeRoot===null?request.revision:null);
    if(!composition&&request.cursor){try{const cursor=JSON.parse(Buffer.from(request.cursor,'base64url').toString('utf8'));if(Sha256.safeParse(cursor.c).success)composition=cursor.c;}catch{}}
    const chosen=this.#readRoot?await this.#readRoot(handle.product.id,named!==null?{build:named.name}:{line:request.build}):null;
    if(!composition){
      if(chosen)composition=chosen.info.composition;
      else if(named!==null){const namedRoot=await this.#builds.rootOfBuild(handle.product.id,named.name);if(!namedRoot)return {ok:false,id:bare,reason:'这个命名构建没有已生产的组成；先生产其基础构建再读'};composition=namedRoot.composition;}
      else {const current=await this.#builds.currentRoot(handle.product.id,request.build);if(!current)return {ok:false,id:bare,reason:'没有这个构建或版本线的当前组成；先核对名称并生产后再读'};composition=current.composition;}
    }
    const fromResolver=!supplied&&chosen?.info.composition===composition;
    const body=await this.#context.store.composition(composition);
    if(!body||body.product!==handle.product.id)return {ok:false,id:bare,reason:'组成不属于请求的产品，改用该产品的组成'};
    if(useRunLock&&context.run&&lockedRoot!==null&&body.root!==lockedRoot)return {ok:false,id:bare,reason:'组成的根与运行锁定的根不同；按运行锁定组成重读'};
    if(named===null&&!fromResolver&&body.version?.line!==request.build)return {ok:false,id:bare,reason:'组成不属于请求的版本线'};
    if(named!==null&&!target&&!fromResolver){
      const base=fold(body.build?.name ?? ''),graph=new Map<string,Set<string>>();
      for(const row of await history()){const key=fold(row.body.build.name),values=graph.get(key)??new Set<string>();values.add(fold(row.body.build.base));graph.set(key,values);}
      const seen=new Set<string>(),belongs=(name:string):boolean=>{const key=fold(name);if(key===base)return true;if(seen.has(key))return false;seen.add(key);return [...(graph.get(key)??[])].some(belongs);};
      if(!belongs(named.name))return {ok:false,id:bare,reason:'组成不属于这个命名构建或它已记录的基础构建；核对 composition 后重读'};
    }
    const revision=scopeRoot===null?composition:sha256Hex(canonicalize({composition,scope:scopeRoot}));
    if(request.revision!==null&&request.revision!==revision)return {ok:false,id:bare,reason:'要求的修订与锁定组成不同，请按锁定组成重读'};
    const scope=await this.#scopeView(handle.product.id,scopeRoot);
    const summary=await this.#scopeSummary(scope,ENTRY_KIND);
    const firstPage=pageCursor===null;
    const entries:Record<string,ViewEntry>={};
    let cut=savedScopeCut??0;
    if(scope){
      const budget=Math.max(0,Math.floor((this.#context.limits.maxViewBytes-4096)/2));
      let used=2,full=false;cut=0;
      for(const kind of ENTRY_KIND)for await(const row of entriesOfKind(scope,kind)){
        if(full){cut++;continue;}
        const entry=viewEntry(row.entry,row.content,scope.body.root,row.path,true),size=memberBytes(row.entry,entry);
        if(full||used+size>budget){full=true;cut++;continue;}
        used+=size;if(firstPage)entries[row.entry]=entry;
      }
    }
    if(savedScopeCut!==undefined&&savedScopeCut!==cut)throw new LinkRefusal('分页游标的不分版本截断计数与根和预算不符；请从首页重新读取');
    if(summary)summary.totals.cut_entries=cut;
    const reserve=canonicalBytes({unversioned:summary,entries,notes:[this.#scopeNote(summary,scopeLocked,scope)]}).byteLength;
    const view=await this.#relations.page(new CompositionView(this.#context.store,composition,body),{prefix:request.prefix,target:request.target,rule:request.rule,cursor:pageCursor,limit:request.limit,maxBytes:Math.max(0,this.#context.limits.maxViewBytes-reserve),...(named?{build:request.build}:{})});
    if(view.next!==null)view.next=Buffer.from(canonicalize({c:composition,scope:scopeRoot,cursor:view.next,scope_cut:cut})).toString('base64url');
    view.unversioned=summary;
    const rootNote=readRootNote(chosen&&body.root===chosen.info.root?chosen:null);
    if(rootNote)view.notes.push(rootNote);
    view.notes.push(this.#scopeNote(summary,scopeLocked,scope));
    if(scope){
      view.entries=firstPage?entries:{};
      if(cut>0){view.truncated=true;view.notes.push(`不分版本条目只在首页交付；有 ${cut} 条被字节预算截断，按 get_nodes 从根 ${scope.body.root} 分页读取剩余条目`);}
      else view.notes.push('不分版本条目只在首页交付，后续页不重复发送');
    }
    if(view.totals)Object.assign(view.totals,this.#scopeCounts(summary),summary?{unversioned_entries_cut:cut}:{});
    if (canonicalByteLength(view) > this.#context.limits.maxViewBytes) throw new LinkRefusal('链接视图的固定范围说明超过字节上限；请维护者调整字节预算后从首页重读');
    LinksView.parse(view);
    const inputs=[`tree:${body.root}/`,`rec:${composition}`],origin={generated:{generator:COMPONENTS.views,inputs}},sources=new Set<string>();
    const sourceView=new CompositionView(this.#context.store,composition,body);
    for(const sourceViewItem of [sourceView,scope])if(sourceViewItem)for(const source of await sourceViewItem.sources())sources.add(source.sha256);
    if(scope)inputs.push(`tree:${scope.body.root}/`,`rec:${scope.record}`);
    const derivedCoverage=await this.#context.records.artifacts.prepareDerived({origin,author:{user:null},derivedSources:[...sources]});
    const artifact=await this.#context.records.artifacts.ingest({bytes:canonicalBytes(view),mediaType:'application/json',origin,derivedCoverage,author:{user:null},provenanceType:'projected',visibility:{readers:[context.principal.id],admins:true,packs:[],shareable:false},name:'links-view.json'});
    if(artifact.body.read_tier!=='model_readable')return {ok:false,id:bare,reason:'链接视图含有未受理的凭据命中，需管理员处理后重读'};
    const manifest=await this.#context.store.putAction({action:ACTION.generate,run:RunId.safeParse(context.run).success?context.run!:null,item:null,inputs,component:COMPONENTS.views,lease:null,started_at:startedAt,ended_at:this.#context.now().toISOString(),result:'completed',error_code:null,acceptance:null,codes:[],detail:{external:bare,view:'links',product:body.product,roots:[body.root,...(scopeRoot?[scopeRoot.root]:[])],composition,revision,artifact:artifact.digest,sha256:artifact.body.sha256,size:artifact.body.size,reader:context.principal.id,purpose:cutText(context.purpose,200)}},[]);
    return {ok:true,id:bare,revision,artifacts:[{name:'original',artifact}],manifest:manifest.digest};
  }

  async #read(id: string, context: ExternalReadContext, startedAt: string): Promise<ExternalRead> {
    const parsed = parseViewId(id);
    const bare = splitRevision(id).body;
    if (!parsed.ok) return { ok: false, id: bare, reason: parsed.reason };
    const request = parsed.value;
    if(request.type==='links')return this.#readLinks(bare,request,context,startedAt);
    const handle = (await this.#packs.productById(request.product)) ?? (await this.#packs.productByName(request.product));
    if (handle === null) return { ok: false, id: bare, reason: `没有产品 ${cutText(request.product, 80)}` };
    const product = handle.product.id;
    const principal = context.principal;
    if (!(await this.#reading.mayReadProducts(principal, [product]))) return { ok: false, id: bare, reason: `账号 ${principal?.id ?? '（无）'} 不能读产品 ${product} 的知识` };
    const pins=new Map<string,CompositionView>();
    let reserve=VIEW_MARGIN;
    const additional=context.run?undefined:await this.#context.additionalScopeRoots?.(product);
    const scopeRoot = await this.#scope(product,context,additional);
    const resolve = async (name: string): Promise<At | string> => {
      const named = await this.#builds.named(product, name);
      if (named === null) {
        const candidates = await this.#builds.candidates(product,name);
        if(candidates.length>1)throw new BuildNameRefusal(`构建名字的大小写有歧义，候选：${candidates.map(build=>build.name).join('、')}；请使用候选的完整原样构建名重读`);
        return `产品 ${product} 没有构建 ${cutText(name,80)}`;
      }
      const chosen = this.#readRoot ? await this.#readRoot(product, { build: name }) : null;
      const root = chosen?.info ?? (this.#readRoot ? null : await this.#builds.rootOfBuild(product, name));
      if (root === null) return `构建 ${named.name} 还没有知识树的根`;
      const seedlingNote = readRootNote(chosen);
      const locked=context.composition && context.build===named.name ? await this.#context.store.composition(context.composition) : null;
      const useLocked = Boolean(locked && locked.product===product);
      const seedling = useLocked ? Boolean(chosen?.source === 'seedling' && locked!.root === chosen.info.root) : chosen?.source === 'seedling';
      const at = {
        build: named.name,
        root: useLocked ? locked!.root : root.root,
        composition: useLocked ? context.composition! : root.composition,
        ...(seedling ? { seedling: true, ...(seedlingNote ? { seedlingNote } : {}) } : {}),
      };
      const body=await this.#context.store.composition(at.composition);
      if(!body||body.product!==product||body.root!==at.root)throw new ImpactRefusal('构建的组成快照缺失；管理员恢复组成后重读');
      pins.set(`${at.root}\0${at.build}`,new CompositionView(this.#context.store,at.composition,body));
      return at;
    };
    const resolved=new Map<string,ReturnType<typeof resolve>>();
    const resolveOnce=(name:string):ReturnType<typeof resolve>=>{
      let pending=resolved.get(name);
      if(pending===undefined){pending=resolve(name);resolved.set(name,pending);}
      return pending;
    };
    let roots: string[];
    let key: string;
    let compute: (exclude: ReadonlySet<string>) => Promise<ImpactView | FacetView | IndexView>;
    let title: string;
    if (request.type === 'impact') {
      const from = await resolveOnce(request.from);
      if (typeof from === 'string') return { ok: false, id: bare, reason: from };
      const to = await resolveOnce(request.to);
      if (typeof to === 'string') return { ok: false, id: bare, reason: to };
      roots = [from.root, to.root];
      key = canonicalize({ type: request.type, product, from, to, changed: request.changed, attached: request.attached, attached_fields: request.attached_fields, catalog: request.catalog, after:request.after??null });
      compute = (exclude) => this.impact(product, from, to, request.changed, request.attached, request.attached_fields, request.catalog, exclude, request.after??null,{from:pins.get(`${from.root}\0${from.build}`)!,to:pins.get(`${to.root}\0${to.build}`)!,reserve},scopeRoot,Boolean(context.run),feeding);
      title = `版本差 ${from.build} → ${to.build}（${product}）`;
    } else {
      const at = await resolveOnce(request.build);
      if (typeof at === 'string') return { ok: false, id: bare, reason: at };
      roots = [at.root];
      if (request.type === 'facets') {
        key = canonicalize({ type: request.type, product, at, kind: request.kind, by: request.by, after:request.after??null });
        compute = (exclude) => this.facets(product, at, request.kind, request.by, exclude, request.after??null,{composition:pins.get(`${at.root}\0${at.build}`)!,reserve},scopeRoot,Boolean(context.run),feeding);
        title = `${labelOf('entry_kind', request.kind)}按 ${request.by.join('、')} 计数（${at.build}）`;
      } else {
        key = canonicalize({ type: request.type, product, at, kind: request.kind, key: request.key, only: request.only, fields: request.fields, after:request.after??null });
        compute = (exclude) => this.#index(product, at, request.kind, request.key, request.only, request.fields, exclude, request.after??null,{composition:pins.get(`${at.root}\0${at.build}`)!,reserve},scopeRoot,Boolean(context.run),true,feeding);
        title = `${labelOf('entry_kind', request.kind)}按 ${request.key} 索引（${at.build}）`;
      }
    }
    const feeding: FeedingNotes | null = await (async () => {
      const reader = this.#context.feedingReader;
      if (reader === undefined) return null;
      const handle = await this.#packs.productById(product) ?? await this.#packs.productByName(product);
      if (handle === null) return null;
      if(reader===this.#context.feeding){const at=await resolveOnce(request.type==='impact'?request.to:request.build);if(typeof at==='string'||!await seedlingOfRoot(this.#context,product,at.root))return null;}
      const offset = context.feeding_offset?.offset??(context.run === undefined || context.run === null ? null : await reader.frozenOffset(context.run));
      if(context.run&&offset===null)throw new KnowledgeError('旧运行缺少冻结的喂入序号；另开运行以冻结树苗和喂入层，不能用最新序号冒充历史',{code:'REFERENCE_UNRESOLVED'});
      const cut=await reader.cut(handle.product.id, offset,context.principal);
      return { context, cut, identity:cut===null?null:feedingIdentity(cut,principal.id) };
    })();
    key = canonicalize({request:key,scope:scopeRoot,feeding:feeding?.identity??null});
    const revision = feeding?.identity ? request.type==='impact'?[roots[0],sha256Hex(canonicalize({root:roots[1],scope:scopeRoot,feeding:feeding.identity}))].join('..'):sha256Hex(canonicalize({root:roots[0],scope:scopeRoot,feeding:feeding.identity})) : scopeRoot === null ? roots.join('..') : request.type === 'impact' ? [roots[0],sha256Hex(canonicalize({root:roots[1],scope:scopeRoot}))].join('..') : sha256Hex(canonicalize({root:roots[0],scope:scopeRoot}));
    if (request.revision !== null && request.revision !== revision) return { ok: false, id: bare, reason: `要求修订 ${cutText(request.revision, 140)}，现在是 ${revision}` };
    const compositions=[...new Map([...pins.values()].map(composition=>[composition.record,composition])).values()];
    key=canonicalize({query:key,compositions:compositions.map(composition=>composition.record)});
    const rawScope=await documentScope({...this.#context,additionalScopeRootsDeclared:(this.#context.additionalScopeRootsDeclared??this.#context.additionalScopeRoots!==undefined)||scopeRoot!==null,additionalScopeRoots:async()=>additional??(scopeRoot?[scopeRoot]:[])},product,compositions,request.type==='impact');
    if(scopeRoot){roots.push(scopeRoot.root);const scope=await this.#scopeView(product,scopeRoot);if(scope&&!compositions.some(c=>c.record===scope.record))compositions.push(scope);}
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
    const ingest = (bytes: Uint8Array): Promise<SourceArtifact> => {
      const consume = bytes.byteLength >= 1024 * 1024;
      // A large private view hands off its one owned buffer; retaining an alias would defeat both immutability and memory bounds.
      if (consume) this.#cache.delete(key);
      const write = consume ? this.#context.records.artifacts.ingestTransferred.bind(this.#context.records.artifacts) : this.#context.records.artifacts.ingest.bind(this.#context.records.artifacts);
      return write({
        bytes,
        mediaType: 'application/json',
        origin,
        derivedCoverage:coverage,
        author: { user: null },
        provenanceType: 'projected',
        visibility,
        name: `${request.type}-view.json`,
      });
    };
    const scopeCollection=async(rows:ScopedDocument[]):Promise<KnowledgeViewScope['listed_documents']>=>{
      const parts:KnowledgeViewScope['listed_documents']['parts']=[];
      const storePage=async(page:ScopedDocument[]):Promise<void>=>{
        const artifact=await this.#context.records.artifacts.ingest({bytes:canonicalBytes(page),mediaType:'application/json',origin,derivedCoverage:coverage,author:{user:null},provenanceType:'projected',visibility,name:'knowledge-scope.json'});
        if(artifact.body.read_tier!=='model_readable'){
          const action='管理员核对范围清单的来源标识并修正源头，确认可公开后重新读取';
          const question=await requestKnowledgeFact(this.#context,{kind:'clarification',subject:`范围清单核对 ${artifact.body.sha256}`,missing:'范围清单仍有未受理凭据，未交付清单内容',action,inputs:[...inputs,`src:${artifact.body.sha256}`]});
          throw new ImpactRefusal(`范围清单被排除，引用 src:${artifact.body.sha256}；管理员 ${question.audience_user} 的核对请求 ${question.reference}，期限 ${question.deadline}；${action}`);
        }
        parts.push({reference:`src:${artifact.body.sha256}`,sha256:artifact.body.sha256,rows:page.length});
      };
      let page:ScopedDocument[]=[],bytes=0;
      for(const row of rows){const size=canonicalBytes(row).byteLength;if(page.length>0&&(page.length>=2000||bytes+size>512*1024)){await storePage(page);page=[];bytes=0;}page.push(row);bytes+=size;}
      if(page.length>0)await storePage(page);
      return {total:rows.length,parts};
    };
    const scoped:KnowledgeViewScope={note:'清单是这些根生产时使用或列出的来源观察，依生产器与槽位区分用途；仅核对列明范围，不代表系统内全部文档。不分版本根的条目按本次锁定范围合并，并分别标注来源',roots:rawScope.roots,additional_roots:rawScope.additional_roots,additional_roots_declared:rawScope.additional_roots_declared,complete:rawScope.pending.length===0,
      not_in_roots:await scopeCollection(rawScope.not_in_roots),listed_documents:await scopeCollection(rawScope.listed),elsewhere_documents:await scopeCollection(rawScope.elsewhere),omitted_documents:rawScope.omitted===null?null:await scopeCollection(rawScope.omitted),pending_documents:await scopeCollection(rawScope.pending),missing_optional_sources:await scopeCollection(rawScope.optional),unplaced_entries:rawScope.unplaced_entries,...(rawScope.unplaced_cases?{unplaced_cases:rawScope.unplaced_cases}:{})};
    if(rawScope.pending.length>0){
      const action='管理员配置本产品额外根及其组成清单，确认这些来源是否已在其他范围；配置后重读，下一轮同步仍会重试来源';
      const question=await requestKnowledgeFact(this.#context,{kind:'clarification',subject:`知识范围核对 ${sha256Hex(canonicalize(rawScope.roots))}`,missing:'缺少额外根覆盖清单，不能确定这些未入当前根的来源是否已由其他根覆盖',action,inputs});
      scoped.request={...question,action};
    }
    reserve=Math.max(VIEW_MARGIN,canonicalBytes(scoped).byteLength+16*1024);
    key=canonicalize({query:key,scope:sha256Hex(canonicalBytes(scoped))});
    const credentialRefusal=async(held:SourceArtifact,references:string[]):Promise<ExternalRead>=>{
      const excluded=[...new Set([...inputs,...references])];
      const refs=await keepProblemRows(this.#context,excluded,inputs);
      const action='管理员按完整引用清单核对来源，修正源头或显式受理已确认的示例后重读视图';
      const request=await requestKnowledgeFact(this.#context,{kind:'clarification',subject:`视图凭据核对 ${held.body.sha256}`,missing:'视图最后一步仍有未受理凭据命中，未交付这份视图',action,inputs:refs.map(ref=>`rec:${ref.record}`)});
      return {ok:false,id:bare,reason:`视图 ${held.body.sha256} 有未受理凭据命中，不交给任务包。被排除引用前 ${Math.min(10,excluded.length)} 个：${excluded.slice(0,10).join('、')}；共 ${excluded.length} 个，完整清单：${refs.map(ref=>`rec:${ref.record}`).join('、')}。管理员 ${request.audience_user} 的核对请求 ${request.reference}，期限 ${request.deadline}；${action}`};
    };
    const tooLarge = (bytes: Uint8Array): string | null => (bytes.byteLength > this.#context.limits.maxViewBytes ? `视图有 ${bytes.byteLength} 字节，超过 ${this.#context.limits.maxViewBytes} 字节` : null);
    const cached = this.#cache.get(key);
    let originalBytes: Uint8Array | undefined;
    let view: ImpactView | FacetView | IndexView;
    if (cached === undefined) {
      view = await compute(new Set());
      const encoded = view.schema === 'index-view@1' ? this.#encodedIndexes.get(view) : undefined;
      if (encoded && view.schema === 'index-view@1') {
        // Keep the unfiltered encoded answer, never scanner decisions or a decoded graph of the root.
        const cachedView = { ...view, notes: [...view.notes] };
        this.#cache.set(key, { view: cachedView, entries: encoded });
        const complete = this.#completeIndexes.get(view); if (complete) this.#completeIndexes.set(cachedView, complete);
      } else {
        originalBytes = this.#bytes(view);
        const large = tooLarge(originalBytes); if (large !== null) return { ok: false, id: bare, reason: large };
      this.#cache.set(key,originalBytes);
      }
    } else if (cached instanceof Uint8Array) {
      originalBytes = cached;
      view = JSON.parse(Buffer.from(cached).toString('utf8')) as ImpactView | FacetView | IndexView;
    } else {
      view = { ...cached.view, notes: [...cached.view.notes] }; this.#encodedIndexes.set(view, cached.entries);
      const complete = this.#completeIndexes.get(cached.view); if (complete) this.#completeIndexes.set(view, complete);
    }
    const encoded = view.schema === 'index-view@1' ? this.#encodedIndexes.get(view) : undefined;
    const flagged = flaggedParts(view, coverage, part => part instanceof Uint8Array ? part : this.#entryBytes.get(part as ViewEntry) ?? canonicalBytes(part), encoded);
    const originalReferences=view.schema==='facet-view@1'?[]:Object.values(view.entries).map(entry=>entry.reference);
    if(request.after&&flagged.excluded.size>0)return credentialRefusal(await ingest(originalBytes ?? this.#bytes(view)),originalReferences);
    let indexExcludedEntries = 0;
    if (flagged.excluded.size > 0) {
      if (view.schema === 'index-view@1') indexExcludedEntries = flagged.excluded.size;
      view = await compute(flagged.excluded);
    }
    const annotate = (value: ImpactView | FacetView | IndexView, covered: number, limited: number, fallback = 0): void => {
      const unit = value.schema === 'facet-view@1' ? '计数行' : '条目';
      if (covered > 0) value.notes.push(`有 ${covered} 个${unit}的凭据命中由来源的受理覆盖；每次读取重新核对受理仍有效`);
      if (limited > 0) value.notes.push(`有 ${limited} 个${unit}因整份扫描的命中上限没有留下；截断扫描不能被覆盖`);
      if (fallback > 0) value.notes.push(`有 ${fallback} 个${unit}原已由来源的受理覆盖，因整份入库扫描仍被截断，在回退时剔掉`);
    };
    if(flagged.excluded.size>0&&view.next){view.next=null;view.notes.push('本页有未受理凭据，先由管理员处理这些来源或用 only 收窄；处理后从首页重读，不沿偏移后的页继续');}
    view.scope=scoped;
    if(view.schema==='index-view@1'&&view.kind==='case'&&!scoped.complete)view.key_space_complete=false;
    const finalEncoded = view.schema === 'index-view@1' ? this.#encodedIndexes.get(view) : undefined;
    const finalKeys = finalEncoded ? new Set(finalEncoded.keys()) : partKeys(view);
    const covered = [...flagged.kept].filter(key => finalKeys.has(key)).length;
    annotate(view,covered,flagged.limited.size);
    if(view.next)view.next=continuationId(bare,view.next,revision);
    let bytes = this.#bytes(view);
    let large = tooLarge(bytes);
    if (large !== null) return {ok:false,id:bare,reason:large};
    let artifact = await ingest(bytes);
    // Keys or other surrounding content can add hits beyond the per-part budget.
    // Fall back once to the previous safe omission behavior, never scan every prefix.
    if (artifact.body.scan.truncated && flagged.eligible.size > 0) {
      if (view.schema === 'index-view@1') indexExcludedEntries = flagged.allHits.size;
      view = await compute(flagged.allHits);
      annotate(view,0,flagged.limited.size,covered);
      view.scope=scoped;
      if(view.schema==='index-view@1'&&view.kind==='case'&&!scoped.complete)view.key_space_complete=false;
      if(view.next)view.next=continuationId(bare,view.next,revision);
      bytes = this.#bytes(view);
      large = tooLarge(bytes);
      if (large !== null) return {ok:false,id:bare,reason:large};
      artifact = await ingest(bytes);
    }
    if (artifact.body.read_tier !== 'model_readable') {
      return credentialRefusal(artifact,originalReferences);
    }
    const meta = await this.#context.records.artifacts.ingest({
      bytes: canonicalBytes({ title, view: request.type, product, roots, revision,
        ...(view.schema === 'index-view@1' ? { index_excluded_entries: indexExcludedEntries, index_view_sha256: artifact.body.sha256 } : {}) }),
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

function flaggedParts(view: ImpactView | FacetView | IndexView, coverage: DerivedCoverage, encode: (part: unknown) => Uint8Array = canonicalBytes, encoded?: ReadonlyMap<string, Uint8Array>): { excluded: Set<string>; limited: Set<string>; eligible: Set<string>; kept: Set<string>; allHits: Set<string> ;} {
  const excluded = new Set<string>(), limited = new Set<string>(), eligible = new Set<string>(), kept = new Set<string>(), allHits = new Set<string>();
  const parts: Array<[string,unknown]> = view.schema === 'facet-view@1'
    ? view.rows.map(row => [canonicalize(view.by.map(field => row.values[field] ?? null)),row])
    : encoded ? [...encoded] : Object.entries(view.entries);
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
    const assessment = coverage.assess(encode(value));
    const associated = memberships.get(key) ?? [];
    const hitKeys = associated.filter(k => keys.get(k)!.scan.findings.length > 0);
    if (!assessment.scan.findings.length && !hitKeys.length) continue;
    allHits.add(key);
    if (assessment.scan.findings.length > 0 && !assessment.derived || hitKeys.some(k => !keys.get(k)!.derived)) { excluded.add(key); continue; }
    eligible.add(key);
    const cost = assessment.scan.findings.length + hitKeys.filter(k => !charged.has(k)).reduce((n,k) => n+keys.get(k)!.scan.findings.length,0);
    if (full || findings + cost > MAX_ADMIN_FINDINGS) { full=true; excluded.add(key); limited.add(key); continue; }
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
