import { z } from 'zod';
import { RESET_SCOPE, ResetScopeSchema, labelOf } from '../generated/vocabulary.ts';

export { RESET_SCOPE, RESET_SCOPE_LABEL, ResetScopeSchema } from '../generated/vocabulary.ts';
export type { ResetScope } from '../generated/vocabulary.ts';

export const ResetDataScopeSchema = ResetScopeSchema.exclude(['all']);
export type ResetDataScope = z.infer<typeof ResetDataScopeSchema>;
export const RESET_DATA_SCOPE: readonly ResetDataScope[] = RESET_SCOPE.filter((scope): scope is ResetDataScope => scope !== 'all');
export const RESET_ALL_LABEL = labelOf('reset_scope', 'all');

export const ResetScopesSchema = z.union([
  z.array(ResetDataScopeSchema).min(1).refine(scopes => new Set(scopes).size === scopes.length, 'each reset scope is selected once'),
  ResetScopeSchema.extract(['all']),
]);
export type ResetScopes = z.infer<typeof ResetScopesSchema>;

export const schemas: Record<string, z.ZodType> = {
  'reset-scope@1': ResetScopeSchema,
  'reset-scopes@1': ResetScopesSchema,
};
