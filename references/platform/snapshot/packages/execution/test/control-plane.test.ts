import { describe, expect, it } from "vitest";
import { FakeClock } from "@infosec/platform";
import { ControlPlane, DEDUPE_WINDOW_MS, type SubmitSpec } from "../src/control-plane.js";

function spec(over: Partial<SubmitSpec> = {}): SubmitSpec {
  return {
    tenantId: "t1",
    scopeId: "scope-a",
    principalId: "user-1",
    name: "append-effect",
    resourceId: "ws-1",
    idempotencyKey: "key-1",
    requestHash: "hash-1",
    ...over,
  };
}

describe("D-T05: idempotency partitioning and the unknown window rule", () => {
  it("same key in another scope is a distinct operation; cross-scope reads are forbidden", () => {
    const cp = new ControlPlane(new FakeClock(0));
    const a = cp.submit(spec());
    const b = cp.submit(spec({ scopeId: "scope-b" }));
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(a.value.deduplicated).toBe(false);
      expect(b.value.deduplicated).toBe(false);
      expect(a.value.op.operationId).not.toBe(b.value.op.operationId);
      const cross = cp.getOperation("t1", "scope-a", b.value.op.operationId);
      expect(cross.ok).toBe(false);
      if (!cross.ok) expect(cross.error.code).toBe("FORBIDDEN_SCOPE");
    }
  });

  it("same key with a different request hash in the same partition is a mismatch", () => {
    const cp = new ControlPlane(new FakeClock(0));
    cp.submit(spec());
    const again = cp.submit(spec({ requestHash: "hash-2" }));
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.code).toBe("IDEMPOTENCY_MISMATCH");
  });

  it("a terminal operation's key becomes reusable after the window; an unknown operation's key never silently does", async () => {
    const clock = new FakeClock(0);
    const cp = new ControlPlane(clock);
    // Terminal path.
    const first = cp.submit(spec({ idempotencyKey: "k-term" }));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const lease = cp.acquireLease("ws-1", "w1");
    expect(lease.ok).toBe(true);
    if (!lease.ok) return;
    cp.assign(first.value.op.operationId, "w1", lease.value.fencingToken);
    cp.reportEffect(first.value.op.operationId, "w1", lease.value.fencingToken, "succeeded", "done");
    clock.advance(DEDUPE_WINDOW_MS + 1);
    const reused = cp.submit(spec({ idempotencyKey: "k-term" }));
    expect(reused.ok).toBe(true);
    if (reused.ok) {
      expect(reused.value.deduplicated).toBe(false);
      expect(reused.value.op.operationId).not.toBe(first.value.op.operationId);
    }

    // Unknown path: window passing must NOT permit a rewrite.
    const second = cp.submit(spec({ idempotencyKey: "k-unknown", resourceId: "ws-2" }));
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const lease2 = cp.acquireLease("ws-2", "w1");
    if (!lease2.ok) throw new Error("lease2 failed");
    cp.assign(second.value.op.operationId, "w1", lease2.value.fencingToken);
    cp.onWorkerExit("w1");
    expect(cp.getOperationById(second.value.op.operationId)?.status).toBe("unknown");
    clock.advance(DEDUPE_WINDOW_MS + 1);
    const resubmitted = cp.submit(spec({ idempotencyKey: "k-unknown", resourceId: "ws-2" }));
    expect(resubmitted.ok).toBe(true);
    if (resubmitted.ok) {
      expect(resubmitted.value.deduplicated).toBe(true);
      expect(resubmitted.value.op.operationId).toBe(second.value.op.operationId);
      expect(resubmitted.value.op.status).toBe("unknown");
    }
  });
});

