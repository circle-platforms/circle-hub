import {
  AssessmentRecordSchema,
  type AssessmentRecord,
} from "@infosec/contracts";
import { createHash } from "node:crypto";
import type { UseCase } from "./parse.js";
import {
  REVIEW_METHOD_ID,
  REVIEW_METHOD_VERSION,
  reviewCaseDimensions,
  type Severity,
} from "./rules.js";

export interface Finding {
  findingId: string;
  caseId: string;
  dimension: string;
  type: string;
  severity: Severity;
  location: string;
  rationale: string;
}

export interface CaseReview {
  caseId: string;
  findingIds: string[];
  assessment: AssessmentRecord;
}

export interface ReviewReport {
  inputSha256: string;
  findings: Finding[];
  perCase: CaseReview[];
  verification: { checkId: string; result: "pass" | "fail"; note: string }[];
}

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

export function hashCases(cases: UseCase[]): string {
  return createHash("sha256")
    .update(JSON.stringify(cases.map((c) => ({ id: c.id, text: c.text }))))
    .digest("hex");
}

/**
 * The V04 review. Findings come from the declared dimension rules and
 * are summarized per case in an AssessmentRecord (the case's implicit
 * claim "this use case is sound" is supported or refuted). The report
 * never delivers itself: delivery requires the human sign-off item of
 * the completion checklist (v04-signoff) on the platform task.
 */
export class ReviewService {
  #registry: RegistryLike;
  #ids: IdGenLike;

  constructor(deps: { registry: RegistryLike; ids: IdGenLike }) {
    this.#registry = deps.registry;
    this.#ids = deps.ids;
  }

  review(input: {
    tenantId: string;
    scopeId: string;
    cases: UseCase[];
    reviewedAt: string;
  }): ReviewReport {
    const inputSha256 = hashCases(input.cases);
    const findings: Finding[] = [];
    const perCase: CaseReview[] = [];

    for (const kase of input.cases) {
      const evidenceId = this.#registry.register({
        tenantId: input.tenantId,
        scopeId: input.scopeId,
        kind: "evidence",
        sha256: createHash("sha256").update(kase.text).digest("hex"),
        label: `用例 ${kase.id} 原文`,
        bindings: { caseId: kase.id, inputSha256 },
      }).id;

      const drafts = reviewCaseDimensions(kase);
      const caseFindings: Finding[] = drafts.map((d) => ({
        findingId: this.#ids.next("fnd"),
        caseId: kase.id,
        ...d,
      }));
      findings.push(...caseFindings);

      const assessment = AssessmentRecordSchema.parse({
        kind: "assessment",
        recordId: this.#ids.next("rec"),
        methodId: REVIEW_METHOD_ID,
        methodVersion: REVIEW_METHOD_VERSION,
        inputBindingSha256: inputSha256,
        evidenceRefs: [evidenceId],
        conclusion: caseFindings.length === 0 ? "supports" : "refutes",
        unknowns: [],
        rationaleSummary:
          caseFindings.length === 0
            ? `用例 ${kase.id} 在已声明的评审维度下未发现缺陷。`
            : `用例 ${kase.id} 发现 ${caseFindings.length} 项：${caseFindings.map((f) => f.type).join("、")}。`,
        createdAt: input.reviewedAt,
      });
      perCase.push({
        caseId: kase.id,
        findingIds: caseFindings.map((f) => f.findingId),
        assessment,
      });
    }

    return {
      inputSha256,
      findings,
      perCase,
      verification: [
        {
          checkId: "v04-input-hash",
          result: "pass",
          note: `input bound by sha256 ${inputSha256.slice(0, 12)}… over ${input.cases.length} case(s)`,
        },
        {
          checkId: "v04-case-ids",
          result: input.cases.every((c) => c.id.length > 0) ? "pass" : "fail",
          note: "every case carries an identifier findings can point at",
        },
      ],
    };
  }
}
