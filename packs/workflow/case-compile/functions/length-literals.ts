import { CallFailure, isRecord } from './text.ts';

export const MAX_LABEL = 63;
const MAX_LENGTH = 4096;
const PLACEHOLDER = /\{\{(domain|name):([1-9][0-9]{0,3})((?:\|[^|{}]*){0,2})\}\}/g;
const LEFTOVER = /\{\{\s*(?:domain|name)\b/;
const FIXED = /^[\x21-\x7e]*$/;
const QUOTES = /["'`\\]/;
const LETTERS = 'abcdefghijklmnopqrstuvwxyz';
export const PLACEHOLDER_FORMS = '{{domain:253}}、{{domain:253|前缀|后缀}} 或 {{name:64}}';

export interface Expansion { placeholder: string; literal: string; length: number; labels: number[] | null }

function fillerLabels(total: number): string[] {
  const labels: string[] = [];
  let rest = total;
  while (rest > MAX_LABEL) {
    const take = rest === MAX_LABEL + 1 ? MAX_LABEL - 1 : MAX_LABEL;
    labels.push(LETTERS[labels.length % LETTERS.length].repeat(take));
    rest -= take + 1;
  }
  labels.push(LETTERS[labels.length % LETTERS.length].repeat(rest));
  return labels;
}

function expandOne(placeholder: string, kind: string, length: number, prefix: string, suffix: string): Expansion {
  if (length > MAX_LENGTH) throw new CallFailure("invalid_parameters", `占位 ${placeholder} 的长度超过 ${MAX_LENGTH}`, "把长度占位值 N 写在 1 到 4096 之间，或使用原始资料明确给出的完整字面量");
  if (!FIXED.test(prefix + suffix) || QUOTES.test(prefix + suffix)) throw new CallFailure("invalid_parameters", `占位 ${placeholder} 的固定部分只能是不含空白和引号的可见 ASCII 字符`, "长度占位的固定前后缀仅使用不含空白、引号和反斜杠的可见 ASCII 字符");
  if (kind === 'name') {
    const fill = length - prefix.length - suffix.length;
    if (fill < 1) throw new CallFailure("invalid_parameters", `占位 ${placeholder} 的固定部分已有 ${prefix.length + suffix.length} 字符，补不出 ${length} 字符`, "缩短固定前后缀，使声明长度至少还能容纳 1 个填充字符");
    const literal = prefix + 'a'.repeat(fill) + suffix;
    return { placeholder, literal, length: literal.length, labels: null };
  }
  const head = prefix && !prefix.endsWith('.') ? prefix + '.' : prefix;
  const tail = suffix && !suffix.startsWith('.') ? '.' + suffix : suffix;
  const fill = length - head.length - tail.length;
  if (fill < 1) throw new CallFailure("invalid_parameters", `占位 ${placeholder} 的固定部分已有 ${head.length + tail.length} 字符，补不出 ${length} 字符的域名`, "缩短固定域名前后缀，把补充点号也计入总长度，并至少留下 1 个填充字符");
  const literal = head + fillerLabels(fill).join('.') + tail;
  const labels = literal.split('.').map((label) => label.length);
  if (labels.some((n) => n === 0)) throw new CallFailure("invalid_parameters", `占位 ${placeholder} 的固定部分有空的一段（连续的点或首尾的点）`, "移除固定域名前后缀中的连续点和会形成空段的首尾点后重试");
  if (labels.some((n) => n > MAX_LABEL)) throw new CallFailure("invalid_parameters", `占位 ${placeholder} 的固定部分有一段超过 ${MAX_LABEL} 字符；要一段超长时写 {{name:N}}`, "缩短固定域名每段至 63 字符以内；需要超长单段的用例明确使用 {{name:N}}");
  if (literal.length !== length) throw new CallFailure("temporarily_unavailable", `占位 ${placeholder} 展开后是 ${literal.length} 字符，不是 ${length}`, "停止使用本次展开结果；请维护者核对长度占位生成器，再用相同占位重新生成");
  return { placeholder, literal, length, labels };
}

export function expandText(text: string): { text: string; expansions: Expansion[] } {
  const expansions: Expansion[] = [];
  const out = text.replace(PLACEHOLDER, (placeholder: string, kind: string, digits: string, rest: string) => {
    const [prefix = '', suffix = ''] = rest ? rest.slice(1).split('|') : [];
    const expansion = expandOne(placeholder, kind, Number(digits), prefix, suffix);
    expansions.push(expansion);
    return expansion.literal;
  });
  if (LEFTOVER.test(out)) throw new CallFailure("invalid_parameters", `长度占位写法不对：${JSON.stringify(text.slice(0, 120))}；写 ${PLACEHOLDER_FORMS}`, "使用 {{domain:253}}、{{domain:253|前缀|后缀}} 或 {{name:64}} 这种完整占位写法");
  return { text: out, expansions };
}

export function expandValue(value: unknown): { value: unknown; expansions: Expansion[] } {
  const expansions: Expansion[] = [];
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') { const done = expandText(v); expansions.push(...done.expansions); return done.text; }
    if (Array.isArray(v)) return v.map(walk);
    if (isRecord(v)) return Object.fromEntries(Object.entries(v).map(([key, inner]) => [key, walk(inner)]));
    return v;
  };
  return { value: walk(value), expansions };
}

export function describeExpansions(file: string, expansions: Expansion[]): string[] {
  const seen = new Set<string>();
  return expansions.filter((e) => !seen.has(e.placeholder) && seen.add(e.placeholder)).map((e) => `${file}：${e.placeholder} → ${e.length} 字符${e.labels ? `，${e.labels.length} 段，各段 ${e.labels.join('/')}` : ''}`);
}

// The inverse of the expansion. A plan that was expanded holds long names as plain text; a writer who is handed that text
// copies it by hand and can get a length wrong without anyone noticing. collapseText puts the placeholders back, so that
// the same name stands for the same placeholder and a name of another length shows as another placeholder.

/** The characters a fixed part may hold: visible ASCII without whitespace, quotes, the backtick and the backslash. */
const TOKEN = /[\x21\x23-\x26\x28-\x5b\x5d-\x5f\x61-\x7e]+/g;
/** Sixteen identical characters in a row: the filler of a name worth a placeholder, not an ordinary short name. */
const LONG_RUN = /(.)\1{15}/;
const LEADING_RUN = /^(.)\1{15}/;
const TRAILING_RUN = /(.)\1{15}$/;
// A filler of at most MAX_LENGTH characters is not made of more labels than this: every label but the last has 62 or 63.
const MAX_FILLER_LABELS = 70;

export interface CanonicalName {
  kind: 'domain' | 'name';
  /** The length of the whole name, the number the placeholder declares. */
  length: number;
  prefix: string;
  suffix: string;
  /** The characters the placeholder makes up between its fixed parts. */
  fill: number;
  placeholder: string;
  literal: string;
}
export interface Collapsed { placeholder: string; literal: string; count: number }

/** The maximal runs of fixed-part characters of a text, with where each one starts. */
export function tokensOf(text: string): Array<{ token: string; index: number }> {
  return [...text.matchAll(TOKEN)].map((found) => ({ token: found[0], index: found.index! }));
}

function placeholderOf(kind: 'domain' | 'name', length: number, prefix: string, suffix: string): string {
  return `{{${kind}:${length}${suffix ? `|${prefix}|${suffix}` : prefix ? `|${prefix}` : ''}}}`;
}

/** A placeholder is only written when expanding it gives back the literal byte for byte. */
function expandsTo(placeholder: string, literal: string): boolean {
  try { return expandText(placeholder).text === literal; } catch { return false; }
}

function domainName(token: string): CanonicalName | null {
  const labels = token.split('.');
  for (let start = 0; start < labels.length; start++) {
    if (!/^a{16,63}$/.test(labels[start]!)) continue;
    for (let end = Math.min(labels.length - 1, start + MAX_FILLER_LABELS); end >= start; end--) {
      const filler = labels.slice(start, end + 1).join('.');
      if (fillerLabels(filler.length).join('.') !== filler) continue;
      const prefix = labels.slice(0, start).join('.'), suffix = labels.slice(end + 1).join('.');
      if (LONG_RUN.test(prefix) || LONG_RUN.test(suffix)) continue;
      const placeholder = placeholderOf('domain', token.length, prefix, suffix);
      if (expandsTo(placeholder, token)) return { kind: 'domain', length: token.length, prefix, suffix, fill: filler.length, placeholder, literal: token };
    }
  }
  return null;
}

function plainName(token: string): CanonicalName | null {
  for (const run of token.matchAll(/a{16,}/g)) {
    const prefix = token.slice(0, run.index), suffix = token.slice(run.index! + run[0].length);
    if (LONG_RUN.test(prefix) || LONG_RUN.test(suffix)) continue;
    const placeholder = placeholderOf('name', token.length, prefix, suffix);
    if (expandsTo(placeholder, token)) return { kind: 'name', length: token.length, prefix, suffix, fill: run[0].length, placeholder, literal: token };
  }
  return null;
}

/** What a token is when it is exactly what some length placeholder expands to and its filler is at least 16 characters long. */
export function canonicalOf(token: string): CanonicalName | null {
  if (token.length > MAX_LENGTH || !LONG_RUN.test(token)) return null;
  return (token.includes('.') ? domainName(token) ?? plainName(token) : plainName(token));
}

/** Where a literal stands inside a host without lengthening the run of its own filler (a literal ending in a run is not found in the middle of a longer run). */
function alignedAt(host: string, literal: string): number[] {
  const found: number[] = [], before = LEADING_RUN.test(literal) ? literal[0] : null, after = TRAILING_RUN.test(literal) ? literal.at(-1) : null;
  for (let from = host.indexOf(literal); from >= 0; from = host.indexOf(literal, from + 1)) {
    if (before !== null && host[from - 1] === before) continue;
    if (after !== null && host[from + literal.length] === after) continue;
    found.push(from);
    from += literal.length - 1;
  }
  return found;
}

// The fixed parts of a name are what names have in common when only their lengths differ.
interface FixedParts { kind: CanonicalName['kind']; prefix: string; suffix: string }
const fixedKey = (parts: FixedParts): string => JSON.stringify([parts.kind, parts.prefix, parts.suffix]);
const fixedSize = (parts: FixedParts): number => parts.prefix.length + parts.suffix.length;
/** A character that belongs to a word: a name of fixed parts is not found glued to one, that would be another name. */
const WORD = /[A-Za-z0-9_-]/;
/** Longer tokens than this are not searched for names of known fixed parts. */
const MAX_TOKEN_CHARS = 16_384;
const MIN_FILLER = 16;

/** How many characters of filler of a domain start at `from` and are followed by `tail`, the longest one; 0 when there is none. */
function domainFillerAt(token: string, from: number, tail: string): number {
  const labels = token.slice(from).split('.');
  for (let count = Math.min(labels.length, MAX_FILLER_LABELS + 1); count >= 1; count--) {
    const filler = labels.slice(0, count).join('.');
    if (filler.length >= MIN_FILLER && fillerLabels(filler.length).join('.') === filler && token.startsWith(tail, from + filler.length)) return filler.length;
  }
  return 0;
}

function plainFillerAt(token: string, from: number, tail: string): number {
  let run = 0;
  while (token[from + run] === 'a') run++;
  for (let fill = run; fill >= MIN_FILLER; fill--) if (token.startsWith(tail, from + fill)) return fill;
  return 0;
}

/** The names in a token that are exactly what the placeholders of these fixed parts expand to, whatever their length. */
function namesFor(token: string, parts: FixedParts): CanonicalName[] {
  const domain = parts.kind === 'domain';
  const head = domain ? (parts.prefix ? `${parts.prefix}.` : '') : parts.prefix, tail = domain ? (parts.suffix ? `.${parts.suffix}` : '') : parts.suffix;
  const glued = (at: number) => at >= 0 && at < token.length && WORD.test(token[at]!);
  const found: CanonicalName[] = [];
  for (let start = 0; start < token.length; start++) {
    if (!token.startsWith(head, start) || glued(start - 1)) continue;
    const from = start + head.length;
    if (token[from] !== 'a') continue;
    const fill = domain ? domainFillerAt(token, from, tail) : plainFillerAt(token, from, tail), end = from + fill + tail.length;
    if (fill === 0 || glued(end)) continue;
    const literal = token.slice(start, end), placeholder = placeholderOf(parts.kind, literal.length, parts.prefix, parts.suffix);
    if (!expandsTo(placeholder, literal)) continue;
    found.push({ kind: parts.kind, length: literal.length, prefix: parts.prefix, suffix: parts.suffix, fill, placeholder, literal });
    start = end - 1;
  }
  return found;
}

interface Piece { text: string; start: number; name?: CanonicalName; kept?: true }
interface Collapse { text: string; collapsed: Collapsed[]; places: Array<{ at: number; name: CanonicalName }> }

/** The whole of it: which names a text holds, which placeholder each stands for, and the text with the placeholders; null when nothing is to be put back or it cannot be proved. */
function collapse(text: string): Collapse | null {
  if (!LONG_RUN.test(text)) return null;
  let expected: string;
  try { expected = expandText(text).text; } catch { return null; }

  // The names that stand alone as a token, shortest first; one that is only a shorter name with something around it is said through that one.
  const alone = new Map<string, CanonicalName | null>();
  for (const { token } of tokensOf(text)) if (!alone.has(token)) alone.set(token, canonicalOf(token));
  const bases: CanonicalName[] = [];
  for (const name of [...alone.values()].filter((value): value is CanonicalName => value !== null).sort((a, b) => a.length - b.length)) {
    if (!bases.some((base) => base.kind === name.kind && base.fill === name.fill && alignedAt(name.literal, base.literal).length > 0)) bases.push(name);
  }

  // The second look: a name with fixed parts of its own that holds a name of fixed parts found before, only of another length,
  // is said through those fixed parts ("x1." and the placeholder), and so is such a name inside any other token with a long run.
  // The fixed parts of the shortest names come first; names without any fixed part say nothing about another name.
  const chosen = new Map<string, CanonicalName>(), known: FixedParts[] = [];
  const add = (name: CanonicalName) => { if (!chosen.has(name.literal)) chosen.set(name.literal, name); };
  for (const base of [...bases].sort((a, b) => fixedSize(a) - fixedSize(b))) {
    let through: CanonicalName[] = [], most = -1;
    for (const parts of known) {
      if (fixedKey(parts) === fixedKey(base) || fixedSize(parts) <= most) continue;
      const found = namesFor(base.literal, parts);
      if (found.length) { through = found; most = fixedSize(parts); }
    }
    if (through.length) { through.forEach(add); continue; }
    add(base);
    if (fixedSize(base) > 0 && !known.some((parts) => fixedKey(parts) === fixedKey(base))) known.push({ kind: base.kind, prefix: base.prefix, suffix: base.suffix });
  }
  if (known.length) for (const [token, name] of alone) {
    if (name === null && token.length <= MAX_TOKEN_CHARS && LONG_RUN.test(token)) for (const parts of known) namesFor(token, parts).forEach(add);
  }
  if (!chosen.size) return null;

  // The text as pieces: what is written out, and what is placeholder (kept as it is, and not looked into).
  let pieces: Piece[] = [];
  let last = 0;
  for (const found of text.matchAll(PLACEHOLDER)) {
    if (found.index! > last) pieces.push({ text: text.slice(last, found.index), start: last });
    pieces.push({ text: found[0], start: found.index!, kept: true });
    last = found.index! + found[0].length;
  }
  if (last < text.length) pieces.push({ text: text.slice(last), start: last });
  for (const name of [...chosen.values()].sort((a, b) => b.length - a.length)) {
    pieces = pieces.flatMap((piece) => {
      if (piece.kept || piece.name) return [piece];
      const hits = alignedAt(piece.text, name.literal);
      if (!hits.length) return [piece];
      const split: Piece[] = [];
      let from = 0;
      for (const hit of hits) {
        if (hit > from) split.push({ text: piece.text.slice(from, hit), start: piece.start + from });
        split.push({ text: name.placeholder, start: piece.start + hit, name });
        from = hit + name.literal.length;
      }
      if (from < piece.text.length) split.push({ text: piece.text.slice(from), start: piece.start + from });
      return split;
    });
  }

  const out = pieces.map((piece) => piece.text).join('');
  try { if (expandText(out).text !== expected) return null; } catch { return null; }
  const counts = new Map<string, Collapsed>(), places: Collapse['places'] = [];
  for (const piece of pieces) if (piece.name) {
    const row = counts.get(piece.text) ?? { placeholder: piece.text, literal: piece.name.literal, count: 0 };
    row.count++;
    counts.set(piece.text, row);
    places.push({ at: piece.start, name: piece.name });
  }
  return { text: out, collapsed: [...counts.values()], places };
}

/**
 * Puts the length placeholders back into a text that was expanded. A token (see tokensOf) that is exactly what a placeholder
 * expands to becomes that placeholder; the same name inside a longer token (a name with a label or other characters around it
 * that stands alone elsewhere in the text) becomes the same placeholder with its own extra characters around it. Names that
 * only differ in length are different placeholders, and a name that has the fixed parts of another one found in the text is
 * written with those fixed parts, in a longer token as well. The result expands back to what the text expands to, byte for
 * byte; a text this cannot be proved for is returned as it was.
 */
export function collapseText(text: string): { text: string; collapsed: Collapsed[] } {
  const done = collapse(text);
  return done ? { text: done.text, collapsed: done.collapsed } : { text, collapsed: [] };
}

/** The long names a text holds as collapseText finds them, with the placeholder each stands for and where it starts in the text. */
export function namesIn(text: string): Array<{ at: number; name: CanonicalName }> {
  return collapse(text)?.places ?? [];
}

/**
 * A JSON text with its long names collapsed; the text itself when the collapsed text is no longer JSON, does not expand back to
 * exactly these bytes, or does not read back as the same value (expandValue leaves the keys of an object as they are).
 */
export function collapseJsonText(text: string): string {
  const { text: collapsed } = collapseText(text);
  if (collapsed === text) return text;
  try {
    const sameValue = JSON.stringify(expandValue(JSON.parse(collapsed)).value) === JSON.stringify(JSON.parse(text));
    return sameValue && expandText(collapsed).text === text ? collapsed : text;
  } catch { return text; }
}
