// Pure SVN HTTP v2 planners and projections; all network and XML parsing belong to the Hub.
type Element = { name: string; attributes?: Record<string, string>; children: (Element | string)[] };
type Response = { ok?: boolean; model?: { root?: Element } };
type Input = { round?: number; external: { key: string }; settings?: Record<string, unknown>; responses?: Record<string, Response> };
export const MAX_DIRECTORY_MEMBERS = 512;
export const MAX_DIRECTORY_PATH_DEPTH = 32;
const directoryBudget = () => ({error:{code:'svn.directory_budget',message:'SVN 目录深度或成员数量超过只读上限；请管理员缩小目录范围或复核预算后重跑，不截断目录清单'}});
const REVISION = /^[0-9]{1,200}$/;
const BAD_SEGMENT = /[;\\\u0000-\u001f\u007f]/;
const configurationFailure = () => ({ error: { code: 'svn.invalid_configuration', message: '缺少或无效的资源设置 settings.repository_path；必须配置服务器 href 中的仓库根绝对路径' } });
const failure = () => ({ error: { code: 'svn.invalid_response', message: 'SVN 应答缺少有效修订号、成员属性或目录身份，或成员修订号超过批次修订号' } });

function pathKey(key: string): string | null {
  try {
    const path = decodeURIComponent(key);
    return path.length > 0 && path.length <= 2000 && path.split('/').every((s) => s !== '' && s !== '.' && s !== '..' && s.length <= 255 && !BAD_SEGMENT.test(s)) ? path : null;
  } catch { return null; }
}
function fileKey(key: string): { rev: string; path: string } | null {
  const at = key.indexOf('/');
  const rev = key.slice(0, at);
  const path = pathKey(key.slice(at + 1));
  return at > 0 && REVISION.test(rev) && path !== null ? { rev, path } : null;
}
// Resolve bindings at each element; declarations apply to that element and its descendants only.
// Keep non-DAV elements unnamed so a familiar local name in another namespace is never a DAV property.
function davTree(element: Element, inherited: ReadonlyMap<string, string> = new Map()): Element {
  const bindings = new Map(inherited);
  for (const [name, uri] of Object.entries(element.attributes ?? {})) {
    if (name === 'xmlns') bindings.set('', uri);
    else if (name.startsWith('xmlns:')) bindings.set(name.slice(6), uri);
  }
  const parts = element.name.split(':');
  const prefix = parts.length === 1 ? '' : parts[0];
  const name = parts.length <= 2 && bindings.get(prefix) === 'DAV:' ? parts.at(-1)! : '';
  return { name, children: element.children.map((child) => typeof child === 'string' ? child : davTree(child, bindings)) };
}
const local = (e: Element) => e.name;
const children = (e: Element, name: string): Element[] => e.children.filter((c): c is Element => typeof c !== 'string' && local(c) === name);
function text(e: Element): string { return e.children.map((c) => typeof c === 'string' ? c : text(c)).join('').trim(); }
function value(e: Element, name: string): string | null { const found = children(e, name); return found.length === 1 ? text(found[0]) : null; }
function rows(response: Response | undefined): Element[] {
  const parsed = response?.ok === true ? response.model?.root : undefined;
  const root = parsed && davTree(parsed);
  return root && local(root) === 'multistatus' ? children(root, 'response') : [];
}
function properties(row: Element): Element | null {
  const props = children(row, 'propstat').filter((p) => /^HTTP\/\S+ 200(?: |$)/.test(value(p, 'status') ?? '')).flatMap((p) => children(p, 'prop'));
  return props.length === 1 ? props[0] : null;
}
// Decode one segment at a time. Reject traversal, empty segments and encoded separators without normalizing them away.
function absolutePath(raw: string): string | null {
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.length > 4096 || /[?#]/.test(raw)) return null;
  if (raw === '/') return '/';
  try {
    const trailing = raw.endsWith('/');
    const segments = raw.slice(1, trailing ? -1 : undefined).split('/').map((part) => decodeURIComponent(part));
    if (segments.some((part) => !part || part === '.' || part === '..' || part.length > 255 || part.includes('/') || BAD_SEGMENT.test(part))) return null;
    return `/${segments.join('/')}${trailing ? '/' : ''}`;
  } catch { return null; }
}
function repositoryPath(settings: Input['settings']): string[] | null {
  const raw = settings?.repository_path;
  if (typeof raw !== 'string') return null;
  const path = absolutePath(raw);
  return path === null ? null : path === '/' ? [] : path.replace(/\/$/, '').slice(1).split('/');
}
function directorySegments(repository: string[], dir: string, rev?: string): string[] {
  return [...repository, ...(rev === undefined ? [] : ['!svn', 'rvr', rev]), ...dir.split('/')];
}
function sameDirectory(path: string | null, expected: string[]): boolean {
  if (path === null || !path.endsWith('/')) return false;
  const actual = path.slice(1, -1).split('/');
  return actual.length === expected.length && actual.every((part, i) => part === expected[i]);
}
// Never use href as a request; its entire decoded path must match the configured identity.
function hrefPath(row: Element): string | null {
  const href = value(row, 'href');
  return href === null ? null : absolutePath(href);
}
function revision(response: Response | undefined, repository: string[], dir: string): string | null {
  const all = rows(response);
  if (all.length !== 1) return null;
  const path = hrefPath(all[0]);
  const prop = properties(all[0]);
  const rev = prop && value(prop, 'version-name');
  return sameDirectory(path, directorySegments(repository, dir)) && prop && children(prop, 'resourcetype').some((p) => children(p, 'collection').length === 1) && rev && REVISION.test(rev) ? rev : null;
}
export function directoryPlan(input: unknown): unknown {
  const { round = 1, external, settings, responses = {} } = input as Input;
  const repository = repositoryPath(settings);
  if (repository === null) return { requests: [], done: true };
  const dir = pathKey(external.key);
  if (!dir) return { requests: [], done: true };
  if (round === 1) return { requests: [{ key: 'revision', route: 'revision', params: { dir } }], done: false };
  const rev = revision(responses.revision, repository, dir);
  if (!rev) return { requests: [], done: true };
  return { requests: [{ key: 'list', route: 'list', params: { rev, dir } }], original: 'list', done: true };
}
export function filePlan(input: unknown): unknown {
  if (repositoryPath((input as Input).settings) === null) return { requests: [], done: true };
  const key = fileKey((input as Input).external.key);
  return { requests: key ? [{ key: 'file', route: 'file', params: key }] : [], done: true };
}
export function fileProject(input: unknown): unknown {
  if (repositoryPath((input as Input).settings) === null) return configurationFailure();
  const key = fileKey((input as Input).external.key);
  return key ? { revision: key.rev, artifacts: [{ name: 'meta', media_type: 'application/json', json: { revision: key.rev, path: key.path } }] } : failure();
}
export function directoryProject(input: unknown): unknown {
  const { external, settings, responses = {} } = input as Input;
  const repository = repositoryPath(settings);
  if (repository === null) return configurationFailure();
  const dir = pathKey(external.key);
  const rev = dir && revision(responses.revision, repository, dir);
  if (!dir || !rev) return failure();
  return projectDirectory(repository,dir,rev,responses.list);
}
function projectDirectory(repository:string[],dir:string,rev:string,response:Response|undefined):unknown{
  const all = rows(response);
  if(all.length>MAX_DIRECTORY_MEMBERS+1)return directoryBudget();
  const expected = directorySegments(repository, dir, rev);
  const self = all.filter((row) => sameDirectory(hrefPath(row), expected));
  if (self.length !== 1) return failure();
  const base = hrefPath(self[0])!;
  const members = [];
  const seen = new Set<string>();
  for (const row of all) {
    const href = hrefPath(row);
    const prop = properties(row);
    if (!href || !prop) return failure();
    const memberRev = value(prop, 'version-name');
    if (!memberRev || !REVISION.test(memberRev) || BigInt(memberRev) > BigInt(rev)) return failure();
    const types = children(prop, 'resourcetype');
    if (types.length !== 1) return failure();
    const directory = children(types[0], 'collection').length === 1;
    if (href === base) { if (!directory) return failure(); continue; }
    if (!href.startsWith(base) || directory !== href.endsWith('/')) return failure();
    const name = href.slice(base.length).replace(/\/$/, '');
    if (!name || name.includes('/') || pathKey(encodeURIComponent(name)) !== name || seen.has(name)) return failure();
    seen.add(name);
    const size = value(prop, 'getcontentlength');
    if (!directory && (size === null || !/^[0-9]+$/.test(size) || !Number.isSafeInteger(Number(size)))) return failure();
    members.push({ name, directory, size: directory ? null : Number(size), revision: memberRev, external: directory ? null : `svn:file:${rev}/${encodeURIComponent(`${dir}/${name}`)}` });
  }
  members.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  return { revision: rev, artifacts: [{ name: 'content', media_type: 'application/json', json: { directory: dir, revision: rev, members } }] };
}


/** A fixed version-root listing for descendants of a directory already pinned by the caller. */
export function directoryAtPlan(input:unknown):unknown{
 const {external,settings}=input as Input;
 if(repositoryPath(settings)===null)return {requests:[],done:true};
 const key=fileKey(external.key);
 if(!key || key.path.split('/').length>MAX_DIRECTORY_PATH_DEPTH)return {requests:[],done:true};
 return {requests:[{key:'list',route:'list',params:{rev:key.rev,dir:key.path}}],original:'list',done:true};
}
export function directoryAtProject(input:unknown):unknown{
 const {external,settings,responses={}}=input as Input;
 const repository=repositoryPath(settings);
 if(repository===null)return configurationFailure();
 const key=fileKey(external.key);
 if(!key)return failure();
 if(key.path.split('/').length>MAX_DIRECTORY_PATH_DEPTH)return directoryBudget();
 return projectDirectory(repository,key.path,key.rev,responses.list);
}
