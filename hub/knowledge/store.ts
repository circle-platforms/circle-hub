// Record I/O of the knowledge package over the records store: nodes and entries (tree_node), compositions and their parts
// (tree_root), current-root moves (root_pointer), builds, calibration sets and layers (claim), and its own actions (loads
// of list sources, memoized producer calls, productions, plan rounds, judgments). Read payloads are memoized within one
// operation only. Immutable addressing permits reuse during that operation, not permanent retention in the service.
import { KNOWLEDGE_CONTRIBUTION_SCHEMA, KnowledgeContributionBody } from '../../contracts/src/contributions.ts';
import { z } from 'zod';
import {
  CompositionContentRow,
  KnowledgeBuildBody,
  KnowledgeCalibrationBody,
  KnowledgeEntryBody,
  KnowledgeObservationBody,
  RecordedBuild,
  RootPointerBody,
  TreeNodeBody,
  TreeRootBody,
  TreeRootRowsPart,
  TreeRootSourcesPart,
  TreeRootUnplacedPart,
  schemas as KNOWLEDGE_SCHEMAS,
} from '../../contracts/src/knowledge.ts';
import type { BuildInfo } from '../../contracts/src/product.ts';
import { ReasonSchema } from '../../contracts/generated/vocabulary.ts';
import type { ActionKind, ProvenanceType } from '../../contracts/generated/vocabulary.ts';
import type { RecordKind } from '../../contracts/generated/protocol.ts';
import { IntegrityError, RECORD_SCHEMAS, canonicalize, createCanonicalEncoder, sha256Hex } from '../records/api.ts';
import type { ActionBody, FindQuery, IndexEntry, RecordStore, StoredRecord, Transaction } from '../records/api.ts';
import { cutText, entryDigest, entryCanonical, nodeDigest, type EntryContent } from './digest.ts';
import { KnowledgeError } from './errors.ts';
import { currentReadCache } from './read-cache.ts';
import { visitRowsPart } from './rows-stream.ts';
import type { BuiltNode } from './tree.ts';

/** Schemas of the record bodies this package writes. Actions use the records package's action@1. */
export const SCHEMAS = {
  node: 'tree_node@1',
  entry: 'knowledge-entry@1',
  root: 'tree_root@1',
  rowsPart: 'tree_root-rows@1',
  unplacedPart: 'tree_root-unplaced@1',
  sourcesPart: 'tree_root-sources@1',
  pointer: 'root_pointer@1',
  build: 'knowledge-build@1',
  calibration: 'knowledge-calibration@1',
  observation: 'knowledge-observation@1',
  contribution: KNOWLEDGE_CONTRIBUTION_SCHEMA,
  action: RECORD_SCHEMAS.action,
} as const;

/** The part schemas of a large composition and their shapes. */
export const PART_SHAPES = {
  [SCHEMAS.rowsPart]: TreeRootRowsPart,
  [SCHEMAS.unplacedPart]: TreeRootUnplacedPart,
  [SCHEMAS.sourcesPart]: TreeRootSourcesPart,
} as const;
export type PartSchema = keyof typeof PART_SHAPES;
export type PartBody<S extends PartSchema> = z.infer<(typeof PART_SHAPES)[S]>;

// The pinned Zod version exposes a public compiled parser. It clones outputs and falls back to the original parser
// for unsupported paths or invalid inputs, preserving the schema's transformations and error behavior.
const CONTENT_ROW_READER = z.compile(CompositionContentRow);
const ENTRY_READER = z.compile(KnowledgeEntryBody);
const ROOT_READER = z.compile(TreeRootBody);
const PART_READERS = {
  [SCHEMAS.rowsPart]: z.compile(TreeRootRowsPart),
  [SCHEMAS.unplacedPart]: z.compile(TreeRootUnplacedPart),
  [SCHEMAS.sourcesPart]: z.compile(TreeRootSourcesPart),
} as const;

/** The indexed key of a contradiction relation between two claims (B01 R[2]): a claim record whose body says
 * relation: 'contradicts' and the other claim's tree address. The candidate layer (another terminal) proposes these;
 * a deterministic rule may too. Reading computes the flag, never adjudicates (K-direction §5). */
export const CONTRADICTION = 'knowledge.claim.contradiction';

/** Index keys this package writes (all under `knowledge.`, plus the records package's `action.kind`). */
export const INDEX = {
  node: 'knowledge.node',
  entry: 'knowledge.entry',
  entryProduct: 'knowledge.entry.product',
  root: 'knowledge.root',
  rootBuild: 'knowledge.root.build',
  rootProduct: 'knowledge.root.product',
  produce: 'knowledge.produce',
  produceScope: 'knowledge.produce.scope',
  produceRoot: 'knowledge.produce.root',
  produceProduct: 'knowledge.produce.product',
  sync: 'knowledge.sync',
  contradiction: CONTRADICTION,
  buildFailure: 'knowledge.build.failure',
  buildFailureName: 'knowledge.build.failure.name',
  buildFailureRoot: 'knowledge.build.failure.root',
  build: 'knowledge.build',
  buildProduct: 'knowledge.build.product',
  buildBase: 'knowledge.build.base',
  pointer: 'knowledge.pointer',
  pointerMove: 'knowledge.pointer.move',
  seedling: 'knowledge.seedling',
  seedlingRoot: 'knowledge.seedling.root',
  reuse: 'knowledge.jev.reuse',
  judgmentInput: 'knowledge.jev.input',
  calibration: 'knowledge.calibration',
  observation: 'knowledge.observation.product',
  contribution: 'knowledge.contribution.product',
  /** A list source the knowledge package loaded: external id -> its read action. */
  read: 'knowledge.read',
  /** A producer call's stored output: memo key -> its generate action. */
  memo: 'knowledge.memo',
  /** A composition part: content key -> its record. */
  part: 'knowledge.part',
  actionKind: 'action.kind',
} as const;

