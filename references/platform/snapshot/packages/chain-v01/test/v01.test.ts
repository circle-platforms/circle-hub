import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ScriptedAssessor } from "@infosec/assessor";
import { KnowledgeStore } from "@infosec/knowledge";
import { FakeClock, IdGen, Registry, TaskService } from "@infosec/platform";
import {
  KnowledgeQaService,
  runCalibration,
  type StandardSample,
} from "../src/index.js";

const SAMPLES_DIR =
  process.env.V01_SAMPLES_DIR ??
  fileURLToPath(new URL("../../../samples/v01/", import.meta.url));

function loadSample(name: string): StandardSample {
  return JSON.parse(readFileSync(`${SAMPLES_DIR}${name}`, "utf8")) as StandardSample;
}

const ALL = [
  "smp-v01-01.json",
  "smp-v01-02.json",
  "smp-v01-03.json",
  "smp-v01-04.json",
].map(loadSample);

describe("V01 calibration on the frozen samples (ADR 0013)", () => {
  const report = runCalibration(ALL);

  it("covers all 8 expected question runs", () => {
    expect(report.totalQuestions).toBe(8);
  });

  it("conclusion agreement meets the >=90% bar", () => {
    expect(report.conclusionMatches).toBe(8);
    expect(report.agreementRate).toBe(1);
  });

  it("every programmatic check passes (100% bar)", () => {
    expect(report.programmaticChecks.total).toBeGreaterThan(0);
    expect(report.programmaticChecks.passed).toBe(report.programmaticChecks.total);
  });

  it("per-question detail is inspectable", () => {
    for (const q of report.questions) {
      expect(q.conclusionMatch, `${q.sampleId}/${q.key}`).toBe(true);
      for (const c of q.checks) {
        expect(c.passed, `${q.sampleId}/${q.key}/${c.name}`).toBe(true);
      }
    }
  });
});

describe("V01 behaviour spot checks", () => {
  function makeQa() {
    const clock = new FakeClock(1_700_000_000_000);
    const ids = new IdGen();
    const store = new KnowledgeStore(clock, ids);
    const registry = new Registry(clock, ids);
    const qa = new KnowledgeQaService({
      store,
      assessor: new ScriptedAssessor(),
      registry,
      ids,
    });
    return { store, qa };
  }

  it("version binding: the 7.0 question is answered from the 7.0 source only", () => {
    const { store, qa } = makeQa();
    const sample = loadSample("smp-v01-01.json");
    for (const src of sample.sources ?? []) {
      store.addRevision({ tenantId: "tnt_main", scopeId: "scp_demo_a", ...src });
    }
    store.createSnapshot({
      tenantId: "tnt_main",
      scopeId: "scp_demo_a",
      sourceRevisionIds: sample.snapshot?.sourceRevisionIds ?? [],
      snapshotId: "snap_demo_001",
    });
    const result = qa.answer({
      tenantId: "tnt_main",
      scopeId: "scp_demo_a",
      snapshotId: "snap_demo_001",
      question: { id: "q2", text: "LBX-200 在 7.0 版的最大并发连接数是多少？", productVersion: "7.0" },
      askedAt: "2026-10-10T00:00:00.000Z",
    });
    expect(result.outcome).toBe("answered");
    expect(result.value).toBe("200000");
    expect(result.citations).toEqual(["src_manual_v2"]);
    expect(result.excluded).toContainEqual({
      sourceRevisionId: "src_manual_v3",
      reason: "different-version",
    });
  });

  it("conflict: both values presented, withdrawn source excluded, no single answer", () => {
    const { store, qa } = makeQa();
    const sample = loadSample("smp-v01-02.json");
    for (const src of sample.sources ?? []) {
      store.addRevision({ tenantId: "tnt_main", scopeId: "scp_demo_a", ...src });
    }
    store.createSnapshot({
      tenantId: "tnt_main",
      scopeId: "scp_demo_a",
      sourceRevisionIds: sample.snapshot?.sourceRevisionIds ?? [],
      snapshotId: "snap_demo_002",
    });
    const result = qa.answer({
      tenantId: "tnt_main",
      scopeId: "scp_demo_a",
      snapshotId: "snap_demo_002",
      question: { id: "q1", text: "LBX-200 的会话超时默认是多少？" },
      askedAt: "2026-10-10T00:00:00.000Z",
    });
    expect(result.outcome).toBe("conflict");
    expect(result.value).toBeUndefined();
    expect(result.conflicts?.map((c) => c.value).sort()).toEqual(["30", "90"]);
    expect(result.citations).not.toContain("src_notice_2024");
    expect(result.assessment?.conclusion).toBe("abstained");
  });

  it("answering against another scope's snapshot is refused", () => {
    const { qa } = makeQa();
    const result = qa.answer({
      tenantId: "tnt_main",
      scopeId: "scp_other",
      snapshotId: "snap_demo_001",
      question: { id: "q1", text: "LBX-200 在 7.1 版的最大并发连接数是多少？" },
      askedAt: "2026-10-10T00:00:00.000Z",
    });
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("TARGET_NOT_FOUND");
  });
});

describe("V01 vertical slice on the platform task gate", () => {
  it("an answered question delivers through the completion checklist", () => {
    const clock = new FakeClock(1_700_000_000_000);
    const ids = new IdGen();
    const store = new KnowledgeStore(clock, ids);
    const registry = new Registry(clock, ids);
    const tasks = new TaskService(clock, ids);
    const qa = new KnowledgeQaService({
      store,
      assessor: new ScriptedAssessor(),
      registry,
      ids,
    });
    const sample = loadSample("smp-v01-01.json");
    for (const src of sample.sources ?? []) {
      store.addRevision({ tenantId: "tnt_main", scopeId: "scp_demo_a", ...src });
    }
    store.createSnapshot({
      tenantId: "tnt_main",
      scopeId: "scp_demo_a",
      sourceRevisionIds: sample.snapshot?.sourceRevisionIds ?? [],
      snapshotId: "snap_demo_001",
    });

    const task = tasks.createTask({
      tenantId: "tnt_main",
      scopeId: "scp_demo_a",
      principalId: "prn_alice",
      title: "回答 q1",
    });
    tasks.transition(task.taskId, "admitted");
    tasks.transition(task.taskId, "running");
    const result = qa.answer({
      tenantId: "tnt_main",
      scopeId: "scp_demo_a",
      snapshotId: "snap_demo_001",
      question: { id: "q1", text: "LBX-200 在 7.1 版的最大并发连接数是多少？", productVersion: "7.1" },
      askedAt: "2026-10-10T00:00:00.000Z",
    });
    expect(result.outcome).toBe("answered");
    const recordId = result.assessment?.recordId ?? "rec_000001";
    expect(
      tasks.attachChecklist(task.taskId, {
        taskId: task.taskId,
        inputRevisionId: task.inputRevisionId,
        items: [
          { itemId: "v01-bindings", kind: "verification", refId: "snap_demo_001", required: true, satisfied: true },
          { itemId: "v01-cite-resolve", kind: "verification", refId: "snap_demo_001", required: true, satisfied: true },
          { itemId: "v01-assessment", kind: "assessment", refId: recordId, required: true, satisfied: result.assessment?.conclusion === "supports" },
        ],
      }).ok,
    ).toBe(true);
    tasks.transition(task.taskId, "under-review");
    expect(tasks.deliver(task.taskId).ok).toBe(true);
  });
});
