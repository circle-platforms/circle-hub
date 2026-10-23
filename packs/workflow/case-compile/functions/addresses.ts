// Literal address locations and replacement verification, never plan rewriting.
import { addressKey } from './manifest.ts';
import type { Replacement } from './slots.ts';
export interface LiteralAddress { text: string; at: number; key: string | null }
export function literalAddresses(text: string): LiteralAddress[] {
  const out: LiteralAddress[] = [];
  for (const m of text.matchAll(/(?<![A-Za-z0-9_])(?:\d{1,3}(?:\.\d{1,3}){3}|(?:[0-9a-fA-F]{0,4}:){2,}[0-9a-fA-F:.]*)(?![A-Za-z0-9_])/g)) out.push({ text: m[0], at: m.index, key: addressKey(m[0]) });
  return out;
}
/** Substitute only complete numeric address tokens; a short address never changes the prefix of a longer one. */
export function replacedQuote(text: string, replacements: readonly Replacement[]): string {
  const byKey = new Map(replacements.map((v) => [addressKey(v.case), v.bed]));
  let out = ''; let at = 0;
  for (const token of literalAddresses(text)) { out += text.slice(at, token.at) + (token.key === null ? token.text : byKey.get(token.key) ?? token.text); at = token.at + token.text.length; }
  return out + text.slice(at);
}
export function deniedCommand(text: string, denied: readonly string[]): boolean {
  // Adjacent shell quoting and escaping cannot hide a denied spelling. No shell or Python is executed.
  const normalized = text.normalize('NFKC').replace(/["'`\\]/g, '').toLowerCase().replace(/\s+/g, ' ');
  return denied.some((raw) => { const key = raw.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); return new RegExp(`(^|[^a-z0-9_])${key}($|[^a-z0-9_])`).test(normalized); });
}

/** Host-address classification excludes explicit prefixes and the bed's network/broadcast or mask literals. */
export function isHostLiteral(token: LiteralAddress, text: string, bed: import('./manifest.ts').ManifestBed): boolean {
  if (!token.key) return true; // Invalid colon tokens are handled separately by the lexical classifier.
  const known = bed.devices.flatMap((v) => [...v.ipv4, ...v.ipv6]);
  if (known.some((v) => addressKey(v.address) === token.key)) return true;
  const tail = text.slice(token.at + token.text.length); const before = text.slice(0, token.at);
  if (/^\/[0-9]{1,3}(?![0-9])/.test(tail) && !/https?:\/\/$/i.test(before)) return false;
  if (token.key.startsWith('ipv4:')) {
    const value = BigInt('0x' + token.key.slice('ipv4:'.length)); const all = 0xffffffffn;
    if ((value & (value + 1n)) === 0n || (((all ^ value) & ((all ^ value) + 1n)) === 0n)) return false;
    for (const iface of known.filter((v) => v.family === 'ipv4')) {
      const host = (1n << BigInt(32 - iface.prefix)) - 1n; const network = iface.value & (all ^ host);
      if (value === network || value === (network | host)) return false;
    }
  }
  return true;
}

/** Noncanonical inet_aton-like targets in opaque host commands are unsupported, not declared off-bed facts. */
export function hasAmbiguousIpv4(text: string): boolean {
  for (const match of text.matchAll(/(?<![A-Za-z0-9_.:])(?:0x[0-9a-f]+|[0-9]+)(?:\.(?:0x[0-9a-f]+|[0-9]+)){0,3}(?![A-Za-z0-9_.:])/gi)) {
    const parts = match[0].split('.');
    if (parts.length === 4 && parts.every((v) => /^(?:0|[1-9][0-9]{0,2})$/.test(v) && Number(v) <= 255)) continue;
    if (parts.length === 1 && /^[0-9]+$/.test(parts[0]) && Number(parts[0]) < 16777216) continue;
    try {
      const values = parts.map((part) => /^0x/i.test(part) ? BigInt(part) : /^0[0-7]+$/.test(part) ? BigInt('0o' + part.slice(1)) : BigInt(part));
      const lastBits = BigInt(8 * (5 - values.length));
      if (values.slice(0, -1).every((v) => v <= 255n) && values.at(-1)! < (1n << lastBits)) return true;
    } catch { /* A malformed numeric token is not silently converted into a different address. */ }
  }
  return false;
}
