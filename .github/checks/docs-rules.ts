// Rules the docs keep, applied by docs.test.ts: links the docs site can serve, vocabulary tables equal to the generated
// vocabulary, the model's decided and deferred counts, a source for every recorded decision, and no local paths.
import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { lstatSync, readFileSync, readlinkSync } from 'node:fs';

export const REPOSITORY = 'https://github.com/circle-platforms/circle-hub';

export interface Site {
  /** 'file', 'dir' or undefined for a repository-relative path. */
  kind(path: string): 'file' | 'dir' | undefined;
  /** Whether the docs site build (docs/ only) publishes this repository-relative path. */
  published(path: string): boolean;
}

export interface Link {
  target: string;
  line: number;
}

const BANNER = /^> \*\*(历史文档|历史记录|历史调查|已被取代|Superseded|Historical(?: survey)?)\*\*/;

/** A page that opens with a historical or superseded banner is a record; its body is kept as it was. */
export function isHistorical(markdown: string): boolean {
  const first = markdown.split('\n').slice(0, 15).find((line) => line.startsWith('> **'));
  return first !== undefined && BANNER.test(first);
}

/** Link targets outside code blocks and code spans: inline links and images, reference definitions, href and src. */
export function linksOf(markdown: string): Link[] {
  const links: Link[] = [];
  let fence: string | undefined;
  markdown.split('\n').forEach((raw, index) => {
    const opener = /^\s{0,3}(`{3,}|~{3,})/.exec(raw);
    if (opener) {
      if (fence === undefined) fence = opener[1][0];
      else if (opener[1][0] === fence) fence = undefined;
      return;
    }
    if (fence !== undefined) return;
    const line = raw.replace(/(`+)[^`]*?\1/g, '');
    const found = [
      ...[...line.matchAll(/!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g)].map((m) => m[1]),
      ...[...line.matchAll(/\b(?:href|src)="([^"]+)"/g)].map((m) => m[1]),
    ];
    const definition = /^\s{0,3}\[[^\]]+\]:\s*<?([^\s>]+)>?/.exec(line);
    if (definition) found.push(definition[1]);
    for (const target of found) links.push({ target, line: index + 1 });
  });
  return links;
}

function decode(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/**
 * Problems with the links of one published page (`page` is repository-relative, under docs/). The site is built from docs/
 * alone, so a relative link that leaves docs/ is a 404 there; such targets take an absolute link to the file on main, and
 * that file must exist in this tree.
 */
export function linkProblems(page: string, markdown: string, site: Site): string[] {
  const problems: string[] = [];
  const mainPrefix = new RegExp(`^${REPOSITORY.replace(/[.]/g, '\\.')}/(?:blob|tree)/main/`);
  for (const { target, line } of linksOf(markdown)) {
    const at = `${page}:${line} ${target}`;
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) {
      if (!mainPrefix.test(target)) continue;
      const path = decode(target.replace(mainPrefix, '').split(/[#?]/)[0]).replace(/\/$/, '');
      if (site.kind(path) === undefined) problems.push(`${at}: links to ${path} on main, which is not in this tree`);
      continue;
    }
    if (target.startsWith('#')) continue;
    if (target.startsWith('/')) {
      problems.push(`${at}: a site-absolute link misses the site's base URL; use a relative link`);
      continue;
    }
    const path = posix.normalize(posix.join(posix.dirname(page), decode(target.split(/[#?]/)[0]))).replace(/\/$/, '');
    if (path !== 'docs' && !path.startsWith('docs/')) {
      problems.push(`${at}: leaves docs/, so the docs site cannot serve it; link ${REPOSITORY}/blob/main/${path} instead`);
      continue;
    }
    const kind = site.kind(path);
    if (kind === undefined) problems.push(`${at}: ${path} does not exist`);
    else if (kind === 'dir') {
      if (!site.published(`${path}/README.md`) && !site.published(`${path}/index.md`)) problems.push(`${at}: the site has no page for ${path}/`);
    } else if (!site.published(path)) problems.push(`${at}: ${path} is excluded from the docs site`);
  }
  return problems;
}

export interface Axis {
  label: string;
  values: readonly { code: string; label: string }[];
}

/**
 * Rows of a vocabulary table are hand-copied from the generated vocabulary, so they must stay equal to it. Chinese rows are
 * `| \`axis\` | axis label | labels |`, English rows `| \`axis\` | codes |`; values are separated by 、 or , (or > for a ranking).
 */
export function vocabularyTableProblems(markdown: string, lang: 'zh' | 'en', axes: Readonly<Record<string, Axis>>): string[] {
  const problems: string[] = [];
  let rows = 0;
  for (const raw of markdown.split('\n')) {
    const cells = raw.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    const name = /^`([a-z_]+)`$/.exec(cells[0] ?? '');
    if (!raw.trim().startsWith('|') || name === null) continue;
    rows += 1;
    const axis = axes[name[1]];
    if (axis === undefined) {
      problems.push(`${name[1]}: not a vocabulary axis`);
      continue;
    }
    if (lang === 'zh') {
      if (cells[1] !== axis.label) problems.push(`${name[1]}: label ${JSON.stringify(cells[1])}, generated ${JSON.stringify(axis.label)}`);
      const shown = (cells[2] ?? '').split(/\s*(?:、|>)\s*/);
      const generated = axis.values.map((v) => v.label);
      if (shown.join('|') !== generated.join('|')) problems.push(`${name[1]}: values ${shown.join('、')}, generated ${generated.join('、')}`);
    } else {
      const shown = (cells[1] ?? '').split(/\s*(?:,|>)\s*/).map((c) => c.replace(/`/g, ''));
      const generated = axis.values.map((v) => v.code);
      if (shown.join('|') !== generated.join('|')) problems.push(`${name[1]}: codes ${shown.join(', ')}, generated ${generated.join(', ')}`);
    }
  }
  if (rows === 0) problems.push('no vocabulary table row found');
  return problems;
}

export interface Pending {
  item: string;
  status?: string;
}

/**
 * A page that summarises the model's pending items states how many there are, how many are decided and how many deferred,
 * with the model's own words: "19 项待定 … 17 项已定，2 项暂缓" or "19 pending items … 17 are decided and 2 are deferred".
 * Chinese pages also name every deferred item as the model does.
 */
export function pendingSummaryProblems(markdown: string, lang: 'zh' | 'en', pending: readonly Pending[]): string[] {
  const problems: string[] = [];
  const decided = pending.filter((p) => p.status === '已定');
  const deferred = pending.filter((p) => p.status === '暂缓');
  const other = pending.filter((p) => p.status !== '已定' && p.status !== '暂缓');
  if (other.length > 0) problems.push(`the model has ${other.length} pending items that are neither decided nor deferred; say so`);
  const stated =
    lang === 'zh'
      ? /(\d+) 项待定[^。]*?(\d+) 项已定[^。]*?(\d+) 项[^。]{0,12}暂缓/.exec(markdown)
      : /(\d+) pending items[^.]*?(\d+) are decided[^.]*?(\d+) are deferred/.exec(markdown);
  if (stated === null) return [...problems, 'the page does not state how many pending items are decided and how many deferred'];
  const [total, yes, later] = stated.slice(1).map(Number);
  if (total !== pending.length) problems.push(`states ${total} pending items, the model has ${pending.length}`);
  if (yes !== decided.length) problems.push(`states ${yes} decided, the model has ${decided.length}`);
  if (later !== deferred.length) problems.push(`states ${later} deferred, the model has ${deferred.length}`);
  if (lang === 'zh') for (const p of deferred) if (!markdown.includes(p.item)) problems.push(`does not name the deferred item ${JSON.stringify(p.item)}`);
  return problems;
}

/** Every numbered entry of the progress page's 决定 section names where it comes from (来源：…). */
export function decisionSourceProblems(markdown: string): string[] {
  const start = markdown.search(/^## 决定$/m);
  if (start === -1) return ['no 决定 section'];
  const rest = markdown.slice(start + 1);
  const end = rest.search(/^## /m);
  const section = end === -1 ? rest : rest.slice(0, end);
  const entries = section.split(/^(?=\d+\. )/m).filter((e) => /^\d+\. /.test(e));
  if (entries.length === 0) return ['the 决定 section has no numbered entry'];
  return entries.filter((e) => !e.includes('来源：')).map((e) => `decision ${/^(\d+)/.exec(e)?.[1]} names no source (来源：…)`);
}

// Build sensitive shapes from pieces so the checker does not match its own source.
const ROOT_BOUNDARY = '(?:(?<=file://)|(?<![A-Za-z0-9_./\\-]))';
const LOCAL_PATH = new RegExp([
  '/' + 'Users/[^/\\s`"\'<>),;:]+',
  '/' + 'home/[^/\\s`"\'<>),;:]+',
  ROOT_BOUNDARY + '(?:/' + 'root/(?=[A-Za-z0-9_.-])[^\\s`"\'<>),;:]+|(?:/private)?/' + 'var/(?=[A-Za-z0-9_.-])[^\\s`"\'<>),;:]+)',
  ROOT_BOUNDARY + '~' + '/(?=[A-Za-z0-9])',
  "[A-Za-z]:\\\\{1,2}" + "[Uu][Ss][Ee][Rr][Ss](?:\\\\{1,2}|/)",
  "(?<![A-Za-z0-9_.+-])[A-Za-z]:/" + "[Uu][Ss][Ee][Rr][Ss](?:\\\\{1,2}|/)",
].join('|'), 'g');

// Exact synthetic home roots are permitted only in the named test files. No directory-wide exemptions.
const SYNTHETIC_PATHS: Readonly<Record<string, readonly string[]>> = {
  'hub/platform/layout.test.ts': ['/' + 'Users/someone', '/' + 'Users/x'],
  'hub/platform/launchd.test.ts': ['/' + 'Users/someone'],
  'hub/platform/environment.test.ts': ['/' + 'Users/x'],
  'contracts/src/tool-shapes.test.ts': ['/' + 'Users/alice'],
  'hub/records/scan.test.ts': ['/' + 'home/synthetic', '/' + 'home/user'],
  'hub/config/config.test.ts': ['/' + 'var/log/hub'],
};


// Only the original, hash-pinned third-party bytes may contain their upstream synthetic home example.
const VENDORED_SYNTHETIC_PATHS: Readonly<Record<string, { sha256: string; paths: readonly string[] }>> = {
  'packs/product/famx/functions/adoc/vendor/core.mjs': {
    sha256: '5a8785bf8dc39a216170b836bb274957f079f77e5f40b33453c988f85de9203d',
    paths: ['/' + 'Users/foo'],
  },
};

function archived(file: string): boolean {
  return file.startsWith('foundation/') || file.startsWith('references/');
}

/** Only normalized network hosts qualify; malformed and machine-local URLs remain checked. */
function networkPathURL(token:string):boolean {
  try{
    const url=new URL(token),host=url.hostname.toLowerCase().replace(/\.+$/,'');
    if(!host||host==='localhost'||host.endsWith('.localhost')||host==='0.0.0.0'||/^127(?:\.\d{1,3}){3}$/.test(host)||host==='[::1]'||host==='[::]')return false;
    const mapped=/^\[::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})\]$/.exec(host);
    if(mapped){const high=parseInt(mapped[1],16),low=parseInt(mapped[2],16);if(high>>>8===127||high===0&&low===0)return false;}
    if(/\/@fs$/i.test(decodeURIComponent(url.pathname)))return false;
    return true;
  }catch{return false;}
}

/** Machine paths anywhere in tracked text, with explicit file-scoped synthetic fixtures. */
export function localPathProblems(file: string, text: string, byteDigest?: string): string[] {
  if (archived(file)) return [];
  const pinned = VENDORED_SYNTHETIC_PATHS[file];
  const upstreamPaths = pinned && byteDigest === pinned.sha256 && createHash('sha256').update(text).digest('hex') === pinned.sha256 ? pinned.paths : [];
  const problems: string[] = [];
  text.split('\n').forEach((line, index) => {
    for (const m of line.matchAll(LOCAL_PATH)) {
      // A path segment inside a network URL is not a machine path; file URLs still are.
      const before = line.slice(0, m.index);
      const token=/(?<![A-Za-z0-9+.-])(?:https?|ftps?):\/\/[^\s"'`<>()|*,?#=\u0080-\uffff]*$/i.exec(before)?.[0];
      if(token&&networkPathURL(token))continue;
      // ~/Library is an OS layout template, not a personal absolute path.
      if (m[0] === '~/' && /^~\/Library(?:[\/\s`"',;)]|$)/.test(line.slice(m.index))) continue;
      if ((SYNTHETIC_PATHS[file] ?? []).includes(m[0]) || upstreamPaths.includes(m[0])) continue;
      problems.push(`${file}:${index + 1}: local path ${JSON.stringify(m[0])}`);
    }
  });
  return problems;
}

const BUILD_NAME = new RegExp('(?:Rel' + '|Beta)_[A-Za-z][A-Za-z0-9_-]*_10_[0-5](?:_|\\b)[A-Za-z0-9_.-]*', 'gi');

/** Build names from protected version lines belong in deployment data, not repository content. */
export function buildNameProblems(file: string, text: string): string[] {
  if (archived(file)) return [];
  const problems: string[] = [];
  text.split('\n').forEach((line, index) => {
    for (const m of line.matchAll(BUILD_NAME)) problems.push(`${file}:${index + 1}: protected build name ${JSON.stringify(m[0])}`);
  });
  return problems;
}

/** Scan regular file contents and Git's symlink target text; never follow a symlink or discard a NUL-bearing blob. */
export function trackedFileText(path: string, onBytes?: (bytes: Uint8Array) => void): string | null {
  const info = lstatSync(path);
  const bytes = info.isSymbolicLink() ? readlinkSync(path, { encoding: 'buffer' }) : info.isFile() ? readFileSync(path) : null;
  if (bytes === null) return null;
  onBytes?.(bytes);
  return bytes.toString('utf8').replaceAll('\0', '');
}

const RELEASE_LINE_NUMBER = '10[._][0-5](?![0-9])(?:[._][0-9]+)*';
const RELEASE_CONTEXT = new RegExp([
  '(?:版本线|版本分支|(?:version|release)\\s+line)\\s*[:：=]?\\s*[`\'"（(]?',
  '\\b(?:min_?line|version_?line|release_?line|build_?line|line)[`\'"]?\\s*(?::|=|===|==)\\s*[`\'"]?',
  '\\b(?:min_?line|version_?line|release_?line|build_?line|line)\\s*:\\s*[A-Za-z_$][A-Za-z0-9_$ |\\[\\]]{0,100}=\\s*[`\'"]?',
  '[`\'"][0-9]{3}[:：]',
  '--(?:min-line|line)\\s+[`\'"]?',
  '\\b(?:lineKey|sameLine|compareLines|caseDocumentsFor|listedFor)\\s*\\(\\s*[`\'"]',
].map(context=>'(?:'+context+')'+RELEASE_LINE_NUMBER).join('|'),'i');
const RELEASE_BUILD = new RegExp('(?:Rel|Beta)[_.][A-Za-z][A-Za-z0-9_-]*[_.]'+RELEASE_LINE_NUMBER,'i');
const lockFile=(file:string):boolean=>/(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|[^/]+\.lock|bun\.lockb)$/.test(file);

/** Release-line syntax in a release context, never an arbitrary dotted number; diagnostics disclose locations only. */
export function versionLineProblems(file:string,text:string,byteDigest?:string):string[]{
  if(archived(file)||lockFile(file))return [];
  const pinned=VENDORED_SYNTHETIC_PATHS[file];
  if(pinned&&byteDigest===pinned.sha256&&createHash('sha256').update(text).digest('hex')===pinned.sha256)return [];
  return text.split('\n').flatMap((line,index)=>RELEASE_CONTEXT.test(line)||RELEASE_BUILD.test(line)?[`${file}:${index+1}: protected release line`]:[]);
}
