// Pack file formats (T01): pack.json, requirements.json, checks.json, slots.schema.json, workflow.json, knowledge.json and the
// samples. The product pack profile (product.json) is in product.ts, the system pack profile (system.json) in resources.ts.
// The runs package validates a pack against these shapes at publish, freezes the parts a run uses at start_run and runs the
// engine on them; the packs package writes packs in these shapes. Product dialect is data and pack functions, never core code.
// Register every record or pack-file schema in `schemas`; contracts/src/index.ts merges them into SCHEMA_REGISTRY.
import { z } from 'zod';
import {
  AcceptedProducerSchema,
  CheckTierSchema,
  DoneRuleSchema,
  ErrorHandlingSchema,
  LayerSchema,
  LeaseOpSchema,
  PackKindSchema,
  SAMPLE_SOURCE,
  SampleSourceSchema,
  SourceRoleSchema,
  TargetSchema,
  VerdictSchema,
  type PackKind,
  type SampleSource,
  type Target,
} from '../generated/vocabulary.ts';
import { PACK_FILE_PATHS } from '../generated/protocol.ts';
import { ItemId, IsoTime, JsonPointer, PackId, PackVersion, Sha256, Versioned } from './common.ts';
import { FragmentRef, PackFunctionRef } from './product.ts';
import { ExternalObjectId, Ground, ReferenceUri } from './reference.ts';
import { ExternalType } from './resources.ts';

// ---------------------------------------------------------------- paths

const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

/** Top-level names a pack may contain, from the generated file list: names ending in / are directories. */
const ROOTS = (() => {
  const files = new Set<string>();
  const dirs = new Set<string>();
  for (const entry of PACK_FILE_PATHS) (entry.endsWith('/') ? dirs : files).add(entry.replace(/\/$/, '').split('/')[0]);
  return { files, dirs };
})();

/** Why a path cannot be a pack file path, or null: relative, no empty, dot or .. segment, ASCII names, a known top-level name. */
export function packPathProblem(path: string): string | null {
  if (path.length === 0 || path.length > 200) return 'the path is empty or longer than 200 characters';
  const segments = path.split('/');
  if (!segments.every((s) => SEGMENT.test(s) && !s.endsWith('.'))) return 'a segment is empty, hidden or has a character outside letters, digits, _ . -';
  const [top, ...rest] = segments;
  if (rest.length === 0 ? !ROOTS.files.has(top) && !ROOTS.dirs.has(top) : !ROOTS.dirs.has(top)) return `${top} is not a place packs keep files`;
  if (rest.length === 0 && ROOTS.dirs.has(top) && !ROOTS.files.has(top)) return `${top} is a folder; name a file in it`;
  return null;
}

export const PackPath = z.string().superRefine((p, ctx) => {
  const problem = packPathProblem(p);
  if (problem !== null) ctx.addIssue({ code: 'custom', message: problem });
});
export type PackPath = z.infer<typeof PackPath>;

// ---------------------------------------------------------------- pack.json

export const PackFileEntry = z.strictObject({
  path: PackPath,
  sha256: Sha256,
  size: z.number().int().nonnegative(),
});
export type PackFileEntry = z.infer<typeof PackFileEntry>;

/** Files a pack of each kind must contain besides pack.json. A kind added to the model fails to compile until it is listed. */
export const REQUIRED_FILES = {
  product: ['product.json'],
  workflow: ['workflow.json', 'requirements.json', 'checks.json', 'slots.schema.json', 'SKILL.md'],
  system: ['system.json'],
} as const satisfies Record<PackKind, readonly string[]>;

/**
 * The pack identity and its file list with SHA-256 (T01 F[0]). The pack digest is the SHA-256 of the RFC 8785 canonical JSON of
 * this manifest, so any changed byte changes the digest a publication is bound to. The owner is the publisher, not a field.
 */
