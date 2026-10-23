// The case-compile projection (pack function, ProjectionInput -> ProjectionOutput): read the reviewed case document
// (kityminder@1), the compile contract (doc:doc:<name>, compile-contract@1) and the bed inventory (doc:doc:<name>,
// test-bed-manifest@1); one item per case taken by the case-review rule (tags or marks, case_rule narrows to tags).
// The raw contract and manifest documents, the frozen lease view and the extraction summary are frozen into the run
// group so every check recomputes from them. An invalid contract or manifest refuses the whole call with every
// problem and its pointer.
import { isRecord, refusal, type PackWarning } from './text.ts';
import { parseContract, type Contract } from './contract.ts';
import { parseManifest, type ManifestBed } from './manifest.ts';
import { documentIdOf, extractCases, type CaseRule } from './cases.ts';

interface Slot {
  slot: string;
  external?: string | null;
  sha256?: string;
  parser?: string | null;
  model: unknown;
}

interface FrozenLeases {
  now: string;
  entries: Array<{ key: string; until: string; mine?: boolean }>;
}

interface Out {
  items: Array<{ id: string; label: string; summary: string; location: { slot: string; source: string; parser: string; selector: string }; fields: Record<string, unknown> }>;
  groups?: Array<Record<string, unknown>>;
  warnings: PackWarning[];
}

const MAX_TITLE = 200;

function slotOf(inputs: unknown[], name: string): Slot | undefined {
  return (inputs as Slot[]).find((candidate) => isRecord(candidate) && candidate.slot === name);
}

function problemWarnings(prefix: string, problems: Array<{ pointer: string; message: string; fix: string }>): PackWarning[] {
  return problems.slice(0, 100).map((problem) => ({ code: prefix, message: `${problem.pointer === '' ? '整份' : problem.pointer}：${problem.message}（处理：${problem.fix}）` }));
}

export function projectItems(input: unknown): unknown {
  const params = isRecord(input) ? input : {};
  const inputs = Array.isArray(params.inputs) ? params.inputs : [];
  const subject = slotOf(inputs, 'subject');
  if (subject === undefined || subject.model === null || subject.model === undefined) {
    return refusal('no_subject', '没有用例文档', '在 inputs.subject 里绑定评审过的用例脑图（agile:mindmap 或 application/json）');
  }
  if (subject.parser !== 'kityminder@1') return refusal('subject_not_mindmap', '用例文档不是 kityminder@1 解析的脑图', '绑定敏捷平台导出的 KityMinder 脑图');
  const contractSlot = slotOf(inputs, 'contract');
  if (contractSlot === undefined || contractSlot.model === null || contractSlot.model === undefined) {
    return refusal('no_contract', '没有编译合约', '在 inputs.contract 里写命名文档 {"external": "doc:doc:compile-contract"}（管理员用 circle-hub doc put 发布）');
  }
  const contractRead = parseContract(contractSlot.model);
  if (!contractRead.ok) {
    const first = contractRead.problems[0];
    return refusal(
      'contract_invalid',
      `编译合约有 ${contractRead.problems.length} 个问题，整份拒绝`,
      first === undefined ? '按合约的形状（compile-contract@1）改正后重新发布' : `${first.pointer === '' ? '整份' : first.pointer}：${first.fix}`,
      problemWarnings('case-compile.contract_problem', contractRead.problems),
    );
  }
  const inventorySlot = slotOf(inputs, 'inventory');
  if (inventorySlot === undefined || inventorySlot.model === null || inventorySlot.model === undefined) {
    return refusal('no_inventory', '没有台架清单', '在 inputs.inventory 里写命名文档 {"external": "doc:doc:bed-topology"}（管理员用 circle-hub doc put 发布）');
  }
  const manifestRead = parseManifest(inventorySlot.model);
  if (!manifestRead.ok) {
    const first = manifestRead.problems[0];
    return refusal(
      'manifest_invalid',
      `台架清单有 ${manifestRead.problems.length} 个问题，整份拒绝`,
      first === undefined ? '按清单的形状（test-bed-manifest@1）改正后重新发布' : `${first.pointer === '' ? '整份' : first.pointer}：${first.fix}`,
      problemWarnings('case-compile.manifest_problem', manifestRead.problems),
    );
  }
  const parameters = isRecord(params.parameters) ? params.parameters : {};
  if (parameters.case_rule !== undefined && parameters.case_rule !== 'tagged' && parameters.case_rule !== 'marked') {
    return refusal('invalid_parameter', `case_rule 的取值 ${String(parameters.case_rule)} 无效`, 'case_rule 写 tagged 或 marked（默认 marked）');
  }
  const rule: CaseRule = parameters.case_rule === 'tagged' ? 'tagged' : 'marked';
  const extraction = extractCases(subject.model, rule);
  const model = isRecord(subject.model) ? subject.model : {};
  const documentId = documentIdOf(typeof subject.external === 'string' ? subject.external : null, isRecord(model.meta) ? model.meta : null, extraction.cases[0]?.id ?? null);
  const warnings: PackWarning[] = [];
  if (extraction.cases.length === 0) warnings.push({ code: 'case-compile.no_cases', message: `文档 ${documentId} 里按规则取不到用例（${extraction.ruleSummary}）` });
  if (extraction.candidates > 0) warnings.push({ code: 'case-compile.candidate_only', message: `${extraction.candidates} 个节点只靠标记识别，case_rule 为 tagged 时不是用例（要取用请加标签，或改用默认规则）` });
  const context = isRecord(params.context) ? params.context : {};
  const frozenLeases = isRecord(context.leases) ? (context.leases as unknown as FrozenLeases) : { now: new Date(0).toISOString(), entries: [] };
  const sha256 = typeof subject.sha256 === 'string' ? subject.sha256 : '';
  const items = extraction.cases.map((found) => ({
    id: `${documentId}:${found.id}`,
    label: found.title.slice(0, MAX_TITLE),
    summary: `${found.steps.length} 步；${found.expected.length + found.steps.reduce((n, step) => n + step.expected.length, 0)} 个期望结果${found.negative ? '；反向用例' : ''}`,
    location: { slot: 'subject', source: sha256, parser: 'kityminder@1', selector: found.selector ?? '' },
    fields: {
      title: found.title,
      tags: found.tags,
      priority: found.priority,
      negative: found.negative,
      steps: found.steps,
      expected: found.expected,
      case_rule: rule,
      marked_only: extraction.markedOnly,
    },
  }));
  const message = `文档 ${documentId} 取出 ${items.length} 个用例（${extraction.ruleSummary}）。按合约和台架清单核对每个用例的执行计划：合约是合成的时结论写“按合成合约核对”，所有结论写“不证明在真实设备上跑得通”。`;
  return {
    items,
    groups: [
      {
        kind: 'case-compile',
        contract: contractSlot.model,
        manifest: inventorySlot.model,
        leases: { now: typeof frozenLeases.now === 'string' ? frozenLeases.now : new Date(0).toISOString(), entries: Array.isArray(frozenLeases.entries) ? frozenLeases.entries : [] },
        case_rule: rule,
        marked_only: extraction.markedOnly,
        rule_summary: extraction.ruleSummary,
        message,
      },
    ],
    warnings,
  };
}

export default function project(input: unknown): unknown {
  try {
    return projectItems(input);
  } catch (error) {
    return refusal('internal_error', `投影函数内部出错：${error instanceof Error ? error.message : String(error)}`, '这是任务包的缺陷，请把输入交给任务包维护人');
  }
}
