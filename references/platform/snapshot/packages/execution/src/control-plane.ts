import { fail, ok, type Clock, type Result } from "@infosec/platform";

/** ADR 0011 baselines, reused unchanged. */
export const LEASE_TTL_MS = 60_000;
export const DEDUPE_WINDOW_MS = 24 * 60 * 60_000;

export type OperationStatus =
  | "accepted"
  | "running"
  | "succeeded"
  | "failed"
  | "unknown"
  | "cancel-requested"
  | "stopped-observed"
  | "stop-unconfirmed";

export interface OperationRecord {
  operationId: string;
  tenantId: string;
  scopeId: string;
  principalId: string;
  name: string;
  resourceId: string;
  idempotencyKey: string;
  requestHash: string;
  status: OperationStatus;
  workerId?: string;
  fencingToken?: number;
  /** Four-stage cancel progress: 1 requested, 2 stop signalled, 3 stop reported, 4 observed. */
  cancelStage?: 1 | 2 | 3 | 4;
  /** Set only by a fencing-valid worker report or a reconcile observation. */
  trustedRecord?: { source: "worker-report" | "reconcile"; detail: string; at: number };
  createdAt: number;
  updatedAt: number;
}

export interface SubmitSpec {
  tenantId: string;
  scopeId: string;
  principalId: string;
  name: string;
  resourceId: string;
  idempotencyKey: string;
  requestHash: string;
}

interface Lease {
  workerId: string;
  fencingToken: number;
  expiresAt: number;
}

let opSeq = 0;

/**
 * The D execution control plane (ADR 0020): the single authority for
 * execution state. Workers hold per-resource leases with monotonic
 * fencing; every side effect must pass an exit-point re-check against
 * live control-plane state immediately before it happens; a stop is
 * only ever "observed", never asserted from prose or from a lost
 * receipt; resources with an unreconciled unknown operation are not
 * writable again until observation settles them.
 */
export class ControlPlane {
  #clock: Clock;
  #ops = new Map<string, OperationRecord>();
  #leases = new Map<string, Lease>();
  #fencingSeq = new Map<string, number>();
  /** Resources frozen for writes until an unknown operation reconciles. */
  #frozenResources = new Set<string>();

  constructor(clock: Clock) {
    this.#clock = clock;
  }

