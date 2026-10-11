import { describe, expect, it } from "vitest";
import {
  AssessmentRecordSchema,
  BindingSetSchema,
  CLI_EXIT_CODES,
  CompletionChecklistSchema,
  EffectDescriptorSchema,
  PendingInputSchema,
  RequestEnvelopeSchema,
  ResponseEnvelopeSchema,
  ResponseStatusSchema,
  StructuredErrorSchema,
  TaskIdSchema,
  VerificationRecordSchema,
  canOperationTransition,
  canTaskTransition,
  contractJsonSchemas,
  deriveAdmissionTier,
  errorCodeInfo,
  evaluateCompletion,
  evaluatePendingResponse,
  isReadOnlyConsistent,
  responseStatusForExitCode,
  validateAssessment,
  validateBindingClosure,
} from "../src/index.js";

const SHA = "a".repeat(64);

describe("FZ-01 response status and CLI exit codes", () => {
  it("has exactly the nine frozen statuses (v1.1 added cancelled, ADR 0009)", () => {
    expect(ResponseStatusSchema.options).toHaveLength(9);
    expect(ResponseStatusSchema.options).toContain("cancelled");
  });
  it("maps every status to a distinct exit code, 0 only for succeeded", () => {
    const codes = Object.values(CLI_EXIT_CODES);
    expect(new Set(codes).size).toBe(9);
    expect(CLI_EXIT_CODES.succeeded).toBe(0);
    expect(CLI_EXIT_CODES.cancelled).toBe(5);
    expect(CLI_EXIT_CODES.accepted).not.toBe(0);
    expect(CLI_EXIT_CODES.running).not.toBe(0);
  });
  it("round-trips exit codes and rejects unknown ones", () => {
    expect(responseStatusForExitCode(3)).toBe("unknown");
    expect(responseStatusForExitCode(99)).toBeUndefined();
  });
});

describe("FZ-02 state machines", () => {
  it("allows the normal task path and the rework path", () => {
    expect(canTaskTransition("draft", "admitted")).toBe(true);
    expect(canTaskTransition("running", "waiting-input")).toBe(true);
    expect(canTaskTransition("under-review", "running")).toBe(true);
    expect(canTaskTransition("under-review", "delivered")).toBe(true);
  });
  it("forbids skipping the completion gate and leaving terminal states", () => {
    expect(canTaskTransition("running", "delivered")).toBe(false);
    expect(canTaskTransition("delivered", "running")).toBe(false);
    expect(canTaskTransition("draft", "delivered")).toBe(false);
  });
  it("keeps the four cancel facts distinct for operations", () => {
    expect(canOperationTransition("running", "cancel-requested")).toBe(true);
    expect(canOperationTransition("cancel-requested", "cancel-delivered")).toBe(true);
    expect(canOperationTransition("cancel-delivered", "stopped-observed")).toBe(true);
    // Requested is not stopped:
    expect(canOperationTransition("cancel-requested", "stopped-observed")).toBe(false);
    expect(canOperationTransition("succeeded", "running")).toBe(false);
  });
  it("lets unknown be left only towards reconcile outcomes", () => {
    expect(canOperationTransition("unknown", "running")).toBe(true);
    expect(canOperationTransition("unknown", "cancel-requested")).toBe(false);
  });
});

