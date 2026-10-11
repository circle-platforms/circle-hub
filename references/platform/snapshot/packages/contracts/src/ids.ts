import { z } from "zod";

/**
 * FZ-07: identity formats.
 * Each state space has its own prefixed, opaque ID. A value from one space
 * must never parse as an ID of another space (contracts ch.2).
 */

const prefixedId = (prefix: string) =>
  z
    .string()
    .regex(
      new RegExp(`^${prefix}_[A-Za-z0-9][A-Za-z0-9_-]*$`),
      `expected an id starting with "${prefix}_"`,
    );

export const PrincipalIdSchema = prefixedId("prn");
export const TenantIdSchema = prefixedId("tnt");
export const ScopeIdSchema = prefixedId("scp");
export const ActorIdSchema = prefixedId("act");
export const ConversationIdSchema = prefixedId("conv");
export const TaskIdSchema = prefixedId("task");
export const RunIdSchema = prefixedId("run");
export const InputRevisionIdSchema = prefixedId("inrev");
export const OperationIdSchema = prefixedId("op");
export const AttemptIdSchema = prefixedId("att");
export const ResourceIdSchema = prefixedId("res");
export const LeaseIdSchema = prefixedId("lease");
export const SourceRevisionIdSchema = prefixedId("src");
export const EvidenceIdSchema = prefixedId("evd");
export const ArtifactIdSchema = prefixedId("art");
export const SnapshotIdSchema = prefixedId("snap");
export const CapabilityPackIdSchema = prefixedId("pack");
export const RecordIdSchema = prefixedId("rec");
export const RequestIdSchema = prefixedId("req");
export const PendingRequestIdSchema = prefixedId("pin");

export type PrincipalId = z.infer<typeof PrincipalIdSchema>;
export type TenantId = z.infer<typeof TenantIdSchema>;
export type ScopeId = z.infer<typeof ScopeIdSchema>;
export type ActorId = z.infer<typeof ActorIdSchema>;
export type ConversationId = z.infer<typeof ConversationIdSchema>;
export type TaskId = z.infer<typeof TaskIdSchema>;
export type RunId = z.infer<typeof RunIdSchema>;
export type InputRevisionId = z.infer<typeof InputRevisionIdSchema>;
export type OperationId = z.infer<typeof OperationIdSchema>;
export type AttemptId = z.infer<typeof AttemptIdSchema>;
export type ResourceId = z.infer<typeof ResourceIdSchema>;
export type LeaseId = z.infer<typeof LeaseIdSchema>;
export type SourceRevisionId = z.infer<typeof SourceRevisionIdSchema>;
export type EvidenceId = z.infer<typeof EvidenceIdSchema>;
export type ArtifactId = z.infer<typeof ArtifactIdSchema>;
export type SnapshotId = z.infer<typeof SnapshotIdSchema>;
export type CapabilityPackId = z.infer<typeof CapabilityPackIdSchema>;
export type RecordId = z.infer<typeof RecordIdSchema>;
export type RequestId = z.infer<typeof RequestIdSchema>;
export type PendingRequestId = z.infer<typeof PendingRequestIdSchema>;

/** SHA-256 of exact bytes, lowercase hex. */
export const Sha256Schema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "expected a lowercase hex SHA-256 digest");
export type Sha256 = z.infer<typeof Sha256Schema>;

/** Monotonically increasing anti-staleness token issued with a lease. */
export const FencingTokenSchema = z.number().int().positive();
export type FencingToken = z.infer<typeof FencingTokenSchema>;

/** Semantic version used for schemas and capability packs. */
export const VersionSchema = z
  .string()
  .regex(/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/, "expected a semver string");
export type Version = z.infer<typeof VersionSchema>;

/** Opaque revision label for artifacts (kept a string on purpose). */
export const ArtifactRevisionSchema = z.string().min(1);
export type ArtifactRevision = z.infer<typeof ArtifactRevisionSchema>;
