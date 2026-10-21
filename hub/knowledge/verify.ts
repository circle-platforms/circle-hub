// What the Hub checks before an entry is hung on the tree (K02 R[0]): every fragment exists in the stored source it names,
// and the path is well formed. Only existence: the statement is the producer's and need not be verbatim (K02 R[4]).
// The bytes were hashed once when the source was loaded, so a fragment is located in the parsed document directly
// (what resolveReference does for src after its digest check) instead of re-hashing megabytes per fragment.
import { TreePath } from '../../contracts/src/reference.ts';
import type { FragmentRef } from '../../contracts/src/product.ts';
import { ReferenceSyntaxError, pathOf, pathSegments, sliceUtf8, srcFragment } from '../refs/api.ts';
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
 * Locates one fragment in the source of its slot. `slots` maps every declared input slot to its parsed source, or null
 * when an optional source could not be read.
 */
export function verifyFragment(fragment: FragmentRef, slots: ReadonlyMap<string, ParsedSource | null>, loader: SourceLoader): Checked<VerifiedFragment> {
  let slot = fragment.slot;
  if (slot === undefined) {
    if (slots.size !== 1) return { ok: false, reason: '生产器有不止一个输入槽，片段必须写明 slot' };
    slot = [...slots.keys()][0];
  }
  if (!slots.has(slot)) return { ok: false, reason: `片段指向的输入槽 ${slot} 没有声明` };
  const source = slots.get(slot) ?? null;
  if (source === null) return { ok: false, reason: `输入槽 ${slot} 没有读到源文件` };
  try {
    srcFragment(source.sha256, fragment.parser, fragment.selector, fragment.range);
  } catch (error) {
    if (error instanceof ReferenceSyntaxError) return { ok: false, reason: `片段引用写法不对：${error.message}` };
    throw error;
  }
  const document = fragment.parser === source.parser ? source.document : loader.documentWith(source, fragment.parser);
  if (document === null) return { ok: false, reason: `解析器 ${fragment.parser} 没有登记，或不能解析源文件 ${source.sha256}` };
  const located = document.locate(fragment.selector);
  if (located === null) return { ok: false, reason: `片段 ${fragment.selector.slice(0, 200)} 在源文件 ${source.sha256} 里找不到` };
  if (fragment.range !== undefined && sliceUtf8(located.text, fragment.range[0], fragment.range[1]) === null) {
    return { ok: false, reason: `字节范围 [${fragment.range[0]}, ${fragment.range[1]}) 超出片段，或没有落在字符边界上` };
  }
  return { ok: true, value: { reference: srcFragment(source.sha256, fragment.parser, located.selector, fragment.range), sha256: source.sha256, slot } };
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
