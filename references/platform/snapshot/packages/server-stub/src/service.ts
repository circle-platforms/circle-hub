import {
  CONTRACT_VERSION,
  type ErrorCode,
  type OperationStatus,
  RequestEnvelopeSchema,
  type ResponseEnvelope,
  ResponseEnvelopeSchema,
  type ResponseStatus,
  type StructuredError,
  StructuredErrorSchema,
  errorCodeInfo,
} from "@infosec/contracts";

/**
 * Minimal long-task service stub for P1-3 pairing tests.
 *
 * This is a scripted model, not a product service: behaviour is driven by
 * payload.script so the same deterministic scenario can be replayed over
 * MCP, CLI and HTTP and the envelopes compared byte for byte. State lives
 * in this service (the C/D side), never in a transport or client.
 */

export type ScriptName =
  | "instant"
  | "slow"
  | "needs-input"
  | "fail-target"
  | "drop-receipt";

interface OpRecord {
  operationId: string;
  runId: string;
  inputRevisionId: string;
  script: ScriptName;
  echo: unknown;
  status: OperationStatus;
  polls: number;
  executorRuns: number;
  pendingRequestId?: string;
  inputReceived: boolean;
  outcomeRecorded: boolean;
  error?: StructuredError;
  resultPayload?: Record<string, unknown>;
}

const BASE_TIME = Date.parse("2026-01-01T00:00:00.000Z");
const FORBIDDEN_SCOPE = "scp_forbidden_1";

export class LongTaskService {
  private tick = 0;
  private opCounter = 0;
  private runCounter = 0;
  private inrevCounter = 0;
  private pinCounter = 0;
  private ops = new Map<string, OpRecord>();
  private idempotency = new Map<string, string>();

  /* ---------------- persistence (used by the CLI transport) -------- */

  snapshot(): unknown {
    return {
      tick: this.tick,
      opCounter: this.opCounter,
      runCounter: this.runCounter,
      inrevCounter: this.inrevCounter,
      pinCounter: this.pinCounter,
      ops: [...this.ops.values()],
      idempotency: [...this.idempotency.entries()],
    };
  }

  static restore(data: unknown): LongTaskService {
    const svc = new LongTaskService();
    if (data && typeof data === "object") {
      const d = data as {
        tick: number;
        opCounter: number;
        runCounter: number;
        inrevCounter: number;
        pinCounter: number;
        ops: OpRecord[];
        idempotency: [string, string][];
      };
      svc.tick = d.tick;
      svc.opCounter = d.opCounter;
      svc.runCounter = d.runCounter;
      svc.inrevCounter = d.inrevCounter;
      svc.pinCounter = d.pinCounter;
      svc.ops = new Map(d.ops.map((o) => [o.operationId, o]));
      svc.idempotency = new Map(d.idempotency);
    }
    return svc;
  }

  /* ---------------- helpers ---------------------------------------- */

  private now(): string {
    this.tick += 1;
    return new Date(BASE_TIME + this.tick * 1000).toISOString();
  }

  private makeError(
    code: ErrorCode,
    message: string,
    userAction?: string,
  ): StructuredError {
    const info = errorCodeInfo(code);
    return StructuredErrorSchema.parse({
      code,
      category: info.category,
      message,
      retryable: info.retryable,
      ...(info.requiresUserAction
        ? { userAction: userAction ?? "see message" }
        : {}),
      ...(userAction && !info.requiresUserAction ? { userAction } : {}),
    });
  }

  private respond(
    requestId: string,
    status: ResponseStatus,
    extra: Partial<ResponseEnvelope> = {},
  ): ResponseEnvelope {
    return ResponseEnvelopeSchema.parse({
      schemaVersion: CONTRACT_VERSION,
      requestId,
      acceptedAt: this.now(),
      status,
      verification: [],
      assessments: [],
      evidenceRefs: [],
      artifactRefs: [],
      pendingInputs: [],
      nextActions: [],
      ...extra,
    });
  }

