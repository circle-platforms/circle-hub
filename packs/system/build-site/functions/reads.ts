// Read functions of the build-site system pack (pure, run in the Hub sandbox). Two reads:
// - buildsite:listing:<page>: one page of the site, GET <base>/<page>.html, parsed with html@1 by the Hub (route `page`).
//   The key `index` stands for the index page the resource names in settings.index_page (default index.html).
// - buildsite:file:<link>: a file a listing page links (a command tree, a fixed-bug list): the key is the link as written,
//   without scheme and authority, with %, @, white space and controls percent-encoded. The Hub resolves it against the base
//   URL (a relative link) or the origin (a link starting with /) and refuses anything outside the role's base path.

type Planned = { key: string; route: string; params?: Record<string, string>; href?: string };
type PlanOutput = { requests: Planned[]; done: boolean };
type PlanInput = { round?: unknown; external?: { key?: unknown }; settings?: Record<string, unknown> };

/** A page name the route admits: letters, digits, _ . - (no slash, so a page never leaves the base directory). */
const PAGE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/;
const DEFAULT_INDEX = 'index.html';

function keyOf(input: unknown): string {
  const key = (input as PlanInput | null)?.external?.key;
  return typeof key === 'string' ? key : '';
}

function settingsOf(input: unknown): Record<string, unknown> {
  const settings = (input as PlanInput | null)?.settings;
  return settings !== null && typeof settings === 'object' && !Array.isArray(settings) ? settings : {};
}

/** The file name of the page a listing key names: `index` is the configured index page; a name gets .html unless it has an extension. */
export function pageFile(key: string, settings: Record<string, unknown>): string | null {
  if (key === 'index') {
    const configured = settings.index_page;
    return typeof configured === 'string' && PAGE.test(configured) ? configured : DEFAULT_INDEX;
  }
  const file = /\.html?$/i.test(key) ? key : `${key}.html`;
  return PAGE.test(file) ? file : null;
}

/** Plan of buildsite:listing:<page>: one request; a key that names no page plans nothing (the read fails, PLAN_INVALID). */
export function listingPlan(input: unknown): PlanOutput {
  const page = pageFile(keyOf(input), settingsOf(input));
  if (page === null) return { requests: [], done: true };
  return { requests: [{ key: 'page', route: 'page', params: { page } }], done: true };
}

/** The link a file key stands for: percent escapes decoded once (the key escapes % itself), or null for a link that cannot be one. */
export function linkOf(key: string): string | null {
  if (key === '' || key.length > 2000) return null;
  let link: string;
  try {
    link = decodeURIComponent(key);
  } catch {
    return null;
  }
  // A scheme or an authority never comes in a key (they are cut off when the key is made); a backslash is never a link.
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(link) || link.startsWith('//') || link.includes('\\')) return null;
  return link;
}

/** The route a linked file is read with, by its extension (query and fragment aside); null for a file type no route reads. */
export function routeOfLink(link: string): 'tree-file' | 'page-file' | null {
  const path = link.split(/[?#]/)[0].toLowerCase();
  if (path.endsWith('.xml')) return 'tree-file';
  if (path.endsWith('.html') || path.endsWith('.htm')) return 'page-file';
  return null;
}

/** Plan of buildsite:file:<link>: the link as found, resolved by the Hub. */
export function filePlan(input: unknown): PlanOutput {
  const link = linkOf(keyOf(input));
  const route = link === null ? null : routeOfLink(link);
  if (link === null || route === null) return { requests: [], done: true };
  return { requests: [{ key: 'file', route, href: link }], done: true };
}

// Code points are compared as numbers: no literal separator or format character, nor its escape, is written in this source.
function mustEscape(code: number): boolean {
  return (
    code === 0x25 ||
    code === 0x40 ||
    code <= 0x20 ||
    (code >= 0x7f && code <= 0xa0) ||
    code === 0xad ||
    code === 0x61c ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200f) ||
    (code >= 0x2028 && code <= 0x202f) ||
    (code >= 0x205f && code <= 0x206f) ||
    code === 0x3000 ||
    code === 0xfeff
  );
}

function escapeKey(link: string): string {
  let out = '';
  for (const ch of link) out += mustEscape(ch.codePointAt(0) as number) ? encodeURIComponent(ch) : ch;
  return out;
}

/**
 * The key of buildsite:file for a link as written on a page: scheme and authority cut off (no host enters an id), then %, @,
 * white space, controls and format characters percent-encoded. Product packs build their source ids with the same rule.
 */
export function fileKey(href: string): string | null {
  let link = href.trim();
  const absolute = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]*/.exec(link);
  if (absolute !== null) link = link.slice(absolute[0].length) || '/';
  else if (link.startsWith('//')) link = link.replace(/^\/\/[^/?#]*/, '') || '/';
  if (link === '' || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(link)) return null;
  return escapeKey(link);
}
