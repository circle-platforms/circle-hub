// Product facts of the case-location scheme (pack data of the line the workflow binds, never core code): the agile tree's
// folder convention under the product project (`NNN：<line>` → `NNN：<line>-<train>` → module → document), the owner's
// version scheme over folder labels (build date `build<8 digits>`, patch `patch<n[.n]>`, version `[A-Za-z_-]*v?<n.n[.n[.n]]>`,
// in that priority order) with its guards, version labels (a label that is only a version), and the build names written in
// the line's name families (`Rel_<FAMILY>_<n>_<n>_<n>_<build>`), found as written and never derived. Labels are compared in
// NFKC, so full-width digits and colons count like ASCII ones.
import { PACK, fold, nfkc, validDate } from './text.ts';

/** Chinese labels of the pack's closed sets (tables/codes.json declares the same). */
export const LABELS = {
  version_source: { folders: '目录', title: '标题', parameter: '参数', none: '无' },
  confidence: { high: '高', low: '低', none: '无' },
} as const;

/** A caller's declaration that contradicts the tree. */
export const CONFLICT_CODE = `${PACK}.declaration_conflict`;

/** Longest label read; real folder labels are far shorter. */
export const MAX_LABEL = 1000;

// ---------------------------------------------------------------- labels and the folder convention

/**
 * Prefix code of a folder: three letters or digits with at least one digit, optionally in groups (000-001-002), before a
 * colon (ASCII or full-width, folded by NFKC).
 */
const PREFIX = /^((?=[0-9A-Za-z-]*[0-9])[0-9A-Za-z]{3}(?:-[0-9A-Za-z]{3}){0,3})\s*:\s*/;
const LINE = /^v?([0-9]{1,3}(?:\.[0-9]{1,3}){1,3})$/i;
const TRAIN = /^v?([0-9]{1,3}(?:\.[0-9]{1,3}){1,3})(?=[-_\s])\S*?[-_\s]+\S/i;
/** Words of activities and documents, not of functional modules. */
const NOT_MODULE = /测试|回归|用例|需求|缺陷|bug|case|patch|build|story|plm|提测/i;

export type Label = {
  /** The label in matching form (NFKC, white space squeezed, cut at MAX_LABEL). */
  text: string;
  /** The prefix code, or null when the label has none. */
  code: string | null;
  /** The text after the prefix code (the whole text without one). */
  rest: string;
};

export function parseLabel(raw: string): Label {
  const text = nfkc(raw.slice(0, MAX_LABEL));
  const match = PREFIX.exec(text);
  return match ? { text, code: match[1], rest: text.slice(match[0].length).trim() } : { text, code: null, rest: text };
}

/** The version line of a line node `NNN：<line>`, or null (also for a guarded number such as an address). */
export function lineOfLabel(label: Label): string | null {
  if (label.code === null) return null;
  const match = LINE.exec(label.rest);
  if (match === null) return null;
  const start = label.rest.indexOf(match[1]);
  return notAVersion(label.rest, start, start + match[1].length, match[1]) === null ? match[1] : null;
}

/** A release train node `NNN：<line>-<suffix>` (or a space before the suffix): the train text and its version, or null. */
export function trainOfLabel(label: Label): { train: string; version: string } | null {
  if (label.code === null) return null;
  const match = TRAIN.exec(label.rest);
  if (match === null) return null;
  const start = label.rest.indexOf(match[1]);
  return notAVersion(label.rest, start, start + match[1].length, match[1]) === null ? { train: label.rest, version: match[1] } : null;
}

/** The owner's version expression over a whole label (after its prefix code): `10.6.1`, `V10.7.0`, `NSAE_10.5.3`. */
const PURE_VERSION = /^[A-Za-z_-]*v?([0-9]{1,3}(?:\.[0-9]{1,3}){1,3})$/;

/**
 * The version of a version label: a label that is only a version in the owner's expression and reads as one version of the
 * scheme (not a patch, a protocol version or an address). A version written among other words is only mentioned.
 */
export function pureVersionOf(label: Label): string | null {
  const match = PURE_VERSION.exec(label.rest);
  if (match === null) return null;
  const { matches } = schemeScan(label.rest);
  return matches.length === 1 && matches[0].kind === 'version' && matches[0].value === match[1] ? match[1] : null;
}

/** Module name of a label right below a release train: a plain name, not an activity, document, version or id folder. */
export function moduleOfLabel(label: Label, hasIds: (text: string) => boolean): string | null {
  const text = label.rest;
  if (text === '' || [...text].length > 40 || NOT_MODULE.test(text)) return null;
  if (LINE.test(text) || TRAIN.test(text) || /[0-9]{4,}/.test(text)) return null;
  if (schemeMatches(text).length > 0 || hasIds(text)) return null;
  return text;
}

