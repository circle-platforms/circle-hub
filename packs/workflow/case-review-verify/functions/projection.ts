// The projection of the verification (workflow@1 projection, ProjectionInput -> ProjectionOutput). Inputs: `target`, the mind map
// the draft reviewed (kityminder@1), and `draft`, the draft run's validation result bound by its rec: reference (json@1: the
// record { kind, schema, provenance, created_at, body }, or the validation result itself). The items are the draft's items,
// located in the target by the selectors of their draft locations; the target must be the very source the draft judged
// (same digest). Each item carries its draft findings in fields.draft_findings (with the rec: reference of each claim, the
// reference a disposition names in data.finding) and the draft level in fields.draft_level; the groups carry the draft level
// ({ kind: draft_level }) and the draft ({ kind: draft }), frozen with the run. The receiver inherits the items and the
// references, not the judgments: the checks of this pack re-run on its own boundary.
import type {Attribution} from '../../../../contracts/generated/vocabulary.ts';
import type { BoundInput, ProjectedItem, ProjectionOutput } from '../../../../contracts/src/pack.ts';
import { failure, guarded, isRecord, warningSink, PACK } from './common.ts';
import { clip, collapseWhitespace } from './text.ts';
import type { KityMinderModel, PackError, Warning } from './types.ts';

const SOURCE_ERROR='author_input' satisfies Attribution;
export const TARGET_SLOT = 'target';
export const DRAFT_SLOT = 'draft';
/** The draft pack's requirement keys whose claims this pack verifies. */
export const FINDINGS = 'findings';
export const LEVEL = 'level';
/** The workflow pack whose results this pack verifies (result.locks.pack is `<id>@<version>`). */
export const DRAFT_PACK = 'case-review';
export const MAX_ITEMS = 100;
export const MAX_SUMMARY = 200;
/** Longest finding text kept in the item fields; the claim itself stays readable by its reference. */
const MAX_TEXT = 2000;
const HEX64 = /^[0-9a-f]{64}$/;
const LOCATION = /^src:([0-9a-f]{64})\/kityminder@1\/(.+)$/;

export type DraftQuote = { reference: string; text: string };
export type DraftFinding = { reference: string; code: string | null; rank: string | null; text: string; location: string | null; quotes: DraftQuote[]; commands: string[] };
export type DraftLevel = { reference: string; rank: string | null; text: string };

const escapeToken = (token: string): string => token.replaceAll('~', '~0').replaceAll('/', '~1');

/** The rec: reference of a value of the draft record: the record digest, the base pointer of the bound value, the path. */
function recReference(record: string, base: string, path: ReadonlyArray<string | number>): string {
  return `rec:${record}#${base}${path.map((p) => `/${escapeToken(String(p))}`).join('')}`;
}

/** The validation result inside the bound draft value and the pointer it sits at in the record body. */
function resultOf(model: unknown, meta: Record<string, unknown>): { result: Record<string, unknown>; base: string } | null {
  if (!isRecord(model)) return null;
  if (model.kind === 'validation_result' && isRecord(model.body) && model.body.schema === 'validation@1') return { result: model.body, base: '' };
  if (model.schema === 'validation@1') return { result: model, base: typeof meta.pointer === 'string' ? meta.pointer : '' };
  return null;
}

/** A model statement (a judgment claim the draft's model wrote), not a Hub fact. */
function isModelJudgment(claim: unknown): claim is Record<string, unknown> {
  return isRecord(claim) && isRecord(claim.qualifier) && claim.qualifier.nature === 'judgment' && isRecord(claim.warrant) && claim.warrant.producer === 'model' && isRecord(claim.statement);
}

const stringOr = (value: unknown, fallback: string | null = null): string | null => (typeof value === 'string' ? value : fallback);

