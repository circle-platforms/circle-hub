import { z } from 'zod';

export { RESET_SCOPE, RESET_DATA_SCOPE, ResetScopeSchema, ResetDataScopeSchema, RESET_SCOPE_LABEL, RESET_ALL_LABEL } from '../../../contracts/api.ts';
import { RESET_DATA_SCOPE, ResetScopesSchema, type ResetDataScope } from '../../../contracts/api.ts';
export type { ResetScope, ResetDataScope } from '../../../contracts/api.ts';
export const ResetRequest = z.strictObject({
  scopes: ResetScopesSchema,
  keepConfig: z.boolean().default(false),
  definitionFile: z.string().refine(value => !value.includes('\0') && (/^src:[0-9a-f]{64}$/.test(value) || process.getBuiltinModule('path').isAbsolute(value)), '定义文件必须是src引用或绝对本机路径').optional(),
});
export type ResetRequest = z.infer<typeof ResetRequest>;
export interface ResetProblem { scope?: ResetDataScope; table?: string; row?: number; name?: string; reason: string; nextAction: string; }
export interface ResetInspection { available: boolean; compatible: boolean; needsRebuild: boolean; diagnostics: readonly ResetProblem[]; canKeepConfig: boolean; choices: readonly { scopes: readonly ResetDataScope[] | 'all'; keepConfig: boolean; definitionAllowed: boolean }[]; }
export interface ResetCount { scope: ResetDataScope; retained: number; cleared: number | null; }
export interface ResetPlan { request: ResetRequest; inspection: ResetInspection; counts: readonly ResetCount[]; blocked: readonly ResetProblem[]; }
export interface ResetReport { archive: string; backup: string; configurationSnapshot?: string; botRuntime?: 'cleaned' | 'retained'; counts: readonly ResetCount[]; notices: readonly ResetProblem[]; archivedTables?: readonly { schema: string; table: string; rows: number }[]; }
export interface ResetPorts {
  exportConfiguration?(path: string): Promise<void>;
  restoreConfiguration?(path: string): Promise<void>;
  applyDefinition?(path: string): Promise<void>;
}
export function resetScopes(request: ResetRequest): ReadonlySet<ResetDataScope> { return new Set(request.scopes === 'all' ? RESET_DATA_SCOPE : request.scopes); }

export function parseResetRequest(input: unknown): ResetRequest { return ResetRequest.parse(input); }
