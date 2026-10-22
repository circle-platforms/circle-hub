// Read functions of the agile test platform system pack (pure, run in the Hub sandbox). The platform answers every request
// with HTTP 200 and an envelope {code, msg, data}; the Hub logs in (the profile's login rule) and checks the envelope. Reads:
// - agile:tree:<root id>: the whole subtree of a root ({label, id, cases, children} nodes) and the root's title, found in the
//   paged root listing (10 per page with a total; pages past the end repeat page 1, so only the announced pages are read).
// - agile:mindmap:<document id>: the document (data is the KityMinder JSON encoded once more as a string). Artifacts: the
//   original answer, content (the inner KityMinder JSON, application/json) and meta {id, title, ancestors, root}: the title
//   and the labels of the folders above the document from the root down, found in the trees of the configured roots
//   (settings.roots, the first MAX_ROOTS of them), read as nested reads, which the Hub caches; a document in none of them
//   refreshes the cached trees once. A document no tree places while a root was not read is incomplete (meta unknown).
// - agile:search:<terms joined by +>[+!<document id>...]: the documents of the configured roots whose titles contain the most
//   terms (the best five), with an outline of the best three, leaving out the documents a `!` part names (the reviewed
//   document itself); a hint for similar test lists, never a ground for product behaviour. Incomplete when a root was not read.
// The connectors allow MAX_NESTED_READS (20) nested reads over all rounds of a read: round 1 reads at most MAX_ROOTS (10)
// trees and the refresh at most those again.

type Planned = { key: string; route: string; body?: unknown };
type NestedAsk = { external: string; refresh?: boolean };
type PlanOutput = { requests: Planned[]; reads?: NestedAsk[]; done: boolean; original?: string };
type Response = { ok?: boolean; json?: unknown; sha256?: string | null };
type Nested = { ok?: boolean; cached?: boolean; content?: unknown; meta?: unknown };
type TreeNode = { label?: unknown; title?: unknown; name?: unknown; id?: unknown; cases?: unknown; children?: unknown };

