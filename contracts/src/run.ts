import {CommandPolicy} from './product.ts';
import {FeedingOffsetSchema, ModelIdentitySchema} from '../generated/shared-interfaces.ts';
import {AcceptedCriterionRef,CriterionNotice} from './criterion.ts';
// Run (W06), item projection (W01), source binding (P02) and the summaries start_run and list_task_packs return.
import { WorkflowOutputs } from './contributions.ts';
import { z } from 'zod';
import { SkillLocks } from './skills.ts';
import {
  AcceptedProducerSchema,
  AggregationSchema,
  DoneRuleSchema,
  ExecutionHostSchema,
  LayerSchema,
  LeaseOpSchema,
  PackKindSchema,
  SourceRoleSchema,
  TriggerSchema,
} from '../generated/vocabulary.ts';
import { Claim } from './claim.ts';
import { Coverage, Versioned, IsoTime, ItemId, LeaseId, PackId, PackVersion, RunId, Sha256, UserId } from './common.ts';
import { ContextBuild, IndexBindingDefault, LeaseContextRow, LeaseRegistrationRow, PredecessorInputDefault, RunResultSource } from './pack.ts';
import { ExternalObjectId, ReferenceUri, referenceUriOf } from './reference.ts';

/** One input given to start_run: bytes already uploaded, or an external object the Hub reads (read-only) with the pack's system adapter. Exactly one key. */
export const InputBinding = z.union([
  z.strictObject({ reference: ReferenceUri.describe('reference returned by upload_file, or any reference the caller may read') }),
  z.strictObject({ external: ExternalObjectId.describe('external object identity system:type:id[@revision], of a type the input slot accepts') }),
  z.strictObject({ run: RunId.describe('a run whose latest accepted submitted validation record this slot binds, when the slot declares from_runs') }),
]);
export type InputBinding = z.infer<typeof InputBinding>;

/** A source bound to the run (P02), with the role it plays (A03). Inputs carry their slot; sources the pack bound itself carry none. */
export const SourceBinding = z.strictObject({
  artifact:Sha256.optional().describe('Exact source_artifact record returned by this read, independent of equal-byte captures'),
  read_manifest:Sha256.optional().describe('Observed read action that returned this exact capture'),
  meta_artifact:Sha256.optional().describe('Exact metadata source_artifact returned by the same read'),
  coverage:Coverage.optional().describe('Observed coverage of the external read frozen with these bytes; absent on legacy bindings'),
  reference: ReferenceUri.describe('the bound bytes or fragment; read it with get_nodes'),
  role: SourceRoleSchema,
  slot: z.string().optional().describe('input slot the source came in through'),
  external: ExternalObjectId.optional().describe('external object identity with the revision the Hub read'),
  media_type: z.string().optional(),
  label: z.string().optional().describe('display name, for example the title of a linked record'),
});
export type SourceBinding = z.infer<typeof SourceBinding>;

/** An item the pack's projection function produced from the judged source. The Hub core never interprets `fields`. */
export const ItemProjection = z.strictObject({
  id: ItemId,
  label: z.string(),
  summary: z.string().optional().describe('one short line the model reads about the item (from the pack projection); the text of a tool result is limited, so a long list of items is shown as id, label and summary only'),
  location: ReferenceUri.describe('where the item sits in the judged source'),
  fields: z.record(z.string(), z.unknown()),
  digest: Sha256.optional().describe('item fingerprint the Hub computes from the canonical fields; unchanged across runs means the item can be carried over'),
  reuse: referenceUriOf('rec')
    .optional()
    .describe('set by the Hub when the predecessor run has an unchanged item: the Hub record reference to give back in the submission to carry it over'),
});
export type ItemProjection = z.infer<typeof ItemProjection>;

