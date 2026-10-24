// Normalisation and digests of the knowledge tree (K01 R[1], R[7]; K02 R[4]). A node digest covers its name, its children's
// names and digests and its entry digests; an entry digest covers kind, normalised statement, data and applicability. No
// source digest enters either, so unchanged content of two builds gives equal digests and shared subtrees.
import type { Applicability } from '../../contracts/src/product.ts';
import { canonicalize, canonicalByteLength, sha256Hex } from '../records/api.ts';
import type { TreeNodeChild } from '../../contracts/src/knowledge.ts';

/** The content an entry digest covers. */
export interface EntryContent {
  kind: string;
  statement: string;
  data: Record<string, unknown>;
  applicability: Applicability | null;
}

/** The content a node digest covers. */
export interface NodeContent {
  name: string;
  children: TreeNodeChild[];
  entries: string[];
}

/** Code-unit order, the order RFC 8785 sorts member names in; used for every sorted list of the tree. */
export function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The canonical statement: Unicode NFC, NUL removed (PostgreSQL text refuses it), line breaks as LF, trailing white space
 * of every line and leading and trailing empty lines removed. Inner spacing and indentation stay as the producer wrote them.
 */
export function normaliseStatement(text: string): string {
  const lines = text.normalize('NFC').replaceAll('\u0000', '').replace(/\r\n?/g, '\n').split('\n');
  const trimmed = lines.map((line) => line.replace(/[\t\f\v  　]+$/u, ''));
  let start = 0;
  let end = trimmed.length;
  while (start < end && trimmed[start] === '') start++;
  while (end > start && trimmed[end - 1] === '') end--;
  return trimmed.slice(start, end).join('\n');
}

const uniqueSorted = (values: readonly string[]): string[] => [...new Set(values.map((v) => v.normalize('NFC')))].sort(compareText);

/** Applicability with every list sorted and without repeats; null (未声明) stays null. */
export function normaliseApplicability(applicability: Applicability | null): Applicability | null {
  if (applicability === null) return null;
  const out: Applicability = {};
  if (applicability.builds !== undefined) out.builds = uniqueSorted(applicability.builds);
  if (applicability.platforms !== undefined) out.platforms = uniqueSorted(applicability.platforms);
  if (applicability.models !== undefined) out.models = uniqueSorted(applicability.models);
  if(applicability.components!==undefined)out.components={...(applicability.components.with!==undefined?{with:uniqueSorted(applicability.components.with)}:{}),...(applicability.components.without!==undefined?{without:uniqueSorted(applicability.components.without)}:{})};
  if(applicability.memory!==undefined)out.memory={...applicability.memory,...(applicability.memory.minimum?{minimum:{...applicability.memory.minimum}}:{}),...(applicability.memory.maximum?{maximum:{...applicability.memory.maximum}}:{})};
  if(applicability.licenses!==undefined)out.licenses=uniqueSorted(applicability.licenses);
  if(applicability.deployment_forms!==undefined)out.deployment_forms=uniqueSorted(applicability.deployment_forms);
  if(applicability.inherited!==undefined)out.inherited=[...new Set(applicability.inherited)].sort(compareText);
  return out;
}

/** The normalised content of a produced entry. Throws TypeError when data is not canonical JSON. */
export function entryContentOf(entry: { kind: string; statement: string; data: Record<string, unknown>; applicability: Applicability | null }): EntryContent {
  const content: EntryContent = {
    kind: entry.kind.normalize('NFC'),
    statement: normaliseStatement(entry.statement),
    data: entry.data,
    applicability: normaliseApplicability(entry.applicability),
  };
  canonicalize(content.data);
  return content;
}

/** The single canonical recipe shared by entry hashing and operation-scoped batch encoders. */
export function entryCanonical(content:EntryContent,encode:(value:unknown)=>string=canonicalize):string {
  return encode({kind:content.kind,statement:content.statement,data:content.data,applicability:content.applicability});
}

export function entryDigest(content: EntryContent): string {
  return sha256Hex(entryCanonical(content));
}

export function nodeDigest(content: NodeContent): string {
  return sha256Hex(
    canonicalize({ name: content.name, children: content.children.map((c) => ({ name: c.name, digest: c.digest })), entries: [...content.entries] }),
  );
}

/** UTF-8 size of the canonical JSON of a value. */
export function canonicalSize(value: unknown): number {
  return canonicalByteLength(value);
}

/**
 * Text that can be stored and shown: lone surrogates become U+FFFD and at most `max` UTF-16 units are kept, never splitting a
 * surrogate pair (a cut pair would make a string that canonical JSON and the typed-judgment service refuse).
 */
export function cutText(text: string, max: number): string {
  const safe = text.isWellFormed() ? text : text.toWellFormed();
  if (safe.length <= max) return safe;
  const end = max > 0 && safe.charCodeAt(max - 1) >= 0xd800 && safe.charCodeAt(max - 1) <= 0xdbff ? max - 1 : max;
  return safe.slice(0, Math.max(0, end));
}
