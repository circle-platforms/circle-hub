// Read functions of the agile test platform system pack (pure, run in the Hub sandbox). The platform answers every request
// with HTTP 200 and an envelope {code, msg, data}; the Hub logs in (the profile's login rule) and checks the envelope. Reads:
// - agile:tree:<root id>: the whole subtree of a root ({label, id, cases, children} nodes) and the root's title, found in the
//   paged root listing (10 per page with a total; pages past the end repeat page 1, so only the announced pages are read).
// - agile:tree:roots: every configured root (all settings.roots within the Hub read budgets) at once, one subtree request per
//   root and, for a root whose subtree answer does not carry its own node, the listing pages that name it, at most
//   ROOTS_IN_FLIGHT requests per round (the connectors send the requests of a round together, within the resource's own
//   limits). Content: {roots: [{id, title}], documents: [{id, title, ancestors, root, listed}], repeated, complete,
//   unread?}: every leaf of the trees with the folder labels above it from the root title down (the ancestors the mind-map
//   meta gives), each id once; `listed` says whether a folder lists the leaf in `cases` (the platform's folders list every
//   document below them, so an unlisted leaf is an empty folder), `repeated` counts the ids filed more than once. The
//   revision is the SHA-256 of that content, so equal trees give one revision and one stored content.
// - agile:mindmap:<document id>: the document (data is the KityMinder JSON encoded once more as a string). Artifacts: the
//   original answer, content (the inner KityMinder JSON, application/json) and meta {id, title, ancestors, root}: the title
//   and the labels of the folders above the document from the root down, found in the trees of the configured roots
//   (all settings.roots within the Hub read budgets), read as nested reads, which the Hub caches; a document in none of them
//   refreshes the cached trees once. A document no tree places while a root was not read is incomplete (meta unknown).
// - agile:case:<document id>: the document alone, for the case index: the case-data request only, no nested read. Content:
//   the KityMinder JSON with one more wrapper member, `agile: {id}` (kityminder@1 keeps wrapper members in model.meta), so
//   that the document says which agile document it is wherever the Hub hands it on; the original answer; meta {id}.
// - agile:search:<terms joined by +>[+!<document id>...]: the documents of the configured roots as a listing (id, title,
//   folders above it, root), leaving out the documents a `!` part names by their exact id. Keyword retrieval is retired
//   (owner ruling U19/U20, 2026-10-24): titles are not scored, no document is chosen by a term and none is read here; the
//   terms are disclosed as unused. The listing is a hint for what exists, never a ground for product behaviour, and never
//   a basis of recall. Incomplete when a root was not read.
// Mindmap/search use one aggregate nested tree read and at most one refresh, independent of configured-root count.
import { createHash } from 'node:crypto';

type Planned = { key: string; route: string; body?: unknown };
type NestedAsk = { external: string; refresh?: boolean };
type PlanOutput = { concurrency?:number; requests: Planned[]; reads?: NestedAsk[]; done: boolean; original?: string };
type Response = { ok?: boolean; json?: unknown; sha256?: string | null };
type Nested = { ok?: boolean; cached?: boolean; content?: unknown; meta?: unknown;coverage?:{complete:boolean} };
type TreeNode = { label?: unknown; title?: unknown; name?: unknown; id?: unknown; cases?: unknown; children?: unknown };

const PAGE_SIZE = 10;
const MAX_PAGES = 50;
/** Roots read by one read: half the connectors' nested reads (20 over all rounds), so a refresh of every one still fits. */
/** @deprecated Historical cap, retained as a source API constant; configured roots are no longer sliced. */
export const MAX_ROOTS = 10;
/** Documents one search key may leave out. */
const MAX_EXCLUDED = 8;
const MAX_DEPTH = 64;
/** Documents one search listing names; the rest are counted and the tree read is named as the next step. */
const SEARCH_LISTING_LIMIT = 200;
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

/** Key of the read of every configured root at once (agile:tree:roots); never a root id of its own. */
export const ROOTS_KEY = 'roots';