describe("D-T01: no trusted record, no final state", () => {
  it("confirmStopped with prose or an arbitrary outcome is rejected; the operation stays unknown until observation settles it", async () => {
    const cp = new ControlPlane(new FakeClock(0));
    const sub = cp.submit(spec({ resourceId: "ws-9" }));
    if (!sub.ok) throw new Error("submit failed");
    const lease = cp.acquireLease("ws-9", "w1");
    if (!lease.ok) throw new Error("lease failed");
    cp.assign(sub.value.op.operationId, "w1", lease.value.fencingToken);
    cp.onWorkerExit("w1");
    const opId = sub.value.op.operationId;
    expect(cp.getOperationById(opId)?.status).toBe("unknown");

    const prose = cp.confirmStopped(opId, { note: "the operator says it stopped" });
    expect(prose.ok).toBe(false);
    if (!prose.ok) expect(prose.error.code).toBe("EVIDENCE_INSUFFICIENT");
    const outcome = cp.confirmStopped(opId, { outcome: "succeeded" });
    expect(outcome.ok).toBe(false);
    expect(cp.getOperationById(opId)?.status).toBe("unknown");

    const undetermined = await cp.reconcile(opId, async () => ({
      determined: false,
      observation: "target unreachable",
    }));
    expect(undetermined.ok).toBe(false);
    expect(cp.getOperationById(opId)?.status).toBe("unknown");
    expect(cp.isResourceWritable("ws-9")).toBe(false);

    const settled = await cp.reconcile(opId, async () => ({
      determined: true,
      finalStatus: "succeeded",
      observation: "effects.log contains exactly one line for this operation",
    }));
    expect(settled.ok).toBe(true);
    expect(cp.getOperationById(opId)?.status).toBe("succeeded");
    expect(cp.getOperationById(opId)?.trustedRecord?.source).toBe("reconcile");
    expect(cp.isResourceWritable("ws-9")).toBe(true);
  });
});

describe("leases, fencing and the exit-point re-check (D-T02 logic half)", () => {
  it("an expired lease fails the exit-point check; a newer holder's fencing makes the old holder stale; frozen resources refuse new leases", () => {
    const clock = new FakeClock(0);
    const cp = new ControlPlane(clock);
    const sub = cp.submit(spec({ resourceId: "ws-7" }));
    if (!sub.ok) throw new Error("submit failed");
    const opId = sub.value.op.operationId;
    const lease1 = cp.acquireLease("ws-7", "w-old");
    if (!lease1.ok) throw new Error("lease failed");
    expect(cp.assign(opId, "w-old", lease1.value.fencingToken).ok).toBe(true);
    expect(cp.authorizeEffect(opId, "w-old", lease1.value.fencingToken).ok).toBe(true);

    clock.advance(61_000); // past the 60s TTL
    const expired = cp.authorizeEffect(opId, "w-old", lease1.value.fencingToken);
    expect(expired.ok).toBe(false);
    if (!expired.ok) expect(expired.error.code).toBe("LEASE_EXPIRED");

    const lease2 = cp.acquireLease("ws-7", "w-new");
    expect(lease2.ok).toBe(true);
    if (!lease2.ok) return;
    expect(lease2.value.fencingToken).toBe(lease1.value.fencingToken + 1);
    const stale = cp.authorizeEffect(opId, "w-old", lease1.value.fencingToken);
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.code).toBe("FENCING_STALE");
    // The stale worker's report is likewise refused.
    const staleReport = cp.reportEffect(opId, "w-old", lease1.value.fencingToken, "succeeded", "late");
    expect(staleReport.ok).toBe(false);

    cp.onWorkerExit("w-old");
    expect(cp.getOperationById(opId)?.status).toBe("unknown");
    const frozen = cp.acquireLease("ws-7", "w-third");
    expect(frozen.ok).toBe(false);
    if (!frozen.ok) expect(frozen.error.code).toBe("RESOURCE_BUSY");
  });

  it("a cancel requested after dispatch blocks the exit-point check", () => {
    const cp = new ControlPlane(new FakeClock(0));
    const sub = cp.submit(spec({ resourceId: "ws-8" }));
    if (!sub.ok) throw new Error("submit failed");
    const lease = cp.acquireLease("ws-8", "w1");
    if (!lease.ok) throw new Error("lease failed");
    cp.assign(sub.value.op.operationId, "w1", lease.value.fencingToken);
    expect(cp.requestCancel(sub.value.op.operationId).ok).toBe(true);
    const check = cp.authorizeEffect(sub.value.op.operationId, "w1", lease.value.fencingToken);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.error.code).toBe("DECISION_CONFLICT");
  });
});
