// ExpectedQuoteIdentity from a resolvable src: reference and the quote text. The model does not supply the identity.
import type { ExpectedQuoteIdentity } from '../../../../contracts/generated/shared-interfaces.ts';
import { expectedIdentity } from './case-identity.ts';

const SHA = /^[0-9a-f]{64}$/;
const PARSER = /^[a-z][a-z0-9_.-]*@(?:0|[1-9][0-9]*)$/;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/;
const LINE = /^[1-9][0-9]{0,8}$/;

export interface SrcReference {
  sha256: string;
  parser: string;
  selector: string;
  range?: [number, number];
}

/** Canonical `src:<sha256>/<parser@major>/<selector>[:from-to]` as resolve_reference emits it. */
export function parseSrcReference(input: string): SrcReference | null {
  if (typeof input !== 'string' || input.length === 0 || input.length > 8192 || !input.startsWith('src:')) return null;
  const digest = input.slice(4, 68);
  if (!SHA.test(digest)) return null;
  const tail = input.slice(68);
  if (!tail.startsWith('/')) return null;
  const slash = tail.indexOf('/', 1);
  if (slash < 0) return null;
  const parser = tail.slice(1, slash);
  if (!PARSER.test(parser)) return null;
  const rest = tail.slice(slash + 1);
  const rangeAt = rest.indexOf(':');
  const selector = rangeAt < 0 ? rest : rest.slice(0, rangeAt);
  if (selector.length === 0 || selector.length > 8192 || selector.split('/').some(part => part === '')) return null;
  try { for (const part of selector.split('/')) decodeURIComponent(part); } catch { return null; }
  if (rangeAt < 0) return { sha256: digest, parser, selector };
  const spec = rest.slice(rangeAt + 1);
  const dash = spec.indexOf('-');
  if (dash < 0) return null;
  const from = spec.slice(0, dash);
  const to = spec.slice(dash + 1);
  if (!DECIMAL.test(from) || !DECIMAL.test(to)) return null;
  const start = Number(from);
  const end = Number(to);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= end) return null;
  return { sha256: digest, parser, selector, range: [start, end] };
}

function uniqueSpan(bytes: Uint8Array, from: number, to: number, quote: string): { offset: number; length: number } | null {
  const needle = new TextEncoder().encode(quote);
  if (needle.length === 0 || to < from || to - from < needle.length || to > bytes.length) return null;
  const hits: number[] = [];
  for (let at = from; at + needle.length <= to; at++) {
    let same = true;
    for (let k = 0; k < needle.length; k++) if (bytes[at + k] !== needle[k]) { same = false; break; }
    if (same) hits.push(at);
  }
  return hits.length === 1 ? { offset: hits[0], length: needle.length } : null;
}

function lineBounds(text: string): Array<{ start: number; end: number }> {
  const bounds: Array<{ start: number; end: number }> = [];
  const breaks = /\r\n|\r|\n/g;
  let start = 0;
  for (let match = breaks.exec(text); match !== null; match = breaks.exec(text)) {
    bounds.push({ start, end: match.index });
    start = match.index + match[0].length;
  }
  if (start < text.length || bounds.length === 0) bounds.push({ start, end: text.length });
  return bounds;
}

function textRange(text: string, selector: string): { start: number; end: number } | null {
  const parts = selector.split('/');
  if (parts.length !== 2 || parts[0] !== 'l') return null;
  const spec = parts[1];
  const dash = spec.indexOf('-');
  const left = dash < 0 ? spec : spec.slice(0, dash);
  const right = dash < 0 ? left : spec.slice(dash + 1);
  if (!LINE.test(left) || !LINE.test(right)) return null;
  const from = Number(left);
  const to = Number(right);
  if ((dash >= 0 && from >= to) || to < 1) return null;
  const lines = lineBounds(text);
  if (to > lines.length) return null;
  return { start: Buffer.byteLength(text.slice(0, lines[from - 1].start)), end: Buffer.byteLength(text.slice(0, lines[to - 1].end)) };
}