/** The root ids the resource names (settings.roots: ids as text or numbers), in order, without repeats. */
export function rootsOf(settings: Record<string, unknown>): string[] {
  const list = Array.isArray(settings.roots) ? settings.roots : [];
  const out: string[] = [];
  for (const value of list) {
    const id = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : typeof value === 'string' ? value.trim() : '';
    if (ID.test(id) && id !== ROOTS_KEY && !out.includes(id)) out.push(id);
  }
  return out;
}

/** All configured roots; the Hub request and byte budgets decide whether this read can complete. */
function readRootsOf(settings: Record<string, unknown>): { read: string[]; beyond: string[] } {
  const all = rootsOf(settings);
  return { read: all, beyond: [] };
}

const treeId = (root: string): string => `agile:tree:${root}`;

/** The roots whose trees are not at hand: read but not ok, and configured beyond the limit. */
function unreadRoots(reads: Record<string, Nested>, settings: Record<string, unknown>): string[] {
  const aggregate=reads[treeId(ROOTS_KEY)];
  if(aggregate!==undefined){const content=isRecord(aggregate.content)?aggregate.content:{};if(aggregate.ok!==true || aggregate.coverage?.complete===false || content.complete===false)return rootsOf(settings);return Array.isArray(content.unread)?content.unread.filter((v):v is string=>typeof v==='string'):[];}
  const { read, beyond } = readRootsOf(settings);
  return [...read.filter((root) => reads[treeId(root)]?.ok !== true), ...beyond];
}

function unreadNote(unread: readonly string[], _settings: Record<string, unknown>): string {
  const named=unread.slice(0,12).join('、');
  return `${unread.length} 个配置的根未确认完整读到（${named}${unread.length>12?' 等':''}）；恢复失败读取后重读范围，不能按完整范围判定`;
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

/**
 * The roots of one listing page, from the forms the listing takes ({list}, {records} or a bare array in `data`). The real
 * platform answers {code, data: [10 roots], msg, total}: the total is a sibling of `data`, not inside it.
 */
function listedRoots(response: Response | undefined): { total: number; roots: TreeNode[] } {
  const data = dataOf(response);
  const page = isRecord(data) ? data : {};
  const list = Array.isArray(data) ? data : Array.isArray(page.list) ? page.list : Array.isArray(page.records) ? page.records : [];
  const top = isRecord(response?.json) ? (response.json as Record<string, unknown>) : {};
  const count = (value: unknown): number | null => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null);
  const total = count(page.total) ?? count(top.total) ?? list.length;
  return { total, roots: list.filter(isRecord) as TreeNode[] };
}