export const PackManifest = z
  .strictObject({
    schema: z.literal('pack@1'),
    id: PackId,
    version: PackVersion,
    kind: PackKindSchema,
    title: z.string().min(1),
    description: z.string().min(1),
    files: z.array(PackFileEntry).describe('every file of the pack except pack.json, sorted by path'),
  })
  .superRefine((m, ctx) => {
    const seen = new Set<string>();
    let previous = '';
    m.files.forEach((f, i) => {
      const key = f.path.toLowerCase();
      if (f.path === 'pack.json') ctx.addIssue({ code: 'custom', path: ['files', i, 'path'], message: 'pack.json is not listed in its own manifest' });
      if (seen.has(key)) ctx.addIssue({ code: 'custom', path: ['files', i, 'path'], message: `${f.path} is listed twice (paths compare without case)` });
      seen.add(key);
      if (f.path < previous) ctx.addIssue({ code: 'custom', path: ['files', i, 'path'], message: 'files are sorted by path' });
      previous = f.path;
    });
    for (const required of REQUIRED_FILES[m.kind]) {
      if (!seen.has(required.toLowerCase())) ctx.addIssue({ code: 'custom', path: ['files'], message: `a ${m.kind} pack contains ${required}` });
    }
  });
export type PackManifest = z.infer<typeof PackManifest>;

// ---------------------------------------------------------------- requirements.json (W02)

const Key = z.string().regex(/^[a-z][a-z0-9_]*$/, 'lowercase letters, digits and underscores');

/** One row of the error handling table: a violation code (or * for any other) and what happens to a requirement that shows it. */
export const ErrorHandlingRow = z
  .strictObject({
    code: z.string().min(1).describe('a core violation code, a pack code, or * for any other'),
    action: ErrorHandlingSchema,
    max_rounds: z.number().int().min(1).max(10).optional().describe('repair rounds for the whole requirement; required when the action is repair'),
  })
  .superRefine((r, ctx) => {
    if ((r.action === 'repair') !== (r.max_rounds !== undefined)) ctx.addIssue({ code: 'custom', path: ['max_rounds'], message: 'a repair row names its rounds and only a repair row does' });
  });
export type ErrorHandlingRow = z.infer<typeof ErrorHandlingRow>;

/**
 * What a check is expected to say: support, unless an item field says otherwise. A negative case expects the refutation the
 * check gives (for example a parameter out of range); an outcome that matches is satisfied (V03), one that does not is not.
 */
export const ExpectedOutcome = z.strictObject({
  overrides: z
    .array(
      z.strictObject({
        when: z.strictObject({ pointer: JsonPointer.describe('into the item fields'), equals: z.union([z.string(), z.number(), z.boolean()]) }),
        outcome: VerdictSchema.extract(['refute']),
        codes: z.array(z.string().min(1)).min(1).describe('the refutation codes that meet the expectation'),
      }),
    )
    .min(1),
});
export type ExpectedOutcome = z.infer<typeof ExpectedOutcome>;

export const RequirementTemplate = z
  .strictObject({
    key: Key,
    name: z.string().min(1),
    description: z.string().min(1),
    target: TargetSchema.describe('item: judged for every item; run: one judgment over the whole target (a cross-item claim)'),
    required: z.boolean().describe('a gating run needs every required requirement satisfied (V06 R[2])'),
    done_rule: DoneRuleSchema,
    layers: z.array(LayerSchema).min(1),
    accepted_producer: AcceptedProducerSchema,
    independent_of: z.literal('predecessor').optional().describe('an independent judgment is satisfied only by another session and model than the predecessor run (A04)'),
    accepts_declared_independence: z.boolean().optional().describe('accept the independence the client declares (A04 R[4]); not accepted when absent'),
    checks: z.array(Key).describe('ids from checks.json that judge this requirement; none means no check is installed (reason no_check)'),
    expected: ExpectedOutcome.optional(),
    error_handling: z.array(ErrorHandlingRow),
    requires_discrimination: z.boolean().optional(),
  })
  .superRefine((r, ctx) => {
    if ((r.accepted_producer === 'independent_judgment') !== (r.independent_of !== undefined)) {
      ctx.addIssue({ code: 'custom', path: ['independent_of'], message: 'an independent judgment names what it is independent of, and only one does' });
    }
    if (r.accepted_producer === 'fact' && r.target === 'run' && r.checks.length === 0) {
      ctx.addIssue({ code: 'custom', path: ['checks'], message: 'a fact over the whole target needs a check' });
    }
    const codes = r.error_handling.map((e) => e.code);
    codes.forEach((c, i) => {
      if (codes.indexOf(c) !== i) ctx.addIssue({ code: 'custom', path: ['error_handling', i, 'code'], message: `code ${c} is handled twice` });
    });
  });
export type RequirementTemplate = z.infer<typeof RequirementTemplate>;

