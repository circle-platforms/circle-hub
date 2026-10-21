// Run (W06), item projection (W01) and the summaries start_run and list_task_packs return.
import { z } from 'zod';
import {
  AcceptedProducerSchema,
  DoneRuleSchema,
  LayerSchema,
  PackKindSchema,
  SourceRoleSchema,
} from '../generated/vocabulary.ts';
import { IsoTime, ItemId, PackId, PackVersion, RunId, Sha256 } from './common.ts';
import { ExternalObjectId, ReferenceUri } from './reference.ts';

/** One input given to start_run: bytes already uploaded, or an external object the Hub reads (read-only) with the pack's system adapter. */
export const InputBinding = z.union([
  z.object({ reference: ReferenceUri.describe('reference returned by upload_file, or any reference the caller may read') }),
  z.object({ external: ExternalObjectId.describe('external object identity, system:type:id, for example agile:mindmap:24863') }),
]);
export type InputBinding = z.infer<typeof InputBinding>;

/** An item the pack's projection function produced from the judged source. The Hub core never interprets `fields`. */
export const ItemProjection = z.object({
  id: ItemId,
  label: z.string(),
  location: ReferenceUri.describe('where the item sits in the judged source'),
  fields: z.record(z.string(), z.unknown()),
});
export type ItemProjection = z.infer<typeof ItemProjection>;

export const RequirementSummary = z.object({
  key: z.string(),
  name: z.string(),
  description: z.string(),
  layers: z.array(LayerSchema).describe('the judgment layers this requirement is judged on; other layers are not applicable'),
  done_rule: DoneRuleSchema,
  accepted_producer: AcceptedProducerSchema,
  repair_rounds: z.number().int().nonnegative(),
});
export type RequirementSummary = z.infer<typeof RequirementSummary>;

export const InputSlotSummary = z.object({
  slot: z.string(),
  role: SourceRoleSchema,
  description: z.string(),
  accepts: z.array(z.string()).describe('media types, or external object types such as agile:mindmap'),
  required: z.boolean(),
  many: z.boolean(),
});
export type InputSlotSummary = z.infer<typeof InputSlotSummary>;

export const PackSummary = z.object({
  pack: z.string().describe('id@version'),
  id: PackId,
  version: PackVersion,
  kind: PackKindSchema,
  title: z.string(),
  description: z.string(),
  products: z.array(z.string()).describe('every name of the product lines the pack is bound to, for example APV and NSAE'),
  inputs: z.array(InputSlotSummary),
  parameters: z.array(z.object({ name: z.string(), description: z.string(), required: z.boolean() })),
  requirements: z.array(RequirementSummary),
});
export type PackSummary = z.infer<typeof PackSummary>;

export const RunSummary = z.object({
  run: RunId,
  pack: z.string(),
  pack_digest: Sha256,
  product: z.string().optional(),
  version: z.string().optional(),
  build: z.string().optional(),
  root: Sha256.optional().describe('knowledge root locked for this run'),
  requirements: z.array(RequirementSummary),
  items: z.array(ItemProjection),
  instructions: z.string().describe('the pack procedure, plain text'),
  instructions_digest: Sha256,
  predecessor: RunId.optional(),
  session: z.string().optional().describe('client session id observed from the request header'),
  started_at: IsoTime,
});
export type RunSummary = z.infer<typeof RunSummary>;
