import type {TestTypeId,ResourceTagDeclaration} from './generated/vocabulary.ts';
// Input and output types of the case-review pack functions. Type-only imports: they are erased at run time, so the
// functions stay self-contained inside the pack (the sandbox admits only modules inside the pack).
import type { JsonValue, KityMinderModel, MindMapNode } from '../../../../hub/refs/api.ts';
import type { ExternalObjectId } from '../../../../contracts/src/reference.ts';

export type { JsonValue, KityMinderModel, MindMapNode, ExternalObjectId };

/** The canonical test categories of the team template; every tag spelling maps to one of them or to null. */
export type CanonicalTag = TestTypeId;

/** A non-fatal problem. `code` is a pack code (`case-review.<name>`, declared in tables/codes.json); text is Chinese. */
export type Warning = {
  code: string;
  message: string;
  document?: string;
  item?: string;
  /** kityminder@1 selector of the node concerned. */
  node?: string;
  data?: { [key: string]: JsonValue };
};

/** A refusal: the whole call produced nothing usable. */
export type PackError = {
  code: string;
  message: string;
  fix: string;
  /** Documents the refusal is about, when it is about some of them. */
  documents?: string[];
};

export type Failure = { error: PackError; warnings: Warning[] };

// tags.ts -------------------------------------------------------------------------------------------------------------------

export type NormalizedTag = { canonical: CanonicalTag | null; raw: unknown };

export type TagsInput = { tags: unknown[] };
export type TagsOutput = { tags: NormalizedTag[]; canonical: CanonicalTag[]; negative: boolean | null; declaration: ResourceTagDeclaration } | Failure;

// project.ts ----------------------------------------------------------------------------------------------------------------

/** One parsed mind map. `model` is what the kityminder@1 parser returned for the bytes bound to `slot`. */
export type ProjectionDocument = { slot?: string; documentId: string; model: KityMinderModel };

/**
 * Which nodes are cases. `tagged` (default, the brief's rule): a node with a non-empty tag list. `marked`: also an untagged
 * node outside every case that carries the case priority, has children and holds no tagged node and no node with the case
 * priority (how the team template writes a case); such a case has no tags and an unknown negative flag.
 */
export type CaseRule = 'tagged' | 'marked';

export type ProjectionParameters = {
  caseRule?: CaseRule;
  /** Priority of the team's case marker (template v3: 2). Integer 1-9, default 2. */
  casePriority?: number;
  /** Priority of the team's group marker (template v3: 1): a tagged node with it that holds cases is a group. Default 1; null turns the rule off. */
  groupPriority?: number | null;
  /** Priority that marks a leaf inside a case as a precondition (template v3: 3); null turns the rule off. Default 3. */
  preconditionPriority?: number | null;
};

/**
 * Set by the caller, not by the run: the output limit of the sandbox call, so a too large result is a refusal with a fix.
 * Infinity (in process only) leaves the bound to a caller that returns a part of the result (the run adapter).
 */
export type ProjectionLimits = { outputBytes?: number };

export type ProjectionInput = {
  documents: ProjectionDocument[];
  parameters?: ProjectionParameters & { [key: string]: unknown };
  limits?: ProjectionLimits;
};

/** Where an item sits: parser and selector only. The Hub core adds the source digest and forms the src: URI. */
export type ItemLocation = { parser: 'kityminder@1'; selector: string };

/** A child of a case that has children of its own: an operation step and the expected results below it. */
export type CaseStep = { text: string; expected: string[] };

export type CaseFields = {
  document: string;
  /** data.id as text, or null when the node has none. */
  nodeId: string | null;
  /** Texts of the ancestors, from the root (the document title) down to the parent. */
  path: string[];
  /** The case text: the operation (or, with steps, the case name). */
  title: string;
  /** As written: a number when the node has one, a string if written as text, null when missing. */
  priority: number | string | null;
  degree: number | null;
  /** The resource entries as written (text only); empty for a case found by the case marker (caseRule marked). */
  tags: string[];
  resource?: unknown;
  resourcePresent?: boolean;
  tagDeclaration?: ResourceTagDeclaration;
  /** Canonical categories of the tags, in canonical order, without repetition. */
  tagsNormalized: CanonicalTag[];
  /** Expected results in document order: leaf children, and the leaves below each step. */
  expected: string[];
  /** Number of expected results, also when `expected` is clipped. */
  expectedCount: number;
  expectedSelectors?: string[];
  steps: CaseStep[];
  /** Leaves inside the case marked with the precondition priority. */
  preconditions: string[];
  autoid: string | null;
  /** autoid present or auto written as YES. */
  automated: boolean;
  /** Has the canonical tag Negative; null when the case has no non-blank tag, so whether it is negative is unknown. */
  negative: boolean | null;
  hasNote: boolean;
  /** Sits below another case. */
  nested: boolean;
  case_rule?: 'marked' | 'tagged';
  marked_only?: number;
};

export type CaseItem = { id: string; label: string; location: ItemLocation; fields: CaseFields };

/** A node with a priority outside every case that is not a case, or a tagged group node holding cases. Not an item. */
export type GroupEntry = {
  id: string;
  label: string;
  location: ItemLocation;
  document: string;
  priority: number | string | null;
  /** Cases in its subtree. */
  cases: number;
};

/**
 * `unnumbered`: ids of the items whose identity is a pack identity (W01 R[2]: duplicated, missing or unusable data.id).
 * The Hub does not carry these across revisions; every other item id is `<documentId>:<data.id>` of one case node.
 */
export type ProjectionResult = { items: CaseItem[]; groups: GroupEntry[]; unnumbered: string[]; warnings: Warning[] };
export type ProjectionOutput = ProjectionResult | Failure;

