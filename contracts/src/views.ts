// Views of the Hub's own knowledge that workflow packs read like any external object (`knowledge:<type>:<id>`). The Hub serves
// them itself, stores each answer as an original (so every exact value resolves to a reference) and hands the parsed JSON to the
// projection and check functions of a pack. A view is derived data, never a second source of truth: every entry in it carries
// its tree reference. The impact view answers "what changed between two builds, and which entries of another kind sit on the
// changed nodes" (K01 R[1]: the version difference is the regression scope).
//   knowledge:impact:<product>:<from build>..<to build>[?changed=definition,behaviour&attached=case][&attached_fields=document,node,title][&catalog=commands@1]
//     (with attached_fields the attached entries carry only those data fields and an empty statement; the changed entries are untouched.
//     With catalog, only the members of that catalog count as changes, read per root like the catalog reader (the kind and producer
//     from the product's declaration for that root) and compared by syntax — the descriptive fields of catalog-entry@1 (parameter
//     descriptions, the entry summary), the per-root references and the signature ids are out, overloads compare as a set; changed may
//     then be omitted (the catalog's kind) or must equal it. A root that does not declare the catalog is a refusal, not an empty answer.
//     The catalog name holds a literal @ in the id; the percent-escaped commands%401 reads the same)
//   knowledge:facets:<product>:<build>?kind=case&by=line,module,has_expected   (counts of entries by data fields)
//   knowledge:index:<product>:<build>?kind=case&key=defects[&only=1,2,3][&fields=document,node,title]   (data value -> the entries that carry it;
//     with fields the entries carry only those data fields and an empty statement, so a big index fits the byte budget)
// `<build>` is a build name of any name family; the reader resolves aliases and answers for the root the build uses.
import { z } from 'zod';
import { ChangeKindSchema, EntryKindSchema,ReasonSchema } from '../generated/vocabulary.ts';
import { Sha256, Versioned } from './common.ts';
import { TreePath, referenceUriOf } from './reference.ts';

/** Most changed paths and most attached entries one answer holds; beyond it the answer says it is cut and how. */
export const MAX_IMPACT_PATHS = 20000;
export const MAX_IMPACT_ENTRIES = 200000;

/** A data field name an entry carries at the top level of its data. */
export const DataFieldName = z.string().regex(/^[a-z][a-z0-9_]{0,40}$/);

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
  changed_kinds: z.array(EntryKindSchema).min(1).describe('the entry kinds whose difference counts as a change; default definition and behaviour; with catalog, the single kind of the catalog members'),
  attached_kinds: z.array(EntryKindSchema).describe('the entry kinds listed on the changed nodes; default case'),
  attached_fields: z
    .array(DataFieldName)
    .optional()
    .describe('the request asked for only these data fields per attached entry: they carry them with an empty statement; absent means full entries (the changed entries are never slimmed)'),
  catalog: Versioned.optional().describe(
    'the request filtered the changes to the members of this catalog, read per root from the declaration of the product and compared by syntax (catalog-entry@1 without the descriptive fields, references and signature ids); absent: no catalog, every entry of the changed kinds counts',
  ),
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
  skipped: z
    .strictObject({ from: z.number().int().nonnegative(), to: z.number().int().nonnegative() })
    .describe('listed sources the producers could not use, per root (unreadable, unparsable, over the byte cap): what they would have given is unknown, not absent, so a pack must not read the absence of an entry as a fact when this is not zero'),
  notes: z.array(z.string()).describe('what the reader could not say, in Chinese: a root without entries of the attached kind, a cut list'),
});
export type ImpactView = z.infer<typeof ImpactView>;

// ---------------------------------------------------------------- facets: counts of entries by the values of data fields

/** Most rows one facet answer holds. */
export const MAX_FACET_ROWS = 20000;

const FacetValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const FacetView = z.strictObject({
  schema: z.literal('facet-view@1'),
  product: z.string().min(1),
  build: z.strictObject({ build: z.string().min(1), root: Sha256 }),
  kind: EntryKindSchema.describe('the kind of the entries counted'),
  by: z.array(DataFieldName).min(1).max(6).describe('data fields of the entries; a field that holds a list counts the entry once per element, a missing field is null'),
  rows: z
    .array(z.strictObject({ values: z.record(DataFieldName, FacetValue), count: z.number().int().positive() }))
    .max(MAX_FACET_ROWS)
    .describe('one row per distinct combination, sorted by the values in code-unit order'),
  total: z.number().int().nonnegative().describe('entries of the kind in the root, whatever the fields'),
  truncated: z.boolean(),
  skipped: z.number().int().nonnegative().describe('listed sources the producers could not use in this root: the counts do not cover what they would have given'),
  notes: z.array(z.string()),
});
export type FacetView = z.infer<typeof FacetView>;

// ---------------------------------------------------------------- index: the entries that carry a data value

/**
 * Most entries one index answer holds in total, and most per key. The byte budget (limits.maxViewBytes) is the effective
 * bound — an entry costs hundreds of bytes, so a full view never gets near this cap; it stays only as a sanity bound when a
 * deployment raises the byte budget (a slim fields view of a big build lists well over 100,000).
 */
export const MAX_INDEX_ENTRIES = 200000;
export const MAX_INDEX_PER_KEY = 2000;

