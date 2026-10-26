// Product pack profile (product.json, product@1): what a product line is called, how its builds are found and how its knowledge
// is produced. Product dialect lives here and in the pack's functions, never in the core (classification rule: a product dialect
// goes to the product pack). The knowledge package consumes the sync and producer parts, the runs package the names and the
// build choice; the shapes of the functions' inputs and outputs below are the contract between them and the pack authors.
// Register every record or pack-file schema in `schemas`; contracts/src/index.ts merges them into SCHEMA_REGISTRY.
import { z } from 'zod';
import { PROTOCOL_CODES, type ProtocolCode } from '../generated/protocol.ts';
import { VariableDeclaration, referencesIn, VariableInputError } from './variables.ts';
import { ApplicabilityFieldSchema, EntryKindSchema, LINK_MATCH, LinkMatchSchema, PlacementSchema, type Placement, TypeDeclarationStatusSchema, CommandParseStatusSchema, ReasonSchema } from '../generated/vocabulary.ts';
import { IsoTime, Sha256, Versioned } from './common.ts';
import { ExternalObjectId, TreePath } from './reference.ts';

/** Product-authored command structure; no word/prose classification or mutable runtime lookup. */
const CommandPrefix=TreePath.refine(path=>path==='/commands'||path.startsWith('/commands/'),'a locked command-tree prefix');
export const CommandPolicy=z.strictObject({
 schema:z.literal('command-policy@1'),
 read_only:z.array(CommandPrefix).max(64),
 inverse_rules:z.array(z.strictObject({source_prefix:CommandPrefix,inverse_prefix:CommandPrefix,leading_parameters:z.number().int().min(0).max(128).optional().describe('When absent, require a unique inverse formed by a leading parameter count accepted by the locked inverse signature')})).max(64),
 inverse_alternatives:z.array(z.tuple([z.string().regex(/\S/),z.string().regex(/\S/)])).max(64).optional().describe('Pairs of enum alternative values of one signature that are each other\'s inverse (on/off, enable/disable); decided on the locked tree\'s declared enum structure, never on free text'),
});
export type CommandPolicy=z.infer<typeof CommandPolicy>;

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

/** Most external objects one role of a build may list (a producer reads them in batches). */
export const MAX_LIST_SOURCES = 20000;

/**
 * One build of the product as the pack's sync function identifies it. FAMX and FAMY style name families are one product: `family`
 * says which name the build carries and `base` the build whose tree it uses (itself when it has its own tree, otherwise the
 * build it is "based on"). Roots are keyed by product and base build; every other name is an alias of it.
 */
