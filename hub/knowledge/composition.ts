// The composition of a root (K01 R[7]) in one record or, when large, in part records beside it: content-defined splitting
// for writes (a boundary falls after a row whose digest has a fixed residue, so an insertion moves only the boundaries
// around it and unchanged parts are shared between roots), and one reader over both forms: the rows at a path (binary
// search over the parts' path ranges), a scan of every row with its entry content, the unplaced rows with the content of
// their entry records (read in batches; a part row does not carry it) and the sources.
import type {
  CompositionContentRow,
  CompositionPartRef,
  CompositionRow,
  CompositionRowsPartRef,
  RootSource,
  TreeRootBody,
  UnplacedRow,
} from '../../contracts/src/knowledge.ts';
import { chunks } from './concurrency.ts';
import { compareText, type EntryContent } from './digest.ts';
import { SCHEMAS, type KnowledgeStore, type RowsReadHandle } from './store.ts';

/** Average rows of a part (a boundary after a row whose digest's leading 32 bits are 0 modulo this). */
export const PART_TARGET_ROWS = 512;
/** No part ends before this many rows, unless the rows end. */
export const PART_MIN_ROWS = 64;
/** A part ends at this many rows or about this many bytes, whatever the digests say. */
export const PART_MAX_ROWS = 2048;
export const PART_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Splits rows (already in their sort order) into parts at content-defined boundaries: after a row whose key (a hex digest)
 * falls on the boundary residue once the part has PART_MIN_ROWS rows, or when the part reaches PART_MAX_ROWS rows or
 * about PART_MAX_BYTES (estimated by `size`).
 */
export function splitRows<R>(rows: readonly R[], key: (row: R) => string, size: (row: R) => number): R[][] {
  const out: R[][] = [];
  let part: R[] = [];
  let bytes = 0;
  for (const row of rows) {
    part.push(row);
    bytes += size(row);
    const residue = Number.parseInt(key(row).slice(0, 8), 16) % PART_TARGET_ROWS;
    if ((part.length >= PART_MIN_ROWS && residue === 0) || part.length >= PART_MAX_ROWS || bytes >= PART_MAX_BYTES) {
      out.push(part);
      part = [];
      bytes = 0;
    }
  }
  if (part.length > 0) out.push(part);
  return out;
}

/** A row the reader hands out: content is present for rows of parts (inline rows carry none). */
export type ReadRow = CompositionRow & { content?: EntryContent };

function contentOf(row: CompositionContentRow): ReadRow {
  const { statement, data, applicability, ...plain } = row;
  return { ...plain, content: { kind: row.kind, statement, data, applicability } };
}

