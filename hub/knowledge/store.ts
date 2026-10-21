// Record I/O of the knowledge package over the records store: nodes and entries (tree_node), compositions (tree_root),
// current-root moves (root_pointer), builds, calibration sets and layers (claim), and its own actions. Content-addressed
// reads are cached: what is behind a node or entry digest never changes, and every read is re-verified against its digest.
import { z } from 'zod';
import {
  KnowledgeBuildBody,
  KnowledgeCalibrationBody,
  KnowledgeCandidateBody,
  KnowledgeEntryBody,
  KnowledgeObservationBody,
  RootPointerBody,
  TreeNodeBody,
  TreeRootBody,
  schemas as KNOWLEDGE_SCHEMAS,
} from '../../contracts/src/knowledge.ts';
import { BuildInfo } from '../../contracts/src/product.ts';
import type { ActionKind, ProvenanceType } from '../../contracts/generated/vocabulary.ts';
import type { RecordKind } from '../../contracts/generated/protocol.ts';
import { IntegrityError, RECORD_SCHEMAS } from '../records/api.ts';
import type { ActionBody, FindQuery, IndexEntry, RecordStore, StoredRecord, Transaction } from '../records/api.ts';
import { cutText, entryDigest, nodeDigest, type EntryContent } from './digest.ts';
import { KnowledgeError } from './errors.ts';
import type { BuiltNode } from './tree.ts';

/** Schemas of the record bodies this package writes. Actions use the records package's action@1. */
export const SCHEMAS = {
  node: 'tree_node@1',
  entry: 'knowledge-entry@1',
  root: 'tree_root@1',
  pointer: 'root_pointer@1',
  build: 'knowledge-build@1',
  calibration: 'knowledge-calibration@1',
  observation: 'knowledge-observation@1',
  candidate: 'knowledge-candidate@1',
  action: RECORD_SCHEMAS.action,
} as const;

/** Index keys this package writes (all under `knowledge.`, plus the records package's `action.kind`). */
export const INDEX = {
  node: 'knowledge.node',
  entry: 'knowledge.entry',
  entryProduct: 'knowledge.entry.product',
  root: 'knowledge.root',
  rootBuild: 'knowledge.root.build',
  rootProduct: 'knowledge.root.product',
  produce: 'knowledge.produce',
  produceRoot: 'knowledge.produce.root',
  produceProduct: 'knowledge.produce.product',
  sync: 'knowledge.sync',
  build: 'knowledge.build',
  buildProduct: 'knowledge.build.product',
  buildBase: 'knowledge.build.base',
  pointer: 'knowledge.pointer',
  pointerMove: 'knowledge.pointer.move',
  reuse: 'knowledge.jev.reuse',
  judgmentInput: 'knowledge.jev.input',
  calibration: 'knowledge.calibration',
  observation: 'knowledge.observation.product',
  candidate: 'knowledge.candidate.owner',
  actionKind: 'action.kind',
} as const;

/** Components that write this package's actions (component@version, B05 F[3]). */
export const COMPONENTS = {
  produce: 'knowledge.produce@1',
  sync: 'knowledge.sync@1',
  placement: 'knowledge.placement@1',
  calibration: 'knowledge.calibration@1',
} as const;

/** The action kinds (B05 F[0]) this package records; checked against the generated vocabulary at compile time. */
export const ACTION = { parse: 'parse', generate: 'generate', classify: 'classify' } as const satisfies Record<string, ActionKind>;

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
  const texts = [build.family, build.line, build.platform ?? '', ...Object.keys(build.sources), ...Object.values(build.sources)];
  if (!texts.every(storable)) return '构建信息里有不能保存的文字（不成对的代理字符或 NUL）';
  try {
    pointerName(product, build.line);
  } catch (error) {
    if (error instanceof KnowledgeError) return error.message;
    throw error;
  }
  return null;
}

