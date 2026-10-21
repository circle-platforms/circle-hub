// Product pack profile (product.json, product@1): what a product line is called, how its builds are found and how its knowledge
// is produced. Product dialect lives here and in the pack's functions, never in the core (classification rule: a product dialect
// goes to the product pack). The knowledge package consumes the sync and producer parts, the runs package the names and the
// build choice; the shapes of the functions' inputs and outputs below are the contract between them and the pack authors.
// Register every record or pack-file schema in `schemas`; contracts/src/index.ts merges them into SCHEMA_REGISTRY.
import { z } from 'zod';
import { IsoTime, Sha256, Versioned } from './common.ts';
import { ExternalObjectId } from './reference.ts';

/** Product line id, for example the id of its product pack. */
export const ProductId = z.string().regex(/^[a-z][a-z0-9-]{1,40}$/, 'lowercase letters, digits and hyphens');
export type ProductId = z.infer<typeof ProductId>;

/** A pure TypeScript function of the pack run in the sandbox: a module under `functions/` and the export to call (default `default`). */
export const PackFunctionRef = z.strictObject({
  module: z
    .string()
    .regex(/^functions\/[A-Za-z0-9_.\/-]+\.ts$/, 'functions/<path>.ts')
    .refine((m) => !m.split('/').some((part) => part === '..' || part === '.' || part === ''), 'no empty, . or .. segment in a module path'),
  export: z
    .string()
    .regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/, 'an identifier')
    .optional(),
});
export type PackFunctionRef = z.infer<typeof PackFunctionRef>;

// ---------------------------------------------------------------- external id templates

/** What a template may mention: the build being produced or chosen and its product line. */
export const TEMPLATE_VARIABLES = ['product', 'line', 'build', 'base', 'family', 'platform'] as const;
export type TemplateVariable = (typeof TEMPLATE_VARIABLES)[number];

const PLACEHOLDER = /\{([a-z_]+)\}/g;
const isVariable = (name: string): name is TemplateVariable => (TEMPLATE_VARIABLES as readonly string[]).includes(name);

/** Variables a template uses, in order of appearance; throws on an unknown one or a stray brace. */
export function templateVariables(template: string): TemplateVariable[] {
  const names: TemplateVariable[] = [];
  for (const m of template.matchAll(PLACEHOLDER)) {
    if (!isVariable(m[1])) throw new Error(`unknown template variable {${m[1]}}; use one of ${TEMPLATE_VARIABLES.join(', ')}`);
    names.push(m[1]);
  }
  if (template.replaceAll(PLACEHOLDER, '').match(/[{}]/)) throw new Error('a brace outside {variable} in a template');
  return names;
}

/** Fills a template. A value containing a character an external id cannot carry makes the result invalid: the caller gets an error, not a guess. */
export function expandTemplate(template: string, values: Partial<Record<TemplateVariable, string>>): string {
  templateVariables(template);
  const out = template.replaceAll(PLACEHOLDER, (_all, name: TemplateVariable) => {
    const value = values[name];
    if (value === undefined || value === '') throw new Error(`template ${template} needs {${name}}`);
    return value;
  });
  const checked = ExternalObjectId.safeParse(out);
  if (!checked.success) throw new Error(`template ${template} expands to ${JSON.stringify(out)}, which is not an external object id`);
  return out;
}

/** `system:type:id` with `{variable}` placeholders in any part. */
export const ExternalTemplate = z.string().superRefine((t, ctx) => {
  try {
    templateVariables(t);
    // Placeholders stand for one safe word; the filled shape is checked with a stand-in.
    ExternalObjectId.parse(t.replaceAll(PLACEHOLDER, 'x'));
  } catch (error) {
    ctx.addIssue({ code: 'custom', message: (error as Error).message });
  }
});
export type ExternalTemplate = z.infer<typeof ExternalTemplate>;

// ---------------------------------------------------------------- builds

/**
 * One build of the product as the pack's sync function identifies it. APV and NSAE style name families are one product: `family`
 * says which name the build carries and `base` the build whose tree it uses (itself when it has its own tree, otherwise the
 * build it is "based on"). Roots are keyed by product and base build; every other name is an alias of it.
 */
export const BuildInfo = z.strictObject({
  name: z.string().min(1).describe('build name exactly as listed'),
  family: z.string().min(1).describe('which of the product names the build carries'),
  line: z.string().min(1).describe('version line the pack assigns to the build, for example 10.4.6'),
  base: z.string().min(1).describe('the build whose tree this build uses; equals name when the build has its own tree'),
  platform: z.string().min(1).nullable().describe('platform or customer branch; null for the main platform'),
  built_at: IsoTime.nullable(),
  released_at: IsoTime.nullable().describe('null while unreleased'),
  sources: z.record(z.string(), ExternalObjectId).describe('external objects of this build by role the producers use, for example the command tree; empty for an alias without a tree of its own'),
});
export type BuildInfo = z.infer<typeof BuildInfo>;

