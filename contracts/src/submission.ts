// Submission (W07): what the client hands back. Stored exactly as received; the Hub computes every terminal state itself.
import { z } from 'zod';
import { ItemHandlingSchema, NatureSchema } from '../generated/vocabulary.ts';
import { ItemId, RunId } from './common.ts';
import { ReferenceUri } from './reference.ts';

export const ItemSubmission = z.object({
  item: ItemId,
  handling: ItemHandlingSchema,
  reason: z.string().optional().describe('required when the item is skipped'),
  slots: z.record(z.string(), z.unknown()).optional().describe('slot record, validated against the pack slot schema'),
  context: z.string().optional().describe('digest of the context the model used for this item, so unchanged items can be reused'),
});
export type ItemSubmission = z.infer<typeof ItemSubmission>;

/** A claim over several items. A fact must ground in references; a judgment may also rest on the fact before it. */
export const CrossItemSubmission = z.object({
  nature: NatureSchema.extract(['fact', 'judgment']),
  statement: z.string(),
  grounds: z.array(ReferenceUri),
  code: z.string().optional(),
  rank: z.string().optional(),
});
export type CrossItemSubmission = z.infer<typeof CrossItemSubmission>;

export const Submission = z.object({
  run: RunId,
  model: z.string().min(1).describe('model name and exact configuration as the client declares it'),
  items: z.array(ItemSubmission),
  cross_item: z.array(CrossItemSubmission),
  notes: z.string().optional(),
});
export type Submission = z.infer<typeof Submission>;
