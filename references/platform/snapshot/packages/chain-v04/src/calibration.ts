import { FakeClock, IdGen, Registry } from "@infosec/platform";
import type { UseCase } from "./parse.js";
import { ReviewService, type Finding } from "./service.js";

/**
 * ADR 0013 calibration for V04, over the frozen samples:
 * - SMP-V04-01 (basically-correct set): any high-severity finding is a
 *   false positive by the sample's own calibration design.
 * - SMP-V04-02 (defect-injected set): expected findings D-01..D-03 must
 *   be detected with matching type and severity; the revision case must
 *   show D-04 and no longer show D-01.
 * The revision case text is NOT part of the frozen sample (the sample
 * carries only its description); callers construct it from that
 * description as a test fixture, disclosed as such.
 */
export interface ExpectedFinding {
  defectId: string;
  caseId: string;
  type: string;
  severity: string;
}

export interface DefectSample {
  cases: {
    id: string;
    text: string;
    defects: {
      defectId: string;
      expectedFinding: { type: string; severity: string; location: string };
    }[];
  }[];
  revisionSet: {
    newDefectId: string;
    expectedFinding: { type: string; severity: string; location: string };
  };
}

export interface V04CalibrationReport {
  baseline: { caseCount: number; totalFindings: number; highSeverityFindings: number };
  expected: (ExpectedFinding & { matched: boolean })[];
  agreementRate: number;
  extraFindings: Finding[];
  revision: { defectId: string; matched: boolean; fixedDefectAbsent: boolean };
}

const CTX = { tenantId: "tnt_main", scopeId: "scp_demo_a" };
const AT = "2026-10-10T00:00:00.000Z";

export function runV04Calibration(input: {
  baselineCases: UseCase[];
  defectSample: DefectSample;
  revisionCase: UseCase;
}): V04CalibrationReport {
  const clock = new FakeClock(1_700_000_000_000);
  const ids = new IdGen();
  const registry = new Registry(clock, ids);
  const service = new ReviewService({ registry, ids });

  const baselineReport = service.review({
    ...CTX,
    cases: input.baselineCases,
    reviewedAt: AT,
  });

  const defectCases: UseCase[] = input.defectSample.cases.map((c) => ({
    id: c.id,
    text: c.text,
  }));
  const defectReport = service.review({ ...CTX, cases: defectCases, reviewedAt: AT });

  const expected: (ExpectedFinding & { matched: boolean })[] = [];
  for (const c of input.defectSample.cases) {
    for (const d of c.defects) {
      expected.push({
        defectId: d.defectId,
        caseId: c.id,
        type: d.expectedFinding.type,
        severity: d.expectedFinding.severity,
        matched: defectReport.findings.some(
          (f) =>
            f.caseId === c.id &&
            f.type === d.expectedFinding.type &&
            f.severity === d.expectedFinding.severity,
        ),
      });
    }
  }

  const revisionReport = service.review({
    ...CTX,
    cases: [input.revisionCase],
    reviewedAt: AT,
  });
  const revisionExpected: ExpectedFinding & { matched: boolean } = {
    defectId: input.defectSample.revisionSet.newDefectId,
    caseId: input.revisionCase.id,
    type: input.defectSample.revisionSet.expectedFinding.type,
    severity: input.defectSample.revisionSet.expectedFinding.severity,
    matched: revisionReport.findings.some(
      (f) =>
        f.type === input.defectSample.revisionSet.expectedFinding.type &&
        f.severity === input.defectSample.revisionSet.expectedFinding.severity,
    ),
  };
  expected.push(revisionExpected);

  const matchedCount = expected.filter((e) => e.matched).length;
  const matchedKeys = new Set(
    expected.map((e) => `${e.caseId}|${e.type}|${e.severity}`),
  );
  const extraFindings = [...defectReport.findings, ...revisionReport.findings].filter(
    (f) => !matchedKeys.has(`${f.caseId}|${f.type}|${f.severity}`),
  );

  return {
    baseline: {
      caseCount: input.baselineCases.length,
      totalFindings: baselineReport.findings.length,
      highSeverityFindings: baselineReport.findings.filter(
        (f) => f.severity === "high",
      ).length,
    },
    expected,
    agreementRate: expected.length ? matchedCount / expected.length : 0,
    extraFindings,
    revision: {
      defectId: revisionExpected.defectId,
      matched: revisionExpected.matched,
      fixedDefectAbsent: !revisionReport.findings.some(
        (f) => f.type === "越权未校验",
      ),
    },
  };
}
