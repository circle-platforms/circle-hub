import type { ProvenanceType } from '../../../../contracts/generated/vocabulary.ts';
import { PROVENANCE_TYPE_LABEL, labelOf } from './generated/vocabulary.ts';
export function scopeText(scope: unknown): string {
  if (typeof scope !== 'string' || !Object.hasOwn(PROVENANCE_TYPE_LABEL, scope)) throw new Error('Invalid scope provenance');
  return `需求范围依据：${labelOf('provenance_type', scope as ProvenanceType)}`;
}