export const RequirementSummary = z.strictObject({
  independence_by_account:z.boolean().optional(),
  key: z.string(),
  name: z.string(),
  description: z.string(),
  layers: z.array(LayerSchema).describe('the judgment layers this requirement is judged on; other layers are not applicable'),
  done_rule: DoneRuleSchema,
  accepted_producer: AcceptedProducerSchema,
  observation:Versioned.optional().describe('The declared P07 observation contract for the dynamic layer'),
  repair_rounds: z.number().int().nonnegative(),
  rules: z.array(z.string().min(1)).describe('locked rule@version identities that judge this requirement'),
  run_interpreters: z.array(Versioned).describe('ledger-permitted interpreters for inline runtime tables; empty when disabled'),
  repetition: z
    .strictObject({
      count: z.number().int().min(1).max(10),
      aggregation: AggregationSchema,
      k: z.number().int().min(1).max(10).optional(),
      basis: z.enum(['explicit', 'work_class', 'single_round']).describe('explicit: a field was written; work_class: the pack\u2019s class default; single_round: no class, or a static-only requirement'),
      declared: z.strictObject({ count: z.boolean(), aggregation: z.boolean(), k: z.boolean() }).describe('which parts the pack wrote itself'),
      fresh_context: z.boolean().optional(),
      baseline_first: z.boolean().optional(),
      window_seconds: z.number().int().min(1).max(86400).optional(),
    })
    .optional()
    .describe('V07: the repetition policy in force for this requirement, frozen with the run; absent on records stored before the field existed'),
});
export type RequirementSummary = z.infer<typeof RequirementSummary>;

export const InputSlotSummary = z.strictObject({
  slot: z.string(),
  role: SourceRoleSchema,
  description: z.string(),
  accepts: z.array(z.string()).describe('media types, or external object types written system:type'),
  required: z.boolean(),
  many: z.boolean(),
  default_from_predecessor: PredecessorInputDefault.optional(),
  from_runs: RunResultSource.optional(),
  index_default: IndexBindingDefault.optional(),
});
export type InputSlotSummary = z.infer<typeof InputSlotSummary>;

export const PackSummary = z.strictObject({
  pack: z.string().describe('id@version'),
  id: PackId,
  version: PackVersion,
  kind: PackKindSchema,
  title: z.string(),
  description: z.string(),
  products: z.array(z.string()).describe('every name of the product line the pack is bound to; all of them name one line'),
  inputs: z.array(InputSlotSummary),
  parameters: z.array(z.strictObject({ name: z.string(), description: z.string(), required: z.boolean(), schema: z.record(z.string(), z.unknown()).optional().describe('JSON Schema 2020-12 of the value, as the pack declares it; absent when the pack declares none') })),
  requirements: z.array(RequirementSummary),
});
export type PackSummary = z.infer<typeof PackSummary>;

/** The frozen slot schema of the run's pack (T01 F[3], W05): what the model may fill for one item. */
export const SlotSchema = z.strictObject({
  schema: z
    .record(z.string(), z.unknown())
    .describe('JSON Schema 2020-12 of the slot record of one item, from the pack file slots.schema.json, with the closed sets the pack declares (finding codes, ranks, slot kinds)'),
  sha256: Sha256.describe('SHA-256 of the pack file the schema comes from'),
});
export type SlotSchema = z.infer<typeof SlotSchema>;

/** A default selected by the Hub at start_run. A result is a complete validation record; an input copy cites the frozen object. */
export const InputDefault = z.strictObject({
  slot: z.string().min(1),
  predecessor: RunId,
  reference: z.union([
    referenceUriOf('rec').refine(reference=>!reference.includes('#'),'a complete validation record is required'),
    referenceUriOf('src'),
    ExternalObjectId,
  ]),
  kind: z.literal('input').optional().describe('present when the Hub copied a frozen predecessor input; absent when it bound an accepted validation record'),
});
export type InputDefault = z.infer<typeof InputDefault>;

