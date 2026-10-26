import {CompositionBasisSchema} from '../generated/vocabulary.ts';
import {ApplicabilityFieldSchema} from '../generated/vocabulary.ts';
import { VariableUse } from './variables.ts';
// Shapes owned by the knowledge work package (K01-K05): the records of the content-addressed knowledge tree, its builds,
// current-root moves, calibration sets and the two layers beside the tree. Register every record or pack-file schema in
// `schemas`; contracts/src/index.ts merges them into SCHEMA_REGISTRY, which tools/gen-contracts.ts turns into
// contracts/generated/schemas/*.json. Keys are `name@major`.
//
// Record layout (hub/knowledge/README.md): nodes and entries are `tree_node` records (tree content, never a ground on their
// own, B01 R[5]), compositions are `tree_root` records (a large one with `tree_root` part records beside it), current-root
// moves are `root_pointer` records, builds, calibration sets, observations and contributions are `claim` records with the
// schemas below. Digests of nodes and entries cover the normalised content only (K01 R[7], K02 R[4]); see nodeDigest and
// entryDigest in hub/knowledge.
import { KNOWLEDGE_CONTRIBUTION_SCHEMA, KnowledgeContributionBody } from './contributions.ts';
import { z } from 'zod';
import { ENTRY_KIND,type EntryKind,EntryKindSchema, NodeLevelSchema, ProvenanceTypeSchema, ReadTierSchema, type NodeLevel } from '../generated/vocabulary.ts';
import { IsoTime, PackId, PackVersion, Sha256, UserId, Versioned } from './common.ts';
import { CommandPolicy, Applicability, ApplicabilityOrigin, BuildInfo, CatalogDeclaration, LinkDeclaration, MAX_LIST_SOURCES, PackFunctionRef, ProductId } from './product.ts';
import { ExternalObjectId, TreePath, referenceUriOf } from './reference.ts';

// ---------------------------------------------------------------- levels and bases

/**
 * Level of a node of this height (K01 R[2], axis node_level: 干、枝 by height counted from the bottom, 叶 from the source's
 * own structure): height 0 is a leaf, height 1 a branch, anything higher a trunk.
 */
export function levelOfHeight(height: number): NodeLevel {
  if (!Number.isSafeInteger(height) || height < 0) throw new RangeError('height is a non-negative integer');
  return height === 0 ? 'leaf' : height === 1 ? 'branch' : 'trunk';
}

/**
 * Basis of a source in a version's composition (K01 R[5], R[7]): the product release record (the build's own files on the
 * build site of a released build), a device echo, or a declaration (a source the product pack maps to the version, or a
 * build that has no release record). Named by the model, no vocabulary axis yet (README, Needs).
 */
export {COMPOSITION_BASIS as COMPOSITION_BASES,CompositionBasisSchema} from '../generated/vocabulary.ts';
export type {CompositionBasis} from '../generated/vocabulary.ts';

const SrcReferenceUri = referenceUriOf('src');
const sortedUnique = (values: readonly string[]): boolean => values.every((v, i) => i === 0 || values[i - 1] < v);

// ---------------------------------------------------------------- builds as recorded

/**
 * A list role of a build (product@1 ProducerSource many) kept by reference, so that no record grows with a list: the ids as
 * listed, as their canonical JSON array, are the object with this digest.
 */
export const ListReference = z.strictObject({
  list: Sha256.describe('SHA-256 of the canonical JSON array of the listed external ids, as listed: the object that holds them'),
  count: z.number().int().nonnegative().max(MAX_LIST_SOURCES).describe('ids listed, repeats included'),
});
export type ListReference = z.infer<typeof ListReference>;

/** BuildInfo as a production records it (tree_root@1, the generate action): single roles by external id, list roles by reference. */
export const RecordedBuild = BuildInfo.extend({
  sources: z.record(z.string(), z.union([ExternalObjectId, ListReference])).describe('external objects by role; a role that holds a list is kept by reference'),
});
export type RecordedBuild = z.infer<typeof RecordedBuild>;

/** Ids of the producers of the product pack (product@1 Producer.id) that gave an entry, sorted and unique. */
const ProducerIds = z
  .array(z.string().regex(/^[a-z][a-z0-9_-]*$/))
  .min(1)
  .refine(sortedUnique, 'producer ids are sorted and unique')
  .describe('the producers of the product pack that gave the entry, sorted; a catalog limited to one producer takes only its entries');

