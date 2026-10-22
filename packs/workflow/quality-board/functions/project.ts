// Item projection of the quality-board pack (W01): the bound facet view becomes one item per (line, module) group, with the
// counts and the exact ratios frozen in the item fields and the view facts frozen in the run's groups for the totals check.
// The grouping itself is board.ts; both the summary here and the checks read the same groups. A run too large is a refusal
// with a fix, not a cut answer.
import { groupBoard, summaryOf } from './board.ts';
import { readThresholds } from './thresholds.ts';
import { PACK, guarded, isRecord, utf8Length } from './text.ts';
import type { BoundInput, PackWarning, ProjectedItem, RunFacts } from './types.ts';
import { readFacetView } from './views.ts';

/** The input slot (workflow.json). */
export const SLOT = 'facets';
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
  if (inputs.length !== 1) return refusal('invalid_input', `需要输入槽 ${SLOT} 绑定一个知识计数视图`, `在 inputs.${SLOT} 里给出 knowledge:facets:<产品>:<构建>?kind=case&by=line,module,has_expected,vague_expected,negative`);

  const read = readFacetView(inputs[0] as unknown as BoundInput, SLOT);
  if (!read.ok) return refusal(read.code, `输入槽 ${SLOT}：${read.message}`, read.fix);
  const view = read.view;
  const warnings: PackWarning[] = [];

  const context = isRecord(input.context) ? input.context : {};
  const runProduct = typeof context.product === 'string' ? context.product : null;
  if (runProduct !== null && view.product !== runProduct) {
    return refusal('view_mismatch', `视图的产品是 ${view.product}，运行绑定的是 ${runProduct}`, '绑定运行所绑产品线的视图', warnings);
  }

  const groups = groupBoard(view);
  if (groups.length === 0) {
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
    summary: summaryOf(group.counts),
    location: { slot: SLOT, source, parser: PARSER, selector: 'p/rows' },
    fields: group as unknown as Record<string, unknown>,
  }));
  const facts: RunFacts = { product: view.product, build: view.build, root: view.root, view: { source: view.source, total: view.total, truncated: view.truncated, skipped: view.skipped, listed_rows: view.rows.length } };
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
