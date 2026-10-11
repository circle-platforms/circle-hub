import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  parseUseCaseMarkdown,
  type DefectSample,
} from "@infosec/chain-v04";
import {
  BudgetExceeded,
  CallFailed,
  BudgetTracker,
  callMessages,
  parseModelJson,
  MAX_TOKENS,
  MODEL_ID,
  PROMPT_SET_ID,
  TEMPERATURE,
  V04_REVIEW_SYSTEM,
  buildReviewUser,
} from "../src/index.js";

/**
 * P3-5 L4 evaluation, V04: the frozen SMP-V04 sets reviewed by the
 * real model under the frozen four-dimension taxonomy, compared
 * against the frozen expected findings exactly as the P2-4 rule
 * calibration compared them — (case, type, severity).
 *
 * UC-04R's text is NOT part of the frozen sample; it is the same
 * test fixture the P2-4 calibration used, constructed strictly from
 * the sample's revisionSet description (disclosed in P2-4 and here).
 */
const SAMPLES_DIR =
  process.env.V04_SAMPLES_DIR ??
  fileURLToPath(new URL("../../../../samples/v04/", import.meta.url));
const OUT_DIR =
  process.env.EVAL_OUT_DIR ??
  fileURLToPath(new URL("../../eval-out/", import.meta.url));

const REVISION_CASE = {
  id: "UC-04R",
  text: "UC-04R 查看订单详情（修订版）：前置：用户已登录，会话有效期 30 分钟。主流程：1. 用户输入订单号；2. 系统校验订单归属与当前登录用户一致后，按订单号返回订单详情；3. 用户查看详情。后置：会话有效期 3 分钟，超时需重新登录。",
};

interface ModelFinding {
  type: string;
  severity: string;
  location?: string;
  rationale?: string;
}

function reviewCase(
  budget: BudgetTracker,
  caseId: string,
  text: string,
): { findings: ModelFinding[]; failure?: string } {
  try {
    const { text: reply } = callMessages(budget, `v04-review:${caseId}`, {
      model: MODEL_ID,
      max_tokens: MAX_TOKENS,
      temperature: TEMPERATURE,
      system: V04_REVIEW_SYSTEM,
      messages: [{ role: "user", content: buildReviewUser(caseId, text) }],
    });
    const parsed = parseModelJson(reply);
    if (!parsed || !Array.isArray(parsed.findings)) {
      return { findings: [], failure: "unparseable model output" };
    }
    return {
      findings: parsed.findings
        .filter(
          (f): f is ModelFinding =>
            typeof f === "object" &&
            f !== null &&
            typeof (f as ModelFinding).type === "string" &&
            typeof (f as ModelFinding).severity === "string",
        )
        .map((f) => ({
          type: f.type,
          severity: f.severity,
          location: f.location,
          rationale: f.rationale,
        })),
    };
  } catch (error) {
    if (error instanceof BudgetExceeded) throw error;
    if (error instanceof CallFailed) {
      return { findings: [], failure: "model call failed after retries" };
    }
    throw error;
  }
}

