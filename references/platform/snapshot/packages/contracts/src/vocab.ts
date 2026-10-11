import { z } from "zod";
import { EvidenceIdSchema } from "./ids.js";

/**
 * FZ-01: response status vocabulary (COM-02). Never collapse these into a
 * single boolean success.
 * FZ-02: task phases and operation states are separate state spaces
 * (contracts ch.7); transitions below are the frozen allow-lists.
 * FZ-03: structured errors (STATE-01). The registry is the single source
 * for code -> category / retryable defaults.
 */

/* ------------------------------------------------------------------ */
/* FZ-01: ResponseStatus + CLI exit codes (COM-06)                     */
/* ------------------------------------------------------------------ */

export const ResponseStatusSchema = z.enum([
  "accepted",
  "running",
  "succeeded",
  "failed",
  "unknown",
  "partial",
  "not-run",
  "cancel-requested",
  // Contract v1.1 (ADR 0009): final state for an operation terminated by
  // cancellation (stopped-observed), whether cancelled before or during
  // execution. Exhaustive consumers must handle it explicitly.
  "cancelled",
]);
export type ResponseStatus = z.infer<typeof ResponseStatusSchema>;

/**
 * CLI exit codes. 0 is reserved for a completed `succeeded` result only;
 * accepted/running are not final results and never map to 0.
 */
export const CLI_EXIT_CODES: Readonly<Record<ResponseStatus, number>> = {
  succeeded: 0,
  failed: 1,
  partial: 2,
  unknown: 3,
  "not-run": 4,
  cancelled: 5,
  accepted: 10,
  running: 11,
  "cancel-requested": 12,
};

export function responseStatusForExitCode(
  code: number,
): ResponseStatus | undefined {
  for (const [status, exit] of Object.entries(CLI_EXIT_CODES)) {
    if (exit === code) return status as ResponseStatus;
  }
  return undefined;
}

export function isFinalStatus(status: ResponseStatus): boolean {
  return (
    status === "succeeded" ||
    status === "failed" ||
    status === "unknown" ||
    status === "partial" ||
    status === "not-run" ||
    status === "cancelled"
  );
}

/* ------------------------------------------------------------------ */
/* FZ-02: task phases (owner: C)                                       */
/* ------------------------------------------------------------------ */

export const TaskPhaseSchema = z.enum([
  "draft",
  "admitted",
  "running",
  "waiting-input",
  "waiting-resource",
  "waiting-review",
  "under-review",
  "delivered",
  "failed",
  "cancelled",
  "unknown",
]);
export type TaskPhase = z.infer<typeof TaskPhaseSchema>;

export const TASK_TRANSITIONS: Readonly<Record<TaskPhase, readonly TaskPhase[]>> = {
  draft: ["admitted", "cancelled"],
  admitted: ["running", "cancelled", "failed"],
  running: [
    "waiting-input",
    "waiting-resource",
    "waiting-review",
    "under-review",
    "failed",
    "cancelled",
    "unknown",
  ],
  "waiting-input": ["running", "cancelled", "unknown"],
  "waiting-resource": ["running", "cancelled", "unknown"],
  "waiting-review": ["under-review", "running", "cancelled"],
  // under-review -> running is the rework path; delivered only via the
  // completion gate (VER-03), never directly from running.
  "under-review": ["delivered", "running", "failed", "cancelled"],
  delivered: [],
  failed: [],
  cancelled: [],
  // unknown may only be left after reconcile (RC-03).
  unknown: ["running", "failed", "cancelled"],
};

export function canTaskTransition(from: TaskPhase, to: TaskPhase): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}

/* ------------------------------------------------------------------ */
/* FZ-02: operation states (owner: D), incl. the cancel sub-states     */
/* ------------------------------------------------------------------ */

export const OperationStatusSchema = z.enum([
  "submitted",
  "accepted",
  "running",
  "succeeded",
  "failed",
  "unknown",
  "partial",
  "cancel-requested",
  "cancel-delivered",
  "stopped-observed",
  "still-running",
]);
export type OperationStatus = z.infer<typeof OperationStatusSchema>;

export const OPERATION_TRANSITIONS: Readonly<
  Record<OperationStatus, readonly OperationStatus[]>
> = {
  submitted: ["accepted", "failed"],
  accepted: ["running", "cancel-requested", "unknown"],
  running: ["succeeded", "failed", "unknown", "partial", "cancel-requested"],
  // A new attempt under the same operation may resume from partial.
  partial: ["running"],
  // Cancel is four distinct facts (RC-04); none of them is "stopped".
  "cancel-requested": ["cancel-delivered", "still-running", "unknown"],
  "cancel-delivered": ["stopped-observed", "still-running", "unknown"],
  "still-running": ["stopped-observed", "succeeded", "failed", "unknown"],
  // unknown is left only through reconcile evidence (RC-03).
  unknown: ["running", "succeeded", "failed", "partial", "stopped-observed"],
  succeeded: [],
  failed: [],
  "stopped-observed": [],
};

export function canOperationTransition(
  from: OperationStatus,
  to: OperationStatus,
): boolean {
  return OPERATION_TRANSITIONS[from].includes(to);
}

/* ------------------------------------------------------------------ */
/* FZ-03: structured errors                                            */
/* ------------------------------------------------------------------ */

