// Item projection of the traceability pack (W01): the two bound index views (the defects of the build from its release
// notes, the cases by the defect ids their documents carry) become one item per defect, with the joined cases frozen in the
// item fields and the view facts frozen in the run's groups for the counts check. The join itself is matrix.ts; both the
// summary here and the check read the same rows. A run too large is a refusal with a fix, not a cut answer.
import { buildMatrix, summaryOf } from './matrix.ts';
import { readStatuses } from './params.ts';
import { PACK, guarded, isRecord, shown, utf8Length } from './text.ts';
import type { BoundInput, IndexViewData, PackWarning, ProjectedItem, RunFacts, ViewFacts } from './types.ts';
import { readIndexView } from './views.ts';

/** The input slots (workflow.json). */
export const SLOT_DEFECTS = 'defects';
export const SLOT_CASES = 'cases';
const PARSER = 'json@1';

/**
 * Budgets under the sandbox's default limits (8 MiB out, 10,000 outcomes per check), so that a run too large is a refusal
 * with a fix: the projection's own output, and one outcome per defect at the check.
 */
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

function factsOf(view: IndexViewData): ViewFacts {
  return {
    source: view.source,
    skipped: view.skipped,
    truncated: view.truncated,
    total_keys: view.total_keys,
    total_entries: view.total_entries,
    listed_keys: Object.keys(view.keys).length,
    listed_entries: Object.keys(view.entries).length,
    missing: view.missing,
  };
}

