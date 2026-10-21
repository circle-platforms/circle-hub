// The reading side of the knowledge tree: permission (the reader is an admin, or a pack assigned to them binds the product of
// the root; absent and forbidden are the same null, D05 R[3]), get_nodes pages with coverage, the TreeReader hub/refs resolves
// tree and entry references with (grounds from the version's composition, B01 R[5], K02 R[2]), the closed catalog of a root
// (C07), the diff of two roots and the provenance of an entry.
import { createHash } from 'node:crypto';
import { EntryKindSchema } from '../../contracts/generated/vocabulary.ts';
import type { CompositionRow, TreeNodeBody, TreeRootBody } from '../../contracts/src/knowledge.ts';
import type { Applicability } from '../../contracts/src/product.ts';
import { TreePath } from '../../contracts/src/reference.ts';
import type { NodesPage, NodesQuery, NodeViews, RootDiff } from '../ports.ts';
import type { Principal } from '../records/api.ts';
import { ReferenceSyntaxError, parseReference, pathOf, pathSegments, treeReference } from '../refs/api.ts';
import type { JsonValue, ReaderIdentity, TreeRead, TreeReader } from '../refs/api.ts';
import { createCatalogView, type CatalogEntry, type CatalogView } from '../rules/api.ts';
import type { KnowledgeContext } from './context.ts';
import { canonicalSize, compareText, cutText, type EntryContent } from './digest.ts';
import { catalogData } from './produce.ts';
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

