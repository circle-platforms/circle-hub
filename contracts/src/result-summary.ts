// Model 43, W08 R[6] (decision 153): the summary of a validation result, a record of its own beside the result. A list of
// tasks needs a few facts of each task's current result; reading a whole result for each cost a megabyte or more a row
// (issue 200). The summary is projected from the result when the result is stored and never changes it: the result stays
// the authority, and a result with no summary is read as before.
import { z } from 'zod';
import { AcceptanceSchema, DynamicTerminalSchema, LayerSchema, ReasonSchema, StaticTerminalSchema, TaskResultSchema } from '../generated/vocabulary.ts';
import { RunId, Sha256 } from './common.ts';
import { Ground } from './reference.ts';

/** What a result comes to when it is the one that counts for its run: the figures a list row and the overview show. */
export const ResultStatistics = z.strictObject({
  result: TaskResultSchema,
  pending: z.number().int().nonnegative().describe('delivered requirements still pending or with an unknown terminal'),
  checks: z.array(z.strictObject({
    layer: LayerSchema,
    terminal: z.union([StaticTerminalSchema, DynamicTerminalSchema]),
    unknown: z.boolean(),
    count: z.number().int().positive(),
  })),
  blockers: z.array(z.strictObject({
    code: z.string().optional(),
    reason: ReasonSchema.optional(),
    count: z.number().int().positive(),
  })),
});
export type ResultStatistics = z.infer<typeof ResultStatistics>;

export const ResultSummaryBody = z.strictObject({
  run: RunId,
  result: Sha256.describe('digest of the validation_result record this summarizes'),
  submission: Sha256.describe('the result\'s submission field, as stored'),
  acceptance: AcceptanceSchema,
  system_input: z.boolean().describe('whether the result carries a system-delivery input'),
  statistics: ResultStatistics,
  grounds: z.array(Ground).describe('every ground the result names, in the order the result gives them'),
  bound: z.array(z.string()).describe('the digests its validity conditions bind, which name the run sources it rests on'),
  unavailable_references: z.array(Ground).describe('the result\'s unavailable_references: diagnostic identities, not evidence'),
});
export type ResultSummaryBody = z.infer<typeof ResultSummaryBody>;

export const schemas = {
  'result-summary@1': ResultSummaryBody,
};
