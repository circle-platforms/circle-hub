// Literal address locations and replacement verification, never plan rewriting.
import { addressKey } from './manifest.ts';
import type { Replacement } from './slots.ts';
export interface LiteralAddress { text: string; at: number; key: string | null }
/** Internal offsets are UTF-16 string indexes into the exact quote. The typed reader, not this helper, authorizes a span. */
export interface AddressSpan { start: number; end: number; literal: string }
export class AddressSpanError extends Error {
  readonly reason: string;
  constructor(reason: string) { super('结构地址跨度或替换映射不符合已声明原文；不得重新扫描文字猜位置'); this.name = 'AddressSpanError'; this.reason = reason; }
}
/** Rewrites explicitly selected address positions only. No supplied position means no replacement, even for IP-shaped text. */
export function replacedQuote(text: string, replacements: readonly Replacement[], spans: readonly AddressSpan[] = []): string {
  const byKey = new Map<string, string>(), targets = new Set<string>();
  for (const replacement of replacements) {
    const from = addressKey(replacement.case), to = addressKey(replacement.bed);
    if (!from || !to) throw new AddressSpanError('mapping_syntax');
    if (from.split(':', 1)[0] !== to.split(':', 1)[0]) throw new AddressSpanError('mapping_family');
    if (byKey.has(from) || targets.has(to)) throw new AddressSpanError('mapping_bijection');
    byKey.set(from, replacement.bed); targets.add(to);
  }
  let out = '', cursor = 0;
  for (const span of spans) {
    if (!Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end) || span.start < cursor || span.end <= span.start || span.end > text.length) throw new AddressSpanError('span_bounds');
    if (text.slice(span.start, span.end) !== span.literal) throw new AddressSpanError('span_identity');
    const key = addressKey(span.literal);
    if (!key) throw new AddressSpanError('span_syntax');
    out += text.slice(cursor, span.start) + (byKey.get(key) ?? span.literal);
    cursor = span.end;
  }
  return out + text.slice(cursor);
}

/** Retired APIs refuse to classify untyped text; kept only so old callers receive an explicit migration error. */
export function literalAddresses(_text:string):LiteralAddress[]{throw new AddressSpanError('typed_parameter_required');}
export function deniedCommand(_text:string,_words:readonly string[]):boolean{throw new AddressSpanError('effect_authority_required');}