export const RequirementsFile = z
  .strictObject({
    schema: z.literal('requirements@1'),
    requirements: z.array(RequirementTemplate).min(1),
  })
  .superRefine((f, ctx) => {
    f.requirements.forEach((r, i) => {
      if (f.requirements.findIndex((x) => x.key === r.key) !== i) ctx.addIssue({ code: 'custom', path: ['requirements', i, 'key'], message: `requirement ${r.key} is declared twice` });
    });
  });
export type RequirementsFile = z.infer<typeof RequirementsFile>;

// ---------------------------------------------------------------- checks.json (C05)

/** A build of the bound product as the run context lists it: no sources and no root digest; `has_root` says the tree exists. */
export const ContextBuild = z.strictObject({
  name: z.string().min(1).describe('build name exactly as listed'),
  family: z.string().min(1).describe('which of the product names the build carries'),
  line: z.string().min(1).describe('version line the pack assigns to the build'),
  base: z.string().min(1).describe('the build whose tree this build uses; equals name when the build has its own tree'),
  platform: z.string().min(1).nullable().describe('platform or customer branch; null for the main platform'),
  built_at: IsoTime.nullable(),
  released_at: IsoTime.nullable().describe('null while unreleased'),
  has_root: z.boolean().describe('whether the knowledge base has produced the root of the build’s tree'),
});
export type ContextBuild = z.infer<typeof ContextBuild>;

/** The run-context parts a workflow may ask for beyond the defaults (W06): the builds of the bound product, and the leases of the declared prefixes. */
export const CONTEXT_KEY = ['builds', 'leases'] as const;
export type ContextKey = (typeof CONTEXT_KEY)[number];
export const ContextKeySchema = z.enum(CONTEXT_KEY);

/** Facts about the run that checks and pack functions may use. */
export const RunContext = z.strictObject({
  product: z.string().nullable(),
  names: z.array(z.string()).describe('every name of the bound product line (all of them name one line); empty when the run has no product'),
  line: z.string().nullable(),
  build: z.string().nullable(),
  root: Sha256.nullable(),
  parameters: z.record(z.string(), z.unknown()),
  groups: z.array(z.record(z.string(), z.unknown())).describe('the groups the projection function returned, frozen with the run'),
  builds: z
    .array(ContextBuild)
    .optional()
    .describe(
      'every build the knowledge base knows for the bound product, sorted by (line, built_at, name); present only when the workflow asked for it (workflow.context) and the run is bound to a product — absent then means "not asked", not "none known"',
    ),
  leases: z
    .strictObject({
      now: IsoTime.describe('the moment the lease table was frozen for this run'),
      entries: z
        .array(z.strictObject({ key: z.string().min(1), until: IsoTime, mine: z.boolean() }))
        .describe('the unexpired, unreleased rows of the declared prefixes at the frozen moment; no tokens, no other holders\' names — visibility is undecided (D04 changes5)'),
    })
    .optional()
    .describe('present only when the workflow asked for the leases context (workflow.context)'),
});
export type RunContext = z.infer<typeof RunContext>;

/** An item as a check subject builder sees it. */
export const SubjectItem = z.strictObject({ id: ItemId, label: z.string(), location: ReferenceUri, fields: z.record(z.string(), z.unknown()) });
export type SubjectItem = z.infer<typeof SubjectItem>;

/** An exact value of a submission as resolved at the boundary: the reference, whether it resolved and the source it resolved into. */
export const ResolvedEvidence = z.strictObject({
  reference: ReferenceUri,
  resolved: z.boolean(),
  source: Sha256.nullable().describe('digest of the stored source the reference resolves into'),
  role: SourceRoleSchema.nullable().describe('the role that source plays in the run'),
  text: z.string().nullable().describe('the text of the fragment, when the reader may have it'),
});
export type ResolvedEvidence = z.infer<typeof ResolvedEvidence>;

/**
 * Input of a subject builder of a check with applies `run`: every item of the run. The default subject (no builder) is
 * `{ items: [{ id, label, location, fields }] }`.
 */
export const RunSubjectInput = z.strictObject({ applies: z.literal('run'), items: z.array(SubjectItem), context: RunContext });
/**
 * Input of a subject builder of a check with applies `item`: one item, its slot record (null while nothing was submitted) and
 * the evidence references of that slot record with their resolution. The default subject is
 * `{ item, label, location, fields, slots, evidence }`.
 */