export function treePlan(input: unknown): PlanOutput {
  const { round, key, responses } = partsOf(input);
  if (key === ROOTS_KEY) return rootsPlan(input);
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
  if (key === ROOTS_KEY) return rootsProject(input);
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

/** A leaf of a tree as scanned: `listed` when a folder of the tree lists its id in `cases`. */
export type ScannedDocument = Located & { listed: boolean };

/**
 * Every document of a tree, depth first in document order, with what the scan saw. In the platform's trees a leaf without
 * listed cases is a document (its id is the document id, its label the title); a folder lists in `cases` EVERY document below
 * it (the lists are cumulative: the root lists all of them), so a listed id is a document of its own only when no node carries
 * it, and it belongs to the DEEPEST folder that lists it. A leaf that lists cases is a folder whose documents have no node. A
 * leaf no folder lists is `listed: false` (an empty folder, since the folders list every document; a top-level leaf of an
 * answer without the root's own node has no folder that could list it and counts as listed). Ancestors are the folder labels
 * from the root down; the root node of the response (its id is the root id) is the first of them and never a document, and
 * the root title is added only when the response does not include that node. A leaf id met again is counted in `repeated`
 * and kept at its first place.
 */
export function scanTree(tree: Tree, limit = 100_000): { documents: ScannedDocument[]; repeated: number } {
  const own: ScannedDocument[] = [];
  const ownIds = new Set<string>();
  const listed = new Map<string, { ancestors: string[]; depth: number }>();
  const top = Array.isArray(tree.children) ? tree.children : [];
  const includesRoot = top.some((node) => isRecord(node) && idText((node as TreeNode).id) === tree.root.id);
  const start = tree.root.title === null || includesRoot ? [] : [tree.root.title];
  type Frame = { nodes: unknown; above: string[]; depth: number };
  const stack: Frame[] = [{ nodes: tree.children, above: start, depth: 0 }];
  let visited = 0;
  let repeated = 0;
  while (stack.length > 0 && visited < limit * 4) {
    const { nodes, above, depth } = stack.pop() as Frame;
    if (!Array.isArray(nodes) || depth > MAX_DEPTH) continue;
    const frames: Frame[] = [];
    for (const raw of nodes) {
      if (!isRecord(raw)) continue;
      visited += 1;
      const node = raw as TreeNode;
      const id = idText(node.id);
      const children = Array.isArray(node.children) ? node.children : [];
      const cases = (Array.isArray(node.cases) ? node.cases : []).map(idText).filter((c): c is string => c !== null);
      if (children.length === 0 && cases.length === 0) {
        // An empty root node is the root, not a document.
        if (id === null || (depth === 0 && id === tree.root.id)) continue;
        if (ownIds.has(id)) {
          repeated += 1;
          continue;
        }
        ownIds.add(id);
        own.push({ id, title: labelOf(node), ancestors: above, root: tree.root, listed: depth === 0 && !includesRoot });
        continue;
      }
      const below = [...above, labelOf(node) ?? ''];
      for (const caseId of cases) {
        const known = listed.get(caseId);
        if (known === undefined || below.length > known.depth) listed.set(caseId, { ancestors: below, depth: below.length });
      }
      frames.push({ nodes: children, above: below, depth: depth + 1 });
    }
    for (let k = frames.length - 1; k >= 0; k--) stack.push(frames[k]);
  }
  const out: ScannedDocument[] = own.map((doc) => (doc.listed || !listed.has(doc.id) ? doc : { ...doc, listed: true }));
  for (const [id, where] of listed) if (!ownIds.has(id)) out.push({ id, title: null, ancestors: where.ancestors, root: tree.root, listed: true });
  return { documents: out.slice(0, limit), repeated };
}

/** Every document of a tree (scanTree without what the scan saw): the mind-map meta and the search place documents with it. */
export function documentsOf(tree: Tree, limit = 100_000): Located[] {
  return scanTree(tree, limit).documents.map(({ listed: _listed, ...doc }) => doc);
}

// ---------------------------------------------------------------- agile:tree:roots

/** Historical planning hint retained for source consumers; physical concurrency is enforced by the resource limiter. */
export const ROOTS_IN_FLIGHT = 4;
/** Planner rounds the connectors run (contracts MAX_READ_ROUNDS; a test keeps them equal). */
export const READ_ROUNDS = 5;
/**
 * Listing pages the roots read asks for at most, as the tree read of one root. Pages are needed only for a root whose subtree
 * answer does not carry the root's own node; the round budget (READ_ROUNDS rounds of ROOTS_IN_FLIGHT) stops earlier: about 17
 * pages with two roots, 10 with MAX_ROOTS.
 */
export const ROOTS_PAGES = MAX_PAGES;
/** Documents the roots read lists at most (about 250 bytes each, well inside a core JSON parser's 16 MiB). */
export const MAX_TREE_DOCUMENTS = 50_000;

const subtreeKey = (k: number): string => `subtree-${k + 1}`;
const pageKey = (page: number): string => `page-${page}`;

/** The label of the root's own node in its subtree answer (the platform's answer starts with that node), or null. */
function subtreeTitle(root: string, response: Response | undefined): string | null {
  const data = response?.ok === true ? dataOf(response) : undefined;
  if (!Array.isArray(data)) return null;
  for (const node of data) if (isRecord(node) && idText((node as TreeNode).id) === root) return labelOf(node as TreeNode);
  return null;
}

/** Titles of the roots the listing pages read so far name, by root id (the first page that names a root wins). */
function listedTitles(responses: Record<string, Response>): Map<string, string> {
  const titles = new Map<string, string>();
  const pages = Object.keys(responses)
    .filter((name) => /^page-[0-9]{1,4}$/.test(name))
    .sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)));
  for (const name of pages) {
    for (const root of listedRoots(responses[name]).roots) {
      const id = idText(root.id);
      const label = labelOf(root);
      if (id !== null && label !== null && !titles.has(id)) titles.set(id, label);
    }
  }
  return titles;
}

