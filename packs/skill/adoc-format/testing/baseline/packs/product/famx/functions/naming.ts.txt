// U24 owner ruling 2026-10-24: line leading zeroes and trailing .0 do not change version-line identity; build ids remain exact.
// Naming of the FAMX/FAMY product line (product knowledge, pack data): the two name families, build names, listing page
// names and version lines. Pure functions over strings.
import type { Family, PageKind } from './types.ts';
import { compareDigits } from './util.ts';

/** Name tokens of the product line (lower case) and the family each names. FAMX and FAMY are one product. */
export const PRODUCT_NAMES: Readonly<{ [token: string]: Family }> = { famx: 'FAMX', famy: 'FAMY' };

/** Every name of the product line, for bindings and display. */
export const PRODUCT_LINE = { id: 'famx', names: ['FAMX', 'FAMY'] } as const;

/** Platform token sequences in listing page names (lower case), longest first when they share a start. */
export const PAGE_PLATFORMS: readonly (readonly string[])[] = [
  ['sy', 'demoos12'],
  ['sy', 'demoos13'],
  ['sy', 'k'],
  ['sy', 'u'],
  ['sz', 'demoos10'],
  ['sz', 'k'],
  ['zx', 'demoos11'],
  ['zx', 'demoos12'],
  ['zx', 'u'],
  ['zx', 'n'],
  ['demoos14', 'sy'],
  ['sv', 'k'],
  ['demoarch'],
  ['demoarch2'],
  ['legacydemoos'],
];


export function familyOf(token: string): Family {
  const key = token.toLowerCase();
  return Object.hasOwn(PRODUCT_NAMES, key) ? PRODUCT_NAMES[key] : 'other';
}

/** Canonical decimal text of a digit run (leading zeros dropped). */
function digits(text: string): string {
  return text.replace(/^0+(?=\d)/, '');
}

export type BuildNameParts = {
  family: Family;
  platform: string | null;
  line: string | null;
  number: string | null;
  /** Prefix and suffix around the core name, with * for the core; null for a plain name. */
  variant: string | null;
};

// [prefix-]Rel|Beta <sep> family[-PLAT-FORM] <sep> n <sep> n ... [suffix], with <sep> either '_' or '.' throughout.
const BUILD_NAME = /^([A-Za-z][A-Za-z0-9]{0,31}[-_])?(Rel|Beta)([_.])([A-Za-z][A-Za-z0-9]{0,31})((?:-[A-Za-z0-9]{1,16}){0,6})\3([0-9]{1,9}(?:\3[0-9]{1,9}){1,15})(.*)$/i;

/**
 * Parts of a build name. The first three numbers are the version line and the rest the build number (Rel_FAMX_10_6_1_57:
 * 10.6.1 and 57); a name with three numbers has a two-number line, a name with two numbers no build number.
 */
export function parseBuildName(name: string): BuildNameParts {
  const none: BuildNameParts = { family: 'other', platform: null, line: null, number: null, variant: null };
  if (typeof name !== 'string' || name.length > 512) return none;
  const match = BUILD_NAME.exec(name);
  if (!match) return none;
  const [, prefix, , separator, familyToken, platformText, numberText, suffix] = match;
  const numbers = numberText.split(separator).map(digits);
  const platform = platformText ? platformText.slice(1).toLowerCase() : null;
  let line: string;
  let number: string | null;
  if (numbers.length >= 4) {
    line = numbers.slice(0, 3).join('.');
    number = numbers.slice(3).join('.');
  } else if (numbers.length === 3) {
    line = numbers.slice(0, 2).join('.');
    number = numbers[2];
  } else {
    line = numbers.join('.');
    number = null;
  }
  const variant = prefix || suffix ? `${prefix ?? ''}*${suffix ?? ''}` : null;
  return { family: familyOf(familyToken), platform, line, number, variant };
}

/**
 * Key that compares version lines: digits without leading zeros and trailing `.0` parts beyond the second dropped, so
 * 10.6, 10.6.0 and 010.6 name one line. Text that is not a dotted number is only trimmed and lower-cased.
 */
export function lineKey(line: string): string {
  const text = line;
  if (!/^[0-9]{1,9}(?:\.[0-9]{1,9}){0,5}$/.test(text)) return text;
  const parts = text.split('.').map(digits);
  while (parts.length > 2 && parts[parts.length - 1] === '0') parts.pop();
  return parts.join('.');
}

export function sameLine(a: string | null, b: string | null): boolean {
  return a !== null && b !== null && lineKey(a) === lineKey(b);
}

/** Orders line keys numerically part by part (10.6.2 before 10.6.10); non-numeric keys after numeric ones, by text. */
export function compareLines(a: string | null, b: string | null): number {
  const x = a === null ? null : lineKey(a);
  const y = b === null ? null : lineKey(b);
  if (x === y) return 0;
  if (x === null) return -1;
  if (y === null) return 1;
  const numericX = /^[0-9.]+$/.test(x);
  const numericY = /^[0-9.]+$/.test(y);
  if (numericX !== numericY) return numericX ? -1 : 1;
  if (!numericX) return x < y ? -1 : 1;
  const p = x.split('.');
  const q = y.split('.');
  for (let i = 0; i < Math.min(p.length, q.length); i++) {
    const order = compareDigits(p[i], q[i]);
    if (order !== 0) return order;
  }
  return p.length - q.length;
}

export type PageNameParts = { family: Family; line: string; platform: string | null; kind: PageKind; tokens: string[] };

