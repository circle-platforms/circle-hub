import {applyExpectedJudgments} from './judgments.ts';
import { labelOf } from './generated/vocabulary.ts';
// Item projection of the quality-board pack (W01): the bound facet view becomes one item per (line, module) group, with the
// counts and the exact ratios frozen in the item fields and the view facts frozen in the run's groups for the totals check.
// The grouping itself is board.ts; both the summary here and the checks read the same groups. A run too large is a refusal
// with a fix, not a cut answer.
import { attachCoverage, coverageSummary } from './coverage.ts';
import { groupBoard, summaryOf } from './board.ts';
import { readThresholds } from './thresholds.ts';
import { PACK, guarded, isRecord, utf8Length } from './text.ts';
import type { BoundInput, PackWarning, ProjectedItem, RunFacts } from './types.ts';
import { readFacetView } from './views.ts';

/** The input slot (workflow.json). */
export const SLOT = 'facets';
const COMMANDLESS_CASES = labelOf('knowledge_count', 'commandless_cases');
const PARSER = 'json@1';

/** Budgets under the sandbox's default limits, so that a run too large is a refusal with a fix. */
export interface ProjectLimits {
  maxItems: number;
  outputBytes: number;
}
export const PROJECT_LIMITS: ProjectLimits = { maxItems: 8000, outputBytes: 5 * 1024 * 1024 };

type Refusal = { error: { code: string; message: string; fix: string }; warnings: PackWarning[] };
type Output = { items: ProjectedItem[]; groups: Record<string, unknown>[]; warnings: PackWarning[] } | Refusal;

function refusal(code: string, message: string, fix: string, warnings: PackWarning[] = []): Refusal {
  return { error: { code: `${PACK}.${code}`, message, fix }, warnings };
}

