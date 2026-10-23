// Requirement and defect ids in titles (the PLM system's story and bug numbers), adapted from the case-review pack and the
// product pack (packs cannot import each other at run time). Only a word right before a number names its kind: bug, bugs,
// 缺陷 (a defect); story, 需求 (a requirement). "bug to case" (with the misspellings seen in titles: bug2case, bugtocase,
// but-to-case, bug ro case) names a document type and PLM the system, and titles put story numbers after both, so the
// numbers after them are unmarked, like a number at the start of a title (31057-..., 回归 - 112233). Versions (10.6.1.32),
// dates (20260531, 2026/7, 3/17), times, years and numbers glued to short words are never ids. An unmarked number is an id
// only with five to seven digits and a separator after it: case-review measured 947 of 949 sampled unmarked ids at 10,000 or
// more, while four-digit numbers and numbers glued to Han text or a unit start titles as quantities (8080 端口, 4094 VLAN,
// 10000并发, 1000条). Where a leading number is no id at all (folders deep in the tree, the map path, the case text), callers
// read marked ids only. (Numbers are invented.)
import { validDate } from './text.ts';
import type { FoundId } from './types.ts';

/** Code units of one text that are scanned; real titles are far shorter. */
const MAX_SCAN = 2000;

/**
 * Markers on NFKC, lower-cased text. Alternatives in order: the "bug to case" family (defect), bug words (defect), story
 * words (requirement), plm (unmarked), then the Chinese words. ASCII markers must not continue a word (debug, history).
 */
