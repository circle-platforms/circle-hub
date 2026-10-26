// Read functions of a WebDAV document store (pure, run in the Hub sandbox): the manual store and the document library share
// this module (each pack carries an identical copy; a test keeps them equal). Collections are listed with PROPFIND Depth 1
// (route `list`, parsed with xml@1 by the Hub); files are read with GET (route `file`) by their path below the listed folder:
// the member's name from the listing, never the listing's link, so a link to another host or outside the folder is never
// followed (it is skipped and named in a warning). Reads, with <type> the pack's own prefix:
// - <type>:file:<path>          one file by its path below the base (percent-encoded where needed)
// - <type>:cli:<line>           the CLI manual of a version line: the subfolder of settings.cli_folder (default cli) whose
//                               name ends in the line's numbers (rel_x_10_7_1 is line 10.7.1), file settings.cli_file
// - <type>:app:<line>           the same for the application manual (settings.app_folder, settings.app_file)
// - <type>:spec-search:<terms>  terms joined by +: settings.spec_folders (default [spec]) listed once each. Keyword
//                               retrieval is retired (owner ruling U19/U20, 2026-10-24): the terms are disclosed and not
//                               used, no file is scored, chosen or read. The derived content (Markdown) lists the folder
//                               members and names the missing fact and its next step (an explicit <type>:file:<path>, or
//                               a candidate a model proposes with a verbatim quote the Hub verifies)
// - <type>:qa-search:<terms>    the same over the test strategy documents (settings.qa_folder, default qa)
// No product name is written here: folder and file names come from the resource settings.

type Planned = { key: string; route: string; params?: Record<string, string> };
type PlanOutput = { requests: Planned[]; done: boolean; original?: string };
type XmlElement = { name: string; children: Array<XmlElement | string> };
type Response = { ok?: boolean; status?: number | null; text?: unknown; model?: unknown; media_type?: string | null; sha256?: string | null; error?: { code?: string } };
type Input = { round?: unknown; external?: { type?: unknown; key?: unknown }; settings?: unknown; responses?: unknown; original?: unknown };

const DEFAULTS = { cli_folder: 'cli', cli_file: 'cli_cn/cli_cn.md', app_folder: 'app', app_file: 'app_cn/app_cn.md', spec_folder: 'spec', qa_folder: 'qa' } as const;
type Setting = keyof typeof DEFAULTS;

const MAX_TERMS = 16;
const MAX_TERM = 64;
const MAX_CANDIDATES = 4;
/** Longest member name the file route takes as one path segment (its parameter shape). */
const MAX_NAME = 255;
/** Skipped members named in one warning. */
const MAX_NAMED = 10;
/** A folder or file setting: relative path segments of letters, digits, _ . - and CJK, no dot segments. */
const SEGMENT = /^(?!\.\.?$)[\p{L}\p{N}_.-]{1,120}$/u;
/** A name that cannot be one segment of a route path: separators, the path parameter mark, controls. */
const UNUSABLE_NAME = /[/\\;\u0000-\u001f\u007f]/;
const ABSOLUTE = /^([A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]*)/;

