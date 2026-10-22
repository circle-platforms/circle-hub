// The totals check: run-level facts over the whole view (cases, missing, vague, negative) and the caveat that the board
// describes the indexed cases, not the whole suite — the case index only holds cases that name a resolvable command. The
// sums are recomputed from the frozen items. A view that declares itself complete (not truncated) but whose rows cannot
// hold its stated total — fewer counted than stated, or more (a list-valued by field counted cases twice) — contradicts
// itself: the totals are refuted (advisory) instead of stated.
import { displayOf, fieldsOf, percentOf } from './board.ts';
import { guarded, isRecord } from './text.ts';
import type { CheckOutcome, GroupCounts, RunFacts } from './types.ts';

const TIER = 'advisory' as const;

function read(subject: unknown): { counts: GroupCounts; facts: RunFacts } | null {
  if (!isRecord(subject) || !Array.isArray(subject.items) || !isRecord(subject.context)) return null;
  const groups = Array.isArray(subject.context.groups) ? subject.context.groups : [];
  if (!isRecord(groups[0]) || !isRecord(groups[0].view)) return null;
  const counts: GroupCounts = { cases: 0, missing: 0, vague: 0, negative: 0 };
  for (const value of subject.items) {
    if (!isRecord(value)) return null;
    const fields = fieldsOf(value.fields);
    if (fields === null) return null;
    counts.cases += fields.counts.cases;
    counts.missing += fields.counts.missing;
    counts.vague += fields.counts.vague;
    counts.negative += fields.counts.negative;
  }
  return { counts, facts: groups[0] as unknown as RunFacts };
}

export function totalsOutcome(subject: unknown): CheckOutcome {
  const read_ = read(subject);
  if (read_ === null || read_.counts.cases === 0) {
    return { verdict: 'unknown', reason: 'check_error', statement: '合计检查的被判对象里没有条目或没有视图事实（任务包缺陷）', grounds: [], tier: TIER };
  }
  const { counts, facts } = read_;
  const view = facts.view;
  const grounds = [view.source];
  const data: Record<string, unknown> = {
    cases: counts.cases,
    missing: counts.missing,
    vague: counts.vague,
    negative: counts.negative,
    ratios: {
      missing: { num: counts.missing, den: counts.cases },
      vague: { num: counts.vague, den: counts.cases },
      negative: { num: counts.negative, den: counts.cases },
    },
    display: {
      missing: displayOf(counts.missing, counts.cases),
      vague: displayOf(counts.vague, counts.cases),
      negative: displayOf(counts.negative, counts.cases),
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
  let statement = `合计：用例 ${counts.cases} 个；无期望结果 ${counts.missing} 个（${percentOf(counts.missing, counts.cases)}）；含糊期望 ${counts.vague} 个（${percentOf(counts.vague, counts.cases)}）；负面用例 ${counts.negative} 个（${percentOf(counts.negative, counts.cases)}）。看板覆盖已索引文档的每一个用例（没有解析出命令的用例是未归位条目，也计入合计）；没有读到的来源不在其中，所以它描述的是已索引的用例，不是整套测试`;
  if (view.skipped > 0) statement += `；有 ${view.skipped} 份列出的来源没有读取，其中的用例不在计数里`;
  if (view.truncated) statement += '；视图被截断，合计只覆盖列出的部分';
  return { verdict: 'support', statement, grounds, tier: TIER, data };
}

/** Pack check function: PackCheckInput of hub/rules -> a one-element check-outcome@1 array. */
export default function totalsCheck(input: unknown): unknown {
  return guarded<unknown>(
    () => [totalsOutcome(isRecord(input) ? input.subject : undefined)],
    (message) => [{ verdict: 'unknown', reason: 'check_error', statement: `合计检查出错（任务包缺陷）：${message}`, grounds: [], tier: TIER }],
  );
}
