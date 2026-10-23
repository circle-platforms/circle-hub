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
  const normalized = text.replace(/["'`\\]/g, '').toLowerCase().replace(/\s+/g, ' ');
  return denied.some((raw) => { const key = raw.toLowerCase().replace(/\s+/g, ' ').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); return new RegExp(`(^|[^a-z0-9_])${key}($|[^a-z0-9_])`).test(normalized); });
}
