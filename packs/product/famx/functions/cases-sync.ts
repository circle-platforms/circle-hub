// The case documents of the builds (the sync plan's part of the case index, brief section 6a capability 4). With the sync
// option `case_index` on, the plan reads the agile platform's tree of every configured root (agile:tree:roots, the agile
// system pack), takes the documents of the roots titled with a product name (both name families: FAMX and FAMY are one
// product), locates each one with locate.ts and lists, in the sources of every build that has its own command tree:
// - `case_documents`: the agile:case ids of the documents whose version line is not later than the build's line and not
//   earlier than the option `min_line` (explicit null means no floor), ordered by document id (numbers by value). The order only has to be
//   stable: an unchanged tree gives the same list, so the Hub keeps the build's root (its list digest is unchanged). A
//   changed list re-runs every batch of that build: the Hub keys a stored producer call by the whole build, list included.
//   Over the role's limit the documents of the oldest lines (earliest release-train date) are left out first;
// - `case_tree`: agile:tree:roots, where the case producer finds each document's title and folders.
// A build whose list is empty gets neither role. Documents without a located line join the product-wide scope; uncovered located documents do too. Documents before min_line, with an id the agile
// pack cannot read, and leaves no folder lists (empty folders) are not listed; the note counts them by reason with example
// ids. While the tree is not read, cannot be read or is incomplete (a configured root not read, a root title unknown), the
// builds that would list documents are not listed at all (sync.ts): a root produced now would lose every case it had.
// Which line is not later than a build's line is the earliest release-train date of that line in the tree (YYYY/M in the
// train label), not numeric order of version components.
// A line with no dated train is listed only for a build of that same line. min_line is the same date floor when the tree
// dates that line; a line with no date is not dropped as earlier than min_line.
import { AGILE_ID, CASE_DOCUMENTS_ROLE, CASE_PREFIX, CASE_TREE_ID, CASE_TREE_ROLE, DEFAULT_MIN_LINE } from './cases-rules.ts';
import { locateFromAncestors } from './locate.ts';
import { PRODUCT_LINE, lineKey } from './naming.ts';
import { compareDigits, compareText, isRecord } from './util.ts';

/** Most external objects one role of a build may list (contracts MAX_LIST_SOURCES; a test keeps them equal). */
export const MAX_CASE_DOCUMENTS = 20000;
/** Example ids a note names per reason. */
export const NOTE_EXAMPLES = 3;
const DOTTED = /^[0-9]{1,3}(?:\.[0-9]{1,3}){1,3}$/;

export type CaseIndexOptions = { on: boolean; minLine: string | null; notes: string[]; invalidMinLine?: true };

/** The case index options of the sync declaration (as the caller overrode them). */
export function caseIndexOptions(options: unknown): CaseIndexOptions {
  const record = isRecord(options) ? options : {};
  const notes: string[] = [];
  let minLine: string | null = DEFAULT_MIN_LINE;
  let invalidMinLine = false;
  if (Object.hasOwn(record, 'min_line')) {
    const value = typeof record.min_line === 'string' ? record.min_line.trim() : '';
    if(record.min_line===null)minLine=null;
    else if (DOTTED.test(value)) minLine = lineKey(value);
    else {
      invalidMinLine=true;
      notes.push('同步选项 min_line 应是点分版本线或显式 null；未套用下限。下一步 circle-hub var set FAMX_MIN_LINE --file <JSON文件> --reason <理由>，修正后重跑同步');
    }
  }
  return { on: record.case_index === true, minLine: minLine===null?null:lineKey(minLine), notes, ...(invalidMinLine?{invalidMinLine:true as const}:{}) };
}

/** A located document. `at` is the release-train month (YYYY-MM-01) when the train label carries one. */
export type CaseDocument = { id: string; line: string; at: string | null };

/** The month a release-train label names (`2026/7`, `2025/12`), or null. */
export function trainInstant(train: string | null): string | null {
  if (train === null) return null;
  const found = /([0-9]{4})\/([0-9]{1,2})(?!\d)/.exec(train);
  if (found === null) return null;
  const month = Number(found[2]);
  if (month < 1 || month > 12) return null;
  return `${found[1]}-${String(month).padStart(2, '0')}-01`;
}