/**
 * Round 1 asks for the first listing page and the first subtrees; later rounds for the subtrees left and, while a root whose
 * subtree came back carries no title (neither its own node in the answer nor a listing page read so far names it), the
 * listing pages the total announces; with physical concurrency capped by ROOTS_IN_FLIGHT. A round that still sends subtrees is not the
 * last: their answers may need pages. The first listing page is the original.
 */
export function rootsPlan(input: unknown): PlanOutput {
  const { round, settings, responses } = partsOf(input);
  const roots = readRootsOf(settings).read;
  const wanted: Planned[] = [];
  if (round === 1) wanted.push({ key: pageKey(1), route: 'roots', body: { page: 1 } });
  roots.forEach((root, k) => {
    if (!Object.hasOwn(responses, subtreeKey(k))) wanted.push({ key: subtreeKey(k), route: 'subtree', body: { id: bodyId(root) } });
  });
  if (round > 1 && responses[pageKey(1)]?.ok === true) {
    const titles = listedTitles(responses);
    const untitled = roots.some((root, k) => responses[subtreeKey(k)]?.ok === true && !titles.has(root) && subtreeTitle(root, responses[subtreeKey(k)]) === null);
    if (untitled) {
      const pages = Math.min(Math.ceil(listedRoots(responses[pageKey(1)]).total / PAGE_SIZE), ROOTS_PAGES);
      for (let page = 2; page <= pages; page++) if (!Object.hasOwn(responses, pageKey(page))) wanted.push({ key: pageKey(page), route: 'roots', body: { page } });
    }
  }
  const requests = wanted;
  const sendsSubtrees = requests.some((request) => request.route === 'subtree');
  // The last round stops whatever is left.
  const done = roots.length === 0 || (round > 1 && !sendsSubtrees);
  return { concurrency:ROOTS_IN_FLIGHT, requests, done, original: pageKey(1) };
}

export type TreeDocument = { id: string; title: string | null; ancestors: string[]; root: string; listed: boolean };
export type RootsContent = {
  roots: Array<{ id: string; title: string | null }>;
  documents: TreeDocument[];
  /** Leaf ids filed more than once (in one tree or in two), each kept at its first place. */
  repeated: number;
  complete: boolean;
  unread?: string[];
};

/** The content of agile:tree:roots from the answers: the roots with their titles and every document of their trees once. */
export function rootsContent(settings: Record<string, unknown>, responses: Record<string, Response>): { content: RootsContent; cut: boolean; untitled: string[] } {
  const { read, beyond } = readRootsOf(settings);
  const titles = listedTitles(responses);
  const roots = read.map((id, k) => ({ id, title: titles.get(id) ?? subtreeTitle(id, responses[subtreeKey(k)]) }));
  const documents: TreeDocument[] = [];
  const seen = new Set<string>();
  const unread: string[] = [];
  let repeated = 0;
  let cut = false;
  roots.forEach((root, k) => {
    const response = responses[subtreeKey(k)];
    const data = dataOf(response);
    if (response?.ok !== true || !Array.isArray(data)) {
      unread.push(root.id);
      return;
    }
    const scan = scanTree({ root, children: data }, MAX_TREE_DOCUMENTS + 1);
    repeated += scan.repeated;
    for (const doc of scan.documents) {
      if (seen.has(doc.id)) {
        repeated++;
        continue;
      }
      if (documents.length >= MAX_TREE_DOCUMENTS) {
        cut = true;
        break;
      }
      seen.add(doc.id);
      documents.push({ id: doc.id, title: doc.title, ancestors: doc.ancestors, root: root.id, listed: doc.listed });
    }
  });
  unread.push(...beyond);
  const untitled = roots.filter((root) => root.title === null).map((root) => root.id);
  const complete = roots.length > 0 && unread.length === 0 && untitled.length === 0 && !cut;
  return { content: { roots, documents, repeated, complete, ...(unread.length > 0 ? { unread } : {}) }, cut, untitled };
}

