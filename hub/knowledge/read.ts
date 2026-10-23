// The reading side of the knowledge tree: permission (the reader is an admin, or a pack assigned to them binds the product of
// the root; absent and forbidden are the same null, D05 R[3]), get_nodes pages with coverage, the TreeReader hub/refs resolves
// tree and entry references with (grounds from the version's composition, B01 R[5], K02 R[2]), the closed catalog of a root
// (C07), the diffs of two roots (paths, and entries of given kinds) and the provenance of an entry. Compositions are read
// through CompositionView, whether they are one record or parts.
import { createHash } from 'node:crypto';
import { EntryKindSchema, ValidityStatusSchema, type ChangeKind, type EntryKind, type ValidityStatus } from '../../contracts/generated/vocabulary.ts';
import type { CompositionRow, RootCatalog, TreeNodeBody } from '../../contracts/src/knowledge.ts';
import type { Applicability } from '../../contracts/src/product.ts';
import { TreePath } from '../../contracts/src/reference.ts';
import { MAX_IMPACT_PATHS } from '../../contracts/src/views.ts';
import type { EntryDiff, NodesPage, NodesQuery, NodeViews, RootDiff } from '../ports.ts';
import type { Principal } from '../records/api.ts';
import { ReferenceSyntaxError, parseReference, pathOf, pathSegments, treeReference } from '../refs/api.ts';
import type { JsonValue, ReaderIdentity, TreeRead, TreeReader } from '../refs/api.ts';
import { createCatalogView, type CatalogEntry, type CatalogView } from '../rules/api.ts';
import { CompositionView, type ReadRow } from './composition.ts';
import { CONTRADICTION, pointerName } from './store.ts';
import { mapLimited } from './concurrency.ts';
import type { KnowledgeContext } from './context.ts';
import { canonicalSize, compareText, cutText, entryDigest, type EntryContent } from './digest.ts';
import { catalogCanon, catalogData } from './produce.ts';
import { Lru, type ProduceAction } from './store.ts';

/** K02 F[6]: applicability the producer could not read from the source structure. */
export const UNDECLARED = '未声明';
const MAX_DEPTH = 6;
/** Most distinct paths one get_nodes call examines; the rest are named in the coverage note. */
export const MAX_NODE_PATHS = 256;
const SHA256 = /^[0-9a-f]{64}$/;

/** Binds a tree reader to the composition a run locked (RootInfo.composition): its grounds and premises come from it alone. */
export interface TreeLock {
  composition?: string | null;
}

/** Display text of an entry's applicability (K02 R[2]: undeclared is said, never hidden). */
export function applicabilityText(applicability: Applicability | null): string {
  if (applicability === null) return UNDECLARED;
  const parts: string[] = [];
  if (applicability.builds !== undefined) parts.push(`构建 ${applicability.builds.join('、') || '（无）'}`);
  if (applicability.platforms !== undefined) parts.push(`平台 ${applicability.platforms.join('、') || '（无）'}`);
  if (applicability.models !== undefined) parts.push(`型号 ${applicability.models.join('、') || '（无）'}`);
  return parts.length === 0 ? '未限定' : parts.join('；');
}

export interface ProvenanceRow {
  root: string;
  composition: string;
  product: string;
  build: string;
  path: string;
  entry: string;
  kind: string;
  /** The producers of the product pack that gave the entry at this path. */
  producers: string[];
  fragments: string[];
  basis: CompositionRow['basis'];
  decided_by: string;
  placement: CompositionRow['placement'] | null;
  /** The sources the fragments are in, with their external identity and read tier. */
  sources: Array<{ sha256: string; external: string; media_type: string; read_tier: string; basis: string; decided_by: string }>;
}

/** Nearest common ancestor of tree paths (K01 R[3]). */
function commonAncestor(paths: readonly string[][]): string[] {
  if (paths.length === 0) return [];
  let prefix = paths[0];
  for (const path of paths) {
    let k = 0;
    while (k < prefix.length && k < path.length && prefix[k] === path[k]) k++;
    prefix = prefix.slice(0, k);
  }
  return prefix;
}

/** One entry with its content, as a node shows it. */
interface EntryAt {
  digest: string;
  content: EntryContent;
}

export class TreeReading {
  readonly #context: KnowledgeContext;
  readonly #products = new Map<string, { products: Set<string>; at: number }>();
  readonly #views = new Lru<string, CompositionView>(8);
  readonly #catalogs = new Lru<string, CatalogView | null>(8);

  constructor(context: KnowledgeContext) {
    this.#context = context;
  }

  // ------------------------------------------------------------ permission

