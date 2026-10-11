import { z } from "zod";
import { EvidenceIdSchema, Sha256Schema } from "./ids.js";

/**
 * FZ-06: effect declaration. Replaces any single readOnly boolean
 * (contracts ch.6). Declared effects are checked again at the side-effect
 * owner; a mismatch is a contract violation, not a rounding error.
 */

export const ReadScopeSchema = z.enum([
  "local-files",
  "knowledge",
  "device-state",
  "web-page",
  "external-system",
]);
export type ReadScope = z.infer<typeof ReadScopeSchema>;

export const WriteScopeSchema = z.enum([
  "local-workspace",
  "artifacts-evidence",
  "device-config",
  "web-data",
  "external-system",
]);
export type WriteScope = z.infer<typeof WriteScopeSchema>;

export const ResourceUseSchema = z.enum([
  "lease-exclusive",
  "shared-session",
  "browser-context",
  "process-port",
]);
export type ResourceUse = z.infer<typeof ResourceUseSchema>;

export const ReversibilitySchema = z.enum([
  "not-applicable",
  "auto-rollback",
  "manual-rollback",
  "irreversible",
]);
export type Reversibility = z.infer<typeof ReversibilitySchema>;

export const EffectDescriptorSchema = z.object({
  reads: z.array(ReadScopeSchema).default([]),
  writes: z.array(WriteScopeSchema).default([]),
  resourceUse: z.array(ResourceUseSchema).default([]),
  externalTransfers: z
    .array(z.object({ destinationKind: z.string().min(1) }))
    .default([]),
  reversibility: ReversibilitySchema.default("not-applicable"),
  cleanup: z
    .object({
      auto: z.array(z.string()).default([]),
      leftovers: z.array(z.string()).default([]),
    })
    .default({ auto: [], leftovers: [] }),
});
export type EffectDescriptor = z.infer<typeof EffectDescriptorSchema>;

export const AdmissionTierSchema = z.enum([
  "readonly-collect",
  "standard-change",
  "irreversible-separate",
]);
export type AdmissionTier = z.infer<typeof AdmissionTierSchema>;

/** EFF-02 / AUTH-05: irreversible effects always need separate admission. */
export function deriveAdmissionTier(effect: EffectDescriptor): AdmissionTier {
  if (effect.reversibility === "irreversible") return "irreversible-separate";
  if (effect.writes.length > 0) return "standard-change";
  return "readonly-collect";
}

/**
 * EFF-01: a "read-only" claim is only consistent when nothing is written
 * and nothing leaves the boundary. Resource occupation (lease, session)
 * does not break read-only data semantics but must still be declared,
 * which the descriptor forces.
 */
export function isReadOnlyConsistent(effect: EffectDescriptor): boolean {
  return effect.writes.length === 0 && effect.externalTransfers.length === 0;
}

export function occupiesResources(effect: EffectDescriptor): boolean {
  return effect.resourceUse.length > 0;
}

export const EvidenceRefSchema = z.object({
  evidenceId: EvidenceIdSchema,
  sha256: Sha256Schema.optional(),
  locator: z.string().min(1).optional(),
});
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;
