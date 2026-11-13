// Reset scopes are the four choices named by the owner; this is one declaration shared by CLI and console adapters.
import { z } from 'zod';

export { RESET_SCOPE, ResetScopeSchema, RESET_SCOPE_LABEL, RESET_ALL_LABEL } from '../../../contracts/api.ts';
import { RESET_SCOPE, ResetScopesSchema, type ResetScope } from '../../../contracts/api.ts';
export type { ResetScope } from '../../../contracts/api.ts';
export const ResetRequest = z.strictObject({
  scopes: ResetScopesSchema,
  keepConfig: z.boolean().default(false),
  definitionFile: z.string().regex(/^src:[0-9a-f]{64}$/, '定义文件必须是已授权上传对象的src引用').optional(),
}).refine(request => !(request.keepConfig && request.definitionFile), '保留现有配置与定义文件恢复只能选择一种');
export type ResetRequest = z.infer<typeof ResetRequest>;
export interface ResetProblem { scope?: ResetScope; table?: string; row?: number; name?: string; reason: string; nextAction: string; }
export interface ResetInspection { available: boolean; compatible: boolean; needsRebuild: boolean; diagnostics: readonly ResetProblem[]; canKeepConfig: boolean; choices: readonly { scopes: readonly ResetScope[] | 'all'; keepConfig: boolean; definitionAllowed: boolean }[]; }
export interface ResetCount { scope: ResetScope; retained: number; cleared: number | null; }
export interface ResetPlan { request: ResetRequest; inspection: ResetInspection; counts: readonly ResetCount[]; blocked: readonly ResetProblem[]; }
export interface ResetReport { archive: string; backup: string; configurationSnapshot?: string; counts: readonly ResetCount[]; notices: readonly ResetProblem[]; archivedTables?: readonly { schema: string; table: string; rows: number }[]; }
export interface ResetPorts {
  exportConfiguration?(path: string): Promise<void>;
  restoreConfiguration?(path: string): Promise<void>;
  applyDefinition?(path: string): Promise<void>;
}
export function resetScopes(request: ResetRequest): ReadonlySet<ResetScope> { return new Set(request.scopes === 'all' ? RESET_SCOPE : request.scopes); }

export function parseResetRequest(input: unknown): ResetRequest { return ResetRequest.parse(input); }
