import { isDeclarationStatus, labelOf } from './generated/vocabulary.ts';
// Reading a bound input as the facet view the board needs: facet-view@1, kind case, by covering line, module, has_expected,
// vague_expected, negative (the caller may add more, e.g. priority). The model is authoritative; the external id is not
// re-parsed. A view that is not this one, or is malformed, is a refusal the caller can fix.
import { isRecord, strings } from './text.ts';
import type { BoundInput, FacetRow, FacetViewData, Scalar } from './types.ts';

const COMMANDLESS_CASES = labelOf('knowledge_count', 'commandless_cases');
const HEX = /^[0-9a-f]{64}$/;

/** The by fields the board's metrics are defined over. */
export const REQUIRED_BY = ['line', 'module', 'has_expected', 'negative', 'test_type_status'];

export type ViewFailure = { ok: false; code: string; message: string; fix: string };
export type ViewRead = { ok: true; view: FacetViewData } | ViewFailure;

const isScalar = (value: unknown): value is Scalar =>
  value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));

export function readFacetView(input: BoundInput, slot: string, requiredBy: readonly string[] = REQUIRED_BY): ViewRead {
  const fix = `在输入槽 ${slot} 绑定 knowledge:facets:<产品>:<构建>?kind=case&by=${requiredBy.join(',')}，计数、标签和${COMMANDLESS_CASES}视图必须同产品同知识根；facets 只收一个计数视图和可选的一个标签视图`;

  const failure = (message: string): ViewFailure => ({ ok: false, code: 'wrong_view', message, fix });
  const model: unknown = isRecord(input) ? input.model : undefined;
  if (!isRecord(model)) return failure('绑定的源不是 JSON 对象');
  if (model.schema !== 'facet-view@1') return failure(`绑定的视图不是 facet-view@1（schema 是 ${typeof model.schema === 'string' ? model.schema : '（无）'}）`);
  if (model.kind !== 'case') return failure(`绑定的是 kind=${typeof model.kind === 'string' ? model.kind : '（无）'} 的计数视图，这个槽要 kind=case`);
  const by = strings(model.by);
  if (!Array.isArray(model.by) || by.length !== model.by.length || by.length < 1 || by.length > 6 || new Set(by).size !== by.length) {
    return failure('视图的 by 不是 1 到 6 个不重复的数据字段名');
  }
  const missing = requiredBy.filter((field) => !by.includes(field));
  if (missing.length > 0) return failure(`视图的 by 没有 ${missing.join('、')}（by 要覆盖 ${requiredBy.join('、')}）`);
  if (typeof model.product !== 'string' || model.product === '') return failure('视图没有产品');
  const buildRaw = model.build;
  if (!isRecord(buildRaw)) return failure('视图没有有效的构建名或知识根');
  const buildName = buildRaw.build;
  const buildRoot = buildRaw.root;
  if (typeof buildName !== 'string' || buildName === '' || typeof buildRoot !== 'string' || !HEX.test(buildRoot)) {
    return failure('视图没有有效的构建名或知识根');
  }
  if (!Array.isArray(model.rows)) return failure('视图的 rows 不是数组');
  const rows: FacetRow[] = [];
  for (const [k, raw] of model.rows.entries()) {
    if (!isRecord(raw) || !isRecord(raw.values) || !Number.isInteger(raw.count) || (raw.count as number) < 1) {
      return failure(`视图的第 ${k + 1} 行不是“取值组合加正整数计数”`);
    }
    const values = raw.values;
    if (!requiredBy.every((field) => field in values)) return failure(`视图的第 ${k + 1} 行缺少分组字段`);
    if (!Object.values(raw.values).every(isScalar)) return failure(`视图的第 ${k + 1} 行有非标量的取值`);
    if (requiredBy.includes('tags') && !(raw.values.tags === null || typeof raw.values.tags === 'string')) return failure('标签取值必须为文字或空');
    if(requiredBy.includes('test_type_status')&&(!isDeclarationStatus(values.test_type_status)||(values.test_type_status==='declared'?typeof values.negative!=='boolean':values.negative!==null)))return failure('测试类型声明状态与负向值不一致；用新版本 FAMX 包重产根后重读');
    if(requiredBy.includes('tag_valid')&&(typeof values.tag_valid!=='boolean'||typeof values.resource_empty!=='boolean'))return failure('标签视图缺少有效性与空资源字段；用新版本 FAMX 包重产根后重读');
    rows.push({ values: raw.values as Record<string, Scalar>, count: raw.count as number });
  }
  if (!Number.isInteger(model.total) || (model.total as number) < 0) return failure('视图的 total 不是非负整数');
  if (typeof model.truncated !== 'boolean') return failure('视图的 truncated 不是布尔值');
  if (!Number.isInteger(model.skipped) || (model.skipped as number) < 0) return failure('视图的 skipped 不是非负整数');
  const digest = input.sha256;
  if (typeof digest !== 'string' || !HEX.test(digest)) return failure('绑定的输入没有有效的源文件摘要');
  return {
    ok: true,
    view: {
      product: model.product,
      build: buildName,
      root: buildRoot,
      kind: 'case',
      by,
      rows,
      total: model.total as number,
      truncated: model.truncated,
      skipped: model.skipped as number,
      notes: strings(model.notes),
      digest,
      source: `src:${digest}`,
    },
  };
}