/** Pointer name of the current root of a product line@version: the line's UTF-8 bytes outside [a-z0-9._-] are written :hh. */
export function pointerName(product: string, line: string): string {
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

/** A bounded map that forgets the least recently used entry. */
export class Lru<K, V> {
  readonly #max: number;
  readonly #map = new Map<K, V>();
  constructor(max: number) {
    this.#max = Math.max(1, max);
  }
  get(key: K): V | undefined {
    const value = this.#map.get(key);
    if (value !== undefined) {
      this.#map.delete(key);
      this.#map.set(key, value);
    }
    return value;
  }
  set(key: K, value: V): void {
    this.#map.delete(key);
    this.#map.set(key, value);
    while (this.#map.size > this.#max) this.#map.delete(this.#map.keys().next().value as K);
  }
  delete(key: K): void {
    this.#map.delete(key);
  }
}

/** The detail of a generate action: one production of a root, or its failure. Read loosely: later versions may add fields. */
export const ProduceDetail = z.object({
  sync: z.string().nullable(),
  product: z.string(),
  pack: z.object({ id: z.string(), version: z.string(), digest: z.string() }),
  build: BuildInfo,
  root: z.string().nullable(),
  composition: z.string().nullable(),
  sources: z.array(z.object({ producer: z.string(), slot: z.string(), external: z.string(), sha256: z.string() })),
  /** Optional sources that could not be read for this production. */
  missing: z.array(z.object({ producer: z.string(), slot: z.string(), external: z.string().nullable() })).default([]),
  /** The typed-judgment placement the root depends on: model, threshold, spans placed or not, judge failures. */
  placement: z.object({ model: z.string().nullable(), threshold: z.number().nullable(), spans: z.number(), failed: z.number() }).nullable().default(null),
  reason: z.string().nullable(),
});
export type ProduceDetail = z.infer<typeof ProduceDetail>;

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

export class KnowledgeStore {
  readonly records: RecordStore;
  readonly #nodes: Lru<string, TreeNodeBody>;
  readonly #entries: Lru<string, EntryContent>;
  readonly #compositions: Lru<string, TreeRootBody>;

  constructor(records: RecordStore, options: { nodes?: number; entries?: number; compositions?: number } = {}) {
    this.records = records;
    this.#nodes = new Lru(options.nodes ?? 50_000);
    this.#entries = new Lru(options.entries ?? 50_000);
    this.#compositions = new Lru(options.compositions ?? 8);
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

  /** Records of an index value, newest first, until `accept` returns true for one (or the index ends). */
  async newest<B>(query: Omit<FindQuery, 'cursor' | 'limit' | 'newestFirst'>, accept: (record: StoredRecord<B>) => boolean = () => true, tx?: Transaction): Promise<StoredRecord<B> | null> {
    let cursor: string | null = null;
    do {
      const page: { items: StoredRecord<B>[]; next: string | null } = await this.records.find<B>({ ...query, limit: 50, cursor, newestFirst: true }, tx);
      for (const record of page.items) if (accept(record)) return record;
      cursor = page.next;
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

  #verifiedEntry(record: StoredRecord<unknown>, digest: string): KnowledgeEntryBody {
    const body = KnowledgeEntryBody.safeParse(record.body);
    if (!body.success || record.schema !== SCHEMAS.entry || entryDigest(body.data) !== digest) {
      throw new IntegrityError('知识条目记录与它的摘要不符', { detail: { entry: digest, record: record.digest } });
    }
    return body.data;
  }

  /** The content behind an entry digest, verified, or null. */
  async entry(digest: string, tx?: Transaction): Promise<EntryContent | null> {
    const cached = this.#entries.get(digest);
    if (cached !== undefined) return cached;
    const page = await this.records.find<unknown>({ key: INDEX.entry, value: digest, kind: 'tree_node', limit: 1 }, tx);
    const record = page.items[0];
    if (record === undefined) return null;
    const body = this.#verifiedEntry(record, digest);
    const content: EntryContent = { kind: body.kind, statement: body.statement, data: body.data, applicability: body.applicability };
    this.#entries.set(digest, content);
    return content;
  }

  /** Products an entry was produced for. */
  async entryProducts(digest: string): Promise<string[]> {
    const records = await this.all<unknown>({ key: INDEX.entry, value: digest, kind: 'tree_node' });
    return [...new Set(records.map((record) => this.#verifiedEntry(record, digest).product))];
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
          { key: INDEX.rootBuild, value: buildKey(body.product, body.build.name) },
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
    const body = TreeRootBody.safeParse(record.body);
    if (!body.success) throw new IntegrityError('知识树组成记录不符合 tree_root@1', { detail: { record: recordDigest } });
    this.#compositions.set(recordDigest, body.data);
    return body.data;
  }

  static produceOf(record: StoredRecord<ActionBody>): ProduceAction | null {
    if (record.kind !== 'action' || record.body.action !== ACTION.generate) return null;
    const detail = ProduceDetail.safeParse(record.body.detail);
    if (!detail.success) return null;
    return { record, detail: detail.data, completed: record.body.result === 'completed' && detail.data.root !== null && detail.data.composition !== null };
  }

  /** The newest completed production of a product's base build (exact name), or null. */
  async latestProduction(product: string, base: string): Promise<ProduceAction | null> {
    let found: ProduceAction | null = null;
    await this.newest<ActionBody>({ key: INDEX.produce, value: buildKey(product, base), kind: 'action' }, (record) => {
      const produced = KnowledgeStore.produceOf(record);
      if (produced === null || !produced.completed || produced.detail.product !== product || produced.detail.build.name !== base) return false;
      found = produced;
      return true;
    });
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
  async buildsNamed(product: string, name: string): Promise<StoredBuild[]> {
    const records = await this.all<unknown>({ key: INDEX.build, value: buildKey(product, name), kind: 'claim' });
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
          { key: INDEX.pointer, value: `${body.product}/${body.line}` },
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

  static candidateOf(record: StoredRecord<unknown>): KnowledgeCandidateBody | null {
    if (record.schema !== SCHEMAS.candidate) return null;
    const body = KnowledgeCandidateBody.safeParse(record.body);
    return body.success ? body.data : null;
  }
}