export const ItemSubjectInput = z.strictObject({
  applies: z.literal('item'),
  item: SubjectItem,
  slots: z.record(z.string(), z.unknown()).nullable(),
  evidence: z.array(ResolvedEvidence),
  context: RunContext,
});
export type RunSubjectInput = z.infer<typeof RunSubjectInput>;
export type ItemSubjectInput = z.infer<typeof ItemSubjectInput>;

export const MAX_CHECK_READ_BYTES = 1024 * 1024; // 1 MiB

export const CheckReads = z.strictObject({
  roles: z.array(SourceRoleSchema).min(1).describe('source roles whose bound sources are read into sources for this check'),
  types: z
    .array(ExternalType)
    .min(1)
    .optional()
    .describe('external object types system:type whose bound sources are read; when set, sources without external identity are not read'),
  max_bytes: z.number().int().positive().optional().describe('most bytes read per bound source; at most 1 MiB (default 1 MiB)'),
});
export type CheckReads = z.infer<typeof CheckReads>;

export const CheckEntry = z
  .strictObject({
    id: Key,
    title: z.string().min(1).optional(),
    interpreter: Versioned.optional().describe('a core interpreter such as structure@1'),
    function: PackFunctionRef.optional().describe('a pack function with the PackCheckInput of hub/rules'),
    table: PackPath.optional().describe('the table the interpreter reads, under tables/ or policies/'),
    applies: TargetSchema.describe('run: one subject for all items, built once; item: one subject per item (with its submitted slots)'),
    subject: PackFunctionRef.optional().describe('builds the subject from RunSubjectInput or ItemSubjectInput; without it the default subject of that input is used'),
    catalog: Versioned.optional().describe('the catalog of the locked root the check consults'),
    judges: SourceRoleSchema.describe('the role of what the check judges (A03): the target, an expected source or the artifact under verification'),
    tier: CheckTierSchema.optional().describe('replaces the tier of every outcome; required on publication, legacy published packs fall back to basis'),
    basis: z.string().min(1).optional().describe('the acceptance contract clause a blocking check relies on (C05 R[1])'),
    reads: CheckReads.optional().describe('bound sources of these roles are read into sources for this check'),
  })
  .superRefine((c, ctx) => {
    if ((c.interpreter === undefined) === (c.function === undefined)) ctx.addIssue({ code: 'custom', path: ['interpreter'], message: 'a check names a core interpreter or a pack function, not both and not neither' });
    if (c.interpreter !== undefined && c.table === undefined) ctx.addIssue({ code: 'custom', path: ['table'], message: 'an interpreter check reads a table' });
  });
export type CheckEntry = z.infer<typeof CheckEntry>;

export const ChecksFile = z
  .strictObject({ schema: z.literal('checks@1'), checks: z.array(CheckEntry) })
  .superRefine((f, ctx) => {
    f.checks.forEach((c, i) => {
      if (f.checks.findIndex((x) => x.id === c.id) !== i) ctx.addIssue({ code: 'custom', path: ['checks', i, 'id'], message: `check ${c.id} is declared twice` });
    });
  });
export type ChecksFile = z.infer<typeof ChecksFile>;

// ---------------------------------------------------------------- slots.schema.json (W05)

/** A member of a closed set the pack declares: finding codes, ranking levels. Ranking sets are ordered, strongest first. */
export const ClosedValue = z.strictObject({ code: z.string().min(1), label: z.string().min(1) });
export const ClosedSet = z
  .array(ClosedValue)
  .min(1)
  .superRefine((values, ctx) => {
    values.forEach((v, i) => {
      if (values.findIndex((x) => x.code === v.code) !== i) ctx.addIssue({ code: 'custom', path: [i, 'code'], message: `${v.code} is listed twice` });
    });
  });
export type ClosedSet = z.infer<typeof ClosedSet>;

/** An exact value the model quotes: the text must be verbatim in the fragment the reference resolves to (T03, QUOTE_MISMATCH). */
export const SlotQuote = z.strictObject({ reference: ReferenceUri, text: z.string().min(1) });
/** A command the statement mentions; `present` says the statement claims it exists (true) or does not exist (false). */
export const SlotCommand = z.strictObject({ command: z.string().min(1), present: z.boolean().optional() });

/**
 * The one shape of a model's statement in a slot record or a cross-item entry. The pack narrows `code` and `rank` to its
 * closed sets and may constrain `data`; the Hub turns every statement into a claim, resolves its quotations, references and
 * commands at the boundary, and never trusts what it says about itself.
 */