export const BuildInfo = z.strictObject({
  name: z.string().min(1).describe('build name exactly as listed'),
  family: z.string().min(1).describe('which of the product names the build carries'),
  line: z.string().min(1).describe('version line the pack assigns to the build, for example 10.7.6'),
  base: z.string().min(1).describe('the build whose tree this build uses; equals name when the build has its own tree'),
  platform: z.string().min(1).nullable().describe('platform or customer branch; null for the main platform'),
  built_at: IsoTime.nullable(),
  released_at: IsoTime.nullable().describe('null while unreleased'),
  sources: z
    .record(z.string(), z.union([ExternalObjectId, z.array(ExternalObjectId).max(MAX_LIST_SOURCES)]))
    .describe('external objects of this build by role the producers use, for example the command tree; a role may hold a list, for example every case document the build covers; empty for an alias without a tree of its own'),
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

/** A source observation that cannot produce a root; reasons are registered protocol codes. */
export const FailedBuild = z.strictObject({
  source: ExternalObjectId,
  build: BuildInfo,
  raw: z.record(z.string(), z.unknown()),
  reason: z.enum(Object.keys(PROTOCOL_CODES) as [ProtocolCode, ...ProtocolCode[]]),
  fix: z.string().min(1),
});
export type FailedBuild = z.infer<typeof FailedBuild>;

export const SyncPlanOutput = z.strictObject({
  failed_builds: z.array(FailedBuild).optional(),
  scope: BuildInfo.shape.sources.optional().describe('product-wide sources without a declared build'),
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
  entry_kind: EntryKindSchema.describe('kind of the knowledge entries that are its members'),
  producer: z
    .string()
    .regex(/^[a-z][a-z0-9_-]*$/)
    .optional()
    .describe('only entries this producer of the pack produced are members; every producer of the kind when absent'),
  complete: z.boolean().describe('declared complete for the scope of the root (C07 R[0]); only then is absence a fact rather than unknown'),
  case_sensitive: z.boolean(),
});
export type CatalogDeclaration = z.infer<typeof CatalogDeclaration>;

/** Where a producer's source comes from: a role of the build's own sources, or a templated external object. */
export const ProducerSource = z.union([
  z.strictObject({
    source: z.string().min(1),
    optional: z.boolean().optional(),
    parser: Versioned.optional().describe('Explicit core parser for this source or every member of this list; the observed server media type remains unchanged'),
    many: z.boolean().optional().describe('the role holds a list of external objects; the function is called once per batch of them and its outputs are concatenated, so an entry must not depend on another batch'),
    batch: z.number().int().min(1).max(200).optional().describe('objects per call for a list role, default 50'),
  }),
  z.strictObject({ external: ExternalTemplate, optional: z.boolean().optional(), parser: Versioned.optional().describe('Explicit core parser; retain the observed server media type') }),
]);
export type ProducerSource = z.infer<typeof ProducerSource>;

const SlotName = z.string().regex(/^[a-z][a-z0-9_]*$/);

/**
 * How path-less entries produced by this producer may be placed:
 * - `code_only`: keep path-less entries unplaced at root; nothing leaves the Hub.
 * - `judgment_allowed`: the Hub offers this producer's path-less entries to the bot for placement proposals and
 *   verifies each proposal with deterministic rules; the Hub never places them itself.
 * Defaults to `code_only` because the Hub calls no model and placement is the bot's job.
 */
export const ProducerPlacement = PlacementSchema.describe(
  'whether this producer\'s path-less entries may be handed to the bot for placement: code_only (default) keeps them unplaced at the root; judgment_allowed means the Hub offers them to the bot for placement proposals and verifies each proposal with deterministic rules (the path exists, quotes are verbatim from the original, nothing beyond what the producer declared). The Hub calls no model and never places entries itself; the bot flow is not implemented yet',
);
export type ProducerPlacement = Placement;

/**
 * A producer turns stored sources into knowledge entries with their placement in the tree (K02, K04). The Hub parses every
 * source with the core parser for its media type and gives the function the parsed model; the entries it returns point back
 * into the source by parser and selector, and the Hub verifies that each one exists before it is hung on the tree (K02 R[0]).
 */
export const Producer = z.strictObject({
  unversioned: z.boolean().optional().describe('only produce the product-wide root; absent or false produces build roots'),
  id: z.string().regex(/^[a-z][a-z0-9_-]*$/),
  title: z.string().min(1),
  function: PackFunctionRef,
  inputs: z.record(SlotName, ProducerSource).describe('slot name -> where it is read from, for every build whose root is produced'),
  params: z.record(z.string(), z.unknown()).optional().describe('fixed parameters handed to the function'),
  placement: ProducerPlacement.optional().describe(
    'whether this producer\'s path-less entries may be handed to the bot for placement: code_only (default) keeps them unplaced at the root; judgment_allowed means the Hub offers them to the bot for placement proposals and verifies each proposal with deterministic rules (the path exists, quotes are verbatim from the original, nothing beyond what the producer declared). The Hub calls no model and never places entries itself; the bot flow is not implemented yet',
  ),
});
export type Producer = z.infer<typeof Producer>;

export const ProducerSlot = z.strictObject({
  sha256: Sha256.describe('digest of the stored source file the model was parsed from'),
  media_type: z.string(),
  parser: Versioned,
  model: z.unknown(),
  external: ExternalObjectId.optional().describe('the external object this list element was read from; a producer matches documents by it, never by position in the batch'),
});

/** Input of a producer function. A slot whose source could not be read and was declared optional is null. */
export const ProducerInput = z.strictObject({
  known_builds:z.array(z.string().min(1)).max(50000).optional().describe('Immutable product build-name inventory supplied by the Hub, never a client or environment variable'),
  build: KnownBuild.optional(),
  slots: z.record(SlotName, ProducerSlot.nullable()),
  lists: z.record(SlotName, z.array(ProducerSlot)).optional().describe('the batch of each list slot (many: true); the other slots are the same in every call'),
  batch: z.strictObject({ index: z.number().int().nonnegative(), of: z.number().int().min(1) }).optional().describe('which batch this call is, when the producer has a list slot'),
  params: z.record(z.string(), z.unknown()),
});
export type ProducerInput = z.infer<typeof ProducerInput>;

/** Conditions the producer read from the source structure; null on an entry means undeclared (K02 F[6]). */
const MemoryBound=z.strictObject({bytes:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),inclusive:z.boolean()});
export const Applicability = z.strictObject({
  builds: z.array(z.string()).optional(),
  platforms: z.array(z.string()).optional(),
  models: z.array(z.string()).optional(),
  components:z.strictObject({with:z.array(z.string().min(1)).min(1).optional(),without:z.array(z.string().min(1)).min(1).optional()}).refine(value=>value.with!==undefined||value.without!==undefined,'declare components with or without').optional(),
  memory:z.strictObject({minimum:MemoryBound.optional(),maximum:MemoryBound.optional(),raw:z.string().regex(/\S/,'preserve the explicit memory notation')}).refine(value=>value.minimum!==undefined||value.maximum!==undefined,'declare a numeric memory bound').optional(),
  licenses:z.array(z.string().min(1)).optional(),
  deployment_forms:z.array(z.string().min(1)).optional(),
  inherited:z.array(ApplicabilityFieldSchema).optional().describe('Inherited field codes only; source positions belong to composition provenance'),
});
export type Applicability = z.infer<typeof Applicability>;

/** Declared field provenance; conflict preserves competing source declarations without choosing a value. */
export const ApplicabilityOrigin=z.strictObject({field:ApplicabilityFieldSchema,section:z.array(z.string()),declaration:Applicability,conflict:z.boolean().optional(),superseded:z.boolean().optional().describe('An inner scope replaced this declaration; retained as provenance only')});
export type ApplicabilityOrigin=z.infer<typeof ApplicabilityOrigin>;

/** A piece of a stored source: parser, selector and an optional UTF-8 byte range inside the fragment. */
export const FragmentRef = z.strictObject({
  slot: SlotName.optional().describe('which input slot; required when the producer has more than one'),
  source: Sha256.optional().describe('digest of the source inside a list slot (ProducerSlot.sha256); required for a list slot'),
  parser: Versioned,
  selector: z.string().min(1),
  applicability:z.array(ApplicabilityOrigin).min(1).optional().describe('Field-specific source provenance, excluded from entry content'),
  range: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]).optional(),
});
export type FragmentRef = z.infer<typeof FragmentRef>;