// ---------------------------------------------------------------- tree content (kind tree_node)

export const TreeNodeChild = z.strictObject({ name: z.string().min(1), digest: Sha256 });
export type TreeNodeChild = z.infer<typeof TreeNodeChild>;

/**
 * One node (tree_node@1). Its digest is the SHA-256 of the RFC 8785 canonical JSON of {name, children, entries}: the name,
 * the children's names and digests and the entry digests, never a source digest (K01 R[1], R[7]). Height and level are
 * derived from the children and kept for display.
 */
export const TreeNodeBody = z
  .strictObject({
    name: z.string().describe('the decoded path segment of the node in its parent; empty for the root'),
    height: z.number().int().nonnegative().describe('0 for a node without children, else 1 + the largest height of its children'),
    level: NodeLevelSchema,
    children: z.array(TreeNodeChild).describe('sorted by name (UTF-16 code units), names unique'),
    entries: z.array(Sha256).describe('digests of the entries hung on this node, sorted, unique'),
  })
  .superRefine((n, ctx) => {
    if (!sortedUnique(n.children.map((c) => c.name))) ctx.addIssue({ code: 'custom', path: ['children'], message: 'children are sorted by name and unique' });
    if (!sortedUnique(n.entries)) ctx.addIssue({ code: 'custom', path: ['entries'], message: 'entry digests are sorted and unique' });
    if ((n.height === 0) !== (n.children.length === 0)) ctx.addIssue({ code: 'custom', path: ['height'], message: 'height 0 exactly for a node without children' });
    if (n.level !== levelOfHeight(n.height)) ctx.addIssue({ code: 'custom', path: ['level'], message: 'level follows the height' });
  });
export type TreeNodeBody = z.infer<typeof TreeNodeBody>;

/**
 * One knowledge entry (knowledge-entry@1, K02): a statement a producer derived from source fragments. Its digest covers
 * {kind, statement, data, applicability} only (K02 R[4]); the source fragments live in the composition of each root. The
 * record names the product it was produced for, so that readers are checked against that product.
 */
export const KnowledgeEntryBody = z.strictObject({
  product: ProductId,
  kind: EntryKindSchema.describe('declared by the producer (K02 F[0], R[3])'),
  statement: z.string().describe('normalised canonical statement'),
  data: z.record(z.string(), z.unknown()),
  applicability: Applicability.nullable().describe('null: 未声明 (K02 F[6])'),
});
export type KnowledgeEntryBody = z.infer<typeof KnowledgeEntryBody>;

// ---------------------------------------------------------------- compositions (kind tree_root)

/** How the typed-judgment model placed an entry (K04 R[5]); placement only decides the position, never the content. */
export const ModelPlacement = z.strictObject({
  model: z.string().min(1).describe('exact model version'),
  p: z.number().min(0).max(1).describe('probability of the last choice that descended'),
  threshold: z.number().min(0).max(1).describe('the calibrated threshold of the chain'),
  judgments: z.array(Sha256).describe('classify action records, root first'),
  note: z.string().describe('归类判断：Jev@<exact version>，p=…，只影响位置'),
});
export type ModelPlacement = z.infer<typeof ModelPlacement>;

/** One row of a version's composition (K01 R[7]): which source fragments provide an entry at a path, on which basis. */
export const ApplicabilitySource=ApplicabilityOrigin.extend({fragment:SrcReferenceUri});
export type ApplicabilitySource=z.infer<typeof ApplicabilitySource>;

export const CompositionRow = z.strictObject({
  path: TreePath,
  entry: Sha256,
  kind: EntryKindSchema,
  producers: ProducerIds,
  fragments: z.array(SrcReferenceUri).min(1).describe('canonical src references in the order the producers gave them'),
  applicability_sources:z.array(ApplicabilitySource).optional(),
  basis: CompositionBasisSchema,
  decided_by: z.string().min(1).describe('who decided the source belongs to the version: the product pack id@version'),
  placement: ModelPlacement.optional().describe('present when the typed-judgment model chose the position'),
});
export type CompositionRow = z.infer<typeof CompositionRow>;