export const SlotClaim = z.strictObject({
  text: z.string().min(1),
  code: z.string().min(1).optional(),
  rank: z.string().min(1).optional(),
  location: ReferenceUri.optional().describe('where in the judged source the statement applies'),
  grounds: z.array(Ground).optional(),
  quotes: z.array(SlotQuote).optional(),
  commands: z.array(SlotCommand).optional(),
  data: z.record(z.string(), z.unknown()).optional().describe('machine-readable parts the pack defines'),
});
export type SlotClaim = z.infer<typeof SlotClaim>;

export const SlotDeclaration = z.strictObject({
  codes: ClosedSet.optional().describe('allowed claim codes; without it a claim carries none'),
  ranks: ClosedSet.optional().describe('allowed ranking levels, strongest first; without it a claim carries none'),
  max: z.number().int().min(1).optional().describe('most claims per item (or in the run); default unbounded within the size limit'),
  min: z.number().int().min(0).optional().describe('fewest claims; 0 allows an explicit "nothing to report" (an empty list)'),
  data: z.record(z.string(), z.unknown()).optional().describe('JSON Schema 2020-12 of SlotClaim.data'),
  evidence: z.boolean().optional().describe('every claim needs a ground or a quotation of its own that resolves'),
});
export type SlotDeclaration = z.infer<typeof SlotDeclaration>;

/**
 * Per judgment requirement the statements the model may write. `item` is keyed by the requirement key of an item-level
 * requirement (slot record: { <key>: SlotClaim[] }); `run` by the key of a run-level requirement (cross-item claims whose code
 * belongs to that requirement's codes).
 */
export const SlotsFile = z
  .strictObject({
    schema: z.literal('slots@1'),
    item: z.record(Key, SlotDeclaration),
    run: z.record(Key, SlotDeclaration),
  })
  .superRefine((f, ctx) => {
    const codeOwner = new Map<string, string>();
    for (const [key, decl] of Object.entries(f.run)) {
      if (!decl.codes) ctx.addIssue({ code: 'custom', path: ['run', key, 'codes'], message: 'a run-level requirement is identified by its codes' });
      for (const c of decl.codes ?? []) {
        const owner = codeOwner.get(c.code);
        if (owner !== undefined) ctx.addIssue({ code: 'custom', path: ['run', key, 'codes'], message: `code ${c.code} already identifies ${owner}` });
        codeOwner.set(c.code, key);
      }
    }
  });
export type SlotsFile = z.infer<typeof SlotsFile>;

// ---------------------------------------------------------------- workflow.json (W03)

export const WorkflowInput = z.strictObject({
  slot: Key,
  role: SourceRoleSchema,
  description: z.string().min(1),
  accepts: z.array(z.string().min(1)).min(1).describe('media types, or external object types written system:type'),
  required: z.boolean(),
  many: z.boolean(),
});
export type WorkflowInput = z.infer<typeof WorkflowInput>;

export const WorkflowParameter = z.strictObject({
  name: Key,
  description: z.string().min(1),
  required: z.boolean(),
  schema: z.record(z.string(), z.unknown()).optional().describe('JSON Schema 2020-12 of the value'),
});
export type WorkflowParameter = z.infer<typeof WorkflowParameter>;