export const ProducedEntry = z.strictObject({
  kind: z.string().describe('declared by the producer (K02 F[0], R[3]); the knowledge package checks it against the entry_kind axis one entry at a time, so one wrong entry is refused and reported without losing the rest'),
  path: z.string().regex(/^\/(?:[^/]+(?:\/[^/]+)*)?$/, 'a tree path starting with /').nullable().describe('where it hangs; null when code cannot place it (a producer may declare it for the bot\'s placement proposals)'),
  statement: z.string().describe('deterministic canonical statement; it carries everything data says (K02 R[4])'),
  data: z.record(z.string(), z.unknown()),
  fragments: z.array(FragmentRef).min(1).describe('the source pieces that warrant the entry, in order'),
  applicability: Applicability.nullable(),
});
export type ProducedEntry = z.infer<typeof ProducedEntry>;

/** A span the code could not place: it stays citable by its fragment and may be offered to the bot for placement proposals. */
export const Unplaced = z.strictObject({ fragment: FragmentRef, section: z.string(), kind: z.string(), text: z.string() });
export type Unplaced = z.infer<typeof Unplaced>;

/** C07/W05: grammar identity and parameter evidence, never a new validation terminal. */
export const ProducerDiagnostic=z.strictObject({
  command:z.array(z.string()),path:z.string().min(1),attribute:z.string().min(1),position:z.number().int().positive().optional(),
  type_declaration_status:TypeDeclarationStatusSchema,command_parse_status:CommandParseStatusSchema,
  syntax_valid:z.boolean(),reason:ReasonSchema,missing:z.string().regex(/\S/),next_action:z.string().regex(/\S/),
  audience:z.string().regex(/\S/),due:z.string().regex(/\S/),source_value:z.string().optional(),
});
export type ProducerDiagnostic=z.infer<typeof ProducerDiagnostic>;
export const ProducerGrammar=z.strictObject({id:Versioned,source:z.string().min(1),complete:z.boolean()});