export const ErrorCategorySchema = z.enum([
  "validation",
  "permission",
  "conflict-stale",
  "lease",
  "target",
  "transient",
  "semantic-insufficient",
  "internal",
]);
export type ErrorCategory = z.infer<typeof ErrorCategorySchema>;

export interface ErrorCodeInfo {
  readonly code: string;
  readonly category: ErrorCategory;
  /** Registry default. An instance may be stricter (false), never looser. */
  readonly retryable: boolean;
  readonly requiresUserAction: boolean;
}

export const ERROR_CODES = [
  { code: "INVALID_PAYLOAD", category: "validation", retryable: false, requiresUserAction: true },
  { code: "UNSUPPORTED_VERSION", category: "validation", retryable: false, requiresUserAction: true },
  { code: "UNSUPPORTED_MEDIA", category: "validation", retryable: false, requiresUserAction: true },
  { code: "MISSING_BINDING", category: "validation", retryable: false, requiresUserAction: true },
  { code: "UNAUTHENTICATED", category: "permission", retryable: false, requiresUserAction: true },
  { code: "FORBIDDEN_SCOPE", category: "permission", retryable: false, requiresUserAction: false },
  { code: "FORBIDDEN_TARGET", category: "permission", retryable: false, requiresUserAction: false },
  { code: "INPUT_REVISION_STALE", category: "conflict-stale", retryable: false, requiresUserAction: true },
  { code: "SNAPSHOT_SUPERSEDED", category: "conflict-stale", retryable: false, requiresUserAction: false },
  { code: "DECISION_CONFLICT", category: "conflict-stale", retryable: false, requiresUserAction: true },
  // Contract v1.2 (ADR 0011): same idempotency key reused with a different
  // canonical request hash inside the dedupe window.
  { code: "IDEMPOTENCY_MISMATCH", category: "conflict-stale", retryable: false, requiresUserAction: true },
  { code: "LEASE_NOT_HELD", category: "lease", retryable: false, requiresUserAction: false },
  { code: "LEASE_EXPIRED", category: "lease", retryable: true, requiresUserAction: false },
  { code: "FENCING_STALE", category: "lease", retryable: false, requiresUserAction: false },
  { code: "RESOURCE_BUSY", category: "lease", retryable: true, requiresUserAction: false },
  { code: "TARGET_NOT_FOUND", category: "target", retryable: false, requiresUserAction: true },
  { code: "TARGET_IDENTITY_MISMATCH", category: "target", retryable: false, requiresUserAction: true },
  { code: "TARGET_UNREACHABLE", category: "target", retryable: true, requiresUserAction: false },
  { code: "UPSTREAM_TIMEOUT", category: "transient", retryable: true, requiresUserAction: false },
  { code: "RECEIPT_LOST", category: "transient", retryable: false, requiresUserAction: false },
  { code: "TRANSPORT_CLOSED", category: "transient", retryable: true, requiresUserAction: false },
  { code: "EVIDENCE_INSUFFICIENT", category: "semantic-insufficient", retryable: false, requiresUserAction: true },
  { code: "NO_ANSWER", category: "semantic-insufficient", retryable: false, requiresUserAction: false },
  { code: "AMBIGUOUS_INPUT", category: "semantic-insufficient", retryable: false, requiresUserAction: true },
  { code: "INTERNAL_ERROR", category: "internal", retryable: false, requiresUserAction: false },
  { code: "INVARIANT_VIOLATION", category: "internal", retryable: false, requiresUserAction: false },
] as const satisfies readonly ErrorCodeInfo[];

export type ErrorCode = (typeof ERROR_CODES)[number]["code"];

export const ErrorCodeSchema = z.enum(
  ERROR_CODES.map((c) => c.code) as [ErrorCode, ...ErrorCode[]],
);

const registry = new Map<string, ErrorCodeInfo>(
  ERROR_CODES.map((c): [string, ErrorCodeInfo] => [c.code, c]),
);

export function errorCodeInfo(code: ErrorCode): ErrorCodeInfo {
  const info = registry.get(code);
  if (!info) throw new Error(`unregistered error code: ${code}`);
  return info;
}

export const StructuredErrorSchema = z
  .object({
    code: ErrorCodeSchema,
    category: ErrorCategorySchema,
    /** Human-readable explanation only; never a substitute for code/category. */
    message: z.string().min(1),
    retryable: z.boolean(),
    /** Echo of the revision / target / lease the failure was judged against. */
    bindingEcho: z.record(z.string(), z.string()).optional(),
    evidenceRefs: z.array(EvidenceIdSchema).default([]),
    userAction: z.string().min(1).optional(),
    details: z.record(z.string(), z.unknown()).optional(),
  })
  .superRefine((err, ctx) => {
    const info = errorCodeInfo(err.code);
    if (info.category !== err.category) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["category"],
        message: `category ${err.category} does not match registry category ${info.category} for ${err.code}`,
      });
    }
    if (!info.retryable && err.retryable) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["retryable"],
        message: `${err.code} is not retryable in the registry; an instance must not loosen it`,
      });
    }
    if (info.requiresUserAction && !err.userAction) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["userAction"],
        message: `${err.code} requires a userAction description`,
      });
    }
  });
export type StructuredError = z.infer<typeof StructuredErrorSchema>;
