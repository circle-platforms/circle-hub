import { describe, expect, it } from "vitest";
import {
  FakeClock,
  IdGen,
  LeaseManager,
  OperationService,
  Registry,
  TaskService,
  iso,
} from "../src/index.js";

function makePlatform(startMs = 1_700_000_000_000) {
  const clock = new FakeClock(startMs);
  const ids = new IdGen();
  const leases = new LeaseManager(clock, ids);
  const tasks = new TaskService(clock, ids);
  const ops = new OperationService(clock, ids, leases);
  const registry = new Registry(clock, ids);
  return { clock, ids, leases, tasks, ops, registry };
}

const BASE = {
  tenantId: "tnt_main",
  scopeId: "scp_a",
  principalId: "prn_alice",
  runId: "run_000001",
};

describe("task service (C)", () => {
  it("walks the frozen phase machine and rejects illegal jumps", () => {
    const { tasks } = makePlatform();
    const task = tasks.createTask({ ...BASE, title: "demo" });
    expect(task.phase).toBe("draft");
    expect(tasks.transition(task.taskId, "delivered").ok).toBe(false);
    expect(tasks.transition(task.taskId, "admitted").ok).toBe(true);
    expect(tasks.transition(task.taskId, "running").ok).toBe(true);
    expect(task.runId).toMatch(/^run_/);
  });

  it("pending input: stale and expired responses never advance the task", () => {
    const { tasks, clock } = makePlatform();
    const task = tasks.createTask({ ...BASE, title: "needs input" });
    tasks.transition(task.taskId, "admitted");
    tasks.transition(task.taskId, "running");
    const pending = tasks.requestInput(task.taskId, {
      decisionType: "clarification",
      question: "which scope?",
    });
    expect(pending.ok).toBe(true);
    if (!pending.ok) return;
    expect(task.phase).toBe("waiting-input");

    const stale = tasks.respond(task.taskId, {
      requestId: pending.value.requestId,
      inputRevisionId: "inrev_999999",
      actorId: "act_000001",
      decision: "scope A",
      respondedAt: iso(clock.now()),
      idempotencyKey: "resp-0001",
    });
    expect(stale.ok && stale.value.outcome).toBe("stale-revision");
    expect(task.phase).toBe("waiting-input");

    const accepted = tasks.respond(task.taskId, {
      requestId: pending.value.requestId,
      inputRevisionId: task.inputRevisionId,
      actorId: "act_000001",
      decision: "scope A",
      respondedAt: iso(clock.now()),
      idempotencyKey: "resp-0002",
    });
    expect(accepted.ok && accepted.value.outcome).toBe("accepted");
    expect(task.phase).toBe("running");
  });

  it("pending input: an expired request rejects the late response", () => {
    const { tasks, clock } = makePlatform();
    const task = tasks.createTask({ ...BASE, title: "expiring" });
    tasks.transition(task.taskId, "admitted");
    tasks.transition(task.taskId, "running");
    const pending = tasks.requestInput(task.taskId, {
      decisionType: "approval",
      question: "approve?",
      ttlMs: 1_000,
    });
    if (!pending.ok) throw new Error("requestInput failed");
    clock.advance(2_000);
    const late = tasks.respond(task.taskId, {
      requestId: pending.value.requestId,
      inputRevisionId: task.inputRevisionId,
      actorId: "act_000001",
      decision: "yes",
      respondedAt: iso(clock.now()),
      idempotencyKey: "resp-0003",
    });
    expect(late.ok && late.value.outcome).toBe("expired");
    expect(task.phase).toBe("waiting-input");
  });

  it("delivery gate: required items first, under-review only", () => {
    const { tasks } = makePlatform();
    const task = tasks.createTask({ ...BASE, title: "gated" });
    tasks.transition(task.taskId, "admitted");
    tasks.transition(task.taskId, "running");

    const wrongRevision = tasks.attachChecklist(task.taskId, {
      taskId: task.taskId,
      inputRevisionId: "inrev_999999",
      items: [],
    });
    expect(!wrongRevision.ok && wrongRevision.error.code).toBe(
      "INPUT_REVISION_STALE",
    );

    expect(
      tasks.attachChecklist(task.taskId, {
        taskId: task.taskId,
        inputRevisionId: task.inputRevisionId,
        items: [
          {
            itemId: "v-cite",
            kind: "verification",
            refId: "evd_000001",
            required: true,
            satisfied: false,
          },
        ],
      }).ok,
    ).toBe(true);

    // running -> delivered directly is impossible even with a checklist.
    expect(tasks.deliver(task.taskId).ok).toBe(false);
    tasks.transition(task.taskId, "under-review");
    const blocked = tasks.deliver(task.taskId);
    expect(!blocked.ok && blocked.error.code).toBe("DECISION_CONFLICT");
    expect(tasks.satisfyItem(task.taskId, "v-cite").ok).toBe(true);
    const delivered = tasks.deliver(task.taskId);
    expect(delivered.ok && delivered.value.phase).toBe("delivered");
  });
});

