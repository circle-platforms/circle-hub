import {
  fail,
  ok,
  type OperationService,
  type Result,
} from "@infosec/platform";
import { createHash } from "node:crypto";

function sha256Json(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
import type { ApvFixture, Receipt } from "./fixture.js";

interface RegistryLike {
  register(input: {
    tenantId: string;
    scopeId: string;
    kind: "evidence" | "artifact";
    sha256: string;
    label: string;
    bindings: Record<string, string>;
  }): { id: string };
}
interface IdGenLike {
  next(prefix: string): string;
}

export interface CommitOutcome {
  outcome: "committed" | "unknown";
  newVersion?: number;
  operationId?: string;
}

/**
 * The V02 operation driver: every device command runs as a platform
 * operation (object D), identity is verified on every receipt
 * (AUTH-07), a lost or late commit receipt sends the operation to
 * `unknown` and only a readback-based reconcile may settle it (RC-03).
 */
export class ApvDriver {
  #fixture: ApvFixture;
  #ops: OperationService;
  #registry: RegistryLike;
  #ids: IdGenLike;
  #ctx: { tenantId: string; scopeId: string; principalId: string; runId: string };
  #timeoutMs: number;

  #expectedSerial: string | undefined;
  #sessionOpen = false;
  #halted = false;
  #lastVersion: number | undefined;
  #stageId: string | undefined;
  #pendingObject: string | undefined;
  #pendingValue: string | undefined;
  driftEvidenceId: string | undefined;
  lastChangeRecordId: string | undefined;

  constructor(deps: {
    fixture: ApvFixture;
    ops: OperationService;
    registry: RegistryLike;
    ids: IdGenLike;
    ctx: { tenantId: string; scopeId: string; principalId: string; runId: string };
    timeoutMs?: number;
  }) {
    this.#fixture = deps.fixture;
    this.#ops = deps.ops;
    this.#registry = deps.registry;
    this.#ids = deps.ids;
    this.#ctx = deps.ctx;
    this.#timeoutMs = deps.timeoutMs ?? 5_000;
  }

  get halted(): boolean {
    return this.#halted;
  }
  get lastKnownVersion(): number | undefined {
    return this.#lastVersion;
  }
  get sessionOpen(): boolean {
    return this.#sessionOpen;
  }

  #submit(name: string, kind: "read" | "effect", request: unknown) {
    return this.#ops.submit({
      ...this.#ctx,
      name,
      kind,
      idempotencyKey: this.#ids.next("idem"),
      request,
    });
  }

  #identityDrifted(receipt: Receipt): boolean {
    if (
      this.#expectedSerial &&
      receipt.identity.serial !== this.#expectedSerial
    ) {
      this.#halted = true;
      const evidence = this.#registry.register({
        tenantId: this.#ctx.tenantId,
        scopeId: this.#ctx.scopeId,
        kind: "evidence",
        sha256: sha256Json({
          expected: this.#expectedSerial,
          reported: receipt.identity.serial,
        }),
        label: "设备身份漂移证据",
        bindings: {
          expectedSerial: this.#expectedSerial,
          reportedSerial: receipt.identity.serial,
        },
      });
      this.driftEvidenceId = evidence.id;
      return true;
    }
    return false;
  }

  #driftFail<T>(): Result<T> {
    return fail(
      "TARGET_IDENTITY_MISMATCH",
      `device identity drift detected; driver halted (evidence: ${this.driftEvidenceId ?? "n/a"})`,
    );
  }

  #haltedGuard<T>(): Result<T> | undefined {
    if (this.#halted) {
      return fail(
        "TARGET_IDENTITY_MISMATCH",
        "driver is halted after an identity drift; no further operations are attempted",
      );
    }
    return undefined;
  }

  openSession(): Result<{ sessionId: string; serial: string }> {
    const guard = this.#haltedGuard<{ sessionId: string; serial: string }>();
    if (guard) return guard;
    const sub = this.#submit("apv.session.open", "effect", {});
    if (!sub.ok) return sub;
    const opId = sub.value.operation.operationId;
    this.#ops.start(opId);
    const receipt = this.#fixture.open();
    if (!receipt.ok || !receipt.sessionId) {
      this.#ops.complete(opId, "failed");
      return fail("TARGET_UNREACHABLE", receipt.message ?? "session.open failed");
    }
    this.#expectedSerial = receipt.identity.serial;
    this.#sessionOpen = true;
    this.#lastVersion = receipt.configVersion;
    this.#ops.complete(opId, "succeeded", { sessionId: receipt.sessionId });
    return ok({ sessionId: receipt.sessionId, serial: receipt.identity.serial });
  }

  readConfig(object: string): Result<{ value?: string; configVersion: number }> {
    const guard = this.#haltedGuard<{ value?: string; configVersion: number }>();
    if (guard) return guard;
    const sub = this.#submit("apv.config.read", "read", { object });
    if (!sub.ok) return sub;
    const opId = sub.value.operation.operationId;
    this.#ops.start(opId);
    const receipt = this.#fixture.read(object);
    if (this.#identityDrifted(receipt)) {
      this.#ops.complete(opId, "failed");
      return this.#driftFail();
    }
    if (receipt.delayMs > this.#timeoutMs) {
      this.#ops.complete(opId, "failed");
      return fail(
        "UPSTREAM_TIMEOUT",
        `device response exceeded the ${this.#timeoutMs}ms window (simulated ${receipt.delayMs}ms)`,
      );
    }
    if (!receipt.ok) {
      this.#ops.complete(opId, "failed");
      return fail("TARGET_UNREACHABLE", receipt.message ?? "config.read failed");
    }
    this.#lastVersion = receipt.configVersion;
    const value = receipt.value;
    this.#ops.complete(opId, "succeeded", { value });
    return ok({ value, configVersion: receipt.configVersion ?? 0 });
  }

  stageChange(object: string, value: string): Result<{ stageId: string }> {
    const guard = this.#haltedGuard<{ stageId: string }>();
    if (guard) return guard;
    const baseVersion = this.#lastVersion ?? this.#fixture.configVersion;
    const sub = this.#submit("apv.config.stage", "effect", { object, value, baseVersion });
    if (!sub.ok) return sub;
    const opId = sub.value.operation.operationId;
    this.#ops.start(opId);
    const receipt = this.#fixture.stage(object, value, baseVersion);
    if (this.#identityDrifted(receipt)) {
      this.#ops.complete(opId, "failed");
      return this.#driftFail();
    }
    if (!receipt.ok) {
      this.#ops.complete(opId, "failed");
      if (receipt.errorCode === "VERSION_CONFLICT") {
        return fail(
          "INPUT_REVISION_STALE",
          receipt.message ?? "config version conflict",
        );
      }
      return fail("TARGET_UNREACHABLE", receipt.message ?? "config.stage failed");
    }
    this.#stageId = receipt.stageId;
    this.#pendingObject = object;
    this.#pendingValue = value;
    this.#ops.complete(opId, "succeeded", { stageId: receipt.stageId });
    return ok({ stageId: receipt.stageId ?? "" });
  }

  commitChange(): Result<CommitOutcome> {
    const guard = this.#haltedGuard<CommitOutcome>();
    if (guard) return guard;
    if (!this.#stageId) {
      return fail("INVARIANT_VIOLATION", "no staged change to commit");
    }
    const sub = this.#submit("apv.config.commit", "effect", { stageId: this.#stageId });
    if (!sub.ok) return sub;
    const opId = sub.value.operation.operationId;
    this.#ops.start(opId);
    const receipt = this.#fixture.commit(this.#stageId);
    if (this.#identityDrifted(receipt)) {
      this.#ops.markUnknown(opId);
      return this.#driftFail();
    }
    if (receipt.receiptLost || receipt.disconnected || receipt.delayMs > this.#timeoutMs) {
      // The change may or may not have taken effect; only reconcile may
      // settle this operation. A blind retry is forbidden (EFF-04).
      this.#ops.markUnknown(opId);
      return ok({ outcome: "unknown", operationId: opId });
    }
    if (!receipt.ok) {
      this.#ops.complete(opId, "failed");
      return fail("TARGET_UNREACHABLE", receipt.message ?? "config.commit failed");
    }
    this.#lastVersion = receipt.configVersion;
    this.#stageId = undefined;
    const record = this.#registry.register({
      tenantId: this.#ctx.tenantId,
      scopeId: this.#ctx.scopeId,
      kind: "artifact",
      sha256: sha256Json({ op: opId, version: receipt.configVersion }),
      label: "设备变更记录",
      bindings: { operationId: opId, configVersion: String(receipt.configVersion) },
    });
    this.lastChangeRecordId = record.id;
    this.#ops.complete(opId, "succeeded", { newVersion: receipt.configVersion });
    return ok({ outcome: "committed", newVersion: receipt.configVersion });
  }

  /**
   * Settle an unknown commit by reading the device back. The readback
   * (object value + config version) is registered as evidence and cited
   * in the reconcile note; the change is never resubmitted.
   */
  reconcileCommit(operationId: string): Result<{ applied: boolean; currentVersion: number }> {
    if (!this.#pendingObject) {
      return fail("INVARIANT_VIOLATION", "no pending change to reconcile");
    }
    const probe = this.#fixture.read(this.#pendingObject);
    if (this.#identityDrifted(probe)) return this.#driftFail();
    const applied = probe.ok && probe.value === this.#pendingValue;
    const evidence = this.#registry.register({
      tenantId: this.#ctx.tenantId,
      scopeId: this.#ctx.scopeId,
      kind: "evidence",
      sha256: sha256Json({
        object: this.#pendingObject,
        value: probe.value,
        version: probe.configVersion,
      }),
      label: "对账回读证据",
      bindings: { operationId, object: this.#pendingObject },
    });
    const settled = this.#ops.reconcile(operationId, {
      action: "final",
      outcome: applied ? "succeeded" : "failed",
      evidenceNote: `readback via ${evidence.id}: ${this.#pendingObject}=${probe.value} at config version ${probe.configVersion}`,
    });
    if (!settled.ok) return settled;
    if (applied) {
      this.#lastVersion = probe.configVersion;
      this.#stageId = undefined;
      // The change did take effect, so its change record is registered
      // now, at reconcile time, citing the readback evidence.
      const record = this.#registry.register({
        tenantId: this.#ctx.tenantId,
        scopeId: this.#ctx.scopeId,
        kind: "artifact",
        sha256: sha256Json({ op: operationId, version: probe.configVersion }),
        label: "设备变更记录（对账确认）",
        bindings: { operationId, configVersion: String(probe.configVersion) },
      });
      this.lastChangeRecordId = record.id;
    }
    return ok({ applied, currentVersion: probe.configVersion ?? 0 });
  }

  rollback(toVersion: number): Result<{ newVersion: number }> {
    const guard = this.#haltedGuard<{ newVersion: number }>();
    if (guard) return guard;
    const sub = this.#submit("apv.config.rollback", "effect", { toVersion });
    if (!sub.ok) return sub;
    const opId = sub.value.operation.operationId;
    this.#ops.start(opId);
    const receipt = this.#fixture.rollback(toVersion);
    if (this.#identityDrifted(receipt)) {
      this.#ops.complete(opId, "failed");
      return this.#driftFail();
    }
    if (!receipt.ok) {
      this.#ops.complete(opId, "failed");
      return fail("TARGET_UNREACHABLE", receipt.message ?? "config.rollback failed");
    }
    this.#lastVersion = receipt.configVersion;
    this.#ops.complete(opId, "succeeded", { newVersion: receipt.configVersion });
    return ok({ newVersion: receipt.configVersion ?? 0 });
  }

  /** Closing is a safety action: allowed even while halted. */
  closeSession(): Result<{ closed: true }> {
    const receipt = this.#fixture.close();
    if (!receipt.ok) {
      return fail("TARGET_UNREACHABLE", receipt.message ?? "session.close failed");
    }
    this.#sessionOpen = false;
    this.#stageId = undefined;
    return ok({ closed: true });
  }

  /** Cleanup verification against a baseline config (content equality). */
  verifyClean(baselineConfig: Record<string, string>): {
    sessionResidue: boolean;
    stagedResidue: boolean;
    configMatchesBaseline: boolean;
  } {
    const snap = this.#fixture.snapshotState();
    return {
      sessionResidue: snap.sessionActive,
      stagedResidue: snap.staged,
      configMatchesBaseline:
        JSON.stringify(snap.config) === JSON.stringify(baselineConfig),
    };
  }
}
