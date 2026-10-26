import {type KityMinderModel,type MindMapNode} from "../../../skill/mindmap-format/api.ts";
// Input and output types of the case-location pack functions. Types only: every import here is erased at run time, so the
// functions stay self-contained inside the pack (the sandbox admits only modules inside the pack).
import type { Reason, Verdict } from '../../../../contracts/generated/vocabulary.ts';
import type { BoundInput, ContextBuild, PackWarning, ProjectedItem, RunContext } from '../../../../contracts/src/pack.ts';
import type { CheckOutcome } from '../../../../contracts/src/tables.ts';


export type { BoundInput, CheckOutcome, ContextBuild, KityMinderModel, MindMapNode, PackWarning, ProjectedItem, RunContext };

/** Where the version of an answer comes from: the folder labels, the document title only, the caller's parameter, nowhere. */
export type VersionSource = 'folders' | 'title' | 'parameter' | 'none';
/** Where a build date or a patch comes from (never from a parameter). */
export type FormSource = Exclude<VersionSource, 'parameter'>;
/**
 * high: from the version level of the folders (line node, release train or a label that is only a version), consistent;
 * low: a reference version (mentioned in a folder name among other words, or only in the title), a declaration, or a version
 * level that contradicts itself; none: no version.
 */
export type Confidence = 'high' | 'low' | 'none';
/** Where a linked id was read: the document title, the folders below the version level, the mind map (case items). */
export type IdSource = 'title' | 'folders' | 'map';
/** One linked id: the kind a word next to it names (null: unmarked) and every place it was read, in reading order. */
export type LinkedId = { id: string; kind: 'story' | 'bug' | null; from: IdSource[]; spellings?: string[] };
/** An item is a whole document or one case node of it. */
export type ItemKind = 'document' | 'case';
export type Granularity = ItemKind;

/** Inclusive bounds of the ids of one kind in the defect system; a missing bound is open. */
export type IdRange = { min?: number; max?: number };
export type IdRanges = { story?: IdRange; bug?: IdRange };

/** What the caller declared for every item of the run (run parameters `product` and `line`). */
export type Declared = { product: string | null; line: string | null };

/** The inputs of the attribution scheme for one item (the item fields plus the run facts). */
export type LocateInput = {
  case_id: string;
  kind?: ItemKind;
  /** The name of the agile tree's root as the agile system pack gives it (the resource settings map root ids to names). */
  root: string | null;
  /** Folder labels below the root, top down, ending with the document's parent folder. */
  ancestors: string[];
  /** The document title (the document's label in the tree, else the mind map's root text). */
  title: string | null;
  /** Case items: texts of the mind-map nodes between the map root and the case, top down. */
  path?: string[];
  /** Case items: the case node's own text. */
  case_title?: string | null;
  /** External identity of the document (with its revision), or src:<sha256>. */
  source?: string | null;
  /** Every name of the product line the run is bound to (RunContext.names); empty when the run names no line. */
  names: string[];
  /** The id of that product line (RunContext.product). */
  product: string | null;
  declared?: Partial<Declared> | null;
  id_ranges?: IdRanges | null;
};

/** A declaration of the caller that contradicts what the tree gives. */
export type Conflict = { field: 'product' | 'line'; declared: string; tree: string };

/** The answer for one item; `data` of its check outcome. */
export type LocateAnswer = {
  case_id: string;
  product_line: string | null;
  product_name: string | null;
  version: string | null;
  /** Every version-level value with its original label and one-based depth below the root. */
  version_values: Array<{ version: string; level: number; label: string }>;
  /** Missing source facts to obtain before the location can be confirmed. */
  missing: string[];
  /** Build date, eight digits as written (build20260315). */
  build: string | null;
  patch: string | null;
  /** Version line of the NNN: line / NNN: line-train / module convention, where it holds. */
  line: string | null;
  train: string | null;
  module: string | null;
  /** Root, folders and (case items) the document title and the map path, top down. */
  ancestor_path: string[];
  version_source: VersionSource;
  confidence: Confidence;
  /** Where the build date and the patch come from; at the version level they share its confidence, else they are references. */
  build_source: FormSource;
  patch_source: FormSource;
  source: string | null;
  /** Build names written in the folders, the title or the map, verbatim, of the line's name families; not resolved. */
  build_names: string[];
  /** Ids a word marks as a requirement (story) or a defect (bug), from every place read. */
  requirements: string[];
  defects: string[];
  /** Ids no word marks (their kind is not in the tree). */
  unclassified: string[];
  /** Where each linked id was read. */
  id_sources: LinkedId[];
  /** The unclassified ids the caller's id ranges assign a kind: a declaration, apart from the tree facts. */
  ranged: { requirements: string[]; defects: string[] };
  /** Answer fields taken from the caller's product or line instead of the tree (such an answer stays unknown). */
  declared: string[];
  conflicts: Conflict[];
  /** Why something is missing, uncertain or declared, in Chinese. */
  notes: string[];
};

/**
 * How the answer is reported: a fact (support), unknown where the scheme cannot answer (missing input) or the function
 * failed (check error, a pack defect), or a declaration conflict. `brief` says why in a few words (empty for support).
 */
export type Judgment =
  | { verdict: Extract<Verdict, 'support'>; statement: string; brief: string }
  | { verdict: Extract<Verdict, 'unknown'>; reason: Extract<Reason, 'missing_input' | 'check_error'>; missing?: string; statement: string; brief: string }
  | { verdict: Extract<Verdict, 'refute'>; code: string; statement: string; brief: string };

/** A mind-map document as the projection reads it from its bound input. */
export type LocatedDocument = {
  document: string;
  sha256: string;
  source: string | null;
  root: string | null;
  ancestors: string[];
  title: string | null;
  model: KityMinderModel;
};

/** Fields of an item (ProjectedItem.fields). The run facts (names, parameters) reach the check through the subject builder. */
export type ItemFields = {
  kind: ItemKind;
  document: string;
  /** Case items: data.id of the case node (null when it has none); null for documents. */
  node: string | null;
  source: string | null;
  root: string | null;
  ancestors: string[];
  title: string | null;
  path: string[];
  case_title: string | null;
};

/** What the subject builder gives the check: the items and the run facts the scheme needs. */
export type LocateSubject = {
  items: Array<{ id: string; location: string; fields: ItemFields }>;
  context: { product: string | null; names: string[]; parameters: { [key: string]: unknown }; builds?: ContextBuild[] };
};

/** One id found in a text: the kind a marker next to it names, or null when none does. */
export type FoundId = { kind: 'story' | 'bug' | null; id: string; spellings?: string[] };