export const ProducerOutput = z.strictObject({
  incomplete:z.strictObject({missing:z.string().regex(/\S/),next_action:z.string().regex(/\S/)}).optional().describe('Controlled missing-input recovery; no partial output is admitted'),
  grammar:ProducerGrammar.optional(),
  diagnostics:z.array(ProducerDiagnostic).optional(),

  inventory: z.array(z.strictObject({
    label: z.string().min(1).max(80),
    listed: FragmentRef.pick({slot:true,source:true,parser:true,selector:true}).describe('JSON array of the complete source inventory'),
    complete: FragmentRef.pick({slot:true,source:true,parser:true,selector:true}).describe('JSON true declaring the inventory complete'),
    selected: z.number().int().nonnegative(),
  })).max(32).optional().describe('Evidence for a complete zero selection; the Hub verifies fragments and counts before admitting an empty product-wide root'),
  entries: z.array(ProducedEntry),
  unplaced: z.array(Unplaced).optional(),
  warnings: z.array(z.string()),
});
export type ProducerOutput = z.infer<typeof ProducerOutput>;

/** A declarative relation from a literal data field to a namespace; no product dialect enters the reader. */
export const LinkDeclaration = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9_-]{0,40}$/),
  field: z.string().regex(/^[a-z][a-z0-9_]{0,40}$/).optional().describe('Data field holding ordinary literals; mutually exclusive with alternatives_field'),
  alternatives_field: z.string().regex(/^[a-z][a-z0-9_]{0,40}$/).optional().describe('Data field holding groups {primary: string, alternatives: nonempty string[]}; exact primary definition wins, otherwise each alternative is matched exactly'),
  namespace: TreePath,
  match: LinkMatchSchema,
  entry_kind: EntryKindSchema.optional().describe('required by longest-prefix matching; optional restriction for exact matching'),
  target_producers:z.array(z.string().min(1)).min(1).max(32).optional(),
  source_producers:z.array(z.string().min(1)).min(1).max(32).optional(),
  unmatched: z.enum(['drift', 'mention']).optional().describe('What a literal this rule cannot match is: drift, a fact of the run (default), or mention, the author\'s marked text kept verbatim and linked only on complete equality (integrator decision 60, 2026-10-25: prose claims no command, so it creates no drift)'),
  normalize: z.strictObject({ lowercase: z.boolean().optional(), nfc: z.boolean().optional(), nfkc: z.boolean().optional(), strip_nul: z.boolean().optional() }).optional(),
}).superRefine((value, ctx) => {
  if ((value.field===undefined)===(value.alternatives_field===undefined))ctx.addIssue({code:'custom',path:['field'],message:'declare exactly one literal field or alternative-group field'});
  if (value.alternatives_field!==undefined&&value.match!==LINK_MATCH[0])ctx.addIssue({code:'custom',path:['match'],message:'alternative groups require exact matching'});
  if (value.match === LINK_MATCH[1] && value.entry_kind === undefined) ctx.addIssue({code:'custom',path:['entry_kind'],message:'longest-prefix matching needs a declared entry kind'});
  if (value.normalize?.nfc && value.normalize?.nfkc) ctx.addIssue({code:'custom',path:['normalize'],message:'choose one Unicode normalization form'});
});
export type LinkDeclaration = z.infer<typeof LinkDeclaration>;