function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const budget = new BudgetTracker();
  const baselineCases = parseUseCaseMarkdown(
    readFileSync(`${SAMPLES_DIR}smp-v04-01-usecases.md`, "utf8"),
  );
  const defectSample = JSON.parse(
    readFileSync(`${SAMPLES_DIR}smp-v04-02.json`, "utf8"),
  ) as DefectSample;

  const perCase: Record<
    string,
    { findings: ModelFinding[]; failure?: string }
  > = {};
  let stoppedReason: string | undefined;
  const allCases = [
    ...baselineCases.map((c) => ({ id: c.id, text: c.text })),
    ...defectSample.cases.map((c) => ({ id: c.id, text: c.text })),
    REVISION_CASE,
  ];
  for (const kase of allCases) {
    try {
      perCase[kase.id] = reviewCase(budget, kase.id, kase.text);
    } catch (error) {
      if (error instanceof BudgetExceeded) {
        stoppedReason = error.message;
        break;
      }
      throw error;
    }
  }

  const baselineIds = new Set(baselineCases.map((c) => c.id));
  const baselineFindings = baselineCases.flatMap((c) =>
    (perCase[c.id]?.findings ?? []).map((f) => ({ caseId: c.id, ...f })),
  );
  const expected: {
    defectId: string;
    caseId: string;
    type: string;
    severity: string;
    matched: boolean;
  }[] = [];
  const matchedKeys = new Set<string>();
  for (const kase of defectSample.cases) {
    for (const defect of kase.defects) {
      const hit = (perCase[kase.id]?.findings ?? []).find(
        (f) =>
          f.type === defect.expectedFinding.type &&
          f.severity === defect.expectedFinding.severity,
      );
      expected.push({
        defectId: defect.defectId,
        caseId: kase.id,
        type: defect.expectedFinding.type,
        severity: defect.expectedFinding.severity,
        matched: hit !== undefined,
      });
      if (hit) matchedKeys.add(`${kase.id}|${hit.type}|${hit.severity}`);
    }
  }
  const revisionExpected = defectSample.revisionSet;
  const revisionFindings = perCase[REVISION_CASE.id]?.findings ?? [];
  const revisionHit = revisionFindings.find(
    (f) =>
      f.type === revisionExpected.expectedFinding.type &&
      f.severity === revisionExpected.expectedFinding.severity,
  );
  expected.push({
    defectId: revisionExpected.newDefectId,
    caseId: REVISION_CASE.id,
    type: revisionExpected.expectedFinding.type,
    severity: revisionExpected.expectedFinding.severity,
    matched: revisionHit !== undefined,
  });
  if (revisionHit) {
    matchedKeys.add(
      `${REVISION_CASE.id}|${revisionHit.type}|${revisionHit.severity}`,
    );
  }
  const d01 = defectSample.cases
    .flatMap((c) => c.defects)
    .find((d) => d.defectId === "D-01");
  const fixedDefectAbsent =
    d01 === undefined ||
    !revisionFindings.some((f) => f.type === d01.expectedFinding.type);

  const extraFindings = Object.entries(perCase)
    .filter(([caseId]) => !baselineIds.has(caseId))
    .flatMap(([caseId, result]) =>
      result.findings
        .filter((f) => !matchedKeys.has(`${caseId}|${f.type}|${f.severity}`))
        .map((f) => ({ caseId, ...f })),
    );
  const matchedCount = expected.filter((e) => e.matched).length;
  const report = {
    chain: "V04",
    modelId: MODEL_ID,
    promptSetId: PROMPT_SET_ID,
    stoppedReason: stoppedReason ?? null,
    baseline: {
      caseCount: baselineCases.length,
      totalFindings: baselineFindings.length,
      highSeverityFindings: baselineFindings.filter(
        (f) => f.severity === "high",
      ).length,
      findings: baselineFindings,
    },
    expected,
    agreementRate: expected.length === 0 ? 0 : matchedCount / expected.length,
    extraFindings,
    revision: {
      defectId: revisionExpected.newDefectId,
      matched: revisionHit !== undefined,
      fixedDefectAbsent,
    },
    failures: Object.entries(perCase)
      .filter(([, r]) => r.failure)
      .map(([caseId, r]) => ({ caseId, failure: r.failure })),
    budget: budget.snapshot(),
  };
  writeFileSync(
    `${OUT_DIR}v04-report.json`,
    JSON.stringify(report, null, 2),
    "utf8",
  );
  console.log(
    JSON.stringify({
      baseline: report.baseline.totalFindings,
      baselineHigh: report.baseline.highSeverityFindings,
      expectedMatched: `${matchedCount}/${expected.length}`,
      extraFindings: extraFindings.length,
      revision: report.revision,
      calls: budget.calls,
      totalTokens: budget.totalTokens,
      stoppedReason: stoppedReason ?? null,
    }),
  );
}

main();
