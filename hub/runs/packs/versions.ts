// Pack versions and references: `x.y.z` compared segment by segment as integers, and `id` or `id@x.y.z` references.
import { PackId, PackVersion } from '../../../contracts/src/common.ts';

/** Longest `id@x.y.z` a reference may have; a version longer than this cannot be named, so it is never published. */
export const MAX_PACK_REF_LENGTH = 100;

/** True for a version the contracts accept that has no leading zero in any segment, so each number has one spelling. */
export function isCanonicalVersion(version: string): boolean {
  return PackVersion.safeParse(version).success && version.split('.').every((part) => part === '0' || !part.startsWith('0'));
}

/** Semantic version order of two `x.y.z` versions (integers of any length); negative when a comes first. */
export function compareVersions(a: string, b: string): number {
  const left = a.split('.').map((part) => BigInt(part));
  const right = b.split('.').map((part) => BigInt(part));
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const x = left[i] ?? 0n;
    const y = right[i] ?? 0n;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** The highest of some versions, or null. */
export function highestVersion(versions: readonly string[]): string | null {
  let best: string | null = null;
  for (const version of versions) if (best === null || compareVersions(version, best) > 0) best = version;
  return best;
}

export interface PackRef {
  id: string;
  /** Null asks for the latest published version. */
  version: string | null;
}

/** `id` or `id@x.y.z`; null for anything else (a malformed reference has no answer, like an unknown one). */
export function parsePackRef(ref: unknown): PackRef | null {
  if (typeof ref !== 'string' || ref.length > MAX_PACK_REF_LENGTH) return null;
  const at = ref.indexOf('@');
  const id = at < 0 ? ref : ref.slice(0, at);
  const version = at < 0 ? null : ref.slice(at + 1);
  if (!PackId.safeParse(id).success) return null;
  if (version !== null && !isCanonicalVersion(version)) return null;
  return { id, version };
}

/** The object of a publication record: `id@x.y.z`. */
export const packVersionKey = (id: string, version: string): string => `${id}@${version}`;