function findingOf(claim: Record<string, unknown>, reference: string): DraftFinding {
  const statement = claim.statement as Record<string, unknown>;
  const resolutions = Array.isArray(claim.resolutions) ? claim.resolutions.filter(isRecord) : [];
  const first = (r: Record<string, unknown>): string | null => (Array.isArray(r.references) && typeof r.references[0] === 'string' ? r.references[0] : null);
  const at = (suffix: RegExp) => resolutions.filter((r) => typeof r.pointer === 'string' && suffix.test(r.pointer));
  const location = at(/\/location$/).map(first).find((r): r is string => r !== null) ?? null;
  const quotes = at(/\/quotes\/[0-9]+$/).flatMap((r) => {
    const ref = first(r);
    return ref !== null && typeof r.text === 'string' ? [{ reference: ref, text: r.text }] : [];
  });
  const commands = at(/\/commands\/[0-9]+$/).flatMap((r) => (typeof r.text === 'string' ? [r.text] : []));
  return {
    reference,
    code: stringOr(statement.code),
    rank: stringOr(statement.rank),
    text: clip(stringOr(statement.text, '') ?? '', MAX_TEXT).text,
    location,
    quotes,
    commands,
  };
}

type DraftItem = { id: string; label: string; partition: string; selector: string; sha: string; findings: DraftFinding[];sourceFacts:Record<string,unknown>[] };

/** One line for the model: the draft findings of the case by code and rank, the draft partition and the path. */
export function summaryOf(findings: readonly DraftFinding[], partition: string, path: readonly string[]): string {
  const parts: string[] = [];
  if (findings.length === 0) parts.push('初评没有发现');
  else {
    const listed = findings.slice(0, 6).map((f) => `${f.code ?? '?'}/${f.rank ?? '?'}`).join('、');
    parts.push(`初评 ${findings.length} 条发现：${listed}${findings.length > 6 ? ' 等' : ''}`);
  }
  parts.push(`初评分区 ${partition}`);
  if (path.length > 1) parts.push(clip(collapseWhitespace(path.slice(1).slice(-2).join(' › ')), 60).text);
  return clip(parts.join('｜'), MAX_SUMMARY).text;
}