describe("FZ-03 structured errors", () => {
  it("registry covers all eight categories", () => {
    const cats = new Set(
      ResponseStatusSchema.options.length >= 0
        ? [
            errorCodeInfo("INVALID_PAYLOAD").category,
            errorCodeInfo("FORBIDDEN_SCOPE").category,
            errorCodeInfo("INPUT_REVISION_STALE").category,
            errorCodeInfo("LEASE_EXPIRED").category,
            errorCodeInfo("TARGET_NOT_FOUND").category,
            errorCodeInfo("UPSTREAM_TIMEOUT").category,
            errorCodeInfo("NO_ANSWER").category,
            errorCodeInfo("INTERNAL_ERROR").category,
          ]
        : [],
    );
    expect(cats.size).toBe(8);
  });
  it("idempotency mismatch is a caller-resolved conflict (contract v1.2)", () => {
    const info = errorCodeInfo("IDEMPOTENCY_MISMATCH");
    expect(info.category).toBe("conflict-stale");
    expect(info.retryable).toBe(false);
    expect(info.requiresUserAction).toBe(true);
  });
  it("accepts a well-formed error", () => {
    const ok = StructuredErrorSchema.safeParse({
      code: "TARGET_UNREACHABLE",
      category: "target",
      message: "device did not answer",
      retryable: true,
    });
    expect(ok.success).toBe(true);
  });
  it("rejects a category that does not match the registry", () => {
    const bad = StructuredErrorSchema.safeParse({
      code: "TARGET_UNREACHABLE",
      category: "validation",
      message: "wrong category",
      retryable: true,
    });
    expect(bad.success).toBe(false);
  });
  it("rejects loosening a non-retryable code and RECEIPT_LOST is never directly retryable", () => {
    expect(errorCodeInfo("RECEIPT_LOST").retryable).toBe(false);
    const bad = StructuredErrorSchema.safeParse({
      code: "RECEIPT_LOST",
      category: "transient",
      message: "receipt lost",
      retryable: true,
    });
    expect(bad.success).toBe(false);
  });
  it("requires userAction where the registry demands it", () => {
    const bad = StructuredErrorSchema.safeParse({
      code: "TARGET_IDENTITY_MISMATCH",
      category: "target",
      message: "serial mismatch",
      retryable: false,
    });
    expect(bad.success).toBe(false);
  });
});

describe("FZ-04 envelopes", () => {
  it("parses a valid request envelope and rejects a self-minted principal shape", () => {
    const ok = RequestEnvelopeSchema.safeParse({
      schemaVersion: "1.0.0",
      requestId: "req_1",
      idempotencyKey: "idem-0001",
      principalId: "prn_alice",
      tenantId: "tnt_main",
      scopeId: "scp_apv",
      payload: { q: "show version" },
    });
    expect(ok.success).toBe(true);
    const bad = RequestEnvelopeSchema.safeParse({
      schemaVersion: "1.0.0",
      requestId: "req_1",
      principalId: "alice",
      tenantId: "tnt_main",
      scopeId: "scp_apv",
      payload: {},
    });
    expect(bad.success).toBe(false);
  });
  it("response envelope keeps verification and assessments as separate arrays", () => {
    const parsed = ResponseEnvelopeSchema.parse({
      schemaVersion: "1.0.0",
      requestId: "req_1",
      status: "succeeded",
    });
    expect(parsed.verification).toEqual([]);
    expect(parsed.assessments).toEqual([]);
  });
});

describe("FZ-05 binding closure", () => {
  const base = BindingSetSchema.parse({});
  it("knowledge work without a fixed snapshot is not closed", () => {
    const issues = validateBindingClosure(base, {
      citesKnowledge: true,
      hasSideEffects: false,
      requiresPack: false,
      involvesProduct: false,
    });
    expect(issues.length).toBeGreaterThan(0);
  });
  it("a fully bound set is closed", () => {
    const full = BindingSetSchema.parse({
      snapshotId: "snap_20261010",
      sourceRevisionIds: ["src_manual_v3"],
      capabilityPack: { packId: "pack_apv_ops", packVersion: "1.2.0" },
      target: { resourceId: "res_apv_01", environmentRevision: "fw-7.1" },
      product: { productId: "APV", version: "7.1", form: "physical" },
    });
    const issues = validateBindingClosure(full, {
      citesKnowledge: true,
      hasSideEffects: true,
      requiresPack: true,
      involvesProduct: true,
    });
    expect(issues).toEqual([]);
  });
});

describe("FZ-06 effects", () => {
  it("derives admission tiers, irreversible always separate", () => {
    const ro = EffectDescriptorSchema.parse({ reads: ["device-state"] });
    expect(deriveAdmissionTier(ro)).toBe("readonly-collect");
    expect(isReadOnlyConsistent(ro)).toBe(true);
    const change = EffectDescriptorSchema.parse({
      reads: ["device-state"],
      writes: ["device-config"],
      reversibility: "manual-rollback",
    });
    expect(deriveAdmissionTier(change)).toBe("standard-change");
    const irr = EffectDescriptorSchema.parse({
      writes: ["device-config"],
      reversibility: "irreversible",
    });
    expect(deriveAdmissionTier(irr)).toBe("irreversible-separate");
  });
  it("a write hidden behind a read-only claim is inconsistent", () => {
    const sneaky = EffectDescriptorSchema.parse({
      reads: ["device-state"],
      writes: ["local-workspace"],
    });
    expect(isReadOnlyConsistent(sneaky)).toBe(false);
  });
});