export const ProductDeclaration = z
  .strictObject({
    schema: z.literal('product@1'),
    id: ProductId,
    title: z.string().min(1),
    variables: z.array(VariableDeclaration).optional(),
    applicability:z.strictObject({grammar:Versioned,closed_sets:z.partialRecord(ApplicabilityFieldSchema.exclude(['memory','builds']),z.string().min(1)),build_validator:PackFunctionRef.optional()}).optional().describe('Published applicability-domain declarations; values come from the root variable snapshot'),
    names: z.array(z.string().min(1)).min(1).describe('every name of the product; each resolves to this line'),
    sync: SyncDeclaration.optional(),
    select_build: PackFunctionRef.optional().describe('SelectBuildInput -> SelectBuildOutput; without it the newest released build of the line is chosen'),
    links: z.array(LinkDeclaration).max(32).optional(),
    catalogs: z.array(CatalogDeclaration),
    producers: z.array(Producer),
    command_policy: CommandPolicy.optional(),
    feeding: z.strictObject({project:PackFunctionRef,normalize_line:PackFunctionRef.optional(),verify_command:PackFunctionRef.optional(),classifications:PackFunctionRef.optional()}).optional().describe('Native-source projection and declared grammar callbacks for feeding; no Hub business parser'),
  })
  .superRefine((p, ctx) => {
    const declared = new Set<string>();
    for (const [i, variable] of (p.variables ?? []).entries()) {
      if (declared.has(variable.name)) ctx.addIssue({code:'custom',path:['variables',i,'name'],message:`变量名字重复：${variable.name}`});
      declared.add(variable.name);
    }
    const checkKeys = (value:unknown):void => {
      if(!value || typeof value!=='object')return;
      for(const [key,child] of Object.entries(value)){
        if(/\$\{(?:var|secret):/i.test(key))ctx.addIssue({code:'custom',path:[],message:'变量引用必须占满一个值，引用不能作为属性名'});
        checkKeys(child);
      }
    };
    checkKeys(p);
    const used = new Set<string>();
    try {
      for (const ref of referencesIn(p)) {
        const allowed = ref.at.startsWith('/sync/options/') || /^\/producers\/[0-9]+\/params\//.test(ref.at);
        if (ref.kind !== 'var' || !allowed || !declared.has(ref.name)) ctx.addIssue({code:'custom',path:[],message:`${ref.at}：只能在 sync.options 或生产器 params 里引用已声明的普通变量`});
        used.add(ref.name);
      }
    } catch (error) {
      if (!(error instanceof VariableInputError)) throw error;
      ctx.addIssue({code:'custom',path:[],message:error.message});
    }
    for (const name of declared) if (!used.has(name)) ctx.addIssue({code:'custom',path:['variables'],message:`变量 ${name} 声明了却没有引用`});
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
    const ids = (p.links ?? []).map(rule => rule.id);
    if (new Set(ids).size !== ids.length) ctx.addIssue({code:'custom',path:['links'],message:'link ids must be unique'});
    const producers = new Set(p.producers.map((x) => x.id));
    for(const [index,rule] of (p.links??[]).entries())for(const field of ['target_producers','source_producers'] as const){
      for(const id of rule[field]??[])if(!producers.has(id))ctx.addIssue({code:'custom',path:['links',index,field],message:'a scoped producer must be declared by this product'});
    }

    p.catalogs.forEach((c, i) => {
      if (c.producer !== undefined && !producers.has(c.producer)) {
        ctx.addIssue({ code: 'custom', path: ['catalogs', i, 'producer'], message: `catalog ${c.id} names the producer ${c.producer}, which the pack does not declare` });
      }
    });
  });
export type ProductDeclaration = z.infer<typeof ProductDeclaration>;

export const schemas: Record<string, z.ZodType> = {
  'product@1': ProductDeclaration,
  'build-info@1': BuildInfo,
  'sync-plan-input@1': SyncPlanInput,
  'sync-plan-output@1': SyncPlanOutput,
  'select-build-input@1': SelectBuildInput,
  'select-build-output@1': SelectBuildOutput,
  'command-policy@1': CommandPolicy,
  'producer-input@1': ProducerInput,
  'producer-output@1': ProducerOutput,
};