const MARKER = /(?<![a-z0-9])(?:(bu(?:gt?|t)[\s_-]*(?:t?o|ro|2)[\s_-]*c[a-z]{0,5})|(bugs?)|(stor(?:y|ies))|(plm))|(缺陷)|(需求单?)/gu;
/** A second word right after the first ("bug to case-需求20931"): the one next to the number wins. */
const INNER = /(?:(需求单?)|(缺陷)|(stor(?:y|ies))|(bugs?))(?![a-z])/uy;
const GLUE = /[\s#:\-_~.—–]*/uy;
const LIST = /(?:\s*(?:[&、,，+;；]|and\b|和|及|与)\s*#?|\s+)(?=[0-9]{2})/iuy;
const LEAD_SKIP = /[\s\-–—_:.、]+/uy;
const LEAD_BRACKET = /(?:\[[^\]0-9]{0,20}\]|【[^】0-9]{0,20}】|\([^)0-9]{0,20}\)|（[^）0-9]{0,20}）)/uy;
const LEAD_WORD = /(?:regression|二轮回归测试|三轮回归测试|二轮回归|三轮回归|回归测试|回归|test|测试)(?![a-z])/iuy;
const LEAD_OPEN = /[[【(（]\s*(?=[0-9])/uy;
/** After an unmarked id: no Han character glued to it, and no unit or percent sign (a quantity), spaced or not. */
const GLUED_HAN = /^\p{Script=Han}/u;
const UNIT = /^\s*(?:%|‰|(?:ms|us|s|kb|mb|gb|tb|bps|kbps|mbps|gbps|qps|tps|cps|rps|pps|bits?|bytes?)(?![a-z]))/u;

function sticky(pattern: RegExp, text: string, at: number): string | null {
  pattern.lastIndex = at;
  const match = pattern.exec(text);
  return match === null ? null : match[0];
}

/**
 * A digit run at `at` that can be an id: within the bounds, not part of a version, date, time or glued word. A bare number
 * (no marker) followed by a colon is an ordering prefix (`201：...`), not an id.
 */
function idAt(text: string, at: number, min: number, max: number, bare: boolean): { id: string; end: number } | null {
  let end = at;
  while (end < text.length && text[end] >= '0' && text[end] <= '9') end += 1;
  const id = text.slice(at, end);
  if (id.length < min || id.length > max) return null;
  const before = text[at - 1] ?? '';
  const next = text[end] ?? '';
  const after = text[end + 1] ?? '';
  const short = id.length <= 4;
  if (/[0-9]/.test(before) || (before === '.' && /[0-9]/.test(text[at - 2] ?? ''))) return null;
  if (next === '.' && /[0-9]/.test(after)) return null; // 10.6.1
  if (short && (next === '/' || next === ':') && /[0-9]/.test(after)) return null; // 2026/7, 3/17, 12:30
  if (id.length === 4 && next === '-' && /^[0-9]{1,2}(?:[^0-9]|$)/.test(text.slice(end + 1, end + 4))) return null; // 2024-06-26
  if (short && /[a-z]/.test(next)) return null; // option28, 3a
  if (id.length === 8 && validDate(Number(id.slice(0, 4)), Number(id.slice(4, 6)), Number(id.slice(6, 8)))) return null; // 20260531
  if (/^\s*[年月日号]/u.test(text.slice(end, end + 3))) return null; // 2026年
  if (bare && /^\s*:/.test(text.slice(end, end + 3))) return null; // 1001：网络
  const normalized = normalizeId(id);
  return normalized === null ? null : { id: normalized, end };
}

/** Ids from `at` on: one, then more after list separators; stops at the first number that cannot be an id. */
function idList(text: string, at: number, min: number, max: number, bare = false): { ids: string[]; end: number; starts: number[]; ends: number[] } {
  const ids: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  let position = at;
  let end = at;
  for (let guard = 0; guard < 64; guard++) {
    const found = idAt(text, position, min, max, bare);
    if (found === null) break;
    ids.push(found.id);
    starts.push(position);
    ends.push(found.end);
    position = found.end;
    end = found.end;
    const separator = sticky(LIST, text, position);
    if (separator === null) break;
    position += separator.length;
  }
  return { ids, end, starts, ends };
}

/** The kind of a marker: null only for PLM. */
function kindOf(groups: RegExpExecArray | RegExpMatchArray): FoundId['kind'] {
  if (groups[4] !== undefined) return null;
  if (groups[1] !== undefined) return 'bug';
  if (groups[2] !== undefined || groups[5] !== undefined) return 'bug';
  return 'story';
}

/** Ids after a marker word anywhere in the text. */
export function markedIds(text: string, fromBugToCase?: (id: string) => void): FoundId[] {
  const frame = scanText(text.slice(0, MAX_SCAN), true, true);
  const lower = frame.text;
  const out: FoundId[] = [];
  MARKER.lastIndex = 0;
  for (let match = MARKER.exec(lower); match !== null; match = MARKER.exec(lower)) {
    let kind = kindOf(match);
    let family = match[1] !== undefined;
    let position = match.index + match[0].length;
    position += (sticky(GLUE, lower, position) ?? '').length;
    INNER.lastIndex = position;
    const inner = INNER.exec(lower);
    if (inner !== null) {
      family = false;
      kind = inner[1] !== undefined || inner[3] !== undefined ? 'story' : 'bug';
      position += inner[0].length;
      position += (sticky(GLUE, lower, position) ?? '').length;
    }
    const { ids, end, starts, ends } = idList(lower, position, 2, 9);
    for (const [index, id] of ids.entries()) {
      const raw = frame.spelling(starts[index], ends[index]);
      out.push(raw === id ? { kind, id } : { kind, id, spellings: [raw] });
      if (family) fromBugToCase?.(id);
    }
    if (ids.length > 0) MARKER.lastIndex = Math.max(MARKER.lastIndex, end);
  }
  return out;
}

/**
 * Unmarked ids at the very start of a text, after white space, dashes, brackets without digits and regression words: five to
 * seven digits each, none glued to Han text or followed by a unit (the whole run is a quantity then).
 */
export function leadingIds(text: string): FoundId[] {
  const frame = scanText(text.slice(0, MAX_SCAN), true, true);
  const lower = frame.text;
  let at = 0;
  for (let guard = 0; guard < 32; guard++) {
    const skip = sticky(LEAD_SKIP, lower, at) ?? sticky(LEAD_BRACKET, lower, at) ?? sticky(LEAD_WORD, lower, at);
    if (skip === null || skip === '') break;
    at += skip.length;
  }
  at += (sticky(LEAD_OPEN, lower, at) ?? '').length;
  const { ids, starts, ends } = idList(lower, at, 5, 7, true);
  if (ends.some((end) => GLUED_HAN.test(lower.slice(end, end + 1)) || UNIT.test(lower.slice(end, end + 12)))) return [];
  return ids.map((id, index) => {
    const raw = frame.spelling(starts[index], ends[index]);
    return raw === id ? { kind: null, id } : { kind: null, id, spellings: [raw] };
  });
}

/**
 * Every id of one text, once: the ones a word names, then the unmarked ones at its start (a number a word names is not
 * repeated). `leading: false` reads the marked ones only.
 */
export function extractIds(text: string, options: { leading?: boolean } = {}): FoundId[] {
  if (typeof text !== 'string' || text === '') return [];
  const found = [...markedIds(text), ...(options.leading === false ? [] : leadingIds(text))];
  const named = new Set(found.filter((f) => f.kind !== null).map((f) => f.id));
  const byId = new Map<string, FoundId>();
  for (const entry of found) {
    if (entry.kind === null && named.has(entry.id)) {
      for (const namedEntry of found.filter(candidate => candidate.id === entry.id && candidate.kind !== null)) {
        if (entry.spellings || namedEntry.spellings) namedEntry.spellings = [...new Set([...(namedEntry.spellings ?? [namedEntry.id]), ...(entry.spellings ?? [entry.id])])];
      }
      continue;
    }
    const key = `${entry.kind}:${entry.id}`; const previous = byId.get(key);
    if (previous && (previous.spellings || entry.spellings)) previous.spellings = [...new Set([...(previous.spellings ?? [previous.id]), ...(entry.spellings ?? [entry.id])])];
    else if (!previous) byId.set(key, entry);
  }
  return [...byId.values()];
}

/** Whether a text carries an id (a folder that does is a document folder, not a module). */
export function hasIds(text: string): boolean {
  return extractIds(text).length > 0;
}

/** Defect ids explicitly introduced by this title convention, excluding an intervening story/bug marker. */
export function bugToCaseIds(text: string): string[] {
  const ids: string[] = [];
  markedIds(text, id => ids.push(id));
  return ids;
}

/** Canonical nonzero decimal identity; all-zero text is not an identifier. Original spelling is retained separately. */
export function normalizeId(raw: string): string | null {
  const digits = raw.normalize('NFKC');
  return /^0+$/.test(digits) ? null : digits.replace(/^0+(?=\d)/, '');
}

/** Matching text with source offsets, so compatibility normalization never rewrites a displayed identifier. */
function scanText(raw: string, squeeze = false, lower = false): { text: string; spelling: (start: number, end: number) => string } {
  let text = '';
  const starts: number[] = []; const ends: number[] = [];
  for (const part of new Intl.Segmenter('und', { granularity: 'grapheme' }).segment(raw.toWellFormed())) {
    let piece = part.segment.normalize('NFKC');
    if (lower) piece = piece.toLowerCase();
    for (const unit of piece.split('')) {
      if (squeeze && unit === '\u0000') continue;
      const char = squeeze && /\s/u.test(unit) ? ' ' : unit;
      if (squeeze && char === ' ' && (!text || text.endsWith(' '))) continue;
      text += char; starts.push(part.index); ends.push(part.index + part.segment.length);
    }
  }
  if (squeeze && text.endsWith(' ')) { text = text.slice(0, -1); starts.pop(); ends.pop(); }
  return { text, spelling: (start, end) => raw.slice(starts[start], ends[end - 1]) };
}
