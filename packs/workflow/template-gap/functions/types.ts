import type { CommandIdentity } from '../../../../contracts/generated/shared-interfaces.ts';

import type {TestTypeId,ResourceTagDeclaration} from './generated/vocabulary.ts';
// Types of the template-gap functions. Type-only imports: they are erased at run time, so the functions stay self-contained
// inside the pack (the sandbox admits only modules inside the pack); the contract types keep the outputs in their shapes.
import type { ClassificationStatus } from '../../../../contracts/generated/vocabulary.ts';
import type { ClassifiedCase } from './classification.ts';
import type { ItemSubjectInput, PackError, PackFailure, PackWarning, ProjectedItem, ProjectionInput } from '../../../../contracts/src/pack.ts';

export type { ItemSubjectInput, PackError, PackFailure, PackWarning, ProjectedItem, ProjectionInput };

/** The canonical test types of the team template; every tag spelling maps to one of them or to null. */
export type CanonicalTag = TestTypeId;

/** One case of a document as the template matching reads it (the fields case-review projects that the template searches). */
export type CaseRecord = {
  /**
   * The identity case-review gives the case: `<document>:<data.id>` when the id occurs on one case of the document; each copy
   * of an id several cases share gets `#1`, `#2`, ... in document order; a missing or unusable id gives `@<node index>`.
   */
  id: string;
  nodeId: string | null;
  /** The case node in the document's table of visited nodes (DocumentCases.nodes); casePath gives its ancestors' texts. */
  visit: number;
  title: string;
  /** The resource entries as written (text only). */
  tags: string[];
  /** AuthoredCategoryFields.category_ids read unchanged from the original node. */
  category_ids?: unknown;

  resource?: unknown;
  resourcePresent?: boolean;
  tagDeclaration?: ResourceTagDeclaration;
  /** Texts of the children that have children of their own. */
  steps: string[];
  /** Every leaf below the case that is not a precondition, in document order. */
  expected: string[];
  /** Leaves carrying the precondition priority. */
  preconditions: string[];
};

/** Case texts a template category searches. */
export type TemplateField = 'path' | 'title' | 'steps' | 'expected' | 'preconditions';

/** What one document shows of one template category. */
export type CategoryFact = {
  id: string;
  label: string;
  group: string | null;
  /** As the template declares it; in template v3 every category is required, and one no case shows and no skip names is missing. */
  required: boolean;
  present: boolean;
  /** Cases that show the category. */
  count: number;
  /** Ids of the cases that show it: sorted, at most MAX_EVIDENCE, so the report does not depend on the order of the cases. */
  evidence: string[];
};

/** A category declared skipped with its reason (run parameter `skipped`). */
export type Skip = { category: string; reason: string; command?: CommandIdentity };

/** The fields of one document item. */
export type DocumentFields = {
  /** The document id: the id of the agile mind map, or `upload-<first 12 hex digits of its SHA-256>` for an upload. */
  document: string;
  /** The title the source system lists (meta.title), else the text of the mind-map root. */
  title: string;
  /** Labels of the folders above the document in the source system, from the top down; empty for an upload. */
  path: string[];
  caseCount: number;
  /** Untagged nodes written like cases (priority 2, children, no case below): not counted, disclosed. */
  untagged: number;
  case_rule: 'marked' | 'tagged';
  marked_only: number;
  data: { case_rule: 'marked' | 'tagged'; marked_only: number };
  /** Every category of the template, in template order. */
  categories: CategoryFact[];
  classification_status: ClassificationStatus;
  classifications: ClassifiedCase[];
  unclassified: string[];
  scope_complete: boolean;

  case_resources?: Array<{case:string;present:boolean;resource:unknown}>;
  tag_table?: ResourceTagDeclaration['table'];
  tag_undeclared_cases?: number;
  command_coverage?: CommandCoverage;
  /** Ids of the required categories (in template v3: every category) no case shows and no skip names, in template order. */
  missing: string[];
  /** The skips the run parameter `skipped` declares for this document, in template order. */
  skipped: Skip[];
};

/** Where a document item sits: its root node. The Hub core adds the source digest and forms the src: URI. */
export type ItemLocation = { parser: 'kityminder@1'; selector: string };

export type DocumentItem = { id: string; label: string; summary: string; location: ItemLocation; fields: DocumentFields };

export type ProjectionResult = { items: DocumentItem[]; groups?: Record<string, unknown>[]; warnings: PackWarning[] };
export type ProjectionOutcome = ProjectionResult | PackFailure;

/**
 * The subject the coverage check (tables/template-v3-coverage.json, coverage@1) judges for one document. The members that
 * must be covered are the table's own closed set, written from the template, not taken from the item. `covered` is absent
 * when the item has no category list, so the check is unknown (missing input), never a judgment of [].
 */
export type CoverageSubject = {
  item: string | null;
  location: string | null;
  document: string | null;
  /** Ids of the categories some case shows. */
  covered?: string[];
  skipped: Skip[];
};

/** Frozen per-case category membership, before evidence lists are capped for display. */
export type CaseCategory = { id: string; visit: number; categories: string[]; status?: ClassificationStatus };
export type CaseRevisionNodes = { texts: string[]; parents: number[] };
export type CommandFact = { command: string; identity?: CommandIdentity; unclassified?: string[]; potential_missing?: string[]; caseCount: number; categories: (CategoryFact & { references: string[] })[]; missing: string[]; skipped: Skip[]; references: string[] };
export type CommandCoverage = {
  case_rule: 'marked' | 'tagged'; rule_mismatch: boolean; bound: boolean; uploaded: boolean; documentIndexed: boolean; root: string | null; build: string | null;
  caseCount: number; matchedCases: number; unmatched: string[]; orphaned: string[]; pending_commands: string[]; pending_skips: Skip[]; commandlessCases: number;
  truncated: boolean; skippedSources: number; cutKeys: string[]; unplacedRoot: number | null; notes: string[];
  missing_identities?: string[];
  unclassified?: string[];
  pending_identities?: CommandIdentity[];
  commands: CommandFact[];
};