/** A span no rule and no calibrated judgment could place: stored and citable, not hung on the tree (K01 R[4], K04 R[3]). */
export const UnplacedRow = z.strictObject({
  entry: Sha256,
  kind: EntryKindSchema,
  producers: ProducerIds,
  section: z.string(),
  fragments: z.array(SrcReferenceUri).min(1).describe('every source piece with this content, in the order the producers gave them'),
  applicability_sources:z.array(ApplicabilitySource).optional(),
  basis: CompositionBasisSchema,
  decided_by: z.string().min(1),
  stopped_at: TreePath.describe('the node where placement stopped (/ when it never descended)'),
  candidate: z
    .strictObject({
      path: TreePath,
      model: z.string().nullable(),
      p: z.number().min(0).max(1),
      calibrated: z.boolean().describe('false: the chain has no calibrated threshold, the answer is only a candidate'),
    })
    .nullable()
    .describe("the model's answer kept as a candidate, when it named a child"),
  judgments: z.array(Sha256),
  note: z.string().describe('why it stopped, in Chinese'),
});
export type UnplacedRow = z.infer<typeof UnplacedRow>;

/** A source read for the root, with what decided its basis. */
export const RootSource = z.strictObject({
  producer: z.string().min(1),
  slot: z.string().min(1),
  external: ExternalObjectId,
  revision: z.string().nullable(),
  sha256: Sha256,
  size: z.number().int().nonnegative(),
  media_type: z.string().min(1),
  parser: Versioned,
  artifact: Sha256.describe('digest of the source_artifact record that decided the read'),
  read_tier: ReadTierSchema,
  basis: CompositionBasisSchema,
  decided_by: z.string().min(1),
});
export type RootSource = z.infer<typeof RootSource>;

/** An entry refused before it reached the tree (K02 R[0]): its fragment does not resolve, or its path is malformed. */
export const RefusedEntry = z.strictObject({
  producer: z.string().min(1),
  index: z.number().int().nonnegative(),
  unplaced: z.boolean().describe('the refused item was an unplaced span rather than an entry'),
  kind: z.string().max(200).describe('the kind the producer declared, as given (cut to 200 characters; may be empty or outside entry_kind)'),
  path: z.string().nullable(),
  reason: z.string(),
});
export type RefusedEntry = z.infer<typeof RefusedEntry>;

/** A catalog of the root as declared by the product pack; `complete` is withdrawn when an entry of its kind was lost. */
export const RootCatalog = CatalogDeclaration.extend({
  declared_complete: z.boolean(),
  members: z.number().int().nonnegative(),
  incomplete_reason: z.string().nullable(),
});
export type RootCatalog = z.infer<typeof RootCatalog>;

/** Most refusals and warnings kept in one composition record; the counts say how many there were. */
export const MAX_KEPT_PROBLEMS = 200;

/**
 * A listed source (an element of a list slot, product@1 ProducerSource many) the production could not use: it could not be
 * read, checked, parsed or stored, or the producer failed on it alone. It does not stop the production (README decision 16).
 */
export const SkippedSource = z.strictObject({
  producer: z.string().min(1),
  slot: z.string().min(1),
  external: ExternalObjectId,
  reason: z.string(),
});
export type SkippedSource = z.infer<typeof SkippedSource>;

/**
 * A composition row with the content of its entry (tree_root-rows@1 parts): the bulk form views and catalogs read a large
 * root in, instead of one entry record at a time. The content repeats the entry record; the entry digest covers it.
 */
export const CompositionContentRow = CompositionRow.extend({
  statement: z.string(),
  data: z.record(z.string(), z.unknown()),
  applicability: Applicability.nullable(),
});
export type CompositionContentRow = z.infer<typeof CompositionContentRow>;

/** One part record of a large composition: its row count and the sort keys of its first and last row. */
export const CompositionPartRef = z.strictObject({
  record: Sha256.describe('digest of the part record'),
  rows: z.number().int().min(1),
  first: z.string().describe('sort key of the first row: the path (composition rows), the entry digest (unplaced rows) or the source digest (sources)'),
  last: z.string().describe('sort key of the last row'),
});
export type CompositionPartRef = z.infer<typeof CompositionPartRef>;

