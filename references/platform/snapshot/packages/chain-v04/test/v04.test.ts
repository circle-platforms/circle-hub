import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FakeClock, IdGen, Registry, TaskService, iso } from "@infosec/platform";
import {
  parseUseCaseMarkdown,
  runV04Calibration,
  ReviewService,
  type DefectSample,
  type UseCase,
} from "../src/index.js";

const SAMPLES_DIR =
  process.env.V04_SAMPLES_DIR ??
  fileURLToPath(new URL("../../../samples/v04/", import.meta.url));

const baselineMd = readFileSync(`${SAMPLES_DIR}smp-v04-01-usecases.md`, "utf8");
const baselineCases = parseUseCaseMarkdown(baselineMd);
const defectSample = JSON.parse(
  readFileSync(`${SAMPLES_DIR}smp-v04-02.json`, "utf8"),
) as DefectSample;

/**
 * UC-04R text is not shipped with the frozen sample; it is constructed
 * here strictly from the sample's revisionSet description (ownership
 * check added; session lifetime 30 minutes in the precondition and 3
 * minutes in the postcondition). Test fixture, not sample content.
 */
const revisionCase: UseCase = {
  id: "UC-04R",
  text: "UC-04R 查看订单详情（修订版）：前置：用户已登录，会话有效期 30 分钟。主流程：1. 用户输入订单号；2. 系统校验订单归属与当前登录用户一致后，按订单号返回订单详情；3. 用户查看详情。后置：会话有效期 3 分钟，超时需重新登录。",
};

describe("V04 calibration on the frozen samples (ADR 0013)", () => {
  const report = runV04Calibration({ baselineCases, defectSample, revisionCase });

  it("parses the three baseline cases", () => {
    expect(baselineCases.map((c) => c.id)).toEqual(["UC-01", "UC-02", "UC-03"]);
  });

  it("baseline: zero high-severity false positives", () => {
    expect(report.baseline.caseCount).toBe(3);
    expect(report.baseline.highSeverityFindings).toBe(0);
  });

  it("all expected findings D-01..D-04 are detected with matching type and severity", () => {
    expect(report.expected.map((e) => [e.defectId, e.matched])).toEqual([
      ["D-01", true],
      ["D-02", true],
      ["D-03", true],
      ["D-04", true],
    ]);
    expect(report.agreementRate).toBe(1);
  });

  it("no extra findings on the defect set beyond the expected ones", () => {
    expect(report.extraFindings).toEqual([]);
  });

  it("revision: D-04 found and the fixed D-01 no longer reported", () => {
    expect(report.revision.matched).toBe(true);
    expect(report.revision.fixedDefectAbsent).toBe(true);
  });
});

describe("V04 sign-off flow on the platform task gate", () => {
  it("delivery is blocked until the reviewer signs off via a structured decision", () => {
    const clock = new FakeClock(1_700_000_000_000);
    const ids = new IdGen();
    const registry = new Registry(clock, ids);
    const tasks = new TaskService(clock, ids);
    const service = new ReviewService({ registry, ids });

    const task = tasks.createTask({
      tenantId: "tnt_main",
      scopeId: "scp_demo_a",
      principalId: "prn_alice",
      title: "评审 SMP-V04-02",
    });
    tasks.transition(task.taskId, "admitted");
    tasks.transition(task.taskId, "running");

    const cases: UseCase[] = defectSample.cases.map((c) => ({ id: c.id, text: c.text }));
    const report = service.review({
      tenantId: "tnt_main",
      scopeId: "scp_demo_a",
      cases,
      reviewedAt: iso(clock.now()),
    });
    expect(report.findings).toHaveLength(3);

    const artifact = registry.register({
      tenantId: "tnt_main",
      scopeId: "scp_demo_a",
      kind: "artifact",
      sha256: report.inputSha256,
      label: "评审报告",
      bindings: { taskId: task.taskId },
    });

    expect(
      tasks.attachChecklist(task.taskId, {
        taskId: task.taskId,
        inputRevisionId: task.inputRevisionId,
        items: [
          { itemId: "v04-input-hash", kind: "verification", refId: artifact.id, required: true, satisfied: true },
          { itemId: "v04-dimensions", kind: "assessment", refId: report.perCase[0]?.assessment.recordId ?? "rec_000001", required: true, satisfied: true },
          { itemId: "v04-signoff", kind: "human-decision", refId: artifact.id, required: true, satisfied: false },
        ],
      }).ok,
    ).toBe(true);
    tasks.transition(task.taskId, "under-review");
    expect(tasks.deliver(task.taskId).ok).toBe(false); // sign-off missing

    // Structured human decision through the pending-input channel.
    tasks.transition(task.taskId, "running");
    const pending = tasks.requestInput(task.taskId, {
      decisionType: "approval",
      question: "评审结论是否签字确认？",
    });
    if (!pending.ok) throw new Error("requestInput failed");
    const responded = tasks.respond(task.taskId, {
      requestId: pending.value.requestId,
      inputRevisionId: task.inputRevisionId,
      actorId: "act_000001",
      decision: "sign-off",
      respondedAt: iso(clock.now()),
      idempotencyKey: "signoff-01",
    });
    expect(responded.ok && responded.value.outcome).toBe("accepted");
    expect(tasks.satisfyItem(task.taskId, "v04-signoff").ok).toBe(true);
    tasks.transition(task.taskId, "under-review");
    const delivered = tasks.deliver(task.taskId);
    expect(delivered.ok && delivered.value.phase).toBe("delivered");
  });

  it("changing the input after review changes the binding hash", () => {
    const clock = new FakeClock(1_700_000_000_000);
    const ids = new IdGen();
    const registry = new Registry(clock, ids);
    const service = new ReviewService({ registry, ids });
    const a = service.review({
      tenantId: "tnt_main",
      scopeId: "scp_demo_a",
      cases: [{ id: "UC-X", text: "原文" }],
      reviewedAt: iso(clock.now()),
    });
    const b = service.review({
      tenantId: "tnt_main",
      scopeId: "scp_demo_a",
      cases: [{ id: "UC-X", text: "改后原文" }],
      reviewedAt: iso(clock.now()),
    });
    expect(a.inputSha256).not.toBe(b.inputSha256);
  });
});
