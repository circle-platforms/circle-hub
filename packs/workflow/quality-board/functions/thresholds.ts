// The thresholds check: advisory violations when a group's missing or vague share exceeds its maximum or the negative share
// falls below its minimum; equal to the threshold is not a violation; never a blocking violation, because these are
// management signals, not defects. The thresholds are the run's parameters with their defaults; the comparison is the exact
// fraction against the parameter as a number.
import { fieldsOf, percentOf } from './board.ts';
import { guarded, internalError, isRecord } from './text.ts';
import type { CheckOutcome, GroupBoard, Thresholds } from './types.ts';

const TIER = 'advisory' as const;

export const DEFAULT_THRESHOLDS: Thresholds = { max_missing_ratio: 0.05, max_vague_ratio: 0.05, min_negative_ratio: 0.02 };

export type ThresholdRead = { thresholds: Thresholds; ignored: string[] };

function ratioOf(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : null;
}

/** Reads the threshold parameters: absent is the default; an invalid value is reported (the projection refuses it first). */
export function readThresholds(raw: unknown): ThresholdRead {
  const thresholds = { ...DEFAULT_THRESHOLDS };
  const ignored: string[] = [];
  if (!isRecord(raw)) return { thresholds, ignored };
  for (const name of ['max_missing_ratio', 'max_vague_ratio', 'min_negative_ratio'] as const) {
    if (raw[name] === undefined) continue;
    const value = ratioOf(raw[name]);
    if (value === null) ignored.push(name);
    else thresholds[name] = value;
  }
  return { thresholds, ignored };
}

type Metric = 'missing' | 'vague' | 'negative';

const METRIC_STATEMENT: Readonly<Record<Metric, string>> = {
  missing: '无期望结果的用例',
  vague: '只有含糊期望结果的用例',
  negative: '负面用例',
};

/** The violation code of each metric, declared in tables/codes.json. */
const VIOLATION_CODE: Readonly<Record<Metric, string>> = {
  missing: 'quality-board.missing_expected',
  vague: 'quality-board.vague_expected',
  negative: 'quality-board.negative_share',
};

/** The advisory violations of one group, in the metric order missing, vague, negative; empty when within the thresholds. */
function violationsOf(fields: GroupBoard, thresholds: Thresholds): Array<{ metric: Metric; over: boolean }> {
  const out: Array<{ metric: Metric; over: boolean }> = [];
  const { missing, vague, negative } = fields.ratios;
  if (missing.num / missing.den > thresholds.max_missing_ratio) out.push({ metric: 'missing', over: true });
  if (vague.num / vague.den > thresholds.max_vague_ratio) out.push({ metric: 'vague', over: true });
  if (negative.den>0 && negative.num / negative.den < thresholds.min_negative_ratio) out.push({ metric: 'negative', over: false });
  return out;
}

