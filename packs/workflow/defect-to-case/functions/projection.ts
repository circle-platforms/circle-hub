// Projection function for defect-to-case: turns bound defects into run items.
import type {
  BoundInput,
  ProjectedItem,
  ProjectionInput,
  ProjectionOutput,
} from '../../../../contracts/src/pack.ts';
import { buildCompactIndex } from './compact-index.ts';
import { PACK } from './types.ts';

export const DEFECTS_SLOT = 'defects';
export const INDEXED_CASES_SLOT = 'indexed_cases';
export const MAX_DEFECTS = 20;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
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
  const line = typeof context.line === 'string' ? context.line : null;
  const manuals = inputs.filter((b) => b.slot === 'manual');
  if (manuals.length !== 1 || line === null || manuals[0].external?.split('@')[0] !== `manual:cli:${line}`) {
    return { error: { code: `${PACK}.manual_mismatch`, message: '缺少本次版本线的唯一手册输入', fix: `在 inputs.manual 绑定 manual:cli:${line ?? '<运行版本线>'}，不要绑定其他版本线或上传来源；重新开始运行` }, warnings: [] };
  }
  const manual = manuals[0];

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
    if (fixField === null) return { error: { code: `${PACK}.missing_fix_field`, message: '缺少设置 settings.bug_fix_field：缺陷内容没有 fix_field', fix: '请集成者在 PLM 资源中配置 settings.bug_fix_field，并让 PLM 系统包在缺陷 content 回传 fix_field；自动重新读取缺陷后重试，不得猜字段名' }, warnings: [] };

    const title = typeof model.title === 'string' && model.title.trim() !== '' ? model.title.trim() : (b.meta && typeof b.meta.title === 'string' ? b.meta.title : `缺陷 ${id}`);
    const status = (isRecord(model.fields) && typeof model.fields.status === 'string' ? model.fields.status : (b.meta && typeof b.meta.status === 'string' ? b.meta.status : '未知'));

    // Convert HTML fields to plain text
    const plainHtmlFields: Record<string, string> = {};
    if (isRecord(model.html_fields)) {
      for (const [k, v] of Object.entries(model.html_fields)) {
        if (typeof v === 'string') plainHtmlFields[k] = stripHtml(v);
      }
    }

    const summaryText = `缺陷 ${id} · ${status} · 起草 0 个用例`;
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
        allowed_quote_sources: { defect: b.sha256, fix_field: fixField, manual: manual.sha256 },
        fields: isRecord(model.fields) ? model.fields : {},
        html_fields: plainHtmlFields,
      },
    });
  }

  return {
    items,
    ...(groups.length > 0 ? { groups } : {}),
    warnings: [],
  };
}

export default function (input: unknown): unknown {
  return projectDefects(input);
}