describe("leases and fencing", () => {
  it("busy resources, renewal, release and monotonic fencing", () => {
    const { leases } = makePlatform();
    const first = leases.acquire("res_dev1", "run_000001");
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.fencingToken).toBe(1);
    expect(leases.acquire("res_dev1", "run_000002").ok).toBe(false);
    expect(leases.renew(first.value.leaseId, 99).ok).toBe(false);
    expect(leases.renew(first.value.leaseId, 1).ok).toBe(true);
    expect(leases.release(first.value.leaseId, 1).ok).toBe(true);
    const second = leases.acquire("res_dev1", "run_000002");
    expect(second.ok && second.value.fencingToken).toBe(2);
  });
});

describe("operation service (D): idempotency per ADR 0011", () => {
  it("same key + same request dedupes; different request mismatches; window expiry frees the key", () => {
    const { ops, clock } = makePlatform();
    const submit = () =>
      ops.submit({
        ...BASE,
        name: " kb.search",
        kind: "read",
        idempotencyKey: "idem-0001",
        request: { q: "warranty" },
      });
    const first = submit();
    expect(first.ok && first.value.duplicate).toBe(false);
    const again = submit();
    expect(again.ok && again.value.duplicate).toBe(true);
    if (first.ok && again.ok) {
      expect(again.value.operation.operationId).toBe(
        first.value.operation.operationId,
      );
    }
    const mismatch = ops.submit({
      ...BASE,
      name: " kb.search",
      kind: "read",
      idempotencyKey: "idem-0001",
      request: { q: "different" },
    });
    expect(!mismatch.ok && mismatch.error.code).toBe("IDEMPOTENCY_MISMATCH");

    clock.advance(25 * 3_600_000);
    const afterWindow = submit();
    expect(afterWindow.ok && afterWindow.value.duplicate).toBe(false);
  });

  it("a stale holder cannot complete after losing the lease", () => {
    const { ops, clock } = makePlatform();
    const a = ops.submit({
      ...BASE,
      name: "device.reboot",
      kind: "effect",
      resourceId: "res_dev1",
      idempotencyKey: "idem-0010",
      request: { delay: 0 },
    });
    if (!a.ok) throw new Error("submit A failed");
    expect(ops.start(a.value.operation.operationId).ok).toBe(true);
    clock.advance(61_000); // lease (60s) lapses without a sweep
    const b = ops.submit({
      ...BASE,
      name: "device.reboot",
      kind: "effect",
      resourceId: "res_dev1",
      idempotencyKey: "idem-0011",
      request: { delay: 0 },
    });
    expect(b.ok).toBe(true); // resource is free again, fencing advanced
    const lateComplete = ops.complete(a.value.operation.operationId, "succeeded");
    expect(!lateComplete.ok && lateComplete.error.code).toBe("FENCING_STALE");
  });
});

