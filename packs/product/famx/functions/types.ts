import type { Applicability as SourceApplicability, FragmentRef as SourceFragmentRef } from '../../../../contracts/src/product.ts';
// Input and output shapes of the FAMX/FAMY product pack functions. Types only: every import here is erased at run time,
// so the functions stay pure modules inside the pack.
import type { HtmlModel, MarkdownModel, XmlModel } from '../../../../hub/refs/api.ts';
import type { CatalogSignature } from '../../../../contracts/src/tables.ts';
import type { EntryKind, ProvenanceType } from '../../../../contracts/generated/vocabulary.ts';
import type { CommandCatalog } from './cases-commands.ts';

export type { EntryKind, HtmlModel, MarkdownModel, XmlModel };

/** Name family of a build or listing page. FAMX and FAMY name one product line; anything else is `other`. */
export type Family = 'FAMX' | 'FAMY' | 'other';

// listing.ts ------------------------------------------------------------------------------------------------------------

export type FileRef = { name: string; href: string };
/** The image link; its text gives the size and a digest (SHA-256 on newer entries, MD5 on older ones). */
export type ImageRef = FileRef & { size?: string; sha256?: string; md5?: string };

export type BuildFiles = {
  /** The installable image; null when the entry links none. */
  image: ImageRef | null;
  mib?: FileRef;
  commandTree?: FileRef;
  bugsFixed?: FileRef;
  /** Further links of the entry that are none of the above (a second MIB, for example). */
  other?: FileRef[];
};

export type Build = {
  name: string;
  family: Family;
  /** null for the main platform, else a token such as sy-k, sy-u, sz-demoos10, zx-demoos11. */
  platform: string | null;
  /** Version line from the name, for example 10.6.1; null when the name carries none. */
  line: string | null;
  /** Build number after the line, dotted when it has several parts: 57, 3.1.9. */
  number: string | null;
  /** Build time as listed, ISO 8601 without a zone (the page states none): 2024-06-26T12:06:23. */
  built: string | null;
  /** A determined listing failure; never interpreted as a successful build with an unknown timestamp. */
  failure?: string;
  built_raw?: string;
  /** Release date, ISO 8601: 2024-06-27, or 2024-06 when the page gives only the month; null when not released. */
  released: string | null;
  /** The build this one is based on (FAMY-named builds of the older lines name their base FAMX build). */
  basedOn: string | null;
  files: BuildFiles;
  /** Text around the core name, written with * for the core: BrandOS-*.click, *.patch.p1. */
  variant?: string;
  /** Remaining text of the entry line that is neither the release nor the base. */
  note?: string;
};

export type ListingContext = {
  /** Platform of the listing page (from planSync); used for builds whose names carry no platform token. */
  platform?: string | null;
};

/** Default export input: the model itself, or the model with the page context. */
export type ListingInput = HtmlModel | { model: HtmlModel; context?: ListingContext };
export type ListingResult = {
  builds: Build[];
  /** True when the page has no build entry but links other pages: it is a hub page; give it to planSync in `hubs`. */
  hub: boolean;
  warnings: string[];
};

// select-build.ts -------------------------------------------------------------------------------------------------------

export type SelectBuildInput = {
  candidates: Build[];
  /** Version line of the run, for example 10.6.1 (10.6 and 10.6.0 name the same line). */
  line: string;
  /** Build name given by the caller; it wins over the rule (either family). */
  declared?: string;
  /** Platforms besides the main platform that the rule may choose from. */
  includePlatforms?: string[];
};

/** How the build was fixed: declared by the caller, or projected by the pack rule (A01 provenance types). */
export type SelectionBasis = Extract<ProvenanceType, 'declared' | 'projected'>;

export type SelectBuildResult = {
  build: Build | null;
  /**
   * The build whose knowledge root the run locks: the build itself for FAMX names and for FAMY names with their own command
   * tree (the newest lines); for an FAMY name without a tree the build its "based on" chain ends in. Null when unknown.
   */
  base: Build | null;
  basis: SelectionBasis;
  /** Other builds the rule found qualifying, best first; the runner may choose one of them instead. */
  alternatives: Build[];
  notes: string[];
};

// sync-plan.ts ----------------------------------------------------------------------------------------------------------

export type PageKind = 'mainline' | 'platform' | 'customer' | 'patch';

export type ListingPage = {
  /** Page name without the extension, as written: rel_famx_10_6_4. */
  page: string;
  /** The link exactly as written on the linking page; the caller resolves it against that page's URL. */
  href: string;
  /** The hub page that links it; null when the index page links it. */
  from: string | null;
  family: Family;
  line: string | null;
  platform: string | null;
  kind: PageKind;
};

/** A hub page linked from the index (famx_10_7, famx_10_6_4, famx_trunk ...): it links the listing pages of a line. */
export type HubPage = {
  page: string;
  /** The link exactly as written on the index page; the caller resolves it against the index URL. */
  href: string;
  family: Family;
  /** Version line from the name; null for hub pages without one (famx_trunk). */
  line: string | null;
};

