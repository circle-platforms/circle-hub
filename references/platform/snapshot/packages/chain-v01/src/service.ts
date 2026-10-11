import type { AssessmentRecord, StructuredError } from "@infosec/contracts";
import type { Assessor } from "@infosec/assessor";
import type { KnowledgeStore, SourceRevision } from "@infosec/knowledge";
import { createHash } from "node:crypto";
import {
  detectMetric,
  detectQuestionProduct,
  extractFacts,
  sourceProduct,
} from "./metrics.js";

export interface QuestionInput {
  id: string;
  text: string;
  productVersion?: string;
}

export type AnswerOutcome = "answered" | "no-answer" | "conflict";

export interface ExcludedSource {
  sourceRevisionId: string;
  reason: "withdrawn" | "different-product" | "different-version";
}

export interface VerificationCheck {
  checkId: string;
  result: "pass" | "fail";
  note: string;
}

export interface AnswerResult {
  status: "succeeded" | "failed";
  outcome?: AnswerOutcome;
  /** The single extracted value, when answered. */
  value?: string;
  answerText?: string;
  citations: string[];
  excluded: ExcludedSource[];
  conflicts?: { value: string; sourceRevisionIds: string[] }[];
  verification: VerificationCheck[];
  assessment?: AssessmentRecord;
  error?: StructuredError;
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

function bindingHash(parts: string[]): string {
  return createHash("sha256").update(parts.join("|")).digest("hex");
}

/**
 * The V01 answer pipeline. Program verification (which sources may be
 * cited at all: snapshot membership, live withdrawal status, product
 * and version binding, scope partition) is decided before and kept
 * separate from the assessor's support judgement (VER dual-track).
 */
export class KnowledgeQaService {
  #store: KnowledgeStore;
  #assessor: Assessor;
  #registry: RegistryLike;
  #ids: IdGenLike;

  constructor(deps: {
    store: KnowledgeStore;
    assessor: Assessor;
    registry: RegistryLike;
    ids: IdGenLike;
  }) {
    this.#store = deps.store;
    this.#assessor = deps.assessor;
    this.#registry = deps.registry;
    this.#ids = deps.ids;
  }

  answer(input: {
    tenantId: string;
    scopeId: string;
    snapshotId: string;
    question: QuestionInput;
    askedAt: string;
  }): AnswerResult {
    const snapshotRes = this.#store.getSnapshot(
      input.tenantId,
      input.scopeId,
      input.snapshotId,
    );
    if (!snapshotRes.ok) {
      return { status: "failed", citations: [], excluded: [], verification: [], error: snapshotRes.error };
    }
    const snapshot = snapshotRes.value;
    const revisions = this.#store.revisionsOf(snapshot);
    const questionProduct = detectQuestionProduct(input.question.text);

    const excluded: ExcludedSource[] = [];
    const citable: SourceRevision[] = [];
    for (const rev of revisions) {
      if (rev.status === "withdrawn") {
        excluded.push({ sourceRevisionId: rev.sourceRevisionId, reason: "withdrawn" });
        continue;
      }
      const product = sourceProduct(rev);
      if (questionProduct && product && product !== questionProduct) {
        excluded.push({ sourceRevisionId: rev.sourceRevisionId, reason: "different-product" });
        continue;
      }
      if (
        input.question.productVersion &&
        rev.version &&
        rev.version !== input.question.productVersion
      ) {
        excluded.push({ sourceRevisionId: rev.sourceRevisionId, reason: "different-version" });
        continue;
      }
      citable.push(rev);
    }

    const verification: VerificationCheck[] = [
      {
        checkId: "v01-snapshot-binding",
        result: "pass",
        note: `bound to snapshot ${snapshot.snapshotId} with ${revisions.length} revisions`,
      },
      {
        checkId: "v01-withdrawn-excluded",
        result: "pass",
        note: `${excluded.filter((e) => e.reason === "withdrawn").length} withdrawn source(s) excluded`,
      },
    ];

    const metric = detectMetric(input.question.text);
    const facts = metric
      ? citable.flatMap((rev) =>
          extractFacts(rev.content, metric).map((f) => ({
            ...f,
            sourceRevisionId: rev.sourceRevisionId,
            contentSha256: rev.contentSha256,
          })),
        )
      : [];

    const inputHash = bindingHash([
      snapshot.snapshotId,
      input.question.id,
      input.question.text,
      ...facts.map((f) => `${f.sourceRevisionId}:${f.value}`),
    ]);

    const registerEvidence = (fact: (typeof facts)[number]): string =>
      this.#registry.register({
        tenantId: input.tenantId,
        scopeId: input.scopeId,
        kind: "evidence",
        sha256: fact.contentSha256,
        label: `引用 ${fact.sourceRevisionId}`,
        bindings: {
          snapshotId: snapshot.snapshotId,
          sourceRevisionId: fact.sourceRevisionId,
        },
      }).id;

    const distinctValues = [...new Set(facts.map((f) => f.value))];

    if (!metric || facts.length === 0) {
      const assessment = this.#assessor.assess({
        recordId: this.#ids.next("rec"),
        inputBindingSha256: inputHash,
        questionText: input.question.text,
        claim: metric ? `${metric.label} = ?` : "unrecognized metric",
        evidence: [],
        createdAt: input.askedAt,
      });
      return {
        status: "succeeded",
        outcome: "no-answer",
        citations: [],
        excluded,
        verification,
        assessment,
      };
    }

    if (distinctValues.length > 1) {
      const evidence = facts.map((f) => ({
        evidenceId: registerEvidence(f),
        quote: f.quote,
        value: f.value,
      }));
      const assessment = this.#assessor.assess({
        recordId: this.#ids.next("rec"),
        inputBindingSha256: inputHash,
        questionText: input.question.text,
        claim: `${metric.label} = ${distinctValues[0]}`,
        claimValue: distinctValues[0],
        evidence,
        createdAt: input.askedAt,
      });
      const conflicts = distinctValues.map((value) => ({
        value,
        sourceRevisionIds: facts
          .filter((f) => f.value === value)
          .map((f) => f.sourceRevisionId),
      }));
      return {
        status: "succeeded",
        outcome: "conflict",
        citations: facts.map((f) => f.sourceRevisionId),
        excluded,
        conflicts,
        verification,
        assessment,
      };
    }

    const value = distinctValues[0] as string;
    const evidence = facts.map((f) => ({
      evidenceId: registerEvidence(f),
      quote: f.quote,
      value: f.value,
    }));
    const assessment = this.#assessor.assess({
      recordId: this.#ids.next("rec"),
      inputBindingSha256: inputHash,
      questionText: input.question.text,
      claim: `${metric.label} = ${value}`,
      claimValue: value,
      evidence,
      createdAt: input.askedAt,
    });
    verification.push({
      checkId: "v01-citations-resolve",
      result: "pass",
      note: `${facts.length} citation(s), all inside the bound snapshot and active`,
    });
    return {
      status: "succeeded",
      outcome: "answered",
      value,
      answerText: facts[0]?.quote,
      citations: facts.map((f) => f.sourceRevisionId),
      excluded,
      verification,
      assessment,
    };
  }
}
