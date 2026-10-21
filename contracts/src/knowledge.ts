// Shapes owned by the knowledge work package (K01-K05): the records of the content-addressed knowledge tree, its builds,
// current-root moves, calibration sets and the two layers beside the tree. Register every record or pack-file schema in
// `schemas`; contracts/src/index.ts merges them into SCHEMA_REGISTRY, which tools/gen-contracts.ts turns into
// contracts/generated/schemas/*.json. Keys are `name@major`.
//
// Record layout (hub/knowledge/README.md): nodes and entries are `tree_node` records (tree content, never a ground on their
// own, B01 R[5]), compositions are `tree_root` records, current-root moves are `root_pointer` records, builds, calibration
// sets, observations and candidates are `claim` records with the schemas below. Digests of nodes and entries cover the
// normalised content only (K01 R[7], K02 R[4]); see nodeDigest and entryDigest in hub/knowledge.
import { z } from 'zod';
import { EntryKindSchema, NodeLevelSchema, ProvenanceTypeSchema, ReadTierSchema, type NodeLevel } from '../generated/vocabulary.ts';
import { IsoTime, PackId, PackVersion, Sha256, UserId, Versioned } from './common.ts';
import { Applicability, BuildInfo, CatalogDeclaration, PackFunctionRef, ProductId } from './product.ts';
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
export const COMPOSITION_BASES = ['release_record', 'device_echo', 'declared'] as const;
export type CompositionBasis = (typeof COMPOSITION_BASES)[number];
export const CompositionBasisSchema = z.enum(COMPOSITION_BASES);

const SrcReferenceUri = referenceUriOf('src');
const sortedUnique = (values: readonly string[]): boolean => values.every((v, i) => i === 0 || values[i - 1] < v);

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
export const CompositionRow = z.strictObject({
  path: TreePath,
  entry: Sha256,
  kind: EntryKindSchema,
  producers: ProducerIds,
  fragments: z.array(SrcReferenceUri).min(1).describe('canonical src references in the order the producers gave them'),
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
 * The composition record of one produced root (tree_root@1, K01 R[5]-R[7]): product line, version identity, root digest,
 * the producing product pack, every source with its basis and decider, and per entry the fragments that provide it.
 */
export const TreeRootBody = z.strictObject({
  product: ProductId,
  version: z.strictObject({ line: z.string().min(1), build: z.string().min(1), family: z.string().min(1), platform: z.string().min(1).nullable() }),
  build: BuildInfo.describe('the build the root was produced for, as the sync listed it'),
  root: Sha256.describe('digest of the root node'),
  producer: z.strictObject({
    pack: PackId,
    version: PackVersion,
    digest: Sha256,
    id: z.string().min(1).describe('pack id@version'),
    producers: z.array(z.strictObject({ id: z.string().min(1), function: PackFunctionRef })),
  }),
  sources: z.array(RootSource),
  composition: z.array(CompositionRow).describe('sorted by path, then entry'),
  unplaced: z.array(UnplacedRow),
  refused: z.array(RefusedEntry).max(MAX_KEPT_PROBLEMS),
  refused_count: z.number().int().nonnegative(),
  catalogs: z.array(RootCatalog),
  counts: z.strictObject({
    nodes: z.number().int().nonnegative(),
    entries: z.number().int().nonnegative(),
    placed_by_model: z.number().int().nonnegative(),
    unplaced: z.number().int().nonnegative(),
  }),
  warnings: z.array(z.string()).max(MAX_KEPT_PROBLEMS),
  warnings_count: z.number().int().nonnegative(),
  produced_at: IsoTime,
});
export type TreeRootBody = z.infer<typeof TreeRootBody>;

// ---------------------------------------------------------------- current-root moves (kind root_pointer)

/**
 * One move of the current-root pointer of a product line@version (root_pointer@1, K01 R[6]), written in the same transaction
 * as the compare-and-set move and its move_root action, so the history can be read by product and line.
 */
export const RootPointerBody = z.strictObject({
  product: ProductId,
  line: z.string().min(1),
  pointer: z.string().min(1),
  expected: Sha256.nullable(),
  root: Sha256,
  build: z.string().min(1).describe('the build whose root the pointer now names'),
  composition: Sha256.describe('digest of its tree_root record'),
  move: Sha256.describe('digest of the move_root action'),
  version: z.number().int().min(1),
  cause: z.string().nullable().describe('the producing run id, or rec:<digest> of the producing action'),
});
export type RootPointerBody = z.infer<typeof RootPointerBody>;

// ---------------------------------------------------------------- builds (kind claim)

/** A build as the product pack's sync listed it (knowledge-build@1). The newest record of a name wins. */
export const KnowledgeBuildBody = z.strictObject({
  product: ProductId,
  build: BuildInfo,
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

/**
 * A person's candidate (K03): experience a model summarised in Circle, visible to its owner only. It binds the node path,
 * the digest of the cited fragment and the root it rests on (K03 R[5]); its ground is an uploaded session excerpt whose
 * quotation the Hub verified before the candidate entered the layer (K03 R[4]). Never in a root digest.
 */
export const KnowledgeCandidateBody = z.strictObject({
  owner: UserId,
  product: ProductId,
  root: Sha256,
  path: TreePath,
  cited_fragment: Sha256.describe('SHA-256 of the text at the path in that root when the candidate was written'),
  statement: z.string().min(1),
  ground: z.strictObject({ reference: SrcReferenceUri, quote: z.string().min(1) }),
  applicability: Applicability.nullable(),
});
export type KnowledgeCandidateBody = z.infer<typeof KnowledgeCandidateBody>;

export const schemas: Record<string, z.ZodType> = {
  'tree_node@1': TreeNodeBody,
  'knowledge-entry@1': KnowledgeEntryBody,
  'tree_root@1': TreeRootBody,
  'root_pointer@1': RootPointerBody,
  'knowledge-build@1': KnowledgeBuildBody,
  'knowledge-calibration@1': KnowledgeCalibrationBody,
  'knowledge-observation@1': KnowledgeObservationBody,
  'knowledge-candidate@1': KnowledgeCandidateBody,
};