export function rootsProject(input: unknown): unknown {
  const { settings, responses } = partsOf(input);
  const { content, cut, untitled } = rootsContent(settings, responses);
  const notes: string[] = [];
  const unlisted = content.documents.filter((doc) => !doc.listed);
  if (content.roots.length === 0) notes.push('资源设置 roots 里没有可读的根编号');
  if ((content.unread ?? []).length > 0) notes.push(unreadNote(content.unread ?? [], settings));
  if (untitled.length > 0) notes.push(`根列表里没有找到 ${untitled.length} 个根的标题（${untitled.slice(0, 12).join('、')}）`);
  if (cut) notes.push(`文档超过 ${MAX_TREE_DOCUMENTS} 份，其余没有列出`);
  if (content.repeated > 0) notes.push(`${content.repeated} 份文档在树里挂了不止一处，按第一次出现的位置列出`);
  if (unlisted.length > 0) notes.push(`${unlisted.length} 个叶子节点没有被上级目录列为文档（空目录），标为 listed: false（${unlisted.slice(0, 5).map((doc) => doc.id).join('、')}）`);
  const text = JSON.stringify(content);
  return {
    revision: createHash('sha256').update(text).digest('hex'),
    artifacts: [
      { name: 'content', media_type: 'application/json', json: content },
      { name: 'meta', media_type: 'application/json', json: { id: ROOTS_KEY, title: `配置的 ${content.roots.length} 个根的子树`, roots: content.roots.length, documents: content.documents.length, complete: content.complete } },
    ],
    ...(content.complete ? {} : { complete: false }),
    ...(notes.length > 0 ? { note: notes.join('；').slice(0, 500) } : {}),
  };
}

/** The aggregate has the same configured-root order and document order as the individual tree views. */
function locatedDocuments(reads:Record<string,Nested>,roots:readonly string[]):Located[] {
  const aggregate=reads[treeId(ROOTS_KEY)];
  if(aggregate!==undefined){
    const content=aggregate.ok===true && isRecord(aggregate.content)?aggregate.content:null;
    if(content===null || !Array.isArray(content.documents))return [];
    const names=Array.isArray(content.roots)?content.roots:[];
    return content.documents.flatMap(doc=>{
      if(!isRecord(doc) || typeof doc.id!=='string' || typeof doc.root!=='string' || !roots.includes(doc.root))return [];
      const root=names.find(value=>isRecord(value) && value.id===doc.root);
      return [{id:doc.id,title:typeof doc.title==='string'?doc.title:null,ancestors:Array.isArray(doc.ancestors)?doc.ancestors.filter((v):v is string=>typeof v==='string'):[],root:{id:doc.root,title:isRecord(root) && typeof root.title==='string'?root.title:null}}];
    });
  }
  return roots.flatMap(root=>{const tree=treeOf(reads[treeId(root)]);return tree===null?[]:documentsOf(tree);});
}

/** The document in the first configured tree that holds it, or null. */
export function locate(reads: Record<string, Nested>, roots: readonly string[], id: string): Located | null {
  return locatedDocuments(reads,roots).find(doc=>doc.id===id)??null;
}

// ---------------------------------------------------------------- agile:mindmap:<document>

