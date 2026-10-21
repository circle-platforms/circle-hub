// MCP tool annotations derived from the effect class and whether the call writes Hub records (D03, D06 R[0]).
import type { EffectClass } from '../generated/vocabulary.ts';

export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint: boolean;
}

export interface AnnotationOptions {
  /** The call reads an external system (for example start_run resolving an external input). */
  readsExternal?: boolean;
  /** The call is idempotent for the same arguments (content-addressed upload, repeat submit for the same digest). */
  idempotent?: boolean;
}

/**
 * Effect class `none` with no Hub record written is read-only. Writing only Hub records is not read-only, not destructive and
 * never open-world. Effects on external systems are open-world; `destructiveHint` is false only for reversible writes.
 * Only milestone-1 effect classes none and read are exercised; the remaining classes follow the D03 table.
 */
export function annotationsFor(effect: EffectClass, writesHubRecords: boolean, options: AnnotationOptions = {}): ToolAnnotations {
  const external = effect === 'sync_write' || effect === 'job' || effect === 'notification';
  const openWorld = external || effect === 'read' || options.readsExternal === true;
  if (effect === 'none' && !writesHubRecords) {
    return { readOnlyHint: true, openWorldHint: openWorld };
  }
  if (effect === 'read' && !writesHubRecords) {
    return { readOnlyHint: true, openWorldHint: true };
  }
  const out: ToolAnnotations = { readOnlyHint: false, destructiveHint: external, openWorldHint: openWorld };
  if (options.idempotent) out.idempotentHint = true;
  return out;
}
