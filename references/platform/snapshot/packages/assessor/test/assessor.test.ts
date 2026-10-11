import { describe, expect, it } from "vitest";
import { ScriptedAssessor } from "../src/index.js";

const base = {
  recordId: "rec_000001",
  inputBindingSha256: "a".repeat(64),
  questionText: "q?",
  claim: "metric = 90",
  createdAt: "2026-10-10T00:00:00.000Z",
};

describe("ScriptedAssessor", () => {
  const assessor = new ScriptedAssessor();

  it("abstains to insufficient-evidence with no evidence", () => {
    const rec = assessor.assess({ ...base, evidence: [] });
    expect(rec.conclusion).toBe("insufficient-evidence");
    expect(rec.methodId).toBe("scripted-assessor");
    expect(rec.modelId).toBeUndefined();
    expect(rec.confidence).toBeUndefined();
  });

  it("supports when every evidence value equals the claim value", () => {
    const rec = assessor.assess({
      ...base,
      claimValue: "90",
      evidence: [{ evidenceId: "evd_000001", quote: "默认 90 秒", value: "90" }],
    });
    expect(rec.conclusion).toBe("supports");
    expect(rec.evidenceRefs).toEqual(["evd_000001"]);
  });

  it("refutes when evidence carries a different value", () => {
    const rec = assessor.assess({
      ...base,
      claimValue: "90",
      evidence: [{ evidenceId: "evd_000001", quote: "默认 30 秒", value: "30" }],
    });
    expect(rec.conclusion).toBe("refutes");
  });

  it("abstains when evidence disagrees with itself", () => {
    const rec = assessor.assess({
      ...base,
      claimValue: "90",
      evidence: [
        { evidenceId: "evd_000001", quote: "默认 90 秒", value: "90" },
        { evidenceId: "evd_000002", quote: "默认 30 秒", value: "30" },
      ],
    });
    expect(rec.conclusion).toBe("abstained");
  });
});