/** A build the knowledge base knows, with the root of the tree it uses (null until produced). */
export const KnownBuild = BuildInfo.extend({ root: Sha256.nullable() });
export type KnownBuild = z.infer<typeof KnownBuild>;

// ---------------------------------------------------------------- sync: find the builds (called again with the pages read so far)

const SyncRead = z.strictObject({
  ok: z.boolean(),
  media_type: z.string().nullable(),
  parser: Versioned.nullable().describe('the core parser the page was parsed with (html@1 for a web page); null when not parsed'),
  model: z.unknown().describe('the parsed model of the page (the same structure the parser gives selectors into); null when not readable'),
  reason: z.string().nullable().describe('why not readable, for the pack to decide; the real reason stays in the admin log'),
});

export const SyncPlanInput = z.strictObject({
  round: z.number().int().min(1),
  options: z.record(z.string(), z.unknown()).describe('the options of the sync declaration, as overridden by the caller'),
  read: z.record(z.string(), SyncRead).describe('every page read so far by external id, including those that failed'),
  known: z.array(z.strictObject({ name: z.string(), base: z.string(), root: Sha256.nullable() })).describe('builds already in the knowledge base'),
});
export type SyncPlanInput = z.infer<typeof SyncPlanInput>;

export const SyncPlanOutput = z.strictObject({
  fetch: z.array(ExternalObjectId).describe('more pages to read before the plan is complete; asked again with their answers'),
  builds: z.array(BuildInfo).describe('every build found so far; the list of the last round is the plan'),
  done: z.boolean(),
  note: z.string().optional(),
});
export type SyncPlanOutput = z.infer<typeof SyncPlanOutput>;

export const SyncDeclaration = z.strictObject({
  start: z.array(ExternalTemplate).min(1).describe('pages read first, for example the index page of a build site'),
  plan: PackFunctionRef.describe('SyncPlanInput -> SyncPlanOutput; walks the pages and lists the builds worth knowing'),
  options: z.record(z.string(), z.unknown()).optional().describe('defaults handed to the plan function, for example whether platform or customer branches are included'),
  max_rounds: z.number().int().min(1).max(10).optional().describe('rounds of the plan function, default 6'),
  max_reads: z.number().int().min(1).max(2000).optional().describe('pages read in one sync, default 300'),
});
export type SyncDeclaration = z.infer<typeof SyncDeclaration>;

// ---------------------------------------------------------------- build choice (start_run without a build)

export const SelectBuildInput = z.strictObject({
  line: z.string().nullable().describe('version line asked for, null when the caller named none'),
  candidates: z.array(KnownBuild).describe('builds of every name family that have a root'),
  request: z.record(z.string(), z.unknown()).describe('the run parameters'),
});
export type SelectBuildInput = z.infer<typeof SelectBuildInput>;

export const SelectBuildOutput = z.strictObject({
  build: z.string().min(1).describe('name of one candidate'),
  basis: z.string().min(1).describe('why this build, kept with the run (Chinese); the choice is projected by the pack rule, not declared by the caller'),
  alternatives: z.array(z.string()).optional().describe('other candidates that qualify, best first; the caller may name one instead (K01 R[10])'),
});
export type SelectBuildOutput = z.infer<typeof SelectBuildOutput>;

// ---------------------------------------------------------------- catalogs and producers

export const CatalogDeclaration = z.strictObject({
  id: Versioned.describe('catalog@major, the name workflow packs require'),
  entry_kind: z.string().min(1).describe('kind of the knowledge entries that are its members'),
  complete: z.boolean().describe('declared complete for the scope of the root (C07 R[0]); only then is absence a fact rather than unknown'),
  case_sensitive: z.boolean(),
});
export type CatalogDeclaration = z.infer<typeof CatalogDeclaration>;

/** Where a producer's source comes from: a role of the build's own sources, or a templated external object. */
export const ProducerSource = z.union([
  z.strictObject({ source: z.string().min(1), optional: z.boolean().optional() }),
  z.strictObject({ external: ExternalTemplate, optional: z.boolean().optional() }),
]);
export type ProducerSource = z.infer<typeof ProducerSource>;

const SlotName = z.string().regex(/^[a-z][a-z0-9_]*$/);

/**
 * A producer turns stored sources into knowledge entries with their placement in the tree (K02, K04). The Hub parses every
 * source with the core parser for its media type and gives the function the parsed model; the entries it returns point back
 * into the source by parser and selector, and the Hub verifies that each one exists before it is hung on the tree (K02 R[0]).
 */