/** The rows of one composition by path and entry. */
export interface CompositionIndex {
  record: string;
  body: TreeRootBody;
  rows: Map<string, Map<string, CompositionRow>>;
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

function indexOf(record: string, body: TreeRootBody): CompositionIndex {
  const rows = new Map<string, Map<string, CompositionRow>>();
  for (const row of body.composition) {
    const at = rows.get(row.path) ?? new Map<string, CompositionRow>();
    at.set(row.entry, row);
    rows.set(row.path, at);
  }
  return { record, body, rows };
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

async function mapLimited<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

export class TreeReading {
  readonly #context: KnowledgeContext;
  readonly #products = new Map<string, { products: Set<string>; at: number }>();
  readonly #indexes = new Lru<string, CompositionIndex>(8);
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
  async compositionOf(root: string): Promise<CompositionIndex | null> {
    const productions = await this.#context.store.productionsOfRoot(root);
    const latest = productions[productions.length - 1];
    if (latest === undefined) return null;
    return this.#index(latest);
  }

  /** Every composition of a root (one per production, a composition once), newest first. */
  async compositionsOf(root: string): Promise<CompositionIndex[]> {
    const productions = await this.#context.store.productionsOfRoot(root);
    const out: CompositionIndex[] = [];
    const seen = new Set<string>();
    for (let i = productions.length - 1; i >= 0; i--) {
      const digest = productions[i].detail.composition as string;
      if (seen.has(digest)) continue;
      seen.add(digest);
      const index = await this.#index(productions[i]);
      if (index !== null) out.push(index);
    }
    return out;
  }

  async #index(production: ProduceAction): Promise<CompositionIndex | null> {
    const digest = production.detail.composition as string;
    const cached = this.#indexes.get(digest);
    if (cached !== undefined) return cached;
    const body = await this.#context.store.composition(digest);
    if (body === null) return null;
    const index = indexOf(digest, body);
    this.#indexes.set(digest, index);
    return index;
  }

  async #entries(digests: readonly string[]): Promise<Array<{ digest: string; content: EntryContent }>> {
    const out: Array<{ digest: string; content: EntryContent }> = [];
    for (const digest of digests) {
      const content = await this.#context.store.entry(digest);
      if (content !== null) out.push({ digest, content });
    }
    return out.sort((a, b) => compareText(a.content.kind, b.content.kind) || compareText(a.content.statement, b.content.statement) || compareText(a.digest, b.digest));
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
          const entries = await this.#entries(node.entries);
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
          page.push(this.#view(root, segments, digest, node, composition, entries.slice(start, taken)));
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

  #view(root: string, segments: string[], digest: string, node: TreeNodeBody, composition: CompositionIndex | null, entries: Array<{ digest: string; content: EntryContent }>): NodeViews[number] {
    const path = pathOf(segments);
    const rows = composition?.rows.get(path);
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
    const groundsOf = (digests: readonly string[]): { grounds: string[]; tagged: Array<{ composition: string; build: string; grounds: string[] }> } => {
      const grounds: string[] = [];
      const tagged = compositions.map((c) => {
        const own: string[] = [];
        const rows = c.rows.get(canonical);
        for (const digest of digests) for (const fragment of rows?.get(digest)?.fragments ?? []) if (!own.includes(fragment)) own.push(fragment);
        for (const fragment of own) if (!grounds.includes(fragment)) grounds.push(fragment);
        return { composition: c.record, build: c.body.build.name, grounds: own };
      });
      return { grounds, tagged };
    };
    if (entry !== null) {
      if (!found.node.entries.includes(entry)) return null;
      const content = await this.#context.store.entry(entry);
      if (content === null) return null;
      const { grounds, tagged } = groundsOf([entry]);
      return {
        text: content.statement,
        mediaType: 'text/plain',
        readTier: 'model_readable',
        data: { kind: content.kind, data: content.data, applicability: content.applicability } as JsonValue,
        grounds,
        validity: {
          status: 'valid',
          bound: [root, entry],
          premises: content.applicability === null ? [...premises, `适用条件：${UNDECLARED}`] : premises,
          compositions: tagged,
        },
      };
    }
    const entries = await this.#entries(found.node.entries);
    const { grounds, tagged } = groundsOf(entries.map((e) => e.digest));
    const text = entries.length > 0 ? entries.map((e) => e.content.statement).join('\n\n') : found.node.children.map((c) => c.name).join('\n');
    return {
      text,
      mediaType: 'text/plain',
      readTier: 'model_readable',
      data: { name: found.node.name, level: found.node.level, children: found.node.children.map((c) => c.name), entries: [...found.node.entries] },
      grounds,
      validity: { status: 'valid', bound: [root], premises, compositions: tagged },
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
      const index = await this.#index(productions[i]);
      const declaration = index?.body.catalogs.find((c) => c.id === catalogId);
      if (index === null || declaration === undefined) continue;
      const key = `${root}\u0000${catalogId}\u0000${index.record}`;
      const cached = this.#catalogs.get(key);
      if (cached !== undefined) return cached;
      // Members: entries of the declared kind, of the declared producer when the catalog names one (product@1 catalogs).
      const producer = declaration.producer;
      const rows = index.body.composition.filter((row) => row.kind === declaration.entry_kind && (producer === undefined || row.producers.includes(producer)));
      const members = await mapLimited(rows, 16, async (row) => {
        const content = await this.#context.store.entry(row.entry);
        const data = content === null ? null : catalogData(content.data);
        if (data === null) return null;
        const entry: CatalogEntry = { words: data.words, signatures: data.signatures, reference: treeReference(root, row.path, row.entry) };
        if (data.summary !== undefined) entry.summary = data.summary;
        return { entry, segments: pathSegments(row.path) };
      });
      const kept = members.filter((m): m is { entry: CatalogEntry; segments: string[] } => m !== null);
      const view =
        kept.length === 0
          ? null
          : createCatalogView(
              kept.map((m) => m.entry),
              { reference: treeReference(root, pathOf(commonAncestor(kept.map((m) => m.segments)))), complete: declaration.complete, caseSensitive: declaration.case_sensitive },
            );
      this.#catalogs.set(key, view);
      return view;
    }
    return null;
  }

  // ------------------------------------------------------------ diff

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
      const index = await this.#index(production);
      const rows = index?.rows.get(path);
      if (index === null || rows === undefined) continue;
      for (const row of rows.values()) {
        if (parsed.entry !== undefined && row.entry !== parsed.entry) continue;
        const shas = new Set(row.fragments.map((fragment) => fragment.slice(4, 68)));
        out.push({
          root: parsed.root,
          composition: index.record,
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
          sources: index.body.sources
            .filter((s) => shas.has(s.sha256))
            .map((s) => ({ sha256: s.sha256, external: s.external, media_type: s.media_type, read_tier: s.read_tier, basis: s.basis, decided_by: s.decided_by })),
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