export function mindmapPlan(input: unknown): PlanOutput {
  const { round, key, settings, reads } = partsOf(input);
  if (!ID.test(key)) return { requests: [], done: true };
  const roots = readRootsOf(settings).read;
  if (round === 1) return { requests: [{ key: 'case', route: 'case-data', body: { id: bodyId(key) } }], reads: roots.length?[{external:treeId(ROOTS_KEY)}]:[], done: roots.length === 0, original: 'case' };
  // A document added after the trees were cached is in none of them: the cached trees are read again once.
  const stale = reads[treeId(ROOTS_KEY)]?.cached===true?[ROOTS_KEY]:roots.filter((root)=>reads[treeId(root)]?.cached===true);
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
        : { note: '这份文档在本产品配置的根之外；已读完配置根，后续由资源管理员核对归属及 roots 配置' }),
  };
}

// ---------------------------------------------------------------- agile:case:<document>

/** The wrapper member of an agile:case content that names the agile document (a test keeps it equal to the product pack's). */
export const CASE_MEMBER = 'agile';

type CaseContent = { ok: true; artifact: { name: string; media_type: string; text?: string; json?: unknown } } | { ok: false; code: string; message: string };

const isObjectText = (value: unknown): value is Record<string, unknown> => isRecord(value) && isRecord(value.root);

/**
 * The KityMinder document of a case-data answer with `agile: {id}` as its first wrapper member. A JSON text (the platform
 * encodes the document once more as a string, sometimes twice) keeps every byte of the document: the member is written in
 * after its opening brace, so no number or escape is rewritten. A document that already has an `agile` member is refused,
 * since its own member would hide the id.
 */
export function caseContent(id: string, data: unknown): CaseContent {
  const member = `${JSON.stringify(CASE_MEMBER)}:${JSON.stringify({ id })}`;
  if (isRecord(data)) {
    if (!isObjectText(data)) return { ok: false, code: 'agile.no_document', message: '用例数据应答的 data 不是 KityMinder 文档（没有 root 节点）' };
    if (Object.hasOwn(data, CASE_MEMBER)) return { ok: false, code: 'agile.reserved_member', message: `文档自带 ${CASE_MEMBER} 成员，和用例索引写入的文档编号冲突` };
    return { ok: true, artifact: { name: 'content', media_type: 'application/json', json: { [CASE_MEMBER]: { id }, ...data } } };
  }
  if (typeof data !== 'string') return { ok: false, code: 'agile.no_document', message: '用例数据应答的 data 既不是字符串也不是对象' };
  const parse = (text: string): { value: unknown } | null => {
    try {
      return { value: JSON.parse(text) };
    } catch {
      return null;
    }
  };
  let text = data;
  let parsed = parse(text);
  // Encoded once more: the JSON string holds the document's text.
  if (parsed !== null && typeof parsed.value === 'string') {
    text = parsed.value;
    parsed = parse(text);
  }
  if (parsed === null) return { ok: false, code: 'agile.no_document', message: '用例数据应答的 data 不是有效的 JSON' };
  if (!isObjectText(parsed.value)) return { ok: false, code: 'agile.no_document', message: '用例数据应答的 data 不是 KityMinder 文档（没有 root 节点）' };
  if (Object.hasOwn(parsed.value, CASE_MEMBER)) return { ok: false, code: 'agile.reserved_member', message: `文档自带 ${CASE_MEMBER} 成员，和用例索引写入的文档编号冲突` };
  // The text parsed as an object, so its first character that is not JSON white space is its opening brace, and the object
  // is not empty (it has root): the member goes right after the brace, followed by a comma.
  const open = text.search(/[^ \t\r\n]/);
  return { ok: true, artifact: { name: 'content', media_type: 'application/json', text: `${text.slice(0, open + 1)}${member},${text.slice(open + 1)}` } };
}

export function casePlan(input: unknown): PlanOutput {
  const { key } = partsOf(input);
  if (!ID.test(key)) return { requests: [], done: true };
  return { requests: [{ key: 'case', route: 'case-data', body: { id: bodyId(key) } }], done: true, original: 'case' };
}

