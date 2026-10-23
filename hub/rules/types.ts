// Types shared by the interpreters, runCheck and the public api.ts.
import type { CheckTier, FragmentRead, ValidityStatus } from '../../contracts/generated/vocabulary.ts';
import type { CheckOutcome } from '../../contracts/src/tables.ts';
import type { CatalogView } from './catalog/view.ts';

/** A problem with a table, found when validating it (at publish time; runs reuse the result for the same content). */
export interface TableIssue {
  /** JSON Pointer into the table. */
  path: string;
  /** Chinese description for the pack author. */
  message: string;
}

export interface FragmentReadFailure {
  reason: Extract<ValidityStatus, 'credential_unreadable'>;
  missing_fact: string;
  next_action: string;
}

/** Text of the fragments bound to a run, by reference URI. The caller resolves references; interpreters only read. */
export interface SourceView {
  /** The fragment text a reference resolves to, or undefined when it is not bound to this run or not readable. */
  text(reference: string): string | undefined;
  /** Generated fragment grade: permanent scope/syntax/groundability/selector/size defects refute;
   * retain_only and unavailable preserve the missing fact and recovery step. Absent on a plain view. */
  why?(reference: string): FragmentRead;
  /** Structured registered read reason and recovery facts, independent of legacy rendering grades. */
  unread?(reference: string): FragmentReadFailure | undefined;
}

export interface CheckContext {
  run?: string;
  requirement?: string;
  /** Pack id: pack functions may only emit codes under `<pack>.`. */
  pack?: string;
  /** Closed sets the pack declares (slots.schema.json), by name, for membership@1 and coverage@1 `{ name }` sets. */
  sets?: Readonly<Record<string, readonly string[]>>;
}

export interface CheckRequest {
  /** Interpreter id, for example catalog@1. */
  interpreter: string;
  table: unknown;
  /**
   * Tier the check declaration sets, in place of the table's; outcomes on a negative case keep the table's negative tier.
   * runCheck makes sure a blocking declaration names its contract clause (C05 R[1]).
   */
  tier?: CheckTier;
  /** The JSON the check judges: an item, an item with its slots, or a list of items. */
  subject: unknown;
  catalog?: CatalogView;
  sources?: SourceView;
  context: CheckContext;
}

/** A core interpreter: a generic check driven by a versioned table kind (C03 interpreter form, C05). Deterministic and total. */
export interface Interpreter {
  readonly id: string;
  /** Codes its refutations may carry. */
  readonly codes: readonly string[];
  /** Schema problems and semantic problems; empty when the table is admissible. */
  validateTable(table: unknown): TableIssue[];
  /** Never throws: an invalid table or subject gives unknown outcomes with a reason. Always at least one outcome. */
  run(request: CheckRequest): CheckOutcome[];
}