export function projection(input: unknown): ProjectionOutput {
  const warnings = warningSink();
  if (!isRecord(input) || !Array.isArray(input.inputs)) return failure('invalid_input', '输入里没有 inputs 数组', '按 projection-input@1 传入（Hub 自己调用时总是这样）');
  const inputs = input.inputs as unknown[];
  const target = inputs.find((i): i is BoundInput => isRecord(i) && i.slot === TARGET_SLOT) as BoundInput | undefined;
  const draft = inputs.find((i): i is BoundInput => isRecord(i) && i.slot === DRAFT_SLOT) as BoundInput | undefined;
  if (target === undefined || target.parser !== 'kityminder@1' || !isRecord(target.model) || !Array.isArray((target.model as { nodes?: unknown }).nodes)) {
    return failure('invalid_input', '没有绑定初评评审的脑图（输入槽 target，KityMinder）', '在 inputs.target 里给出初评评审的同一份脑图');
  }
  if (draft === undefined) return failure('invalid_input', '没有绑定初评的验证结果（输入槽 draft）', '在 inputs.draft 里给出初评 submit_result 回执里的验证结果引用（rec:<摘要>）');
  const meta = isRecord(draft.meta) ? draft.meta : {};
  const record = typeof meta.record === 'string' && HEX64.test(meta.record) ? meta.record : null;
  const found = resultOf(draft.model, meta);
  if (record === null || found === null) {
    return failure('draft_invalid', '输入槽 draft 绑定的不是初评运行的验证结果（Hub 记录 validation_result，validation@1）', '给出初评 submit_result 回执里的验证结果引用 rec:<摘要>，不带 # 后面的指针');
  }
  const { result, base } = found;
  // Only a draft of the review pack carries the findings and the level this pack verifies; another pack's result over the
  // same map would project as a draft without either.
  const locked = isRecord(result.locks) && typeof result.locks.pack === 'string' ? result.locks.pack : null;
  if (locked === null || !locked.startsWith(`${DRAFT_PACK}@`)) {
    return failure('draft_invalid', `输入槽 draft 绑定的验证结果来自任务包 ${locked === null ? '（未知）' : clip(locked, 60).text}，不是初评任务包 ${DRAFT_PACK}`, `给出 ${DRAFT_PACK} 初评运行 submit_result 回执里的验证结果引用 rec:<摘要>`);
  }
  if (result.acceptance !== 'accepted') {
    return failure('draft_not_accepted', '初评的这次提交没有被接受，没有可以复核的发现和等级', '先让初评方按回执改正并重新提交，复核被接受的那次提交的验证结果');
  }
  const model = target.model as unknown as KityMinderModel;
  const bySelector = new Map(model.nodes.map((n, k) => [n.selector, k]));
  const partitions = isRecord(result.partitions) ? result.partitions : {};
  const items: DraftItem[] = [];
  const misplaced: string[] = [];
  let otherSource: string | null = null;
  let findingCount = 0;
  for (const partition of Object.keys(partitions).sort()) {
    const list = partitions[partition];
    if (!Array.isArray(list)) continue;
    for (const [n, entry] of list.entries()) {
      if (!isRecord(entry) || typeof entry.item !== 'string' || typeof entry.location !== 'string') continue;
      const located = LOCATION.exec(entry.location);
      if (located === null) {
        misplaced.push(entry.item);
        continue;
      }
      if (located[1] !== target.sha256) otherSource ??= located[1];
      const findings:DraftFinding[]=[],sourceFacts:Record<string,unknown>[]=[];
      const requirements=Array.isArray(entry.requirements)?entry.requirements:[];
      requirements.forEach((requirement,r)=>{
        if(!isRecord(requirement)||!Array.isArray(requirement.claims))return;
        requirement.claims.forEach((claim,c)=>{
          const reference=recReference(record,base,['partitions',partition,n,'requirements',r,'claims',c]);
          if(requirement.requirement===FINDINGS&&isModelJudgment(claim))findings.push(findingOf(claim,reference));
          const attributed=Array.isArray(requirement.layers)?requirement.layers.find(layer=>isRecord(layer)&&layer.layer==='static'&&layer.attribution===SOURCE_ERROR):undefined;
          if(attributed&&isRecord(claim)&&isRecord(claim.qualifier)&&claim.qualifier.nature==='fact'&&claim.qualifier.source_role==='subject'&&isRecord(claim.warrant)&&claim.warrant.producer==='function'&&isRecord(claim.statement)&&claim.statement.verdict==='refute'&&!(isRecord(claim.statement.data)&&claim.statement.data.expected===true)){
            sourceFacts.push({reference,location:entry.location,layer:attributed,claim});
          }
        });
      });
      findingCount += findings.length;
      items.push({ id: entry.item, label: typeof entry.label === 'string' ? entry.label : entry.item, partition, selector: located[2], sha: located[1], findings,sourceFacts });
    }
  }
  if (otherSource !== null) {
    return failure('target_mismatch', `初评评审的是另一份源文件（src:${otherSource.slice(0, 12)}…），不是 target 绑定的这份`, `把 target 设为初评评审的同一份源文件：src:${otherSource}（或同一个外部对象没有变过的修订）`);
  }
  if (misplaced.length > 0) {
    return failure('draft_invalid', `初评的 ${misplaced.length} 个条目不是脑图节点（例如 ${clip(misplaced[0], 60).text}）`, '复核用 case-review 初评的验证结果');
  }
  if (items.length === 0) return failure('draft_invalid', '初评的验证结果里没有条目', '复核有条目的初评验证结果');
  if (items.length > MAX_ITEMS) return failure('too_many_items', `初评有 ${items.length} 个条目，超过一次运行最多 ${MAX_ITEMS} 个`, '初评按子树分块（参数 block）后，每块单独复核');
  const missing = items.filter((item) => !bySelector.has(item.selector));
  if (missing.length > 0) {
    return failure('draft_item_missing', `初评的 ${missing.length} 个条目在 target 里找不到（例如 ${clip(missing[0].id, 60).text}）`, '把 target 设为初评评审的同一份脑图');
  }

  let draftLevel: DraftLevel | null = null;
  const cross = Array.isArray(result.cross_item) ? result.cross_item : [];
  for (const [k, claim] of cross.entries()) {
    if (!isModelJudgment(claim) || claim.requirement !== LEVEL) continue;
    const statement = claim.statement as Record<string, unknown>;
    draftLevel = { reference: recReference(record, base, ['cross_item', k]), rank: stringOr(statement.rank), text: clip(stringOr(statement.text, '') ?? '', MAX_TEXT).text };
    break;
  }
  if (draftLevel === null || !draftLevel.rank?.trim()) return failure('draft_level_missing','初评的验证结果缺少等级（跨条目主张 level 的 rank）；本次不能开始复核','先让初评方补等级和理由并重交初评；用新的受理结果重开复核，保留当前初评记录引用作定位');

  const rawParams = isRecord(input.parameters) ? input.parameters : {};
  const hasTaggedChildOrP2 = new Uint8Array(model.nodes.length);
  for (let k = model.nodes.length - 1; k >= 0; k--) {
    const n = model.nodes[k];
    const data = n.data as Record<string, unknown> | undefined;
    const tagged = Array.isArray(data?.resource) && data.resource.length > 0;
    const p2 = data?.priority === 2;
    if (n.parent !== null && (hasTaggedChildOrP2[k] === 1 || tagged || p2)) {
      hasTaggedChildOrP2[n.parent] = 1;
    }
  }
  const isCandidateNode = (k: number): boolean => {
    const n = model.nodes[k];
    const data = n.data as Record<string, unknown> | undefined;
    const tagged = Array.isArray(data?.resource) && data.resource.length > 0;
    if (tagged) return false;
    const hasChildren = Array.isArray(n.children) && n.children.length > 0;
    return data?.priority === 2 && hasChildren && hasTaggedChildOrP2[k] === 0;
  };
  const isItemUntagged = (item: DraftItem): boolean => {
    const k = bySelector.get(item.selector);
    if (k === undefined) return false;
    const data = model.nodes[k].data as Record<string, unknown> | undefined;
    return !Array.isArray(data?.resource) || data.resource.length === 0;
  };
  const hasUntaggedInDraft = items.some(isItemUntagged);
  let modelHasOmittedCandidate = false;
  const draftSelectors = new Set(items.map((i) => i.selector));
  for (let k = 0; k < model.nodes.length; k++) {
    if (isCandidateNode(k) && !draftSelectors.has(model.nodes[k].selector)) {
      modelHasOmittedCandidate = true;
      break;
    }
  }

  const caseRule: 'marked' | 'tagged' =
    typeof rawParams.case_rule === 'string'
      ? rawParams.case_rule === 'tagged' ? 'tagged' : 'marked'
      : hasUntaggedInDraft
        ? 'marked'
        : modelHasOmittedCandidate
          ? 'tagged'
          : 'marked';

  const filteredItems = caseRule === 'tagged' ? items.filter((item) => !isItemUntagged(item)) : items;
  const marked_only = caseRule === 'marked' ? filteredItems.filter(isItemUntagged).length : 0;
  const ruleSummary = `用例规则：${caseRule === 'marked' ? '标签或标记' : '只认标签'}；其中 ${marked_only} 个只靠标记识别（没有标签）`;

  // Items in document order of the target.
  filteredItems.sort((a, b) => (bySelector.get(a.selector) ?? 0) - (bySelector.get(b.selector) ?? 0));
  const out: ProjectedItem[] = filteredItems.map((item) => {
    const k = bySelector.get(item.selector) as number;
    const node = model.nodes[k];
    const path: string[] = [];
    for (let at = node.parent; at !== null; at = model.nodes[at].parent) path.unshift(model.nodes[at].text);
    return {
      id: item.id,
      label: item.label,
      summary: summaryOf(item.findings, item.partition, path),
      location: { slot: TARGET_SLOT, parser: 'kityminder@1', selector: item.selector },
      fields: {
        nodeId: node.id,
        path,
        title: node.text,
        draft_partition: item.partition,
        draft_findings: item.findings,
        draft_source_facts:item.sourceFacts,
        draft_level: draftLevel,
        case_rule: caseRule,
        marked_only,
      },
    };
  });
  const groups: Record<string, unknown>[] = [
    { kind: 'draft_level', ...(draftLevel !== null ? draftLevel : { reference: null, rank: null, text: '' }) },
    {
      kind: 'draft',
      record,
      run: typeof result.run === 'string' ? result.run : null,
      items: out.length,
      findings: findingCount,
      case_rule: caseRule,
      marked_only,
      rule_summary: ruleSummary,
      data: { case_rule: caseRule, marked_only },
    },
  ];
  return { items: out, groups, warnings: warnings.list() };
}

export default function (input: unknown): unknown {
  return guarded(() => projection(input) as { warnings: Warning[]; error?: PackError });
}