export type PlanSyncOptions = {
  /** Additional literal tokens of mainline pages; empty in synthetic defaults. */
  mainline_page_words?: string[];
  /** Glob patterns (* and ?) over page names that opt a listing page in whatever its kind, for example rel_famx_*_sy_k. */
  include?: string[];
  /** Glob patterns over page names that opt a listing or hub page out; they win over include. */
  exclude?: string[];
};

/** A hub page the caller read: the page name planSync returned in `hubs` and its html@1 model, or null when unreadable (404). */
export type ReadHub = { page: string; href?: string; model: HtmlModel | null };

export type PlanSyncInput = {
  /** The build-site index page; several models when the site has more than one index. */
  index: HtmlModel | HtmlModel[];
  /** The hub pages read after the first call (the walk is index -> hub pages -> listing pages, depth 2). */
  hubs?: ReadHub[];
  options?: PlanSyncOptions;
};

export type PlanSyncResult = {
  /** Listing pages to read, from the index and from the hub pages given. */
  pages: ListingPage[];
  /** Hub pages linked from the index that have not been given in `hubs` yet: read them and call planSync again. */
  hubs: HubPage[];
  skipped: Array<{ page: string; href: string | null; reason: string }>;
  warnings: string[];
};

export type SyncBuildsInput = {
  /** Builds parsed from every selected listing page, both families. */
  builds: Build[];
  /** Base build names that already have a knowledge root; objects with a `build` name are accepted too. */
  existingRoots: Array<string | { build: string }>;
};

/**
 * An FAMY-named build without a command tree of its own, recorded as an alias of its base build (section 8 of the brief);
 * `released` is null for an unreleased alias.
 */
export type Alias = { alias: string; base: string; released: string | null; platform: string | null };

export type SyncBuildsResult = {
  /**
   * Base builds to produce a root for: released (or the base of a released alias), with a command tree, not yet in the
   * knowledge base. FAMY builds with their own tree are their own base.
   */
  produce: Build[];
  /** Every alias resolved from the listings, released or not, including those whose base root already exists. */
  aliases: Alias[];
  /** Released builds that are not produced, by name, with the reason. */
  skipped: Array<{ name: string; reason: string }>;
  /** Builds left out because they are not released and no released alias needs them. */
  unreleased: number;
  warnings: string[];
};

// Producers (command-tree.ts, manual.ts, release-notes.ts) -----------------------------------------------------------

// Entry kinds (EntryKind, imported above) are the entry_kind axis of the generated vocabulary, the producer-declared values of
// K02 R[3]. The genre of the source (command tree, manual, release note) is not a kind (K01 R[0]); the finer form is in
// `data` (form, status).

/** Where the content of an entry comes from: a fragment of the parsed source (parser@version and its selector). */
export type FragmentRef = Pick<SourceFragmentRef,'parser'|'selector'|'range'|'applicability'>;

/** Applicability conditions the producer read from the source structure; null on an entry means "未声明" (K02 F[6]). */
export type Applicability = SourceApplicability;

export type ProducedEntry = {
  kind: EntryKind;
  /** Canonical tree path (/commands/show/slb), or null when code cannot place the entry (it goes to the typed-judgment model). */
  path: string | null;
  /** Deterministic canonical statement of the entry's content; `data` holds the same content in machine-readable form. */
  statement: string;
  data: { [key: string]: unknown };
  /** Source fragments in order; for a command entry one per overload (signature id k or k.j names fragments[k-1]). */
  fragments: FragmentRef[];
  applicability: Applicability | null;
};

/** Where a produced signature and each of its parameters came from in the source document: the XML selector of the
 * argument list and, per parameter, its native type name and its own selector. This is the pack's own provenance and it
 * never crosses a declared contract: it is not a key of `data` (which is exactly catalog-entry@1, strict) and not a key
 * of a produced entry (which is exactly producer-output@1, strict). It travels in the pack's own result, keyed by the
 * entry path, and only the pack's command grammar consumes it. */
export type SignatureDeclarations = Record<string, { selector: string; parameters: Array<{ name: string; selector: string; native?: boolean }> }>;

/** Provenance of every produced command entry, keyed by its tree path. */
export type DeclarationsByPath = Record<string, SignatureDeclarations>;

/** Data of a command entry: the catalog-entry@1 fields except the tree reference, which the knowledge package adds. */
export type CommandEntryData = { words: string[]; signatures: CatalogSignature[]; summary?: string };

/**
 * A declared argument type authorized by the versioned famx-command-argument-types@1 schema: argument `position` (1-based) of the
 * command `command` (its words joined by spaces) may declare a tree `type` (a key of ARGUMENT_TYPES), an explicit
 * `address_role`, or both. `origin` says where the declaration comes from; a row without one is ignored.
 */
export type ArgumentTypeDeclaration = { schema?:'famx-command-argument-types@1'; command: string; position: number; type?: string; address_role?:string; origin: string };