// ---------------------------------------------------------------- the version scheme

export type SchemeKind = 'build' | 'patch' | 'version';

/** A match of the version scheme inside one label: its kind, the value and where it stands (UTF-16 offsets). */
export type SchemeMatch = { kind: SchemeKind; value: string; start: number; end: number };

/** A label part the scheme read but could not use: an invalid build date or patch number (kept for the notes). */
export type SchemeReject = { kind: 'build' | 'patch'; text: string };

const BUILD_DATE = /build[\s_-]*([0-9]{8})(?![0-9])/giu;
const PATCH_RUN = /patch[\s_-]*([0-9][0-9.]*)/giu;
const PATCH_NUMBER = /^[0-9]{1,3}(?:\.[0-9]{1,3})?$/;
const VERSION = /(?<![0-9.])v?([0-9]{1,3}(?:\.[0-9]{1,3}){1,3})(?![0-9]|\.[0-9])/giu;
/**
 * A number right after a protocol name is a protocol version (TLSv1.3, SSL3.0, HTTP/1.1), never a product version; after a
 * space only a short one is (TLS 1.2, but SSL 10.6.1 names a module and a product version).
 */
const PROTOCOL_GLUED = /(?:tls|ssl|dtls|https?|snmp|ssh|tlcp|quic|smb)[v/]?$/i;
const PROTOCOL_SPACED = /(?:tls|ssl|dtls|https?|snmp|ssh|tlcp|quic|smb)\s+v?$/i;
const SHORT_PROTOCOL_VERSION = /^[0-3]\.[0-9]$/;
/** A number followed by a unit is a quantity (1.5倍, 0.5 秒, 2.5GB), never a version. */
const UNIT_AFTER = /^\s*(?:倍|秒|分钟|小时|天|次|个|条|%|ms\b|s\b|kb\b|mb\b|gb\b|kbps\b|mbps\b|gbps\b|万)/i;

/** Why a dotted number is not a version (a guard of this pack beside the owner's regular expression), or null. */
export function notAVersion(text: string, start: number, end: number, value: string): string | null {
  const before = text.slice(Math.max(0, start - 8), start);
  if (PROTOCOL_GLUED.test(before) || (PROTOCOL_SPACED.test(before) && SHORT_PROTOCOL_VERSION.test(value))) return 'protocol';
  if (UNIT_AFTER.test(text.slice(end, end + 8))) return 'quantity';
  const parts = value.split('.');
  if ((parts.length === 4 && Number(parts[0]) >= 100) || /^[/:][0-9]/.test(text.slice(end, end + 2))) return 'address';
  return null;
}

/**
 * The scheme on one text in matching form, in priority order: build dates first (and masked), then patches (masked), then
 * versions, so that `patch1.2` is a patch and never version 1.2. Matches are returned in text order.
 */
export function schemeScan(text: string): { matches: SchemeMatch[]; rejects: SchemeReject[] } {
  const matches: SchemeMatch[] = [];
  const rejects: SchemeReject[] = [];
  let masked = text;
  const mask = (start: number, end: number): void => {
    masked = `${masked.slice(0, start)}${' '.repeat(end - start)}${masked.slice(end)}`;
  };
  for (const m of text.matchAll(BUILD_DATE)) {
    const digits = m[1];
    const start = m.index ?? 0;
    const end = start + m[0].length;
    if (validDate(Number(digits.slice(0, 4)), Number(digits.slice(4, 6)), Number(digits.slice(6, 8)))) matches.push({ kind: 'build', value: digits, start, end });
    else rejects.push({ kind: 'build', text: m[0] });
    mask(start, end);
  }
  for (const m of masked.matchAll(PATCH_RUN)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    // One trailing dot ends a sentence; a run like patch1.2.3 is no patch number. It is masked either way, so it never
    // reads as a version.
    const number = m[1].endsWith('.') ? m[1].slice(0, -1) : m[1];
    if (PATCH_NUMBER.test(number)) matches.push({ kind: 'patch', value: number, start, end });
    else rejects.push({ kind: 'patch', text: text.slice(start, end) });
    mask(start, end);
  }
  for (const m of masked.matchAll(VERSION)) {
    const value = m[1];
    const end = (m.index ?? 0) + m[0].length;
    const start = end - value.length;
    if (notAVersion(masked, start, end, value) === null) matches.push({ kind: 'version', value, start, end });
  }
  matches.sort((a, b) => a.start - b.start);
  return { matches, rejects };
}

