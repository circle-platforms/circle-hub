// MCP tool annotations derived from the effect class and whether the call writes Hub records (D03 R[6], D06).
import type { EffectClass } from '../generated/vocabulary.ts';

export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint: boolean;
}

export interface AnnotationOptions {
  /** For this caller the call reads an external system (for example start_run choosing a build by the pack rule, D06 F[2]). */
  readsExternal?: boolean;
  /**
   * Repeating the call is deduplicated unconditionally, by content or by key (upload_file, submit_result; not start_run, whose key
   * has a window). For a write to an external system: only when it is same-key safe and the dedup premise is certified.
   */
  idempotent?: boolean;
  /** A write to an external system that can be undone: destructiveHint is false. Unset means not reversible (D03 F[2]). */
  reversible?: boolean;
  /** Read-only on the external system is enforced by the transport and certified; otherwise an external read is annotated as a write. */
  readOnlyEnforced?: boolean;
}

/** What each effect class does outside the Hub. A new effect class fails to compile until it is placed here. */
const REACH = {
  none: 'none',
  read: 'external_read',
  sync_write: 'external_write',
  job: 'external_write',
  notification: 'external_write',
} as const satisfies Record<EffectClass, 'none' | 'external_read' | 'external_write'>;

/** Hints for anything not recognised: a destructive, open-world write, so no client auto-approves it. */
const UNRECOGNISED: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, openWorldHint: true };

/**
 * D03 R[6]: effect class none without Hub records is read-only and closed-world; writing only Hub records is not read-only, never
 * destructive, and open-world only when the caller's packs make the call read an external system; an external read is read-only only
 * when the transport enforces it, otherwise it is annotated as a write; a write to an external system is open-world and destructive
 * unless reversible. For a call that makes the Hub dispatch (D06 R[4]) pass the widest effect class among the rows it may dispatch.
 * An effect class this table does not know gets the most conservative hints.
 */
export function annotationsFor(effect: EffectClass, writesHubRecords: boolean, options: AnnotationOptions = {}): ToolAnnotations {
  const reach = Object.hasOwn(REACH, effect) ? REACH[effect] : undefined;
  if (reach === undefined) return { ...UNRECOGNISED };
  const readsOutside = reach === 'external_read' || options.readsExternal === true;
  const asWrite = (destructive: boolean, openWorld: boolean): ToolAnnotations => {
    const out: ToolAnnotations = { readOnlyHint: false, destructiveHint: destructive, openWorldHint: openWorld };
    if (options.idempotent === true) out.idempotentHint = true;
    return out;
  };
  if (reach === 'external_write') return asWrite(options.reversible !== true, true);
  if (reach === 'none' && writesHubRecords) return asWrite(false, readsOutside);
  if (!readsOutside) return { readOnlyHint: true, openWorldHint: false };
  if (options.readOnlyEnforced === true) return { readOnlyHint: true, openWorldHint: true };
  return asWrite(options.reversible !== true, true);
}
