// The checks of the review report (checks.json), pure functions over the default subjects the Hub builds. The report
// requirement is a run-level judgment: its claims sit in the subject's cross_item (flattened: code, rank, statement,
// grounds — a run-level claim carries no data, so the findings are its grounds and the level its rank).
// - overall (run, fact): the report claim states the computed verdict (in its statement) and level (as its rank); when a
//   block's final was unreadable the computed overall is unknown and the statement must say so.
// - report (run): every verified, partial and new finding of the blocks is cited among the report claim's grounds (none
//   missing, none refuted, none invented), and every suggestion claim carries the three labeled parts.
import type { CheckOutcome } from '../../../../contracts/src/tables.ts';
import { PACK, isRecord } from './common.ts';

const VERDICT_ORDER = { PASS: 0, PARTIAL: 1, FAIL: 2 } as const;
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

/** The run items of the subject (the report item carries the projection's fields). */
function itemsOf(subject: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(subject.items) ? subject.items.filter(isRecord) : [];
}

/** The flattened cross-item claims the submission produced. */
function claimsOf(subject: Record<string, unknown>): Record<string, unknown>[] {
  return cross(subject.cross_item);
}

export function overallCheck(input: unknown): CheckOutcome[] {
  const subject = isRecord(input) && isRecord(input.subject) ? input.subject : {};
  const reportItem = itemsOf(subject).find((i) => i.id === 'report');
  const fields = isRecord(reportItem?.fields) ? reportItem?.fields : {};
  const computed = isRecord(fields.overall) ? (fields.overall as { verdict: string; level: string | null }) : null;
  const claim = claimsOf(subject).find((c) => c.code === 'report');
  if (claim === undefined) {
    return [{ verdict: 'refute', code: CODES.reportMissing, statement: '提交里没有终稿主张（cross_item 里 code 为 report 的一条）', grounds: [], tier: TIER, data: { fix: '按 SKILL 写终稿：一条 code=report 的跨条目主张' } }];
  }
  const statement = typeof claim.statement === 'string' ? claim.statement : '';
  if (computed === null) {
    if (!statement.includes('未知')) {
      return [{ verdict: 'refute', code: CODES.verdictMismatch, statement: '有块没有可读的结论，整体是未知，终稿要写明', grounds: [], tier: TIER, data: { fix: '终稿写明整体未知并补齐缺的块' } }];
    }
    return [{ verdict: 'support', statement: '有块没有可读的结论，整体记未知（缺输入）', grounds: [], tier: TIER }];
  }
  if (!statement.includes(computed.verdict)) {
    return [{ verdict: 'refute', code: CODES.verdictMismatch, statement: `整体结论应是 ${computed.verdict}（各块取最差），终稿陈述里没有写明`, grounds: [], tier: TIER, data: { fix: `终稿陈述写明整体结论 ${computed.verdict}` } }];
  }
  const rank = typeof claim.rank === 'string' ? claim.rank : null;
  if (computed.level !== null && rank !== computed.level) {
    return [{ verdict: 'refute', code: CODES.levelMismatch, statement: `整体等级应是 ${computed.level}（最差那块的等级），主张的等级是 ${rank ?? '（未写）'}`, grounds: [], tier: TIER, data: { fix: `把终稿主张的等级改成 ${computed.level}` } }];
  }
  return [{ verdict: 'support', statement: `整体结论 ${computed.verdict}、等级 ${computed.level ?? '未给'}：各块取最差，终稿照写`, grounds: [], tier: TIER }];
}

export function reportCheck(input: unknown): CheckOutcome[] {
  const subject = isRecord(input) && isRecord(input.subject) ? input.subject : {};
  const reportItem = itemsOf(subject).find((i) => i.id === 'report');
  const fields = isRecord(reportItem?.fields) ? reportItem?.fields : {};
  const findings = Array.isArray(fields.findings) ? (fields.findings as unknown[]).filter(isRecord) : [];
  const known = new Set(findings.map((f) => String(f.reference ?? '')).filter((r) => r !== ''));
  const refuted = new Set(findings.filter((f) => f.kind === 'refuted').map((f) => String(f.reference ?? '')));
  const claims = claimsOf(subject);
  const report = claims.find((c) => c.code === 'report');
  if (report === undefined) {
    return [{ verdict: 'refute', code: CODES.reportMissing, statement: '提交里没有终稿主张（cross_item 里 code 为 report 的一条）', grounds: [], tier: TIER, data: { fix: '按 SKILL 写终稿：一条 code=report 的跨条目主张' } }];
  }
  const cited = new Set((Array.isArray(report.grounds) ? report.grounds : []).filter((g): g is string => typeof g === 'string'));
  const out: CheckOutcome[] = [];
  for (const f of findings) {
    const reference = String(f.reference ?? '');
    if (reference === '') continue;
    if (f.kind === 'refuted') {
      if (cited.has(reference)) out.push({ verdict: 'refute', code: CODES.findingRefuted, statement: `引用了被推翻的发现 ${reference}：推翻的发现不能进报告`, grounds: [], tier: TIER, data: { fix: '删掉这条 grounds 引用，把推翻写进终稿的文字里而不是发现清单' } });
      continue;
    }
    if (!cited.has(reference)) {
      out.push({ verdict: 'refute', code: CODES.findingMissing, statement: `发现 ${reference}（${f.kind === 'new_finding' ? '新增' : f.kind === 'partial' ? '部分正确' : '证实'}）没有在终稿的 grounds 里引用`, grounds: [], tier: TIER, data: { fix: '把这条发现的 rec: 引用补进终稿主张的 grounds' } });
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