/** Index of the first part whose last key is >= `key` (parts sorted, non-decreasing keys). */
function firstPartAtOrAfter(parts: readonly CompositionPartRef[], key: string): number {
  let lo = 0;
  let hi = parts.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (compareText(parts[mid].last, key) < 0) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** One composition record with its parts, read lazily. */
export class CompositionView {
  readonly record: string;
  readonly body: TreeRootBody;
  readonly #store: KnowledgeStore;
  #byPath: Map<string, Map<string, CompositionRow>> | null = null;
  #groups: CompositionRowsPartRef[][] | null = null;

  constructor(store: KnowledgeStore, record: string, body: TreeRootBody) {
    this.#store = store;
    this.record = record;
    this.body = body;
  }

  get parted(): boolean {
    return this.body.parts !== undefined;
  }

  /** The row parts grouped by kind, each group in path order. */
  #kindGroups(): CompositionRowsPartRef[][] {
    if (this.#groups === null) {
      const groups = new Map<string, CompositionRowsPartRef[]>();
      for (const ref of this.body.parts?.composition ?? []) {
        const group = groups.get(ref.kind);
        if (group === undefined) groups.set(ref.kind, [ref]);
        else group.push(ref);
      }
      this.#groups = [...groups.values()];
    }
    return this.#groups;
  }

  #inline(): Map<string, Map<string, CompositionRow>> {
    if (this.#byPath === null) {
      const rows = new Map<string, Map<string, CompositionRow>>();
      for (const row of this.body.composition) {
        const at = rows.get(row.path) ?? new Map<string, CompositionRow>();
        at.set(row.entry, row);
        rows.set(row.path, at);
      }
      this.#byPath = rows;
    }
    return this.#byPath;
  }

  async #rowsPart(ref: CompositionPartRef, cache = true): Promise<CompositionContentRow[]> {
    const part = await this.#store.part(SCHEMAS.rowsPart, ref.record, { cache });
    if (part === null) throw new Error(`composition part ${ref.record} is missing`);
    return part.rows;
  }

  /** The rows at one path, by entry digest. */
  async rowsAt(path: string): Promise<Map<string, ReadRow>> {
    if (!this.parted) return new Map(this.#inline().get(path) ?? []);
    const out = new Map<string, ReadRow>();
    for (const parts of this.#kindGroups()) {
      for (let i = firstPartAtOrAfter(parts, path); i < parts.length && compareText(parts[i].first, path) <= 0; i++) {
        for (const row of await this.#rowsPart(parts[i])) if (row.path === path) out.set(row.entry, contentOf(row));
      }
    }
    return out;
  }

  /**
   * Every row of the kinds (all kinds when absent); within a kind in path then entry order. Parts are read one at a time
   * without filling the cache, and only the parts of the kinds asked for.
   */
  async *rows(kinds?: ReadonlySet<string>): AsyncGenerator<ReadRow> {
    if (!this.parted) {
      for (const row of this.body.composition) if (kinds === undefined || kinds.has(row.kind)) yield row;
      return;
    }
    for (const ref of this.body.parts?.composition ?? []) {
      if (kinds !== undefined && !kinds.has(ref.kind)) continue;
      for (const row of await this.#rowsPart(ref, false)) yield contentOf(row);
    }
  }

  /**
   * Every row of the kinds that passes `keep`, with its entry content: from the parts, or for an inline composition from the
   * entry records (read a few at a time). Rows whose entry record cannot be found are left out.
   */
  async *contentRows(kinds: ReadonlySet<string> | undefined, keep: (row: CompositionRow) => boolean = () => true): AsyncGenerator<CompositionRow & { content: EntryContent }> {
    if (this.parted) {
      for await (const row of this.rows(kinds)) if (row.content !== undefined && keep(row)) yield row as CompositionRow & { content: EntryContent };
      return;
    }
    const kept = this.body.composition.filter((row) => (kinds === undefined || kinds.has(row.kind)) && keep(row));
    for (const group of chunks(kept, 64)) {
      const contents = await this.#store.entries(group.map(row => row.entry),undefined,{cache:false});
      const filled = group.map(row => { const content = contents.get(row.entry); return content === undefined ? null : { ...row, content }; });
      for (const row of filled) if (row !== null) yield row;
    }
  }

  /** Synchronous entry consumers avoid one promise chain per row while parts still stream one at a time. */
  async forEachEntry(kind: string, consume: (entry: string, path: string, content: EntryContent, unplaced: boolean) => void, validated?: RowsReadHandle): Promise<void> {
    const seen = new Set<string>();
    const emit = (entry: string, path: string, content: EntryContent, unplaced: boolean) => {
      if (seen.has(entry)) return;
      // A parsed string can be a slice of a whole part. Keep only an owned digest in the seen set.
      const owned = Buffer.from(entry).toString(); seen.add(owned); consume(owned, path, content, unplaced);
    };
    if (this.parted) {
      for (const group of chunks((this.body.parts?.composition ?? []).filter(ref => ref.kind === kind), 2)) {
        await this.#store.forEachRowsParts(group.map(ref => ref.record), row => emit(row.entry, row.path, { kind: row.kind, statement: row.statement, data: row.data, applicability: row.applicability }, false), validated);
      }
    } else {
      for (const group of chunks(this.body.composition.filter(row => row.kind === kind), 128)) {
        const contents = await this.#store.entries(group.map(row => row.entry),undefined,{cache:false});
        for (const row of group) { const content = contents.get(row.entry); if (content) emit(row.entry, row.path, content, false); }
      }
    }
    const batch: string[] = [];
    const flush = async () => { const group = batch.splice(0); const contents = await this.#store.entries(group,undefined,{cache:false}); for (const entry of group) { const content = contents.get(entry); if (content) emit(entry, '/', content, true); } };
    for await (const row of this.unplacedRows(kind)) { batch.push(row.entry); if (batch.length >= 128) await flush(); }
    if (batch.length) await flush();
  }

  /** contentRows collected. */
  async rowsWithContent(kinds: ReadonlySet<string> | undefined, keep: (row: CompositionRow) => boolean = () => true): Promise<Array<CompositionRow & { content: EntryContent }>> {
    const out: Array<CompositionRow & { content: EntryContent }> = [];
    for await (const row of this.contentRows(kinds, keep)) out.push(row);
    return out;
  }

  /** Composition rows per entry kind: recorded with the composition, else counted. */
  async kindCounts(): Promise<Map<string, number>> {
    if (this.body.kinds !== undefined) return new Map(Object.entries(this.body.kinds));
    const out = new Map<string, number>();
    for await (const row of this.rows()) out.set(row.kind, (out.get(row.kind) ?? 0) + 1);
    return out;
  }

  async unplaced(): Promise<UnplacedRow[]> {
    const out: UnplacedRow[] = [];
    for await (const row of this.unplacedRows()) out.push(row);
    return out;
  }

  /** Unplaced rows, one part at a time. `kind` keeps that entry kind only. */
  async *unplacedRows(kind?: string): AsyncGenerator<UnplacedRow> {
    const wanted = (row: UnplacedRow): boolean => kind === undefined || row.kind === kind;
    const parts = this.body.parts?.unplaced;
    if (parts === undefined) {
      for (const row of this.body.unplaced) if (wanted(row)) yield row;
      return;
    }
    for (const ref of parts) {
      const part = await this.#store.part(SCHEMAS.unplacedPart, ref.record, { cache: false });
      if (part === null) throw new Error(`composition part ${ref.record} is missing`);
      for (const row of part.rows) if (wanted(row)) yield row;
    }
  }

  /**
   * Unplaced rows of one kind with the stored entry content (the part rows do not carry it). Missing entry records are
   * left out. Reads are batched, like contentRows.
   */
  async *unplacedContent(kind: string): AsyncGenerator<{ entry: string; content: EntryContent }> {
    const batch: UnplacedRow[] = [];
    const flush = async (): Promise<Array<{ entry: string; content: EntryContent } | null>> => {
      const group = batch.splice(0, batch.length);
      const contents = await this.#store.entries(group.map(row => row.entry),undefined,{cache:false});
      return group.map(row => { const content = contents.get(row.entry); return content === undefined ? null : { entry: row.entry, content }; });
    };
    for await (const row of this.unplacedRows(kind)) {
      batch.push(row);
      if (batch.length >= 128) for (const item of await flush()) if (item !== null) yield item;
    }
    if (batch.length > 0) for (const item of await flush()) if (item !== null) yield item;
  }

  /** Every source: single slots from the record, list slots from the parts when there are parts. */
  async sources(): Promise<RootSource[]> {
    const parts = this.body.parts?.sources;
    if (parts === undefined) return this.body.sources;
    const out = [...this.body.sources];
    for (const ref of parts) {
      const part = await this.#store.part(SCHEMAS.sourcesPart, ref.record, { cache: false });
      if (part === null) throw new Error(`composition part ${ref.record} is missing`);
      out.push(...part.rows);
    }
    return out;
  }

  /** The sources with these digests. */
  async sourcesOf(shas: ReadonlySet<string>): Promise<RootSource[]> {
    const out = this.body.sources.filter((s) => shas.has(s.sha256));
    const parts = this.body.parts?.sources;
    if (parts === undefined) return out;
    for (const sha of [...shas].sort(compareText)) {
      for (let i = firstPartAtOrAfter(parts, sha); i < parts.length && compareText(parts[i].first, sha) <= 0; i++) {
        const part = await this.#store.part(SCHEMAS.sourcesPart, parts[i].record);
        if (part === null) throw new Error(`composition part ${parts[i].record} is missing`);
        for (const row of part.rows) if (row.sha256 === sha) out.push(row);
      }
    }
    return out;
  }
}