// subject.ts ----------------------------------------------------------------------------------------------------------------

/** A category tag spelled unlike its category usually is in the document: the tag as written, the usual spelling, the category. */
export type TagVariant = { tag: string; usual: string; category: CanonicalTag };

/** An item as the Hub holds it: like a CaseItem, with `location` already a reference URI. */
export type ItemLike = { id: string; label?: string; location?: unknown; fields: Partial<CaseFields> & { [key: string]: unknown } };

/** One case as the structure@1 tables and the tag check judge it (tables/structure.json and checks.ts tagSpelling judge the list `subjects`). */
export type StructureSubject = {
  kind: 'case';
  id: string;
  /** The item's reference URI when it has one, else null. */
  location: string | null;
  document: string;
  nodeId: string | null;
  /** Grouping key for duplicate cases: the document and the normalized path, as JSON text. */
  group: string;
  path: string[];
  title: string;
  /** Code points of the trimmed title. */
  titleLength: number;
  /** Steps, expected results and preconditions in the matching form, as JSON text: with the title, the duplicate key. */
  content: string;
  priority: JsonValue;
  tags: string[];
  resource?: unknown;
  resourcePresent?: boolean;
  tagDeclaration?: ResourceTagDeclaration;
  /** Tags that are not blank. */
  tagCount: number;
  categories: CanonicalTag[];
  /** Raw spellings of the tags that map to a category. */
  categoryTags: string[];
  /** Category tags written differently from the usual spelling of their category in the same document. */
  tagVariants: TagVariant[];
  /** Tags that map to no category (release-specific tags and the like). */
  otherTags: string[];
  expected: string[];
  expectedCount: number;
  expectedSelectors?: string[];
  /** null when the case has no non-blank tag. */
  negative: boolean | null;
};

/** One case as the catalog@1 tables judge it. `commands` are the phrases the product pack extracted. */
export type CatalogSubject = { kind: 'case'; id: string; location: string | null; negative: boolean | null; commands: string[] };

export type SubjectParameters = {
  /** Scan the case texts for command phrases (tables/catalog.json, advisory). Default false: the scan is off. */
  scanCaseCommands?: boolean;
};

export type SubjectInput = { items: unknown[]; commands?: { [item: string]: unknown }; parameters?: SubjectParameters & { [key: string]: unknown } };
export type SubjectOutput = { subjects: StructureSubject[]; catalog: CatalogSubject[]; warnings: Warning[] } | Failure;

// expected-sources.ts -------------------------------------------------------------------------------------------------------

export type IdKind = 'story' | 'bug';

export type FoundId = {
  /** The kind a marker next to the number names, or null when nothing does (an unmarked number, or one after "bug to case" or "PLM"). */
  kind: IdKind | null;
  id: string;
  /** The word that named the kind as written ("bug", "缺陷", "需求", "story"), or null. */
  marker: string | null;
  /** The matched text. */
  text: string;
};

export type SourcesDocument = {
  slot?: string;
  documentId: string;
  model?: KityMinderModel;
  /** Document title as the source system lists it; defaults to the text of the mind-map root. */
  title?: string;
  /** Labels of the folders above the document in the source system, from the top down. */
  ancestors?: string[];
};

/** Inclusive bounds of the ids of one kind; a missing bound is open. */
export type IdRange = { min?: number; max?: number };

export type SourcesParameters = {
  /** Explicit story ids; given with `bugs` or alone, they replace the ids found in titles. */
  stories?: Array<string | number>;
  bugs?: Array<string | number>;
  /** Id ranges of the defect system (from the product pack): an unmarked id in the range of one kind only takes that kind. A kind without a range covers every id. */
  idRanges?: { story?: IdRange; bug?: IdRange };
  /** How an unmarked id that the ranges do not decide is read: as both kinds (default), as a story, as a bug, or not at all. */
  bareIds?: 'both' | IdKind | 'skip';
  /** Add the manual search for the feature words of the title (default true). */
  specSearch?: boolean;
  /** Most search terms (default 8, at most 16). */
  maxTerms?: number;
};

export type SourcesInput = {
  documents: SourcesDocument[];
  /** The product binding: every name of the product line; names are left out of search terms. */
  product?: { names?: string[] } | null;
  parameters?: SourcesParameters & { [key: string]: unknown };
};

export type SourceBasis = {
  external: ExternalObjectId;
  document: string | null;
  from: 'title' | 'root' | 'ancestor' | 'parameter';
  /** The text the id or the terms were read from (clipped). */
  text: string;
  marker: string | null;
  /** Why this source was bound, in Chinese. */
  reason: string;
};

export type SourcesOutput = { external: ExternalObjectId[]; basis: SourceBasis[]; warnings: Warning[] } | Failure;

// template-coverage.ts ------------------------------------------------------------------------------------------------------

export type Template = import('./template-coverage.ts').Template;

export type CoverageSkip = { category: string; reason: string };

export type CoverageInput = { items: unknown[]; template: unknown; skipped?: unknown[] };

export type CategoryFact = {
  id: string;
  label: string;
  group: string | null;
  required: boolean;
  present: boolean;
  /** Items that show the category. */
  count: number;
  /** Ids of the first items that show it. */
  evidence: string[];
};

/** Cross-item facts; tables/template-v3-coverage.json (coverage@1) judges `required`, `covered` and `skipped`. */
export type CoverageFacts = {
  template: string;
  required: string[];
  covered: string[];
  missing: string[];
  skipped: CoverageSkip[];
  categories: CategoryFact[];
  warnings: Warning[];
};

export type CoverageOutput = import('./template-coverage.ts').CoverageOutput | Failure;
