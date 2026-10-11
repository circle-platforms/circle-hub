import {
  canOperationTransition,
  type OperationStatus,
  type ResponseStatus,
} from "@infosec/contracts";
import { createHash } from "node:crypto";
import type { Clock } from "./clock.js";
import { fail, ok, type Result } from "./result.js";
import type { IdGen } from "./idgen.js";
import { LeaseManager, type Lease } from "./leases.js";

/**
 * Object D minimum: operation lifecycle on the frozen FZ-02 state machine,
 * ADR 0011 idempotency (24h dedupe window, request-hash comparison, 7d
 * result retention) and lease-expiry behaviour split by operation kind:
 * read operations are auto-resumed after expiry (their read-only nature is
 * the reconcile basis, RC-03); effect operations go to `unknown` and may
 * only leave it through an explicit reconcile — never an automatic retry.
 */
export type OperationKind = "read" | "effect";

export const DEDUPE_WINDOW_MS = 24 * 3_600_000;
export const RESULT_RETENTION_MS = 7 * 24 * 3_600_000;

export interface OperationRecord {
  operationId: string;
  tenantId: string;
  scopeId: string;
  principalId: string;
  runId: string;
  name: string;
  kind: OperationKind;
  resourceId?: string;
  state: OperationStatus;
  attempts: number;
  leaseId?: string;
  fencingToken?: number;
  result?: unknown;
  resultExpiresAt?: number;
  awaitingReconcile: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface SubmitInput {
  tenantId: string;
  scopeId: string;
  principalId: string;
  runId: string;
  name: string;
  kind: OperationKind;
  resourceId?: string;
  idempotencyKey: string;
  /** Canonical request payload; hashed for the mismatch comparison. */
  request: unknown;
}

export function canonicalRequestHash(request: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(request) ?? "null")
    .digest("hex");
}

const FINAL_OF: Record<"succeeded" | "failed" | "partial", OperationStatus> = {
  succeeded: "succeeded",
  failed: "failed",
  partial: "partial",
};

export class OperationService {
  #clock: Clock;
  #ids: IdGen;
  #leases: LeaseManager;
  #ops = new Map<string, OperationRecord>();
  #idem = new Map<
    string,
    { operationId: string; requestHash: string; createdAt: number }
  >();
  #dedupeWindowMs: number;
  #resultRetentionMs: number;

  constructor(
    clock: Clock,
    ids: IdGen,
    leases: LeaseManager,
    opts: { dedupeWindowMs?: number; resultRetentionMs?: number } = {},
  ) {
    this.#clock = clock;
    this.#ids = ids;
    this.#leases = leases;
    this.#dedupeWindowMs = opts.dedupeWindowMs ?? DEDUPE_WINDOW_MS;
    this.#resultRetentionMs = opts.resultRetentionMs ?? RESULT_RETENTION_MS;
  }

  get(operationId: string): OperationRecord | undefined {
    return this.#ops.get(operationId);
  }