/** A part of composition rows, all of one entry kind (so that a scan by kind reads its own parts only). */
export const CompositionRowsPartRef = CompositionPartRef.extend({ kind: EntryKindSchema.describe('the kind of every row of the part') });
export type CompositionRowsPartRef = z.infer<typeof CompositionRowsPartRef>;

/**
 * Parts of a large composition. Composition rows are grouped by kind (kinds in code-unit order), each group sorted by path
 * then entry; unplaced rows are sorted by entry, sources by digest then external id.
 */
export const CompositionParts = z.strictObject({
  composition: z.array(CompositionRowsPartRef).describe('tree_root-rows@1 records'),
  unplaced: z.array(CompositionPartRef).describe('tree_root-unplaced@1 records'),
  sources: z.array(CompositionPartRef).describe('tree_root-sources@1 records: the sources of list slots'),
});
export type CompositionParts = z.infer<typeof CompositionParts>;

/** Rows of a large composition (tree_root-rows@1), of one kind, sorted by path then entry. Parts are content-addressed and shared between roots. */
export const TreeRootRowsPart = z.strictObject({ rows: z.array(CompositionContentRow).min(1) });
export type TreeRootRowsPart = z.infer<typeof TreeRootRowsPart>;

/** Unplaced rows of a large composition (tree_root-unplaced@1), sorted by entry. */
export const TreeRootUnplacedPart = z.strictObject({ rows: z.array(UnplacedRow).min(1) });
export type TreeRootUnplacedPart = z.infer<typeof TreeRootUnplacedPart>;

/** Sources of the list slots of a large composition (tree_root-sources@1), sorted by digest then external id. */
export const TreeRootSourcesPart = z.strictObject({ rows: z.array(RootSource).min(1) });
export type TreeRootSourcesPart = z.infer<typeof TreeRootSourcesPart>;

/**
 * The composition record of one produced root (tree_root@1, K01 R[5]-R[7]): product line, version identity, root digest,
 * the producing product pack, every source with its basis and decider, and per entry the fragments that provide it.
 */
// R5 adds counts for new kinds without making immutable pre-R5 compositions unreadable.
type AddedKind=Extract<EntryKind,'procedure'|'pitfall'>;
const count=z.number().int().nonnegative();
const kindCounts=z.strictObject(Object.fromEntries(ENTRY_KIND.map(kind=>[kind,kind==='procedure'||kind==='pitfall'?count.optional():count])) as {[K in EntryKind]:K extends AddedKind?z.ZodOptional<z.ZodNumber>:z.ZodNumber});
export const TreeRootBody = z.strictObject({
  command_policy:CommandPolicy.optional(),
  known_builds:z.array(z.strictObject({name:z.string().min(1),record:Sha256})).max(50000).optional(),
  applicability_context:z.strictObject({grammar:Versioned,closed_sets:z.partialRecord(ApplicabilityFieldSchema,z.array(z.string()))}).optional(),
  variables:z.array(VariableUse).optional(),
  product: ProductId,
  version: z.strictObject({ line: z.string().min(1), build: z.string().min(1), family: z.string().min(1), platform: z.string().min(1).nullable() }).nullable(),
  build: RecordedBuild.nullable().describe('the build the root was produced for, as the sync listed it (list roles by reference)'),
  root: Sha256.describe('digest of the root node'),
  producer: z.strictObject({
    pack: PackId,
    version: PackVersion,
    digest: Sha256,
    id: z.string().min(1).describe('pack id@version'),
    producers: z.array(z.strictObject({ id: z.string().min(1), function: PackFunctionRef })),
  }),
  sources: z.array(RootSource).describe('every source; with parts, the sources of single slots only (the list sources are in parts.sources)'),
  composition: z.array(CompositionRow).describe('sorted by path, then entry; empty when the rows are in parts'),
  unplaced: z.array(UnplacedRow).describe('sorted by entry; empty when the rows are in parts'),
  parts: CompositionParts.optional().describe('a large composition keeps its rows, unplaced rows and list sources in part records, so that no record grows with the root'),
  refused: z.array(RefusedEntry).max(MAX_KEPT_PROBLEMS),
  refused_count: z.number().int().nonnegative(),
  skipped: z.array(SkippedSource).max(MAX_KEPT_PROBLEMS).optional().describe('listed sources the production could not use (first 200 kept)'),
  skipped_count: z.number().int().nonnegative().optional(),
  catalogs: z.array(RootCatalog),
  links: z.array(LinkDeclaration).max(32).optional().describe('frozen relation declarations of this composition; absent on legacy records'),
  counts: z.strictObject({
    nodes: z.number().int().nonnegative(),
    entries: z.number().int().nonnegative(),
    placed_by_model: z.number().int().nonnegative(),
    unplaced: z.number().int().nonnegative(),
  }),
  kinds: kindCounts.optional().describe('composition rows per entry kind'),
  warnings: z.array(z.string()).max(MAX_KEPT_PROBLEMS),
  warnings_count: z.number().int().nonnegative(),
  empty_scope: z.strictObject({
    complete: z.literal(true),
    sources: z.array(z.strictObject({producer:z.string().min(1),label:z.string().min(1).max(80),listed:referenceUriOf('src'),completion:referenceUriOf('src'),total:z.number().int().nonnegative(),selected:z.literal(0)})).min(1),
  }).optional().describe('An empty product-wide root with independently checked complete inventories and zero selections; absent on legacy or nonempty roots'),
  produced_at: IsoTime,
}).superRefine((body,context)=>{
  if(body.empty_scope&&(body.build!==null||body.version!==null||body.counts.entries!==0||body.counts.unplaced!==0||body.counts.nodes!==1))context.addIssue({code:'custom',path:['empty_scope'],message:'Complete empty-scope evidence requires an empty product-wide root'});
});
export type TreeRootBody = z.infer<typeof TreeRootBody>;

