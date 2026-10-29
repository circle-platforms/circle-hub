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
  /** Whether every raw index key in scope was enumerated; null on legacy views. */
  key_space_complete: boolean | null;
  /** The Hub's source scope completeness, when present. */
  scope_complete: boolean | null;
  /** Entries omitted by the producing read, or null when that read did not declare the fact for these bytes. */
  excluded_entries: number | null;
  cut_keys: string[];
  only: string[] | null;
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
