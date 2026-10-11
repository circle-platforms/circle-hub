import { z } from "zod";
import {
  ActorIdSchema,
  InputRevisionIdSchema,
  PendingRequestIdSchema,
  TaskIdSchema,
} from "./ids.js";

/**
 * FZ-09: human decisions are structured objects bound to one request and
 * one input revision (HUM-01..04). A chat remark is not a decision until
 * it lands as a response to a specific requestId.
 */

export const DecisionTypeSchema = z.enum([
  "clarification",
  "approval",
  "credential",
  "mfa",
  "conflict-resolution",
  "other",
]);
export type DecisionType = z.infer<typeof DecisionTypeSchema>;

export const PendingInputSchema = z.object({
  requestId: PendingRequestIdSchema,
  taskId: TaskIdSchema,
  inputRevisionId: InputRevisionIdSchema,
  decisionType: DecisionTypeSchema,
  question: z.string().min(1),
  options: z.array(z.string().min(1)).optional(),
  formatHint: z.string().min(1).optional(),
  /**
   * True for credential / MFA style inputs: the payload must travel the
   * trusted execution channel only, never model context or chat history.
   */
  sensitiveChannel: z.boolean().default(false),
  requestedAt: z.string().datetime(),
  expiresAt: z.string().datetime().optional(),
});
export type PendingInput = z.infer<typeof PendingInputSchema>;

export const PendingInputResponseSchema = z.object({
  requestId: PendingRequestIdSchema,
  inputRevisionId: InputRevisionIdSchema,
  actorId: ActorIdSchema,
  decision: z.unknown(),
  respondedAt: z.string().datetime(),
  idempotencyKey: z.string().min(8),
});
export type PendingInputResponse = z.infer<typeof PendingInputResponseSchema>;

export type PendingResponseOutcome =
  | "accepted"
  | "expired"
  | "stale-revision";

/**
 * HUM-02: a late response to a superseded revision, or after expiry,
 * must be rejected — it never advances the current revision.
 */
export function evaluatePendingResponse(
  pending: PendingInput,
  response: PendingInputResponse,
): PendingResponseOutcome {
  if (response.inputRevisionId !== pending.inputRevisionId) {
    return "stale-revision";
  }
  if (
    pending.expiresAt &&
    new Date(response.respondedAt).getTime() >
      new Date(pending.expiresAt).getTime()
  ) {
    return "expired";
  }
  return "accepted";
}

/** Credential and MFA decisions must use the sensitive channel (HUM-04). */
export function requiresSensitiveChannel(p: PendingInput): boolean {
  return (
    p.sensitiveChannel ||
    p.decisionType === "credential" ||
    p.decisionType === "mfa"
  );
}