// ---------------------------------------------------------------- current-root moves (kind root_pointer)

/**
 * One move of the current-root pointer of a product line@version (root_pointer@1, K01 R[6]), written in the same transaction
 * as the compare-and-set move and its move_root action, so the history can be read by product and line.
 */
export const RootPointerBody = z.strictObject({
  product: ProductId,
  line: z.string().min(1).nullable(),
  pointer: z.string().min(1),
  expected: Sha256.nullable(),
  root: Sha256,
  build: z.string().min(1).nullable().describe('the build whose root the pointer now names'),
  composition: Sha256.describe('digest of its tree_root record'),
  move: Sha256.describe('digest of the move_root action'),
  version: z.number().int().min(1),
  cause: z.string().nullable().describe('the producing run id, or rec:<digest> of the producing action'),
});
export type RootPointerBody = z.infer<typeof RootPointerBody>;

// ---------------------------------------------------------------- builds (kind claim)

/**
 * A build as the product pack's sync listed it (knowledge-build@1). The newest record of a name wins. A role that holds a list
 * is named in `lists` and left out of `sources`: the ids a production read are kept with that production (by reference), so
 * a list that changes writes no new build record.
 */
export const KnowledgeBuildBody = z.strictObject({
  product: ProductId,
  build: BuildInfo.extend({ sources: z.record(z.string(), ExternalObjectId).describe('the single roles by external id; a role that holds a list is named in lists') }),
  lists: z
    .array(z.string().min(1))
    .refine((roles) => roles.every((role, i) => i === 0 || roles[i - 1] < role), 'list roles are sorted and unique')
    .optional()
    .describe('roles of the build that hold a list, sorted; absent when there is none'),
  pack: z.strictObject({ id: PackId, version: PackVersion, digest: Sha256 }),
  plan: Sha256.nullable().describe('the parse action of the plan round that listed it'),
  sync: z.string().nullable(),
});
export type KnowledgeBuildBody = z.infer<typeof KnowledgeBuildBody>;

// ---------------------------------------------------------------- calibration (kind claim)

export const CalibrationSample = z.strictObject({
  input: Sha256.describe('digest of the piece the question was about'),
  expected: z.string().min(1).describe('the right option'),
  chosen: z.string().min(1).describe('the option the model gave the highest probability'),
  probability: z.number().min(0).max(1).describe('that highest probability'),
});
export type CalibrationSample = z.infer<typeof CalibrationSample>;

/**
 * Frozen calibration samples of one chain and exact model version (knowledge-calibration@1, K04 R[1]): projected from
 * code-placed spans (masked) or declared by an administrator who labelled them. Never changed; a new set is appended.
 */