/** Components that write this package's actions (component@version, B05 F[3]). */
export const COMPONENTS = {
  produce: 'knowledge.produce@1',
  sync: 'knowledge.sync@1',
  placement: 'knowledge.placement@1',
  calibration: 'knowledge.calibration@1',
  /** One producer call of a list slot's batch (memoized). */
  producer: 'knowledge.producer@1',
  /** The loads of list sources (reused while younger than max_age_seconds). */
  sources: 'knowledge.sources@1',
  /** The knowledge views served as external objects. */
  views: 'knowledge.views@1',
} as const;

/** The action kinds (B05 F[0]) this package records; checked against the generated vocabulary at compile time. */
export const ACTION = { parse: 'parse', generate: 'generate', classify: 'classify', read: 'read' } as const satisfies Partial<Record<ActionKind, ActionKind>>;

/** Build names compare without case for lookups (NFC, lower case); the stored name keeps its spelling. */
export function fold(name: string): string {
  return name.normalize('NFC').toLowerCase();
}

/** Key of a product's build or base in the index. */
export function buildKey(product: string, name: string): string {
  return `${product}/${fold(name)}`;
}

/** The records rule for an index value (hub/records api.ts IndexEntry): at most 1000 bytes of UTF-8, well-formed, no NUL. */
export const MAX_INDEX_VALUE_BYTES = 1000;

export function indexValueFits(value: string): boolean {
  return value.isWellFormed() && !value.includes('\u0000') && Buffer.byteLength(value, 'utf8') <= MAX_INDEX_VALUE_BYTES;
}

const storable = (text: string): boolean => text.isWellFormed() && !text.includes('\u0000');

/**
 * Why a listed build cannot be recorded, or null: its name and base must fit the build index, its other text must be
 * storable and its line must make a current-root pointer name. Checked before anything of the build is written.
 */
export function buildProblem(product: string, build: BuildInfo): string | null {
  for (const [what, name] of [
    ['构建名', build.name],
    ['基础构建名', build.base],
  ] as const) {
    if (!indexValueFits(buildKey(product, name))) {
      return `${what} ${JSON.stringify(cutText(name, 60))} 记不下：要是规范的 Unicode、不含 NUL，加上产品名不超过 ${MAX_INDEX_VALUE_BYTES} 字节（现在 ${Buffer.byteLength(buildKey(product, name), 'utf8')} 字节）`;
    }
  }
  const texts = [build.family, build.line, build.platform ?? '', ...Object.keys(build.sources), ...Object.values(build.sources).flat()];
  if (!texts.every(storable)) return '构建信息里有不能保存的文字（不成对的代理字符或 NUL）';
  try {
    pointerName(product, build.line);
  } catch (error) {
    if (error instanceof KnowledgeError) return error.message;
    throw error;
  }
  return null;
}

// ---------------------------------------------------------------- the forms a build is kept in

/** Roles of a build that hold a list (an array of ids as listed, a reference as recorded), sorted. */
export function listRoles(build: { sources: Record<string, unknown> }): string[] {
  return Object.keys(build.sources)
    .filter((role) => typeof build.sources[role] !== 'string')
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** A build with single roles only, as a build record keeps it. */
export type ClaimBuild = KnowledgeBuildBody['build'];

/** A build without its list roles: what a build claim keeps and what the port's reads return (README decision 10). */
export function withoutLists(build: BuildInfo | RecordedBuild): ClaimBuild {
  const sources: Record<string, string> = {};
  for (const [role, source] of Object.entries(build.sources)) if (typeof source === 'string') sources[role] = source;
  return { name: build.name, family: build.family, line: build.line, base: build.base, platform: build.platform, built_at: build.built_at, released_at: build.released_at, sources };
}

/** One listed role's ids as listed, with the digest of their canonical JSON array (the object that holds them). */
export interface ListedIds {
  role: string;
  list: string;
  ids: string[];
}

/** The build as a production records it: every list role by reference ({list, count}), and the lists to keep as objects. */
export function recordedOf(build: BuildInfo): { build: RecordedBuild; lists: ListedIds[] } {
  const sources: RecordedBuild['sources'] = {};
  const lists: ListedIds[] = [];
  for (const [role, source] of Object.entries(build.sources)) {
    if (typeof source === 'string') {
      sources[role] = source;
      continue;
    }
    const list = sha256Hex(canonicalize(source));
    sources[role] = { list, count: source.length };
    lists.push({ role, list, ids: [...source] });
  }
  return { build: { ...withoutLists(build), sources }, lists };
}

/** Pointer name of the current root of a product line@version: the line's UTF-8 bytes outside [a-z0-9._-] are written :hh. */
export function pointerName(product: string, line: string | null): string {
  if (line === null) return `knowledge/${product}`;
  let encoded = '';
  for (const byte of Buffer.from(line.normalize('NFC'), 'utf8')) {
    const ch = String.fromCharCode(byte);
    encoded += /[a-z0-9._-]/.test(ch) ? ch : `:${byte.toString(16).padStart(2, '0')}`;
  }
  const name = `knowledge/${product}/${encoded}`;
  if (name.length > 200) throw new KnowledgeError(`版本线 ${cutText(line, 50)} 太长，当前根指针写不下`);
  return name;
}

/** A body parsed with its registered schema before it is written: what is written can always be read back. */
function checked<B>(schema: string, body: B): B {
  const shape = KNOWLEDGE_SCHEMAS[schema];
  if (shape === undefined) throw new KnowledgeError(`没有登记的模式 ${schema}`);
  const parsed = shape.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new KnowledgeError(`要写的记录不符合 ${schema}：${issue === undefined ? '' : cutText(`${issue.path.join('/')} ${issue.message}`, 300)}`);
  }
  return body;
}