export const IndexView = z.strictObject({
  schema: z.literal('index-view@1'),
  product: z.string().min(1),
  build: z.strictObject({ build: z.string().min(1), root: Sha256 }),
  kind: EntryKindSchema,
  key: DataFieldName.describe('the data field indexed; a list field is indexed by each of its elements'),
  keys: z.record(z.string(), z.array(Sha256).max(MAX_INDEX_PER_KEY)).describe('field value -> digests of the entries that carry it, sorted'),
  entries: z.record(Sha256, ViewEntry).describe('those entries, once'),
  fields: z.array(DataFieldName).optional().describe('the request asked for only these data fields per entry: each entry carries them and an empty statement; absent means full entries'),
  only: z.array(z.string()).optional().describe('the requested index values, deduplicated and sorted in UTF-16 code-unit order; absent when the request has no only parameter'),
  cut_keys: z.array(z.string()).optional().describe('listed keys whose entries were cut by MAX_INDEX_PER_KEY, sorted in UTF-16 code-unit order; generated views always include an empty array when none were cut; keys omitted entirely by the byte or entry budget are not included'),
  total_keys: z.number().int().nonnegative(),
  total_entries: z.number().int().nonnegative(),
  truncated: z.boolean(),
  skipped: z.number().int().nonnegative().describe('listed sources the producers could not use in this root: an absent key is unknown, not proof of absence, when this is not zero'),
  notes: z.array(z.string()),
});
export type IndexView = z.infer<typeof IndexView>;

// ---------------------------------------------------------------- literal relations pinned to a composition
export const LinkOccurrence = z.strictObject({ reference: z.union([referenceUriOf('tree').refine(value=>/@[a-f0-9]{64}$/.test(value),'an entry reference is required'),referenceUriOf('entry')]), path: TreePath, summary: z.string() });
export const LinkEdge = LinkOccurrence.extend({ rule: z.string(), literal: z.string(), target: TreePath, remainder: z.array(z.string()) });
export const LinkDrift = z.strictObject({ rule: z.string(), literal: z.string(), spellings:z.array(z.string()).optional(), attempted_path: TreePath.nullable(), stopped_at: TreePath, total: z.number().int().nonnegative(), occurrences: z.array(LinkOccurrence) });
export const LinkDiagnostic=LinkOccurrence.extend({rule:z.string(),reason:ReasonSchema,message:z.string(),next_action:z.string()});
export type LinkDiagnostic=z.infer<typeof LinkDiagnostic>;
export const LinkTotals = z.strictObject({ entries: z.number().int().nonnegative(), literals: z.number().int().nonnegative(), links: z.number().int().nonnegative(), drift_literals: z.number().int().nonnegative(), drift_occurrences: z.number().int().nonnegative(),diagnosed_entries:z.number().int().nonnegative().optional() });
export const Backlinks = z.strictObject({ composition: Sha256.nullable(), configured: z.boolean(), total: z.number().int().nonnegative().nullable(), entries: z.array(LinkOccurrence), truncated: z.boolean(), notes: z.array(z.string()) }).refine(value=>value.configured===(value.total!==null)&&(!value.configured||value.composition!==null),'computed backlinks require a pinned composition and total');
export const LinksView = z.strictObject({
  schema: z.literal('links-view@1'), product: z.string(), build: z.strictObject({build:z.string(),root:Sha256}), composition: Sha256,
  configured: z.boolean(), prefix: TreePath, target: TreePath.nullable(), rule: z.string().nullable(),
  links: z.array(LinkEdge), drift: z.array(LinkDrift), diagnostics:z.array(LinkDiagnostic).optional(), totals: LinkTotals.nullable(), next: z.string().nullable(), truncated: z.boolean(), notes: z.array(z.string()),
}).superRefine((value,ctx)=>{
  if(value.configured!==(value.totals!==null))ctx.addIssue({code:'custom',path:['totals'],message:'totals require a frozen declaration'});
  if(!value.configured&&(value.links.length>0||value.drift.length>0||value.next!==null))ctx.addIssue({code:'custom',path:['configured'],message:'a missing declaration provides no computed detail'});
  const occurrences=[...value.links,...value.drift.flatMap(group=>group.occurrences),...(value.diagnostics??[])];
  for(const occurrence of occurrences)if(!occurrence.reference.startsWith('entry:')&&!occurrence.reference.startsWith(`tree:${value.build.root}${occurrence.path}@`))ctx.addIssue({code:'custom',path:['links'],message:'a source reference must belong to this root and path'});
  if(value.totals&&(value.links.length>value.totals.links||value.drift.length>value.totals.drift_literals))ctx.addIssue({code:'custom',path:['totals'],message:'page details exceed totals'});
});
export type LinkOccurrence = z.infer<typeof LinkOccurrence>;
export type LinkEdge = z.infer<typeof LinkEdge>;
export type LinkDrift = z.infer<typeof LinkDrift>;
export type LinksView = z.infer<typeof LinksView>;
export type Backlinks = z.infer<typeof Backlinks>;

export const schemas: Record<string, z.ZodType> = {
  'links-view@1': LinksView,
  'impact-view@1': ImpactView,
  'facet-view@1': FacetView,
  'index-view@1': IndexView,
};