  #partitionKey(spec: SubmitSpec): string {
    return [spec.tenantId, spec.scopeId, spec.principalId, spec.name, spec.idempotencyKey].join("|");
  }

  submit(spec: SubmitSpec): Result<{ op: OperationRecord; deduplicated: boolean }> {
    const key = this.#partitionKey(spec);
    for (const op of this.#ops.values()) {
      if (this.#partitionKey(op) !== key) continue;
      if (op.requestHash !== spec.requestHash) {
        return fail(
          "IDEMPOTENCY_MISMATCH",
          `idempotency key ${spec.idempotencyKey} was used with a different request in this partition`,
        );
      }
      if (op.status === "unknown" || op.status === "stop-unconfirmed") {
        // D-T05: the dedupe window ending is not a rewrite permit for
        // an operation whose effects are still unknown.
        return ok({ op, deduplicated: true });
      }
      if (this.#clock.now() - op.createdAt <= DEDUPE_WINDOW_MS) {
        return ok({ op, deduplicated: true });
      }
      // Terminal and past the window: the key may be reused.
    }
    opSeq += 1;
    const op: OperationRecord = {
      operationId: `op_${String(opSeq).padStart(4, "0")}`,
      ...spec,
      status: "accepted",
      createdAt: this.#clock.now(),
      updatedAt: this.#clock.now(),
    };
    this.#ops.set(op.operationId, op);
    return ok({ op, deduplicated: false });
  }

  /** Internal accessor for trusted in-process components (no partition check). */
  getOperationById(operationId: string): OperationRecord | undefined {
    return this.#ops.get(operationId);
  }

  getOperation(
    tenantId: string,
    scopeId: string,
    operationId: string,
  ): Result<OperationRecord> {
    const op = this.#ops.get(operationId);
    if (!op) return fail("TARGET_NOT_FOUND", `no operation ${operationId}`);
    if (op.tenantId !== tenantId || op.scopeId !== scopeId) {
      return fail("FORBIDDEN_SCOPE", "operation belongs to another partition");
    }
    return ok(op);
  }

  acquireLease(resourceId: string, workerId: string): Result<{ fencingToken: number }> {
    if (this.#frozenResources.has(resourceId)) {
      return fail(
        "RESOURCE_BUSY",
        `resource ${resourceId} has an unreconciled unknown operation and is not writable`,
      );
    }
    const current = this.#leases.get(resourceId);
    if (
      current &&
      current.workerId !== workerId &&
      current.expiresAt > this.#clock.now()
    ) {
      return fail("RESOURCE_BUSY", `resource ${resourceId} is leased by ${current.workerId}`);
    }
    const fencingToken = (this.#fencingSeq.get(resourceId) ?? 0) + 1;
    this.#fencingSeq.set(resourceId, fencingToken);
    this.#leases.set(resourceId, {
      workerId,
      fencingToken,
      expiresAt: this.#clock.now() + LEASE_TTL_MS,
    });
    return ok({ fencingToken });
  }

  heartbeat(resourceId: string, workerId: string, fencingToken: number): Result<true> {
    const lease = this.#leases.get(resourceId);
    if (!lease || lease.workerId !== workerId || lease.fencingToken !== fencingToken) {
      return fail("FENCING_STALE", "heartbeat from a stale lease holder");
    }
    lease.expiresAt = this.#clock.now() + LEASE_TTL_MS;
    return ok(true);
  }

  assign(operationId: string, workerId: string, fencingToken: number): Result<OperationRecord> {
    const op = this.#ops.get(operationId);
    if (!op) return fail("TARGET_NOT_FOUND", `no operation ${operationId}`);
    const lease = this.#leases.get(op.resourceId);
    if (!lease || lease.workerId !== workerId || lease.fencingToken !== fencingToken) {
      return fail("FENCING_STALE", "assignment requires the current lease holder");
    }
    if (lease.expiresAt <= this.#clock.now()) {
      return fail("LEASE_EXPIRED", "lease expired before assignment");
    }
    if (op.status !== "accepted") {
      return fail("DECISION_CONFLICT", `operation is ${op.status}, not accepted`);
    }
    op.status = "running";
    op.workerId = workerId;
    op.fencingToken = fencingToken;
    op.updatedAt = this.#clock.now();
    return ok(op);
  }

  /**
   * The exit-point re-check (ADR 0020): a worker must call this
   * immediately before a real side effect. It re-validates the live
   * lease, the fencing token, and that no cancel has been requested.
   */
  authorizeEffect(
    operationId: string,
    workerId: string,
    fencingToken: number,
  ): Result<true> {
    const op = this.#ops.get(operationId);
    if (!op) return fail("TARGET_NOT_FOUND", `no operation ${operationId}`);
    if (op.status === "cancel-requested" || (op.cancelStage ?? 0) >= 1) {
      return fail("DECISION_CONFLICT", "a cancel was requested after dispatch");
    }
    if (op.status !== "running") {
      return fail("DECISION_CONFLICT", `operation is ${op.status}, not running`);
    }
    const lease = this.#leases.get(op.resourceId);
    if (!lease || lease.workerId !== workerId || lease.fencingToken !== fencingToken) {
      return fail("FENCING_STALE", "the caller's lease is no longer the current one");
    }
    if (lease.expiresAt <= this.#clock.now()) {
      return fail("LEASE_EXPIRED", "lease expired at the exit point");
    }
    if (op.workerId !== workerId || op.fencingToken !== fencingToken) {
      return fail("FENCING_STALE", "operation was reassigned under a newer fencing token");
    }
    return ok(true);
  }

  /** A fencing-valid worker report is a trusted execution record. */
  reportEffect(
    operationId: string,
    workerId: string,
    fencingToken: number,
    outcome: "succeeded" | "failed",
    detail: string,
  ): Result<OperationRecord> {
    const check = this.authorizeEffect(operationId, workerId, fencingToken);
    if (!check.ok) return check;
    const op = this.#ops.get(operationId)!;
    op.status = outcome;
    op.trustedRecord = { source: "worker-report", detail, at: this.#clock.now() };
    op.updatedAt = this.#clock.now();
    return ok(op);
  }

  /** The worker process died (or vanished): its running operations go unknown. */
  onWorkerExit(workerId: string): void {
    for (const op of this.#ops.values()) {
      if (op.workerId === workerId && (op.status === "running" || op.status === "cancel-requested")) {
        op.status = op.status === "cancel-requested" ? "stop-unconfirmed" : "unknown";
        op.updatedAt = this.#clock.now();
        this.#frozenResources.add(op.resourceId);
      }
    }
    for (const [resourceId, lease] of this.#leases) {
      if (lease.workerId === workerId) this.#leases.delete(resourceId);
    }
  }

  requestCancel(operationId: string): Result<OperationRecord> {
    const op = this.#ops.get(operationId);
    if (!op) return fail("TARGET_NOT_FOUND", `no operation ${operationId}`);
    if (op.status !== "running" && op.status !== "accepted") {
      return fail("DECISION_CONFLICT", `cannot cancel an operation that is ${op.status}`);
    }
    op.status = "cancel-requested";
    op.cancelStage = 1;
    op.updatedAt = this.#clock.now();
    return ok(op);
  }

  noteStopSignalled(operationId: string): void {
    const op = this.#ops.get(operationId);
    if (op && op.cancelStage === 1) op.cancelStage = 2;
  }

  noteStopReported(operationId: string, detail: string): void {
    const op = this.#ops.get(operationId);
    if (op && (op.cancelStage === 1 || op.cancelStage === 2)) {
      op.cancelStage = 3;
      op.trustedRecord = { source: "worker-report", detail, at: this.#clock.now() };
    }
  }

  /**
   * Settle a cancel by OBSERVATION of the target (stage 4). Only an
   * observer's finding can produce stopped-observed; an observer that
   * finds the target still running, or cannot determine its state,
   * leaves the operation stop-unconfirmed.
   */
  async observeStop(
    operationId: string,
    observer: () => Promise<{ stopped: boolean; detail: string }>,
  ): Promise<Result<OperationRecord>> {
    const op = this.#ops.get(operationId);
    if (!op) return fail("TARGET_NOT_FOUND", `no operation ${operationId}`);
    const finding = await observer();
    if (finding.stopped) {
      op.status = "stopped-observed";
      op.cancelStage = 4;
      op.trustedRecord = { source: "reconcile", detail: finding.detail, at: this.#clock.now() };
      this.#frozenResources.delete(op.resourceId);
    } else {
      op.status = "stop-unconfirmed";
    }
    op.updatedAt = this.#clock.now();
    return ok(op);
  }

  /**
   * D-T01: confirmStopped finalizes NOTHING on its own. Without a
   * trusted execution record (fencing-valid worker report or a prior
   * observation) it is rejected and the operation keeps its state —
   * prose explanations and arbitrary outcome claims are not evidence.
   */
  confirmStopped(
    operationId: string,
    claim: { outcome?: string; note?: string },
  ): Result<OperationRecord> {
    const op = this.#ops.get(operationId);
    if (!op) return fail("TARGET_NOT_FOUND", `no operation ${operationId}`);
    if (op.status === "stopped-observed") return ok(op);
    if (!op.trustedRecord) {
      return fail(
        "EVIDENCE_INSUFFICIENT",
        `no trusted execution record exists for ${operationId}; a claim (${claim.outcome ?? claim.note ?? "unspecified"}) cannot settle it`,
      );
    }
    return fail(
      "DECISION_CONFLICT",
      "a trusted record exists but it does not establish a stop; use reconcile/observeStop",
    );
  }

  /**
   * Reconcile an unknown operation FROM OBSERVATION of the target.
   * The observer's finding, not the lost receipt, decides the final
   * state; an observer that cannot determine the state changes
   * nothing.
   */
  async reconcile(
    operationId: string,
    observer: () => Promise<
      | { determined: true; finalStatus: "succeeded" | "failed" | "stopped-observed"; observation: string }
      | { determined: false; observation: string }
    >,
  ): Promise<Result<OperationRecord>> {
    const op = this.#ops.get(operationId);
    if (!op) return fail("TARGET_NOT_FOUND", `no operation ${operationId}`);
    if (op.status !== "unknown" && op.status !== "stop-unconfirmed") {
      return fail("DECISION_CONFLICT", `operation is ${op.status}; reconcile applies to unknown operations`);
    }
    const finding = await observer();
    if (!finding.determined) {
      return fail("EVIDENCE_INSUFFICIENT", `observation could not determine the state: ${finding.observation}`);
    }
    op.status = finding.finalStatus;
    op.trustedRecord = { source: "reconcile", detail: finding.observation, at: this.#clock.now() };
    op.updatedAt = this.#clock.now();
    this.#frozenResources.delete(op.resourceId);
    return ok(op);
  }

  isResourceWritable(resourceId: string): boolean {
    return !this.#frozenResources.has(resourceId);
  }
}