/** Earliest train month of each line. Lines with no dated train are absent. */
export function lineRanks(documents: readonly CaseDocument[]): Map<string, string> {
  const ranks = new Map<string, string>();
  for (const doc of documents) {
    if (doc.at === null) continue;
    const known = ranks.get(doc.line);
    if (known === undefined || doc.at < known) ranks.set(doc.line, doc.at);
  }
  return ranks;
}

/** True when `line` is the build's line, or its earliest train is not after the build line's. */
export function lineNotAfter(line: string, buildLine: string, ranks: ReadonlyMap<string, string>): boolean {
  if (line === buildLine) return true;
  const left = ranks.get(line);
  const right = ranks.get(buildLine);
  if (left === undefined || right === undefined) return false;
  return left <= right;
}

/** A count with the first ids it counts. */
export type Counted = { count: number; examples: string[] };

export type CaseCounts = {
  roots: number;
  productRoots: string[];
  otherRoots: number;
  otherDocuments: number;
  documents: number;
  located: number;
  noLine: Counted;
  beforeMinLine: Counted;
  badId: Counted;
  /** Leaves no folder lists: empty folders (agile:tree:roots `listed: false`). */
  emptyFolders: Counted;
  /** Documents filed more than once, as agile:tree:roots counted them (each kept at its first place). */
  repeated: number;
};

export type CaseTree =
  | { status: 'pending' }
  | { status: 'failed'; reason: string }
  | { status: 'ready'; documents: CaseDocument[]; unlocated: string[]; counts: CaseCounts };

const counted = (): Counted => ({ count: 0, examples: [] });
function add(counter: Counted, id: unknown): void {
  counter.count++;
  if (counter.examples.length < NOTE_EXAMPLES) counter.examples.push(typeof id === 'string' ? id.slice(0, 64) : '?');
}

/** A root titled with one of the product's names (NFKC, case-insensitive; the name alone or followed by a non-word mark). */
export function isProductRoot(title: unknown, names: readonly string[] = PRODUCT_LINE.names): boolean {
  if (typeof title !== 'string') return false;
  return names.some(name => title === name);
}

const numeric = (s: string): boolean => /^[0-9]+$/.test(s);
const byId = (a: CaseDocument, b: CaseDocument): number => {
  if (numeric(a.id) !== numeric(b.id)) return numeric(a.id) ? -1 : 1;
  return (numeric(a.id) ? compareDigits(a.id, b.id) : 0) || compareText(a.id, b.id);
};

