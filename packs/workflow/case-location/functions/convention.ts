// Product facts of the case-location scheme (pack data of the line the workflow binds, never core code): the agile tree's
// folder convention under the product project (`NNN：<line>` → `NNN：<line>-<train>` → module → document), the version
// form of a whole folder label, version labels (a label that is only a version), and the build names written in the line's
// name families (`Rel_<FAMILY>_<n>_<n>_<n>_<build>`), found as written and never derived.
//
// famx-directory@1 (declared grammar; origin: the line's directory naming as reviewed, docs/hub-r4-architecture.md 6a,
// declared for the owner's R6 rule 2026-10-24). Every layer is read from a whole label, by syntax only:
//   prefix code   three ASCII letters or digits with at least one digit, in up to four `-`-joined groups, then optional
//                 spaces and an ASCII or full-width colon;
//   line          the whole label after the code is `v?<n.n[.n[.n]]>`;
//   train         the whole label after the code is `v?<n.n[.n[.n]]>`, one or more of `-`, `_` or a space, then a
//                 non-empty single-line suffix;
//   module        the whole label below a train node: one line, 1 to 1000 characters;
//   version label the whole label is an optional name prefix of letters, `_` and `-`, an optional `v` and the numbers.
// Nothing is folded (no NFKC, no case or width folding) and nothing is excluded by meaning: a label the grammar does not
// read is an unknown layer with the exit that the pack author declares the form or the author renames the folder.
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
const PREFIX = /^((?=[0-9A-Za-z-]*[0-9])[0-9A-Za-z]{3}(?:-[0-9A-Za-z]{3}){0,3})\s*[:：]\s*/;
const LINE = /^v?([0-9]{1,3}(?:\.[0-9]{1,3}){1,3})$/i;
const TRAIN = /^v?([0-9]{1,3}(?:\.[0-9]{1,3}){1,3})[-_\s]+([^\r\n]+)$/i;

export type Label = {
  /** The label in matching form (NFKC, white space squeezed, cut at MAX_LABEL). */
  text: string;
  /** The prefix code, or null when the label has none. */
  code: string | null;
  /** The text after the prefix code (the whole text without one). */
  rest: string;
};

export function parseLabel(raw: string): Label {
  const text = raw.slice(0, MAX_LABEL);
  const match = PREFIX.exec(text);
  return match ? { text, code: match[1], rest: text.slice(match[0].length).trim() } : { text, code: null, rest: text };
}

/** The version line of a line node `NNN：<line>`, or null when the label after the code is not wholly a line. */
export function lineOfLabel(label: Label): string | null {
  if (label.code === null) return null;
  // LINE consumes the whole label after the code, so an optional `v` prefix cannot hide a version mentioned in words.
  const match = LINE.exec(label.rest);
  return match === null ? null : match[1];
}

/** A release train node `NNN：<line>-<suffix>` (or `_`, or a space before the suffix): the train text and its version, or null. */
export function trainOfLabel(label: Label): { train: string; version: string } | null {
  if (label.code === null) return null;
  // TRAIN consumes the whole label after the code, so the version it names cannot be one mentioned inside other words.
  const match = TRAIN.exec(label.rest);
  return match === null ? null : { train: label.rest, version: match[1] };
}

/** famx-directory@1, version form: two to four dotted numbers of one to three digits, with an optional `v` or `V`. */
const NUMBERS = /^v?([0-9]{1,3}(?:\.[0-9]{1,3}){1,3})$/i;

/**
 * The version of a whole text in the declared version form: the numbers alone (`10.6.1`, `V10.7.0`), or a declared name of
 * the bound line, one `_` or `-`, and the numbers (`FAMY_10.7.3`, `FAMX-10.7.6`). The name is compared by exact equality
 * with the names the run bound (U23: no case or width folding, no synonym), so an arbitrary word before the numbers is
 * not a version form: `patch1.2`, `TLSv1.3` and `build20260315` are labels this grammar does not read, and the layer
 * stays unknown with the author's exit, rather than becoming a version by its shape or by a retired word guard.
 */
export function versionForm(text: string, names: readonly string[] = []): string | null {
  const bare = NUMBERS.exec(text);
  if (bare !== null) return bare[1];
  for (const separator of ['_', '-']) {
    const at = text.indexOf(separator);
    if (at <= 0 || !names.includes(text.slice(0, at))) continue;
    const rest = NUMBERS.exec(text.slice(at + 1));
    if (rest !== null) return rest[1];
  }
  return null;
}

