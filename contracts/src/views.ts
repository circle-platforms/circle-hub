// Views of the Hub's own knowledge that workflow packs read like any external object (`knowledge:<type>:<id>`). The Hub serves
// them itself, stores each answer as an original (so every exact value resolves to a reference) and hands the parsed JSON to the
// projection and check functions of a pack. A view is derived data, never a second source of truth: an entry carries its
// tree reference or its exact feeding claim-record reference. The impact view answers "what changed between two builds, and which entries of another kind sit on the
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
/** Structural bound for a complete binding; page producers retain their smaller page limits. */
export const MAX_INDEX_ENTRIES = 200000;

/** A data field name an entry carries at the top level of its data. */
export const DataFieldName = z.string().regex(/^[a-z][a-z0-9_]{0,40}$/);

/** Distinct content identities in the selected root scope; a placed identity is not counted as unplaced. */
export const KnowledgeEntryCounts = z.strictObject({
  total:z.number().int().nonnegative(),
  placed:z.number().int().nonnegative(),
  unplaced:z.number().int().nonnegative(),
}).refine(counts=>counts.total===counts.placed+counts.unplaced,{message:'条目总数必须等于有树上位置与没有树上位置的条目数之和'});
export type KnowledgeEntryCounts = z.infer<typeof KnowledgeEntryCounts>;

/** Product-wide provenance and complete counts, independent of detail truncation. */
export const UnversionedView = z.strictObject({
  root: Sha256, composition: Sha256, build: z.null(),
  skipped_sources: z.number().int().nonnegative(),
  totals: z.strictObject({ entries: z.number().int().nonnegative(), documents: z.number().int().nonnegative(), cut_entries: z.number().int().nonnegative().optional().describe('product-wide entries omitted by the links first-page payload budget; repeated unchanged on later pages') }),
});
export type UnversionedView = z.infer<typeof UnversionedView>;
const ScopeCounts = { unversioned_entries: z.number().int().nonnegative().optional(), unversioned_documents: z.number().int().nonnegative().optional() };

