// The checks of the review report (checks.json), pure functions over the default subjects the Hub builds. The report
// requirement is a run-level judgment: its claims sit in the subject's cross_item (flattened: code, rank, statement,
// grounds — a run-level claim carries no data, so the findings are its grounds). The verdict claim is the one whose code
// is PASS, PARTIAL or FAIL (the closed set the slot declares, the same shape as the verification pack's own final):
// - overall (run, fact): the verdict claim's code equals the computed worst verdict and its rank the computed level — a
//   direct comparison, never text matching; with no readable final in some block the computed overall is unknown and no
//   verdict can be honestly stated, so the claim is refused with the fix naming the missing block.
// - report (run): every verified, partial and new finding of the blocks is cited among the verdict claim's grounds (none
//   missing, none refuted, none invented), and every suggestion claim carries the three labeled parts.
import type { CheckOutcome } from '../../../../contracts/src/tables.ts';
import { PACK, isRecord } from './common.ts';

const VERDICTS = ['PASS', 'PARTIAL', 'FAIL'] as const;
type Verdict = (typeof VERDICTS)[number];
const TIER = 'blocking';
const CODES = {
  verdictMismatch: `${PACK}.verdict_mismatch`,
  levelMismatch: `${PACK}.level_mismatch`,
  reportMissing: `${PACK}.report_missing`,
  findingMissing: `${PACK}.finding_missing`,
  findingRefuted: `${PACK}.finding_refuted`,
  findingUnknown: `${PACK}.finding_unknown`,
  suggestionIncomplete: `${PACK}.suggestion_incomplete`,
};

const cross = (value: unknown): Record<string, unknown>[] => (Array.isArray(value) ? value.filter(isRecord) : []);

function itemsOf(subject: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(subject.items) ? subject.items.filter(isRecord) : [];
}

function claimsOf(subject: Record<string, unknown>): Record<string, unknown>[] {
  return cross(subject.cross_item);
}

/** The verdict claim: the cross-item claim whose code is one of PASS, PARTIAL, FAIL. */
function verdictClaimOf(subject: Record<string, unknown>): Record<string, unknown> | null {
  return claimsOf(subject).find((c) => typeof c.code === 'string' && (VERDICTS as readonly string[]).includes(c.code)) ?? null;
}

export function overallCheck(input: unknown): CheckOutcome[] {
  const subject = isRecord(input) && isRecord(input.subject) ? input.subject : {};
  const reportItem = itemsOf(subject).find((i) => i.id === 'report');
  const fields = isRecord(reportItem?.fields) ? reportItem?.fields : {};
  const computed = isRecord(fields.overall) ? (fields.overall as { verdict: Verdict; level: string | null }) : null;
  const claim = verdictClaimOf(subject);
  if (claim === null) {
    return [{ verdict: 'refute', code: CODES.reportMissing, statement: `提交里没有结论主张（cross_item 里码为 ${VERDICTS.join('、')} 的一条）`, grounds: [], tier: TIER, data: { fix: '按 SKILL 写终稿：一条结论主张（code 写整体结论、rank 写整体等级、statement 写报告全文）' } }];
  }
  if (computed === null) {
    return [{ verdict: 'refute', code: CODES.verdictMismatch, statement: '有块没有可读的结论，整体是未知：先补齐缺的块再出终稿', grounds: [], tier: TIER, data: { fix: '把缺的块复核完成并重新开始终稿运行' } }];
  }
  if (claim.code !== computed.verdict) {
    return [{ verdict: 'refute', code: CODES.verdictMismatch, statement: `整体结论应是 ${computed.verdict}（各块取最差），主张写的是 ${String(claim.code)}`, grounds: [], tier: TIER, data: { fix: `把结论主张的码改成 ${computed.verdict}` } }];
  }
  const rank = typeof claim.rank === 'string' ? claim.rank : null;
  if (computed.level !== null && rank !== computed.level) {
    return [{ verdict: 'refute', code: CODES.levelMismatch, statement: `整体等级应是 ${computed.level}（最差那块的等级），主张的等级是 ${rank ?? '（未写）'}`, grounds: [], tier: TIER, data: { fix: `把结论主张的等级改成 ${computed.level}` } }];
  }
  return [{ verdict: 'support', statement: `整体结论 ${computed.verdict}、等级 ${computed.level ?? '未给'}：各块取最差，终稿主张照写`, grounds: [], tier: TIER }];
}

export function reportCheck(input: unknown): CheckOutcome[] {
  const subject = isRecord(input) && isRecord(input.subject) ? input.subject : {};
  const reportItem = itemsOf(subject).find((i) => i.id === 'report');
  const fields = isRecord(reportItem?.fields) ? reportItem?.fields : {};
  const findings = Array.isArray(fields.findings) ? (fields.findings as unknown[]).filter(isRecord) : [];
  const known = new Set(findings.map((f) => String(f.reference ?? '')).filter((r) => r !== ''));
  const refuted = new Set(findings.filter((f) => f.kind === 'refuted').map((f) => String(f.reference ?? '')));
  const claims = claimsOf(subject);
  const verdict = verdictClaimOf(subject);
  if (verdict === null) {
    return [{ verdict: 'refute', code: CODES.reportMissing, statement: `提交里没有结论主张（cross_item 里码为 ${VERDICTS.join('、')} 的一条）`, grounds: [], tier: TIER, data: { fix: '按 SKILL 写终稿：一条结论主张（code 写整体结论、rank 写整体等级、statement 写报告全文）' } }];
  }
  const cited = new Set((Array.isArray(verdict.grounds) ? verdict.grounds : []).filter((g): g is string => typeof g === 'string'));
  const out: CheckOutcome[] = [];
  for (const f of findings) {
    const reference = String(f.reference ?? '');
    if (reference === '') continue;
    if (f.kind === 'refuted') {
      if (cited.has(reference)) out.push({ verdict: 'refute', code: CODES.findingRefuted, statement: `引用了被推翻的发现 ${reference}：推翻的发现不能进报告`, grounds: [], tier: TIER, data: { fix: '删掉这条 grounds 引用，把推翻写进终稿的文字里而不是发现清单' } });
      continue;
    }
    if (!cited.has(reference)) {
      out.push({ verdict: 'refute', code: CODES.findingMissing, statement: `发现 ${reference}（${f.kind === 'new_finding' ? '新增' : f.kind === 'partial' ? '部分正确' : '证实'}）没有在结论主张的 grounds 里引用`, grounds: [], tier: TIER, data: { fix: '把这条发现的 rec: 引用补进结论主张的 grounds' } });
    }
  }
  for (const reference of cited) {
    if (!known.has(reference)) out.push({ verdict: 'refute', code: CODES.findingUnknown, statement: `引用 ${reference} 不在任何一块的复核结果里`, grounds: [], tier: TIER, data: { fix: '只引用各块复核结果里的发现' } });
  }
  for (const claim of claims.filter((c) => c.code === 'suggestion')) {
    const statement = typeof claim.statement === 'string' ? claim.statement : '';
    if (!(statement.includes('补：') && statement.includes('因为：') && statement.includes('期望：'))) {
      out.push({ verdict: 'refute', code: CODES.suggestionIncomplete, statement: '一条建议缺了三段（补：…；因为：…；期望：…）', grounds: [], tier: TIER, data: { fix: '每条建议按“补：<用例>；因为：<原因>；期望：<结果>”三段写全' } });
    }
  }
  return out.length === 0 ? [{ verdict: 'support', statement: '终稿与各块复核材料一致：发现一条不漏，没有引用推翻的发现，建议三段齐全', grounds: [], tier: TIER }] : out;
}
