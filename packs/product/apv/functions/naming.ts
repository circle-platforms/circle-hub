// Naming of the APV/NSAE product line (product knowledge, pack data): the two name families, build names, listing page
// names and version lines. Pure functions over strings.
import type { Family, PageKind } from './types.ts';
import { compareDigits } from './util.ts';

/** Name tokens of the product line (lower case) and the family each names. APV and NSAE are one product. */
export const PRODUCT_NAMES: Readonly<{ [token: string]: Family }> = { apv: 'APV', nsae: 'NSAE' };

/** Every name of the product line, for bindings and display. */
export const PRODUCT_LINE = { id: 'apv', names: ['APV', 'NSAE'] } as const;

/** Platform token sequences in listing page names (lower case), longest first when they share a start. */
export const PAGE_PLATFORMS: readonly (readonly string[])[] = [
  ['hg', 'uos'],
  ['hg', 'centos79'],
  ['hg', 'k'],
  ['hg', 'u'],
  ['ft', 'kylinv10'],
  ['ft', 'k'],
  ['zx', 'neokylin'],
  ['zx', 'uos'],
  ['zx', 'u'],
  ['zx', 'n'],
  ['rocky86', 'hg'],
  ['kp', 'k'],
  ['zhaoxin'],
  ['haiguang'],
  ['infosecos'],
];

/** Tokens after the version that still name a mainline page (the brief lists APV 10.4.TLS1.3 among the mainline lines). */
export const MAINLINE_TOKENS: readonly string[] = ['tls13'];

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
 * Parts of a build name. The first three numbers are the version line and the rest the build number (Rel_APV_10_6_1_57:
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
  const text = line.trim().toLowerCase();
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
 * A hub page by its name: a product name without `rel_`, followed only by version numbers (apv_10_7, apv_10_6_4: the
 * hub of that line) or by no version at all (apv_trunk, apv_10_x_patch). Hub pages link listing pages (brief section 8).
 * Null for anything else: `rel_` names, and product names with a version and more words (apv_10_6_3_special) are listing
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
 * Mainline: only the version (or a mainline token such as tls13); platform: the version and a platform; patch: any
 * `patch` token; customer: anything else (customer, POC, feature and special branches, extra build numbers). Names
 * without `rel_` must start with a product name and carry more than a version. Returns null for hub pages and for names
 * that are not listing pages of a version.
 */
export function parsePageName(name: string): PageNameParts | null {
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
  if (tail.some((token) => token === 'patch' || token.startsWith('patch'))) kind = 'patch';
  else if (extra.length === 0 && tail.every((token) => MAINLINE_TOKENS.includes(token))) kind = platform === null ? 'mainline' : 'platform';
  else kind = 'customer';
  return { family, line, platform, kind, tokens };
}
