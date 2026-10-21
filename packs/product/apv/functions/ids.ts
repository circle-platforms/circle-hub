// Ids in mind-map document titles: bug, story and PLM ids by the title conventions of the team ('bug to case 61001 ...',
// 'Bug-to-Case-7101 7102-...', '需求7301', 'Story#7302', 'PLM7201-...'), and ids the title does not classify (a leading
// '7401-...', '回归 - 161090 ...'). Several ids may follow one marker, separated by spaces, &, 、 or "and". Version
// numbers (10.6.1.32), dates (20260531, 2026/7, 3/17) and numbers glued to other words are never ids. (Ids here are
// synthetic examples.)
import type { IdsResult } from './types.ts';
import { guarded, internalError, isRecord, unique, validDate } from './util.ts';

const MAX_TITLE = 4096;
/**
 * Markers before ids: bug (bug to case, bug-to-case, Bug2case, bugtocase and the misspellings found in real titles:
 * but-to-case, Butocase, bugt-to-case, bug ro case; 缺陷), story (需求), PLM. Longer forms come first.
 */
const MARKERS =
  /(?<![A-Za-z])(?:(bu(?:t|gt)[\s_-]*(?:t?o|ro|2)[\s_-]*c[a-z]{0,5}|bugs?(?:[\s_-]*(?:t?o|ro|2)[\s_-]*c[a-z]{0,5})?|缺陷)|(stor(?:y|ies)|需求单?)|(plm))/gi;
const GLUE = /^[\s_\-–—:#.]*/;
const SEPARATOR = /^(?:\s*(?:&|、|,|\+|\/|\band\b|和|及|与)\s*|\s+)(?=[0-9]{2})/i;
const REGRESSION = /^(?:回归测试|回归|[一二三四五六七八九十0-9]{1,2}轮回归(?:测试)?|test)(?![A-Za-z])/i;

/** A digit run at `at` that can be an id: bounded length, not part of a version, date or glued word. */
function idAt(text: string, at: number, min: number, max: number): { id: string; end: number } | null {
  let end = at;
  while (end < text.length && text[end] >= '0' && text[end] <= '9') end++;
  const id = text.slice(at, end);
  if (id.length < min || id.length > max) return null;
  const before = text[at - 1] ?? '';
  const next = text[end] ?? '';
  const after = text[end + 1] ?? '';
  const short = id.length <= 4;
  if (/[0-9]/.test(before) || (before === '.' && /[0-9]/.test(text[at - 2] ?? ''))) return null;
  // 10.6.1 continues with digits after a dot; 2026/7, 3/17 and 12:30 after a slash or colon (long ids may be listed with /).
  if (next === '.' && /[0-9]/.test(after)) return null;
  if (short && (next === '/' || next === ':') && /[0-9]/.test(after)) return null;
  // 2024-06-26: four digits, a dash and one or two digits.
  if (id.length === 4 && next === '-' && /^[0-9]{1,2}(?:[^0-9]|$)/.test(text.slice(end + 1, end + 4))) return null;
  // option28, 3a: short numbers glued to a word are not ids; long ones are (bug to case 123456showtech).
  if (short && /[A-Za-z]/.test(next)) return null;
  if (id.length === 8 && validDate(Number(id.slice(0, 4)), Number(id.slice(4, 6)), Number(id.slice(6, 8)))) return null;
  return { id, end };
}

/** Ids from `at` on: one, then more after separators. */
function idList(text: string, at: number, min: number, max: number): string[] {
  const ids: string[] = [];
  let position = at;
  for (let guard = 0; guard < 64; guard++) {
    const found = idAt(text, position, min, max);
    if (found === null) break;
    ids.push(found.id);
    position = found.end;
    const separator = SEPARATOR.exec(text.slice(position, position + 12));
    if (separator === null) break;
    position += separator[0].length;
  }
  return ids;
}

/** Where leading ids may start: after white space, dashes, brackets without digits and regression markers. */
function leadingStart(text: string): number {
  let at = 0;
  for (let guard = 0; guard < 32; guard++) {
    const rest = text.slice(at, at + 64);
    const space = /^[\s\-–—_:.、]+/.exec(rest);
    if (space) {
      at += space[0].length;
      continue;
    }
    const bracket = /^(?:\[[^\]\d]{0,20}\]|【[^】\d]{0,20}】|\([^)\d]{0,20}\)|（[^）\d]{0,20}）)/.exec(rest);
    if (bracket) {
      at += bracket[0].length;
      continue;
    }
    const regression = REGRESSION.exec(rest);
    if (regression) {
      at += regression[0].length;
      continue;
    }
    // An id inside an opening bracket: [7401] or 【7401】.
    if (/^[[【(（]\s*[0-9]/.test(rest)) at += /^[[【(（]\s*/.exec(rest)![0].length;
    break;
  }
  return at;
}

export function idsFromTitle(title: string): IdsResult {
  const out: IdsResult = { stories: [], bugs: [], plm: [], unclassified: [], warnings: [] };
  try {
    if (typeof title !== 'string') {
      out.warnings.push('标题不是字符串');
      return out;
    }
    let text = title.normalize('NFKC');
    if (text.length > MAX_TITLE) {
      out.warnings.push(`标题超过 ${MAX_TITLE} 个字符，只看前 ${MAX_TITLE} 个`);
      text = text.slice(0, MAX_TITLE);
    }
    const classified = new Set<string>();
    for (const match of text.matchAll(MARKERS)) {
      const start = (match.index ?? 0) + match[0].length;
      const glue = GLUE.exec(text.slice(start, start + 16));
      const target = match[1] !== undefined ? out.bugs : match[2] !== undefined ? out.stories : out.plm;
      for (const id of idList(text, start + (glue ? glue[0].length : 0), 2, 9)) {
        target.push(id);
        classified.add(id);
      }
    }
    const bare = idList(text, leadingStart(text), 4, 7);
    // A leading four-digit year (2025 ...) is not an id, and neither is anything listed after it.
    if (!(bare.length > 0 && bare[0].length === 4 && Number(bare[0]) >= 1900 && Number(bare[0]) <= 2099)) {
      for (const id of bare) if (!classified.has(id)) out.unclassified.push(id);
    }
    out.stories = unique(out.stories);
    out.bugs = unique(out.bugs);
    out.plm = unique(out.plm);
    out.unclassified = unique(out.unclassified);
    return out;
  } catch (error) {
    out.warnings.push(internalError(error));
    return out;
  }
}

/** Pack function entry: the title, or `{ title }`. */
export default function ids(input: unknown): IdsResult {
  return guarded(
    () => (isRecord(input) && typeof input.title === 'string' ? idsFromTitle(input.title) : idsFromTitle(input as string)),
    (warning) => ({ stories: [], bugs: [], plm: [], unclassified: [], warnings: [warning] }),
  );
}
