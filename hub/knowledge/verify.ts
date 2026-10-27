// What the Hub checks before an entry is hung on the tree (K02 R[0]): every fragment exists in the stored source it names,
// and the path is well formed. Only existence: the statement is the producer's and need not be verbatim (K02 R[4]).
// The bytes were hashed once when the source was loaded, so a fragment is located in the parsed document directly
// (what resolveReference does for src after its digest check) instead of re-hashing megabytes per fragment.
import { TreePath } from '../../contracts/src/reference.ts';
import type { FragmentRef } from '../../contracts/src/product.ts';
import { ParseError, ReferenceSyntaxError, pathOf, pathSegments, sliceUtf8, srcFragment, type ParsedDocument } from '../refs/api.ts';
import type { ParsedSource, SourceLoader } from './sources.ts';
import { MAX_TREE_DEPTH } from './tree.ts';

export type Checked<T> = { ok: true; value: T } | { ok: false; reason: string };

export interface VerifiedFragment {
  /** Canonical src reference with the parser's canonical selector. */
  reference: string;
  /** Digest of the source it is in. */
  sha256: string;
  slot: string;
}

/**
 * The sources one producer call can cite: every single slot (null when an optional source could not be read) and, for a
 * producer with a list slot, the elements of this call's batch by digest.
 */
export interface FragmentSources {
  single: ReadonlyMap<string, ParsedSource | null>;
  list: { slot: string; elements: ReadonlyMap<string, ParsedSource> } | null;
}

/** Sources of a producer without a list slot. */
export function singleSources(slots: ReadonlyMap<string, ParsedSource | null>): FragmentSources {
  return { single: slots, list: null };
}

/**
 * Locates one fragment in the source it names: the source of its slot, or for a list slot the element of the batch whose
 * digest the fragment gives as `source` (an element of another batch is not citable: an entry must not depend on another
 * batch).
 */
export async function verifyFragment(fragment: FragmentRef, sources: FragmentSources, loader: SourceLoader, prepared?: ParsedDocument | null): Promise<Checked<VerifiedFragment>> {
  let slot = fragment.slot;
  if (slot === undefined) {
    const names = [...sources.single.keys(), ...(sources.list === null ? [] : [sources.list.slot])];
    if (names.length !== 1) return { ok: false, reason: '生产器有不止一个输入槽，片段必须写明 slot' };
    slot = names[0];
  }
  let source: ParsedSource | null;
  if (sources.list !== null && slot === sources.list.slot) {
    if (fragment.source === undefined) return { ok: false, reason: `列表输入槽 ${slot} 的片段必须用 source 写明它在这一批的哪份源文件里（那份源文件的摘要）` };
    source = sources.list.elements.get(fragment.source) ?? null;
    if (source === null) return { ok: false, reason: `片段写的源文件 ${fragment.source} 不在这一批的输入槽 ${slot} 里` };
  } else {
    if (!sources.single.has(slot)) return { ok: false, reason: `片段指向的输入槽 ${slot} 没有声明` };
    source = sources.single.get(slot) ?? null;
    if (source === null) return { ok: false, reason: `输入槽 ${slot} 没有读到源文件` };
    if (fragment.source !== undefined && fragment.source !== source.sha256) return { ok: false, reason: `片段写的源文件 ${fragment.source} 不是输入槽 ${slot} 的源文件` };
  }
  try {
    srcFragment(source.sha256, fragment.parser, fragment.selector, fragment.range);
  } catch (error) {
    if (error instanceof ReferenceSyntaxError) return { ok: false, reason: `片段引用写法不对：${error.message}` };
    throw error;
  }
  const document = prepared !== undefined ? prepared : fragment.parser === source.parser ? source.document : await loader.documentWith(source, fragment.parser);
  if (document === null) return { ok: false, reason: `解析器 ${fragment.parser} 没有登记，或不能解析源文件 ${source.sha256}` };
  const located = await document.locate(fragment.selector);
  if (located === null) return { ok: false, reason: `片段 ${fragment.selector.slice(0, 200)} 在源文件 ${source.sha256} 里找不到` };
  if (fragment.range !== undefined && sliceUtf8(located.text, fragment.range[0], fragment.range[1]) === null) {
    return { ok: false, reason: `字节范围 [${fragment.range[0]}, ${fragment.range[1]}) 超出片段，或没有落在字符边界上` };
  }
  return { ok: true, value: { reference: srcFragment(source.sha256, fragment.parser, located.selector, fragment.range), sha256: source.sha256, slot } };
}

/** Loads every selector of one producer output before the per-fragment checks. A missing source stays a per-fragment refusal. */
export async function prefetchFragmentSelectors(fragments: readonly FragmentRef[], sources: FragmentSources, loader: SourceLoader): Promise<Map<FragmentRef, Checked<VerifiedFragment>>> {
  // Group by immutable source identity before opening alternate parsers. Grouping
  // by a parsed-document object first can thrash the loader's bounded cache when
  // producer output interleaves more documents than that cache holds.
  const groups = new Map<string, { source: ParsedSource; parser: string; fragments: FragmentRef[] }>();
  for (const fragment of fragments) {
    let slot = fragment.slot;
    if (slot === undefined) {
      const names = [...sources.single.keys(), ...(sources.list === null ? [] : [sources.list.slot])];
      if (names.length !== 1) continue;
      slot = names[0];
    }
    let source: ParsedSource | null;
    if (sources.list !== null && slot === sources.list.slot) source = fragment.source === undefined ? null : sources.list.elements.get(fragment.source) ?? null;
    else {
      source = sources.single.get(slot) ?? null;
      if (source !== null && fragment.source !== undefined && fragment.source !== source.sha256) source = null;
    }
    if (source === null) continue;
    const key = `${source.sha256}\u0000${source.mediaType}\u0000${fragment.parser}`;
    const group = groups.get(key) ?? {source, parser:fragment.parser, fragments:[]};
    group.fragments.push(fragment);
    groups.set(key, group);
  }
  const results = new Map<FragmentRef, Checked<VerifiedFragment>>();
  for (const group of groups.values()) {
    let document:ParsedDocument|null;
    try{document=group.parser === group.source.parser ? group.source.document : await loader.documentWith(group.source, group.parser);}
    catch(error){if(error instanceof ParseError)continue;throw error;}
    if (document?.prefetch) await document.prefetch(group.fragments.map(fragment => fragment.selector));
    // Resolve while this document is still in the loader cache; retain only the
    // small checked references rather than pinning every full source document.
    for (const fragment of group.fragments) results.set(fragment, await verifyFragment(fragment, sources, loader, document));
  }
  return results;
}

export interface CheckedPath {
  segments: string[];
  /** Canonical path text after Unicode NFC of every segment. */
  path: string;
}

/** A producer's path must be canonical tree path text (hub/refs grammar); segments are kept in NFC. */
export function checkPath(path: string): Checked<CheckedPath> {
  if (!TreePath.safeParse(path).success) return { ok: false, reason: `路径 ${path.slice(0, 200)} 不是规范的知识树路径（以 / 开头，段非空，特殊字符按百分号转义）` };
  let segments: string[];
  try {
    segments = pathSegments(path).map((segment) => segment.normalize('NFC'));
  } catch (error) {
    if (error instanceof ReferenceSyntaxError) return { ok: false, reason: `路径 ${path.slice(0, 200)} 写法不对：${error.message}` };
    throw error;
  }
  if (segments.length > MAX_TREE_DEPTH) return { ok: false, reason: `路径超过 ${MAX_TREE_DEPTH} 层` };
  return { ok: true, value: { segments, path: pathOf(segments) } };
}