/** The documents of the read tree that can be listed, or why there are none to list yet. */
export function caseTree(read: Record<string, unknown>, options: CaseIndexOptions, names: readonly string[] = PRODUCT_LINE.names): CaseTree {
  if(options.invalidMinLine)return {status:'failed',reason:options.notes[0]};
  if (!Object.hasOwn(read, CASE_TREE_ID)) return { status: 'pending' };
  const entry = read[CASE_TREE_ID];
  if (!isRecord(entry) || entry.ok !== true) {
    const reason = isRecord(entry) && typeof entry.reason === 'string' ? entry.reason.slice(0, 200) : '没有读到';
    return { status: 'failed', reason: `读不出（${reason}）` };
  }
  const model = entry.model;
  if (entry.parser !== 'json@1' || !isRecord(model) || !Array.isArray(model.roots) || !Array.isArray(model.documents)) return { status: 'failed', reason: '内容不是根和文档的清单' };
  if (model.complete !== true) {
    const unread = Array.isArray(model.unread) ? model.unread.filter((x): x is string => typeof x === 'string') : [];
    const untitled = (model.roots as unknown[]).filter((r) => isRecord(r) && typeof r.id === 'string' && typeof r.title !== 'string').map((r) => (r as { id: string }).id);
    const parts = [unread.length > 0 ? `${unread.length} 个配置的根没有读到（${unread.slice(0, 8).join('、')}）` : '', untitled.length > 0 ? `${untitled.length} 个根的标题未知（${untitled.slice(0, 8).join('、')}）` : ''].filter((p) => p !== '');
    return { status: 'failed', reason: `不完整（${parts.length > 0 ? parts.join('，') : '读取说内容不完整'}）` };
  }
  const product = new Set<string>();
  const productTitles: string[] = [];
  let roots = 0;
  for (const root of model.roots as unknown[]) {
    if (!isRecord(root) || typeof root.id !== 'string') continue;
    roots++;
    if (isProductRoot(root.title, names)) {
      product.add(root.id);
      productTitles.push(String(root.title));
    }
  }
  const repeated = typeof model.repeated === 'number' && Number.isSafeInteger(model.repeated) && model.repeated >= 0 ? model.repeated : 0;
  const counts: CaseCounts = {
    roots,
    productRoots: productTitles,
    otherRoots: roots - product.size,
    otherDocuments: 0,
    documents: 0,
    located: 0,
    noLine: counted(),
    beforeMinLine: counted(),
    badId: counted(),
    emptyFolders: counted(),
    repeated,
  };
  const found: CaseDocument[] = [];
  const unlocated: string[] = [];
  const seen = new Set<string>();
  for (const doc of model.documents as unknown[]) {
    if (!isRecord(doc) || typeof doc.root !== 'string') continue;
    if (!product.has(doc.root)) {
      counts.otherDocuments++;
      continue;
    }
    if (doc.listed === false) {
      add(counts.emptyFolders, doc.id);
      continue;
    }
    counts.documents++;
    if (typeof doc.id !== 'string' || !AGILE_ID.test(doc.id)) {
      add(counts.badId, doc.id);
      continue;
    }
    // agile:tree:roots lists each id once; a repeat here is counted with the tree's own.
    if (seen.has(doc.id)) {
      counts.repeated++;
      continue;
    }
    seen.add(doc.id);
    const ancestors = Array.isArray(doc.ancestors) ? doc.ancestors.filter((a): a is string => typeof a === 'string') : [];
    const located = locateFromAncestors(ancestors);
    if (located.line === null) {
      add(counts.noLine, doc.id);
      unlocated.push(doc.id);
      continue;
    }
    const line = lineKey(located.line);
    found.push({ id: doc.id, line, at: trainInstant(located.train) });
  }
  const ranks = lineRanks(found);
  const floor = options.minLine===null?undefined:ranks.get(options.minLine);
  const documents: CaseDocument[] = [];
  for (const doc of found) {
    const at = ranks.get(doc.line);
    if (floor !== undefined && at !== undefined && at < floor) {
      add(counts.beforeMinLine, doc.id);
      continue;
    }
    counts.located++;
    documents.push(doc);
  }
  documents.sort(byId);
  return { status: 'ready', documents, unlocated, counts };
}

/** Sources no selected build covers; all readable identities are retained, not just the note's examples. */
export function unversionedCaseSources(tree:Extract<CaseTree,{status:'ready'}>,buildLines:readonly string[]):{ids:string[];noLine:number;uncovered:number;excluded:number} {
  const ranks=lineRanks(tree.documents);
  const uncovered=tree.documents.filter(doc=>!buildLines.some(line=>lineNotAfter(doc.line,line,ranks)));
  const ids=[...new Set([...tree.unlocated,...uncovered.map(doc=>doc.id)])].sort((a,b)=>compareDigits(a,b)||compareText(a,b)).map(id=>CASE_PREFIX+id);
  if(ids.length>MAX_CASE_DOCUMENTS)throw new RangeError(`不分版本的用例清单超过 ${MAX_CASE_DOCUMENTS} 份；下一步拆分产品来源范围后重跑，不提交截断清单`);
  return {ids,noLine:tree.unlocated.length,uncovered:uncovered.length,excluded:tree.counts.beforeMinLine.count+tree.counts.badId.count};
}

/**
 * The case documents of a build of this line (agile:case ids, in list order) and how many were left out over `cap`: the
 * documents of the oldest lines go first, so that the build's own line stays listed.
 */
export function caseDocumentsFor(documents: readonly CaseDocument[], buildLine: string, _cache = new Map<string, boolean>(), cap = MAX_CASE_DOCUMENTS): { ids: string[]; cut: number } {
  const ranks = lineRanks(documents);
  const within = documents.filter((doc) => lineNotAfter(doc.line, buildLine, ranks));
  let kept = within;
  if (within.length > cap) {
    kept = [...within]
      .sort((a, b) => {
        const left = ranks.get(a.line) ?? '';
        const right = ranks.get(b.line) ?? '';
        return left < right ? -1 : left > right ? 1 : byId(a, b);
      })
      .slice(within.length - cap)
      .sort(byId);
  }
  return { ids: kept.map((doc) => `${CASE_PREFIX}${doc.id}`), cut: within.length - kept.length };
}