  submit(
    input: SubmitInput,
  ): Result<{ operation: OperationRecord; duplicate: boolean }> {
    const now = this.#clock.now();
    const idemKey = `${input.principalId}|${input.name}|${input.idempotencyKey}`;
    const requestHash = canonicalRequestHash(input.request);
    const prior = this.#idem.get(idemKey);
    if (prior && now - prior.createdAt <= this.#dedupeWindowMs) {
      if (prior.requestHash !== requestHash) {
        return fail(
          "IDEMPOTENCY_MISMATCH",
          "idempotency key reused with a different request inside the dedupe window",
        );
      }
      const existing = this.#ops.get(prior.operationId);
      if (existing) return ok({ operation: existing, duplicate: true });
    }

    let lease: Lease | undefined;
    if (input.resourceId) {
      const acquired = this.#leases.acquire(input.resourceId, input.runId);
      if (!acquired.ok) return acquired;
      lease = acquired.value;
    }
    const operation: OperationRecord = {
      operationId: this.#ids.next("op"),
      tenantId: input.tenantId,
      scopeId: input.scopeId,
      principalId: input.principalId,
      runId: input.runId,
      name: input.name,
      kind: input.kind,
      ...(input.resourceId ? { resourceId: input.resourceId } : {}),
      state: "accepted",
      attempts: 0,
      ...(lease
        ? { leaseId: lease.leaseId, fencingToken: lease.fencingToken }
        : {}),
      awaitingReconcile: false,
      createdAt: now,
      updatedAt: now,
    };
    this.#ops.set(operation.operationId, operation);
    this.#idem.set(idemKey, {
      operationId: operation.operationId,
      requestHash,
      createdAt: now,
    });
    return ok({ operation, duplicate: false });
  }

  #move(op: OperationRecord, to: OperationStatus): Result<OperationRecord> {
    if (!canOperationTransition(op.state, to)) {
      return fail(
        "INVARIANT_VIOLATION",
        `operation state ${op.state} -> ${to} is not an allowed transition`,
      );
    }
    op.state = to;
    op.updatedAt = this.#clock.now();
    return ok(op);
  }

  #leaseLive(op: OperationRecord): boolean {
    if (!op.resourceId) return true;
    return (
      op.fencingToken !== undefined &&
      this.#leases.isCurrent(op.resourceId, op.fencingToken)
    );
  }

  start(operationId: string): Result<OperationRecord> {
    const op = this.#ops.get(operationId);
    if (!op) return fail("TARGET_NOT_FOUND", `operation ${operationId} not found`);
    if (op.state === "unknown") {
      return fail(
        "DECISION_CONFLICT",
        "an unknown operation may only move through reconcile (RC-03)",
      );
    }
    if (!this.#leaseLive(op)) {
      return fail(
        "LEASE_EXPIRED",
        "the operation's lease is no longer current; sweep/reconcile first",
      );
    }
    const moved = this.#move(op, "running");
    if (!moved.ok) return moved;
    op.attempts += 1;
    return moved;
  }

  complete(
    operationId: string,
    outcome: "succeeded" | "failed" | "partial",
    result?: unknown,
  ): Result<OperationRecord> {
    const op = this.#ops.get(operationId);
    if (!op) return fail("TARGET_NOT_FOUND", `operation ${operationId} not found`);
    if (op.state === "unknown") {
      return fail(
        "DECISION_CONFLICT",
        "an unknown operation may only be completed through reconcile (RC-03)",
      );
    }
    if (op.resourceId && !this.#leaseLive(op)) {
      return fail(
        "FENCING_STALE",
        "completion rejected: the holder's lease/fencing is no longer current",
      );
    }
    const moved = this.#move(op, FINAL_OF[outcome]);
    if (!moved.ok) return moved;
    if (result !== undefined) op.result = result;
    op.resultExpiresAt = this.#clock.now() + this.#resultRetentionMs;
    if (op.leaseId && op.fencingToken !== undefined) {
      this.#leases.release(op.leaseId, op.fencingToken);
    }
    return moved;
  }

  /** Fencing-checked write: the only way a holder may mutate a resource. */
  writeGuard(operationId: string): Result<{ allowed: true }> {
    const op = this.#ops.get(operationId);
    if (!op) return fail("TARGET_NOT_FOUND", `operation ${operationId} not found`);
    if (op.state !== "running") {
      return fail(
        "INVARIANT_VIOLATION",
        `writes require a running operation (state: ${op.state})`,
      );
    }
    if (op.resourceId && !this.#leaseLive(op)) {
      return fail("FENCING_STALE", "write rejected: fencing token is stale");
    }
    return ok({ allowed: true });
  }

  requestCancel(operationId: string): Result<OperationRecord> {
    const op = this.#ops.get(operationId);
    if (!op) return fail("TARGET_NOT_FOUND", `operation ${operationId} not found`);
    return this.#move(op, "cancel-requested");
  }

  confirmStopped(operationId: string): Result<OperationRecord> {
    const op = this.#ops.get(operationId);
    if (!op) return fail("TARGET_NOT_FOUND", `operation ${operationId} not found`);
    if (op.state === "cancel-requested") {
      const delivered = this.#move(op, "cancel-delivered");
      if (!delivered.ok) return delivered;
    }
    const stopped = this.#move(op, "stopped-observed");
    if (!stopped.ok) return stopped;
    op.resultExpiresAt = this.#clock.now() + this.#resultRetentionMs;
    if (op.leaseId && op.fencingToken !== undefined) {
      this.#leases.release(op.leaseId, op.fencingToken);
    }
    return stopped;
  }

  /**
   * Record that an operation's outcome became unknowable to the caller
   * (receipt lost, connection dropped mid-commit — RC-03's entry point).
   * The operation may only leave `unknown` through reconcile.
   */
  markUnknown(operationId: string): Result<OperationRecord> {
    const op = this.#ops.get(operationId);
    if (!op) return fail("TARGET_NOT_FOUND", `operation ${operationId} not found`);
    const moved = this.#move(op, "unknown");
    if (!moved.ok) return moved;
    op.awaitingReconcile = true;
    return moved;
  }

  /**
   * Observe lease expiries and apply the ADR 0011 split. Returns what
   * happened so callers and tests can assert on it.
   */
  sweep(): { resumedReads: string[]; unknowned: string[] } {
    const resumedReads: string[] = [];
    const unknowned: string[] = [];
    for (const lease of this.#leases.sweepExpired()) {
      const op = [...this.#ops.values()].find(
        (o) => o.leaseId === lease.leaseId,
      );
      if (!op || (op.state !== "running" && op.state !== "accepted")) continue;
      if (op.kind === "effect" || op.state === "accepted") {
        // Effect operations (and never-started operations holding a lease)
        // go to unknown; only reconcile may move them on.
        if (this.#move(op, "unknown").ok) {
          op.awaitingReconcile = true;
          unknowned.push(op.operationId);
        }
        continue;
      }
      // Running read operation: unknown is the only exit from running, and
      // its read-only nature is the reconcile basis for immediate resume
      // under a fresh lease and fencing token.
      if (!this.#move(op, "unknown").ok) continue;
      const reacquired = op.resourceId
        ? this.#leases.acquire(op.resourceId, op.runId)
        : undefined;
      if (reacquired && !reacquired.ok) {
        op.awaitingReconcile = true;
        unknowned.push(op.operationId);
        continue;
      }
      if (reacquired && reacquired.ok) {
        op.leaseId = reacquired.value.leaseId;
        op.fencingToken = reacquired.value.fencingToken;
      }
      if (this.#move(op, "running").ok) {
        op.attempts += 1;
        resumedReads.push(op.operationId);
      }
    }
    return { resumedReads, unknowned };
  }

  /**
   * The only way out of `unknown` (RC-03). "resume" is permitted for read
   * operations, or for effect operations carrying reconcile evidence.
   */
  reconcile(
    operationId: string,
    decision:
      | { action: "resume" }
      | {
          action: "final";
          outcome: "succeeded" | "failed" | "partial";
          result?: unknown;
          evidenceNote: string;
        },
  ): Result<OperationRecord> {
    const op = this.#ops.get(operationId);
    if (!op) return fail("TARGET_NOT_FOUND", `operation ${operationId} not found`);
    if (op.state !== "unknown") {
      return fail(
        "INVARIANT_VIOLATION",
        `reconcile requires the unknown state (state: ${op.state})`,
      );
    }
    if (decision.action === "resume") {
      if (op.kind === "effect") {
        return fail(
          "DECISION_CONFLICT",
          "an effect operation may not resume from unknown without reconcile evidence; use action=final",
        );
      }
      if (op.resourceId) {
        const acquired = this.#leases.acquire(op.resourceId, op.runId);
        if (!acquired.ok) return acquired;
        op.leaseId = acquired.value.leaseId;
        op.fencingToken = acquired.value.fencingToken;
      }
      const moved = this.#move(op, "running");
      if (!moved.ok) return moved;
      op.attempts += 1;
      op.awaitingReconcile = false;
      return moved;
    }
    const moved = this.#move(op, FINAL_OF[decision.outcome]);
    if (!moved.ok) return moved;
    if (decision.result !== undefined) op.result = decision.result;
    op.resultExpiresAt = this.#clock.now() + this.#resultRetentionMs;
    op.awaitingReconcile = false;
    return moved;
  }

  /** Envelope-level status for a finished operation (FZ-01 mapping). */
  responseStatus(op: OperationRecord): ResponseStatus {
    switch (op.state) {
      case "submitted":
      case "accepted":
        return "accepted";
      case "running":
      case "cancel-requested":
      case "cancel-delivered":
      case "still-running":
        return "running";
      case "succeeded":
        return "succeeded";
      case "failed":
        return "failed";
      case "partial":
        return "partial";
      case "unknown":
        return "unknown";
      case "stopped-observed":
        return "cancelled"; // ADR 0009
    }
  }

  /** Terminal results stay retrievable for the retention window (ADR 0011). */
  getResult(
    operationId: string,
  ): Result<{ status: ResponseStatus; result?: unknown; resultExpired: boolean }> {
    const op = this.#ops.get(operationId);
    if (!op) return fail("TARGET_NOT_FOUND", `operation ${operationId} not found`);
    const expired =
      op.resultExpiresAt !== undefined &&
      this.#clock.now() > op.resultExpiresAt;
    return ok({
      status: this.responseStatus(op),
      ...(op.result !== undefined && !expired ? { result: op.result } : {}),
      resultExpired: expired,
    });
  }
}