describe("operation service (D): lease expiry split per ADR 0011", () => {
  it("effect operation: expiry -> unknown, no auto-retry, reconcile-only exit", () => {
    const { ops, clock } = makePlatform();
    const sub = ops.submit({
      ...BASE,
      name: "device.set-ntp",
      kind: "effect",
      resourceId: "res_dev1",
      idempotencyKey: "idem-0020",
      request: { server: "ntp.example" },
    });
    if (!sub.ok) throw new Error("submit failed");
    const opId = sub.value.operation.operationId;
    expect(ops.start(opId).ok).toBe(true);

    clock.advance(61_000);
    const sweep = ops.sweep();
    expect(sweep.unknowned).toContain(opId);
    const op = ops.get(opId);
    expect(op?.state).toBe("unknown");
    expect(op?.awaitingReconcile).toBe(true);
    expect(op?.attempts).toBe(1); // never silently re-executed

    const resume = ops.reconcile(opId, { action: "resume" });
    expect(!resume.ok && resume.error.code).toBe("DECISION_CONFLICT");
    const final = ops.reconcile(opId, {
      action: "final",
      outcome: "succeeded",
      evidenceNote: "readback shows the target NTP server",
    });
    expect(final.ok && final.value.state).toBe("succeeded");
  });

  it("read operation: expiry auto-resumes under a fresh fencing token", () => {
    const { ops, clock } = makePlatform();
    const sub = ops.submit({
      ...BASE,
      name: "device.get-config",
      kind: "read",
      resourceId: "res_dev1",
      idempotencyKey: "idem-0021",
      request: {},
    });
    if (!sub.ok) throw new Error("submit failed");
    const opId = sub.value.operation.operationId;
    const tokenBefore = sub.value.operation.fencingToken;
    expect(ops.start(opId).ok).toBe(true);

    clock.advance(61_000);
    const sweep = ops.sweep();
    expect(sweep.resumedReads).toContain(opId);
    const op = ops.get(opId);
    expect(op?.state).toBe("running");
    expect(op?.attempts).toBe(2);
    expect(op?.fencingToken).toBeGreaterThan(tokenBefore ?? 0);
    expect(ops.writeGuard(opId).ok).toBe(true);
    expect(ops.complete(opId, "succeeded", { cfg: 1 }).ok).toBe(true);
  });

  it("markUnknown is the receipt-loss entry point; only reconcile may exit it", () => {
    const { ops } = makePlatform();
    const sub = ops.submit({
      ...BASE,
      name: "device.commit",
      kind: "effect",
      idempotencyKey: "idem-0024",
      request: {},
    });
    if (!sub.ok) throw new Error("submit failed");
    const opId = sub.value.operation.operationId;
    ops.start(opId);
    const unknown = ops.markUnknown(opId);
    expect(unknown.ok && unknown.value.state).toBe("unknown");
    expect(unknown.ok && unknown.value.awaitingReconcile).toBe(true);
    expect(ops.complete(opId, "succeeded").ok).toBe(false);
    const final = ops.reconcile(opId, {
      action: "final",
      outcome: "succeeded",
      evidenceNote: "readback confirms the change took effect",
    });
    expect(final.ok && final.value.state).toBe("succeeded");
  });

  it("cancel reaches stopped-observed and reports status cancelled (ADR 0009)", () => {
    const { ops } = makePlatform();
    const sub = ops.submit({
      ...BASE,
      name: "device.long-op",
      kind: "effect",
      resourceId: "res_dev1",
      idempotencyKey: "idem-0022",
      request: {},
    });
    if (!sub.ok) throw new Error("submit failed");
    const opId = sub.value.operation.operationId;
    ops.start(opId);
    expect(ops.requestCancel(opId).ok).toBe(true);
    const stopped = ops.confirmStopped(opId);
    expect(stopped.ok && stopped.value.state).toBe("stopped-observed");
    expect(ops.responseStatus(stopped.ok ? stopped.value : sub.value.operation)).toBe(
      "cancelled",
    );
  });

  it("terminal results expire after the 7d retention window", () => {
    const { ops, clock } = makePlatform();
    const sub = ops.submit({
      ...BASE,
      name: "kb.search",
      kind: "read",
      idempotencyKey: "idem-0023",
      request: { q: "x" },
    });
    if (!sub.ok) throw new Error("submit failed");
    const opId = sub.value.operation.operationId;
    ops.start(opId);
    ops.complete(opId, "succeeded", { hits: 3 });
    const fresh = ops.getResult(opId);
    expect(fresh.ok && fresh.value.result).toEqual({ hits: 3 });
    clock.advance(8 * 24 * 3_600_000);
    const stale = ops.getResult(opId);
    expect(stale.ok && stale.value.resultExpired).toBe(true);
    expect(stale.ok && stale.value.result).toBeUndefined();
  });
});

describe("registry partitions per ADR 0012", () => {
  it("items are invisible across (tenant, scope) partitions", () => {
    const { registry } = makePlatform();
    const item = registry.register({
      tenantId: "tnt_main",
      scopeId: "scp_a",
      kind: "evidence",
      sha256: "a".repeat(64),
      label: "readback capture",
      bindings: { operationId: "op_000001" },
    });
    expect(registry.get(item.id, "tnt_main", "scp_a").ok).toBe(true);
    const cross = registry.get(item.id, "tnt_main", "scp_b");
    expect(!cross.ok && cross.error.code).toBe("FORBIDDEN_SCOPE");
    expect(registry.list("tnt_main", "scp_b")).toHaveLength(0);
    expect(registry.list("tnt_main", "scp_a")).toHaveLength(1);
  });
});
