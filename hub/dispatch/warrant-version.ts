// The pack version a function warrant names. The fact a function check of a workflow pack produces is identified as
// `<pack>.<check>@<x.y.z>` (the run engine's rule of a pack function); an interpreter rule of the core has another form and
// names no pack version. An executor names one such identity (proof.warrant_id), so a new version of the pack leaves the
// executor behind until its definition is updated: these helpers let the Hub say so in words.
import { PackId, PackVersion } from '../../contracts/src/common.ts';

export interface PackWarrant { pack: string; check: string; version: string }

const CHECK = /^[A-Za-z0-9_.-]{1,80}$/;

/** `<pack>.<check>@<x.y.z>` taken apart; null for every other identity. */
export function packWarrant(id: unknown): PackWarrant | null {
  if (typeof id !== 'string' || id.length > 200) return null;
  const dot = id.indexOf('.'), at = id.lastIndexOf('@');
  if (dot < 1 || at < dot + 2) return null;
  const pack = id.slice(0, dot), check = id.slice(dot + 1, at), version = id.slice(at + 1);
  return PackId.safeParse(pack).success && CHECK.test(check) && PackVersion.safeParse(version).success ? { pack, check, version } : null;
}

/** Both name the same function of the same pack and differ only in the pack's version; null for every other pair. */
export function versionsApart(expected: unknown, actual: unknown): { expected: PackWarrant; actual: PackWarrant } | null {
  const left = packWarrant(expected), right = packWarrant(actual);
  return left && right && left.pack === right.pack && left.check === right.check && left.version !== right.version ? { expected: left, actual: right } : null;
}

/** Order of two `x.y.z` versions, segment by segment as integers; negative when a comes first. */
export function versionOrder(a: string, b: string): number {
  const left = a.split('.').map((part) => BigInt(part)), right = b.split('.').map((part) => BigInt(part));
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  return 0;
}

/**
 * What an executor names and what it would name for the version of its pack that is in use. Null when the two agree, when
 * no version of the pack is in use, or when the warrant is not a function of that pack (nothing to compare, nothing said).
 */
export function staleWarrant(warrantId: unknown, pack: string, inUse: string | null | undefined): { named: string; wanted: string } | null {
  const named = packWarrant(warrantId);
  if (!named || named.pack !== pack || typeof inUse !== 'string' || !PackVersion.safeParse(inUse).success || named.version === inUse) return null;
  return { named: `${named.pack}.${named.check}@${named.version}`, wanted: `${named.pack}.${named.check}@${inUse}` };
}
