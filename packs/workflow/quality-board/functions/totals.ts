import { labelOf } from './generated/vocabulary.ts';
// The totals check: run-level facts over the whole view (cases, missing, vague, negative) and the caveat that the board
// describes the indexed cases, not the whole suite; commandless cases are counted too. The
// sums are recomputed from the frozen items. A view that declares itself complete (not truncated) but whose rows cannot
// hold its stated total — fewer counted than stated, or more (a list-valued by field counted cases twice) — contradicts
// itself: the totals are refuted (advisory) instead of stated.
import { displayOf, fieldsOf, percentOf, summaryOf } from './board.ts';
import { guarded, isRecord } from './text.ts';
import type { CheckOutcome, GroupCounts, GroupBoard, RunFacts } from './types.ts';

const COMMANDLESS_CASES = labelOf('knowledge_count', 'commandless_cases');
const TIER = 'advisory' as const;

function read(subject: unknown): { counts: GroupCounts; facts: RunFacts } | null {
  if (!isRecord(subject) || !Array.isArray(subject.items) || !isRecord(subject.context)) return null;
  const groups = Array.isArray(subject.context.groups) ? subject.context.groups : [];
  if (!isRecord(groups[0]) || !isRecord(groups[0].view)) return null;
  const counts: GroupCounts = { cases: 0, missing: 0, vague: 0, negative: 0,negative_denominator:0,type_unclassified:0 };
  for (const value of subject.items) {
    if (!isRecord(value)) return null;
    const fields = fieldsOf(value.fields);
    if (fields === null) return null;
    counts.cases += fields.counts.cases;
    counts.missing += fields.counts.missing;
    counts.vague += fields.counts.vague;
    counts.negative += fields.counts.negative;
    counts.negative_denominator!+=fields.counts.negative_denominator!;counts.type_unclassified!+=fields.counts.type_unclassified!;
  }
  return { counts, facts: groups[0] as unknown as RunFacts };
}

export function totalsOutcome(subject: unknown): CheckOutcome {
  const read_ = read(subject);
  if (read_ === null || read_.counts.cases === 0) {
    return { verdict: 'unknown', missing: '尚未取得本检查所需的事实：' + ('合计检查的被判对象里没有条目或没有视图事实（任务包缺陷）'), reason: 'check_error', statement: '合计检查的被判对象里没有条目或没有视图事实（任务包缺陷）', grounds: [], tier: TIER };
  }
  const { counts, facts } = read_;
  const view = facts.view;
  const items=(subject as {items:Array<{fields:unknown}>}).items;
  const quality=items.map(item=>fieldsOf(item.fields)!.quality).reduce<NonNullable<GroupBoard['quality']>>((a,q)=>({judged:a.judged+(q?.judged??0),unjudged:a.unjudged+(q?.unjudged??0),conflicted:a.conflicted+(q?.conflicted??0),sources:[...new Set([...a.sources,...(q?.sources??[])])]}),{judged:0,unjudged:0,conflicted:0,sources:[] as string[]});
  const grounds = [view.source, ...(facts.placement ? [facts.placement.source] : []),...quality.sources];
  const data: Record<string, unknown> = {
    ...(facts.placement ? { placement: facts.placement } : {}),
    quality,
    judged:quality.judged,
    unjudged:quality.unjudged,
    cases: counts.cases,
    missing: counts.missing,
    vague: counts.vague,
    negative: counts.negative,
    negative_denominator:counts.negative_denominator,type_unclassified:counts.type_unclassified,
    ratios: {
      missing: { num: counts.missing, den: counts.cases },
      vague: { num: counts.vague, den: quality.judged },
      negative: { num: counts.negative, den: counts.negative_denominator! },
    },
    display: {
      missing: displayOf(counts.missing, counts.cases),
      vague: quality.judged===0?null:displayOf(counts.vague, quality.judged),
      negative: counts.negative_denominator===0?null:displayOf(counts.negative, counts.negative_denominator!),
    },
    view: { total: view.total, truncated: view.truncated, skipped: view.skipped, listed_rows: view.listed_rows },
  };
  if (!view.truncated && counts.cases < view.total) {
    return {
      verdict: 'refute',
      code: 'quality-board.total_undercount',
      statement: `视图声明未截断，但各行加起来的用例数（${counts.cases}）少于视图声明的用例总数（${view.total}）：视图自相矛盾，合计不可信`,
      grounds,
      tier: TIER,
      data,
    };
  }
  if (!view.truncated && counts.cases > view.total) {
    return {
      verdict: 'refute',
      code: 'quality-board.multi_valued',
      statement: `视图声明未截断，但各行加起来的用例数（${counts.cases}）多于视图声明的用例总数（${view.total}）：有用例在分组字段上带了多个值，被重复计数，合计不可信`,
      grounds,
      tier: TIER,
      data,
    };
  }
  let statement = '合计：'+summaryOf(counts,quality)+`。看板覆盖已索引文档的每一个用例（${COMMANDLESS_CASES}按 commands 空组计数，也计入合计）；未判断不当明确或含糊，含糊率仅描述已受理判断的子集，以模型判断为前提；没有读到的来源不在其中，所以它描述的是已索引的用例，不是整套测试`;
  if (facts.types) statement += '；只按标签观察六种测试类型，其余 18 个模板类别需要路径、标题、步骤和期望原文，这些视图看不到，另用模板查缺读取原文';
  if (facts.placement) statement += `；${COMMANDLESS_CASES} ${facts.placement.unplaced} 个，计入合计` + (facts.placement.skipped > 0 ? `；${COMMANDLESS_CASES}计数只覆盖已索引的来源，另有 ${facts.placement.skipped} 份来源未读，下一步同步这些来源后重跑` : '');
  if (view.skipped > 0) statement += `；有 ${view.skipped} 份列出的来源没有读取，其中的用例不在计数里`;
  if (view.truncated) statement += '；视图被截断，合计只覆盖列出的部分';
  return { verdict: 'support', statement, grounds, tier: TIER, data };
}

/** Pack check function: PackCheckInput of hub/rules -> a one-element check-outcome@1 array. */
export default function totalsCheck(input: unknown): unknown {
  return guarded<unknown>(
    () => [totalsOutcome(isRecord(input) ? input.subject : undefined)],
    (message) => [{ verdict: 'unknown', missing: '尚未取得本检查所需的事实：' + (`合计检查出错（任务包缺陷）：${message}`), reason: 'check_error', statement: `合计检查出错（任务包缺陷）：${message}`, grounds: [], tier: TIER }],
  );
}
