// Input and output types of the quality-board pack functions. Types only: every import here is erased at run time, so the
// functions stay self-contained inside the pack (the sandbox admits only modules inside the pack).
import type { BoundInput, PackWarning, ProjectedItem, RunContext } from '../../../../contracts/src/pack.ts';
import type { CheckOutcome } from '../../../../contracts/src/tables.ts';

export type { BoundInput, CheckOutcome, PackWarning, ProjectedItem, RunContext };

export type Scalar = string | number | boolean | null;

/** A row of a facet view: a distinct value combination and how many entries carry it. */
export type FacetRow = { values: Record<string, Scalar>; count: number };

/** The parts of facet-view@1 the pack reads. */
export type FacetViewData = {
  product: string;
  build: string;
  root: string;
  kind: string;
  by: string[];
  rows: FacetRow[];
  total: number;
  truncated: boolean;
  /** Listed sources the producers could not use: the counts do not cover what they would have given. */
  skipped: number;
  /** When declared, whether the document scope itself is complete. */
  scopeComplete?: boolean;
  notes: string[];
  /** src:<sha256> of the bound view bytes, citable as a ground. */
  source: string;
  /** SHA-256 of the bound view bytes. */
  digest: string;
};

/** An exact ratio: the raw counts, never rounded; the rounded forms are display only. */
export type Fraction = { num: number; den: number };

/** The counts of one (line, module) group, by the definitions of the owner's real-sample measurement. */
export type GroupCounts = { cases: number; missing: number; vague: number; negative: number; negative_denominator?: number; type_unclassified?: number };

/** One group of the board: an item's fields. */
export type TypeCoverage = { present: string[]; missing: string[]; untagged: number | null; type_undeclared?:number; invalid_source?:boolean; invalid_values?: Array<{raw:string;count:number}>; partial: boolean; source: string };

export type GroupBoard = {
  quality?: {judged:number;unjudged:number;conflicted:number;sources:string[]};
  coverage?: TypeCoverage;
  line: string | null;
  module: string | null;
  /** '<line|unplaced>/<module|unplaced>' — the item id. */
  id: string;
  counts: GroupCounts;
  ratios: { missing: Fraction; vague: Fraction; negative: Fraction };
  /** Rounded (4 decimal places) for display only. */
  display: { missing: number; vague: number | null; negative: number | null };
};

/** The effective thresholds of a run (the parameters, defaulted). */
export type Thresholds = { max_missing_ratio: number; max_vague_ratio: number; min_negative_ratio: number };

/** What the totals check needs of the bound view, frozen in the run's groups (groups[0]). */
export type RunFacts = {
  types?: boolean;
  placement?: { unplaced: number; source: string; skipped: number; truncated: boolean };
  product: string;
  build: string;
  root: string;
  view: { source: string; total: number; truncated: boolean; skipped: number; listed_rows: number };
};

/** What the subject builder gives the checks. */
export type BoardSubject = {
  items: Array<{ id: string; location: string; fields: GroupBoard }>;
  context: { product: string | null; names: string[]; parameters: Record<string, unknown>; groups: RunFacts[] };
};