/**
 * A bounded map that forgets the least recently used entry: at most `max` entries and, when a weight is given, at most
 * `maxWeight` in total (an entry heavier than that alone is not kept).
 */
export class Lru<K, V> {
  readonly #max:number;
  readonly #maxWeight:number;
  readonly #operationOnly:boolean;
  readonly #persistent={map:new Map<K,{value:V;weight:number}>(),weight:0};
  constructor(max:number,maxWeight=Number.POSITIVE_INFINITY,operationOnly=false){
    this.#max=Math.max(1,max);this.#maxWeight=maxWeight;this.#operationOnly=operationOnly;
  }
  #state():{map:Map<K,{value:V;weight:number}>;weight:number}|undefined {
    if(!this.#operationOnly)return this.#persistent;
    const scope=currentReadCache();if(!scope||scope.closed)return undefined;
    let state=scope.states.get(this);
    if(!state){state={map:new Map(),weight:0};scope.states.set(this,state);}
    return state as {map:Map<K,{value:V;weight:number}>;weight:number};
  }
  get size():number{return this.#state()?.map.size??0;}
  get weight():number{return this.#state()?.weight??0;}
  get(key:K):V|undefined {
    const state=this.#state(),held=state?.map.get(key);
    if(held!==undefined){state!.map.delete(key);state!.map.set(key,held);}
    return held?.value;
  }
  set(key:K,value:V,weight=0):void {
    const state=this.#state();if(!state)return;
    this.delete(key);if(weight>this.#maxWeight)return;
    state.map.set(key,{value,weight});state.weight+=weight;
    while(state.map.size>this.#max||state.weight>this.#maxWeight){const oldest=state.map.keys().next().value as K;this.delete(oldest);}
  }
  delete(key:K):void {const state=this.#state(),held=state?.map.get(key);if(held===undefined)return;state!.weight-=held.weight;state!.map.delete(key);}
}

/** Most skipped external ids of one list a generate action keeps, so that the next sync can try them again. */
export const MAX_KEPT_SKIPPED_IDS = 50;

/** One list slot of a production, summarised: the full rows are in the composition (sources and skipped). */
export const ListDetail = z.object({
  producer: z.string(),
  slot: z.string(),
  /** External ids listed (repeats dropped). */
  count: z.number(),
  /** SHA-256 of the canonical JSON of the listed ids in order. */
  externals: z.string(),
  /** SHA-256 of the canonical JSON of the [external, sha256] pairs that were used, in order. */
  loaded: z.string(),
  /**
   * SHA-256 of the canonical JSON of the [external, sha256] pairs of every listed object that was read, in order, whether or
   * not it could then be checked, parsed or used: what a recheck compares (absent in records of earlier versions).
   */
  read: z.string().optional(),
  /** Skipped ids (first 50); `retry` when a later load may succeed (the object could not be read, checked or parsed). */
  skipped: z.array(z.object({ external: z.string(), reason: z.string(), retry: z.boolean(), reason_code:ReasonSchema.optional() })),
  skipped_count: z.number(),
});
export type ListDetail = z.infer<typeof ListDetail>;

/** The detail of a generate action: one production of a root, or its failure. Read loosely: later versions may add fields. */
export const ProduceDetail = z.object({
  sync: z.string().nullable(),
  product: z.string(),
  pack: z.object({ id: z.string(), version: z.string(), digest: z.string() }),
  /** The build as listed, its list roles by reference (the ids are an object). */
  build: RecordedBuild.nullable(),
  root: z.string().nullable(),
  composition: z.string().nullable(),
  /** The sources of single slots (list sources are summarised in `lists`). */
  sources: z.array(z.object({ producer: z.string(), slot: z.string(), external: z.string(), sha256: z.string() })),
  /** Optional sources that could not be read for this production. */
  missing: z.array(z.object({ producer: z.string(), slot: z.string(), external: z.string().nullable(), observation:z.unknown().optional(), conclusion:z.string().optional() })).default([]),
  lists: z.array(ListDetail).default([]),
  /** Producer calls made and calls answered from stored outputs. */
  calls: z.object({ made: z.number(), reused: z.number() }).nullable().default(null),
  /** The typed-judgment placement the root depends on: model, threshold, spans placed or not, judge failures, skipped entries per producer. */
  placement: z
    .object({
      model: z.string().nullable(),
      threshold: z.number().nullable(),
      spans: z.number(),
      failed: z.number(),
      skipped: z.record(z.string(), z.number()).optional(),
    })
    .nullable()
    .default(null),
  listing_digest:z.string().optional(),
  source_failures:z.array(z.object({external:z.string(),code:z.string(),status:z.number().nullable(),at:z.string(),manifest:z.string(),system_pack:z.string(),resource:z.string()})).optional(),
  problem_chunks:z.object({warnings:z.array(z.object({record:z.string(),sha256:z.string(),rows:z.number()})),refused:z.array(z.object({record:z.string(),sha256:z.string(),rows:z.number()})),skipped:z.array(z.object({record:z.string(),sha256:z.string(),rows:z.number()}))}).optional(),
  reason: z.string().nullable(),
});
export type ProduceDetail = z.infer<typeof ProduceDetail>;

/** The detail of a read action of a list source: which stored record the load used. */
export const ReadDetail = z.object({
  external: z.string(),
  revision: z.string().nullable(),
  /** Digest of the source_artifact record the connector read returned. */
  artifact: z.string(),
  sha256: z.string(),
  size: z.number(),
  media_type: z.string(),
});
export type ReadDetail = z.infer<typeof ReadDetail>;

/** The detail of a generate action of one producer call: the memo key and the stored output object. */
export const MemoDetail = z.object({
  key: z.string(),
  product: z.string(),
  pack: z.object({ id: z.string(), version: z.string(), digest: z.string() }),
  producer: z.string(),
  batch: z.object({ index: z.number(), of: z.number() }),
  elements: z.number(),
  output: z.object({ sha256: z.string(), size: z.number(), entries: z.number(), unplaced: z.number(), warnings: z.number() }),
});
export type MemoDetail = z.infer<typeof MemoDetail>;

/**
 * The detail of a generate action (result error) of one producer call that failed in a way a smaller call could avoid
 * (README decision 19): the same function on the same input fails the same way under the same sandbox limits, so the failure
 * is used again while the producer limits are `limits`.
 */
export const MemoFailureDetail = z.object({
  key: z.string(),
  product: z.string(),
  pack: z.object({ id: z.string(), version: z.string(), digest: z.string() }),
  producer: z.string(),
  batch: z.object({ index: z.number(), of: z.number() }),
  elements: z.number(),
  failure: z.object({ reason: z.string(), reason_code:ReasonSchema.optional(), limits: z.record(z.string(), z.unknown()) }),
});
export type MemoFailureDetail = z.infer<typeof MemoFailureDetail>;

/** The newest stored outcome of a producer call under a memo key. */
export type MemoOutcome = { ok: true; detail: MemoDetail } | { ok: false; detail: MemoFailureDetail };

export interface ProduceAction {
  record: StoredRecord<ActionBody>;
  detail: ProduceDetail;
  completed: boolean;
}

export interface StoredBuild {
  record: StoredRecord<KnowledgeBuildBody>;
  body: KnowledgeBuildBody;
}

const PAGE = 500;

declare const rowsReadBrand: unique symbol;
export interface RowsReadHandle { readonly [rowsReadBrand]: true ;}

export class KnowledgeStore {
  readonly records: RecordStore;
  readonly #rowsReads = new WeakMap<RowsReadHandle, Set<string>>();
  readonly #nodes: Lru<string, TreeNodeBody>;
  readonly #entries: Lru<string, EntryContent>;
  readonly #compositions: Lru<string, TreeRootBody>;
  /** Parts read by path lookups, bounded in count and in bytes of their JSON text (default 48 and 64 MiB). */
  readonly #parts: Lru<string, unknown>;
  /** Part content keys seen in this process -> the record holding that content. */
  readonly #partKeys = new Lru<string, string>(20_000);

  constructor(records: RecordStore, options: { nodes?: number; entries?: number; entryBytes?:number; compositions?: number; parts?: number; partBytes?: number } = {}) {
    this.records = records;
    this.#nodes = new Lru(options.nodes ?? 50_000,Number.POSITIVE_INFINITY,true);
    this.#entries = new Lru(options.entries ?? 50_000,options.entryBytes??8*1024*1024,true);
    this.#compositions = new Lru(options.compositions ?? 8,Number.POSITIVE_INFINITY,true);
    this.#parts = new Lru(options.parts ?? 48, options.partBytes ?? 64 * 1024 * 1024,true);
  }

  /** Logical cache weights, not a claim about resident process memory. */
  get cachedEntries():{entries:number;bytes:number}{return {entries:this.#entries.size,bytes:this.#entries.weight};}

  /** Parts held by the cache and the bytes of their JSON text (for tests and the console). */
  get cachedParts(): { parts: number; bytes: number } {
    return { parts: this.#parts.size, bytes: this.#parts.weight };
  }

  // ------------------------------------------------------------ generic

  /** Every record of an index value, oldest first. */
  async all<B>(query: Omit<FindQuery, 'cursor' | 'limit' | 'newestFirst'>, tx?: Transaction): Promise<StoredRecord<B>[]> {
    const out: StoredRecord<B>[] = [];
    let cursor: string | null = null;
    do {
      const page: { items: StoredRecord<B>[]; next: string | null } = await this.records.find<B>({ ...query, limit: PAGE, cursor }, tx);
      out.push(...page.items);
      cursor = page.next;
    } while (cursor !== null);
    return out;
  }

  /** Records of an index value, newest first, until `accept` returns true for one (or the index ends); the first page holds `first`. */
  async newest<B>(query: Omit<FindQuery, 'cursor' | 'limit' | 'newestFirst'>, accept: (record: StoredRecord<B>) => boolean = () => true, tx?: Transaction, first = 50): Promise<StoredRecord<B> | null> {
    let cursor: string | null = null;
    let limit = first;
    do {
      const page: { items: StoredRecord<B>[]; next: string | null } = await this.records.find<B>({ ...query, limit, cursor, newestFirst: true }, tx);
      for (const record of page.items) if (accept(record)) return record;
      cursor = page.next;
      limit = 50;
    } while (cursor !== null);
    return null;
  }

  async exists(key: string, value: string, kind: RecordKind, tx?: Transaction): Promise<boolean> {
    const page = await this.records.find({ key, value, kind, limit: 1 }, tx);
    return page.items.length > 0;
  }

  async putAction(body: ActionBody, index: IndexEntry[], tx?: Transaction): Promise<StoredRecord<ActionBody>> {
    return this.records.put<ActionBody>(
      { kind: 'action', schema: SCHEMAS.action, provenance: 'observed', body, index: [{ key: INDEX.actionKind, value: body.action }, ...index] },
      tx,
    );
  }

  // ------------------------------------------------------------ nodes

  hasNode(digest: string, tx?: Transaction): Promise<boolean> {
    return this.exists(INDEX.node, digest, 'tree_node', tx);
  }

  /** Written inside the production's transaction; the read cache is filled only by reads, after the commit. */
  async putNode(node: BuiltNode, tx: Transaction): Promise<void> {
    const body = checked<TreeNodeBody>(SCHEMAS.node, { name: node.name, height: node.height, level: node.level, children: node.children, entries: node.entries });
    await this.records.put({ kind: 'tree_node', schema: SCHEMAS.node, provenance: 'projected', body, index: [{ key: INDEX.node, value: node.digest }] }, tx);
  }

  /** The node behind a digest, verified, or null when no record holds it. */
  async node(digest: string, tx?: Transaction): Promise<TreeNodeBody | null> {
    const cached = this.#nodes.get(digest);
    if (cached !== undefined) return cached;
    const page = await this.records.find<unknown>({ key: INDEX.node, value: digest, kind: 'tree_node', limit: 1 }, tx);
    const record = page.items[0];
    if (record === undefined) return null;
    const body = TreeNodeBody.safeParse(record.body);
    if (!body.success || record.schema !== SCHEMAS.node || nodeDigest(body.data) !== digest) {
      throw new IntegrityError('知识树节点记录与它的摘要不符', { detail: { node: digest, record: record.digest } });
    }
    this.#nodes.set(digest, body.data);
    return body.data;
  }

  // ------------------------------------------------------------ entries

  hasEntryFor(product: string, digest: string, tx?: Transaction): Promise<boolean> {
    return this.exists(INDEX.entryProduct, `${product}/${digest}`, 'tree_node', tx);
  }

  async putEntry(product: string, digest: string, content: EntryContent, tx: Transaction): Promise<void> {
    const body = checked<KnowledgeEntryBody>(SCHEMAS.entry, { product, kind: content.kind as KnowledgeEntryBody['kind'], statement: content.statement, data: content.data, applicability: content.applicability });
    if (entryDigest(body) !== digest) throw new KnowledgeError(`要写的条目与它的摘要 ${digest} 不符`);
    await this.records.put(
      {
        kind: 'tree_node',
        schema: SCHEMAS.entry,
        provenance: 'projected',
        body,
        index: [
          { key: INDEX.entry, value: digest },
          { key: INDEX.entryProduct, value: `${product}/${digest}` },
        ],
      },
      tx,
    );
  }

  #verifiedEntry(record: StoredRecord<unknown>, digest: string,encoder=createCanonicalEncoder()): {body:KnowledgeEntryBody;weight:number} {
    const body = ENTRY_READER.safeParse(record.body);
    const serialized=body.success?entryCanonical(body.data,encoder.text):null;
    if (!body.success || record.schema !== SCHEMAS.entry || sha256Hex(serialized!) !== digest) {
      throw new IntegrityError('知识条目记录与它的摘要不符', { detail: { entry: digest, record: record.digest } });
    }
    return {body:body.data,weight:256+serialized!.length*2};
  }

  /** The content behind an entry digest, verified, or null. */
  async entry(digest: string, tx?: Transaction): Promise<EntryContent | null> {
    const cached = this.#entries.get(digest);
    if (cached !== undefined) return cached;
    const page = await this.records.find<unknown>({ key: INDEX.entry, value: digest, kind: 'tree_node', limit: 1 }, tx);
    const record = page.items[0];
    if (record === undefined) return null;
    const {body,weight} = this.#verifiedEntry(record, digest);
    const content: EntryContent = { kind: body.kind, statement: body.statement, data: body.data, applicability: body.applicability };
    this.#entries.set(digest, content,weight);
    return content;
  }

  /** Bounded batch of entry contents; keep the same oldest record and verify its requested entry digest. */
  async entries(digests: readonly string[], tx?: Transaction,options:{cache?:boolean}={}): Promise<Map<string, EntryContent>> {
    const out = new Map<string, EntryContent>();
    const encoder=createCanonicalEncoder();
    const missing: string[] = [];
    for (const digest of new Set(digests)) { const cached = this.#entries.get(digest); if (cached !== undefined) out.set(digest, cached); else missing.push(digest); }
    for (let i = 0; i < missing.length; i += 256) {
      const found = await this.records.findFirstMany<unknown>({ key: INDEX.entry, values: missing.slice(i, i + 256), kind: 'tree_node' }, tx);
      for (const [digest, record] of found) {
        const {body,weight} = this.#verifiedEntry(record, digest,encoder);
        const content: EntryContent = { kind: body.kind, statement: body.statement, data: body.data, applicability: body.applicability };
        out.set(digest, content); if(options.cache!==false)this.#entries.set(digest, content,weight);
      }
    }
    return out;
  }

  /** Products an entry was produced for. */
  async entryProducts(digest: string): Promise<string[]> {
    const records = await this.all<unknown>({ key: INDEX.entry, value: digest, kind: 'tree_node' });
    return [...new Set(records.map((record) => this.#verifiedEntry(record, digest).body.product))];
  }

  // ------------------------------------------------------------ compositions and productions

  async putRoot(body: TreeRootBody, tx: Transaction): Promise<StoredRecord<TreeRootBody>> {
    const record = await this.records.put<TreeRootBody>(
      {
        kind: 'tree_root',
        schema: SCHEMAS.root,
        provenance: 'projected',
        body: checked(SCHEMAS.root, body),
        index: [
          { key: INDEX.root, value: body.root },
          ...(body.build === null ? [] : [{ key: INDEX.rootBuild, value: buildKey(body.product, body.build.name) }]),
          { key: INDEX.rootProduct, value: body.product },
        ],
      },
      tx,
    );
    return record;
  }

  /** The composition record with this record digest, verified against its schema. */
  async composition(recordDigest: string): Promise<TreeRootBody | null> {
    const cached = this.#compositions.get(recordDigest);
    if (cached !== undefined) return cached;
    const record = await this.records.get<unknown>(recordDigest);
    if (record === null || record.kind !== 'tree_root' || record.schema !== SCHEMAS.root) return null;
    const body = ROOT_READER.safeParse(record.body);
    if (!body.success) throw new IntegrityError('知识树组成记录不符合 tree_root@1', { detail: { record: recordDigest } });
    this.#compositions.set(recordDigest, body.data);
    return body.data;
  }

  /**
   * Stores one part of a large composition in its own transaction, or finds the record that already holds the same content
   * (parts are shared between roots by content). Returns the record digest.
   */
  async putPart<S extends PartSchema>(schema: S, rows: PartBody<S>['rows']): Promise<{ digest: string; created: boolean }> {
    const body = checked(schema, { rows });
    const key = sha256Hex(canonicalize({ schema, body }));
    const known = this.#partKeys.get(key);
    if (known !== undefined) return { digest: known, created: false };
    const page = await this.records.find<unknown>({ key: INDEX.part, value: key, kind: 'tree_root', limit: 1 });
    const existing = page.items[0];
    if (existing !== undefined && existing.schema === schema) {
      this.#partKeys.set(key, existing.digest);
      return { digest: existing.digest, created: false };
    }
    // Committed before it is remembered: a remembered key always names a stored record.
    const record = await this.records.put({ kind: 'tree_root', schema, provenance: 'projected', body, index: [{ key: INDEX.part, value: key }] });
    this.#partKeys.set(key, record.digest);
    return { digest: record.digest, created: true };
  }

  /** A part record, verified against its schema; null when absent. `cache: false` reads it without keeping it (scans). */
  /** Verified bytes, then one schema-checked composition row at a time. No part graph is cached by a scan. */
  rowsRead(): RowsReadHandle {
    const handle = Object.freeze({}) as RowsReadHandle; this.#rowsReads.set(handle, new Set()); return handle;
  }

  async forEachRowsPart(digest: string, consume: (row: CompositionContentRow) => void): Promise<void> {
    return this.forEachRowsParts([digest], consume);
  }

  async forEachRowsParts(digests: readonly string[], consume: (row: CompositionContentRow) => void, read?: RowsReadHandle): Promise<void> {
    const validated = read === undefined ? undefined : this.#rowsReads.get(read);
    if (read !== undefined && validated === undefined) throw new TypeError('行读取凭据不属于此知识存储');
    const records = await this.records.getTexts(digests);
    for (const digest of digests) {
      const record = records.get(digest);
      if (record === undefined) throw new Error(`composition part ${digest} is missing`);
      if (record.kind !== 'tree_root' || record.schema !== SCHEMAS.rowsPart) throw new IntegrityError('知识树组成的分段记录种类或模式不对', { detail: { record: digest, schema: SCHEMAS.rowsPart } });
      try {
        visitRowsPart(record.bodyText, value => {
          // JSON rows with no applicability/placement transformations need validation, not another deep clone.
          // Preserve Zod's record/prototype normalization and complex optional shapes through its ordinary parser.
          const raw = value as Partial<CompositionContentRow> | null;
          if (raw && raw.applicability === null && raw.applicability_sources === undefined && raw.placement === undefined &&
            !Object.hasOwn(raw, '__proto__') && raw.data && !Object.hasOwn(raw.data, '__proto__')) {
            if (!validated?.has(digest) && !CONTENT_ROW_READER.validate(raw)) throw new IntegrityError('知识树组成的分段行不符合合约', { detail: { record: digest } });
            consume(raw as CompositionContentRow);
          } else {
            const row = CONTENT_ROW_READER.safeParse(value);
            if (!row.success) throw new IntegrityError('知识树组成的分段行不符合合约', { detail: { record: digest } });
            consume(row.data);
          }
        });
      } catch (error) { if (error instanceof IntegrityError) throw error; throw new IntegrityError('知识树组成的分段记录不符合 tree_root-rows@1', { detail: { record: digest }, cause: error }); }
      validated?.add(digest); records.delete(digest);
    }
  }

  async part<S extends PartSchema>(schema: S, digest: string, options: { cache?: boolean } = {}): Promise<PartBody<S> | null> {
    const cacheKey = `${schema}\u0000${digest}`;
    const cached = this.#parts.get(cacheKey);
    if (cached !== undefined) return cached as PartBody<S>;
    const record = await this.records.get<unknown>(digest);
    if (record === null) return null;
    if (record.kind !== 'tree_root' || record.schema !== schema) throw new IntegrityError('知识树组成的分段记录种类或模式不对', { detail: { record: digest, schema } });
    const parsed = PART_READERS[schema].safeParse(record.body);
    if (!parsed.success) throw new IntegrityError(`知识树组成的分段记录不符合 ${schema}`, { detail: { record: digest } });
    // Weighed by the length of its JSON text, a stand-in for its size in memory.
    if (options.cache !== false) this.#parts.set(cacheKey, parsed.data, JSON.stringify(record.body).length);
    return parsed.data as PartBody<S>;
  }

  // ------------------------------------------------------------ list sources and producer calls

  /** Records that the knowledge package loaded a list source from this stored record (for reuse within max_age_seconds). */
  async putRead(detail: ReadDetail, startedAt: string, endedAt: string): Promise<void> {
    if (!indexValueFits(detail.external)) return;
    const body: ActionBody = {
      action: ACTION.read,
      run: null,
      item: null,
      inputs: [`src:${detail.sha256}`],
      component: COMPONENTS.sources,
      lease: null,
      started_at: startedAt,
      ended_at: endedAt,
      result: 'completed',
      error_code: null,
      acceptance: null,
      codes: [],
      detail: detail as unknown as Record<string, unknown>,
    };
    await this.putAction(body, [{ key: INDEX.read, value: detail.external }]);
  }

  /** The newest load of a list source, with the time it was read; null when none is recorded. */
  async latestRead(external: string): Promise<{ detail: ReadDetail; at: string } | null> {
    if (!indexValueFits(external)) return null;
    let found: { detail: ReadDetail; at: string } | null = null;
    await this.newest<ActionBody>({ key: INDEX.read, value: external, kind: 'action' }, (record) => {
      if (record.body.action !== ACTION.read || record.body.component !== COMPONENTS.sources || record.body.result !== 'completed') return false;
      const detail = ReadDetail.safeParse(record.body.detail);
      if (!detail.success || detail.data.external !== external) return false;
      found = { detail: detail.data, at: record.body.ended_at };
      return true;
    });
    return found;
  }

  /** The stored output of a producer call under this memo key, newest first; null when none. */
  async memo(key: string): Promise<MemoDetail | null> {
    const outcome = await this.memoOutcome(key);
    return outcome !== null && outcome.ok ? outcome.detail : null;
  }

  /** The newest stored outcome of a producer call under this memo key: its output, or how it failed; null when none. */
  async memoOutcome(key: string): Promise<MemoOutcome | null> {
    let found: MemoOutcome | null = null;
    await this.newest<ActionBody>({ key: INDEX.memo, value: key, kind: 'action' }, (record) => {
      if (record.body.action !== ACTION.generate || record.body.component !== COMPONENTS.producer) return false;
      if (record.body.result === 'completed') {
        const detail = MemoDetail.safeParse(record.body.detail);
        if (!detail.success || detail.data.key !== key) return false;
        found = { ok: true, detail: detail.data };
        return true;
      }
      if (record.body.result !== 'error') return false;
      const detail = MemoFailureDetail.safeParse(record.body.detail);
      if (!detail.success || detail.data.key !== key) return false;
      found = { ok: false, detail: detail.data };
      return true;
    });
    return found;
  }

  static produceOf(record: StoredRecord<ActionBody>): ProduceAction | null {
    if (record.kind !== 'action' || record.body.action !== ACTION.generate) return null;
    const detail = ProduceDetail.safeParse(record.body.detail);
    if (!detail.success) return null;
    return { record, detail: detail.data, completed: record.body.result === 'completed' && detail.data.root !== null && detail.data.composition !== null };
  }

  /** The newest completed production of a product's base build (exact name), or null. Reads a few records at first. */
  async latestProduction(product: string, base: string | null): Promise<ProduceAction | null> {
    let found: ProduceAction | null = null;
    await this.newest<ActionBody>(
      { key: base === null ? INDEX.produceScope : INDEX.produce, value: base === null ? product : buildKey(product, base), kind: 'action' },
      (record) => {
        const produced = KnowledgeStore.produceOf(record);
        if (produced === null || !produced.completed || produced.detail.product !== product || (produced.detail.build?.name ?? null) !== base) return false;
        found = produced;
        return true;
      },
      undefined,
      4,
    );
    return found;
  }

  /** Every production (completed or failed) of a product, oldest first. */
  async productions(product: string): Promise<ProduceAction[]> {
    const records = await this.all<ActionBody>({ key: INDEX.produceProduct, value: product, kind: 'action' });
    return records.map((record) => KnowledgeStore.produceOf(record)).filter((p): p is ProduceAction => p !== null && p.detail.product === product);
  }

  /** Completed productions that gave this root, oldest first. */
  async productionsOfRoot(root: string): Promise<ProduceAction[]> {
    const records = await this.all<ActionBody>({ key: INDEX.produceRoot, value: root, kind: 'action' });
    return records.map((record) => KnowledgeStore.produceOf(record)).filter((p): p is ProduceAction => p !== null && p.completed && p.detail.root === root);
  }

  // ------------------------------------------------------------ builds

  /** Failed observations, including builds for which no root could be produced. */
  async buildFailures(product: string, query: { name?: string; root?: string | null } = {}): Promise<StoredRecord<ActionBody>[]> {
    const key = query.name !== undefined ? INDEX.buildFailureName : query.root !== undefined ? INDEX.buildFailureRoot : INDEX.buildFailure;
    const value = query.name !== undefined ? `${product}/${fold(query.name)}` : query.root !== undefined ? `${product}/${query.root ?? 'none'}` : product;
    if (!indexValueFits(value)) return [];
    const rows = await this.all<ActionBody>({ key, value, kind: 'action' });
    return rows.filter(row => (row.body.component === COMPONENTS.sync || row.body.component === COMPONENTS.produce) && row.body.result === 'error' && row.body.detail.product === product
      && (query.name === undefined || fold(String((row.body.detail.build as BuildInfo)?.name)) === fold(query.name))
      && (query.root === undefined || row.body.detail.root === query.root || (query.root !== null && row.body.detail.previous_root === query.root)));
  }

  async putBuild(body: KnowledgeBuildBody, tx?: Transaction): Promise<StoredRecord<KnowledgeBuildBody>> {
    const problem = buildProblem(body.product, body.build);
    if (problem !== null) throw new KnowledgeError(problem);
    return this.records.put<KnowledgeBuildBody>(
      {
        kind: 'claim',
        schema: SCHEMAS.build,
        provenance: 'projected',
        body: checked(SCHEMAS.build, body),
        index: [
          { key: INDEX.build, value: buildKey(body.product, body.build.name) },
          { key: INDEX.buildProduct, value: body.product },
          { key: INDEX.buildBase, value: buildKey(body.product, body.build.base) },
        ],
      },
      tx,
    );
  }

  static buildOf(record: StoredRecord<unknown>): StoredBuild | null {
    if (record.kind !== 'claim' || record.schema !== SCHEMAS.build) return null;
    const body = KnowledgeBuildBody.safeParse(record.body);
    return body.success ? { record: record as StoredRecord<KnowledgeBuildBody>, body: body.data } : null;
  }

  /** Build records whose name folds to this one, oldest first. */
  async buildsNamed(product: string, name: string, tx?: Transaction): Promise<StoredBuild[]> {
    const records = await this.all<unknown>({ key: INDEX.build, value: buildKey(product, name), kind: 'claim' }, tx);
    return records.map((record) => KnowledgeStore.buildOf(record)).filter((b): b is StoredBuild => b !== null && b.body.product === product);
  }

  /** Every build record of a product, oldest first. */
  async buildsOf(product: string): Promise<StoredBuild[]> {
    const records = await this.all<unknown>({ key: INDEX.buildProduct, value: product, kind: 'claim' });
    return records.map((record) => KnowledgeStore.buildOf(record)).filter((b): b is StoredBuild => b !== null && b.body.product === product);
  }

  // ------------------------------------------------------------ current-root moves

  async putPointerMove(body: RootPointerBody, tx: Transaction): Promise<StoredRecord<RootPointerBody>> {
    return this.records.put<RootPointerBody>(
      {
        kind: 'root_pointer',
        schema: SCHEMAS.pointer,
        provenance: 'observed',
        body: checked(SCHEMAS.pointer, body),
        index: [
          { key: INDEX.pointer, value: body.line === null ? body.product : `${body.product}/${body.line}` },
          { key: INDEX.pointerMove, value: body.move },
        ],
      },
      tx,
    );
  }

  /** The root_pointer record written with this move_root action, or null. */
  async pointerMove(move: string): Promise<RootPointerBody | null> {
    const page = await this.records.find<unknown>({ key: INDEX.pointerMove, value: move, kind: 'root_pointer', limit: 1 });
    const record = page.items[0];
    if (record === undefined) return null;
    const body = RootPointerBody.safeParse(record.body);
    return body.success ? body.data : null;
  }

  /** Moves of the current root of one product line@version, newest first. */
  async pointerMoves(product: string, line: string): Promise<RootPointerBody[]> {
    const records = await this.all<unknown>({ key: INDEX.pointer, value: `${product}/${line}`, kind: 'root_pointer' });
    return records
      .reverse()
      .map((record) => RootPointerBody.safeParse(record.body))
      .filter((parsed) => parsed.success)
      .map((parsed) => parsed.data as RootPointerBody);
  }

  // ------------------------------------------------------------ judgments

  /** The newest completed classify action recorded under a reuse key. */
  async judgment(reuseKey: string): Promise<StoredRecord<ActionBody> | null> {
    return this.newest<ActionBody>({ key: INDEX.reuse, value: reuseKey, kind: 'action' }, (record) => record.body.action === ACTION.classify && record.body.result === 'completed');
  }

  // ------------------------------------------------------------ calibration and layers

  async putClaim<B>(schema: string, provenance: ProvenanceType, body: B, index: IndexEntry[], tx?: Transaction): Promise<StoredRecord<B>> {
    return this.records.put<B>({ kind: 'claim', schema, provenance, body: checked(schema, body), index }, tx);
  }

  async calibrationSets(kind: string, model: string): Promise<Array<{ record: StoredRecord<unknown>; body: KnowledgeCalibrationBody }>> {
    const records = await this.all<unknown>({ key: INDEX.calibration, value: `${kind}/${model}`, kind: 'claim' });
    const out: Array<{ record: StoredRecord<unknown>; body: KnowledgeCalibrationBody }> = [];
    for (const record of records) {
      if (record.schema !== SCHEMAS.calibration) continue;
      const body = KnowledgeCalibrationBody.safeParse(record.body);
      if (body.success && body.data.kind === kind && body.data.model === model) out.push({ record, body: body.data });
    }
    return out;
  }

  static observationOf(record: StoredRecord<unknown>): KnowledgeObservationBody | null {
    if (record.schema !== SCHEMAS.observation) return null;
    const body = KnowledgeObservationBody.safeParse(record.body);
    return body.success ? body.data : null;
  }

  static contributionOf(record: StoredRecord<unknown>): KnowledgeContributionBody | null {
    if (record.schema !== SCHEMAS.contribution) return null;
    const body = KnowledgeContributionBody.safeParse(record.body);
    return body.success ? body.data : null;
  }
}
