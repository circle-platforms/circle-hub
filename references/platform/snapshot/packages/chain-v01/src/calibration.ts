import { ScriptedAssessor, type Assessor } from "@infosec/assessor";
import { KnowledgeStore } from "@infosec/knowledge";
import { FakeClock, IdGen, Registry } from "@infosec/platform";
import { KnowledgeQaService, type AnswerOutcome } from "./service.js";

/**
 * ADR 0013 calibration: run the frozen SMP-V01 samples through the
 * chain and compare against their expected conclusions, citable-source
 * constraints and answer values. With the default scripted assessor,
 * agreement evidences the pipeline and the program checks — not any
 * model's quality. P3-5 passes a real assessor through the optional
 * second parameter; the comparison logic is unchanged.
 */
export interface SampleQuestion {
  id: string;
  text: string;
  productVersion?: string;
}
export interface SampleExpected {
  conclusion: string;
  answerPoints: string[];
  citableSources?: string[];
  mustNotCite?: string[];
}
export interface StandardSample {
  sampleId: string;
  scopeId?: string;
  sources?: {
    sourceRevisionId: string;
    content: string;
    product?: string;
    version?: string;
    status?: "active" | "withdrawn";
  }[];
  snapshot?: { snapshotId: string; sourceRevisionIds: string[] };
  scopes?: {
    scopeId: string;
    sources: NonNullable<StandardSample["sources"]>;
  }[];
  questions: SampleQuestion[];
  expected: Record<string, SampleExpected>;
}

export interface CalibrationQuestionResult {
  sampleId: string;
  key: string;
  expectedConclusion: string;
  actualOutcome?: AnswerOutcome;
  conclusionMatch: boolean;
  checks: { name: string; passed: boolean }[];
}

export interface CalibrationReport {
  totalQuestions: number;
  conclusionMatches: number;
  agreementRate: number;
  programmaticChecks: { total: number; passed: number };
  questions: CalibrationQuestionResult[];
}

const OUTCOME_OF: Record<string, AnswerOutcome> = {
  supports: "answered",
  "insufficient-evidence": "no-answer",
  conflict: "conflict",
};

const TENANT = "tnt_main";
const ASKED_AT = "2026-10-10T00:00:00.000Z";

export function runCalibration(
  samples: StandardSample[],
  assessor: Assessor = new ScriptedAssessor(),
): CalibrationReport {
  const questions: CalibrationQuestionResult[] = [];

  const runOne = (
    sampleId: string,
    key: string,
    expected: SampleExpected,
    qa: KnowledgeQaService,
    ctx: { tenantId: string; scopeId: string; snapshotId: string },
    question: SampleQuestion,
  ) => {
    const result = qa.answer({ ...ctx, question, askedAt: ASKED_AT });
    const checks: { name: string; passed: boolean }[] = [];
    const cited = new Set(result.citations);
    if (expected.citableSources) {
      checks.push({
        name: "expected-citable-sources-cited",
        passed: expected.citableSources.every((s) => cited.has(s)),
      });
    }
    if (expected.mustNotCite) {
      checks.push({
        name: "must-not-cite-respected",
        passed: expected.mustNotCite.every((s) => !cited.has(s)),
      });
    }
    if (expected.conclusion === "supports") {
      checks.push({
        name: "value-appears-in-expected-answer-points",
        passed:
          result.value !== undefined &&
          expected.answerPoints.join(" ").includes(result.value),
      });
      checks.push({
        name: "assessment-conclusion-supports",
        passed: result.assessment?.conclusion === "supports",
      });
    }
    if (expected.conclusion === "insufficient-evidence") {
      checks.push({
        name: "assessment-conclusion-insufficient",
        passed: result.assessment?.conclusion === "insufficient-evidence",
      });
      checks.push({ name: "no-citations-on-no-answer", passed: cited.size === 0 });
    }
    if (expected.conclusion === "conflict") {
      checks.push({
        name: "conflict-values-presented",
        passed: (result.conflicts?.length ?? 0) >= 2,
      });
      checks.push({
        name: "no-single-value-claimed",
        passed: result.value === undefined,
      });
    }
    questions.push({
      sampleId,
      key,
      expectedConclusion: expected.conclusion,
      actualOutcome: result.outcome,
      conclusionMatch: result.outcome === OUTCOME_OF[expected.conclusion],
      checks,
    });
  };

  for (const sample of samples) {
    const clock = new FakeClock(1_700_000_000_000);
    const ids = new IdGen();
    const store = new KnowledgeStore(clock, ids);
    const registry = new Registry(clock, ids);
    const qa = new KnowledgeQaService({
      store,
      assessor,
      registry,
      ids,
    });

    if (sample.scopes) {
      sample.scopes.forEach((scope, i) => {
        for (const src of scope.sources) {
          store.addRevision({ tenantId: TENANT, scopeId: scope.scopeId, ...src });
        }
        const snapId = `snap_${scope.scopeId}`;
        store.createSnapshot({
          tenantId: TENANT,
          scopeId: scope.scopeId,
          sourceRevisionIds: scope.sources.map((s) => s.sourceRevisionId),
          snapshotId: snapId,
        });
        const letter = i === 0 ? "A" : "B";
        for (const q of sample.questions) {
          const expected = sample.expected[`scope${letter}_${q.id}`];
          if (expected) {
            runOne(
              sample.sampleId,
              `scope${letter}_${q.id}`,
              expected,
              qa,
              { tenantId: TENANT, scopeId: scope.scopeId, snapshotId: snapId },
              q,
            );
          }
        }
      });
      continue;
    }

    const scopeId = sample.scopeId ?? "scp_demo_a";
    for (const src of sample.sources ?? []) {
      store.addRevision({ tenantId: TENANT, scopeId, ...src });
    }
    if (!sample.snapshot) continue;
    store.createSnapshot({
      tenantId: TENANT,
      scopeId,
      sourceRevisionIds: sample.snapshot.sourceRevisionIds,
      snapshotId: sample.snapshot.snapshotId,
    });
    for (const q of sample.questions) {
      const expected = sample.expected[q.id];
      if (expected) {
        runOne(
          sample.sampleId,
          q.id,
          expected,
          qa,
          { tenantId: TENANT, scopeId, snapshotId: sample.snapshot.snapshotId },
          q,
        );
      }
    }
  }

  const totalChecks = questions.reduce((n, q) => n + q.checks.length, 0);
  const passedChecks = questions.reduce(
    (n, q) => n + q.checks.filter((c) => c.passed).length,
    0,
  );
  const matches = questions.filter((q) => q.conclusionMatch).length;
  return {
    totalQuestions: questions.length,
    conclusionMatches: matches,
    agreementRate: questions.length ? matches / questions.length : 0,
    programmaticChecks: { total: totalChecks, passed: passedChecks },
    questions,
  };
}