  private fail(
    requestId: string,
    code: ErrorCode,
    message: string,
    userAction?: string,
  ): ResponseEnvelope {
    return this.respond(requestId, "failed", {
      error: this.makeError(code, message, userAction),
      nextActions: ["none"],
    });
  }

  /** Parse + platform-level checks shared by all six calls. */
  private parseEnvelope(
    raw: unknown,
  ):
    | { ok: true; env: import("@infosec/contracts").RequestEnvelope }
    | { ok: false; response: ResponseEnvelope } {
    const parsed = RequestEnvelopeSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        ok: false,
        response: this.fail(
          "req_0",
          "INVALID_PAYLOAD",
          `envelope failed schema validation: ${parsed.error.issues[0]?.message ?? "unknown issue"}`,
          "fix the envelope against the frozen schema and resubmit",
        ),
      };
    }
    const env = parsed.data;
    if (env.schemaVersion !== CONTRACT_VERSION) {
      return {
        ok: false,
        response: this.fail(
          env.requestId,
          "UNSUPPORTED_VERSION",
          `schemaVersion ${env.schemaVersion} is not supported by this service (frozen: ${CONTRACT_VERSION})`,
          "resubmit with the frozen contract version",
        ),
      };
    }
    return { ok: true, env };
  }

  private opFromPayload(
    env: import("@infosec/contracts").RequestEnvelope,
  ): OpRecord | ResponseEnvelope {
    const payload = (env.payload ?? {}) as { operationId?: string };
    if (!payload.operationId) {
      return this.fail(
        env.requestId,
        "INVALID_PAYLOAD",
        "payload.operationId is required for this call",
        "include the operationId returned by submit",
      );
    }
    const op = this.ops.get(payload.operationId);
    if (!op) {
      return this.fail(
        env.requestId,
        "TARGET_NOT_FOUND",
        `no such operation: ${payload.operationId}`,
        "check the operationId and resubmit",
      );
    }
    return op;
  }

  private statusResponse(
    env: import("@infosec/contracts").RequestEnvelope,
    op: OpRecord,
  ): ResponseEnvelope {
    const status = responseStatusForOp(op);
    return this.respond(env.requestId, status, {
      result: {
        operationId: op.operationId,
        operationStatus: op.status,
        executorRuns: op.executorRuns,
        ...(op.resultPayload ?? {}),
      },
      ...(op.error ? { error: op.error } : {}),
      pendingInputs: pendingInputsOf(op),
      nextActions: nextActionsFor(op),
    });
  }

  /* ---------------- the six calls ---------------------------------- */

  submit(raw: unknown): ResponseEnvelope {
    const parsed = this.parseEnvelope(raw);
    if (!parsed.ok) return parsed.response;
    const env = parsed.env;

    if (env.scopeId === FORBIDDEN_SCOPE) {
      return this.fail(
        env.requestId,
        "FORBIDDEN_SCOPE",
        `scope ${env.scopeId} is not admitted for this service`,
      );
    }

    if (env.idempotencyKey && this.idempotency.has(env.idempotencyKey)) {
      const existing = this.ops.get(this.idempotency.get(env.idempotencyKey)!);
      if (existing) {
        const snap = this.statusResponse(env, existing);
        return { ...snap, result: { ...(snap.result as object), duplicate: true } };
      }
    }

    const payload = (env.payload ?? {}) as {
      script?: ScriptName;
      echo?: unknown;
    };
    const script: ScriptName = payload.script ?? "instant";
    this.opCounter += 1;
    this.runCounter += 1;
    this.inrevCounter += 1;
    const op: OpRecord = {
      operationId: `op_${this.opCounter}`,
      runId: `run_${this.runCounter}`,
      inputRevisionId: `inrev_${this.inrevCounter}`,
      script,
      echo: payload.echo ?? null,
      status: "accepted",
      polls: 0,
      executorRuns: 0,
      inputReceived: false,
      outcomeRecorded: false,
    };
    this.ops.set(op.operationId, op);
    if (env.idempotencyKey) {
      this.idempotency.set(env.idempotencyKey, op.operationId);
    }

    if (script === "instant") {
      op.executorRuns = 1;
      op.status = "succeeded";
      op.outcomeRecorded = true;
      op.resultPayload = { echo: op.echo };
      return this.statusResponse(env, op);
    } else if (script === "drop-receipt") {
      // The work happened; the receipt did not reach the caller (RC-03).
      op.executorRuns = 1;
      op.outcomeRecorded = true;
      op.resultPayload = { echo: op.echo };
      op.status = "unknown";
      return this.respond(env.requestId, "unknown", {
        result: { operationId: op.operationId, operationStatus: op.status, executorRuns: op.executorRuns },
        error: this.makeError(
          "RECEIPT_LOST",
          "the submit receipt was lost; the operation outcome is unknown until reconcile",
        ),
        nextActions: ["reconcile"],
      });
    }

    return this.respond(env.requestId, "accepted", {
      result: {
        operationId: op.operationId,
        operationStatus: op.status,
        executorRuns: op.executorRuns,
      },
      nextActions: ["query-status"],
    });
  }

  status(raw: unknown): ResponseEnvelope {
    const parsed = this.parseEnvelope(raw);
    if (!parsed.ok) return parsed.response;
    const env = parsed.env;
    const found = this.opFromPayload(env);
    if ("schemaVersion" in found) return found;
    const op = found as OpRecord;
    this.advance(op);
    return this.statusResponse(env, op);
  }

  result(raw: unknown): ResponseEnvelope {
    const parsed = this.parseEnvelope(raw);
    if (!parsed.ok) return parsed.response;
    const env = parsed.env;
    const found = this.opFromPayload(env);
    if ("schemaVersion" in found) return found;
    return this.statusResponse(env, found as OpRecord);
  }

  input(raw: unknown): ResponseEnvelope {
    const parsed = this.parseEnvelope(raw);
    if (!parsed.ok) return parsed.response;
    const env = parsed.env;
    const found = this.opFromPayload(env);
    if ("schemaVersion" in found) return found;
    const op = found as OpRecord;

    if (env.inputRevisionId && env.inputRevisionId !== op.inputRevisionId) {
      return this.fail(
        env.requestId,
        "INPUT_REVISION_STALE",
        `input targets revision ${env.inputRevisionId} but the operation is bound to ${op.inputRevisionId}`,
        "re-read the current pending input and respond against the current revision",
      );
    }
    if (!op.pendingRequestId || op.inputReceived) {
      return this.fail(
        env.requestId,
        "DECISION_CONFLICT",
        "the operation has no outstanding pending input",
        "query status before submitting input",
      );
    }
    op.inputReceived = true;
    return this.respond(env.requestId, "running", {
      result: { operationId: op.operationId, operationStatus: op.status, executorRuns: op.executorRuns },
      nextActions: ["query-status"],
    });
  }

  cancel(raw: unknown): ResponseEnvelope {
    const parsed = this.parseEnvelope(raw);
    if (!parsed.ok) return parsed.response;
    const env = parsed.env;
    const found = this.opFromPayload(env);
    if ("schemaVersion" in found) return found;
    const op = found as OpRecord;

    if (isFinal(op)) {
      return this.fail(
        env.requestId,
        "DECISION_CONFLICT",
        `operation is already final (${op.status}) and cannot be cancelled`,
        "query the result instead of cancelling",
      );
    }
    if (op.status === "unknown") {
      return this.fail(
        env.requestId,
        "DECISION_CONFLICT",
        "an operation in unknown state must be reconciled before it can be cancelled",
        "reconcile first, then cancel if still running",
      );
    }
    op.status = "cancel-requested";
    return this.respond(env.requestId, "cancel-requested", {
      result: { operationId: op.operationId, operationStatus: op.status, executorRuns: op.executorRuns },
      nextActions: ["query-status"],
    });
  }

  reconcile(raw: unknown): ResponseEnvelope {
    const parsed = this.parseEnvelope(raw);
    if (!parsed.ok) return parsed.response;
    const env = parsed.env;
    const found = this.opFromPayload(env);
    if ("schemaVersion" in found) return found;
    const op = found as OpRecord;

    if (op.status === "unknown" && op.outcomeRecorded) {
      op.status = "succeeded";
      const snap = this.statusResponse(env, op);
      return { ...snap, result: { ...(snap.result as object), reconciled: true } };
    }
    const snap = this.statusResponse(env, op);
    return { ...snap, result: { ...(snap.result as object), reconciled: false } };
  }

  /* ---------------- scripted progression ---------------------------- */

  private advance(op: OpRecord): void {
    if (isFinal(op) || op.status === "unknown") return;

    if (op.status === "cancel-requested") {
      op.status = "cancel-delivered";
      return;
    }
    if (op.status === "cancel-delivered") {
      // This stub cancels operations whose scripted work completes on a
      // later poll; a delivered cancel ends in stopped-observed. The
      // final response status for stopped-observed is `cancelled`
      // (contract v1.1, ADR 0009).
      op.status = "stopped-observed";
      return;
    }

    op.polls += 1;
    switch (op.script) {
      case "slow": {
        if (op.polls === 1) {
          op.status = "running";
        } else {
          op.executorRuns = 1;
          op.status = "succeeded";
          op.outcomeRecorded = true;
          op.resultPayload = { echo: op.echo };
        }
        break;
      }
      case "needs-input": {
        if (!op.inputReceived) {
          op.status = "running";
          if (!op.pendingRequestId) {
            this.pinCounter += 1;
            op.pendingRequestId = `pin_${this.pinCounter}`;
          }
        } else {
          op.executorRuns = 1;
          op.status = "succeeded";
          op.outcomeRecorded = true;
          op.resultPayload = { echo: op.echo, decided: true };
        }
        break;
      }
      case "fail-target": {
        op.status = "failed";
        op.outcomeRecorded = true;
        op.error = this.makeError(
          "TARGET_UNREACHABLE",
          "the scripted target did not answer",
        );
        break;
      }
      default:
        break;
    }
  }
}

