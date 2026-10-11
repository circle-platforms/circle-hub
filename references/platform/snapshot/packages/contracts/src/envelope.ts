import { z } from "zod";
import { BindingSetSchema } from "./bindings.js";
import { EffectDescriptorSchema, EvidenceRefSchema } from "./effects.js";
import {
  ArtifactIdSchema,
  ArtifactRevisionSchema,
  InputRevisionIdSchema,
  PrincipalIdSchema,
  RequestIdSchema,
  RunIdSchema,
  ScopeIdSchema,
  TaskIdSchema,
  TenantIdSchema,
  VersionSchema,
} from "./ids.js";
import { PendingInputSchema } from "./pending.js";
import { AssessmentRecordSchema, VerificationRecordSchema } from "./records.js";
import { ResponseStatusSchema, StructuredErrorSchema } from "./vocab.js";

/**
 * FZ-04: the shared envelope (COM). MCP, CLI and HTTP carry the same
 * semantics; only the transport encoding differs (ADR 0007).
 * Identity fields are validated against the trusted channel by the
 * server — a payload can never mint its own principal (AUTH-02).
 */

export const ArtifactRefSchema = z.object({
  artifactId: ArtifactIdSchema,
  revision: ArtifactRevisionSchema,
});
export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;

export const RequestEnvelopeSchema = z.object({
  schemaVersion: VersionSchema,
  requestId: RequestIdSchema,
  idempotencyKey: z.string().min(8).optional(),
  principalId: PrincipalIdSchema,
  tenantId: TenantIdSchema,
  scopeId: ScopeIdSchema,
  taskId: TaskIdSchema.optional(),
  runId: RunIdSchema.optional(),
  inputRevisionId: InputRevisionIdSchema.optional(),
  bindings: BindingSetSchema.optional(),
  effectDeclaration: EffectDescriptorSchema.optional(),
  payload: z.unknown(),
});
export type RequestEnvelope = z.infer<typeof RequestEnvelopeSchema>;

export const NextActionSchema = z.enum([
  "query-status",
  "query-result",
  "submit-input",
  "request-cancel",
  "reconcile",
  "wait",
  "none",
]);
export type NextAction = z.infer<typeof NextActionSchema>;

export const ResponseEnvelopeSchema = z.object({
  schemaVersion: VersionSchema,
  requestId: RequestIdSchema,
  acceptedAt: z.string().datetime().optional(),
  status: ResponseStatusSchema,
  result: z.unknown().optional(),
  /** Program verification and semantic judgement stay separate (VER). */
  verification: z.array(VerificationRecordSchema).default([]),
  assessments: z.array(AssessmentRecordSchema).default([]),
  evidenceRefs: z.array(EvidenceRefSchema).default([]),
  artifactRefs: z.array(ArtifactRefSchema).default([]),
  pendingInputs: z.array(PendingInputSchema).default([]),
  error: StructuredErrorSchema.optional(),
  nextActions: z.array(NextActionSchema).default([]),
});
export type ResponseEnvelope = z.infer<typeof ResponseEnvelopeSchema>;
