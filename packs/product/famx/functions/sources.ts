// External object ids of the build-site system pack, as this product pack's sync writes them (the pack functions of two packs
// cannot import each other, so the rule is repeated here; a test keeps both equal):
// - buildsite:listing:<page>  a page of the site by its name (the index page is `index`)
// - buildsite:file:<link>     a file a listing page links, by the link as written without scheme and authority, with %, @,
//                             white space, controls and format characters percent-encoded
// Roles of BuildInfo.sources: `tree` (command_tree-<build>.xml) and `fixed_bugs` (Bugs_Fixed_with_<build>.html).

export const INDEX_ID = 'buildsite:listing:index';
export const SOURCE_ROLES = { tree: 'tree', fixedBugs: 'fixed_bugs' } as const;

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

/** The key of buildsite:file for a link as written on a page; null for a link that is no file of the site (mailto:, empty). */
export function fileKey(href: string): string | null {
  let link = href.trim();
  const absolute = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]*/.exec(link);
  if (absolute !== null) link = link.slice(absolute[0].length) || '/';
  else if (link.startsWith('//')) link = link.replace(/^\/\/[^/?#]*/, '') || '/';
  if (link === '' || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(link)) return null;
  return escapeKey(link);
}

/** The listing read of a page name. */
export function listingId(page: string): string {
  return `buildsite:listing:${page}`;
}

/** The file read of a link, or null when the link cannot be one (a lone surrogate stays raw and makes the id invalid). */
export function fileId(href: string): string | null {
  const key = fileKey(href);
  if (key === null) return null;
  for (let i = 0; i < key.length; i++) {
    const code = key.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdfff) {
      const next = key.charCodeAt(i + 1);
      if (code > 0xdbff || !(next >= 0xdc00 && next <= 0xdfff)) return null;
      i += 1;
    }
  }
  return `buildsite:file:${key}`;
}
