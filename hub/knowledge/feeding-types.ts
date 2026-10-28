// Types of the feeding read layer: no imports from the records kit, so the Hub-side store (kb-feeding-hub) and the
// views share one shape while either side may evolve its storage.
import type {Principal} from '../records/api.ts';
import type { VersionBinding, FeedingUsage } from '../../contracts/src/feeding.ts';

/** The feeding record kinds in the layer's index. */
export const FEEDING_INDEX = {
  object: 'knowledge.feeding.object',
  binding: 'knowledge.feeding.binding',
  usage: 'knowledge.feeding.usage',
  offset: 'knowledge.feeding.offset',
  retraction: 'knowledge.feeding.retraction',
} as const;

/** Object kinds of the layer (the knowledge-structure@1 family minus its non-object records). */
export type KnowledgeStructureObject =
  | { schema: 'fed-case@1'; object: string; product: string; root: string | null; path: string | null; commands?: unknown[]; relations?: Array<{ kind: string; object: string }>; [key: string]: unknown }
  | { schema: 'fed-defect@1'; object: string; product: string; root: string | null; path: string | null; relations?: Array<{ kind: string; object: string }>; [key: string]: unknown }
  | { schema: 'fed-spec@1'; object: string; product: string; root: string | null; path: string | null; relations?: Array<{ kind: string; object: string }>; [key: string]: unknown }
  | { schema: 'fed-build@1'; object: string; product: string; root: string | null; path: string | null; relations?: Array<{ kind: string; object: string }>; [key: string]: unknown }
  | { schema: 'fed-note@1'; object: string; product: string|null; root: string | null; path: string | null; relations?: Array<{ kind: string; object: string }>; [key: string]: unknown }
  | { schema: 'fed-observation@1'; object: string; product: string; root: string; path: string; relations?: Array<{ kind: string; object: string }>; [key: string]: unknown }
  | { schema: 'fed-procedure@1'; object: string; product: string; root: string; path: string; relations?: Array<{ kind: string; object: string }>; [key: string]: unknown }
  | { schema: 'fed-pitfall@1'; object: string; product: string; root: string; path: string; relations?: Array<{ kind: string; object: string }>; [key: string]: unknown };

/** The read shape the views consume: a cut of the layer at a frozen offset. */
export interface FeedingCut {
  /** The frozen sequence position this cut stops at (inclusive); records after it are not read. Null: no offset frozen, read everything. */
  offset: number | null;
  /** Objects of the five kinds keyed by digest, minus objects a retraction before the offset invalidated. */
  objects: Map<string, KnowledgeStructureObject>;
  /** Valid function projections, grouped by exact root (or null), content identity and source identity. */
  casesByRoot?: Map<string|null, Map<string, Map<string, { body: KnowledgeStructureObject; record: string; position: number }>>>;
  /** Direct bindings per object digest, oldest first. */
  bindings: Map<string, VersionBinding[]>;
  /** Digests a retraction before the offset invalidated (withdrawn: excluded from views, still visible in provenance). */
  retracted: Set<string>;
  /** Digests of objects that take part in at least one contradicts relation (contradictions counted apart). */
  contradicted: Set<string>;
  /** Usages observed up to the offset, oldest first. */
  usages: FeedingUsage[];
}

/** Reads the feeding layer of one product up to a frozen offset. */
export interface FeedingReader {
  /** The cut at the offset (null offset: everything now in the layer); null when the layer holds nothing at all. */
  cut(product: string, offset: number | null,principal?:Principal): Promise<FeedingCut | null>;
  /** The offset a run froze (its feeding-offset@1 record), or null when the run froze none. */
  frozenOffset(run: string): Promise<number | null>;
}
