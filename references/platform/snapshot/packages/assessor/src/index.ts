import {
  AssessmentRecordSchema,
  type AssessmentRecord,
} from "@infosec/contracts";

/**
 * The replaceable semantic-judgement interface (ADR 0013). Every
 * implementation must produce a full AssessmentRecord: method identity,
 * the exact model identity when a model is used, evidence references,
 * and a conclusion. Abstention is a first-class outcome.
 */
export interface AssessEvidence {
  evidenceId: string;
  quote: string;
  /** Deterministically extracted value, when the evidence carries one. */
  value?: string;
}

export interface AssessInput {
  recordId: string;
  inputBindingSha256: string;
  questionText: string;
  claim: string;
  /** The claim's extracted value, when the claim carries one. */
  claimValue?: string;
  evidence: AssessEvidence[];
  createdAt: string;
}

export interface Assessor {
  readonly methodId: string;
  readonly methodVersion: string;
  assess(input: AssessInput): AssessmentRecord;
}

/**
 * Deterministic scripted assessor (ADR 0013 default for P2). Rules:
 * no evidence -> insufficient-evidence; evidence values disagreeing with
 * each other -> abstained; all evidence values equal to the claim value
 * -> supports; evidence carrying a different value -> refutes. It sets
 * no confidence and no modelId: it is a method, not a model.
 */
export class ScriptedAssessor implements Assessor {
  readonly methodId = "scripted-assessor";
  readonly methodVersion = "1.0.0";

  assess(input: AssessInput): AssessmentRecord {
    const base = {
      kind: "assessment" as const,
      recordId: input.recordId,
      methodId: this.methodId,
      methodVersion: this.methodVersion,
      inputBindingSha256: input.inputBindingSha256,
      createdAt: input.createdAt,
    };
    if (input.evidence.length === 0) {
      return AssessmentRecordSchema.parse({
        ...base,
        evidenceRefs: [],
        conclusion: "insufficient-evidence",
        unknowns: ["no citable evidence in the bound snapshot"],
        rationaleSummary:
          "No evidence was supplied, so no support judgement is possible.",
      });
    }
    const values = input.evidence
      .map((e) => e.value)
      .filter((v): v is string => v !== undefined);
    const distinct = [...new Set(values)];
    if (distinct.length > 1) {
      return AssessmentRecordSchema.parse({
        ...base,
        evidenceRefs: input.evidence.map((e) => e.evidenceId),
        conclusion: "abstained",
        unknowns: ["cited evidence disagrees on the value"],
        rationaleSummary:
          "Cited evidence carries conflicting values; the scripted assessor abstains and the conflict is surfaced by the caller.",
      });
    }
    if (input.claimValue !== undefined && distinct.length === 1) {
      const supports = distinct[0] === input.claimValue;
      return AssessmentRecordSchema.parse({
        ...base,
        evidenceRefs: input.evidence.map((e) => e.evidenceId),
        conclusion: supports ? "supports" : "refutes",
        unknowns: [],
        rationaleSummary: supports
          ? "Every cited evidence value equals the claim value."
          : "Cited evidence carries a different value than the claim.",
      });
    }
    return AssessmentRecordSchema.parse({
      ...base,
      evidenceRefs: input.evidence.map((e) => e.evidenceId),
      conclusion: "supports",
      unknowns: [],
      rationaleSummary:
        "Evidence is cited and carries no contradicting extracted value.",
    });
  }
}