export const WorkflowFile = z
  .strictObject({
    schema: z.literal('workflow@1'),
    inputs: z.array(WorkflowInput).min(1),
    parameters: z.array(WorkflowParameter),
    product: z
      .strictObject({
        id: z.string().optional().describe('the one product line this workflow serves; without it the line is chosen at start_run among those that declare the catalogs'),
        catalogs: z.array(Versioned).describe('catalogs the product must provide'),
      })
      .describe('the product binding (W03 R[5]): one line, whatever the names it is known by'),
    context: z
      .array(ContextKeySchema)
      .optional()
      .describe('the run-context parts this workflow asks for beyond the defaults, for example builds: the knowledge base builds of the bound product, frozen with the run'),
    subject: Key.describe('the input slot that holds the judged source'),
    projection: PackFunctionRef.describe('ProjectionInput -> ProjectionOutput: the items of the run (W01)'),
    expected_sources: PackFunctionRef.optional().describe('ExpectedSourcesInput -> ExpectedSourcesOutput: external objects to bind as expected sources'),
    leases: z
      .strictObject({
        prefix: z.string().min(1).regex(/\/$/, 'the lease prefix ends with / (keys of this workflow live under it)'),
        max_ttl_seconds: z.number().int().positive().max(2_592_000).describe('the ceiling of one lease request\'s TTL and of the cumulative extension (D04 R[0])'),
      })
      .optional()
      .describe('the lease namespace this workflow may acquire under (the keys of its lease_requests start with the prefix)'),
  })
  .superRefine((w, ctx) => {
    if (w.leases !== undefined && !(w.context ?? []).includes('leases')) {
      ctx.addIssue({ code: 'custom', path: ['leases'], message: 'a workflow that declares leases asks for the leases context (context: ["leases"])' });
    }
    if (!w.inputs.some((i) => i.slot === w.subject)) ctx.addIssue({ code: 'custom', path: ['subject'], message: 'the subject names an input slot' });
    w.inputs.forEach((i, k) => {
      if (w.inputs.findIndex((x) => x.slot === i.slot) !== k) ctx.addIssue({ code: 'custom', path: ['inputs', k, 'slot'], message: `slot ${i.slot} is declared twice` });
    });
    w.parameters.forEach((p, k) => {
      if (w.parameters.findIndex((x) => x.name === p.name) !== k) ctx.addIssue({ code: 'custom', path: ['parameters', k, 'name'], message: `parameter ${p.name} is declared twice` });
    });
    w.context?.forEach((key, k) => {
      if (w.context!.findIndex((x) => x === key) !== k) ctx.addIssue({ code: 'custom', path: ['context', k], message: `context key ${key} is declared twice` });
    });
  });
export type WorkflowFile = z.infer<typeof WorkflowFile>;

// ---------------------------------------------------------------- workflow functions: projection and expected sources

/** A source bound to a slot, parsed with a core parser, as the workflow functions receive it. */
export const BoundInput = z.strictObject({
  slot: Key,
  external: ExternalObjectId.nullable().describe('the external object the source was read from; null for an upload'),
  sha256: Sha256,
  media_type: z.string(),
  parser: Versioned,
  model: z.unknown().describe('the parsed model (the structure the parser gives selectors into)'),
  meta: z.record(z.string(), z.unknown()).nullable().describe('what the system pack derived about the external object, such as its title and the folders above it'),
});
export type BoundInput = z.infer<typeof BoundInput>;

export const PackWarning = z.strictObject({
  code: z.string().min(1),
  message: z.string(),
  document: z.string().optional(),
  item: z.string().optional(),
  node: z.string().optional(),
  data: z.record(z.string(), z.unknown()).optional(),
});
export type PackWarning = z.infer<typeof PackWarning>;

/** A refusal: the whole call produced nothing usable. */
export const PackError = z.strictObject({ code: z.string().min(1), message: z.string(), fix: z.string(), documents: z.array(z.string()).optional() });
export type PackError = z.infer<typeof PackError>;
export const PackFailure = z.strictObject({ error: PackError, warnings: z.array(PackWarning) });
export type PackFailure = z.infer<typeof PackFailure>;

export const ProjectionInput = z.strictObject({
  inputs: z.array(BoundInput),
  parameters: z.record(z.string(), z.unknown()),
  context: RunContext,
});
export type ProjectionInput = z.infer<typeof ProjectionInput>;

/** An item as the projection function returns it: the Hub adds the source digest and forms the location reference. */
export const ProjectedItem = z.strictObject({
  id: ItemId,
  label: z.string(),
  summary: z.string().optional().describe('one short line the model reads about the item next to its id and label (a tool result is read as text and must stay small); the full fields remain in the structured answer'),
  location: FragmentRef,
  fields: z.record(z.string(), z.unknown()),
});
export type ProjectedItem = z.infer<typeof ProjectedItem>;

