// Owner-approved reset categories (2026-11-13 17:15); all is a selector, never a category.
import { z } from 'zod';

export const ResetScopeSchema = z.enum(['history', 'knowledge', 'packs', 'config']);
export type ResetScope = z.infer<typeof ResetScopeSchema>;
export const RESET_SCOPE: readonly ResetScope[] = ResetScopeSchema.options;

export const ResetScopesSchema = z.union([
  z.array(ResetScopeSchema).min(1).refine(scopes => new Set(scopes).size === scopes.length, 'each reset scope is selected once'),
  z.literal('all'),
]);
export type ResetScopes = z.infer<typeof ResetScopesSchema>;

export const schemas: Record<string, z.ZodType> = {
  'reset-scope@1': ResetScopeSchema,
  'reset-scopes@1': ResetScopesSchema,
};