export function caseProject(input: unknown): unknown {
  const { key, responses, original } = partsOf(input);
  const content = caseContent(key, dataOf(responses[original]));
  if (!content.ok) return { error: { code: content.code, message: content.message } };
  const revision = responses[original]?.sha256;
  return {
    ...(typeof revision === 'string' ? { revision } : {}),
    artifacts: [content.artifact, { name: 'meta', media_type: 'application/json', json: { id: key } }],
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

/**
 * The documents a search lists: every document of the configured roots in tree order, minus the documents the key names
 * with a `!` part (an exact document id), at most SEARCH_LISTING_LIMIT of them. No title is scored and no document is
 * chosen by a term (owner ruling U19/U20, 2026-10-24).
 */
export function listedDocuments(reads: Record<string, Nested>, roots: readonly string[], exclude: readonly string[] = []): Located[] {
  const out: Located[] = [];
  for (const doc of locatedDocuments(reads, roots)) {
    if (exclude.includes(doc.id)) continue;
    out.push(doc);
    if (out.length >= SEARCH_LISTING_LIMIT) break;
  }
  return out;
}

export function searchPlan(input: unknown): PlanOutput {
  const { round, settings } = partsOf(input);
  const roots = readRootsOf(settings).read;
  if (roots.length === 0) return { requests: [], done: true };
  // The first root listing page is the answer as received; the listing is derived from the cached trees.
  if (round === 1) return { requests: [{ key: 'listing', route: 'roots', body: { page: 1 } }], reads: [{external:treeId(ROOTS_KEY)}], done: false, original: 'listing' };
  // No document is requested for its title: a search reads no case data. A document is read by its declared id
  // (agile:mindmap:<id> or agile:case:<id>), or a model proposes one with a verbatim quote the Hub verifies.
  return { requests: [], done: true };
}

export function searchProject(input: unknown): unknown {
  const { key, settings, reads } = partsOf(input);
  const { terms, exclude } = searchKeyOf(key);
  const roots = readRootsOf(settings).read;
  const documents = listedDocuments(reads, roots, exclude);
  const total = locatedDocuments(reads, roots).filter((doc) => !exclude.includes(doc.id)).length;
  const cut = total > documents.length;
  // Roots whose trees were not read were not listed: the result is incomplete, never "no such document".
  const unread = unreadRoots(reads, settings);
  const note = [
    '关键词检索已退役（所有者裁定 U19/U20，2026-10-24）：本读法不按标题打分选文档，也不读任何文档正文；检索词只作披露，不作输入或查全依据。',
    '缺的事实：这次要判断的来源身份。下一步：作者用 agile:mindmap:<文档编号> 或 agile:case:<文档编号> 按下面列出的编号显式读取，或由模型带逐字引文提出候选并经 Hub 核验。',
    ...(unread.length > 0 ? [`${unreadNote(unread, settings)}，这些根没有列出`] : []),
    ...(cut ? [`文档超过 ${SEARCH_LISTING_LIMIT} 份，其余没有列出；下一步用 agile:tree:<根> 读法取完整清单`] : []),
  ].join('');
  return {
    artifacts: [
      {
        name: 'content',
        media_type: 'application/json',
        json: {
          terms,
          terms_used: false,
          documents: documents.map((doc) => ({ id: doc.id, title: doc.title, ancestors: doc.ancestors, root: doc.root })),
          listed: documents.length,
          total,
          ...(exclude.length > 0 ? { excluded: exclude } : {}),
          ...(unread.length > 0 ? { unread } : {}),
          ...(cut ? { cut: true } : {}),
        },
      },
      { name: 'meta', media_type: 'application/json', json: { title: `配置的根里的文档清单（检索词只作披露）：${terms.join('、')}`, terms, terms_used: false, documents: documents.length, selection: 'retired', ...(unread.length > 0 ? { unread: unread.length } : {}) } },
    ],
    ...(unread.length > 0 ? { complete: false } : {}),
    note,
  };
}