/** The sources a build with its own command tree gains: nothing for an empty list. */
export function caseSources(ids: readonly string[]): Record<string, string | string[]> {
  return ids.length === 0 ? {} : { [CASE_DOCUMENTS_ROLE]: [...ids], [CASE_TREE_ROLE]: CASE_TREE_ID };
}

/**
 * Located documents no listed build covers (their line is later than every line a build with its own tree was listed on),
 * per line, with example ids.
 */
export function uncoveredDocuments(documents: readonly CaseDocument[], buildLines: readonly string[]): Array<{ line: string } & Counted> {
  const ranks = lineRanks(documents);
  const byLine = new Map<string, Counted>();
  for (const doc of documents) {
    if (buildLines.some((line) => lineNotAfter(doc.line, line, ranks))) continue;
    let counter = byLine.get(doc.line);
    if (counter === undefined) byLine.set(doc.line, (counter = counted()));
    add(counter, doc.id);
  }
  return [...byLine.entries()]
    .sort(([a], [b]) => {
      const left = ranks.get(a) ?? '';
      const right = ranks.get(b) ?? '';
      return left < right ? -1 : left > right ? 1 : compareText(a, b);
    })
    .map(([line, counter]) => ({ line, ...counter }));
}

const named = (counter: Counted): string => (counter.examples.length === 0 ? '' : `，例如 ${counter.examples.join('、')}`);

/** The plan note's part on the case documents (Chinese). */
export function caseNote(tree: CaseTree, options: CaseIndexOptions, extra: { listed: number; cut: number; withheld?: number; uncovered?: ReadonlyArray<{ line: string } & Counted>; scoped?:boolean }): string {
  if (tree.status === 'pending') return '用例文档：敏捷平台的用例树还没有读';
  if (tree.status === 'failed') {
    const withheld = extra.withheld ?? 0;
    if(options.invalidMinLine)return `用例文档：${tree.reason}；这次不列 ${withheld} 个会列出用例文档的构建，旧根不动`;
    return `用例文档：敏捷平台的用例树（${CASE_TREE_ID}）${tree.reason}，这次不列 ${withheld} 个会列出用例文档的构建（版本线 ${options.minLine===null?'不设下限':options.minLine+' 起'}有自己命令树的构建），免得产出缺少用例的根；不需要用例索引时把同步选项 case_index 设为 false`;
  }
  const c = tree.counts;
  const parts = [
    `用例文档：读到 ${c.roots} 个根，产品的根 ${c.productRoots.length} 个（${c.productRoots.join('、') || '无'}）下有 ${c.documents} 份文档，按版本线（${options.minLine===null?'不设下限':options.minLine+' 起'}）可列 ${c.located} 份，构建里共列出 ${extra.listed} 份次`,
  ];
  const uncovered = extra.uncovered ?? [];
  const unlisted = [
    !extra.scoped && c.noLine.count > 0 ? `上级目录里没有版本线 ${c.noLine.count} 份${named(c.noLine)}` : '',
    c.beforeMinLine.count > 0 ? `早于 ${options.minLine} 的 ${c.beforeMinLine.count} 份${named(c.beforeMinLine)}` : '',
    c.badId.count > 0 ? `编号读不了 ${c.badId.count} 份${named(c.badId)}` : '',
    ...(!extra.scoped?uncovered.map((u) => `版本线 ${u.line} 没有列出的构建 ${u.count} 份${named(u)}`):[]),
  ].filter((p) => p !== '');
  if (unlisted.length > 0) parts.push(`没有列出：${unlisted.join('；')}`);
  if (c.emptyFolders.count > 0) parts.push(`空目录 ${c.emptyFolders.count} 个（没有被上级目录列为文档的叶子${named(c.emptyFolders)}），不算文档`);
  if (c.repeated > 0) parts.push(`挂了不止一处的文档 ${c.repeated} 份，按第一次出现的位置算`);
  if (c.otherRoots > 0) parts.push(`另有 ${c.otherRoots} 个根不是产品的根（${c.otherDocuments} 份文档，没有读）`);
  if (extra.cut > 0) parts.push(`有构建的用例文档超过 ${MAX_CASE_DOCUMENTS} 份，最早版本线的 ${extra.cut} 份次没有列出`);
  return [...parts, ...options.notes].join('，');
}
