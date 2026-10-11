import { createHash } from "node:crypto";
import type { AssessInput, Assessor } from "@infosec/assessor";
import {
  AssessmentRecordSchema,
  type AssessmentConclusion,
  type AssessmentRecord,
} from "@infosec/contracts";
import {
  BudgetExceeded,
  CallFailed,
  callMessages,
  parseModelJson,
  type BudgetTracker,
} from "./budget.js";
import {
  MAX_TOKENS,
  MODEL_ID,
  TEMPERATURE,
  V01_ASSESS_SYSTEM,
  buildAssessUser,
} from "./prompts.js";

const CONCLUSIONS: AssessmentConclusion[] = [
  "supports",
  "refutes",
  "not-addressed",
  "insufficient-evidence",
  "abstained",
];

/**
 * The real-model assessor (ADR 0013 interface, ADR 0026 channel).
 * Every judgement is one model call through the vault-backed
 * bridge; the record carries the exact modelId. Judgement failures
 * are first-class: an unparseable reply or a call that fails after
 * the frozen retries becomes an `abstained` record stating why —
 * never a silent default and never a retried-until-agreeable answer.
 * A BudgetExceeded from the frozen caps propagates: the round stops
 * and reports partial (plan §4).
 */
export class LlmAssessor implements Assessor {
  readonly methodId = "llm-assessor";
  readonly methodVersion = "1.0.0";
  readonly modelId = MODEL_ID;

  constructor(private readonly budget: BudgetTracker) {}

  assess(input: AssessInput): AssessmentRecord {
    const base = {
      kind: "assessment" as const,
      recordId: input.recordId,
      methodId: this.methodId,
      methodVersion: this.methodVersion,
      modelId: this.modelId,
      inputBindingSha256: input.inputBindingSha256,
      evidenceRefs: input.evidence.map((e) => e.evidenceId),
      createdAt: input.createdAt,
    };
    const abstain = (reason: string, extra: string[] = []) =>
      AssessmentRecordSchema.parse({
        ...base,
        conclusion: "abstained",
        unknowns: [reason, ...extra],
        rationaleSummary: `The model assessor abstained: ${reason}.`,
      });

    let text: string;
    try {
      const result = callMessages(this.budget, `v01-assess:${input.recordId}`, {
        model: MODEL_ID,
        max_tokens: MAX_TOKENS,
        temperature: TEMPERATURE,
        system: V01_ASSESS_SYSTEM,
        messages: [{ role: "user", content: buildAssessUser(input) }],
      });
      text = result.text;
    } catch (error) {
      if (error instanceof BudgetExceeded) throw error;
      if (error instanceof CallFailed) {
        return abstain("model call failed after the frozen retries", [
          `${error.attempts.length} attempt(s) logged in the run budget`,
        ]);
      }
      throw error;
    }

    const parsed = parseModelJson(text);
    const outputHash = createHash("sha256")
      .update(text)
      .digest("hex")
      .slice(0, 16);
    if (!parsed || typeof parsed.conclusion !== "string") {
      return abstain("model output did not parse as the required JSON", [
        `output sha256 prefix ${outputHash}`,
      ]);
    }
    if (!CONCLUSIONS.includes(parsed.conclusion as AssessmentConclusion)) {
      return abstain(
        `model returned an out-of-vocabulary conclusion: ${String(parsed.conclusion)}`,
        [`output sha256 prefix ${outputHash}`],
      );
    }
    const unknowns = Array.isArray(parsed.unknowns)
      ? parsed.unknowns.filter((u): u is string => typeof u === "string")
      : [];
    return AssessmentRecordSchema.parse({
      ...base,
      conclusion: parsed.conclusion,
      unknowns,
      rationaleSummary:
        typeof parsed.rationale === "string" && parsed.rationale.length > 0
          ? parsed.rationale.slice(0, 500)
          : "The model gave no rationale.",
    });
  }
}