/** A tree entry or a separately stored feeding projection as a view shows it. */
export const ViewEntry = z.strictObject({
  root: Sha256.optional(),
  build: z.null().optional(),
  entry: Sha256.describe('tree entry digest, or the feeding claim record digest; a feeding projection carries its content identity in data.object'),
  kind: EntryKindSchema,
  statement: z.string(),
  data: z.record(z.string(), z.unknown()),
  reference: referenceUriOf('tree', 'rec').describe('tree:<root><path>@<entry> for a tree entry, or rec:<claim> for a separately stored feeding object; citable as a ground'),
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

/** Complete document lists live in immutable, independently readable chunks. */
export const ScopeRoot=z.strictObject({root:Sha256,composition:Sha256,build:z.string().nullable()});
export const ScopedDocument=z.strictObject({external:z.string().nullable(),sha256:Sha256.optional(),at:z.array(Sha256).optional(),uses:z.array(z.strictObject({producer:z.string(),slot:z.string()})).optional(),producer:z.string().optional(),slot:z.string().optional(),reason:ReasonSchema.optional(),explanation:z.string().optional(),observation:z.string().optional(),next_action:z.string().optional()});
export type ScopedDocument=z.infer<typeof ScopedDocument>;
export const ScopeCollection=z.strictObject({total:z.number().int().nonnegative().describe('source observations; versions of one external id are distinguished by composition and byte digest'),parts:z.array(z.strictObject({reference:z.string(),sha256:Sha256,rows:z.number().int().positive()}))});
export const KnowledgeViewScope=z.strictObject({
  note:z.string().optional().describe('Explicit extent of the document observations, not a claim about every enterprise document'),
  roots:z.array(ScopeRoot),additional_roots:z.array(ScopeRoot),additional_roots_declared:z.boolean(),
  complete:z.boolean().describe('document membership and omissions are fully enumerated; omitted inputs are outside the computed data'),
  not_in_roots:ScopeCollection.optional().describe('Per-composition source exclusions, even when another declared root covers the same document'),
  listed_documents:ScopeCollection,elsewhere_documents:ScopeCollection,omitted_documents:ScopeCollection.nullable(),pending_documents:ScopeCollection,missing_optional_sources:ScopeCollection,
  unplaced_entries:z.number().int().nonnegative(),unplaced_cases:z.strictObject({from:z.number().int().nonnegative(),to:z.number().int().nonnegative()}).optional(),
  request:z.strictObject({reference:z.string(),audience_user:z.string(),deadline:z.string(),action:z.string()}).optional(),
});
export type KnowledgeViewScope=z.infer<typeof KnowledgeViewScope>;

export const ImpactView = z.strictObject({
  unversioned: UnversionedView.nullable().optional(),
  schema: z.literal('impact-view@1'),
  scope:KnowledgeViewScope.optional(),
  next: z.string().nullable().optional().describe('Continuation for the same immutable scope; null on the last page'),
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
  changes: z.array(PathChange).max(MAX_IMPACT_ENTRIES),
  placements: z.array(Placement).max(MAX_IMPACT_ENTRIES).describe('only nodes that hold at least one attached entry'),
  entries: z
    .record(Sha256, ViewEntry)
    .describe('every entry named above by digest, once; the references in it are those of the later root, or of the earlier one for an entry that exists only there'),
  totals: z.strictObject({
    ...ScopeCounts,
    changed_paths: z.number().int().nonnegative(),
    attached_from: z.number().int().nonnegative(),
    attached_to: z.number().int().nonnegative(),
  }),
  truncated: z.boolean().describe('true when a limit cut the lists; totals still count everything'),
  skipped: z
    .strictObject({ from: z.number().int().nonnegative(), to: z.number().int().nonnegative() })
    .describe('listed sources the producers could not use per side: the build root on that side plus the shared locked product-wide root; the shared count intentionally contributes to both sides; the produced entries do not cover these sources'),
  notes: z.array(z.string()).describe('what the reader could not say, in Chinese: a root without entries of the attached kind, a cut list'),
});
export type ImpactView = z.infer<typeof ImpactView>;

// ---------------------------------------------------------------- facets: counts of entries by the values of data fields

/** Most rows one facet answer holds. */
export const MAX_FACET_ROWS = 20000;

const FacetValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const FacetView = z.strictObject({
  unversioned: UnversionedView.nullable().optional(),
  schema: z.literal('facet-view@1'),
  scope:KnowledgeViewScope.optional(),
  next: z.string().nullable().optional().describe('Continuation for the same immutable scope; null on the last page'),
  product: z.string().min(1),
  build: z.strictObject({ build: z.string().min(1), root: Sha256 }),
  kind: EntryKindSchema.describe('the kind of the entries counted'),
  by: z.array(DataFieldName).min(1).max(6).describe('data fields of the entries; a field that holds a list counts the entry once per element, a missing field is null'),
  rows: z
    .array(z.strictObject({ values: z.record(DataFieldName, FacetValue), count: z.number().int().positive(), unversioned_count: z.number().int().nonnegative().optional(), unversioned_root: Sha256.optional() }))
    .max(MAX_INDEX_ENTRIES)
    .describe('one row per distinct combination, sorted by the values in code-unit order'),
  total: z.number().int().nonnegative().describe('entries of the kind in the root, whatever the fields'),
  totals: z.strictObject({
    ...ScopeCounts,
    entry_counts:KnowledgeEntryCounts.optional().describe('Content-deduplicated entries of the selected kind across the locked scope, before detail truncation or exclusions; independent of null command fields'),
    empty: z.record(DataFieldName, z.number().int().nonnegative()).describe('Entries in the null group of each by field, once per entry per field; includes rows omitted by every truncation limit; zero is explicit'),
  }),
  truncated: z.boolean(),
  skipped: z.number().int().nonnegative().describe('listed sources the producers could not use across the build root and its locked product-wide root together: the counts do not cover their possible entries'),
  notes: z.array(z.string()),
}).superRefine((view, ctx) => {
  if(view.totals.entry_counts&&view.totals.entry_counts.total!==view.total)ctx.addIssue({code:'custom',path:['totals','entry_counts','total'],message:'条目汇总与分面视图 total 不一致'});
  for (const field of view.by) {
    if (!Object.hasOwn(view.totals.empty, field)) ctx.addIssue({code:'custom',path:['totals','empty',field],message:'every by field has an explicit empty count'});
  }
  for (const [field, count] of Object.entries(view.totals.empty)) {
    if (!view.by.includes(field)) ctx.addIssue({code:'custom',path:['totals','empty',field],message:'only requested by fields have empty counts'});
    if (count > view.total) ctx.addIssue({code:'custom',path:['totals','empty',field],message:'an empty count cannot exceed the entry total'});
  }
});
export type FacetView = z.infer<typeof FacetView>;

// ---------------------------------------------------------------- index: the entries that carry a data value

/**
 * Most entries one index answer holds in total, and most per key. The byte budget (limits.maxViewBytes) is the effective
 * bound — an entry costs hundreds of bytes, so a full view never gets near this cap; it stays only as a sanity bound when a
 * deployment raises the byte budget (a slim fields view of a big build lists well over 100,000).
 */
export const MAX_INDEX_PER_KEY = 2000;

export const IndexView = z.strictObject({
  unversioned: UnversionedView.nullable().optional(),
  schema: z.literal('index-view@1'),
  scope:KnowledgeViewScope.optional(),
  next: z.string().nullable().optional().describe('Continuation for the same immutable scope; null on the last page'),
  product: z.string().min(1),
  build: z.strictObject({ build: z.string().min(1), root: Sha256 }),
  kind: EntryKindSchema,
  key: DataFieldName.describe('the data field indexed; a list field is indexed by each of its elements'),
  keys: z.record(z.string(), z.array(Sha256).max(MAX_INDEX_ENTRIES)).describe('field value -> sorted entry digests; one emitted page has at most MAX_INDEX_PER_KEY per key, complete run bindings may collate pages'),
  entries: z.record(Sha256, ViewEntry).describe('those entries, once'),
  fields: z.array(DataFieldName).optional().describe('the request asked for only these data fields per entry: each entry carries them and an empty statement; absent means full entries'),
  only: z.array(z.string()).optional().describe('the requested index values, deduplicated and sorted in UTF-16 code-unit order; absent when the request has no only parameter'),
  cut_keys: z.array(z.string()).optional().describe('listed keys whose entries were cut by MAX_INDEX_PER_KEY, sorted in UTF-16 code-unit order; generated views always include an empty array when none were cut; keys omitted entirely by the byte or entry budget are not included'),
  key_space_complete: z.boolean().optional().describe('true only when this page lists every raw key in the frozen view and no known skipped source, unresolved feeding projection or missing indexed field can add a key; it does not cover unobserved sources; absent on legacy views'),
  totals: z.strictObject({...ScopeCounts,entry_counts:KnowledgeEntryCounts.optional().describe('All distinct entries of the requested kind, even without the indexed key or outside only; the carrier total remains total_entries')}).optional(),
  total_keys: z.number().int().nonnegative(),
  total_entries: z.number().int().nonnegative(),
  truncated: z.boolean(),
  skipped: z.number().int().nonnegative().describe('listed sources the producers could not use across the build root and its locked product-wide root together: the absence of a key does not prove absence from these sources'),
  notes: z.array(z.string()),
});
export type IndexView = z.infer<typeof IndexView>;

// ---------------------------------------------------------------- literal relations pinned to a composition
export const LinkOccurrence = z.strictObject({ reference: referenceUriOf('tree').refine(value=>/@[a-f0-9]{64}$/.test(value),'a citable tree entry reference is required'), path: TreePath, summary: z.string() });
export const LinkEdge = LinkOccurrence.extend({ rule: z.string(), literal: z.string(), target: TreePath, remainder: z.array(z.string()) });
export const LinkDrift = z.strictObject({ rule: z.string(), literal: z.string(), spellings:z.array(z.string()).optional(), attempted_path: TreePath.nullable(), stopped_at: TreePath, total: z.number().int().nonnegative(), occurrences: z.array(LinkOccurrence) });
export const LinkDiagnostic=LinkOccurrence.extend({rule:z.string(),reason:ReasonSchema,message:z.string(),next_action:z.string()});
export type LinkDiagnostic=z.infer<typeof LinkDiagnostic>;
export const LinkRuleDiagnostic=z.strictObject({rule:z.string(),namespace:TreePath,reason:ReasonSchema,message:z.string(),next_action:z.string(),unchecked_literals:z.number().int().nonnegative()});
export type LinkRuleDiagnostic=z.infer<typeof LinkRuleDiagnostic>;
export const LinkTotals = z.strictObject({ ...ScopeCounts, unversioned_entries_cut:z.number().int().nonnegative().optional().describe('product-wide entries cut from the first-page-only payload'), entries: z.number().int().nonnegative(), literals: z.number().int().nonnegative(), links: z.number().int().nonnegative(), drift_literals: z.number().int().nonnegative(), drift_occurrences: z.number().int().nonnegative(),diagnosed_entries:z.number().int().nonnegative().optional(),unchecked_literals:z.number().int().nonnegative().optional() });
export const Backlinks = z.strictObject({ view_id: z.string().optional().describe('Exact external view id for composition-pinned continuation'), composition: Sha256.nullable(), configured: z.boolean(), total: z.number().int().nonnegative().nullable(), entries: z.array(LinkOccurrence), truncated: z.boolean(), notes: z.array(z.string()) }).refine(value=>value.configured===(value.total!==null)&&(!value.configured||value.composition!==null),'computed backlinks require a pinned composition and total');
export const LinksView = z.strictObject({
  unversioned: UnversionedView.nullable().optional(),
  schema: z.literal('links-view@1'), product: z.string(), build: z.strictObject({build:z.string(),root:Sha256}), composition: Sha256,
  configured: z.boolean(), prefix: TreePath, target: TreePath.nullable(), rule: z.string().nullable(),
  entries: z.record(Sha256, ViewEntry).optional(),
  links: z.array(LinkEdge), drift: z.array(LinkDrift), diagnostics:z.array(LinkDiagnostic).optional(), rule_diagnostics:z.array(LinkRuleDiagnostic).optional(), totals: LinkTotals.nullable(), next: z.string().nullable(), truncated: z.boolean(), notes: z.array(z.string()),
}).superRefine((value,ctx)=>{
  if(value.configured!==(value.totals!==null))ctx.addIssue({code:'custom',path:['totals'],message:'totals require a frozen declaration'});
  if(!value.configured&&(value.links.length>0||value.drift.length>0||value.next!==null))ctx.addIssue({code:'custom',path:['configured'],message:'a missing declaration provides no computed detail'});
  const occurrences=[...value.links,...value.drift.flatMap(group=>group.occurrences),...(value.diagnostics??[])];
  for(const occurrence of occurrences)if(!occurrence.reference.startsWith(`tree:${value.build.root}${occurrence.path}@`))ctx.addIssue({code:'custom',path:['links'],message:'a source reference must belong to this root and path'});
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
