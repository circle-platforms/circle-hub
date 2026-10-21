// Views of the Hub's own knowledge that workflow packs read like any external object (`knowledge:<type>:<id>`). The Hub serves
// them itself, stores each answer as an original (so every exact value resolves to a reference) and hands the parsed JSON to the
// projection and check functions of a pack. A view is derived data, never a second source of truth: every entry in it carries
// its tree reference. The impact view answers "what changed between two builds, and which entries of another kind sit on the
// changed nodes" (K01 R[1]: the version difference is the regression scope).
//   knowledge:impact:<product>:<from build>..<to build>[?changed=definition,behaviour&attached=case]
import { z } from 'zod';
import { ChangeKindSchema, EntryKindSchema } from '../generated/vocabulary.ts';
import { Sha256 } from './common.ts';
import { TreePath, referenceUriOf } from './reference.ts';

/** Most changed paths and most attached entries one answer holds; beyond it the answer says it is cut and how. */
export const MAX_IMPACT_PATHS = 20000;
export const MAX_IMPACT_ENTRIES = 200000;

/** An entry of the tree as a view shows it: what it says and where to cite it. */
export const ViewEntry = z.strictObject({
  entry: Sha256,
  kind: EntryKindSchema,
  statement: z.string(),
  data: z.record(z.string(), z.unknown()),
  reference: referenceUriOf('tree').describe('tree:<root><path>@<entry>, citable as a ground'),
});
export type ViewEntry = z.infer<typeof ViewEntry>;

/** A node whose own entries of the changed kinds differ between the two roots. */
export const PathChange = z.strictObject({
  path: TreePath,
  change: ChangeKindSchema.describe('added: only in the later root; removed: only in the earlier; modified: in both with different entries'),
  before: z.array(Sha256).describe('digests of its entries of the changed kinds in the earlier root; empty when added'),
  after: z.array(Sha256).describe('the same in the later root; empty when removed'),
});
export type PathChange = z.infer<typeof PathChange>;

/** The entries of the attached kinds filed exactly at a changed node, by side. */
export const Placement = z.strictObject({
  path: TreePath,
  from: z.array(Sha256).describe('digests of the attached entries at this node in the earlier root'),
  to: z.array(Sha256).describe('the same in the later root'),
});
export type Placement = z.infer<typeof Placement>;

export const ImpactView = z.strictObject({
  schema: z.literal('impact-view@1'),
  product: z.string().min(1),
  from: z.strictObject({ build: z.string().min(1), root: Sha256 }),
  to: z.strictObject({ build: z.string().min(1), root: Sha256 }),
  changed_kinds: z.array(EntryKindSchema).min(1).describe('the entry kinds whose difference counts as a change; default definition and behaviour'),
  attached_kinds: z.array(EntryKindSchema).describe('the entry kinds listed on the changed nodes; default case'),
  changes: z.array(PathChange).max(MAX_IMPACT_PATHS),
  placements: z.array(Placement).max(MAX_IMPACT_PATHS).describe('only nodes that hold at least one attached entry'),
  entries: z
    .record(Sha256, ViewEntry)
    .describe('every entry named above by digest, once; the references in it are those of the later root, or of the earlier one for an entry that exists only there'),
  totals: z.strictObject({
    changed_paths: z.number().int().nonnegative(),
    attached_from: z.number().int().nonnegative(),
    attached_to: z.number().int().nonnegative(),
  }),
  truncated: z.boolean().describe('true when a limit cut the lists; totals still count everything'),
  notes: z.array(z.string()).describe('what the reader could not say, in Chinese: a root without entries of the attached kind, a cut list'),
});
export type ImpactView = z.infer<typeof ImpactView>;

export const schemas: Record<string, z.ZodType> = {
  'impact-view@1': ImpactView,
};
