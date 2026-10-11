import { z } from "zod";
import {
  CapabilityPackIdSchema,
  ResourceIdSchema,
  Sha256Schema,
  SnapshotIdSchema,
  SourceRevisionIdSchema,
  VersionSchema,
} from "./ids.js";

/**
 * FZ-05: BindingSet (contracts ch.4). Every run and every side-effecting
 * operation carries the full binding closure it was judged against.
 * Changing any bound item creates a new input revision (BIND-01); it
 * never mutates a running one.
 */

export const BoundInputArtifactSchema = z.object({
  label: z.string().min(1),
  sha256: Sha256Schema,
});
export type BoundInputArtifact = z.infer<typeof BoundInputArtifactSchema>;

export const BoundProductSchema = z.object({
  productId: z.string().min(1),
  version: z.string().min(1),
  form: z.enum(["physical", "virtual", "cloud", "unknown"]),
});
export type BoundProduct = z.infer<typeof BoundProductSchema>;

export const BindingSetSchema = z.object({
  inputArtifacts: z.array(BoundInputArtifactSchema).default([]),
  sourceRevisionIds: z.array(SourceRevisionIdSchema).default([]),
  snapshotId: SnapshotIdSchema.optional(),
  product: BoundProductSchema.optional(),
  capabilityPack: z
    .object({
      packId: CapabilityPackIdSchema,
      packVersion: VersionSchema,
    })
    .optional(),
  target: z
    .object({
      resourceId: ResourceIdSchema,
      environmentRevision: z.string().min(1),
    })
    .optional(),
  sampleSet: z
    .object({
      sampleSetId: z.string().min(1),
      manifestSha256: Sha256Schema,
    })
    .optional(),
  /** Audit/replay information only; never an input to business state. */
  harness: z
    .object({
      name: z.string().min(1),
      version: z.string().min(1),
      adapterVersion: z.string().min(1),
    })
    .optional(),
});
export type BindingSet = z.infer<typeof BindingSetSchema>;

export interface BindingClosureOptions {
  /** The work draws factual conclusions from knowledge (V01-style). */
  citesKnowledge: boolean;
  /** The work produces real side effects on a target (D operations). */
  hasSideEffects: boolean;
  /** The work's behaviour is defined by an E capability pack. */
  requiresPack: boolean;
  /** The work is specific to one product / version. */
  involvesProduct: boolean;
}

/**
 * Program-side closure check. Returns human-readable issues; an empty
 * array means the binding set is closed for the declared work.
 */
export function validateBindingClosure(
  bindings: BindingSet,
  opts: BindingClosureOptions,
): string[] {
  const issues: string[] = [];
  if (opts.citesKnowledge) {
    if (!bindings.snapshotId) {
      issues.push("citesKnowledge requires a fixed snapshotId");
    }
    if (bindings.sourceRevisionIds.length === 0) {
      issues.push("citesKnowledge requires at least one sourceRevisionId");
    }
  }
  if (opts.hasSideEffects && !bindings.target) {
    issues.push("hasSideEffects requires a bound target (resourceId + environmentRevision)");
  }
  if (opts.requiresPack && !bindings.capabilityPack) {
    issues.push("requiresPack requires capabilityPack (packId + packVersion)");
  }
  if (opts.involvesProduct && !bindings.product) {
    issues.push("involvesProduct requires a bound product (productId + version + form)");
  }
  return issues;
}
