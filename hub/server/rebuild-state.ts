import type { RecordsSchemaCompatibility } from '../records/api.ts';

export interface RebuildNeeded { reason: string; detail?: string }

export function rebuildRequiredState(schema: RecordsSchemaCompatibility): RebuildNeeded | null {
  if (schema.status !== 'incompatible' || schema.compatible !== false) return null;
  return {
    reason: schema.problems.join('；'),
    detail: `当前程序迁移身份：${JSON.stringify(schema.expected)}；已观察迁移身份：${JSON.stringify(schema.applied)}`,
  };
}