function isFinal(op: OpRecord): boolean {
  return (
    op.status === "succeeded" ||
    op.status === "failed" ||
    op.status === "stopped-observed"
  );
}

function responseStatusForOp(op: OpRecord): ResponseStatus {
  switch (op.status) {
    case "submitted":
    case "accepted":
      return "accepted";
    case "running":
      return "running";
    case "cancel-requested":
    case "cancel-delivered":
    case "still-running":
      // A cancel is in flight; the precise sub-state is in
      // result.operationStatus, the response status stays interim.
      return "cancel-requested";
    case "stopped-observed":
      // Terminated by cancellation, before or during execution (v1.1).
      return "cancelled";
    case "unknown":
      return "unknown";
    case "succeeded":
      return "succeeded";
    case "failed":
      return "failed";
    case "partial":
      return "partial";
  }
}

function pendingInputsOf(op: OpRecord) {
  if (op.pendingRequestId && !op.inputReceived && op.status === "running") {
    return [
      {
        requestId: op.pendingRequestId,
        taskId: "task_stub",
        inputRevisionId: op.inputRevisionId,
        decisionType: "clarification" as const,
        question: "Provide the missing scripted input",
        sensitiveChannel: false,
        requestedAt: new Date(BASE_TIME).toISOString(),
      },
    ];
  }
  return [];
}

function nextActionsFor(op: OpRecord): ResponseEnvelope["nextActions"] {
  if (op.status === "unknown") return ["reconcile"];
  if (isFinal(op)) return ["none"];
  if (op.pendingRequestId && !op.inputReceived && op.status === "running") {
    return ["submit-input", "query-status"];
  }
  return ["query-status"];
}