/**
 * The version of a version label: a label whose whole text after the prefix code is a version in the declared form. A
 * version written among other words is not read here (nothing is extracted from prose).
 */
export function pureVersionOf(label: Label, names: readonly string[] = []): string | null {
  return versionForm(label.rest, names);
}

/** Module name of a label right below a release train: a plain name, not an activity, document, version or id folder. */
export function moduleOfLabel(label: Label, _hasIds: (text: string) => boolean): string | null {
  return /^[^\r\n]{1,1000}$/.test(label.rest) ? label.rest : null;
}

// ---------------------------------------------------------------- the version scheme

export type SchemeKind = 'build' | 'patch' | 'version';

/** A match of the version scheme inside one label: its kind, the value and where it stands (UTF-16 offsets). */
export type SchemeMatch = { kind: SchemeKind; value: string; start: number; end: number };

/** A label part the scheme read but could not use: an invalid build date or patch number (kept for the notes). */
export type SchemeReject = { kind: 'build' | 'patch'; text: string };

// The retired build-date, patch-run and in-prose version patterns are gone: the scheme reads a whole label only.
/** famx-directory@1 accepts a whole label only: a version that does not span the text is outside the grammar ('grammar').
 * No semantic exclusion (protocol, unit, quantity, address) is applied any more — the syntax decides, and a label the
 * grammar does not read is an unknown layer with its exit. */
export function notAVersion(text:string,start:number,end:number,_value:string): string|null {
  return start===0 && end===text.length ? null : 'grammar';
}
/** The scheme over one text: the declared version form when the whole text is a version, otherwise nothing. No prose is
 * scanned and no build date or patch number is read any more, so nothing is rejected for its shape either. */
export function schemeScan(text: string, names: readonly string[] = []): { matches: SchemeMatch[]; rejects: SchemeReject[] } {
  const value = versionForm(text, names);
  return { matches: value === null ? [] : [{ kind: 'version', value, start: 0, end: text.length }], rejects: [] };
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

/** A family token of a build name: the product names that can stand in one (FAMX, FAMY). */
export const FAMILY_NAME = /^[A-Za-z][A-Za-z0-9]{0,31}$/;

/** `Rel|Beta <sep> family[-PLATFORM] <sep> n <sep> n ...` with `<sep>` either `_` or `.` throughout (the product's names). */
const BUILD_NAME = /^(Rel|Beta)([_.])([A-Za-z][A-Za-z0-9]{0,31})((?:-[A-Za-z0-9]{1,16}){0,6})\2([0-9]{1,9}(?:\2[0-9]{1,9}){1,15})(?![0-9])/giu;

export type BuildName = { name: string; kind: string; separator: string; family: string; platform: string; numbers: string };

/** Build names written in a text, in text order. */
export function buildNames(text: string): BuildName[] {
  const out: BuildName[] = [];
  for (const m of text.matchAll(BUILD_NAME)) out.push({ name: m[0], kind: m[1], separator: m[2], family: m[3], platform: m[4], numbers: m[5] });
  return out;
}

/**
 * The build names written in some texts, as written: those of a name family of the bound line (a name of the line that can
 * stand in a build name) and, apart, the others. Nothing is derived: an FAMY name of an older line is based on an FAMX build
 * with another number, so a name with the same numbers in another family, or one made from a version, would be a guess. The
 * knowledge base resolves names and aliases; a pack check does not see it.
 */
export function writtenBuilds(texts: readonly string[], names: readonly string[], max: number): { names: string[]; foreign: string[] } {
  const families = names.filter((name) => FAMILY_NAME.test(name));
  const own: string[] = [];
  const foreign: string[] = [];
  for (const text of texts) {
    for (const b of buildNames(text)) {
      const list = families.includes(b.family) ? own : foreign;
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
    // The product naming rule keeps a trailing zero in the line (Rel_FAMX_10_7_0_12 is 10.7.0). lineKey is only for
    // comparing lines, where 10.7.0 and 10.7 name one line.
    const version = (numbers.length >= 4 ? numbers.slice(0, 3) : numbers.length === 3 ? numbers.slice(0, 2) : numbers).join('.');
    return { name: build.name, version };
  });
}
