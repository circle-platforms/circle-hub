import {fixedStatusDeclaration} from './fixed-status.ts';
// Projection function for defect-to-case: turns bound defects into run items.
import type { ErrorHypothesis } from '../../../../contracts/src/common.ts';
import type {
  BoundInput,
  PackError,
  PackWarning,
  ProjectedItem,
  ProjectionInput,
  ProjectionOutput,
} from '../../../../contracts/src/pack.ts';
import { buildCompactIndex } from './compact-index.ts';
import { PACK } from './types.ts';

/**
 * The claim of a defect without fix text (D05 R[8]): the record it rests on, the missing fact and the open causes. The
 * fixed-status rule predicts that a defect not yet fixed has no original structured status fixed, so an observed fixed
 * excludes that cause; the other cause has no rule prediction and stays open.
 */
function noFixTextClaim(model: Record<string, unknown>, sha256: string, fixField: string | null, notes: number[] | null): Pick<PackError, 'grounds' | 'provenance' | 'missing' | 'hypotheses'> {
  const declared = fixedStatusDeclaration(model);
  const fields = isRecord(model.fields) ? model.fields : {};
  const raw = Object.hasOwn(fields, 'status') ? fields.status : model.status;
  const seen = typeof raw === 'string' && raw.trim() !== '' ? `“${raw}”` : '没有';
  const record = `src:${sha256}`;
  const prediction = '没修复的缺陷，原始结构状态不会声明 fixed（defect-to-case 的已修复状态规则）';
  const notFixed: ErrorHypothesis = declared.status === 'fixed'
    ? { statement: '缺陷还没有修复，所以没有修复说明', prediction, refute: [`原始结构状态声明 fixed（${record}）`], status: 'excluded' }
    : { statement: '缺陷还没有修复，所以没有修复说明', prediction, support: [`原始结构状态是 ${seen}，没有声明 fixed（${record}）`], status: 'open' };
  const configured = fixField === null && notes === null ? 'PLM 资源没有配置 settings.bug_fix_field，也没有配置 settings.bug_fix_actions' : fixField !== null ? `配置的字段 ${fixField} 在这条缺陷里没有文字` : '声明的动作码在这条缺陷里没有非空 comment';
  const elsewhere: ErrorHypothesis = { statement: '修复说明写在 Hub 没有配置读取的字段或动作里', support: [configured], status: 'open' };
  return { grounds: [record], provenance: 'projected', missing: '可以引用的修复说明', hypotheses: [notFixed, elsewhere] };
}