describe("FZ-07 identity spaces", () => {
  it("accepts well-formed ids and rejects cross-space reuse", () => {
    expect(TaskIdSchema.safeParse("task_abc").success).toBe(true);
    expect(TaskIdSchema.safeParse("conv_abc").success).toBe(false);
    expect(TaskIdSchema.safeParse("abc").success).toBe(false);
  });
});

describe("FZ-08 dual records and completion gate", () => {
  it("verification and assessment are distinct kinds", () => {
    const v = VerificationRecordSchema.parse({
      kind: "verification",
      recordId: "rec_1",
      checkId: "sha-match",
      programVersion: "1.0.0",
      inputBindingSha256: SHA,
      scopeNote: "hash of the bound input artifact only",
      expected: SHA,
      actual: SHA,
      result: "pass",
      checkedAt: "2026-10-10T00:00:00.000Z",
    });
    expect(v.kind).toBe("verification");
    const a = AssessmentRecordSchema.parse({
      kind: "assessment",
      recordId: "rec_2",
      methodId: "support-judgement",
      methodVersion: "0.3.0",
      inputBindingSha256: SHA,
      evidenceRefs: ["evd_1"],
      conclusion: "supports",
      rationaleSummary: "the cited passage states the limit directly",
      createdAt: "2026-10-10T00:00:00.000Z",
    });
    expect(a.kind).toBe("assessment");
  });
  it("flags a supports conclusion with no evidence", () => {
    const a = AssessmentRecordSchema.parse({
      kind: "assessment",
      recordId: "rec_3",
      methodId: "support-judgement",
      methodVersion: "0.3.0",
      inputBindingSha256: SHA,
      evidenceRefs: [],
      conclusion: "supports",
      rationaleSummary: "no citation given",
      createdAt: "2026-10-10T00:00:00.000Z",
    });
    expect(validateAssessment(a).length).toBeGreaterThan(0);
  });
  it("execution success alone cannot deliver: required items must all be satisfied", () => {
    const checklist = CompletionChecklistSchema.parse({
      taskId: "task_1",
      inputRevisionId: "inrev_1",
      items: [
        { itemId: "op-done", kind: "verification", refId: "rec_1", required: true, satisfied: true },
        { itemId: "human-ok", kind: "human-decision", refId: "pin_1", required: true, satisfied: false },
      ],
    });
    const result = evaluateCompletion(checklist);
    expect(result.canDeliver).toBe(false);
    expect(result.missing).toEqual(["human-ok"]);
  });
});

describe("FZ-09 pending inputs", () => {
  const pending = PendingInputSchema.parse({
    requestId: "pin_1",
    taskId: "task_1",
    inputRevisionId: "inrev_1",
    decisionType: "approval",
    question: "Apply the change?",
    requestedAt: "2026-10-10T00:00:00.000Z",
    expiresAt: "2026-10-11T00:00:00.000Z",
  });
  const respond = (over: Record<string, unknown>) => ({
    requestId: "pin_1",
    inputRevisionId: "inrev_1",
    actorId: "act_bob",
    decision: "approve",
    respondedAt: "2026-10-10T12:00:00.000Z",
    idempotencyKey: "idem-resp-1",
    ...over,
  });
  it("accepts an in-time response to the bound revision", () => {
    expect(evaluatePendingResponse(pending, respond({}))).toBe("accepted");
  });
  it("rejects a response to a superseded revision", () => {
    expect(
      evaluatePendingResponse(pending, respond({ inputRevisionId: "inrev_2" })),
    ).toBe("stale-revision");
  });
  it("rejects an expired response", () => {
    expect(
      evaluatePendingResponse(
        pending,
        respond({ respondedAt: "2026-10-12T00:00:00.000Z" }),
      ),
    ).toBe("expired");
  });
});

describe("generated JSON schemas", () => {
  it("exports a JSON schema for every frozen envelope/record type", () => {
    const schemas = contractJsonSchemas();
    for (const name of [
      "BindingSet",
      "EffectDescriptor",
      "StructuredError",
      "VerificationRecord",
      "AssessmentRecord",
      "PendingInput",
      "RequestEnvelope",
      "ResponseEnvelope",
    ]) {
      expect(schemas[name]).toBeDefined();
      expect(JSON.stringify(schemas[name])).toContain("properties");
    }
  });
});