export const ProjectionOutput = z.union([
  z.strictObject({
    items: z.array(ProjectedItem),
    groups: z.array(z.record(z.string(), z.unknown())).optional(),
    warnings: z.array(PackWarning),
    lease_requests: z
      .array(
        z.union([
          z.strictObject({ op: LeaseOpSchema.extract(['acquire']).optional(), keys: z.array(z.string().min(1)).min(1), ttl_seconds: z.number().int().positive() }).describe('acquire (the default): every key free (or taken over from expired/released rows), all or nothing'),
          z.strictObject({ op: LeaseOpSchema.extract(['extend']), keys: z.array(z.string().min(1)).min(1), ttl_seconds: z.number().int().positive() }).describe('extend: the lineage-held leases of these keys grow by ttl_seconds from now, inside the cumulative cap'),
          z.strictObject({ op: LeaseOpSchema.extract(['release']), keys: z.array(z.string().min(1)).min(1) }).describe('release: the lineage-held leases of these keys end now (not undone when the run later fails)'),
        ]),
      )
      .optional()
      .describe('the lease operations the run asks the Hub to perform before it is stored (extend and release checks run first; a failing acquire later compensates the ones already granted); keys must sit under the workflow\'s declared prefix and the TTL under its cap'),
  }),
  PackFailure,
]);
export type ProjectionOutput = z.infer<typeof ProjectionOutput>;

export const ExpectedSourcesInput = ProjectionInput.extend({ items: z.array(ProjectedItem) });
export type ExpectedSourcesInput = z.infer<typeof ExpectedSourcesInput>;

export const ExpectedSource = z.strictObject({
  external: ExternalObjectId,
  role: SourceRoleSchema.extract(['expected', 'hint']),
  reason: z.string().describe('why this source was bound, in Chinese'),
});
export type ExpectedSource = z.infer<typeof ExpectedSource>;

export const ExpectedSourcesOutput = z.union([z.strictObject({ sources: z.array(ExpectedSource), warnings: z.array(PackWarning) }), PackFailure]);
export type ExpectedSourcesOutput = z.infer<typeof ExpectedSourcesOutput>;

// ---------------------------------------------------------------- knowledge.json (K01, C07)

export const KnowledgeFile = z.strictObject({
  schema: z.literal('knowledge@1'),
  requires: z.array(
    z.strictObject({
      catalog: Versioned,
      complete: z.boolean().describe('needs the catalog declared complete for the scope of the root, so that absence is a fact'),
    }),
  ),
});
export type KnowledgeFile = z.infer<typeof KnowledgeFile>;

// ---------------------------------------------------------------- samples (T02)

/** Where a sample comes from (T02 R[1]); the publish check reports the counts per source. */
export const SAMPLE_SOURCES = SAMPLE_SOURCE;
export type { SampleSource };

/** What a check must say about the sample subject: every outcome in order, with the fields that must match. */
export const SampleExpectation = z.strictObject({
  verdict: VerdictSchema,
  code: z.string().optional(),
  reason: z.string().optional(),
  tier: CheckTierSchema.optional(),
  item: z.string().optional(),
});

export const SampleUnreadSource = z.strictObject({
  reference: ReferenceUri,
  reason: z.string().min(1),
  external: ExternalObjectId.optional().describe('external object identity when the bound source had one'),
  slot: z.string().optional().describe('input slot when the bound source had one'),
});
export type SampleUnreadSource = z.infer<typeof SampleUnreadSource>;

export const PackSample = z.strictObject({
  id: Key,
  source: SampleSourceSchema,
  check: Key.describe('the check of checks.json this sample exercises'),
  note: z.string().optional(),
  subject: z.unknown().describe('the subject exactly as the check receives it after the subject builder'),
  sources: z.record(z.string(), z.string()).optional().describe('fragment texts by reference for quotation checks'),
  unread_sources: z.array(SampleUnreadSource).optional().describe('sources that could not be read or exceeded max bytes'),
  catalog: z.unknown().optional().describe('catalog entries the check consults (catalog@1 spec of hub/rules)'),
  expect: z.array(SampleExpectation),
});
export type PackSample = z.infer<typeof PackSample>;

export const schemas: Record<string, z.ZodType> = {
  'pack@1': PackManifest,
  'requirements@1': RequirementsFile,
  'checks@1': ChecksFile,
  'slots@1': SlotsFile,
  'workflow@1': WorkflowFile,
  'knowledge@1': KnowledgeFile,
  'pack-sample@1': PackSample,
  'projection-input@1': ProjectionInput,
  'projection-output@1': ProjectionOutput,
  'expected-sources-input@1': ExpectedSourcesInput,
  'expected-sources-output@1': ExpectedSourcesOutput,
  'run-subject-input@1': RunSubjectInput,
  'item-subject-input@1': ItemSubjectInput,
  'slot-claim@1': SlotClaim,
};