export const Producer = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9_-]*$/),
  title: z.string().min(1),
  function: PackFunctionRef,
  inputs: z.record(SlotName, ProducerSource).describe('slot name -> where it is read from, for every build whose root is produced'),
  params: z.record(z.string(), z.unknown()).optional().describe('fixed parameters handed to the function'),
});
export type Producer = z.infer<typeof Producer>;

export const ProducerSlot = z.strictObject({
  sha256: Sha256.describe('digest of the stored source file the model was parsed from'),
  media_type: z.string(),
  parser: Versioned,
  model: z.unknown(),
});

/** Input of a producer function. A slot whose source could not be read and was declared optional is null. */
export const ProducerInput = z.strictObject({
  build: KnownBuild,
  slots: z.record(SlotName, ProducerSlot.nullable()),
  params: z.record(z.string(), z.unknown()),
});
export type ProducerInput = z.infer<typeof ProducerInput>;

/** A piece of a stored source: parser, selector and an optional UTF-8 byte range inside the fragment. */
export const FragmentRef = z.strictObject({
  slot: SlotName.optional().describe('which input slot; required when the producer has more than one'),
  parser: Versioned,
  selector: z.string().min(1),
  range: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]).optional(),
});
export type FragmentRef = z.infer<typeof FragmentRef>;

/** Conditions the producer read from the source structure; null on an entry means undeclared (K02 F[6]). */
export const Applicability = z.strictObject({
  builds: z.array(z.string()).optional(),
  platforms: z.array(z.string()).optional(),
  models: z.array(z.string()).optional(),
});
export type Applicability = z.infer<typeof Applicability>;

export const ProducedEntry = z.strictObject({
  kind: z.string().min(1).describe('declared by the producer (K02 R[1])'),
  path: z.string().regex(/^\/(?:[^/]+(?:\/[^/]+)*)?$/, 'a tree path starting with /').nullable().describe('where it hangs; null when code cannot place it (it goes to the typed-judgment model)'),
  statement: z.string().describe('deterministic canonical statement; it carries everything data says (K02 R[4])'),
  data: z.record(z.string(), z.unknown()),
  fragments: z.array(FragmentRef).min(1).describe('the source pieces that warrant the entry, in order'),
  applicability: Applicability.nullable(),
});
export type ProducedEntry = z.infer<typeof ProducedEntry>;

/** A span the code could not place: it stays citable by its fragment and goes to the typed-judgment model. */
export const Unplaced = z.strictObject({ fragment: FragmentRef, section: z.string(), kind: z.string(), text: z.string() });
export type Unplaced = z.infer<typeof Unplaced>;

export const ProducerOutput = z.strictObject({
  entries: z.array(ProducedEntry),
  unplaced: z.array(Unplaced).optional(),
  warnings: z.array(z.string()),
});
export type ProducerOutput = z.infer<typeof ProducerOutput>;

export const ProductDeclaration = z
  .strictObject({
    schema: z.literal('product@1'),
    id: ProductId,
    title: z.string().min(1),
    names: z.array(z.string().min(1)).min(1).describe('every name of the product; each resolves to this line'),
    sync: SyncDeclaration.optional(),
    select_build: PackFunctionRef.optional().describe('SelectBuildInput -> SelectBuildOutput; without it the newest released build of the line is chosen'),
    catalogs: z.array(CatalogDeclaration),
    producers: z.array(Producer),
  })
  .superRefine((p, ctx) => {
    const lower = new Set<string>();
    p.names.forEach((n, i) => {
      const k = n.normalize('NFC').toLowerCase();
      if (lower.has(k)) ctx.addIssue({ code: 'custom', path: ['names', i], message: `the name ${n} is listed twice` });
      lower.add(k);
    });
    const unique = (what: 'catalogs' | 'producers', ids: string[]) =>
      ids.forEach((id, i) => {
        if (ids.indexOf(id) !== i) ctx.addIssue({ code: 'custom', path: [what, i, 'id'], message: `${what.slice(0, -1)} ${id} is declared twice` });
      });
    unique('catalogs', p.catalogs.map((c) => c.id));
    unique('producers', p.producers.map((x) => x.id));
  });
export type ProductDeclaration = z.infer<typeof ProductDeclaration>;

export const schemas: Record<string, z.ZodType> = {
  'product@1': ProductDeclaration,
  'build-info@1': BuildInfo,
  'sync-plan-input@1': SyncPlanInput,
  'sync-plan-output@1': SyncPlanOutput,
  'select-build-input@1': SelectBuildInput,
  'select-build-output@1': SelectBuildOutput,
  'producer-input@1': ProducerInput,
  'producer-output@1': ProducerOutput,
};
