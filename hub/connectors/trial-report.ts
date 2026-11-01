// The observed B05 trial action: an allow-list of facts, never the typed configuration or the source's text.
import { z } from 'zod';
import { ActionKindSchema, ActionResultSchema, EnvironmentSchema } from '../../contracts/generated/vocabulary.ts';
import { IsoTime, PackId, PackVersion, UserId, Versioned } from '../../contracts/src/common.ts';

export const TRIAL_REPORT_SCHEMA = 'trial-report@1';
export const TrialRecord = z.strictObject({
  action: ActionKindSchema.extract(['trial']),
  run: z.null(),
  item: z.null(),
  inputs: z.array(z.string()),
  component: Versioned,
  lease: z.null(),
  started_at: IsoTime,
  ended_at: IsoTime,
  result: ActionResultSchema,
  error_code: z.string().nullable(),
  principal: UserId,
  system_pack: z.strictObject({ id: PackId, version: PackVersion }),
  environment: EnvironmentSchema,
  auth: z.strictObject({ sent: z.boolean(), ok: z.boolean().nullable(), code: z.string().nullable() }),
  routes: z.array(z.strictObject({
    route: z.string().min(1).max(100),
    tried: z.boolean(),
    ok: z.boolean().nullable(),
    status: z.number().int().nullable(),
    code: z.string().nullable(),
    ms: z.number().nonnegative().nullable(),
  })),
});
export type TrialRecord = z.infer<typeof TrialRecord>;
