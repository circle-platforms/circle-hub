// CatalogView: the closed world the catalog interpreter matches against (C07). Entries are addressed by their command words;
// lookup finds the longest head that starts a word sequence. The knowledge package builds a view from tree nodes; this file
// provides the in-memory implementation and a builder for tests.
import { CatalogEntry as CatalogEntryShape, type CatalogEntry, type CatalogSignature } from '../../../contracts/src/tables.ts';

export interface CatalogLookupOptions {
  /** Compare words exactly as written; default: the view's own setting. */
  caseSensitive?: boolean;
}

export interface CatalogMatch {
  entry: CatalogEntry;
  /** How many leading words the head consumed; the rest are arguments. */
  length: number;
}

export interface CatalogView {
  /** Reference of the catalog as a whole (its tree node); the ground of an absence. */
  readonly reference?: string;
  /** Declared complete for its scope (C07 R[0]); only then is absence a fact rather than unknown. */
  readonly complete: boolean;
  /** Words compare exactly when true; lower-cased (after Unicode NFC) when false. */
  readonly caseSensitive: boolean;
  readonly size: number;
  /** The entry whose head is the longest prefix of `words`. */
  lookup(words: readonly string[], options?: CatalogLookupOptions): CatalogMatch | undefined;
  /** The entry whose head is exactly `words`. */
  get(words: readonly string[], options?: CatalogLookupOptions): CatalogEntry | undefined;
  /** Some head starts with `words` (a menu or an entry). */
  hasPrefix(words: readonly string[], options?: CatalogLookupOptions): boolean;
  /** Heads that start with `prefix`, sorted; at most `limit`. */
  heads(prefix?: readonly string[], options?: CatalogLookupOptions & { limit?: number }): string[][];
  /** Every entry, sorted by head. */
  entries(): CatalogEntry[];
}

interface TrieNode {
  children: Map<string, TrieNode>;
  entries: CatalogEntry[];
}

export const foldWord = (word: string): string => word.normalize('NFC').toLowerCase();

/** Exact comparison, as case-sensitive views make it: the same words after Unicode NFC (entry words are stored in NFC). */
const sameWords = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((w, i) => w === b[i] || w.normalize('NFC') === b[i].normalize('NFC'));

class MemoryCatalog implements CatalogView {
  readonly reference?: string;
  readonly complete: boolean;
  readonly caseSensitive: boolean;
  readonly size: number;
  readonly root: TrieNode = { children: new Map(), entries: [] };
  readonly sorted: CatalogEntry[];

  constructor(entries: readonly CatalogEntry[], options: { reference?: string; complete: boolean; caseSensitive: boolean }) {
    this.reference = options.reference;
    this.complete = options.complete;
    this.caseSensitive = options.caseSensitive;
    const merged: CatalogEntry[] = [];
    for (const original of entries) {
      const entry: CatalogEntry = { ...original, words: original.words.map((w) => w.normalize('NFC')) };
      let node = this.root;
      for (const word of entry.words) {
        const key = foldWord(word);
        let child = node.children.get(key);
        if (!child) {
          child = { children: new Map(), entries: [] };
          node.children.set(key, child);
        }
        node = child;
      }
      // Overloads given as separate entries of one head become one entry with several signatures.
      const same = node.entries.find((e) => (this.caseSensitive ? sameWords(e.words, entry.words) : true));
      if (same) {
        same.signatures.push(...entry.signatures.map((s) => ({ ...s })));
      } else {
        const copy: CatalogEntry = { ...entry, words: [...entry.words], signatures: entry.signatures.map((s) => ({ ...s })) };
        node.entries.push(copy);
        merged.push(copy);
      }
    }
    this.size = merged.length;
    this.sorted = merged.sort((a, b) => (a.words.join(' ') < b.words.join(' ') ? -1 : a.words.join(' ') > b.words.join(' ') ? 1 : 0));
  }

  private pick(node: TrieNode, words: readonly string[], exact: boolean): CatalogEntry | undefined {
    if (!exact) return node.entries[0];
    return node.entries.find((e) => sameWords(e.words, words));
  }

  lookup(words: readonly string[], options: CatalogLookupOptions = {}): CatalogMatch | undefined {
    const exact = options.caseSensitive ?? this.caseSensitive;
    let node = this.root;
    let best: CatalogMatch | undefined;
    for (let i = 0; i < words.length; i++) {
      const child = node.children.get(foldWord(words[i]));
      if (!child) break;
      node = child;
      const entry = this.pick(node, words.slice(0, i + 1), exact);
      if (entry) best = { entry, length: i + 1 };
    }
    return best;
  }

