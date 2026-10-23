// Pure SVN HTTP v2 planners and projections; all network and XML parsing belong to the Hub.
type Element = { name: string; children: (Element | string)[] };
type Response = { ok?: boolean; model?: { root?: Element } };
type Input = { round?: number; external: { key: string }; responses?: Record<string, Response> };
const REVISION = /^[0-9]{1,200}$/;
const BAD_SEGMENT = /[;\\\u0000-\u001f\u007f]/;
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
const local = (e: Element) => e.name.slice(e.name.indexOf(':') + 1);
const children = (e: Element, name: string): Element[] => e.children.filter((c): c is Element => typeof c !== 'string' && local(c) === name);
function text(e: Element): string { return e.children.map((c) => typeof c === 'string' ? c : text(c)).join('').trim(); }
function value(e: Element, name: string): string | null { const found = children(e, name); return found.length === 1 ? text(found[0]) : null; }
function rows(response: Response | undefined): Element[] {
  const root = response?.ok === true ? response.model?.root : undefined;
  return root && local(root) === 'multistatus' ? children(root, 'response') : [];
}
function properties(row: Element): Element | null {
  const props = children(row, 'propstat').filter((p) => /^HTTP\/\S+ 200(?: |$)/.test(value(p, 'status') ?? '')).flatMap((p) => children(p, 'prop'));
  return props.length === 1 ? props[0] : null;
}
// Compare decoded paths, reject absolute links, query strings and encoded separators. Never use href as a request.
function hrefPath(row: Element): string | null {
  const href = value(row, 'href');
  if (!href || !href.startsWith('/') || href.startsWith('//') || /[?#]|%(?:2f|5c)/i.test(href)) return null;
  try { return decodeURIComponent(href); } catch { return null; }
}
function revision(response: Response | undefined, dir: string): string | null {
  const all = rows(response);
  if (all.length !== 1) return null;
  const path = hrefPath(all[0]);
  const prop = properties(all[0]);
  const rev = prop && value(prop, 'version-name');
  return path?.endsWith(`/${dir}/`) && prop && children(prop, 'resourcetype').some((p) => children(p, 'collection').length === 1) && rev && REVISION.test(rev) ? rev : null;
}
export function directoryPlan(input: unknown): unknown {
  const { round = 1, external, responses = {} } = input as Input;
  const dir = pathKey(external.key);
  if (!dir) return { requests: [], done: true };
  if (round === 1) return { requests: [{ key: 'revision', route: 'revision', params: { dir } }], done: false };
  const rev = revision(responses.revision, dir);
  if (!rev) return { requests: [], done: true };
  return { requests: [{ key: 'list', route: 'list', params: { rev, dir } }], original: 'list', done: true };
}
export function filePlan(input: unknown): unknown {
  const key = fileKey((input as Input).external.key);
  return { requests: key ? [{ key: 'file', route: 'file', params: key }] : [], done: true };
}
export function fileProject(input: unknown): unknown {
  const key = fileKey((input as Input).external.key);
  return key ? { revision: key.rev, artifacts: [{ name: 'meta', media_type: 'application/json', json: { revision: key.rev, path: key.path } }] } : failure();
}
export function directoryProject(input: unknown): unknown {
  const { external, responses = {} } = input as Input;
  const dir = pathKey(external.key);
  const rev = dir && revision(responses.revision, dir);
  if (!dir || !rev) return failure();
  const all = rows(responses.list);
  const suffix = `/!svn/rvr/${rev}/${dir}/`;
  const self = all.filter((row) => hrefPath(row)?.endsWith(suffix));
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
