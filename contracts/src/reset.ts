// Owner-approved reset categories (2026-11-13 17:15); all is a selector, never a category.
import { z } from 'zod';

// One runtime declaration supplies both codes and owner-authored labels; the model axis awaits Boss approval.
export const RESET_SCOPE_LABEL = {
  history: '运行历史',
  knowledge: '知识',
  packs: '包',
  config: '配置',
} as const;
export const RESET_ALL_LABEL = '全部初始化';
export const ResetScopeSchema = z.enum(Object.keys(RESET_SCOPE_LABEL) as Array<keyof typeof RESET_SCOPE_LABEL>);
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