function jsonRange(bytes: Uint8Array, selector: string): { start: number; end: number } | null {
  const parts = selector.split('/');
  if (parts.length === 0 || parts[0] !== 'p' || parts.some(part => part === '')) return null;
  let tokens: string[];
  try { tokens = parts.slice(1).map(part => decodeURIComponent(part)); } catch { return null; }
  let i = 0;
  const n = bytes.length;
  const ws = () => { while (i < n && (bytes[i] === 32 || bytes[i] === 9 || bytes[i] === 10 || bytes[i] === 13)) i++; };
  const skipString = (): boolean => {
    if (bytes[i] !== 0x22) return false;
    i++;
    while (i < n) {
      const c = bytes[i++];
      if (c === 0x22) return true;
      if (c !== 0x5c) continue;
      if (i >= n) return false;
      const escaped = bytes[i++];
      if (escaped === 0x75) { if (i + 4 > n) return false; i += 4; }
    }
    return false;
  };
  const readKey = (): string | null => {
    const start = i;
    if (!skipString()) return null;
    try {
      const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(start, i)));
      return typeof value === 'string' ? value : null;
    } catch { return null; }
  };
  const skipValue = (): boolean => {
    ws();
    const b = bytes[i];
    if (b === 0x22) return skipString();
    if (b === 0x7b || b === 0x5b) {
      const open = b;
      const close = b === 0x7b ? 0x7d : 0x5d;
      i++;
      let depth = 1;
      let inString = false;
      let escaped = false;
      while (i < n && depth > 0) {
        const c = bytes[i++];
        if (inString) {
          if (escaped) escaped = false;
          else if (c === 0x5c) escaped = true;
          else if (c === 0x22) inString = false;
          continue;
        }
        if (c === 0x22) inString = true;
        else if (c === open) depth++;
        else if (c === close) depth--;
      }
      return depth === 0;
    }
    if (b === 0x74 || b === 0x66 || b === 0x6e || b === 0x2d || (b >= 0x30 && b <= 0x39)) {
      while (i < n && ![0x2c, 0x7d, 0x5d, 0x20, 0x09, 0x0a, 0x0d].includes(bytes[i])) i++;
      return i > 0;
    }
    return false;
  };
  const descend = (want: string[]): { start: number; end: number } | null => {
    ws();
    if (want.length === 0) {
      const start = i;
      return skipValue() ? { start, end: i } : null;
    }
    const b = bytes[i];
    if (b === 0x7b) {
      i++;
      ws();
      if (bytes[i] === 0x7d) return null;
      while (i < n) {
        ws();
        const key = readKey();
        if (key === null) return null;
        ws();
        if (bytes[i] !== 0x3a) return null;
        i++;
        if (key === want[0]) return descend(want.slice(1));
        if (!skipValue()) return null;
        ws();
        if (bytes[i] === 0x7d) return null;
        if (bytes[i] !== 0x2c) return null;
        i++;
      }
      return null;
    }
    if (b === 0x5b) {
      if (!DECIMAL.test(want[0])) return null;
      const index = Number(want[0]);
      i++;
      let at = 0;
      ws();
      if (bytes[i] === 0x5d) return null;
      while (i < n) {
        if (at === index) return descend(want.slice(1));
        if (!skipValue()) return null;
        at++;
        ws();
        if (bytes[i] === 0x5d) return null;
        if (bytes[i] !== 0x2c) return null;
        i++;
      }
      return null;
    }
    return null;
  };
  return descend(tokens);
}

function fragmentRange(bytes: Uint8Array, text: string, parsed: SrcReference): { start: number; end: number } | null {
  if (parsed.range) return { start: parsed.range[0], end: parsed.range[1] };
  if (parsed.parser === 'text@1') return textRange(text, parsed.selector);
  if (parsed.parser === 'json@1') return jsonRange(bytes, parsed.selector);
  return { start: 0, end: bytes.length };
}

export function quoteIdentity(reference: string, quote: string, sources: Record<string, unknown>): { identity: ExpectedQuoteIdentity } | { missing: string } {
  const parsed = parseSrcReference(reference);
  if (!parsed) return { missing: '引用不是可解析的 src:摘要/解析器@主版本/片段路径' };
  const text = sources['src:' + parsed.sha256];
  if (typeof text !== 'string') return { missing: '缺原件 src:' + parsed.sha256 + ' 的可读 UTF-8 字节' };
  const bytes = new TextEncoder().encode(text);
  const range = fragmentRange(bytes, text, parsed);
  if (!range || range.start < 0 || range.end > bytes.length) return { missing: '引用片段在原件中不存在，无法确定原始字节位置' };
  const span = uniqueSpan(bytes, range.start, range.end, quote);
  if (!span) return { missing: '引文在引用片段中没有唯一的原始字节位置' };
  const identity = expectedIdentity({ source_sha256: parsed.sha256, parser: parsed.parser, path: parsed.selector, span: { unit: 'byte', offset: span.offset, length: span.length } });
  return identity ? { identity } : { missing: '由引用推出的期望引用身份不符合 ExpectedQuoteIdentity' };
}
