// Item projection (W01): the impact view bound to slot `impact` becomes one item per case of the earlier build that
// needs maintenance. Zero items is a clean pair and says so. The run engine refuses that projection (W01 R[3]); this
// function still returns it, and does not invent an item.

import { readParameters, sweepOf, type SweepItem } from './sweep.ts';
import { PACK, guarded, isRecord } from './text.ts';
import { parseView } from './view.ts';

export const SLOT = 'impact';
const PARSER = 'json@1';

interface Warning {
  code: string;
  message: string;
}

function refusal(code: string, message: string, fix: string, warnings: Warning[] = []): { error: { code: string; message: string; fix: string }; warnings: Warning[] } {
  return { error: { code: `${PACK}.${code}`, message, fix }, warnings };
}

function itemOf(item: SweepItem, sha256: string) {
  return {
    id: item.id,
    label: item.label,
    summary: item.summary,
    location: { slot: SLOT, source: sha256, parser: PARSER, selector: `p/entries/${item.entry}` },
    fields: {
      document: item.document,
      node: item.node,
      title: item.title,
      priority: item.priority,
      negative: item.negative,
      reasons: item.reasons,
    },
  };
}

export function projectItems(input: unknown): unknown {
  if (!isRecord(input) || !Array.isArray(input.inputs)) return refusal('invalid_input', '输入里没有 inputs 数组', '按 projection-input@1 传入绑定的源文件');
  const { parameters, ignored } = readParameters(input.parameters);
  if (ignored.length > 0) {
    return refusal('invalid_parameter', `参数 ${ignored.join('、')} 的取值无效`, 'ignore_fields 是字符串列表，每项 1 到 80 个字符，最多 40 项。改正后重新开始运行');
  }
  const bound = (input.inputs as unknown[]).filter((raw) => isRecord(raw) && raw.slot === SLOT);
  if (bound.length === 0) return refusal('no_impact', `输入槽 ${SLOT} 里没有影响视图`, '在 inputs.impact 里绑定 knowledge:impact:<产品>:<起始构建>..<目标构建>');
  if (bound.length > 1) return refusal('no_impact', `输入槽 ${SLOT} 只接受一个影响视图，给了 ${bound.length} 个`, '只绑定一个影响视图');
  const source = bound[0] as { [key: string]: unknown };
  const sha256 = source.sha256;
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) return refusal('invalid_input', '影响视图没有源文件摘要', '按 projection-input@1 传入绑定的源文件');
  const parsed = parseView(source.model);
  if (!parsed.ok) return refusal('not_a_view', parsed.message, '绑定知识库的影响视图（impact-view@1），附着种类为用例');
  const sweep = sweepOf(parsed.view, parameters);
  return {
    items: sweep.items.map((item) => itemOf(item, sha256)),
    groups: [sweep.note],
    warnings: sweep.warnings.slice(0, 100),
  };
}

export default function project(input: unknown): unknown {
  return guarded(
    () => projectItems(input),
    (message) => refusal('internal_error', `投影函数内部出错：${message}`, '这是任务包的缺陷，请把输入交给任务包维护人'),
  );
}