export const RunSummary = z.strictObject({
  skills: SkillLocks.optional().describe('Skill package digests frozen at start; absent only on historical runs'),
  feeding_offset:FeedingOffsetSchema.optional().describe('Append-only feeding horizon frozen with the root; missing on a historical run remains unknown'),
  feeding_objects:z.array(Sha256).optional().describe('Objects actually consumed by this run'),
  criterion_changes:z.array(CriterionNotice).optional(),
  run: RunId,
  pack: z.string(),
  pack_digest: Sha256,
  product: z.string().optional().describe('product line the run is bound to'),
  version: z.string().optional(),
  build: z.string().optional(),
  target_basis: z
    .array(Claim)
    .describe('how product, version and build were fixed: one claim each; provenance declared when the caller gave the value, projected when the pack rule chose it, observed when a target echoed it; grounds cite what the choice read'),
  unversioned_root: Sha256.optional().describe('product-wide knowledge root locked for this run'),
  root: Sha256.optional().describe('knowledge root locked for this run'),
  sources: z.array(SourceBinding).describe('every source bound to the run besides the knowledge root: inputs and the expected sources the pack bound'),
  requirements: z.array(RequirementSummary),
  items: z.array(ItemProjection),
  slots: SlotSchema.optional().describe('the slot schema to fill for each item; absent when the pack declares no slots'),
  outputs: WorkflowOutputs.optional(),
  instructions: z.string().describe('the pack procedure, plain text'),
  instructions_digest: Sha256,
  predecessor: RunId.optional(),
  input_defaults: z.array(InputDefault).min(1).refine(rows=>new Set(rows.map(row=>`${row.slot}\0${row.reference}`)).size===rows.length,'defaulted bindings are unique').optional().describe('Hub-selected input defaults frozen at start_run; absent on explicit or historical bindings'),
  session: z.string().optional().describe('client session id observed from the request header'),
  model_identity: ModelIdentitySchema.optional().describe('Explicit client declaration at start; a submission from the same observed session can reuse it'),
  started_at: IsoTime,
  submission_due:IsoTime.optional().describe('Absolute submission deadline; absent only on historical runs, never inferred by readers'),
});
export type RunSummary = z.infer<typeof RunSummary>;

/** Triggers that someone configured beforehand, so the run names its configurer (W09 F[1], R[1]-R[3]). */
const CONFIGURED = TriggerSchema.extract(['event_or_schedule', 'standing_obligation']);

/**
 * Body of a `run` record (run@1): the summary plus what only the Hub needs (W06 F[0]-F[10], W09 F[1], D05 R[4]-R[5]).
 * Phase is derived from records, never stored. A Hub-side run (a standing obligation the Hub executes) has no runner.
 */
// Earlier run@1 snapshots contain only key/until/mine. They remain immutable and readable.
const PersistedLeaseContextRow=LeaseContextRow.partial({since:true,run:true,jobs:true}).superRefine((row,ctx)=>{
  const known=[row.since,row.run,row.jobs].filter(value=>value!==undefined).length;
  if(known!==0&&known!==3||known===0&&row.holder!==undefined)ctx.addIssue({code:'custom',message:'lease snapshot has either all current facts or the historical key/until/mine shape'});
});