export function projectItems(input: unknown, limits: Partial<ProjectLimits> = {}): Output {
  const budget: ProjectLimits = { ...PROJECT_LIMITS, ...limits };
  if (!isRecord(input) || !Array.isArray(input.inputs)) return refusal('invalid_input', '输入里没有 inputs 数组', '按 projection-input@1 传入绑定的视图');
  const rawParameters = isRecord(input.parameters) ? input.parameters : {};
  const thresholds = readThresholds(rawParameters);
  if (thresholds.ignored.length > 0) {
    return refusal('invalid_parameter', `参数 ${thresholds.ignored.join('、')} 的取值无效`, '三个阈值参数都写成 0 到 1 的数，例如 {"max_missing_ratio": 0.05}；不写则用默认值');
  }
  const bound = (input.inputs as unknown[]).filter(isRecord);
  const inputs = bound.filter((b) => b.slot === SLOT);
  const fix = `inputs.facets 绑定一个 by=line,module,has_expected,negative,test_type_status 计数视图，可再绑一个 by=line,module,tags,resource_empty,tag_valid 标签视图；inputs.placement 必填，绑定 by=commands ${COMMANDLESS_CASES}视图，三个视图同产品同知识根`;
  if (inputs.length < 1 || inputs.length > 2) return refusal('invalid_input', 'facets 需要一个计数视图和可选的一个标签视图', fix);
  const countInputs = inputs.filter((b) => isRecord(b.model) && Array.isArray(b.model.by) && b.model.by.includes('has_expected'));
  const tagInputs = inputs.filter((b) => { const model = b.model; if (!isRecord(model) || !Array.isArray(model.by)) return false; const by = model.by; return by.length === 5 && ['line', 'module', 'tags','resource_empty','tag_valid'].every((key) => by.includes(key)); });
  if (countInputs.length !== 1 || (inputs.length === 2 && tagInputs.length !== 1)) return refusal('wrong_view', '计数视图和标签视图的组合不正确', fix);
  const read = readFacetView(countInputs[0] as unknown as BoundInput, SLOT);
  if (!read.ok) return refusal(read.code, `输入槽 ${SLOT}：${read.message}`, read.fix);
  const view = read.view;
  if (view.by.includes('tags') || view.by.includes('commands')) return refusal('wrong_view', '计数视图不能混入列表字段 tags 或 commands，否则同一用例重复计数', fix);
  let tags: typeof view | undefined;
  if (tagInputs.length) {
    const tagRead = readFacetView(tagInputs[0] as unknown as BoundInput, SLOT, ['line', 'module', 'tags','resource_empty','tag_valid']);
    if (!tagRead.ok) return refusal(tagRead.code, tagRead.message, tagRead.fix);
    tags = tagRead.view;
    if (tags.product !== view.product || tags.root !== view.root || tags.total !== view.total) return refusal('view_mismatch', '标签和计数视图必须同产品同知识根，且 total 相同', fix);
  }
  const placements = bound.filter((b) => b.slot === 'placement');
  if (placements.length !== 1) return refusal('invalid_input', `缺少${COMMANDLESS_CASES}计数来源：placement 必须绑定一个视图`, fix);
  const placeRead = readFacetView(placements[0] as unknown as BoundInput, 'placement', ['commands']);
  if (!placeRead.ok) return refusal(placeRead.code, placeRead.message, placeRead.fix);
  const placement = placeRead.view;
  if (placement.by.length !== 1 || placement.product !== view.product || placement.root !== view.root || placement.total !== view.total) return refusal('view_mismatch', `${COMMANDLESS_CASES}视图必须是同产品同知识根的 by=commands 视图，且 total 相同`, fix);
  const nullRows = placement.rows.filter((row) => row.values.commands === null);
  if (placement.truncated && nullRows.length === 0) return refusal('wrong_view', `缺少事实：${COMMANDLESS_CASES}计数；视图截断且没有读到空组`, `重新绑定同根完整的 by=commands 视图；若续页仍受能力缺口、预算或来源限制，请管理员补足来源或请维护者提供完整的${COMMANDLESS_CASES}汇总，不猜测为零`);
  const unplaced = nullRows.reduce((sum, row) => sum + row.count, 0);
  const warnings: PackWarning[] = [];

  const context = isRecord(input.context) ? input.context : {};
  const runProduct = typeof context.product === 'string' ? context.product : null;
  if (runProduct !== null && view.product !== runProduct) {
    return refusal('view_mismatch', `视图的产品是 ${view.product}，运行绑定的是 ${runProduct}`, '绑定运行所绑产品线的视图', warnings);
  }

  const groups = groupBoard(view);
  applyExpectedJudgments(groups,view,bound);
  if (tags) attachCoverage(groups, tags);
  if (groups.length === 0) {
    if(view.total>0||view.truncated||view.skipped>0||view.scopeComplete===false)
      return refusal('wrong_view', `计数视图没有可用分组（total=${view.total}，truncated=${view.truncated}，skipped=${view.skipped}${view.scopeComplete===false?'，文档范围未完成':''}）；不能据此认定没有用例`, '按视图续读并补齐未读来源；仍无法取得完整计数时请知识库维护者提供完整视图', warnings);
    return refusal('no_cases', `构建 ${view.build} 的根里没有用例条目（视图的 total 是 ${view.total}），看板没有条目可算`, '确认这个构建的用例索引已经同步（knowledge sync），再开始运行', warnings);
  }
  const ids = new Set(groups.map((g) => g.id));
  if (ids.size !== groups.length) {
    return refusal('ambiguous_group', '有两个（版本线、模块）分组的条目编号相同（字段值里带了 /）', '修正用例索引来源里带 / 的版本线或模块值后重新同步', warnings);
  }
  if (groups.length > budget.maxItems) {
    return refusal('too_large', `这次投影出 ${groups.length} 个分组，一次运行最多 ${budget.maxItems} 个`, '把视图的 by 收紧后重试（例如按版本线分开）', warnings.slice(0, 20));
  }
  if (view.truncated) {
    warnings.push({ code: `${PACK}.view_truncated`, message: `计数视图被截断：只有列出的 ${view.rows.length} 行进入看板（视图声明共 ${view.total} 个用例条目），合计只覆盖列出的部分` });
  }

  const source = view.digest;
  const items: ProjectedItem[] = groups.map((group) => ({
    id: group.id,
    label: group.id,
    summary: summaryOf(group.counts,group.quality) + coverageSummary(group.coverage),
    location: { slot: SLOT, source, parser: PARSER, selector: 'p/rows' },
    fields: group as unknown as Record<string, unknown>,
  }));
  const facts: RunFacts = { ...(tags ? { types: true } : {}), placement: { unplaced, source: placement.source, skipped: placement.skipped, truncated: placement.truncated }, product: view.product, build: view.build, root: view.root, view: { source: view.source, total: view.total, truncated: view.truncated, skipped: view.skipped, listed_rows: view.rows.length } };
  const result = { items, groups: [facts as unknown as Record<string, unknown>], warnings };
  const bytes = utf8Length(JSON.stringify(result));
  if (bytes > budget.outputBytes) {
    return refusal('too_large', `投影结果有 ${bytes} 字节（${items.length} 个分组），超过投影函数的输出上限`, '把视图的 by 收紧后重试（例如按版本线分开）', warnings.slice(0, 20));
  }
  return result;
}

export default function project(input: unknown): unknown {
  return guarded<unknown>(
    () => projectItems(input),
    (message) => refusal('internal_error', `投影函数内部出错：${message}`, '这是任务包的缺陷，请把输入交给任务包维护人'),
  );
}
