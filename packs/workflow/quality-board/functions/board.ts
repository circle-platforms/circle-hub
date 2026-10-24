import {labelOf} from './generated/vocabulary.ts';
// The board: one group per (line, module) of the facet view (module null is the group 'unplaced', and so is a null line),
// rows that split a group by the other fields summed. The metrics are exactly the definitions of the owner's real-sample
// measurement: a case without an expected result has has_expected false; a case with only vague expected results has
// has_expected true and vague_expected true; the negative share is negative true over all cases. Ratios are exact fractions
// {num, den}, rounded only for display. The board check always supports with the metrics as claim data — unless the frozen
// counts contradict the definitions (counts_inconsistent, advisory), which the pack's own projection never produces.
import { coverageSummary } from './coverage.ts';
import { clip, compareText, guarded, internalError, isRecord } from './text.ts';
import type { CheckOutcome, FacetViewData, Fraction, GroupBoard, GroupCounts } from './types.ts';

/** The group name of a null line or module. */
export const UNPLACED = 'unplaced';
const UNJUDGED=labelOf('judgment_status','unjudged');

/** The item id of a (line, module) pair. */
export function groupId(line: string | null, module: string | null): string {
  return `${line ?? UNPLACED}/${module ?? UNPLACED}`;
}

/** Rounded to four decimal places, for display only. */
export function displayOf(num: number, den: number): number {
  return den === 0 ? 0 : Math.round((num / den) * 10000) / 10000;
}

/** One decimal place with a percent sign, for summaries and statements. */
export function percentOf(num: number, den: number): string {
  return den === 0 ? '无已判断分母' : `${(Math.round((num / den) * 1000) / 10).toFixed(1)}%`;
}

function fraction(num: number, den: number): Fraction {
  return { num, den };
}

/** The one-line summary of a group (at most 200 characters): cases, missing percent, vague percent, negative percent. */
export function summaryOf(counts: GroupCounts, quality?: GroupBoard['quality']): string {
  const judged=quality?.judged??0,unjudged=quality?.unjudged??counts.cases;
  const negativeShare=counts.negative_denominator===0?'缺类型声明分母':percentOf(counts.negative,counts.negative_denominator??0);
  return clip(`用例 ${counts.cases} 个；无期望结果 ${counts.missing} 个（${percentOf(counts.missing, counts.cases)}）；含糊期望 ${counts.vague} 个（${judged?percentOf(counts.vague, judged):UNJUDGED}，已判断 ${judged} 个）；${UNJUDGED} ${unjudged} 个；负面用例 ${counts.negative} 个（${negativeShare}；有效声明分母 ${counts.negative_denominator??0}；类型未声明 ${counts.type_unclassified??0}）`, 480);
}

/**
 * The groups of the view: the by fields line and module name the group; every other field (and any extra by field such as
 * priority) only splits rows and is summed over. Deterministic: groups sorted by id in code-unit order.
 */
export function groupBoard(view: FacetViewData): GroupBoard[] {
  // The map key distinguishes the pair (a field value may contain '/'); the item id is computed after and a collision of
  // ids between different pairs is detected by the projection (ambiguous_group), never silently merged here.
  const groups = new Map<string, { line: string | null; module: string | null; counts: GroupCounts }>();
  for (const row of view.rows) {
    const line = typeof row.values.line === 'string' ? row.values.line : null;
    const module = typeof row.values.module === 'string' ? row.values.module : null;
    const key = JSON.stringify([line, module]);
    let held = groups.get(key);
    if (held === undefined) groups.set(key, (held = { line, module, counts: { cases: 0, missing: 0, vague: 0, negative: 0, negative_denominator:0, type_unclassified:0 } }));
    held.counts.cases += row.count;
    if (row.values.has_expected === false) held.counts.missing += row.count;
    if(row.values.test_type_status==='declared'&&typeof row.values.negative==='boolean'){held.counts.negative_denominator!+=row.count;if(row.values.negative)held.counts.negative+=row.count;}else held.counts.type_unclassified!+=row.count;
  }
  return [...groups.values()]
    .map((group) => ({
      line: group.line,
      module: group.module,
      id: groupId(group.line, group.module),
      counts: group.counts,
      quality: {judged:0,unjudged:group.counts.cases,conflicted:0,sources:[]},
      ratios: {
        missing: fraction(group.counts.missing, group.counts.cases),
        vague: fraction(0, 0),
        negative: fraction(group.counts.negative, group.counts.negative_denominator!),
      },
      display: {
        missing: displayOf(group.counts.missing, group.counts.cases),
        vague: null,
        negative: group.counts.negative_denominator===0?null:displayOf(group.counts.negative, group.counts.negative_denominator!),
      },
    }))
    .sort((a, b) => compareText(a.id, b.id));
}

const TIER = 'advisory' as const;

