// Item projection (W01): the impact view bound to slot `impact` becomes one item per case in the later build that sits
// on an added or modified path. Zero items is an empty scope and says so: since the engine accepts an empty item set
// (W01 R[3] as clarified), the run starts with an empty result. A scope that would not fit the sandbox's output budget
// is a clean refusal (too_large), never a sandbox memory failure.

import { scopeOf, readParameters, type ScopeItem } from './scope.ts';
import { PACK, guarded, isRecord } from './text.ts';
import { parseView } from './view.ts';
import { FacetsError, readFacets, unplacedMessage, FACETS_FIX } from './facets.ts';

export const SLOT = 'impact';
const BEHAVIOUR_SLOT = 'behaviour';
const PARSER = 'json@1';

/** Budgets under the sandbox's defaults (8 MiB out): an item costs about 1.4 KB of output with its citations, so 4,000
 * items stay under 6 MiB. */
export interface ProjectLimits {
  maxItems: number;
  outputBytes: number;
}
export const LIMITS: ProjectLimits = { maxItems: 4000, outputBytes: 6 * 1024 * 1024 };

interface Warning {
  code: string;
  message: string;
}

function refusal(code: string, message: string, fix: string, warnings: Warning[] = []): { error: { code: string; message: string; fix: string }; warnings: Warning[] } {
  return { error: { code: `${PACK}.${code}`, message, fix }, warnings };
}

function itemOf(item: ScopeItem, sha256: string) {
  return {
    id: item.id,
    label: item.label,
    summary: item.summary,
    location: { slot: SLOT, source: sha256, parser: PARSER, selector: `p/entries/${item.entry}` },
    fields: {
      document: item.document,
      node: item.node,
      priority: item.priority,
      negative: item.negative,
      reasons: item.reasons,
    },
  };
}

export function projectItems(input: unknown, limits: Partial<ProjectLimits> = {}): unknown {
  if (!isRecord(input) || !Array.isArray(input.inputs)) return refusal('invalid_input', '输入里没有 inputs 数组', '按 projection-input@1 传入绑定的源文件');
  const { parameters, ignored } = readParameters(input.parameters);
  if (ignored.length > 0) {
    return refusal('invalid_parameter', `参数 ${ignored.join('、')} 的取值无效`, 'priorities 是数字列表；include_added 是布尔值。改正后重新开始运行');
  }
  const bound = (input.inputs as unknown[]).filter((raw) => isRecord(raw) && raw.slot === SLOT);
  if (bound.length === 0) return refusal('no_impact', `输入槽 ${SLOT} 里没有影响视图`, '在 inputs.impact 里绑定 knowledge:impact:<产品>:<起始构建>..<目标构建>');
  if (bound.length > 1) return refusal('no_impact', `输入槽 ${SLOT} 只接受一个影响视图，给了 ${bound.length} 个`, '只绑定一个影响视图');
  const source = bound[0] as { [key: string]: unknown };
  const sha256 = source.sha256;
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) return refusal('invalid_input', '影响视图没有源文件摘要', '按 projection-input@1 传入绑定的源文件');
  const parsed = parseView(source.model);
  if (!parsed.ok) return refusal('not_a_view', parsed.message, '绑定知识库的影响视图（impact-view@1），附着种类为用例');
  // The scope counts only command-definition changes (decision 11): the bound view must have been asked for
  // changed=definition, so behaviour rows never widen it. A view that also counts behaviour refuses the run.
  if (parsed.view.changedKinds.length !== 1 || parsed.view.changedKinds[0] !== 'definition') {
    return refusal(
      'changed_kinds',
      `影响视图按 ${parsed.view.changedKinds.join('、')} 算变更，回归范围只按命令定义（definition）的变化算`,
      `视图引用写成 knowledge:impact:<产品>:<起始构建>..<目标构建>?changed=definition&attached=case&attached_fields=document,node,title,priority,negative&catalog=commands@1（带上 changed=definition 和目录）`,
    );
  }
  // The view must be filtered to the command catalog (decision 11): without it the change count is by entry kind alone
  // and members of other producers on the same paths would widen the scope. Refuse instead of hinting.
  if (parsed.view.catalog !== 'commands@1') {
    return refusal(
      'catalog',
      `影响视图没有限定到命令目录 catalog=commands@1${parsed.view.catalog === null ? '' : `，带的是 ${parsed.view.catalog}`}，只按条目种类比会混进其他生产器在同一路径上的同类条目`,
      '视图引用写成 knowledge:impact:<产品>:<起始构建>..<目标构建>?changed=definition&attached=case&attached_fields=document,node,title,priority,negative&catalog=commands@1（带上 catalog=commands@1）',
    );
  }
  // The behaviour view of the same pair of builds (optional): never in the scope, only a clue paragraph.
  const clue = behaviourClue(input, parsed.view);
  if (typeof clue === 'string') return refusal('behaviour_view', clue, 'behaviour 槽绑定同一对构建的 changed=behaviour 视图，或不绑定');
  let facets;try{facets=readFacets({ inputs: input.inputs }, parsed.view);}catch(error){if(error instanceof FacetsError)return refusal('facets_view',error.message,error.fix);throw error;}
  const scope = scopeOf(parsed.view, parameters);
  // The run note also names the view itself: the command-diff summary of the check cites it as its ground.
  const note = { ...scope.note, view: `src:${sha256}`, unplaced: facets.unplaced, unplaced_build: facets.build, message: `${scope.note.message} ${unplacedMessage(facets)}` };
  const budget = { ...LIMITS, ...limits };
  if (scope.items.length > budget.maxItems) {
    return refusal('too_large', `范围内有 ${scope.items.length} 条用例，一次运行最多 ${budget.maxItems} 条`, '范围只按命令定义的变化算：先看定义变化是否已经把范围缩小，再用 priorities 参数收窄（例如先只看优先级 1 的），按优先级分几次运行', scope.warnings.slice(0, 20));
  }
  const out = {
    items: scope.items.map((item) => itemOf(item, sha256)),
    groups: [note, ...(clue !== null ? [clue] : [])],
    warnings: scope.warnings.slice(0, 100),
  };
  const bytes = Buffer.byteLength(JSON.stringify(out), 'utf8');
  if (bytes > budget.outputBytes) {
    return refusal('too_large', `投影结果有 ${bytes} 字节（${scope.items.length} 条用例），超过投影函数的输出上限`, '用 priorities 参数收窄范围（例如先只看优先级 1 的），再按优先级分几次运行', scope.warnings.slice(0, 20));
  }
  return out;
}

