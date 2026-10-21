// Validation result (W08, validation@1): what the Hub's boundary validation produces for one submission.
import { z } from 'zod';
import {
  AcceptanceSchema,
  AttributionSchema,
  CheckTierSchema,
  DynamicTerminalSchema,
  LayerSchema,
  PartitionSchema,
  ReasonSchema,
  RequirementStatusSchema,
  StaticTerminalSchema,
  UnsatisfiedReasonSchema,
} from '../generated/vocabulary.ts';
import { Claim } from './claim.ts';
import { Coverage, ItemId, ProtocolError, RunId, Sha256, TraceId } from './common.ts';

/** Terminal state of one (item, requirement, layer). A layer the requirement does not declare has no entry: the screen says "not applicable". */
export const LayerResult = z.discriminatedUnion('layer', [
  z.object({
    layer: z.literal('static'),
    terminal: StaticTerminalSchema,
    code: z.string().optional().describe('violation code when terminal is violation'),
    tier: CheckTierSchema.optional(),
    reason: ReasonSchema.optional().describe('why the state is unchecked or incomplete'),
  }),
  z.object({
    layer: z.literal('dynamic'),
    terminal: DynamicTerminalSchema,
    code: z.string().optional(),
    tier: CheckTierSchema.optional(),
    reason: ReasonSchema.optional(),
  }),
]);
export type LayerResult = z.infer<typeof LayerResult>;

export const RequirementResult = z.object({
  requirement: z.string(),
  layers: z.array(LayerResult),
  status: RequirementStatusSchema,
  unsatisfied_reason: UnsatisfiedReasonSchema.optional(),
  attribution: AttributionSchema.optional().describe('only for non-pass terminals that miss the contract\'s expected outcome'),
  claims: z.array(Claim).describe('in display order: position, statement, nature and basis rank, qualifier, grounds, producer, resolution, validity'),
});
export type RequirementResult = z.infer<typeof RequirementResult>;

export const ItemResult = z.object({
  item: ItemId,
  label: z.string(),
  location: z.string().describe('reference URI of the item in the judged source'),
  partition: PartitionSchema,
  requirements: z.array(RequirementResult),
});
export type ItemResult = z.infer<typeof ItemResult>;

export const Locks = z.object({
  pack: z.string().describe('pack id@version'),
  pack_digest: Sha256,
  root: Sha256.optional().describe('knowledge root digest locked at start_run'),
  policy: z.string().optional(),
});

export const ValidationResult = z.object({
  schema: z.literal('validation@1'),
  run: RunId,
  submission: Sha256.describe('digest of the submission, the idempotency key together with the run'),
  acceptance: AcceptanceSchema,
  errors: z.array(ProtocolError),
  rounds: z.object({ used: z.number().int().nonnegative(), max: z.number().int().nonnegative() }),
  items: z.array(ItemResult).describe('empty when the submission was not accepted'),
  cross_item: z.array(Claim),
  counts: z.object({
    delivered: z.number().int().nonnegative(),
    rejected: z.number().int().nonnegative(),
    quarantined: z.number().int().nonnegative(),
    incomplete: z.number().int().nonnegative(),
    unknown: z.number().int().nonnegative(),
  }),
  coverage: Coverage,
  locks: Locks,
  trace: TraceId,
});
export type ValidationResult = z.infer<typeof ValidationResult>;