// Historical records keep their original bytes; only public summaries require ruling metadata.
const PersistedRequirementSummary=RequirementSummary.partial({rules:true,run_interpreters:true}).superRefine((row,ctx)=>{
  if((row.rules===undefined)!==(row.run_interpreters===undefined))ctx.addIssue({code:'custom',message:'ruling fields are either both present or both absent on a historical row'});
});
export const RunRecord = RunSummary.omit({criterion_changes:true}).extend({
  product_pack_digest:Sha256.optional().describe('Product package digest frozen at admission; absent on historical records'),
  command_policy:CommandPolicy.optional(),
  accepted_criteria:z.array(AcceptedCriterionRef).optional(),
  criterion_requests:z.array(Sha256).optional(),
  criterion_review:z.strictObject({submission:Sha256,requests:z.array(Sha256)}).optional(),
  predecessor_access:z.literal('view').optional(),
  requirements:z.array(PersistedRequirementSummary),
  runner: UserId.optional().describe('the user the run is executed for; absent only when the Hub itself executes a standing obligation'),
  host: ExecutionHostSchema,
  trigger: TriggerSchema,
  configurer: UserId.optional().describe('Hub user who configured the trigger (W09 F[1]); required for event, schedule and standing obligation triggers'),
  parameters: z.record(z.string(), z.unknown()).describe('parameters bound at start_run and frozen'),
  policy: z.string().optional().describe('version of the global boundary policy table used'),
  executors: Sha256.optional().describe('digest of the executor registry used (W06 F[7]); absent while no executor is registered'),
  groups: z.array(z.record(z.string(), z.unknown())).optional().describe('the groups the projection function returned (structure of the judged source that is not an item), frozen with the run and handed to subject builders'),
  builds: z
    .array(ContextBuild)
    .optional()
    .describe('the builds of the bound product the workflow asked for (workflow.context), frozen with the run so an evaluation after a restart sees the same list; absent when not asked or not bound to a product'),
  client_key: z.string().min(1).max(200).optional(),
  request_digest: Sha256.optional().describe('SHA-256 of the RFC 8785 canonical JSON of the start_run arguments the client key was bound to; the same key with other arguments is IDEMPOTENCY_MISMATCH (D05 R[4])'),
  client_key_expires_at: IsoTime.optional().describe('end of the window in which repeating the client key returns this run'),
  leases: z
    .array(z.union([
      z.strictObject({ op: z.literal('acquire').optional(), lease: LeaseId, keys: z.array(z.string().min(1)).min(1), until: IsoTime.nullable() }),
      z.strictObject({ op: z.literal('extend'), lease: LeaseId, keys: z.array(z.string().min(1)).min(1), until: IsoTime.nullable() }),
      z.strictObject({ op: LeaseOpSchema.extract(['register','unregister']), prefix:z.string().min(1), owner:z.string().min(1) }),
      z.strictObject({ op: LeaseOpSchema.extract(['force_release']), keys:z.array(z.string().min(1)).min(1), reason:z.string().min(1), until:IsoTime.nullable(), previous_holders:z.array(z.strictObject({key:z.string().min(1),run:RunId})) }),
      z.strictObject({ op: z.literal('release'), keys: z.array(z.string().min(1)).min(1), until: IsoTime.nullable() }),
    ]))
    .optional()
    .describe('the lease operations this run performed before it was stored (acquire\'s grant, extend\'s new end, release\'s keys with their former end); the fencing token stays in the lease table, never in the record'),
  lease_registrations: z.array(LeaseRegistrationRow).optional(),
  lease_context: z
    .array(PersistedLeaseContextRow)
    .optional()
    .describe('the frozen lease rows of the workflow\'s declared prefix at start_run (every holder\'s rows, no tokens), `mine` marking the rows held by this run\'s lineage (D04 R[0])'),
}).superRefine((r, ctx) => {
  if(r.feeding_offset&&(r.feeding_offset.run!==r.run||r.feeding_offset.root!==(r.root??null)))ctx.addIssue({code:'custom',path:['feeding_offset'],message:'feeding horizon belongs to the same run and locked root'});
  if (r.host === 'hub') {
    if(r.trigger==='standing_obligation'){
      if(r.runner!==undefined)ctx.addIssue({code:'custom',path:['runner'],message:'a standing obligation keeps its legacy configurer identity'});
    }else{
      if(r.trigger!=='event_or_schedule')ctx.addIssue({code:'custom',path:['trigger'],message:'an automatic successor is event triggered'});
      if(r.runner===undefined)ctx.addIssue({code:'custom',path:['runner'],message:'an automatic successor preserves the original named runner'});
      if(r.predecessor===undefined)ctx.addIssue({code:'custom',path:['predecessor'],message:'an automatic successor names the original run'});
      if(r.requirements.some(requirement=>requirement.accepted_producer!=='fact'))ctx.addIssue({code:'custom',path:['requirements'],message:'the Hub succeeds only fact-producing runs'});
    }
  } else if (r.runner === undefined) {
    ctx.addIssue({ code: 'custom', path: ['runner'], message: 'a run executed by a client or a bot names its runner' });
  }
  if (CONFIGURED.safeParse(r.trigger).success && r.configurer === undefined) {
    ctx.addIssue({ code: 'custom', path: ['configurer'], message: `a ${r.trigger} trigger names its configurer (W09 F[1])` });
  }
  const keyed = [r.client_key, r.request_digest, r.client_key_expires_at].filter((v) => v !== undefined).length;
  if (keyed !== 0 && keyed !== 3) {
    ctx.addIssue({ code: 'custom', path: ['client_key'], message: 'client_key, request_digest and client_key_expires_at go together' });
  }
});
/** Strict new-write shape; the base RunRecord remains a historical reader. */
export const NewRunRecord=RunRecord.safeExtend({submission_due:IsoTime}).refine(value=>Date.parse(value.submission_due)>Date.parse(value.started_at),{path:['submission_due'],message:'the submission deadline is later than run creation'});
export type RunRecord = z.infer<typeof RunRecord>;
/** Derived read view: historical originals stay unchanged. */
export type RunRecordView = RunRecord & {requirements:RequirementSummary[];criterion_changes?:z.infer<typeof CriterionNotice>[]};