  /** Products a root was produced for (kept 30 s; a root does not lose a product). */
  async productsOfRoot(root: string): Promise<Set<string>> {
    const cached = this.#products.get(root);
    const now = Date.now();
    if (cached !== undefined && now - cached.at < 30_000) return cached.products;
    const products = new Set((await this.#context.store.productionsOfRoot(root)).map((p) => p.detail.product));
    if (products.size > 0) this.#products.set(root, { products, at: now });
    return products;
  }

  /** The reader is an enabled admin, or a pack assigned to them binds one of the products. The account is re-read. */
  async mayReadProducts(reader: { id: string } | null | undefined, products: Iterable<string>): Promise<boolean> {
    const wanted = [...products];
    if (wanted.length === 0 || typeof reader?.id !== 'string') return false;
    const account = await this.#context.records.principals.get(reader.id);
    if (account === null || account.disabled) return false;
    if (account.role === 'admin') return true;
    const readable = await this.#context.packs.readableProducts({ id: account.id, name: account.name, role: account.role });
    return wanted.some((product) => readable.has(product));
  }

  async mayReadRoot(reader: { id: string } | null | undefined, root: string): Promise<boolean> {
    if (!SHA256.test(root)) return false;
    return this.mayReadProducts(reader, await this.productsOfRoot(root));
  }

  // ------------------------------------------------------------ structure

  async nodeAt(root: string, segments: readonly string[]): Promise<{ digest: string; node: TreeNodeBody } | null> {
    let digest = root;
    let node = await this.#context.store.node(digest);
    for (const segment of segments) {
      if (node === null) return null;
      const child = node.children.find((c) => c.name === segment);
      if (child === undefined) return null;
      digest = child.digest;
      node = await this.#context.store.node(digest);
    }
    return node === null ? null : { digest, node };
  }

  /** The composition of the newest production of a root. */
  async compositionOf(root: string): Promise<CompositionView | null> {
    const productions = await this.#context.store.productionsOfRoot(root);
    const latest = productions[productions.length - 1];
    if (latest === undefined) return null;
    return this.#view(latest);
  }

  /** Every composition of a root (one per production, a composition once), newest first. */
  async compositionsOf(root: string): Promise<CompositionView[]> {
    const productions = await this.#context.store.productionsOfRoot(root);
    const out: CompositionView[] = [];
    const seen = new Set<string>();
    for (let i = productions.length - 1; i >= 0; i--) {
      const digest = productions[i].detail.composition as string;
      if (seen.has(digest)) continue;
      seen.add(digest);
      const view = await this.#view(productions[i]);
      if (view !== null) out.push(view);
    }
    return out;
  }

  async #view(production: ProduceAction): Promise<CompositionView | null> {
    const digest = production.detail.composition as string;
    const cached = this.#views.get(digest);
    if (cached !== undefined) return cached;
    const body = await this.#context.store.composition(digest);
    if (body === null) return null;
    const view = new CompositionView(this.#context.store, digest, body);
    this.#views.set(digest, view);
    return view;
  }

  /**
   * The entries of a node with their content: from the composition's rows at the path when they carry it (parts), else from
   * the entry records. Sorted by kind, statement, digest.
   */
  async #entriesAt(rows: ReadonlyMap<string, ReadRow> | null, digests: readonly string[]): Promise<EntryAt[]> {
    const found = await mapLimited(digests, 16, async (digest) => {
      const content = await this.#contentOf(rows, digest);
      return content === null ? null : { digest, content };
    });
    return found
      .filter((e): e is EntryAt => e !== null)
      .sort((a, b) => compareText(a.content.kind, b.content.kind) || compareText(a.content.statement, b.content.statement) || compareText(a.digest, b.digest));
  }

  /** The content of one entry: a part row's content when it hashes to the digest, else the verified entry record. */
  async #contentOf(rows: ReadonlyMap<string, ReadRow> | null, digest: string): Promise<EntryContent | null> {
    const inRow = rows?.get(digest)?.content;
    if (inRow !== undefined && entryDigest(inRow) === digest) return inRow;
    return this.#context.store.entry(digest);
  }

  // ------------------------------------------------------------ get_nodes