export function projectItems(input: unknown, limits: Partial<ProjectLimits> = {}): Output {
  const budget: ProjectLimits = { ...PROJECT_LIMITS, ...limits };
  if (!isRecord(input) || !Array.isArray(input.inputs)) return refusal('invalid_input', '输入里没有 inputs 数组', '按 projection-input@1 传入绑定的视图');
  const rawParameters = isRecord(input.parameters) ? input.parameters : {};
  const parameters = readStatuses(rawParameters.statuses);
  if (parameters.ignored.length > 0) {
    return refusal('invalid_parameter', `参数 ${parameters.ignored.join('、')} 的取值无效`, 'statuses 写成 fixed 和 known 的非空列表，例如 ["fixed","known"]；不写则两个都算');
  }
  const bound = (input.inputs as unknown[]).filter(isRecord);
  const ofSlot = (slot: string) => bound.filter((b) => b.slot === slot);
  const defectsBound = ofSlot(SLOT_DEFECTS);
  const casesBound = ofSlot(SLOT_CASES);
  if (defectsBound.length !== 1 || casesBound.length !== 1) {
    return refusal('invalid_input', `需要输入槽 ${SLOT_DEFECTS} 和 ${SLOT_CASES} 各绑定一个知识索引视图`, `在 inputs.${SLOT_DEFECTS} 和 inputs.${SLOT_CASES} 里各给出一个 knowledge:index 视图`);
  }

  const defectsRead = readIndexView(defectsBound[0] as unknown as BoundInput, SLOT_DEFECTS, { kind: 'defect', key: 'bug' });
  if (!defectsRead.ok) return refusal(defectsRead.code, `输入槽 ${SLOT_DEFECTS}：${defectsRead.message}`, defectsRead.fix);
  const casesRead = readIndexView(casesBound[0] as unknown as BoundInput, SLOT_CASES, { kind: 'case', key: 'defects' });
  if (!casesRead.ok) return refusal(casesRead.code, `输入槽 ${SLOT_CASES}：${casesRead.message}`, casesRead.fix);
  const defects = defectsRead.view;
  const cases = casesRead.view;
  const warnings: PackWarning[] = [...defectsRead.warnings, ...casesRead.warnings];

  const context = isRecord(input.context) ? input.context : {};
  const runProduct = typeof context.product === 'string' ? context.product : null;
  if (defects.product !== cases.product || (runProduct !== null && defects.product !== runProduct)) {
    return refusal(
      'view_mismatch',
      `两个视图的产品不一致（缺陷索引是 ${defects.product}，用例索引是 ${cases.product}${runProduct === null ? '' : `，运行绑定的是 ${runProduct}`}）`,
      '绑定同一产品线的两个视图，并与运行绑定的产品线一致',
      warnings,
    );
  }
  if (defects.root !== cases.root) {
    return refusal(
      'view_mismatch',
      `缺陷索引和用例索引不是同一个知识根（缺陷索引是 ${defects.build} 的根，用例索引是 ${cases.build} 的根）`,
      '用同一个构建重新生成两个视图：knowledge:index:<产品>:<构建>?kind=defect&key=bug 和 kind=case&key=defects（构建的任一名称族的写法都可以）',
      warnings,
    );
  }

  const rows = buildMatrix(defects, cases, parameters.statuses);
  if (rows.some((row) => row.bug === ''&&row.identity_declaration_status!=='undeclared')) {
    return refusal('invalid_id', '缺陷索引里有空编号，不能作为条目编号', '检查缺陷索引的来源（release notes 生产器），空编号的条目需要先修正', warnings);
  }
  if (rows.length === 0) {
    return refusal(
      'no_defects',
      `构建 ${defects.build}：` + (defects.skipped > 0 ? `视图列出来源但 ${defects.skipped} 份未读；原因记录：${defects.notes.join('；') || '视图未提供逐份原因'}` : defects.missing > 0 ? `缺陷视图列出的 ${defects.missing} 个条目没有内容` : defects.truncated ? '缺陷视图被截断，当前部分没有所选状态' : defects.total_entries === 0 ? '当前缺陷视图未列出发布说明缺陷条目' : `已读 ${Object.keys(defects.entries).length} 条缺陷，所选状态 ${parameters.statuses.join('、')} 为 0 条`),
      defects.skipped > 0 || defects.missing > 0 || defects.truncated ? '请集成者按视图原有原因补齐来源或条目内容并重新生成视图；缺逐份原因时补取生产记录' : '核对当前构建、所选 statuses 和发布说明生产记录；不把当前视图的空集推断为外部原件缺席',
      warnings,
    );
  }
  if (rows.length > budget.maxItems) {
    return refusal('too_large', `这次投影出 ${rows.length} 个缺陷条目，一次运行最多 ${budget.maxItems} 个`, '分批读取：先按 statuses 缩小范围（例如只看 fixed）', warnings.slice(0, 20));
  }
  if (defects.truncated) {
    warnings.push({ code: `${PACK}.view_truncated`, message: `缺陷索引视图被截断：只有列出的 ${Object.keys(defects.keys).length} 个缺陷进入矩阵（视图声明共 ${defects.total_keys} 个）` });
  }
  if (cases.truncated) {
    warnings.push({ code: `${PACK}.view_truncated`, message: `用例索引视图被截断：只有列出的用例进入矩阵，“未追溯”的缺陷可能比结果里更多` });
  }

  const source = defects.digest;
  const items: ProjectedItem[] = rows.map((row) => ({
    id: row.identity ?? row.bug,
    label: shown(row.statement) || `缺陷 ${row.bug}`,
    summary: summaryOf(row),
    location: { slot: SLOT_DEFECTS, source, parser: PARSER, selector: `p/entries/${row.digests[0]}` },
    fields: row as unknown as Record<string, unknown>,
  }));
  const facts: RunFacts = { product: defects.product, build: defects.build, root: defects.root, statuses: parameters.statuses, views: { defects: factsOf(defects), cases: factsOf(cases) } };
  const result = { items, groups: [facts as unknown as Record<string, unknown>], warnings };
  const bytes = utf8Length(JSON.stringify(result));
  if (bytes > budget.outputBytes) {
    return refusal('too_large', `投影结果有 ${bytes} 字节（${items.length} 个条目），超过投影函数的输出上限`, '按 statuses 缩小范围后分次运行；完整矩阵仍可从运行的知识根用 get_nodes 读取', warnings.slice(0, 20));
  }
  return result;
}

export default function project(input: unknown): unknown {
  return guarded<unknown>(
    () => projectItems(input),
    (message) => refusal('internal_error', `投影函数内部出错：${message}`, '这是任务包的缺陷，请把输入交给任务包维护人'),
  );
}
