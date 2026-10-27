// The final prose only declares the computed overall verdict and level. Individual dispositions and suggestions are
// already shown verbatim by the deterministic table; the reporter must not transcribe them into another claim list.
import type { CheckOutcome } from '../../../../contracts/src/tables.ts';
import { PACK, isRecord } from './common.ts';
import labels from '../tables/labels.json' with {type:'json'};

const VERDICTS=labels.finalCodes.map(row=>row.code);
type Verdict=string;
const TIER = 'blocking';
export const CODES = {
  verdictMismatch: `${PACK}.verdict_mismatch`,
  levelMismatch: `${PACK}.level_mismatch`,
  reportMissing: `${PACK}.report_missing`,
  multipleVerdicts: `${PACK}.multiple_verdicts`,
  gapLevelMismatch: `${PACK}.gap_level_mismatch`,
};

const cross = (value: unknown): Record<string, unknown>[] => (Array.isArray(value) ? value.filter(isRecord) : []);

function itemsOf(subject: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(subject.items) ? subject.items.filter(isRecord) : [];
}

function claimsOf(subject: Record<string, unknown>): Record<string, unknown>[] {
  return cross(subject.cross_item);
}

function gapProblems(claims: readonly Record<string, unknown>[], level: string | null): CheckOutcome[] {
  const out: CheckOutcome[] = [];
  claims.forEach((gap, index) => {
    if (gap.code !== 'gap') return;
    const rank = typeof gap.rank === 'string' ? gap.rank : null;
    if (rank !== level) out.push({ verdict: 'refute', code: CODES.gapLevelMismatch, statement: `证据缺口必须与本报告整体等级 ${level} 相同，当前为 ${rank ?? '（未写）'}；缺口不另定等级`, grounds: [], tier: TIER, pointer: `/cross_item/${index}/rank`, data: { expected: level, actual: rank, fix: `把这条 gap 的 rank 改为 ${level}` } });
  });
  return out;
}

export function overallCheck(input: unknown): CheckOutcome[] {
  const subject = isRecord(input) && isRecord(input.subject) ? input.subject : {};
  const reportItem = itemsOf(subject).find((i) => i.id === 'report');
  const fields = isRecord(reportItem?.fields) ? reportItem?.fields : {};
  const computed = isRecord(fields.overall) ? (fields.overall as { verdict: Verdict; level: string | null }) : null;
  const claims = claimsOf(subject);
  const verdicts = claims.filter(claim => typeof claim.code === 'string' && (VERDICTS as readonly string[]).includes(claim.code));
  if (verdicts.length !== 1) {
    const code = verdicts.length === 0 ? CODES.reportMissing : CODES.multipleVerdicts;
    return [{ verdict: 'refute', code, statement: `终稿必须恰好一条结论主张（${VERDICTS.join('、')} 之一），当前 ${verdicts.length} 条；证据缺口另写 code=gap，不能另给结论`, grounds: [], tier: TIER, pointer: '/cross_item', data: { verdicts: verdicts.length, fix: '只保留与整体结果一致的一条结论，每条证据缺口使用 code=gap 并写同一整体等级' } }, ...(computed === null ? [] : gapProblems(claims, computed.level))];
  }
  const claim = verdicts[0];
  if (computed === null) {
    const missing = Array.isArray(fields.missing_items) ? fields.missing_items.filter((x): x is string => typeof x === 'string') : [];
    const sourceGaps=Array.isArray(fields.missing_source_facts)?fields.missing_source_facts.filter(isRecord):[];
    const blocks=Array.isArray(fields.missing_blocks)?fields.missing_blocks:[];
    const why=missing.length>0?'有 '+missing.length+' 个条目任何一块都没交付（'+missing.slice(0,10).join('、')+'），覆盖不完整'
      :sourceGaps.length>0?'缺少初评 Hub 核对支持事实；'+(typeof fields.source_gap_fix==='string'?fields.source_gap_fix:'下一步：按原回执补齐处置支持事实并重交复核后重开终稿')+'（'+sourceGaps.slice(0,3).map(gap=>String(gap.item).slice(0,50)).join('、')+'）'
      :'第 '+blocks.join('、')+' 块没有可读结论或等级';
    return [{ verdict: 'refute', code:CODES.reportMissing, statement: `${why}，整体结论缺少必要判定：先补齐并重开终稿`, grounds: [], tier: TIER, data: { fix: sourceGaps.length>0&&typeof fields.source_gap_fix==='string'?fields.source_gap_fix:'把缺的块复核完成（或补齐没交付的条目）后重新开始终稿运行' } }];
  }
  const out: CheckOutcome[] = [];
  if (claim.code !== computed.verdict) out.push({ verdict: 'refute', code: CODES.verdictMismatch, statement: `整体结论应是 ${computed.verdict}（各块取最差），主张写的是 ${String(claim.code)}`, grounds: [], tier: TIER, data: { fix: `把结论主张的码改成 ${computed.verdict}` } });
  const rank = typeof claim.rank === 'string' ? claim.rank : null;
  if (rank !== computed.level) out.push({ verdict: 'refute', code: CODES.levelMismatch, statement: `整体等级应是 ${computed.level}（最差那块的等级），主张的等级是 ${rank ?? '（未写）'}`, grounds: [], tier: TIER, data: { fix: `把结论主张的等级改成 ${computed.level}` } });
  out.push(...gapProblems(claims, computed.level));
  if (out.length > 0) return out;
  return [{ verdict: 'support', statement: `整体结论 ${computed.verdict}、等级 ${computed.level}：唯一结论与 ${claims.filter(c => c.code === 'gap').length} 条同等级证据缺口均已核对`, grounds: [], tier: TIER }];
}

/** The table already contains each accepted disposition; the final prose only declares the computed overall and level. */
export function reportCheck(input:unknown):CheckOutcome[] {
  return overallCheck(input).map(outcome=>outcome.verdict==='support'
    ? {...outcome,statement:'终稿的整体结论和等级与各块最差一致；发现和建议已在确定性评审表中列出，不要求逐条引用'}
    : outcome);
}