const PAGE_SIZE = 10;
const MAX_PAGES = 50;
/** Roots read by one read: half the connectors' nested reads (20 over all rounds), so a refresh of every one still fits. */
export const MAX_ROOTS = 10;
/** Documents one search key may leave out. */
const MAX_EXCLUDED = 8;
const MAX_DEPTH = 64;
const SEARCH_LIMIT = 5;
const OUTLINE_LIMIT = 3;
const OUTLINE_LINES = 150;
const OUTLINE_DEPTH = 5;
const MAX_TERMS = 16;
const ID = /^[0-9A-Za-z_-]{1,64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function partsOf(input: unknown) {
  const record = isRecord(input) ? input : {};
  const external = isRecord(record.external) ? record.external : {};
  return {
    round: typeof record.round === 'number' ? record.round : 1,
    key: typeof external.key === 'string' ? external.key : '',
    settings: isRecord(record.settings) ? record.settings : {},
    responses: (isRecord(record.responses) ? record.responses : {}) as Record<string, Response>,
    reads: (isRecord(record.reads) ? record.reads : {}) as Record<string, Nested>,
    original: typeof record.original === 'string' ? record.original : '',
  };
}

/** An id as the platform's JSON bodies carry it: a number when it is one, else the text. */
export function bodyId(key: string): number | string {
  return /^[0-9]{1,15}$/.test(key) ? Number(key) : key;
}

/** The root ids the resource names (settings.roots: ids as text or numbers), in order, without repeats. */
export function rootsOf(settings: Record<string, unknown>): string[] {
  const list = Array.isArray(settings.roots) ? settings.roots : [];
  const out: string[] = [];
  for (const value of list) {
    const id = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : typeof value === 'string' ? value.trim() : '';
    if (ID.test(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

/** The configured roots a read reads (the first MAX_ROOTS) and the ones beyond that limit. */
function readRootsOf(settings: Record<string, unknown>): { read: string[]; beyond: string[] } {
  const all = rootsOf(settings);
  return { read: all.slice(0, MAX_ROOTS), beyond: all.slice(MAX_ROOTS) };
}

const treeId = (root: string): string => `agile:tree:${root}`;

/** The roots whose trees are not at hand: read but not ok, and configured beyond the limit. */
function unreadRoots(reads: Record<string, Nested>, settings: Record<string, unknown>): string[] {
  const { read, beyond } = readRootsOf(settings);
  return [...read.filter((root) => reads[treeId(root)]?.ok !== true), ...beyond];
}

function unreadNote(unread: readonly string[], settings: Record<string, unknown>): string {
  const beyond = readRootsOf(settings).beyond.length;
  const named = unread.slice(0, 12).join('、');
  return `${unread.length} 个配置的根没有读到（${named}${unread.length > 12 ? ' 等' : ''}）${beyond > 0 ? `，其中 ${beyond} 个超出一次读取最多 ${MAX_ROOTS} 个根的上限` : ''}`;
}

function labelOf(node: TreeNode): string | null {
  for (const value of [node.label, node.title, node.name]) if (typeof value === 'string') return value;
  return null;
}

const idText = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : typeof value === 'number' && Number.isFinite(value) ? String(value) : null);

function dataOf(response: Response | undefined): unknown {
  return isRecord(response?.json) ? (response.json as Record<string, unknown>).data : undefined;
}

// ---------------------------------------------------------------- agile:tree:<root>

/** The roots of one listing page, from the forms the listing takes ({list}, {records} or a bare array). */
function listedRoots(response: Response | undefined): { total: number; roots: TreeNode[] } {
  const data = dataOf(response);
  const page = isRecord(data) ? data : {};
  const list = Array.isArray(data) ? data : Array.isArray(page.list) ? page.list : Array.isArray(page.records) ? page.records : [];
  const total = typeof page.total === 'number' && Number.isSafeInteger(page.total) ? page.total : list.length;
  return { total, roots: list.filter(isRecord) as TreeNode[] };
}

export function treePlan(input: unknown): PlanOutput {
  const { round, key, responses } = partsOf(input);
  if (!ID.test(key)) return { requests: [], done: true };
  if (round === 1) {
    return {
      requests: [
        { key: 'subtree', route: 'subtree', body: { id: bodyId(key) } },
        { key: 'page-1', route: 'roots', body: { page: 1 } },
      ],
      done: false,
      original: 'subtree',
    };
  }
  const first = listedRoots(responses['page-1']);
  if (first.roots.some((root) => idText(root.id) === key)) return { requests: [], done: true };
  const pages = Math.min(Math.ceil(first.total / PAGE_SIZE), MAX_PAGES);
  const requests: Planned[] = [];
  for (let page = 2; page <= pages; page++) requests.push({ key: `page-${page}`, route: 'roots', body: { page } });
  return { requests, done: true };
}

export function treeProject(input: unknown): unknown {
  const { key, responses, original } = partsOf(input);
  const subtree = dataOf(responses[original]);
  if (!Array.isArray(subtree)) return { error: { code: 'agile.no_subtree', message: '子树应答的 data 不是数组' } };
  let title: string | null = null;
  for (const [name, response] of Object.entries(responses)) {
    if (!name.startsWith('page-')) continue;
    for (const root of listedRoots(response).roots) if (idText(root.id) === key && labelOf(root) !== null) title = labelOf(root);
  }
  const revision = responses[original]?.sha256;
  return {
    ...(typeof revision === 'string' ? { revision } : {}),
    artifacts: [
      { name: 'content', media_type: 'application/json', json: { root: { id: key, title }, children: subtree } },
      { name: 'meta', media_type: 'application/json', json: { id: key, title } },
    ],
    ...(title === null ? { complete: false, note: '根列表里没有这个根，标题未知' } : {}),
  };
}

// ---------------------------------------------------------------- documents in the trees

export type Located = { id: string; title: string | null; ancestors: string[]; root: { id: string; title: string | null } };

type Tree = { root: { id: string; title: string | null }; children: unknown };

function treeOf(nested: Nested | undefined): Tree | null {
  const content = nested?.ok === true && isRecord(nested.content) ? nested.content : null;
  if (content === null || !isRecord(content.root) || typeof content.root.id !== 'string') return null;
  const title = typeof content.root.title === 'string' ? content.root.title : null;
  return { root: { id: content.root.id, title }, children: content.children };
}

/**
 * Every document of a tree, depth first in document order: the leaves (a leaf id is a document id) and the ids folders list
 * in `cases` that are not leaves of their own (title unknown). Ancestors are the folder labels from the root title down.
 */
export function documentsOf(tree: Tree, limit = 100_000): Located[] {
  const out: Located[] = [];
  const seen = new Set<string>();
  const top = tree.root.title === null ? [] : [tree.root.title];
  type Frame = { nodes: unknown; above: string[]; depth: number };
  const stack: Frame[] = [{ nodes: tree.children, above: top, depth: 0 }];
  while (stack.length > 0 && out.length < limit) {
    const { nodes, above, depth } = stack.pop() as Frame;
    if (!Array.isArray(nodes) || depth > MAX_DEPTH) continue;
    const frames: Frame[] = [];
    for (const raw of nodes) {
      if (!isRecord(raw)) continue;
      const node = raw as TreeNode;
      const id = idText(node.id);
      const label = labelOf(node) ?? '';
      const children = Array.isArray(node.children) ? node.children : [];
      if (children.length === 0) {
        if (id !== null && !seen.has(id)) {
          seen.add(id);
          out.push({ id, title: labelOf(node), ancestors: above, root: tree.root });
        }
        continue;
      }
      frames.push({ nodes: children, above: [...above, label], depth: depth + 1 });
      // Cases a folder lists without a node of their own.
      for (const listed of Array.isArray(node.cases) ? node.cases : []) {
        const caseId = idText(listed);
        if (caseId === null || seen.has(caseId) || children.some((c) => isRecord(c) && idText((c as TreeNode).id) === caseId)) continue;
        seen.add(caseId);
        out.push({ id: caseId, title: null, ancestors: [...above, label], root: tree.root });
      }
    }
    for (let k = frames.length - 1; k >= 0; k--) stack.push(frames[k]);
  }
  return out;
}

/** The document in the first configured tree that holds it, or null. */
export function locate(reads: Record<string, Nested>, roots: readonly string[], id: string): Located | null {
  for (const root of roots) {
    const tree = treeOf(reads[treeId(root)]);
    if (tree === null) continue;
    const found = documentsOf(tree).find((doc) => doc.id === id);
    if (found !== undefined) return found;
  }
  return null;
}

// ---------------------------------------------------------------- agile:mindmap:<document>

export function mindmapPlan(input: unknown): PlanOutput {
  const { round, key, settings, reads } = partsOf(input);
  if (!ID.test(key)) return { requests: [], done: true };
  const roots = readRootsOf(settings).read;
  if (round === 1) return { requests: [{ key: 'case', route: 'case-data', body: { id: bodyId(key) } }], reads: roots.map((root) => ({ external: treeId(root) })), done: roots.length === 0, original: 'case' };
  // A document added after the trees were cached is in none of them: the cached trees are read again once.
  const stale = roots.filter((root) => reads[treeId(root)]?.cached === true);
  if (locate(reads, roots, key) !== null || stale.length === 0) return { requests: [], done: true };
  return { requests: [], reads: stale.map((root) => ({ external: treeId(root), refresh: true })), done: true };
}

export function mindmapProject(input: unknown): unknown {
  const { key, settings, responses, reads, original } = partsOf(input);
  const data = dataOf(responses[original]);
  let content: { name: string; media_type: string; text?: string; json?: unknown };
  if (typeof data === 'string') content = { name: 'content', media_type: 'application/json', text: data };
  else if (isRecord(data)) content = { name: 'content', media_type: 'application/json', json: data };
  else return { error: { code: 'agile.no_document', message: '用例数据应答的 data 既不是字符串也不是对象' } };
  const found = locate(reads, readRootsOf(settings).read, key);
  const meta = found === null ? { id: key, title: null, ancestors: [], root: null } : { id: key, title: found.title, ancestors: found.ancestors, root: found.root };
  const revision = responses[original]?.sha256;
  // Not placed while a tree is missing: the title and the folders are unknown, not absent.
  const unread = found === null ? unreadRoots(reads, settings) : [];
  return {
    ...(typeof revision === 'string' ? { revision } : {}),
    artifacts: [content, { name: 'meta', media_type: 'application/json', json: meta }],
    ...(found !== null
      ? {}
      : unread.length > 0
        ? { complete: false, note: `没有在读到的根里找到这份文档，${unreadNote(unread, settings)}：标题和上级目录未知` }
        : { note: '配置的根里没有这份文档：标题和上级目录未知' }),
  };
}

// ---------------------------------------------------------------- agile:search:<terms>

function decoded(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/**
 * The terms of a search key and the documents it leaves out: parts joined by +, percent escapes decoded; a part written with a
 * raw `!` names a document id to leave out (an encoded %21 stays a term), blank and repeated terms are dropped.
 */
export function searchKeyOf(key: string): { terms: string[]; exclude: string[] } {
  const terms: string[] = [];
  const exclude: string[] = [];
  const seen = new Set<string>();
  for (const raw of key.split('+')) {
    if (raw.startsWith('!')) {
      const id = decoded(raw.slice(1)).trim();
      if (ID.test(id) && !exclude.includes(id) && exclude.length < MAX_EXCLUDED) exclude.push(id);
      continue;
    }
    const term = decoded(raw).trim().slice(0, 64);
    if (term === '' || seen.has(term.toLowerCase()) || terms.length >= MAX_TERMS) continue;
    seen.add(term.toLowerCase());
    terms.push(term);
  }
  return { terms, exclude };
}

export function termsOf(key: string): string[] {
  return searchKeyOf(key).terms;
}

/** Case-insensitive containment; an ASCII term counts only where no ASCII letter touches it. */
export function containsTerm(text: string, term: string): boolean {
  const haystack = text.toLowerCase();
  const needle = term.toLowerCase();
  if (!/^[A-Za-z0-9]+$/.test(term)) return haystack.includes(needle);
  for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + 1)) {
    if (!/[A-Za-z]/.test(haystack[at - 1] ?? '') && !/[A-Za-z]/.test(haystack[at + needle.length] ?? '')) return true;
  }
  return false;
}

export type Ranked = Located & { matched: string[] };

/**
 * The documents whose titles contain the most terms, best first (ties by root order, then document order); at most five.
 * Documents named in `exclude` (the reviewed document itself) are left out.
 */
export function rankDocuments(reads: Record<string, Nested>, roots: readonly string[], terms: readonly string[], exclude: readonly string[] = []): Ranked[] {
  const scored: Array<Ranked & { order: number }> = [];
  let order = 0;
  for (const root of roots) {
    const tree = treeOf(reads[treeId(root)]);
    if (tree === null) continue;
    for (const doc of documentsOf(tree)) {
      if (exclude.includes(doc.id)) continue;
      const matched = doc.title === null ? [] : terms.filter((term) => containsTerm(doc.title as string, term));
      if (matched.length > 0) scored.push({ ...doc, matched, order: order++ });
    }
  }
  return scored
    .sort((a, b) => b.matched.length - a.matched.length || a.order - b.order)
    .slice(0, SEARCH_LIMIT)
    .map(({ order: _order, ...doc }) => doc);
}

export function searchPlan(input: unknown): PlanOutput {
  const { round, key, settings, reads } = partsOf(input);
  const roots = readRootsOf(settings).read;
  const { terms, exclude } = searchKeyOf(key);
  if (terms.length === 0 || roots.length === 0) return { requests: [], done: true };
  // The first root listing page is the answer as received; the result is derived from the cached trees and the outlines.
  if (round === 1) return { requests: [{ key: 'listing', route: 'roots', body: { page: 1 } }], reads: roots.map((root) => ({ external: treeId(root) })), done: false, original: 'listing' };
  const best = rankDocuments(reads, roots, terms, exclude).slice(0, OUTLINE_LIMIT);
  return { requests: best.map((doc, k) => ({ key: `case-${k + 1}`, route: 'case-data', body: { id: bodyId(doc.id) } })), done: true };
}

/** Node texts of a KityMinder document (inner JSON as text or object), indented by depth, at most OUTLINE_LINES. */
export function outlineOf(data: unknown): string[] {
  let doc: unknown = data;
  for (let k = 0; k < 2 && typeof doc === 'string'; k++) {
    try {
      doc = JSON.parse(doc);
    } catch {
      return [];
    }
  }
  const root = isRecord(doc) && isRecord(doc.root) ? doc.root : null;
  if (root === null) return [];
  const lines: string[] = [];
  type Frame = { node: unknown; depth: number };
  const stack: Frame[] = [{ node: root, depth: 0 }];
  while (stack.length > 0 && lines.length < OUTLINE_LINES) {
    const { node, depth } = stack.pop() as Frame;
    if (!isRecord(node)) continue;
    const data = isRecord(node.data) ? node.data : {};
    const text = typeof data.text === 'string' ? data.text.replace(/\s+/g, ' ').trim() : '';
    if (text !== '') lines.push(`${'  '.repeat(depth)}${text.slice(0, 200)}`);
    if (depth >= OUTLINE_DEPTH) continue;
    const children = Array.isArray(node.children) ? node.children : [];
    for (let k = children.length - 1; k >= 0; k--) stack.push({ node: children[k], depth: depth + 1 });
  }
  return lines;
}

export function searchProject(input: unknown): unknown {
  const { key, settings, responses, reads } = partsOf(input);
  const { terms, exclude } = searchKeyOf(key);
  const ranked = rankDocuments(reads, readRootsOf(settings).read, terms, exclude);
  const outlines = ranked.slice(0, OUTLINE_LIMIT).flatMap((doc, k) => {
    const response = responses[`case-${k + 1}`];
    return response?.ok === true ? [{ id: doc.id, title: doc.title, lines: outlineOf(dataOf(response)) }] : [];
  });
  // Roots whose trees were not read were not searched: the result is incomplete, never "no similar list".
  const unread = unreadRoots(reads, settings);
  const note = unread.length > 0 ? `${unreadNote(unread, settings)}，这些根没有检索${ranked.length === 0 ? '；读到的根里没有标题包含这些词的文档' : ''}` : ranked.length === 0 ? '配置的根里没有标题包含这些词的文档' : null;
  return {
    artifacts: [
      {
        name: 'content',
        media_type: 'application/json',
        json: { terms, documents: ranked.map((doc) => ({ id: doc.id, title: doc.title, ancestors: doc.ancestors, matched: doc.matched })), outlines, ...(exclude.length > 0 ? { excluded: exclude } : {}), ...(unread.length > 0 ? { unread } : {}) },
      },
      { name: 'meta', media_type: 'application/json', json: { title: `相似的测试清单：${terms.join('、')}`, terms, documents: ranked.length, ...(unread.length > 0 ? { unread: unread.length } : {}) } },
    ],
    ...(unread.length > 0 ? { complete: false } : {}),
    ...(note !== null ? { note } : {}),
  };
}