export type CommandTreeParams = {
  /** Tree path the commands go under; default /commands. */
  path?: string;
  /** Declared argument types; they require the exact schema/origin identity; help text never supplies types. */
  argumentTypes?: ArgumentTypeDeclaration[];
};

export type CommandTreeInput = XmlModel | { model: XmlModel; params?: CommandTreeParams };
export type CommandTreeResult = { entries: ProducedEntry[]; /** Pack-internal provenance beside the contract-shaped entries; never part of an entry. */ declarations?: DeclarationsByPath; warnings: string[]; diagnostics?:import('../../../../contracts/src/product.ts').ProducerDiagnostic[]; grammar?:import('../../../../contracts/src/product.ts').ProducerOutput['grammar'] };

/** The manual command catalog JSON (schema ist.manual-command-catalog). */
export type ManualCatalog = {
  schema: string;
  identity?: { [key: string]: unknown };
  signatures: Array<{
    head_tokens: string[];
    head_variants?: string[][];
    ordered_tokens?: Array<{ kind: string; text?: string; name?: string }>;
    params: Array<{ name: string; required: boolean }>;
    signature_verbatim: string;
    src?: string;
  }>;
  value_domains?: Array<{ desc: string; enums?: string[]; head: string; param: string; src?: string }>;
  worked_examples?: Array<{ lines: string[]; src?: string }>;
};

export type ManualInput = MarkdownModel | ManualCatalog | { model: MarkdownModel | ManualCatalog; heads?: string[]; name?: string; params?: {models?:string[];platforms?:string[];components?:string[];licenses?:string[];deployment_forms?:string[]} };

/**
 * Options of the markdown manual producer: `name` is the manual's segment under the manual namespace (the slot name:
 * cli or app); `catalog` is the build's command catalog (cases-commands `commandCatalog` of the command tree) — with it,
 * signatures and command-table rows hang at /commands only at nodes the tree has, and the warnings list the literals the
 * tree cannot resolve as drift candidates. What an entry's digest covers never depends on the tree; placement does
 * (K01 R[1]: builds whose trees place the manual's signatures the same way share its subtree).
 */
export type ManualOptions = {
  known_builds?:readonly string[];
  /** Deployment closed sets. Omission is the empty set used only by direct examples. */
  models?: readonly string[];
  platforms?: readonly string[];
  components?: readonly string[];
  licenses?: readonly string[];
  deployment_forms?: readonly string[];
  name?: string;
  catalog?: CommandCatalog | null;
  /** A production whose tree slot is unusable: signatures stay at their section nodes (no synthetic paths). */
  noTree?: boolean;
  /** The fragment parser key of the input model (K1 item: only a document model with section paths is depended on;
   * the adoc producer passes its own key, default markdown@1 — the placement code needs no change then). */
  fragmentParser?: string;
  /** The section-selector scheme of the input model ('h/' path selectors by default; text@1 uses l/<a>-<b>). */
  sectionSelector?: (path: readonly string[]) => string;
};

/**
 * A span the code could not place; it stays citable by its selector and goes to the typed-judgment model later. `kind` is
 * the entry kind it will have once placed (the knowledge package files it with that kind).
 */
export type Unplaced = { fragment: FragmentRef; section: string; kind: EntryKind; text: string };

export interface ApplicabilityDifference {field:import('./generated/vocabulary.ts').ApplicabilityField;section:string[];values:Applicability[];fragments:FragmentRef[]}
export interface ManualApplicabilityReport {counts:Record<import('./generated/vocabulary.ts').ApplicabilityField,{direct:number;inherited:number}>;overrides:ApplicabilityDifference[];conflicts:ApplicabilityDifference[]}
export type ManualResult = { entries: ProducedEntry[]; unplaced: Unplaced[]; warnings: string[]; applicability_report?:ManualApplicabilityReport };

export type ReleaseInput = MarkdownModel | { model: MarkdownModel };

export type ReleaseResult = {
  complete?:boolean;
  product: Family | null;
  version: string | null;
  build: string | null;
  /** Release date, ISO 8601. */
  released: string | null;
  entries: ProducedEntry[];
  warnings: string[];
};

// commands.ts, locate.ts, ids.ts -------------------------------------------------------------------------------------

export type CommandsInput = {
  text: string;
  /** Complete locked definitions are required; heads alone are insufficient evidence. */
  definitions:import('./commands.ts').CommandDefinition[];
  heads?: string[];
};

/** A command phrase: text.slice(start, end) exactly, offsets in UTF-16 code units, end exclusive. */
export type Phrase = { text: string; start: number; end: number };
export type CommandsResult = { phrases: Phrase[]; warnings: string[] };

export type LocateInput = string[] | { labels: string[] };
export type LocateResult = { line: string | null; train: string | null; module: string | null; notes: string[] };

export type IdsInput = string | { title: string };
/** Ids in title order, decimal digits. `unclassified`: ids the title does not mark as story, bug or PLM (a leading 7401-..., 回归 - 161090). */
export type IdsResult = { stories: string[]; bugs: string[]; plm: string[]; unclassified: string[]; warnings: string[] };
