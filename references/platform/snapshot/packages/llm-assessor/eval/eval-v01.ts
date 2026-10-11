import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Assessor } from "@infosec/assessor";
import type { AssessmentRecord } from "@infosec/contracts";
import {
  runCalibration,
  type CalibrationReport,
  type StandardSample,
} from "@infosec/chain-v01";
import {
  BudgetExceeded,
  BudgetTracker,
  LlmAssessor,
  MODEL_ID,
  PROMPT_SET_ID,
} from "../src/index.js";

/**
 * P3-5 L4 evaluation, V01: the frozen SMP-V01 samples through the
 * unchanged chain-v01 calibration, with the real-model assessor in
 * place of the scripted one (ADR 0013 interface; plan
 * docs/p3-5-evaluation-plan.md). Programmatic checks and conclusion
 * comparison are the harness's own — identical to the P2-3 run.
 */
const SAMPLES_DIR =
  process.env.V01_SAMPLES_DIR ??
  fileURLToPath(new URL("../../../../samples/v01/", import.meta.url));
const OUT_DIR =
  process.env.EVAL_OUT_DIR ??
  fileURLToPath(new URL("../../eval-out/", import.meta.url));

class RecordingAssessor implements Assessor {
  readonly records: AssessmentRecord[] = [];
  constructor(private readonly inner: LlmAssessor) {}
  get methodId() {
    return this.inner.methodId;
  }
  get methodVersion() {
    return this.inner.methodVersion;
  }
  assess(input: Parameters<Assessor["assess"]>[0]) {
    const record = this.inner.assess(input);
    this.records.push(record);
    return record;
  }
}

function loadSample(name: string): StandardSample {
  return JSON.parse(
    readFileSync(`${SAMPLES_DIR}${name}`, "utf8"),
  ) as StandardSample;
}

function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const budget = new BudgetTracker();
  const assessor = new RecordingAssessor(new LlmAssessor(budget));
  const names = [
    "smp-v01-01.json",
    "smp-v01-02.json",
    "smp-v01-03.json",
    "smp-v01-04.json",
  ];
  const perSample: CalibrationReport[] = [];
  const completedSamples: string[] = [];
  let stoppedReason: string | undefined;
  for (const name of names) {
    try {
      perSample.push(runCalibration([loadSample(name)], assessor));
      completedSamples.push(name);
    } catch (error) {
      if (error instanceof BudgetExceeded) {
        stoppedReason = error.message;
        break;
      }
      throw error;
    }
  }
  const merged = {
    totalQuestions: perSample.reduce((a, r) => a + r.totalQuestions, 0),
    conclusionMatches: perSample.reduce((a, r) => a + r.conclusionMatches, 0),
    programmaticChecks: {
      total: perSample.reduce((a, r) => a + r.programmaticChecks.total, 0),
      passed: perSample.reduce((a, r) => a + r.programmaticChecks.passed, 0),
    },
    questions: perSample.flatMap((r) => r.questions),
  };
  const agreementRate =
    merged.totalQuestions === 0
      ? 0
      : merged.conclusionMatches / merged.totalQuestions;
  const conclusions: Record<string, number> = {};
  for (const r of assessor.records) {
    conclusions[r.conclusion] = (conclusions[r.conclusion] ?? 0) + 1;
  }
  const report = {
    chain: "V01",
    modelId: MODEL_ID,
    promptSetId: PROMPT_SET_ID,
    methodId: assessor.methodId,
    methodVersion: assessor.methodVersion,
    completedSamples,
    stoppedReason: stoppedReason ?? null,
    ...merged,
    agreementRate,
    assessmentConclusions: conclusions,
    abstentions: assessor.records
      .filter((r) => r.conclusion === "abstained")
      .map((r) => ({ recordId: r.recordId, unknowns: r.unknowns })),
    budget: budget.snapshot(),
  };
  writeFileSync(
    `${OUT_DIR}v01-report.json`,
    JSON.stringify(report, null, 2),
    "utf8",
  );
  console.log(
    JSON.stringify({
      questions: merged.totalQuestions,
      conclusionMatches: merged.conclusionMatches,
      agreementRate,
      programmatic: merged.programmaticChecks,
      assessmentConclusions: conclusions,
      calls: budget.calls,
      totalTokens: budget.totalTokens,
      stoppedReason: stoppedReason ?? null,
    }),
  );
}

main();