export const DEFECTS_SLOT = 'defects';
export const INDEXED_CASES_SLOT = 'indexed_cases';
export const MAX_DEFECTS = 20;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function projectDefects(input: unknown): ProjectionOutput {
  if (!isRecord(input) || !Array.isArray(input.inputs)) {
    return {
      error: {
        code: `${PACK}.invalid_input`,
        message: '输入不符合 projection-input@1：缺少 inputs 数组',
        fix: '请提供符合规范的运行输入',
      },
      warnings: [],
    };
  }

  const inputs = input.inputs as BoundInput[];
  const defectInputs = inputs.filter((i) => i.slot === DEFECTS_SLOT);
  if (defectInputs.length === 0) {
    return {
      error: {
        code: `${PACK}.missing_defects`,
        message: '缺少缺陷输入：slot defects 必须绑定至少 1 个缺陷（plm:bug:<id>）',
        fix: '在 start_run 的 inputs 中提供 defects 槽位绑定',
      },
      warnings: [],
    };
  }

  if (defectInputs.length > MAX_DEFECTS) {
    return {
      error: {
        code: `${PACK}.too_many_defects`,
        message: `缺陷数量超过上限：本次运行给出了 ${defectInputs.length} 个缺陷，最多支持 ${MAX_DEFECTS} 个`,
        fix: `请将缺陷拆分为每次最多 ${MAX_DEFECTS} 个分批运行`,
      },
      warnings: [],
    };
  }

  const context = isRecord(input.context) ? input.context : {};
  const line = typeof context.line === 'string' && context.line.trim() ? context.line : null;
  const manuals = inputs.filter((b) => b.slot === 'manual');
  if (manuals.length > 1 || (manuals.length === 1 && (line === null || manuals[0].external?.split('@')[0] !== `manual:cli:${line}`))) {
    const bound = manuals.map(m => m.external ?? '无外部身份的来源').join('、');
    const message = line === null ? `运行没有版本线，不能绑定版本线手册（已绑定：${bound}）` : manuals.length > 1 ? `绑定了 ${manuals.length} 份手册（${bound}），本次版本线 ${line} 最多绑定一份 manual:cli:${line}` : `绑定的手册 ${bound} 不是本次版本线 ${line} 的 manual:cli:${line}`;
    const fix = line === null ? '不绑定 manual，只引用已配置的修复说明字段；需要手册时先选择有明确版本线的构建，再重新开始运行' : `改绑 manual:cli:${line}；这条线没有手册时不绑定 manual，只引用修复说明字段；重新开始运行`;
    return { error: { code: `${PACK}.manual_mismatch`, message: `输入槽 manual：${message}`, fix }, warnings: [] };
  }
  const manual = manuals[0] ?? null;
  const warnings: PackWarning[] = [];

  const indexInput = inputs.find((i) => i.slot === INDEXED_CASES_SLOT);
  const groups: Record<string, unknown>[] = [];
  if (indexInput && isRecord(indexInput.model)) {
    // The narrowing (only=…) lives on the bound URI; the view's own output does not carry it (README Needs).
    const compact = buildCompactIndex(indexInput.model, undefined, typeof indexInput.external === 'string' ? indexInput.external : null);
    groups.push({ indexed_cases: compact });
  }

  const items: ProjectedItem[] = [];
  const seenIds = new Set<string>();

  for (const b of defectInputs) {
    const model = isRecord(b.model) ? b.model : {};
    const externalId = typeof b.external === 'string' ? b.external.replace(/^plm:bug:/, '').split('@')[0] : '';
    const id = (typeof model.id === 'string' && model.id !== '' ? model.id : String(model.id ?? '')) || externalId;

    if (!id) {
      return {
        error: {
          code: `${PACK}.missing_defect_id`,
          message: '缺陷记录中无法识别编号（id）',
          fix: '请确认绑定的缺陷对象格式正确',
        },
        warnings: [],
      };
    }

    if (seenIds.has(id)) {
      return {
        error: {
          code: `${PACK}.duplicate_defect_id`,
          message: `缺陷编号 ${id} 在同一次运行中重复提供`,
          fix: '请移除重复的缺陷绑定',
        },
        warnings: [],
      };
    }
    seenIds.add(id);

    const fixField = typeof model.fix_field === 'string' && model.fix_field.trim() !== '' ? model.fix_field : null;
    const fieldText = fixField !== null && isRecord(model.fields) && typeof model.fields[fixField] === 'string' && (model.fields[fixField] as string).trim() !== '';
    const notes = !Object.hasOwn(model, 'fix_notes') || model.fix_notes === null ? null : Array.isArray(model.fix_notes) ? model.fix_notes.flatMap((row, index) => isRecord(row) && typeof row.comment === 'string' && row.comment.trim() !== '' ? [index] : []) : null;
    if (!fieldText && !(notes !== null && notes.length > 0)) {
      // Why there is no fix text is open: the error lists the causes the pack knows with what bears on each, plus 其他
      // (V08); only the fixed-status rule gives a prediction, so only that hypothesis can be excluded (V08 R[0]).
      const claim = noFixTextClaim(model, b.sha256, fixField, notes);
      if (fixField === null) return { error: { code: `${PACK}.missing_fix_field`, message: `缺陷 ${id} 没有可引用的修复说明：content.fix_field 未配置，content.fix_notes 也没有非空 comment`, fix: '缺陷修复后再开运行（你的运行能做）；修复说明若写在别的字段或动作里，请集成者配置 PLM 资源 settings.bug_fix_field（字段名）或 settings.bug_fix_actions（动作码 JSON 字符串数组）后重读（集成者做）；不得猜字段名或动作码', ...claim }, warnings: [] };
      return { error: { code: `${PACK}.fix_text_missing`, message: `缺陷 ${id} 的修复说明字段 ${fixField} 不存在、不是文字或为空，且 fix_notes 没有非空 comment`, fix: notes === null ? '缺陷修复后再开运行（你的运行能做）；字段配错时请集成者核对 PLM 资源 settings.bug_fix_field，或配置 settings.bug_fix_actions 后重读（集成者做）；不进入运行或消耗修复轮' : '该缺陷的配置字段为空，且声明的动作码没有非空 comment；缺陷修复后再开运行，或换有修复说明的缺陷；不进入运行或消耗修复轮', ...claim }, warnings: [] };
    }
    const quotable = [fieldText ? `修复说明字段 ${fixField}` : '', notes !== null && notes.length > 0 ? 'fix_notes 中的 comment' : ''].filter(Boolean).join('，或');
    if (manual === null) warnings.push({ code: `${PACK}.manual_missing`, item: id, message: `版本线 ${line ?? '未确定'} 没有绑定手册 manual:cli:${line ?? '<版本线>'}：本次期望结果只能引用缺陷 ${id} 的${quotable}；自动先核实该版本线的手册是否可读，存在时在 inputs.manual 绑定后重开运行，不存在则保留本条来源限制` });
    const title = typeof model.title === 'string' && model.title.trim() !== '' ? model.title.trim() : (b.meta && typeof b.meta.title === 'string' ? b.meta.title : `缺陷 ${id}`);
    const status = (isRecord(model.fields) && typeof model.fields.status === 'string' ? model.fields.status : (b.meta && typeof b.meta.status === 'string' ? b.meta.status : '未知'));

    // PLM has already converted HTML values to plain text in fields; html_fields lists their names.
    const htmlFields = Array.isArray(model.html_fields) ? model.html_fields.filter((name): name is string => typeof name === 'string') : [];

    const summaryText = `缺陷 ${id} · ${status} · 起草 0 个用例${manual === null ? '；未绑定手册，仅修复字段可引' : ''}`;
    const summary = summaryText.length > 200 ? `${summaryText.slice(0, 197)}...` : summaryText;
    const selector = isRecord(model) && Object.hasOwn(model, id)
      ? `p/${id}`
      : (isRecord(model) && Object.hasOwn(model, 'id') ? 'p/id' : 'p');

    items.push({
      id,
      label: title.length > 200 ? `${title.slice(0, 197)}...` : title,
      summary,
      location: {
        slot: DEFECTS_SLOT,
        ...(typeof b.sha256 === 'string' ? { source: b.sha256 } : {}),
        parser: 'json@1',
        selector,
      },
      fields: {
        id,
        title,
        status,
        fixed_status:fixedStatusDeclaration(model),
        allowed_quote_sources: { defect: b.sha256, fix_field: fixField, fix_notes: notes, manual: manual?.sha256 ?? null },
        fields: isRecord(model.fields) ? model.fields : {},
        html_fields: htmlFields,
      },
    });
  }

  return {
    items,
    ...(groups.length > 0 ? { groups } : {}),
    warnings,
  };
}

export default function (input: unknown): unknown {
  return projectDefects(input);
}
