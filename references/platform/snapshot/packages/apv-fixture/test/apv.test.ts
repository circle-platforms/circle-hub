import { describe, expect, it } from "vitest";
import { FakeClock, IdGen, TaskService } from "@infosec/platform";
import { makeStack, runAllScenarios } from "../src/index.js";

describe("SMP-V02-02 scenarios against the SMP-V02-01 fixture", () => {
  const results = runAllScenarios();

  it("all four scenarios pass every expectation check", () => {
    expect(results.map((r) => r.id)).toEqual([
      "apv-s1-normal-change",
      "apv-s2-receipt-loss",
      "apv-s3-version-conflict",
      "apv-s4-identity-drift",
    ]);
    for (const r of results) {
      for (const c of r.checks) {
        expect(c.passed, `${r.id} / ${c.name}`).toBe(true);
      }
    }
  });
});

describe("injection points not covered by the four scenarios", () => {
  it("INJ-APV-2: mid-commit disconnect -> unknown; reconcile learns not-applied", () => {
    const { fixture, driver, ops } = makeStack();
    driver.openSession();
    driver.readConfig("vs.web");
    driver.stageChange("vs.web", "profile=upgraded");
    fixture.arm("INJ-APV-2");
    const commit = driver.commitChange();
    expect(commit.ok && commit.value.outcome).toBe("unknown");
    const opId = commit.ok ? commit.value.operationId : undefined;
    if (!opId) throw new Error("no operation id");
    expect(fixture.changeCount).toBe(0); // fixture-side truth: not applied
    const reconciled = driver.reconcileCommit(opId);
    expect(reconciled.ok && reconciled.value.applied).toBe(false);
    expect(ops.get(opId)?.state).toBe("failed");
    driver.closeSession();
  });

  it("INJ-APV-5: slow read is classified as a timeout, not as unknown content", () => {
    const { fixture, driver } = makeStack();
    driver.openSession();
    fixture.arm("INJ-APV-5");
    const read = driver.readConfig("vs.web");
    expect(!read.ok && read.error.code).toBe("UPSTREAM_TIMEOUT");
    expect(!read.ok && read.error.retryable).toBe(true);
    fixture.disarm("INJ-APV-5");
    expect(driver.readConfig("vs.web").ok).toBe(true);
    driver.closeSession();
  });

  it("INJ-APV-5 on commit: a late receipt means unknown, settled by readback", () => {
    const { fixture, driver, ops } = makeStack();
    driver.openSession();
    driver.readConfig("vs.web");
    driver.stageChange("vs.web", "profile=upgraded");
    fixture.arm("INJ-APV-5");
    const commit = driver.commitChange();
    expect(commit.ok && commit.value.outcome).toBe("unknown");
    const opId = commit.ok ? commit.value.operationId : undefined;
    if (!opId) throw new Error("no operation id");
    expect(fixture.changeCount).toBe(1); // it did apply; the receipt was just late
    const reconciled = driver.reconcileCommit(opId);
    expect(reconciled.ok && reconciled.value.applied).toBe(true);
    expect(ops.get(opId)?.state).toBe("succeeded");
    fixture.disarm("INJ-APV-5");
    driver.rollback(1);
    driver.closeSession();
  });
});

describe("V02 vertical slice through the completion checklist", () => {
  it("the receipt-loss scenario delivers only with reconcile + cleanup items satisfied", () => {
    const clock = new FakeClock(1_700_000_000_000);
    const ids = new IdGen();
    const tasks = new TaskService(clock, ids);
    const { fixture, driver } = makeStack();

    const task = tasks.createTask({
      tenantId: "tnt_main",
      scopeId: "scp_demo_a",
      principalId: "prn_alice",
      title: "APV 变更（含回执丢失对账）",
    });
    tasks.transition(task.taskId, "admitted");
    tasks.transition(task.taskId, "running");

    fixture.arm("INJ-APV-1");
    expect(driver.openSession().ok).toBe(true);
    expect(driver.readConfig("vs.web").ok).toBe(true);
    expect(driver.stageChange("vs.web", "profile=upgraded").ok).toBe(true);
    const commit = driver.commitChange();
    if (!commit.ok || commit.value.outcome !== "unknown" || !commit.value.operationId) {
      throw new Error("expected an unknown commit");
    }
    const reconciled = driver.reconcileCommit(commit.value.operationId);
    expect(reconciled.ok && reconciled.value.applied).toBe(true);
    expect(driver.rollback(1).ok).toBe(true);
    expect(driver.closeSession().ok).toBe(true);
    const clean = driver.verifyClean({ "vs.web": "profile=baseline" });

    expect(
      tasks.attachChecklist(task.taskId, {
        taskId: task.taskId,
        inputRevisionId: task.inputRevisionId,
        items: [
          { itemId: "v02-identity", kind: "verification", refId: "EMU-SN-0001", required: true, satisfied: true },
          { itemId: "v02-readback", kind: "verification", refId: commit.value.operationId, required: true, satisfied: reconciled.ok },
          { itemId: "v02-reconcile", kind: "operation-reconcile", refId: commit.value.operationId, required: true, satisfied: reconciled.ok && reconciled.value.applied },
          { itemId: "v02-cleanup", kind: "verification", refId: commit.value.operationId, required: true, satisfied: clean.configMatchesBaseline && !clean.sessionResidue && !clean.stagedResidue },
          { itemId: "v02-change-recorded", kind: "artifact-registered", refId: driver.lastChangeRecordId ?? "n/a", required: true, satisfied: driver.lastChangeRecordId !== undefined },
        ],
      }).ok,
    ).toBe(true);
    // The change record exists because reconcile confirmed the change
    // took effect and registered it with the readback evidence.
    expect(driver.lastChangeRecordId).toBeDefined();
    tasks.transition(task.taskId, "under-review");
    expect(tasks.deliver(task.taskId).ok).toBe(true);
  });
});
