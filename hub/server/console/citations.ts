// A knowledge node's citations and provenance for the console (the interface doc's node detail): how many accepted
// submissions cited the node or its entries in the last CITATION_DAYS, from the index the runs engine writes as it
// stores a submission (hub/runs citationIndex), and the source references each entry rests on (the tree reader's
// grounds). Submissions stored before citations were indexed count once the runs engine's backfill has indexed them all
// (hub/runs backfillCitations); until then, when the window starts before the index, the count is a lower bound and says
// from when it counts. Called only for a node the reader could read.
import type { NodeViews } from '../../ports.ts';
import { citationsComplete, citationsIndexedSince, countCitations } from '../../runs/api.ts';
import type { PageContext } from './pages.ts';
import { when } from './ui.ts';

export const CITATION_DAYS = 30;
/** Counts stop here: beyond it the answer is "at least". */
const CITATION_CAP = 10_000;
/** Entries of one node counted and given their provenance. */
const MAX_ENTRIES = 50;
/** Source references listed per entry. */
const MAX_GROUNDS = 20;

type NodeView = NodeViews[number];

export interface EntryCitation {
  entry: string;
  count: number;
  capped: boolean;
  /** The source references the entry rests on; null when the reader gives none. */
  grounds: string[] | null;
  /** More grounds exist than are listed. */
  grounds_truncated: boolean;
}

export interface Citations {
  days: number;
  /** Start of the window. */
  since: string;
  /** Accepted submissions in the window that cited the node, or any of its entries from any root. */
  count: number;
  capped: boolean;
  /** When submissions started to be indexed as they are stored: the oldest so indexed; null before any. */
  indexed_since: string | null;
  /** The count is exact (up to the cap): the index covers the whole window, or every submission once the backfill ended. */
  complete: boolean;
  /** At most MAX_ENTRIES entries, in the node's order. */
  entries: EntryCitation[];
  entries_truncated: boolean;
}

/** The citations of `node` in `root`; null when the records offer no count. */
export async function nodeCitations(ctx: PageContext, root: string, node: NodeView): Promise<Citations | null> {
  const store = ctx.deps.records.store;
  const now = (ctx.deps.now?.() ?? new Date()).getTime();
  const since = new Date(now - CITATION_DAYS * 86_400_000).toISOString();
  const shown = node.entries.slice(0, MAX_ENTRIES);
  const total = await countCitations(store, { nodes: [{ root, path: node.path }], entries: shown.map((entry) => entry.entry), since, cap: CITATION_CAP });
  if (total === null) return null;
  const reader = ctx.deps.knowledge.treeReader();
  const identity = { user: ctx.principal.id, role: ctx.principal.role };
  const entries: EntryCitation[] = [];
  for (const entry of shown) {
    const counted = (await countCitations(store, { nodes: [], entries: [entry.entry], since, cap: CITATION_CAP }))!;
    let grounds: string[] | null = null;
    try {
      grounds = (await reader.read(root, node.path, entry.entry, identity))?.grounds ?? null;
    } catch {
      grounds = null;
    }
    entries.push({ entry: entry.entry, count: counted.count, capped: counted.capped, grounds: grounds === null ? null : grounds.slice(0, MAX_GROUNDS), grounds_truncated: grounds !== null && grounds.length > MAX_GROUNDS });
  }
  const indexedSince = await citationsIndexedSince(store);
  const backfilled = await citationsComplete(store);
  return {
    days: CITATION_DAYS,
    since,
    count: total.count,
    capped: total.capped,
    indexed_since: indexedSince,
    complete: backfilled || (indexedSince !== null && indexedSince <= since),
    entries,
    entries_truncated: node.entries.length > shown.length,
  };
}

/** “N 次”, “N 次以上”, or a lower bound when the index starts inside the window. */
export function countText(citations: Pick<Citations, 'complete'>, count: number, capped: boolean): string {
  const n = capped ? `${count} 次以上` : `${count} 次`;
  return citations.complete ? n : `至少 ${n}`;
}

/** The node's line: the count over the window and, when the index starts inside it, from when it counts. */
export function citationsLine(citations: Citations): string {
  const count = countText(citations, citations.count, citations.capped);
  const head = `近 ${citations.days} 天被引用${citations.complete ? ` ${count}` : count}`;
  if (citations.complete) return `${head}（按引用该节点或其条目的已受理提交计）`;
  return citations.indexed_since === null
    ? `近 ${citations.days} 天被引用：暂无统计（引用自本功能启用后受理的提交起统计）`
    : `${head}（引用自 ${when(citations.indexed_since)} 起统计，更早的提交未计入）`;
}