  private walk(words: readonly string[], exact: boolean): TrieNode | undefined {
    let node = this.root;
    for (const word of words) {
      const child = node.children.get(foldWord(word));
      if (!child) return undefined;
      node = child;
    }
    if (exact && words.length > 0) {
      // Some head below must spell the prefix exactly.
      const below = this.collect(node, Number.POSITIVE_INFINITY);
      if (!below.some((e) => sameWords(e.words.slice(0, words.length), words))) return undefined;
    }
    return node;
  }

  get(words: readonly string[], options: CatalogLookupOptions = {}): CatalogEntry | undefined {
    const exact = options.caseSensitive ?? this.caseSensitive;
    const node = words.length > 0 ? this.walk(words, false) : undefined;
    return node ? this.pick(node, words, exact) : undefined;
  }

  hasPrefix(words: readonly string[], options: CatalogLookupOptions = {}): boolean {
    if (words.length === 0) return this.size > 0;
    return this.walk(words, options.caseSensitive ?? this.caseSensitive) !== undefined;
  }

  private collect(node: TrieNode, limit: number): CatalogEntry[] {
    const out: CatalogEntry[] = [];
    const stack = [node];
    while (stack.length > 0 && out.length < limit) {
      const at = stack.pop() as TrieNode;
      out.push(...at.entries);
      stack.push(...at.children.values());
    }
    return out;
  }

  heads(prefix: readonly string[] = [], options: CatalogLookupOptions & { limit?: number } = {}): string[][] {
    const exact = options.caseSensitive ?? this.caseSensitive;
    const node = this.walk(prefix, exact);
    if (!node) return [];
    let found = this.collect(node, Number.POSITIVE_INFINITY);
    if (exact) found = found.filter((e) => sameWords(e.words.slice(0, prefix.length), prefix));
    const heads = found.map((e) => [...e.words]).sort((a, b) => (a.join(' ') < b.join(' ') ? -1 : a.join(' ') > b.join(' ') ? 1 : 0));
    return options.limit === undefined ? heads : heads.slice(0, options.limit);
  }

  entries(): CatalogEntry[] {
    return [...this.sorted];
  }
}

export interface CatalogViewOptions {
  reference?: string;
  /** Declared complete for its scope; default false, because absence is only a fact for a complete catalog. */
  complete?: boolean;
  /** Default false: command words are case-insensitive. */
  caseSensitive?: boolean;
}

/** In-memory view over validated entries. Throws TypeError (in Chinese) when an entry does not match catalog-entry@1. */
export function createCatalogView(entries: readonly unknown[], options: CatalogViewOptions = {}): CatalogView {
  const valid: CatalogEntry[] = entries.map((entry, index) => {
    const parsed = CatalogEntryShape.safeParse(entry);
    if (!parsed.success) throw new TypeError(`目录条目 ${index} 不符合 catalog-entry@1：${parsed.error.issues.map((i) => `${i.path.join('/')} ${i.message}`).join('；')}`);
    return parsed.data;
  });
  return new MemoryCatalog(valid, { reference: options.reference, complete: options.complete ?? false, caseSensitive: options.caseSensitive ?? false });
}

/** Builder input for tests: heads as space-separated text, references derived from a root digest when omitted. */
export interface CatalogSpec {
  /** 64-hex root digest used for derived tree references `tree:<root>/<word>/<word>`. */
  root: string;
  complete?: boolean;
  caseSensitive?: boolean;
  entries: { head: string; signatures?: (CatalogSignature['params'] | CatalogSignature)[]; reference?: string; summary?: string }[];
}

export function buildCatalog(spec: CatalogSpec): CatalogView {
  const entries = spec.entries.map((e) => {
    const words = e.head.split(/\s+/).filter(Boolean);
    const signatures = (e.signatures ?? []).map((s, i): CatalogSignature => (Array.isArray(s) ? { id: `${words.join(' ')}#${i + 1}`, params: s } : s));
    const reference = e.reference ?? `tree:${spec.root}/${words.map((w) => encodeURIComponent(w)).join('/')}`;
    return { words, signatures, reference, ...(e.summary ? { summary: e.summary } : {}) };
  });
  return createCatalogView(entries, { reference: `tree:${spec.root}/`, complete: spec.complete ?? true, caseSensitive: spec.caseSensitive });
}
