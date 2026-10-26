// Input and output types of the traceability pack functions. Types only: every import here is erased at run time, so the
// functions stay self-contained inside the pack (the sandbox admits only modules inside the pack).
import type { BoundInput, PackWarning, ProjectedItem, RunContext } from '../../../../contracts/src/pack.ts';
import type { CheckOutcome } from '../../../../contracts/src/tables.ts';

export type { BoundInput, CheckOutcome, PackWarning, ProjectedItem, RunContext };

/** An entry of a knowledge index view, as the pack reads it. */
export type ViewEntry = {
  /** Entry digest (the member name of the view's entries record). */
  entry: string;
  kind: string;
  statement: string;
  data: Record<string, unknown>;
  /** tree:<root><path>@<entry>, citable as a ground. */
  reference: string;
};

/** The parts of index-view@1 the pack reads. */
export type IndexViewData = {
  product: string;
  build: string;
  root: string;
  kind: string;
  key: string;
  /** Raw key -> digests of the entries that carry it. */
  keys: Record<string, string[]>;
  entries: Record<string, ViewEntry>;
  total_keys: number;
  total_entries: number;
  truncated: boolean;
  /** Listed sources the producers could not use: an absent key is unknown, not proof of absence, when this is not zero. */
  skipped: number;
  notes: string[];
  /** Digests a key lists but the view carries no content for. */
  missing: number;
  /** SHA-256 of the bound view bytes. */
  digest: string;
  /** src:<sha256> of the bound view bytes, citable as a ground. */
  source: string;
};

/** One case that carries the defect, as the item fields and the claim data list it. */
export type CaseRef = {
  /** data.case of the case entry; its digest when the entry names none. */
  case: string;
  /** data.title, else the entry statement. */
  title: string;
  document: string | null;
  reference: string;
  /** The raw defect ids the case entry carries (data.defects), sorted; the check re-verifies the join against them. */
  defects: string[];
  system?: string | null;
  /** Entry digest. */
  entry: string;
};

/** One defect of the build and the cases that name it: an item's fields. */
export type MatrixRow = {
  identity?: string;
  collision_systems?: string[];
  collision_references?: string[];
  ambiguous_cases?: CaseRef[];
  /** The normalised bug id (the item id). */
  bug: string;
  declaration_status?:import('./generated/vocabulary.ts').DeclarationStatus;
  identity_declaration_status?:import('./generated/vocabulary.ts').DeclarationStatus;
  missing?:string;
  next_action?:string;
  /** The raw keys of the defect view this bug was listed under, sorted. */
  ids: string[];
  /** The selected statuses the entries carry, sorted; more than one is a conflict of the source. */
  statuses: string[];
  conflict: boolean;
  /** The defect summary: the statement of the entry with the smallest digest. */
  statement: string;
  /** Tree references of the defect entries, sorted. */
  references: string[];
  /** Digests of the defect entries, sorted (the first names the item's location in the defects view). */
  digests: string[];
  /** The cases carrying the bug, sorted by (case, document, reference). */
  cases: CaseRef[];
  /** The distinct systems the defect entries name (data.system of the producer, sorted); the current row belongs to one system.
   * Cross-system collisions are listed separately in collision_systems. Empty when unspecified. */
  systems: string[];
};

/** What the counts check needs of one bound view. */
export type ViewFacts = {
  source: string;
  skipped: number;
  truncated: boolean;
  total_keys: number;
  total_entries: number;
  listed_keys: number;
  listed_entries: number;
  missing: number;
};

/** The run-level facts the projection freezes into the run's groups (groups[0]). */
export type RunFacts = {
  product: string;
  build: string;
  root: string;
  /** The statuses the run selected (the statuses parameter, defaulted). */
  statuses: string[];
  views: { defects: ViewFacts; cases: ViewFacts };
};

/** What the subject builder gives the checks. */
export type TraceSubject = {
  items: Array<{ id: string; location: string; fields: MatrixRow }>;
  context: { product: string | null; names: string[]; parameters: Record<string, unknown>; groups: RunFacts[] };
};