/** The frozen fields as the projection wrote them, or null when they are not the board shape (a pack defect). */
export function fieldsOf(fields: unknown): GroupBoard | null {
  if (!isRecord(fields) || !isRecord(fields.counts) || !isRecord(fields.ratios)) return null;
  const counts = fields.counts;
  const keys = ['cases', 'missing', 'vague', 'negative','negative_denominator','type_unclassified'] as const;
  if (!keys.every((key) => Number.isInteger(counts[key]) && (counts[key] as number) >= 0)) return null;
  if (typeof fields.id !== 'string') return null;
  if (!(fields.line === null || typeof fields.line === 'string') || !(fields.module === null || typeof fields.module === 'string')) return null;
  return fields as unknown as GroupBoard;
}

/** Where the frozen counts contradict the definitions (a management board never invents them): the breach, or null. */
function inconsistencyOf(counts: GroupCounts): string | null {
  if(counts.negative_denominator!>counts.cases||counts.negative>counts.negative_denominator!||counts.type_unclassified!+counts.negative_denominator! !==counts.cases)return '负向分母、类型未声明数与总用例数不一致';
  if (counts.missing > counts.cases) return `无期望结果的用例（${counts.missing}）多于用例总数（${counts.cases}）`;
  if (counts.vague > counts.cases) return `只有含糊期望结果的用例（${counts.vague}）多于用例总数（${counts.cases}）`;
  if (counts.missing + counts.vague > counts.cases) return `无期望结果的用例与只有含糊期望结果的用例加起来（${counts.missing + counts.vague}）多于用例总数（${counts.cases}）`;
  if (counts.negative > counts.cases) return `负面用例（${counts.negative}）多于用例总数（${counts.cases}）`;
  return null;
}

/** The board outcomes for a subject of the subject builder: one per group, always advisory. */
export function boardOutcomes(subject: unknown): CheckOutcome[] {
  const raw = isRecord(subject) ? subject : {};
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
      if(fields?.coverage?.invalid_source)out.push({verdict:'refute',code:'quality-board.undeclared_tag',statement:'未声明的标签：'+(fields.coverage.invalid_values??[]).map(issue=>JSON.stringify(issue.raw)).join('、')+'；resource 的闭集或形状校验未通过；未携带的原值请按根引用读取源条目的 tag_declaration，作者按发布闭集修正后重产视图',grounds,tier:TIER,item:id,pointer:pointer+'/coverage/invalid_values',data:{issues:fields.coverage.invalid_values}});
      if (fields === null) {
        out.push({ verdict: 'unknown', missing: '尚未取得本检查所需的事实：' + (`条目 ${id} 的字段不是质量看板的形状（任务包缺陷）`), reason: 'check_error', statement: `条目 ${id} 的字段不是质量看板的形状（任务包缺陷）`, grounds: [], tier: TIER, item: id, pointer });
        continue;
      }
      const breach = inconsistencyOf(fields.counts);
      if (breach !== null) {
        out.push({
          verdict: 'refute',
          code: 'quality-board.counts_inconsistent',
          statement: `分组 ${id} 的计数组不自洽：${breach}——被判对象自相矛盾，指标不可信`,
          grounds,
          tier: TIER,
          item: id,
          pointer,
          data: { line: fields.line, module: fields.module, counts: fields.counts },
        });
        continue;
      }
      out.push({
        verdict: 'support',
        statement: summaryOf(fields.counts, fields.quality) + coverageSummary(fields.coverage) + (fields.coverage ? `；出现的类型：${fields.coverage.present.join('、') || '无'}` : '') + (fields.coverage?.partial ? '；补取动作：同步未读来源并重新读取同根标签视图，若仍截断则报告分面补读能力缺口' : ''),
        grounds: [...grounds, ...(fields.quality?.sources??[]), ...(fields.coverage ? [fields.coverage.source] : [])],
        tier: TIER,
        item: id,
        pointer,
        data: { quality:fields.quality, ...(fields.coverage ? { coverage: fields.coverage } : {}), line: fields.line, module: fields.module, counts: fields.counts, ratios: fields.ratios, display: fields.display },
      });
    } catch (error) {
      out.push({ verdict: 'unknown', missing: '尚未取得本检查所需的事实：' + (`看板检查出错（任务包缺陷）：${internalError(error)}`), reason: 'check_error', statement: `看板检查出错（任务包缺陷）：${internalError(error)}`, grounds: [], tier: TIER, item: id });
    }
  }
  if (out.length === 0) out.push({ verdict: 'unknown', missing: '尚未取得本检查所需的事实：' + ('看板检查的被判对象里没有条目（子对象构建函数没有给出 items）'), reason: 'check_error', statement: '看板检查的被判对象里没有条目（子对象构建函数没有给出 items）', grounds: [], tier: TIER });
  return out;
}

/** Pack check function: PackCheckInput of hub/rules -> check-outcome@1 array. */
export default function boardCheck(input: unknown): unknown {
  return guarded<unknown>(
    () => boardOutcomes(isRecord(input) ? input.subject : undefined),
    (message) => [{ verdict: 'unknown', missing: '尚未取得本检查所需的事实：' + (`看板检查出错（任务包缺陷）：${message}`), reason: 'check_error', statement: `看板检查出错（任务包缺陷）：${message}`, grounds: [], tier: TIER }],
  );
}