function matchPlatform(tokens: readonly string[], at: number, fromEnd: boolean): { platform: string; length: number } | null {
  for (const sequence of PAGE_PLATFORMS) {
    const start = fromEnd ? tokens.length - sequence.length : at;
    if (start < at || start + sequence.length > tokens.length) continue;
    if (sequence.every((token, k) => tokens[start + k] === token)) return { platform: sequence.join('-'), length: sequence.length };
  }
  return null;
}

function pageTokens(name: string): string[] | null {
  if (typeof name !== 'string' || name.length === 0 || name.length > 256) return null;
  return name.toLowerCase().split(/[_\-\s]+/).filter((token) => token !== '');
}

export type HubNameParts = { family: Family; line: string | null; tokens: string[] };

/**
 * A hub page by its name: a product name without `rel_`, followed only by version numbers (famx_10_7, famx_10_6_4: the
 * hub of that line) or by no version at all (famx_trunk, famx_10_x_patch). Hub pages link listing pages (brief section 8).
 * Null for anything else: `rel_` names, and product names with a version and more words (famx_10_6_3_special) are listing
 * pages.
 */
export function parseHubName(name: string): HubNameParts | null {
  const tokens = pageTokens(name);
  if (tokens === null || tokens.length === 0 || tokens[0] === 'rel') return null;
  const family = Object.hasOwn(PRODUCT_NAMES, tokens[0]) ? PRODUCT_NAMES[tokens[0]] : null;
  if (family === null) return null;
  const rest = tokens.slice(1);
  let numbers = 0;
  while (numbers < rest.length && /^[0-9]{1,9}$/.test(rest[numbers])) numbers++;
  if (numbers === rest.length) return { family, line: numbers >= 2 ? rest.slice(0, 3).map(digits).join('.') : null, tokens };
  if (numbers < 2) return { family, line: null, tokens };
  return null;
}

/**
 * Classifies a listing page by its name (without the extension): `[rel_]<family>[_<platform>]_<n>_<n>[...]_<tokens>`.
 * Mainline: only the version (or a token explicitly supplied by the sync options); platform: the version and a platform; patch: any
 * `patch` token; customer: anything else (customer, POC, feature and special branches, extra build numbers). Names
 * without `rel_` must start with a product name and carry more than a version. Returns null for hub pages and for names
 * that are not listing pages of a version.
 */
export function parsePageName(name: string, mainlineWords: readonly string[] = []): PageNameParts | null {
  const tokens = pageTokens(name);
  if (tokens === null || parseHubName(name) !== null) return null;
  let at = 0;
  const release = tokens[0] === 'rel';
  if (release) at++;
  const familyToken = tokens[at];
  if (familyToken === undefined || !/^[a-z]+$/.test(familyToken)) return null;
  const family = familyOf(familyToken);
  if (!release && family === 'other') return null;
  at++;
  let platform: string | null = null;
  const leading = matchPlatform(tokens, at, false);
  if (leading) {
    platform = leading.platform;
    at += leading.length;
  }
  const numbers: string[] = [];
  while (at < tokens.length && /^[0-9]{1,9}$/.test(tokens[at])) numbers.push(digits(tokens[at++]));
  if (numbers.length < 2) return null;
  const line = numbers.slice(0, 3).join('.');
  const extra = numbers.slice(3);
  let tail = tokens.slice(at);
  const trailing = matchPlatform(tail, 0, true);
  if (trailing) {
    platform = trailing.platform;
    tail = tail.slice(0, tail.length - trailing.length);
  }
  let kind: PageKind;
  // famx-pages@1 (declared for the owner's R6 rule, 2026-10-24): a page name is a patch page when its last tail token is
  // exactly `patch` or `patch<n[.n]>` (a whole token, never a prefix), a mainline or platform page when every tail token
  // is in the declared mainline word list (a closed declaration of the product, not a guess), and a customer page when
  // its tail is exactly `customer_<identifier>`.
  // Anything else is not a declared page form and is null: the retired rule matched a `patch` prefix and fell back to
  // "customer" for whatever tokens were left.
  const last = tail[tail.length - 1];
  if (last !== undefined && /^patch(?:[0-9]+(?:\.[0-9]{1,3})?)?$/.test(last)) kind = 'patch';
  else if (extra.length === 0 && tail.every((token) => mainlineWords.includes(token))) kind = platform === null ? 'mainline' : 'platform';
  else if (tail.length === 2 && tail[0] === 'customer' && /^[A-Za-z0-9]+$/.test(tail[1])) kind = 'customer';
  else return null;
  return { family, line, platform, kind, tokens };
}

/** Complete native grammar only; the Hub separately checks exact membership in its frozen build inventory. */
export function validateBuildNames(input:unknown):{accepted:string[];rejected:string[]}{const values=input&&typeof input==='object'&&'names'in input&&Array.isArray(input.names)?input.names:[];return{accepted:values.filter((v):v is string=>typeof v==='string'&&parseBuildName(v).line!==null),rejected:values.filter((v):v is string=>typeof v==='string'&&parseBuildName(v).line===null)};}

/**
 * The spelling a device's version display shows for a build: the build-site spelling with every `_` replaced by `.`
 * (synthetic example: `Beta_FAMX-ZX-U_10_8_0_901` displays as `Beta.FAMX-ZX-U.10.8.0.901`). This is an identity rule of
 * this pack's naming syntax under C07 R[9] — the one declared replacement and nothing else: no case folding, no other
 * separator handling, no vendor prefix handling (the executor's extraction pattern removes that prefix before the Hub
 * compares). The spelling is a verified alias of the build by this declaration alone; the Hub core still compares
 * exactly and never normalises.
 */
export function deviceSpelling(name: string): string {
  return name.replaceAll('_', '.');
}