export const KnowledgeCalibrationBody = z.strictObject({
  kind: z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/).describe('the chain, for example placement.choice'),
  model: z.string().min(1).describe('exact model version'),
  origin: ProvenanceTypeSchema.extract(['projected', 'declared']).describe('projected from code placement, or declared by the labeller'),
  samples: z.array(CalibrationSample).min(1),
  decided_by: UserId.nullable().describe('the administrator who labelled the samples'),
  root: Sha256.nullable().describe('the root the code-placed spans came from'),
  note: z.string().nullable(),
});
export type KnowledgeCalibrationBody = z.infer<typeof KnowledgeCalibrationBody>;

// ---------------------------------------------------------------- layers beside the tree (kind claim, K03)

/**
 * An echo the Hub collected itself during a verification run and the pack declares a product observation (K03): append
 * only, carrying device, build, collection time and the digest of the echo source; no run id (K03 R[3]). Never in a root digest.
 */
export const KnowledgeObservationBody = z.strictObject({
  product: ProductId,
  build: z.string().min(1),
  device: z.string().min(1),
  collected_at: IsoTime,
  echo: Sha256.describe('digest of the stored echo source'),
  declared_by: z.string().min(1).describe('the pack id@version that declares the echo a product observation'),
});
export type KnowledgeObservationBody = z.infer<typeof KnowledgeObservationBody>;

// ---------------------------------------------------------------- seedlings (schema seedling@1, kind claim)

/** One of the three fixed sources of a seedling (seedling@1, the kb-seedling task). */
export const SeedlingSource = z.strictObject({
  role: z.enum(['command-tree', 'cli-manual', 'app-manual']),
  producer: z.string().min(1).describe('the producer id that read this source'),
  slot: z.string().min(1).describe('the input slot the source was read through'),
  external: z.string().min(1).describe('the external object id the source was read as'),
  sha256: Sha256.describe('digest of the original bytes'),
  revision: z.string().nullable().describe('the fixed SVN revision the adoc was read at (null for the command tree)'),
});
export type SeedlingSource = z.infer<typeof SeedlingSource>;

/**
 * One initial seedling of a product × version line (seedling@1, the kb-seedling task): a tree merged from exactly the
 * command-tree XML of the line's current released build and the CLI and APP adoc manuals, by structure alone. The tree
 * itself is an ordinary production: `root` is its root node digest and `composition` the tree_root@1 record its
 * production wrote; this record adds what only the seedling path knows — the line, the three fixed sources with their
 * original digests and adoc revisions, and the parent seedling it descends from (append-only lineage). The current
 * seedling of a line is named by the seedling pointer (seedling/<product>/<line>), moved by compare-and-set.
 */
export const SeedlingBody = z.strictObject({
  product: ProductId,
  line: z.string().min(1).describe('the version line of the seedling'),
  root: Sha256.describe('digest of the root node'),
  composition: Sha256.describe('the tree_root@1 record the production wrote'),
  build: z.string().min(1).describe('the released build whose command tree the seedling used'),
  origin: z.array(SeedlingSource).min(1).max(3).describe('the fixed sources, sorted by role'),
  parent: Sha256.nullable().describe('the previous seedling record of this line (null for the first)'),
  basis: z.string().min(1).max(500).describe('why the seedling was produced, as one line of text'),
});
export type SeedlingBody = z.infer<typeof SeedlingBody>;

export const schemas: Record<string, z.ZodType> = {
  'tree_node@1': TreeNodeBody,
  'knowledge-entry@1': KnowledgeEntryBody,
  'tree_root@1': TreeRootBody,
  'seedling@1': SeedlingBody,
  'tree_root-rows@1': TreeRootRowsPart,
  'tree_root-unplaced@1': TreeRootUnplacedPart,
  'tree_root-sources@1': TreeRootSourcesPart,
  'root_pointer@1': RootPointerBody,
  'knowledge-build@1': KnowledgeBuildBody,
  'knowledge-calibration@1': KnowledgeCalibrationBody,
  'knowledge-observation@1': KnowledgeObservationBody,
  [KNOWLEDGE_CONTRIBUTION_SCHEMA]: KnowledgeContributionBody,
};
