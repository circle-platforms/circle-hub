// ECMA-404 string/value boundaries for the kityminder@1 pre-order model. Hub checks case ownership at submission.
// Raw source digests are checked before offsets are used, so decoded/stripped source views cannot impersonate original bytes.
import { createHash } from 'node:crypto';
type QuoteEvidence = { identity: { source_sha256: string; parser: string; path: string; span: { unit: 'byte'; offset: number; length: number } }; text: string };
export type JsonToken = { start: number; end: number; value?: unknown; object?: Map<string, JsonToken>; array?: JsonToken[] };
function jsonTokens(text: string): JsonToken {
  JSON.parse(text); // authoritative JSON grammar; the scanner below only retains its token locations
  let at = 0;
  const space = () => { while ([' ', '\t', '\r', '\n'].includes(text[at])) at++; };
  const string = (): JsonToken => {
    const start = at++;
    while (at < text.length) { const c = text[at++]; if (c === '\\') at++; else if (c === '"') break; }
    return { start, end: at, value: JSON.parse(text.slice(start, at)) };
  };
  const value = (depth: number): JsonToken => {
    if (depth > 600) throw new Error('JSON nesting exceeds the retained parser scope');
    space(); const start = at;
    if (text[at] === '"') return string();
    if (text[at] === '{') {
      at++; space(); const object = new Map<string, JsonToken>();
      while (text[at] !== '}') { const key = string().value as string; space(); at++; object.set(key, value(depth + 1)); space(); if (text[at] !== ',') break; at++; space(); }
      at++; return { start, end: at, object };
    }
    if (text[at] === '[') {
      at++; space(); const array: JsonToken[] = [];
      while (text[at] !== ']') { array.push(value(depth + 1)); space(); if (text[at] !== ',') break; at++; }
      at++; return { start, end: at, array };
    }
    while (at < text.length && ![' ', '\t', '\r', '\n', ',', '}', ']'].includes(text[at])) at++;
    return { start, end: at, value: JSON.parse(text.slice(start, at)) };
  };
  return value(0);
}
function utf8Offsets(text: string): number[] {
  const offsets = new Array<number>(text.length + 1); let byte = 0;
  for (let at = 0; at < text.length; at++) {
    offsets[at] = byte; const cp = text.codePointAt(at)!;
    byte += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    if (cp > 0xffff) { offsets[++at] = -1; }
  }
  offsets[text.length] = byte; return offsets;
}
/** For a double-encoded document, map inner decoded character boundaries to the outer original JSON string. */
function decodedOffsets(text: string, token: JsonToken): number[] {
  const offsets: number[] = []; let at = token.start + 1;
  while (at < token.end - 1) {
    const start = at; let decoded: string;
    if (text[at] !== '\\') decoded = text[at++];
    else { at += text[at + 1] === 'u' ? 6 : 2; decoded = JSON.parse('"' + text.slice(start, at) + '"'); }
    for (let i = 0; i < decoded.length; i++) offsets.push(start);
  }
  offsets.push(token.end - 1); return offsets;
}
export type QuoteNode = { selector: string; parent: number | null; data: unknown };
/** Prepare candidates in one selected node; the Hub independently verifies any submitted evidence. */
export function originalQuoteLocator(raw: string, sha256: string, nodes: QuoteNode[]) {
  if (createHash('sha256').update(raw, 'utf8').digest('hex') !== sha256) throw new Error('读取的文本不能重算原件摘要；需要原始 UTF-8 字节读取通路');
  const bytes = new TextEncoder().encode(raw), offsets = utf8Offsets(raw);
  let token = jsonTokens(raw); let parsed = raw; let rebased: number[] | undefined;
  if (typeof token.value === 'string') { rebased = decodedOffsets(raw, token); parsed = token.value; token = jsonTokens(parsed); }
  const byteAt = (index: number) => offsets[rebased ? rebased[index] : index];
  const roots = token.object?.get('root'); if (!roots) throw new Error('原件没有 root');
  const ranges: Array<{ start: number; end: number; text: string | null; offsets: number[] | null }> = [];
  const stack = [roots];
  while (stack.length) {
    const node = stack.pop()!; const text = node.object?.get('data')?.object?.get('text');
    ranges.push(text ? { start: byteAt(text.start + (typeof text.value === 'string' ? 1 : 0)), end: byteAt(text.end - (typeof text.value === 'string' ? 1 : 0)), text: typeof text.value === 'string' ? text.value : null, offsets: typeof text.value === 'string' ? decodedOffsets(parsed,text).map(byteAt) : null } : { start: -1, end: -1, text: null, offsets: null });
    const children = node.object?.get('children')?.array ?? [];
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
  }
  if (ranges.length !== nodes.length) throw new Error('原件与冻结节点树不一致');
  const selectors = new Map(nodes.map((n, i) => [n.selector, i]));
  return (path: string, text: string): QuoteEvidence[] => {
    const field = path.endsWith('/@text');
    const selected = selectors.get(field ? path.slice(0, -6) : path);
    if (selected === undefined || !text || !text.isWellFormed()) return [];
    const range = ranges[selected];
    if (range.text === null || range.offsets === null) return [];
    const matches: QuoteEvidence[] = [];
    let from = 0;
    while (from <= range.text.length - text.length) {
      const at = range.text.indexOf(text, from);
      if (at < 0) break;
      const begin = range.offsets[at], end = range.offsets[at + text.length];
      if (begin >= range.start && end > begin && end <= range.end && end <= bytes.length) {
        const quote: QuoteEvidence = { identity: { source_sha256: sha256, parser: 'kityminder@1', path, span: { unit: 'byte', offset: begin, length: end - begin } }, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(begin, end)) };
        matches.push(quote);
      }
      from = at + 1;
    }
    return matches;
  };
}