export function schemeMatches(text: string): SchemeMatch[] {
  return schemeScan(text).matches;
}

// ---------------------------------------------------------------- version lines

function digits(text: string): string {
  return text.replace(/^0+(?=[0-9])/, '');
}

/**
 * Key that compares version lines (the product pack's rule): digits without leading zeros, trailing `.0` parts beyond the
 * second dropped, so 10.6, 10.6.0 and 010.6 name one line.
 */
export function lineKey(line: string): string {
  const text = line.trim().toLowerCase().replace(/^v/, '');
  if (!/^[0-9]{1,9}(?:\.[0-9]{1,9}){0,5}$/.test(text)) return text;
  const parts = text.split('.').map(digits);
  while (parts.length > 2 && parts[parts.length - 1] === '0') parts.pop();
  return parts.join('.');
}

/** Two versions agree when one is the other or a dotted prefix of it (10.6 and 10.6.1 agree; 10.6.0 and 10.6.1 do not). */
export function versionsAgree(a: string, b: string): boolean {
  const x = a.trim().toLowerCase().replace(/^v/, '').split('.').map(digits);
  const y = b.trim().toLowerCase().replace(/^v/, '').split('.').map(digits);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) if (x[i] !== y[i]) return false;
  return true;
}

/** The version line a version belongs to: its first three numbers (10.6.1.57 → 10.6.1). */
export function lineOfVersion(version: string): string {
  return version.split('.').slice(0, 3).join('.');
}

/** Two versions of one version line: their first three numbers name one line (10.6.1.57 and 10.6.1; not 10.6 and 10.6.1). */
export function sameLine(a: string, b: string): boolean {
  return lineKey(lineOfVersion(a)) === lineKey(lineOfVersion(b));
}

// ---------------------------------------------------------------- build names

/** A family token of a build name: the product names that can stand in one (APV, NSAE). */
export const FAMILY_NAME = /^[A-Za-z][A-Za-z0-9]{0,31}$/;

/** `Rel|Beta <sep> family[-PLATFORM] <sep> n <sep> n ...` with `<sep>` either `_` or `.` throughout (the product's names). */
const BUILD_NAME = /(?<![A-Za-z0-9])(Rel|Beta)([_.])([A-Za-z][A-Za-z0-9]{0,31})((?:-[A-Za-z0-9]{1,16}){0,6})\2([0-9]{1,9}(?:\2[0-9]{1,9}){1,15})(?![0-9])/giu;

export type BuildName = { name: string; kind: string; separator: string; family: string; platform: string; numbers: string };

/** Build names written in a text, in text order. */
export function buildNames(text: string): BuildName[] {
  const out: BuildName[] = [];
  for (const m of nfkc(text).matchAll(BUILD_NAME)) out.push({ name: m[0], kind: m[1], separator: m[2], family: m[3], platform: m[4], numbers: m[5] });
  return out;
}

/**
 * The build names written in some texts, as written: those of a name family of the bound line (a name of the line that can
 * stand in a build name) and, apart, the others. Nothing is derived: an NSAE name of an older line is based on an APV build
 * with another number, so a name with the same numbers in another family, or one made from a version, would be a guess. The
 * knowledge base resolves names and aliases; a pack check does not see it.
 */
export function writtenBuilds(texts: readonly string[], names: readonly string[], max: number): { names: string[]; foreign: string[] } {
  const families = names.filter((name) => FAMILY_NAME.test(name)).map(fold);
  const own: string[] = [];
  const foreign: string[] = [];
  for (const text of texts) {
    for (const b of buildNames(text)) {
      const list = families.includes(fold(b.family)) ? own : foreign;
      if (list.length < max && !list.includes(b.name)) list.push(b.name);
    }
  }
  return { names: own, foreign };
}

/** Bound-family build names in this label, with the product naming rule for their version line. */
export function buildVersionsOf(label: Label, names: readonly string[]): Array<{ name: string; version: string }> {
  const own = new Set(writtenBuilds([label.text], names, 24).names);
  return buildNames(label.text).filter(build => own.has(build.name)).map(build => {
    const numbers = build.numbers.split(build.separator).map(digits);
    // The product naming rule keeps a trailing zero in the line (Rel_APV_10_7_0_12 is 10.7.0). lineKey is only for
    // comparing lines, where 10.7.0 and 10.7 name one line.
    const version = (numbers.length >= 4 ? numbers.slice(0, 3) : numbers.length === 3 ? numbers.slice(0, 2) : numbers).join('.');
    return { name: build.name, version };
  });
}