export default function project(input: unknown): unknown {
  return guarded(
    () => projectItems(input),
    (message) => refusal('internal_error', `投影函数内部出错：${message}`, '这是任务包的缺陷，请把输入交给任务包维护人'),
  );
}


const MAX_CLUE_PATHS = 5;

/** The clue paragraph from the optional behaviour view: 手册说明有变化的命令 N 条（只作线索，不算进范围）, at most
 * 5 paths named, then 另有 M 条. A string return is a refusal (the slot held something unusable). */
function behaviourClue(input: { inputs?: unknown[] }, scope: { fromBuild: string; toBuild: string }): { kind: string; message: string } | null | string {
  const raws = ((input.inputs ?? []) as unknown[]).filter((raw) => isRecord(raw) && raw.slot === BEHAVIOUR_SLOT);
  if (raws.length === 0) return null;
  if (raws.length > 1) return `behaviour 槽只接受一个影响视图，给了 ${raws.length} 个`;
  const parsed = parseView((raws[0] as { model?: unknown }).model);
  if (!parsed.ok) return `behaviour 槽绑定的不是影响视图：${parsed.message}`;
  const view = parsed.view;
  if (view.changedKinds.length !== 1 || view.changedKinds[0] !== 'behaviour') return `behaviour 槽要绑 changed=behaviour 的视图（按 ${view.changedKinds.join('、')} 算变更不对）`;
  if (view.fromBuild !== scope.fromBuild || view.toBuild !== scope.toBuild) return 'behaviour 槽要绑同一对构建（起始和目标与 impact 相同）';
  const paths = view.changes.filter((change) => change.change !== 'removed').map((change) => change.path);
  const shown = paths.slice(0, MAX_CLUE_PATHS);
  const rest = paths.length - shown.length;
  const listed = shown.join('、');
  const message = `手册说明有变化的命令 ${paths.length} 条（只作线索，不算进范围）${shown.length > 0 ? `：${listed}` : ''}${rest > 0 ? `；另有 ${rest} 条` : ''}`;
  return { kind: 'behaviour-clue', message };
}
