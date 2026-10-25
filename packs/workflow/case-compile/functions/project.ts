// Project exactly one authored case and freeze the original runner contract, profile, manifest and lease view.
// Every check recomputes from these inputs; malformed documents refuse the whole run with all problem pointers.
import { isRecord, refusal, type PackWarning } from './text.ts';
import { parseRuntimeContract } from './runtime-contract.ts';
import { parseProfile } from './profile.ts';
import { parseManifest } from './manifest.ts';
import WORKBOOK_FORMAT from '../tables/workbook-format.json' with { type: 'json' };
import { readWorkbookModel } from './xlsx-model.ts';
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
  entries: Array<{ key: string; until: string | null; mine?: boolean }>;
}

const MAX_TITLE = 200;

function slotOf(inputs: unknown[], name: string): Slot | undefined {
  return (inputs as Slot[]).find((candidate) => isRecord(candidate) && candidate.slot === name);
}

function problemWarnings(prefix: string, problems: Array<{ pointer: string; message: string; fix: string }>): PackWarning[] {
  return problems.map((problem) => ({ code: prefix, message: `${problem.pointer === '' ? '整份' : problem.pointer}：${problem.message}（处理：${problem.fix}）` }));
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
    return refusal('no_contract', '没有运行器原格式合约', '在 inputs.contract 绑定管理员发布的原格式合约命名文档');
  }
  const contractRead = parseRuntimeContract(contractSlot.model);
  if (!contractRead.ok) {
    const first = contractRead.problems[0];
    return refusal(
      'contract_invalid',
      `运行器合约有 ${contractRead.problems.length} 个问题，整份拒绝`,
      first === undefined ? '按合约的运行器原格式改正后重新发布' : `${first.pointer === '' ? '整份' : first.pointer}：${first.fix}`,
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
  const profileSlot = slotOf(inputs, 'profile');
  if (!profileSlot || profileSlot.model == null) return refusal('no_profile', '没有运行环境配置', '在 inputs.profile 绑定发布的 runtime-profile@1 命名文档');
  const profileRead = parseProfile(profileSlot.model, contractRead.contract, manifestRead.beds);
  if (!profileRead.ok) return refusal('profile_invalid', profileRead.problems.find(problem=>problem.capacityExceeded)?.message??`运行环境配置有 ${profileRead.problems.length} 个问题，整份拒绝`, `${profileRead.problems[0].pointer}：${profileRead.problems[0].fix}`, problemWarnings('case-compile.profile_problem', profileRead.problems));
  const parameters = isRecord(params.parameters) ? params.parameters : {};
  if (parameters.case_rule !== undefined && parameters.case_rule !== 'tagged' && parameters.case_rule !== 'marked') {
    return refusal('invalid_parameter', `case_rule 的取值 ${String(parameters.case_rule)} 无效`, 'case_rule 写 tagged 或 marked（默认 marked）');
  }
  const workbook = slotOf(inputs, 'workbook');
  if (workbook) {
    if (workbook.parser !== 'xlsx@1' || typeof workbook.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(workbook.sha256) || !readWorkbookModel(workbook.model)) return refusal('workbook_input', '工作簿不是完整的 xlsx@1 绑定原件', '上传原始 xlsx，按 upload_file 返回的 src: 引用绑定，不上传自行转换的 JSON');
    if (Buffer.byteLength(JSON.stringify(workbook.model), 'utf8') > WORKBOOK_FORMAT.max_model_bytes) return refusal('workbook_input', '单用例工作簿模型超过核验预算', '减少同一个用例内的非必要内容后重新生成，不能截断模型或拆掉要执行的行');
    if (typeof parameters.plan_run !== 'string' || !/^run_[a-z0-9]+$/.test(parameters.plan_run)) return refusal('workbook_context', '缺少已满足的计划运行号 plan_run', '从已满足提交及结果复制计划运行号，以其为 predecessor 开新运行并绑定原工作簿');
  }
  const rule: CaseRule = parameters.case_rule === 'tagged' ? 'tagged' : 'marked';
  const extraction = extractCases(subject.model, rule,true);
  if (extraction.impreciseAutoids.length) return refusal('autoid_imprecise', `文档有 ${extraction.impreciseAutoids.length} 个 autoid 数值超出安全范围，JSON 解析后无法保证原编号精度`, `把原文节点 ${extraction.impreciseAutoids[0].selector ?? extraction.impreciseAutoids[0].node} 的 autoid 以文本重新导出或重新上传；不能从已舍入数值猜原编号`, extraction.impreciseAutoids.map((value) => ({ code: 'case-compile.autoid_problem', message: `${value.pointer}（节点 ${value.selector ?? value.node}）：数值精度无法保证；从原件以文本重导出或请求核心无损数字解析，不复制当前数值` })));
  if (typeof parameters.autoid !== 'string' || !new RegExp(profileRead.profile.workbook.autoid_pattern, 'u').test(parameters.autoid)) return refusal('autoid_invalid', 'autoid 必须是符合配置形状的原始文字', '从用例原文复制完整 autoid 字符串，不能转为数字，改正后重新开始运行');
  const selected = extraction.cases.filter((found) => found.autoid === parameters.autoid);
  if (selected.length === 0) return refusal('autoid_not_found', '指定 autoid 在按规则抽取的用例里找不到', '核对用例文档和 case_rule，取得该用例原始 autoid 文字后重新开始运行');
  if (selected.length > 1) return refusal('autoid_ambiguous', '指定 autoid 在用例文档里重复，无法确定一个用例', '作者修正重复编号并重新上传文档，再开始新运行');
  const model = isRecord(subject.model) ? subject.model : {};
  const documentId = documentIdOf(typeof subject.external === 'string' ? subject.external : null, isRecord(model.meta) ? model.meta : null, extraction.cases[0]?.id ?? null);
  const warnings: PackWarning[] = [];
  if (extraction.cases.length === 0) warnings.push({ code: 'case-compile.no_cases', message: `文档 ${documentId} 里按规则取不到用例（${extraction.ruleSummary}）` });
  if (extraction.candidates > 0) warnings.push({ code: 'case-compile.candidate_only', message: `${extraction.candidates} 个节点只靠标记识别，case_rule 为 tagged 时不是用例（要取用请加标签，或改用默认规则）` });
  const context = isRecord(params.context) ? params.context : {};
  const frozenLeases = isRecord(context.leases) ? (context.leases as unknown as FrozenLeases) : { now: new Date(0).toISOString(), entries: [] };
  const sha256 = typeof subject.sha256 === 'string' ? subject.sha256 : '';
  const items = selected.map((found) => ({
    id: `${documentId}:${found.id}`,
    label: found.title.slice(0, MAX_TITLE),
    summary: `${found.steps.length} 步；${found.expected.length + found.steps.reduce((n, step) => n + step.expected.length, 0)} 个期望结果${found.negative ? '；反向用例' : ''}`,
    location: { slot: 'subject', source: sha256, parser: 'kityminder@1', selector: found.selector ?? '' },
    fields: {
      command_identities:(()=>{const source=slotOf(inputs,'case_index'),context=isRecord(params.context)?params.context:{};const view=source?.model;
        if(!source)return undefined;if(source.parser!=='json@1'||!isRecord(view)||view.schema!=='index-view@1'||view.kind!=='case'||!isRecord(view.build)||view.build.root!==context.root||!isRecord(view.entries))return null;
        const rows=Object.values(view.entries).filter(row=>isRecord(row)&&isRecord(row.data)&&row.data.document===documentId&&row.data.node===found.id);
        if(!rows.length||rows.every(row=>isRecord(row)&&isRecord(row.data)&&!Object.hasOwn(row.data,'command_identities')))return undefined;if(rows.some(row=>!isRecord(row)||!isRecord(row.data)||!Array.isArray(row.data.command_identities)))return null;
        return [...new Map(rows.flatMap(row=>(row as {data:{command_identities:unknown[]}}).data.command_identities).map(identity=>[JSON.stringify(identity),identity])).values()];
      })(),
      expected_nodes:found.expected_nodes?.every(node=>node.selector!==null)?found.expected_nodes.map(node=>({reference:`src:${sha256}/kityminder@1/${node.selector}`,text:node.text})):undefined,
      title: found.title,
      tags: found.tags,
      priority: found.priority,
      autoid: found.autoid,
      auto: found.auto,
      negative: found.negative,
      steps: found.steps,
      expected: found.expected,
      case_rule: rule,
      marked_only: extraction.markedOnly,
    },
  }));
  const message = `文档 ${documentId} 选出 ${items.length} 个用例（${extraction.ruleSummary}）。配置声明决定核对依据：${profileRead.profile.synthetic ? '按合成合约核对' : '按发布的运行器合约核对'}，身份 ${contractRead.contract.pinned.identity.slice(0, 12)}；不证明在真实设备上跑得通。`;
  return {
    items,
    groups: [
      {
        kind: 'case-compile',
        contract: contractSlot.model,
        manifest: inventorySlot.model,
        profile: profileSlot.model,
        manifest_sha256: typeof inventorySlot.sha256 === 'string' ? inventorySlot.sha256 : '',
        workbook: workbook ? { model: workbook.model, sha256: workbook.sha256, source: `src:${workbook.sha256}` } : null,
        generation: { plan_run: parameters.plan_run ?? null, build: context.build ?? null, generator: WORKBOOK_FORMAT.generator },
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