  /**
   * get_nodes (D05): each requested path and its subtree to `depth` in pre-order, each node once. The reader is checked
   * before anything of the request is read; at most MAX_NODE_PATHS distinct paths are examined (the rest are named in the
   * coverage note). A page ends at `pageNodes` nodes or once about `pageBytes` of statements, data and child lists are on
   * it; a node whose entries do not fit is split over pages by an entry offset in the cursor. A cursor is bound to its query
   * and must point inside the walk; coverage is complete only on the last page.
   */
  async getNodes(query: NodesQuery, reader: Principal): Promise<NodesPage | null> {
    const root = query.root;
    if (typeof root !== 'string' || !SHA256.test(root)) return null;
    if (!(await this.mayReadRoot(reader, root))) return null;
    // The tool's default depth is 1 (contracts GetNodesInput).
    const depth = query.depth ?? 1;
    if (!Number.isInteger(depth) || depth < 0 || depth > MAX_DEPTH) return null;
    const requested = query.paths === undefined || query.paths === null || query.paths.length === 0 ? ['/'] : query.paths;
    if (!Array.isArray(requested)) return null;
    const paths: Array<{ text: string; segments: string[] }> = [];
    const seen = new Set<string>();
    const skipped: string[] = [];
    let skippedCount = 0;
    for (const path of requested) {
      if (typeof path !== 'string') return null;
      if (seen.has(path)) continue;
      seen.add(path);
      if (paths.length >= MAX_NODE_PATHS) {
        skippedCount++;
        if (skipped.length < 5) skipped.push(cutText(path, 100));
        continue;
      }
      if (!TreePath.safeParse(path).success) return null;
      let segments: string[];
      try {
        segments = pathSegments(path);
      } catch (error) {
        if (error instanceof ReferenceSyntaxError) return null;
        throw error;
      }
      paths.push({ text: path, segments });
    }
    const queryKey = createHash('sha256').update(JSON.stringify([root, paths.map((p) => p.text), depth])).digest('hex').slice(0, 16);
    let offset = 0;
    let entryOffset = 0;
    if (query.cursor !== undefined && query.cursor !== null && query.cursor !== '') {
      const decoded = decodeCursor(query.cursor);
      if (decoded === null || decoded.q !== queryKey) return null;
      offset = decoded.o;
      entryOffset = decoded.e;
    }
    if ((await this.#context.store.node(root)) === null) return null;
    const composition = await this.compositionOf(root);
    const { pageNodes, pageBytes } = this.#context.limits;

    const missing: string[] = [];
    // Each node is emitted when it is first reached; the levels still to go when it was reached, at most.
    const reached = new Map<string, number>();
    const page: NodeViews = [];
    // The walk's state: nodes walked completely so far (a node split over pages counts once its last part is on a page),
    // bytes on the page, where the next page starts, the note of a split node, and whether the cursor points into the walk.
    const walk: { position: number; bytes: number; next: { o: number; e: number } | null; split: string | null; invalid: boolean } = {
      position: 0,
      bytes: 0,
      next: null,
      split: null,
      invalid: false,
    };
    const visit = async (segments: string[], digest: string, node: TreeNodeBody, levels: number): Promise<boolean> => {
      const path = pathOf(segments);
      // Nothing lies deeper than the node's height. A subtree reached before with at least as many levels to go holds
      // nothing new, so overlapping paths walk each node a bounded number of times however many of them a request names.
      const remaining = Math.min(levels, node.height);
      const before = reached.get(path);
      if (before !== undefined && before >= remaining) return true;
      reached.set(path, remaining);
      if (before === undefined) {
        if (walk.position >= offset) {
          const start = walk.position === offset ? entryOffset : 0;
          if (page.length >= pageNodes) {
            walk.next = { o: walk.position, e: start };
            return false;
          }
          const rows = composition === null ? null : await composition.rowsAt(path);
          const entries = await this.#entriesAt(rows, node.entries);
          if (start > 0 && start >= entries.length) {
            walk.invalid = true;
            return false;
          }
          // The child list goes with the node and is never split; the entries are taken while they fit.
          let size = node.children.reduce((sum, child) => sum + 2 * Buffer.byteLength(child.name, 'utf8') + 100, 0);
          if (page.length > 0 && walk.bytes + size > pageBytes) {
            walk.next = { o: walk.position, e: start };
            return false;
          }
          let taken = start;
          for (; taken < entries.length; taken++) {
            const one = Buffer.byteLength(entries[taken].content.statement, 'utf8') + canonicalSize(entries[taken].content.data);
            // A page always takes something, so that paging ends even when one entry alone is larger than the budget.
            if ((page.length > 0 || taken > start) && walk.bytes + size + one > pageBytes) break;
            size += one;
          }
          if (taken === start && start < entries.length) {
            walk.next = { o: walk.position, e: start };
            return false;
          }
          walk.bytes += size;
          page.push(this.#nodeView(root, segments, digest, node, rows, entries.slice(start, taken)));
          if (taken < entries.length) {
            walk.split = `节点 ${path} 的条目分在几页里：这一页给出第 ${start + 1} 到第 ${taken} 个（共 ${entries.length} 个），其余在下一页`;
            walk.next = { o: walk.position, e: taken };
            return false;
          }
        }
        walk.position++;
      }
      if (remaining === 0) return true;
      for (const child of node.children) {
        const childNode = await this.#context.store.node(child.digest);
        if (childNode === null) continue;
        if (!(await visit([...segments, child.name], child.digest, childNode, remaining - 1))) return false;
      }
      return true;
    };
    for (const path of paths) {
      const found = await this.nodeAt(root, path.segments);
      if (found === null) {
        missing.push(path.text);
        continue;
      }
      if (!(await visit(path.segments, found.digest, found.node, depth))) break;
    }
    // A cursor that points past the walk (or into a node without such an entry) was not made by this query.
    if (walk.invalid || (walk.next === null && (offset > 0 || entryOffset > 0) && offset >= walk.position)) return null;
    const notes: string[] = [];
    if (walk.split !== null) notes.push(walk.split);
    if (missing.length > 0) notes.push(`这些路径在这个根里不存在：${cutText(missing.join('、'), 1000)}`);
    if (skippedCount > 0) notes.push(`一次最多读 ${MAX_NODE_PATHS} 个路径，其余 ${skippedCount} 个没有读：${skipped.join('、')}${skippedCount > skipped.length ? '…' : ''}`);
    const note = notes.length === 0 ? undefined : notes.join('；');
    const cursor = walk.next === null ? null : encodeCursor({ ...walk.next, q: queryKey });
    const examined = walk.position;
    return {
      nodes: page,
      next: cursor,
      coverage:
        cursor === null
          ? { complete: missing.length === 0 && skippedCount === 0, examined, total: examined, ...(note ? { note } : {}) }
          : { complete: false, examined, ...(note ? { note } : {}) },
    };
  }

  #nodeView(root: string, segments: string[], digest: string, node: TreeNodeBody, rows: ReadonlyMap<string, ReadRow> | null, entries: EntryAt[]): NodeViews[number] {
    const path = pathOf(segments);
    return {
      path,
      reference: treeReference(root, path),
      name: node.name,
      level: node.level,
      digest,
      children: node.children.map((child) => ({ name: child.name, path: pathOf([...segments, child.name]), digest: child.digest })),
      entries: entries.map(({ digest: entry, content }) => {
        const placement = rows?.get(entry)?.placement;
        const applicability = applicabilityText(content.applicability);
        return {
          entry,
          // Entries are checked against the entry_kind axis before they are stored; a stored kind outside it is corruption.
          kind: EntryKindSchema.parse(content.kind),
          statement: content.statement,
          reference: treeReference(root, path, entry),
          applicability: placement === undefined ? applicability : `${applicability}；${placement.note}`,
          data: content.data,
        };
      }),
    };
  }

  // ------------------------------------------------------------ TreeReader for hub/refs

  /**
   * The reader hub/refs resolves tree and entry references with. Grounds come from the version composition (B01 R[5]):
   * bound to a composition (`lock`, the RootInfo.composition a run locked) the fragments of that composition alone; unbound,
   * the fragments of every composition of the root (builds whose trees have equal content share one root), each also
   * listed with its build under `validity.compositions` (K02 R[2]: which version's composition provides the fragment).
   */
  treeReader(lock: TreeLock | null = null): TreeReader {
    const bound = typeof lock?.composition === 'string' && SHA256.test(lock.composition) ? lock.composition : null;
    return {
      read: (root, path, entry, reader) => this.#read(root, path, entry, reader, bound),
      readEntry: (entry, reader) => this.#readEntry(entry, reader),
      // A path or entry that `read` does not find in a root the reader may read is a mistake in the reference.
      hasRoot: async (root, reader) => (await this.mayReadRoot({ id: reader.user }, root)) && (await this.#context.store.node(root)) !== null,
    };
  }

  async #read(root: string, path: string, entry: string | null, reader: ReaderIdentity, bound: string | null): Promise<TreeRead | null> {
    if (!(await this.mayReadRoot({ id: reader.user }, root))) return null;
    let segments: string[];
    try {
      segments = pathSegments(path);
    } catch (error) {
      if (error instanceof ReferenceSyntaxError) return null;
      throw error;
    }
    const found = await this.nodeAt(root, segments);
    if (found === null) return null;
    const all = await this.compositionsOf(root);
    // A lock on another root's composition does not apply here: every composition of this root grounds the read.
    const locked = bound === null ? [] : all.filter((c) => c.record === bound);
    const compositions = locked.length > 0 ? locked : all;
    const canonical = pathOf(segments);
    const premises = compositions.map((c) => `rec:${c.record}`);
    const rowsOf = await Promise.all(compositions.map((c) => c.rowsAt(canonical)));
    const groundsOf = (digests: readonly string[]): { grounds: string[]; tagged: Array<{ composition: string; build: string; grounds: string[] }> } => {
      const grounds: string[] = [];
      const tagged = compositions.map((c, i) => {
        const own: string[] = [];
        for (const digest of digests) for (const fragment of rowsOf[i].get(digest)?.fragments ?? []) if (!own.includes(fragment)) own.push(fragment);
        for (const fragment of own) if (!grounds.includes(fragment)) grounds.push(fragment);
        return { composition: c.record, build: c.body.build.name, grounds: own };
      });
      return { grounds, tagged };
    };
    // The machine-checkable validity of what is read (B01 R[2], K03 R[5]). Every condition that holds is listed with
    // its source; the status is the first of them in the fixed order rule_withdrawn > cited_fragment_changed >
    // contradicted (README). grounds_withdrawn and premise_failed have no data source today; tree entries carry no
    // expiry (record claims: hub/refs). cited_fragment_changed compares the cited root X with the reader's root Y —
    // the root of the composition the reader's lock names: X ≠ Y and Y's entry at the same path differs or is absent
    // (K03 R[5]). The same root never flags (roots are content-addressed); without a lock there is no reader root to
    // compare against, and nothing is claimed, honestly.
    // The reader's root Y (K01 R[6], K03 R[5]): in a run, the root of the composition the lock names; outside a run,
    // the CURRENT-ROOT POINTER of the product line the cited root belongs to. When the pointer cannot be taken (the
    // line has no root yet) there is no Y and nothing is claimed, honestly (README).
    const readerRoot = bound !== null
      ? (await this.#context.store.composition(bound))?.root ?? null
      : await (async () => {
          const body = all[0]?.body;
          if (body === undefined) return null;
          const pointer = await this.#context.records.pointers.get(pointerName(body.product, body.version.line));
          return pointer?.target ?? null;
        })();
    // Pack lookups of one read are cached (a withdrawn version is asked once, not once per row).
    const packCache = new Map<string, Promise<boolean>>();
    const withdrawn = (ref: string): Promise<boolean> => {
      let hit = packCache.get(ref);
      if (hit === undefined) {
        hit = this.#context.packs.pack(ref).then((pack) => pack === null);
        packCache.set(ref, hit);
      }
      return hit;
    };
    const CONDITIONS = ValidityStatusSchema.extract(['rule_withdrawn', 'cited_fragment_changed', 'contradicted']);
    type Condition = (typeof CONDITIONS.options)[number];
    const ORDER: readonly Condition[] = CONDITIONS.options;
    type Relation = { digest: string; source: string; at: string; other: string; by: string; provenance: string };
    /** Every contradiction relation of these digests: ONE findMany per read (all digests at once — the query count
     * never grows with the entry count); findMany pages internally until exhausted, so nothing is silently capped. */
    const relationsOf = async (digests: readonly string[]): Promise<Relation[]> => {
      const out: Relation[] = [];
      if (digests.length === 0) return out;
      const records = await this.#context.store.records.findMany<{ relation?: string; at?: string; other?: string; by?: string; claim?: string }>({ key: CONTRADICTION, values: [...digests], kind: 'claim' });
      for (const record of records) {
        const body = record.body as { relation?: string; at?: string; other?: string; by?: string; claim?: string };
        if (body.relation !== 'contradicts') continue;
        // The claim address names the digest this relation flags (tree:<root>/<path>@<digest>).
        const digest = /@([0-9a-f]{64})$/.exec(body.claim ?? '')?.[1] ?? digests[0]!;
        out.push({ digest, source: `rec:${record.digest}`, at: body.at ?? record.created_at, other: body.other ?? '', by: body.by ?? '', provenance: record.provenance });
      }
      return out;
    };

    const validityOfRows = async (digests: readonly string[]): Promise<{
      status: ValidityStatus;
      bound: string[];
      conditions: Array<{ condition: Condition; source: string }>;
      contradictions: Array<{ source: string; at: string; other: string }>;
      cited_root?: string;
      reader_root?: string;
    }> => {
      const conditions: Array<{ condition: Condition; source: string }> = [];
      // rule_withdrawn: the pack version that decided a row is no longer published.
      const decidedBy = new Set<string>();
      for (const [i, c] of compositions.entries()) for (const digest of digests) {
        const row = rowsOf[i].get(digest);
        if (row !== undefined) decidedBy.add(row.decided_by);
      }
      for (const ref of [...decidedBy].sort()) if (await withdrawn(ref)) conditions.push({ condition: 'rule_withdrawn', source: ref });
      // cited_fragment_changed: X ≠ Y, and Y's entry at the same path differs or the path is absent in Y.
      if (digests.length === 1 && readerRoot !== null && readerRoot !== root) {
        const view = (await this.compositionsOf(readerRoot))[0];
        const yRows = view === undefined ? null : await view.rowsAt(canonical);
        if (yRows === null || !yRows.has(digests[0]!)) {
          conditions.push({ condition: 'cited_fragment_changed', source: `引用根 ${root}，读者根 ${readerRoot}；主张在 ${root} 上仍成立` });
        }
      }
      // contradicted: relations this reader may see — their own candidate relations and the Hub's deterministic ones
      // (K05 R[4]: someone else's private candidate relation never flags another reader, an admin included).
      const contradictions: Array<{ source: string; at: string; other: string }> = [];
      const relations = await relationsOf(digests);
      for (const relation of relations) {
        if (!digests.includes(relation.digest)) continue;
        const visible = relation.provenance !== 'candidate' || relation.by === reader.user;
        if (visible) contradictions.push({ source: relation.source, at: relation.at, other: relation.other });
      }
      if (contradictions.length > 0) conditions.push({ condition: 'contradicted', source: contradictions.map((c) => c.source).join('、') });
      let status: ValidityStatus = 'valid';
      for (const condition of ORDER) if (conditions.some((c) => c.condition === condition)) { status = condition; break; }
      const result: {
        status: ValidityStatus;
        bound: string[];
        conditions: Array<{ condition: Condition; source: string }>;
        contradictions: Array<{ source: string; at: string; other: string }>;
        cited_root?: string;
        reader_root?: string;
      } = { status, bound: [root, ...digests], conditions, contradictions };
      if (digests.length === 1 && readerRoot !== null && readerRoot !== root) {
        result.cited_root = root;
        result.reader_root = readerRoot;
      }
      return result;
    };

    if (entry !== null) {
      if (!found.node.entries.includes(entry)) return null;
      const content = await this.#contentOf(rowsOf[0] ?? null, entry);
      if (content === null) return null;
      const { grounds, tagged } = groundsOf([entry]);
      const validity = await validityOfRows([entry]);
      return {
        text: content.statement,
        mediaType: 'text/plain',
        readTier: 'model_readable',
        data: { kind: content.kind, data: content.data, applicability: content.applicability } as JsonValue,
        grounds,
        validity: {
          ...validity,
          premises: content.applicability === null ? [...premises, `适用条件：${UNDECLARED}`] : premises,
          compositions: tagged,
        } as JsonValue,
      };
    }
    const entries = await this.#entriesAt(rowsOf[0] ?? null, found.node.entries);
    const { grounds, tagged } = groundsOf(entries.map((e) => e.digest));
    const validity = await validityOfRows(entries.map((e) => e.digest));
    const text = entries.length > 0 ? entries.map((e) => e.content.statement).join('\n\n') : found.node.children.map((c) => c.name).join('\n');
    return {
      text,
      mediaType: 'text/plain',
      readTier: 'model_readable',
      data: { name: found.node.name, level: found.node.level, children: found.node.children.map((c) => c.name), entries: [...found.node.entries] },
      grounds,
      validity: { ...validity, premises, compositions: tagged } as JsonValue,
    };
  }

  async #readEntry(entry: string, reader: ReaderIdentity): Promise<TreeRead | null> {
    if (!SHA256.test(entry)) return null;
    const products = await this.#context.store.entryProducts(entry);
    if (!(await this.mayReadProducts({ id: reader.user }, products))) return null;
    const content = await this.#context.store.entry(entry);
    if (content === null) return null;
    return {
      text: content.statement,
      mediaType: 'text/plain',
      readTier: 'model_readable',
      data: { kind: content.kind, data: content.data, applicability: content.applicability } as JsonValue,
      grounds: [],
    };
  }

  // ------------------------------------------------------------ catalog

  async catalog(root: string, catalogId: string): Promise<CatalogView | null> {
    if (!SHA256.test(root)) return null;
    const productions = await this.#context.store.productionsOfRoot(root);
    for (let i = productions.length - 1; i >= 0; i--) {
      const view = await this.#view(productions[i]);
      const declaration = view?.body.catalogs.find((c) => c.id === catalogId);
      if (view === null || declaration === undefined) continue;
      const key = `${root}\u0000${catalogId}\u0000${view.record}`;
      const cached = this.#catalogs.get(key);
      if (cached !== undefined) return cached;
      // Members: entries of the declared kind, of the declared producer when the catalog names one (product@1 catalogs).
      const producer = declaration.producer;
      const rows = await view.rowsWithContent(new Set([declaration.entry_kind]), (row) => producer === undefined || row.producers.includes(producer));
      const kept: Array<{ entry: CatalogEntry; segments: string[] }> = [];
      for (const row of rows) {
        const data = catalogData(row.content.data);
        if (data === null) continue;
        const entry: CatalogEntry = { words: data.words, signatures: data.signatures, reference: treeReference(root, row.path, row.entry) };
        if (data.summary !== undefined) entry.summary = data.summary;
        kept.push({ entry, segments: pathSegments(row.path) });
      }
      const catalog =
        kept.length === 0
          ? null
          : createCatalogView(
              kept.map((m) => m.entry),
              { reference: treeReference(root, pathOf(commonAncestor(kept.map((m) => m.segments)))), complete: declaration.complete, caseSensitive: declaration.case_sensitive },
            );
      this.#catalogs.set(key, catalog);
      return catalog;
    }
    return null;
  }

  /**
   * The declaration of a catalog in the newest production of a root that declares it, and its members by entry digest:
   * the path and the syntax canon (catalogCanon). Same reading as catalog(): the kind and the producer from the
   * declaration, catalog-parseable rows only. Null when no production of the root declares the catalog.
   */
  async catalogMembers(root: string, catalogId: string): Promise<{ declaration: RootCatalog; members: Map<string, { path: string; canon: string }> } | null> {
    if (!SHA256.test(root)) return null;
    const productions = await this.#context.store.productionsOfRoot(root);
    for (let i = productions.length - 1; i >= 0; i--) {
      const view = await this.#view(productions[i]);
      const declaration = view?.body.catalogs.find((c) => c.id === catalogId);
      if (view === null || declaration === undefined) continue;
      const producer = declaration.producer;
      const rows = await view.rowsWithContent(new Set([declaration.entry_kind]), (row) => producer === undefined || row.producers.includes(producer));
      const members = new Map<string, { path: string; canon: string }>();
      for (const row of rows) {
        const canon = catalogCanon(row.content.data);
        if (canon === null) continue;
        members.set(row.entry, { path: row.path, canon });
      }
      return { declaration, members };
    }
    return null;
  }

  // ------------------------------------------------------------ diffs

  async diff(from: string, to: string): Promise<RootDiff | null> {
    if (!SHA256.test(from) || !SHA256.test(to)) return null;
    const store = this.#context.store;
    if ((await store.node(from)) === null || (await store.node(to)) === null) return null;
    const added: string[] = [];
    const removed: string[] = [];
    const modified: string[] = [];
    const all = async (segments: string[], digest: string, into: string[]): Promise<void> => {
      into.push(pathOf(segments));
      const node = await store.node(digest);
      for (const child of node?.children ?? []) await all([...segments, child.name], child.digest, into);
    };
    const walk = async (segments: string[], a: string, b: string): Promise<void> => {
      if (a === b) return;
      const na = await store.node(a);
      const nb = await store.node(b);
      if (na === null || nb === null) return;
      if (na.entries.length !== nb.entries.length || na.entries.some((e, i) => nb.entries[i] !== e)) modified.push(pathOf(segments));
      const childrenA = new Map(na.children.map((c) => [c.name, c.digest]));
      const childrenB = new Map(nb.children.map((c) => [c.name, c.digest]));
      const names = [...new Set([...childrenA.keys(), ...childrenB.keys()])].sort(compareText);
      for (const name of names) {
        const da = childrenA.get(name);
        const db = childrenB.get(name);
        if (da === undefined) await all([...segments, name], db as string, added);
        else if (db === undefined) await all([...segments, name], da, removed);
        else await walk([...segments, name], da, db);
      }
    };
    await walk([], from, to);
    return { from, to, added, removed, modified };
  }

  /**
   * The nodes whose own entry lists differ between two roots (a node on one side only included), walked in parallel by
   * digest so that shared subtrees are never read. Each comes with its path and both entry lists.
   */
  async changedNodes(from: string, to: string): Promise<Array<{ path: string; before: string[]; after: string[] }> | null> {
    if (!SHA256.test(from) || !SHA256.test(to)) return null;
    const store = this.#context.store;
    if ((await store.node(from)) === null || (await store.node(to)) === null) return null;
    const out: Array<{ path: string; before: string[]; after: string[] }> = [];
    const walk = async (segments: string[], a: string | null, b: string | null): Promise<void> => {
      if (a === b) return;
      const na = a === null ? null : await store.node(a);
      const nb = b === null ? null : await store.node(b);
      const before = na?.entries ?? [];
      const after = nb?.entries ?? [];
      if (before.length !== after.length || before.some((e, i) => after[i] !== e)) out.push({ path: pathOf(segments), before, after });
      const childrenA = new Map((na?.children ?? []).map((c) => [c.name, c.digest]));
      const childrenB = new Map((nb?.children ?? []).map((c) => [c.name, c.digest]));
      const names = [...new Set([...childrenA.keys(), ...childrenB.keys()])].sort(compareText);
      for (const name of names) await walk([...segments, name], childrenA.get(name) ?? null, childrenB.get(name) ?? null);
    };
    await walk([], from, to);
    return out.sort((x, y) => compareText(x.path, y.path));
  }

  /**
   * Entry kinds of the entries at one path of a root: from the newest composition's rows at the path, else from the entry
   * records (null when an entry cannot be found).
   */
  async kindsAt(composition: CompositionView | null, path: string, entries: readonly string[]): Promise<Map<string, { kind: string; row: ReadRow | null }>> {
    const rows = composition === null || entries.length === 0 ? null : await composition.rowsAt(path);
    const out = new Map<string, { kind: string; row: ReadRow | null }>();
    await mapLimited(entries, 16, async (entry) => {
      const row = rows?.get(entry) ?? null;
      const kind = row?.kind ?? (await this.#context.store.entry(entry))?.kind;
      if (kind !== undefined) out.set(entry, { kind, row });
    });
    return out;
  }

  /** The version difference over entries of some kinds (KnowledgePort.diffEntries). */
  async diffEntries(from: string, to: string, options: { kinds: readonly EntryKind[]; limit?: number }): Promise<EntryDiff | null> {
    const kinds = [...new Set(options.kinds)].filter((k) => EntryKindSchema.safeParse(k).success).sort(compareText);
    const changes = await this.entryChanges(from, to, new Set(kinds));
    if (changes === null) return null;
    // A limit that is not a non-negative safe integer (NaN, infinite, fractional, negative) is the default.
    const limit = Number.isSafeInteger(options.limit) && (options.limit as number) >= 0 ? (options.limit as number) : MAX_IMPACT_PATHS;
    return { from, to, kinds, changes: changes.slice(0, limit), total: changes.length, truncated: changes.length > limit };
  }

  /** Every path whose own entries of the kinds differ, with the change kind, sorted by path. */
  async entryChanges(from: string, to: string, kinds: ReadonlySet<string>): Promise<Array<{ path: string; change: ChangeKind; before: string[]; after: string[] }> | null> {
    const nodes = await this.changedNodes(from, to);
    if (nodes === null) return null;
    const [fromComposition, toComposition] = await Promise.all([this.compositionOf(from), this.compositionOf(to)]);
    const out: Array<{ path: string; change: ChangeKind; before: string[]; after: string[] }> = [];
    for (const node of nodes) {
      const [a, b] = await Promise.all([this.kindsAt(fromComposition, node.path, node.before), this.kindsAt(toComposition, node.path, node.after)]);
      const before = node.before.filter((e) => kinds.has(a.get(e)?.kind ?? '')).sort(compareText);
      const after = node.after.filter((e) => kinds.has(b.get(e)?.kind ?? '')).sort(compareText);
      if (before.length === after.length && before.every((e, i) => after[i] === e)) continue;
      out.push({ path: node.path, change: before.length === 0 ? 'added' : after.length === 0 ? 'removed' : 'modified', before, after });
    }
    return out;
  }

  // ------------------------------------------------------------ provenance

  /** The composition rows behind a tree address (with or without an entry), newest production first; the reader is required. */
  async provenanceOf(reference: string, reader: Principal): Promise<ProvenanceRow[] | null> {
    let parsed;
    try {
      parsed = parseReference(reference);
    } catch (error) {
      if (error instanceof ReferenceSyntaxError) return null;
      throw error;
    }
    if (parsed.scheme !== 'tree') return null;
    if (reader === undefined || reader === null || !(await this.mayReadRoot(reader, parsed.root))) return null;
    const path = pathOf(pathSegments(parsed.path));
    const productions = await this.#context.store.productionsOfRoot(parsed.root);
    const out: ProvenanceRow[] = [];
    for (let i = productions.length - 1; i >= 0; i--) {
      const production = productions[i];
      const view = await this.#view(production);
      if (view === null) continue;
      const rows = await view.rowsAt(path);
      for (const row of rows.values()) {
        if (parsed.entry !== undefined && row.entry !== parsed.entry) continue;
        const shas = new Set(row.fragments.map((fragment) => fragment.slice(4, 68)));
        const sources = await view.sourcesOf(shas);
        out.push({
          root: parsed.root,
          composition: view.record,
          product: production.detail.product,
          build: production.detail.build.name,
          path,
          entry: row.entry,
          kind: row.kind,
          producers: [...row.producers],
          fragments: [...row.fragments],
          basis: row.basis,
          decided_by: row.decided_by,
          placement: row.placement ?? null,
          sources: sources.map((s) => ({ sha256: s.sha256, external: s.external, media_type: s.media_type, read_tier: s.read_tier, basis: s.basis, decided_by: s.decided_by })),
        });
      }
    }
    return out.length === 0 ? null : out;
  }
}

/** A get_nodes cursor: the node to start at (`o`, in walk order), the entry of that node to start at (`e`) and the query it belongs to. */
function encodeCursor(value: { o: number; e: number; q: string }): string {
  return Buffer.from(JSON.stringify({ v: 2, ...value }), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): { o: number; e: number; q: string } | null {
  if (typeof cursor !== 'string' || cursor.length > 200 || !/^[A-Za-z0-9_-]+$/.test(cursor)) return null;
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { v?: unknown; o?: unknown; e?: unknown; q?: unknown };
    const index = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;
    if (value.v !== 2 || !index(value.o) || !index(value.e) || typeof value.q !== 'string') return null;
    return { o: value.o, e: value.e, q: value.q };
  } catch {
    return null;
  }
}