/** The searches of this module by external type: the folder setting each one lists and how its content is titled. */
const SEARCHES: Record<string, { folder: Setting; title: string }> = {
  'spec-search': { folder: 'spec_folder', title: '规格书检索' },
  'qa-search': { folder: 'qa_folder', title: '测试策略检索' },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function partsOf(input: unknown): { round: number; type: string; key: string; settings: Record<string, unknown>; responses: Record<string, Response> } {
  const record = isRecord(input) ? (input as Input) : {};
  const external = isRecord(record.external) ? record.external : {};
  return {
    round: typeof record.round === 'number' ? record.round : 1,
    type: typeof external.type === 'string' ? external.type : '',
    key: typeof external.key === 'string' ? external.key : '',
    settings: isRecord(record.settings) ? record.settings : {},
    responses: isRecord(record.responses) ? (record.responses as Record<string, Response>) : {},
  };
}

/** A relative path setting (segments joined by /), or its default. */
export function setting(settings: Record<string, unknown>, name: Setting): string {
  const value = settings[name];
  if (typeof value === 'string') {
    const segments = value.replace(/^\/+|\/+$/g, '').split('/');
    if (segments.length > 0 && segments.length <= 8 && segments.every((s) => SEGMENT.test(s))) return segments.join('/');
  }
  return DEFAULTS[name];
}

function decoded(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** The local name of an element (WebDAV answers use any namespace prefix: D:href, d:href, lp1:href). */
function localName(name: string): string {
  return name.slice(name.indexOf(':') + 1).toLowerCase();
}

function textOf(element: XmlElement, depth = 0): string {
  if (depth > 32) return '';
  return element.children.map((child) => (typeof child === 'string' ? child : textOf(child, depth + 1))).join('');
}

/** Every href of a multistatus answer, as written, in document order (at most 20,000). */
export function hrefsOf(model: unknown): string[] {
  const root = isRecord(model) && isRecord(model.root) ? (model.root as XmlElement) : null;
  const out: string[] = [];
  const stack: Array<{ element: XmlElement; depth: number }> = root === null ? [] : [{ element: root, depth: 0 }];
  while (stack.length > 0 && out.length < 20_000) {
    const { element, depth } = stack.pop() as { element: XmlElement; depth: number };
    if (!Array.isArray(element.children) || typeof element.name !== 'string') continue;
    if (localName(element.name) === 'href') {
      out.push(textOf(element).trim());
      continue;
    }
    if (depth > 32) continue;
    for (let k = element.children.length - 1; k >= 0; k--) {
      const child = element.children[k];
      if (typeof child !== 'string' && isRecord(child)) stack.push({ element: child as XmlElement, depth: depth + 1 });
    }
  }
  return out;
}

/** A member of a listing: its link as written, its name (decoded), whether it is a collection, its path and origin. */
export type Entry = { href: string; name: string; collection: boolean; path: string; origin: string | null };
/** A listed member the plans do not read, and why: another origin, not directly below the collection, or a name no path segment can hold. */
export type Skipped = { href: string; name: string; why: 'origin' | 'outside' | 'name' };

type Listing = { self: { path: string; origin: string | null } | null; entries: Entry[] };

const originOf = (href: string): string | null => ABSOLUTE.exec(href)?.[1].toLowerCase() ?? null;
/** The decoded path of a link: the origin and any query or fragment left out. */
const pathOf = (href: string): string => decoded(href.replace(ABSOLUTE, '').split(/[?#]/)[0]);
const trimmed = (path: string): string => path.replace(/\/+$/, '');

/**
 * The listing of a collection: the collection itself and its members. The collection is the collection link most other links
 * lie below (RFC 4918 lists it, usually first), or the only link when the listing holds nothing else; a listing of members
 * alone has none.
 */
function listingOf(model: unknown): Listing {
  const hrefs = hrefsOf(model).filter((href) => href !== '');
  const all = hrefs.map((href) => trimmed(pathOf(href)));
  let at = -1;
  let most = 0;
  all.forEach((candidate, k) => {
    if (!pathOf(hrefs[k]).endsWith('/')) return;
    const below = all.filter((other) => other !== candidate && other.startsWith(`${candidate}/`)).length;
    if (below > most) {
      most = below;
      at = k;
    }
  });
  if (at < 0 && hrefs.length === 1 && pathOf(hrefs[0]).endsWith('/')) at = 0;
  const self = at < 0 ? null : { path: all[at], origin: originOf(hrefs[at]) };
  const entries: Entry[] = [];
  const seen = new Set<string>();
  for (const href of hrefs) {
    const path = pathOf(href);
    const bare = trimmed(path);
    if ((self !== null && bare === self.path) || seen.has(bare)) continue;
    seen.add(bare);
    const name = bare.slice(bare.lastIndexOf('/') + 1);
    if (name !== '') entries.push({ href, name, collection: path.endsWith('/'), path: bare, origin: originOf(href) });
  }
  return { self, entries };
}

/** The members of a listed collection (the collection itself left out): name decoded, collection when the link ends with /. */
export function entriesOf(model: unknown): Entry[] {
  return listingOf(model).entries;
}

/**
 * The members the plans may read, by name below the listed folder: on the collection's own origin (a link to another host is
 * never followed), directly below the collection, with a name that one path segment can hold. The others are skipped.
 */
export function membersOf(model: unknown): { members: Entry[]; skipped: Skipped[] } {
  const { self, entries } = listingOf(model);
  const members: Entry[] = [];
  const skipped: Skipped[] = [];
  for (const entry of entries) {
    const skip = (why: Skipped['why']): void => void skipped.push({ href: entry.href, name: entry.name, why });
    // A link on another origin than the collection's own; with a collection given as a path, any absolute link.
    if (entry.origin !== null && (self === null || self.origin !== entry.origin)) {
      if (self !== null || entries.some((other) => other.origin !== entry.origin)) {
        skip('origin');
        continue;
      }
    }
    const relative = !entry.href.replace(ABSOLUTE, '').startsWith('/');
    const parent = entry.path.slice(0, entry.path.lastIndexOf('/'));
    if (relative ? entry.path.includes('/') : self !== null && parent !== self.path) {
      skip('outside');
      continue;
    }
    if (entry.name === '.' || entry.name === '..' || entry.name.length > MAX_NAME || UNUSABLE_NAME.test(entry.name)) {
      skip('name');
      continue;
    }
    members.push(entry);
  }
  return { members, skipped };
}

const WHY = { origin: '链接指向另一个来源', outside: '不在所列目录的正下方', name: '名称不能写成一段路径' } as const;

/** A warning naming the skipped members of a listing (at most ten by name). */
function skippedWarning(folder: string, skipped: readonly Skipped[]): string | null {
  if (skipped.length === 0) return null;
  const named = skipped.slice(0, MAX_NAMED).map((s) => `${s.name}（${WHY[s.why]}）`);
  return `${folder}/ 的列表里有 ${skipped.length} 项没有读：${named.join('、')}${skipped.length > MAX_NAMED ? ' 等' : ''}`.slice(0, 500);
}

/** Version numbers as a line compares them: parts without leading zeros, trailing .0 parts beyond the second dropped. */
export function lineKey(text: string): string | null {
  const match = /^v?([0-9]{1,4}(?:[._][0-9]{1,4}){1,5})$/i.exec(text.trim());
  if (match === null) return null;
  const parts = match[1].split(/[._]/).map((part) => part.replace(/^0+(?=\d)/, ''));
  while (parts.length > 2 && parts[parts.length - 1] === '0') parts.pop();
  return parts.join('.');
}

/** The version a folder name ends in: rel_x_10_7_1 and x-10.7.1 are 10.7.1; null when it ends in no version. */
export function folderLine(name: string): string | null {
  const match = /(?:^|[^0-9A-Za-z])v?([0-9]{1,4}(?:[._][0-9]{1,4}){1,5})$/i.exec(name);
  return match === null ? null : lineKey(match[1]);
}

const KINDS: Record<string, { folder: Setting; file: Setting }> = { cli: { folder: 'cli_folder', file: 'cli_file' }, app: { folder: 'app_folder', file: 'app_file' } };

function kindOf(type: string): 'cli' | 'app' | null {
  return type === 'cli' || type === 'app' ? type : null;
}

/** Plan of <type>:file:<path>: one GET of the decoded path. */
export function filePlan(input: unknown): PlanOutput {
  const { key } = partsOf(input);
  const path = decoded(key).replace(/^\/+/, '');
  if (path === '' || path.length > 2000 || path.split('/').some((s) => s === '' || s === '.' || s === '..')) return { requests: [], done: true };
  return { requests: [{ key: 'file', route: 'file', params: { path } }], done: true };
}

const byName = (a: Entry, b: Entry): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/** The readable subfolders of a manual folder listing whose names end in the line, in name order (at most four). */
export function manualCandidates(model: unknown, line: string): Entry[] {
  const wanted = lineKey(line);
  if (wanted === null) return [];
  return membersOf(model)
    .members.filter((entry) => entry.collection && folderLine(entry.name) === wanted)
    .sort(byName)
    .slice(0, MAX_CANDIDATES);
}

/** Plan of <type>:cli:<line> and <type>:app:<line>: list the manual folder, read the file of each matching subfolder, keep the first that answers. */
export function manualPlan(input: unknown): PlanOutput {
  const { round, type, key, settings, responses } = partsOf(input);
  const kind = kindOf(type);
  if (kind === null || lineKey(key) === null) return { requests: [], done: true };
  const folder = setting(settings, KINDS[kind].folder);
  if (round === 1) return { requests: [{ key: 'list', route: 'list', params: { dir: folder } }], done: false };
  const file = setting(settings, KINDS[kind].file);
  const candidates = manualCandidates(responses.list?.model, key);
  if (round === 2) {
    if (candidates.length === 0) return { requests: [], done: true };
    return { requests: candidates.map((entry, k) => ({ key: `file-${k + 1}`, route: 'file', params: { path: `${folder}/${entry.name}/${file}` } })), done: false };
  }
  const first = candidates.findIndex((_, k) => responses[`file-${k + 1}`]?.ok === true);
  if (first >= 0) return { requests: [], done: true, original: `file-${first + 1}` };
  // A manual the Hub holds back (a credential scan hit no administrator accepted) is still the answer: naming it as the
  // original makes the read fail with its digest, so the administrator can review it, instead of "no such manual".
  const held = candidates.findIndex((_, k) => responses[`file-${k + 1}`]?.error?.code === 'SOURCE_CREDENTIAL');
  return held < 0 ? { requests: [], done: true } : { requests: [], done: true, original: `file-${held + 1}` };
}

function stripNul(text: string): { text: string; removed: number } {
  let removed = 0;
  const out = text.replace(/\u0000/g, () => {
    removed += 1;
    return '';
  });
  return { text: out, removed };
}

/** Projection of a manual read: content is the manual text without NUL (stored text cannot hold it; the original keeps every byte). */
export function manualProject(input: unknown): unknown {
  const { type, key, settings, responses } = partsOf(input);
  const kind = kindOf(type);
  const original = isRecord(input) && typeof input.original === 'string' ? input.original : '';
  if (kind === null || !original.startsWith('file-')) {
    return { error: { code: 'manual.not_found', message: `${kind === null ? '' : setting(settings, KINDS[kind].folder)} 下没有名称以版本线 ${key} 结尾的目录，或其中没有手册文件` } };
  }
  const response = responses[original];
  if (typeof response?.text !== 'string') return { error: { code: 'manual.unreadable', message: '手册文件没有文本' } };
  const { text, removed } = stripNul(response.text);
  const candidates = manualCandidates(responses.list?.model, key);
  const folder = candidates[Number(original.slice('file-'.length)) - 1];
  // Folders of the line the listing names but the plan did not read (another origin, outside the folder, an unusable name).
  const wanted = lineKey(key);
  const skipped = membersOf(responses.list?.model).skipped.filter((s) => folderLine(s.name) === wanted);
  const warning = skippedWarning(setting(settings, KINDS[kind].folder), skipped);
  return {
    artifacts: [
      { name: 'content', media_type: 'text/markdown; charset=utf-8', text },
      { name: 'meta', media_type: 'application/json', json: { title: `${kind === 'cli' ? 'CLI 手册' : '应用手册'} ${key}`, line: lineKey(key), folder: folder?.name ?? null, nul_removed: removed } },
    ],
    ...(removed > 0 ? { note: `去掉了 ${removed} 个 NUL 字符（原件保留全部字节）` } : {}),
    ...(warning !== null ? { warnings: [warning] } : {}),
  };
}

/** Search terms of a key: split at +, percent escapes decoded, blank and repeated terms dropped (case-insensitive). */
export function termsOf(key: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of key.split('+')) {
    const term = decoded(raw).trim().slice(0, MAX_TERM);
    const folded = term.toLowerCase();
    if (term === '' || seen.has(folded)) continue;
    seen.add(folded);
    out.push(term);
    if (out.length >= MAX_TERMS) break;
  }
  return out;
}

const searchOf = (type: string): { folder: Setting; title: string } => SEARCHES[type] ?? SEARCHES['spec-search'];

const LEGACY_SPEC = '旧设置 spec_folder 已并入 spec_folders，下一步资源管理员改用 spec_folders';
/** One normalized list for both listing and search; legacy settings add one member, never a second read path. */
export function specFolders(settings: Record<string, unknown>,searchDefault=false): { folders: string[]; warnings: string[] } {
  const given = settings.spec_folders;
  if (given !== undefined && (!Array.isArray(given) || given.some(v => typeof v !== 'string'))) throw new TypeError('spec_folders 需要目录列表；下一步资源管理员修正设置后重读');
  const values: unknown[] = given === undefined ? [] : [...given as string[]];
  const warnings: string[] = [];
  if (settings.spec_folder !== undefined) { values.push(settings.spec_folder); warnings.push(LEGACY_SPEC); }
  if (given === undefined && settings.spec_folder === undefined) {
    if(!searchDefault)throw new TypeError('规格目录设置 spec_folders 未声明；下一步资源管理员配置目录列表后重读');
    values.push(DEFAULTS.spec_folder);
  }
  const folders = values.map(value => {
    if (typeof value !== 'string') throw new TypeError('spec_folders 含无效目录；下一步资源管理员修正设置后重读');
    const path = value.replace(/^\/+|\/+$/g, '');
    if (path.length > 255 || !path.split('/').every(s => SEGMENT.test(s))) throw new TypeError('spec_folders 含无效目录；下一步资源管理员修正设置后重读');
    return path;
  });
  const unique=[...new Set(folders)];
  if(unique.length===0)throw new TypeError('spec_folders 没有可读取的目录清单原件；下一步资源管理员至少配置一个目录（可以是空目录）后重读');
  if (unique.length > 32) throw new TypeError('spec_folders 超过 32 个目录；下一步包作者提高读请求上限并发布后重读');
  return { folders: unique, warnings };
}
const listKey = (folders: readonly string[], at: number): string => folders.length === 1 ? 'list' : `list-${at}`;
export function specListPlan(input: unknown): PlanOutput {
  const {settings} = partsOf(input); const {folders} = specFolders(settings);
  return {requests: folders.map((dir, at) => ({key: listKey(folders, at), route: 'list', params: {dir}})), done: true};
}
export function specListProject(input: unknown): unknown {
  const {settings,responses} = partsOf(input); const {folders,warnings} = specFolders(settings);
  const files: Array<{name:string;path:string;title?:string}> = []; const unread: string[] = [];
  const directories:Array<{name:string;path:string}>=[];
  folders.forEach((folder, at) => {
    const response = responses[listKey(folders, at)];
    if (!response?.ok || !isRecord(response.model) || !isRecord(response.model.root)) { unread.push(folder); warnings.push(`${folder}/ 目录读不到；下一步资源管理员核对读权限和目录后重读`); return; }
    const listing = membersOf(response.model); const warning = skippedWarning(folder,listing.skipped);
    directories.push(...listing.members.filter(entry=>entry.collection).sort(byName).map(entry=>({name:entry.name,path:`${folder}/${entry.name}`})));
    if (warning) warnings.push(warning);
    const titles=new Map<string,string>();
    const walk=(element:XmlElement,depth=0):void=>{
      if(depth>32)return;
      if(localName(element.name)==='response'){
        let href:string|undefined,title:string|undefined;
        const fields=(node:XmlElement,level=0):void=>{if(level>32)return;const name=localName(node.name);if(name==='href')href=textOf(node).trim();if(name==='displayname')title=textOf(node).trim();for(const child of node.children)if(typeof child!=='string')fields(child,level+1);};
        fields(element);if(href&&title)titles.set(trimmed(pathOf(href)),title);
      }else for(const child of element.children)if(typeof child!=='string')walk(child,depth+1);
    };
    walk(response.model.root as XmlElement);
    files.push(...listing.members.filter(e=>!e.collection).sort(byName).map(e=>({name:e.name,path:`${folder}/${e.name}`,...(titles.has(e.path)?{title:titles.get(e.path)}:{})})));
  });
  return {artifacts:[{name:'content',media_type:'application/json',json:{folders,files,directories,unread,complete:unread.length===0}}],warnings,...(unread.length?{complete:false}:{})};
}

function searchFolders(type: string, settings: Record<string,unknown>): {folders:string[];warnings:string[]} {
  return type === 'spec-search' || !SEARCHES[type] ? specFolders(settings,true) : {folders:[setting(settings,searchOf(type).folder)],warnings:[]};
}
/**
 * The listings of the configured folders of a search key, one per folder in the order the settings give. Nothing here
 * scores a name, chooses a file or reads one (owner ruling U19/U20, 2026-10-24).
 */
function searchListings(type: string, settings: Record<string, unknown>, responses: Record<string, Response>) {
  const { folders, warnings } = searchFolders(type, settings);
  const listings = folders.map((folder, at) => {
    const response = responses[listKey(folders, at)];
    return { folder, listed: response?.ok === true, ...membersOf(response?.model) };
  });
  return { folders, warnings, listings };
}

/**
 * Plan of <type>:spec-search:<terms> and <type>:qa-search:<terms>: the configured folders listed once each, and nothing
 * else. Keyword retrieval selects no source, so no file is planned for reading: a file is read by its declared path
 * (<type>:file:<path>), or a model proposes one with a verbatim quote the Hub verifies.
 */
export function searchPlan(input: unknown): PlanOutput {
  const { round, type, settings } = partsOf(input);
  const { folders } = searchFolders(type, settings);
  if (round === 1) return { requests: folders.map((dir, at) => ({ key: listKey(folders, at), route: 'list', params: { dir } })), done: folders.length === 0 };
  return { requests: [], done: true, ...(folders.length ? { original: listKey(folders, 0) } : {}) };
}

/**
 * Projection of a search: the members of the configured folders as a listing in name order, the requested terms
 * disclosed as unused, and the missing fact with its next step. No file is scored, chosen or read, and the terms never
 * decide what is listed.
 */
export function searchProject(input: unknown): unknown {
  const { type, key, settings, responses } = partsOf(input);
  const search = searchOf(type);
  const terms = termsOf(key);
  const { folders, warnings, listings } = searchListings(type, settings, responses);
  const folder = folders.join('、');
  const skipped = listings.flatMap((list) => list.skipped);
  const unread = listings.filter((list) => !list.listed).map((list) => list.folder);
  const files = listings.flatMap((list) => list.members.filter((entry) => !entry.collection).sort(byName).map((entry) => ({ name: entry.name, path: `${list.folder}/${entry.name}` })));
  const lines = [
    `# ${search.title}`, '',
    `检索词：${terms.join('、') || '（无）'}（只作披露；关键词检索已退役，不用于选择来源）`, '',
    `目录：${folder}/`, '',
    `目录成员（${files.length} 个，按名称排序；没有打分、没有选择、没有读取）：`,
    ...files.map((file, k) => `${k + 1}. ${file.path}`),
    '',
    '本读法不按检索词给文件名打分，也不读任何文件（所有者裁定 U19/U20，2026-10-24：关键词检索连候选来源也禁止，检索结果不作任何输入或查全依据）。',
    '缺的事实：这次要判断的来源身份。下一步：作者用 file:<路径> 读法按上面列出的路径显式声明来源（目录清单也可用 spec-list:configured 读法取得），或由模型带逐字引文提出候选并经 Hub 核验。',
  ];
  if (skipped.length > 0) {
    const named = skipped.slice(0, MAX_NAMED).map((entry) => `${entry.name}（${WHY[entry.why]}）`);
    lines.push('', `列表里没有读的项（${skipped.length} 个）：${named.join('、')}${skipped.length > MAX_NAMED ? ' 等' : ''}`);
  }
  if (unread.length > 0) lines.push('', `没有读到的目录：${unread.join('、')}`);
  const warning = skippedWarning(folder, skipped);
  return {
    artifacts: [
      { name: 'content', media_type: 'text/markdown; charset=utf-8', text: `${lines.join('\n')}\n` },
      {
        name: 'meta',
        media_type: 'application/json',
        json: { title: `${search.title}：${terms.join('、')}`, terms, terms_used: false, folder, files, skipped: skipped.map((s) => ({ name: s.name, why: s.why })), selection: 'retired' },
      },
    ],
    ...(unread.length > 0 ? { complete: false } : {}),
    note: '关键词检索已退役：本读法只列出配置目录的成员，不选择也不读取来源；下一步按 file:<路径> 显式声明来源，或由模型带逐字引文提出候选并经 Hub 核验',
    ...((warnings.length || warning !== null) ? { warnings: [...warnings,...(warning?[warning]:[])] } : {}),
  };
}