export function thresholdOutcomes(subject: unknown): CheckOutcome[] {
  const raw = isRecord(subject) ? subject : {};
  const context = isRecord(raw.context) ? raw.context : {};
  const { thresholds, ignored } = readThresholds(context.parameters);
  const items = (Array.isArray(raw.items) ? raw.items : []).filter(isRecord);
  const out: CheckOutcome[] = [];
  for (const [at, value] of items.entries()) {
    const id = typeof value.id === 'string' ? value.id : '';
    if (id === '') continue;
    const pointer = `/items/${at}/fields`;
    const location = typeof value.location === 'string' ? value.location : '';
    const grounds = location === '' ? [] : [location];
    try {
      const fields = fieldsOf(value.fields);
      if (fields === null || ignored.length > 0) {
        const why = fields === null ? `条目 ${id} 的字段不是质量看板的形状（任务包缺陷）` : `阈值参数 ${ignored.join('、')} 的取值无效（应是 0 到 1 的数）`;
        out.push({ verdict: 'unknown', missing: '尚未取得本检查所需的事实：' + (why), reason: 'check_error', statement: why, grounds: [], tier: TIER, item: id, pointer });
        continue;
      }
      const unresolvedNegative=fields.ratios.negative.den===0;
      if(unresolvedNegative)out.push({verdict:'unknown',reason:'missing_input',tier:TIER,item:id,pointer,grounds,missing:'缺少有效作者测试类型声明构成的负向比例分母',statement:'缺少有效测试类型声明，负向比例未核对；下一步作者按发布闭集补 resource，重产知识根后重新运行看板'});
      const violations = violationsOf(fields, thresholds);
      const noJudgment=fields.ratios.vague.den===0;
      if(noJudgment)out.push({verdict:'unknown',reason:'missing_input',missing:'分组 '+id+' 的已受理期望质量判断；下一步由运行者补交当前原件的 case-review 期望判断并绑定其 rec: 结果和同根 cases 索引，重新开始看板',statement:'含糊期望阈值未核对：已判断数为 0，没有可用分母；下一步补交评审并重跑',grounds:[...grounds,...(fields.quality?.sources??[])],tier:TIER,item:id,pointer,data:{quality:fields.quality}});
      if (violations.length === 0) {
        if(noJudgment||unresolvedNegative)continue;
        out.push({
          verdict: 'support',
          statement: `阈值内：无期望结果 ${percentOf(fields.counts.missing, fields.counts.cases)} ≤ 上限 ${(thresholds.max_missing_ratio * 100).toFixed(1)}%；含糊期望 ${percentOf(fields.counts.vague, fields.ratios.vague.den)}（已判断分母 ${fields.ratios.vague.den} 个） ≤ 上限 ${(thresholds.max_vague_ratio * 100).toFixed(1)}%；负面用例 ${percentOf(fields.counts.negative, fields.counts.negative_denominator!)} ≥ 下限 ${(thresholds.min_negative_ratio * 100).toFixed(1)}%`,
          grounds,
          tier: TIER,
          item: id,
          pointer,
          data: { quality:fields.quality,vague_ratio:fields.ratios.vague,line: fields.line, module: fields.module, negative_denominator:fields.counts.negative_denominator,type_unclassified:fields.counts.type_unclassified,thresholds: { ...thresholds } },
        });
        continue;
      }
      for (const violation of violations) {
        const ratio = fields.ratios[violation.metric];
        const threshold = violation.metric === 'missing' ? thresholds.max_missing_ratio : violation.metric === 'vague' ? thresholds.max_vague_ratio : thresholds.min_negative_ratio;
        const share = percentOf(ratio.num, ratio.den);
        const bound = `${(threshold * 100).toFixed(1)}%`;
        out.push({
          verdict: 'refute',
          code: VIOLATION_CODE[violation.metric],
          statement: violation.over
            ? `${METRIC_STATEMENT[violation.metric]}占 ${share}，超过上限 ${bound}（${ratio.num}/${ratio.den}）`
            : `${METRIC_STATEMENT[violation.metric]}占 ${share}，低于下限 ${bound}（${ratio.num}/${ratio.den}）`,
          grounds,
          tier: TIER,
          item: id,
          pointer,
          data: { line: fields.line, module: fields.module, metric: violation.metric, type_unclassified:fields.counts.type_unclassified, ratio, display: fields.display[violation.metric], threshold },
        });
      }
    } catch (error) {
      out.push({ verdict: 'unknown', missing: '尚未取得本检查所需的事实：' + (`阈值检查出错（任务包缺陷）：${internalError(error)}`), reason: 'check_error', statement: `阈值检查出错（任务包缺陷）：${internalError(error)}`, grounds: [], tier: TIER, item: id });
    }
  }
  if (out.length === 0) out.push({ verdict: 'unknown', missing: '尚未取得本检查所需的事实：' + ('阈值检查的被判对象里没有条目（子对象构建函数没有给出 items）'), reason: 'check_error', statement: '阈值检查的被判对象里没有条目（子对象构建函数没有给出 items）', grounds: [], tier: TIER });
  return out;
}

/** Pack check function: PackCheckInput of hub/rules -> check-outcome@1 array. */
export default function thresholdsCheck(input: unknown): unknown {
  return guarded<unknown>(
    () => thresholdOutcomes(isRecord(input) ? input.subject : undefined),
    (message) => [{ verdict: 'unknown', missing: '尚未取得本检查所需的事实：' + (`阈值检查出错（任务包缺陷）：${message}`), reason: 'check_error', statement: `阈值检查出错（任务包缺陷）：${message}`, grounds: [], tier: TIER }],
  );
}
