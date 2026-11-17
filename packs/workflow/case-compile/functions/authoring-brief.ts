// The authoring brief of a case: the entries of the locked tree its writer would otherwise look up one model round trip at a
// time. With the knowledge root on local disk a search costs nothing, but each search is still a reply of the model: in run 22
// the six plan writers spent 78% of their model time in 208 replies that only searched (the commands their case's
// recomposition record already names, the inverses and read-only forms of those commands, their siblings), and every rework
// round starts a fresh writer that searches again. The reference implementation does this before a writer starts: its engine
// builds each case's brief in code (compile_engine/briefs.py build_brief) and binds the recompose stage's command grounding to
// it, and the writer's rule is to read that first and query only what it does not carry (agents/compile-worker.md, "Reuse
// sealed recompose grounding before querying").
//
// Facts only, taken by structure and never by matching words: the tree references the record carries, the command lines its
// rewrites and the author's own lines spell (followed word by word down the tree), the inverse rules and read-only prefixes
// the product declares (command-policy@1, the same rule the cleanup check applies), and the tree's own parents and children.
// Nothing here is a judgement and nothing here is plan content.
//
// The brief ends with the envelope of the case's plan file. The Hub takes a plan as one statement in a list, {text, quotes,
// data}, and only `data` is described by slots.schema.json; the one place that shows the whole shape is
// examples/submit-result.json, which the skill text never names. So a writer learnt the shape from a refusal: run 21's first
// submission had 162 schema violations, and in run 22 the main session's hand-written template put the plan slot as an object
// with `bucket` outside `data`, which fourteen plans copied (fourteen refusals; its `bucket` was the words of the skill
// sentence instead of the bed the run's profile selects). The reference engine hands its writer the envelope's field-level
// schema (lang_query docs blocks_schema, section mechanical_case_envelope). The envelope here carries only identities of the
// frozen item: its id, its expected sentences with their references, the bed of the run's profile, the recomposition receipt,
// the case id and the expectation slots. What a writer writes is left empty, and empty is refused, so an unfilled envelope
// cannot pass as a plan.
import { createHash } from 'node:crypto';
import type { BedFacts } from './bed.ts';
import type { RunnerCleanup } from './runtime-contract.ts';
import { canonicalJson } from './canonical-json.ts';
import { entryLines, nodeLines } from './knowledge-text.ts';
import {
  analyzeRoundHistory,
  consecutiveRepeatedGateCodes,
  INLINE_TAIL_CHARS,
  MAX_ANOMALY_LINES,
  MAX_ROUNDS,
  renderPriorRoundsMarkdown,
  type PriorAttributionItem,
  type PriorRoundRecord,
  type StreakAnalysis,
} from './rework-history.ts';
import { isRecord, wrapProseLine, CallFailure } from './text.ts';
import { SCOPE_RULINGS_ORIGIN } from './scope.ts';

/** `parameter` is on a manual table row that states one parameter of a command: the command forms the manual spells and the parameter's name (the product's producer records both from the row's place in the manual). */
export interface BriefNode { path: string; children: Array<{ name: string; path: string }>; entries: Array<{ kind?: string; statement: string; reference: string; applicability?: string; fragments?: string[]; parameter?: { commands: string[]; name: string } }> }
export interface BriefPolicy { inverse_rules: Array<{ source_prefix: string; inverse_prefix: string; leading_parameters?: number }>; inverse_alternatives: string[][]; read_only: string[] }
export interface BriefParameter { name: string; statement: string; reference: string }
/** The locked root as the run download wrote it: its nodes by canonical path, where each node's block starts in the text files, and the manual's parameter rows by the words of the command they state. */
export interface BriefKnowledge { root: string; nodes: Map<string, BriefNode>; lines: Map<string, { file: string; line: number; count: number }>; parameters?: Map<string, BriefParameter[]> }

/**
 * The manual's statement of each parameter, by the words of the command it belongs to: the value domain in the vendor's
 * own words, which the reference hands its writer beside the tree's argument contract (lang_query kind=param: "the XML
 * side gives position/type/optional/help, the manual side gives the value domain in the vendor's own words"). A row is
 * listed once per command form, in the order the root holds it.
 */
export function parameterRows(nodes: Iterable<BriefNode>): Map<string, BriefParameter[]> {
  const out = new Map<string, BriefParameter[]>();
  for (const node of nodes) for (const entry of node.entries) {
    if (!entry.parameter) continue;
    for (const command of entry.parameter.commands) {
      const rows = out.get(command) ?? [];
      if (!rows.some((row) => row.reference === entry.reference)) rows.push({ name: entry.parameter.name, statement: entry.statement, reference: entry.reference });
      out.set(command, rows);
    }
  }
  return out;
}

/** Commands hang below this node in a locked tree (the catalog's paths, as the recomposition check builds them). */
const COMMANDS = '/commands';
/** How many siblings a command lists, and how large a block of another node may be to be quoted whole. */
const SIBLINGS = 40, QUOTED_BYTES = 3000, QUOTED_BLOCKS = 4;

const segments = (path: string): string[] => path.split('/').slice(1);
const decoded = (segment: string): string => { try { return decodeURIComponent(segment); } catch { return segment; } };
/** One spelling of a path: references encode a space, the text files do not, and a slash inside a name stays encoded in both. */
export const canonicalPath = (path: string): string => '/' + segments(path).map((segment) => encodeURIComponent(decoded(segment))).join('/');
const within = (path: string, prefix: string): boolean => path === prefix || path.startsWith(prefix + '/');
const words = (path: string): string => segments(path).slice(1).map(decoded).join(' ');

const WHOLE = /^tree:([0-9a-f]{64})(\/[^@]*)(?:@[0-9a-f]{64})?$/;
const QUOTED = /tree:([0-9a-f]{64})(\/[^@\s"]+)@[0-9a-f]{64}/g;
/** Every path of the locked root a value's strings reference: a string that is a reference, or one written out with its entry inside a sentence. */
export function referencedPaths(value: unknown, root: string): string[] {
  const found = new Set<string>();
  const visit = (current: unknown): void => {
    if (typeof current === 'string') {
      const whole = WHOLE.exec(current);
      if (whole) { if (whole[1] === root) found.add(canonicalPath(whole[2])); return; }
      for (const match of current.matchAll(QUOTED)) if (match[1] === root) found.add(canonicalPath(match[2]));
    } else if (Array.isArray(current)) current.forEach(visit);
    else if (isRecord(current)) Object.values(current).forEach(visit);
  };
  visit(value);
  return [...found];
}

/** The command a line names: its words followed down the tree from the command node, as far as they are node names; a node that defines nothing is no command. */
export function commandPath(knowledge: BriefKnowledge, line: string): string | null {
  const top = knowledge.nodes.get(COMMANDS);
  if (!top) return null;
  let node: BriefNode = top;
  for (const token of line.trim().split(/\s+/)) {
    const child: { name: string; path: string } | undefined = node.children.find((candidate) => candidate.name === token);
    const next: BriefNode | undefined = child ? knowledge.nodes.get(canonicalPath(child.path)) : undefined;
    if (!next) break;
    node = next;
  }
  return node.entries.length && node !== top ? canonicalPath(node.path) : null;
}

/** The product's inverse of a command: the rule with the longest source prefix, when it is the only one of that length (the cleanup check's rule). */
export function inverseOf(policy: BriefPolicy, path: string): { path: string; rule: BriefPolicy['inverse_rules'][number] } | null {
  const matches = policy.inverse_rules.filter((rule) => within(path, canonicalPath(rule.source_prefix))).sort((a, b) => segments(b.source_prefix).length - segments(a.source_prefix).length);
  const rule = matches[0];
  if (!rule || (matches[1] && canonicalPath(matches[1].source_prefix) === canonicalPath(rule.source_prefix))) return null;
  return { path: canonicalPath(rule.inverse_prefix) + path.slice(canonicalPath(rule.source_prefix).length), rule };
}

/**
 * The sibling a declared pair of inverse values names: the command's last word is one member and the same parent holds a
 * command under the other (`… on` and `… off`). The cleanup check asks this before the prefix rules; the other form of a
 * declared pair, an enumerated argument of one signature, is not in the text of the tree and is left to the rule stated in
 * the brief's head.
 */
export function pairedSibling(policy: BriefPolicy, knowledge: BriefKnowledge, path: string): { pair: string[]; node: BriefNode } | null {
  const parts = segments(path), leaf = decoded(parts.at(-1) ?? '');
  const pair = policy.inverse_alternatives.find((members) => members.length === 2 && members.includes(leaf));
  if (!pair) return null;
  const node = knowledge.nodes.get(canonicalPath('/' + [...parts.slice(0, -1), pair[0] === leaf ? pair[1] : pair[0]].join('/')));
  return node?.entries.length ? { pair, node } : null;
}

export function policyOf(value: unknown): BriefPolicy | null {
  if (!isRecord(value) || value.schema !== 'command-policy@1' || !Array.isArray(value.inverse_rules) || !Array.isArray(value.read_only)) return null;
  const rules = value.inverse_rules.filter(isRecord).filter((rule) => typeof rule.source_prefix === 'string' && typeof rule.inverse_prefix === 'string')
    .map((rule) => ({ source_prefix: rule.source_prefix as string, inverse_prefix: rule.inverse_prefix as string, ...(typeof rule.leading_parameters === 'number' ? { leading_parameters: rule.leading_parameters } : {}) }));
  const pairs = Array.isArray(value.inverse_alternatives) ? value.inverse_alternatives.filter((pair): pair is string[] => Array.isArray(pair) && pair.every((member) => typeof member === 'string')) : [];
  return { inverse_rules: rules, inverse_alternatives: pairs, read_only: value.read_only.filter((prefix): prefix is string => typeof prefix === 'string') };
}

/** A node as the run download writes it into the text files (knowledge-text.ts nodeLines, the same function): a heading line per entry, then its statement byte for byte. */
export function nodeBlock(node: BriefNode): string[] {
  return nodeLines(node.path, node.children.map((child) => child.name), node.entries);
}
const syntaxLine = (node: BriefNode): string | null => (node.entries.find((entry) => entry.kind === 'definition') ?? node.entries[0])?.statement.split('\n', 1)[0] ?? null;

/**
 * The command the same words lead to below a read-only prefix: the deepest node that exists there along the command's own
 * words, when that node defines a command. A branch that only lists children is not one (below a statistics prefix the words
 * of a configuration command end at the module's branch, which says nothing about that command).
 */
function readOnlyForm(knowledge: BriefKnowledge, prefix: string, path: string): BriefNode | null {
  const base = segments(path), under = segments(prefix);
  if (under[0] !== base[0]) return null;
  for (let length = base.length - 1; length >= 1; length--) {
    const node = knowledge.nodes.get(canonicalPath('/' + [...under, ...base.slice(1, 1 + length)].join('/')));
    if (node) return node.entries.length ? node : null;
  }
  return null;
}

/**
 * The envelope of a case's plan file with the identities of its frozen item filled in, or null when the item has no id. The
 * statement's text, the steps, the expectations and each slot's assertions are the writer's and stay empty.
 */
export function planEnvelope(item: unknown, bed: string | null): Record<string, unknown> | null {
  const fields = isRecord(item) && isRecord(item.fields) ? item.fields : null;
  if (!isRecord(item) || typeof item.id !== 'string' || !fields) return null;
  const recomposition = isRecord(fields.recomposition) ? fields.recomposition : null;
  const record = recomposition && isRecord(recomposition.record) ? recomposition.record : null;
  const quotes = (Array.isArray(fields.expected_nodes) ? fields.expected_nodes : []).filter(isRecord)
    .filter((node) => typeof node.reference === 'string' && typeof node.text === 'string').map((node) => ({ reference: node.reference, text: node.text }));
  const slots = (record && Array.isArray(record.expectation_slots) ? record.expectation_slots : []).filter(isRecord).filter((slot) => typeof slot.slot === 'string').map((slot) => ({ slot: slot.slot, assertions: [] }));
  const caseId = record && isRecord(record.case) && typeof record.case.id === 'string' ? record.case.id : '';
  return {
    item: item.id, handling: 'handled',
    slots: { plan: [{
      text: '', quotes,
      data: {
        bucket: bed ?? '', blocks: [], replacements: [], steps: [], expects: [],
        ...(record ? { recomposition: { receipt: typeof recomposition!.receipt === 'string' ? recomposition!.receipt : '', case_id: caseId, slots, rebindings: [] } } : {}),
      },
    }] },
  };
}

export interface AuthoringBrief { text: string; commands: string[]; others: string[]; missing: string[] }
/**
 * The brief of one frozen item of a plan run, or null when the item carries no recomposition record. `commands` are the tree
 * paths of the commands the record names, `others` the other nodes it references, `missing` the referenced paths the locked
 * root does not hold.
 */
function collectKnowledgeSets(
  recomposition: Record<string, unknown>,
  record: Record<string, unknown>,
  knowledge: BriefKnowledge,
): { commands: string[]; others: string[]; missing: string[] } {
  const named = new Set<string>(referencedPaths(recomposition, knowledge.root));
  const ledgers = isRecord(record.ledgers) ? record.ledgers : {};
  const lines: string[] = [];
  for (const row of Array.isArray(ledgers.adapted) ? ledgers.adapted : []) {
    if (isRecord(row) && Array.isArray(row.commands)) {
      for (const line of row.commands) if (typeof line === 'string') lines.push(line);
    }
  }
  for (const atom of Array.isArray(record.atoms) ? record.atoms : []) {
    if (isRecord(atom)) {
      const txt = typeof atom.text === 'string' ? atom.text : typeof atom.content === 'string' ? atom.content : null;
      if (txt) lines.push(...txt.split(/\r?\n/));
    }
  }
  for (const line of lines) {
    const path = commandPath(knowledge, line);
    if (path) named.add(path);
  }
  const commands = [...named].filter((path) => within(path, COMMANDS) && knowledge.nodes.get(path)?.entries.length).sort();
  const others = [...named].filter((path) => knowledge.nodes.has(path) && !commands.includes(path)).sort();
  const missing = [...named].filter((path) => !knowledge.nodes.has(path)).sort();
  return { commands, others, missing };
}

interface RunnerCleanupBriefHit {
  rule: number;
  prefix: string;
  clears?: string[];
  line: number | null;
  inTail: boolean;
}
function runnerCleanupMatch(cleanup: RunnerCleanup | null | undefined, cmdWords: string): RunnerCleanupBriefHit | null {
  if (!cleanup) return null;
  for (const [rule, row] of cleanup.rules.entries()) {
    const prefix = row.prefixes.find((p) => cmdWords === p || cmdWords.startsWith(p));
    if (prefix === undefined) continue;
    const inTail = Boolean(cleanup.order?.tail.some((t) => row.clears?.includes(t) || t.startsWith(prefix)));
    return { rule, prefix, ...(row.clears ? { clears: row.clears } : {}), line: row.line, inTail };
  }
  return null;
}
function runnerCleanupSummaryText(cleanup: RunnerCleanup): string {
  const tailText = cleanup.order?.tail.length ? `；以下动作放收尾末尾：${cleanup.order.tail.join('、')}` : '';
  const beforeText = cleanup.order?.before.length ? `；顺序约束：${cleanup.order.before.map(([a, b]) => `${a} 先于 ${b}`).join('、')}` : '';
  return `执行器自动清理（${cleanup.source}@${cleanup.sha256.slice(0, 12)}）：对清配对象 ${cleanup.objects.join('、')}，自第 2 条用例开始前及整本关闭连接时按 cmd_config 发过的命令行逐条比前缀、第一条命中即用（共 ${cleanup.rules.length} 条规则${tailText}${beforeText}）。已声明枚举或同级命令互逆取值的配置仍须先在 cleanup:true 写同设备逆操作，再交运行器清除，不能以自动清理替代互逆状态转换。未命中规则或不在清配对象列表上的设备改动仍须在 cleanup:true 手写同设备逆序逆操作；运行器自己的收尾清除或保存命令禁止写入 cleanup:true（需在用例中执行时只写进 main）。`;
}
function runnerCleanupRuleNote(cleanup: RunnerCleanup, hit: RunnerCleanupBriefHit): string {
  const clearsText = hit.clears?.length ? `，触发清理命令 ${hit.clears.map((c) => `“${c}”`).join('、')}` : '';
  const tailText = hit.inTail ? '，收尾阶段末尾执行' : '';
  return `清配对象 ${cleanup.objects.join('、')} 命中规则 ${hit.rule + 1}${hit.line !== null ? `（${cleanup.source} 第 ${hit.line} 行）` : ''}，前缀“${hit.prefix}”${clearsText}${tailText}`;
}

export function authoringBrief(item: unknown, index: string, knowledge: BriefKnowledge, policy: BriefPolicy | null, bed: string | null = null, runnerCleanup: RunnerCleanup | null = null): AuthoringBrief | null {
  const fields = isRecord(item) && isRecord(item.fields) ? item.fields : null;
  const recomposition = fields && isRecord(fields.recomposition) ? fields.recomposition : null;
  const record = recomposition && isRecord(recomposition.record) ? recomposition.record : null;
  if (!isRecord(item) || !fields || !record) return null;
  const { commands, others, missing } = collectKnowledgeSets(recomposition!, record, knowledge);
  const shown = new Set<string>();
  const block = (node: BriefNode): string[] => { const path = canonicalPath(node.path); if (shown.has(path)) return [`（${node.path} 的条目已在上文）`]; shown.add(path); return nodeBlock(node); };
  const out: string[] = [
    `# 编写简报 ${index}：${typeof fields.title === 'string' ? fields.title : ''}`,
    '',
    `下载运行时由程序从 items/${index}.json、run.json 和 knowledge/ 摘出，只有事实，没有判断，也不是计划：这条用例的重组记录点到的命令在锁定命令树里的条目、手册对这些命令各参数的说明、产品声明的逆操作、只读前缀下同样的词走到的命令、同级命令的语法行，记录点到的其它节点在 knowledge/ 里的位置，最后是这条用例的计划文件外壳。写这条用例先读这一份，这里没有的再到 knowledge/ 里搜。每个条目前有一行“· 引用 tree:…”，那是标注，不是原文，引用照抄它；它下面到下一个“· 引用”行或“# ”行之前才是原文，一字不差（含全角标点和 ** 标记），引文只从这些行里连续复制，不带标注，不自加省略号。标注行末尾有“源 <文件号> 行 <起>-<止>”时，同一节点的条目就按这个原文行号排列，行号挨着就是原文挨着；没有“源”的条目按 Hub 的排列（类别、原文）列出，不是手册里的先后。`,
    '',
    `条目 ${String(item.id ?? '')}；锁定根 ${knowledge.root}。`,
    '',
    '执行器规则关掉的动作不能作为排除原始用例的理由。按同一构建的手册和命令树，用该设备已开放的命令方法完成原来的效果，保留对象、动作和场景，并说明命令与原始步骤的对应关系；不修改执行器规则或测试环境配置。',
    'expects 使用 basis:"model_judgment" 时，text 必须是设备执行后实际会输出、能在设备输出里逐字找到的一行原文，不写“输出含……”或“状态为……”等描述。对应原始用例哪句期望、为什么选择这段原文，写在 rationale 里。',
    '分块计划里，作者在期望节点没写字面（items/<序号>.json 的 expected_nodes 里该节点没有 declaration）时，同样由模型写检查点：criteria 里写一条类型化判据（quote 逐字取该期望原句，literal 是设备输出里可逐字找到的单行原文，rationale 写为何选它，scope_root 写上面的锁定根），断言的 criterion 指向它。这是模型判断，状态未确认，不发起 criteria_review，由上机验证的设备输出裁定。',
    '只有上机时才产生的值，在本条自动化用例里先取出再用；手册允许指定名字时，由生成器指定，本条先创建，配置、查询和清理都使用同一个名字。可在这些命令里写相同的 {{name:N|前缀|后缀}}，前后缀取手册允许的字符并区分本条；fidelity-brief.ts 或 submit-plans.ts 展开并写回文件后，Hub 核对具体命令。不写死设备生成的名字，不抄旧设备输出，不沿用设备上已有的东西。CAPTURE 保存原文，EXPECT_FROM 用于检查，整段原文不直接插入普通参数；设备不允许命名时，须有执行器规则已支持的本条取值和引用方式，缺少时说明缺什么，不猜。',
    '设备生成的值，在本条先保存设备输出，按表格列和选行条件取一格；后续命令用 {} 引用它。',
    '数据行按声明的字面分隔符和列数识别；取不到、零行或多行就停止并带设备原话说明，不猜值、不用上一次的输出。',
  ];
  // The order is the cleanup check's own (functions/command-obligations.ts, alternativeInverses then inverse_rules).
  if (policy) out.push(`产品声明的命令规则（run.json 的 command_policy）：只读前缀 ${policy.read_only.join('、') || '无'}；互逆取值 ${policy.inverse_alternatives.map((pair) => pair.join('/')).join('、') || '无'}。`
    + (policy.inverse_alternatives.length ? '核验认逆操作的顺序：命令的枚举参数取了互逆取值之一时，逆操作是同一条命令取另一个值；命令的末词是互逆取值之一、同级又有另一个取值的命令时，逆操作是那条同级命令；都不是时按前缀规则。' : ''));
  else out.push('run.json 里没有产品声明的命令规则（command_policy），下面不列逆操作和只读命令。');
  if (runnerCleanup) out.push(runnerCleanupSummaryText(runnerCleanup));
  out.push('', `## 重组记录点到的命令（${commands.length} 条）`);
  if (!commands.length) out.push('', '重组记录没有点到命令树里的命令；要用的命令到 knowledge/ 里搜。');
  for (const path of commands) {
    const node = knowledge.nodes.get(path)!;
    out.push('', `### ${words(path)}`, ...block(node));
    const stated = knowledge.parameters?.get(words(path)) ?? [];
    if (stated.length) {
      out.push(`手册对这条命令各参数的说明（${stated.length} 行，原文）：`);
      for (const row of stated) out.push(...entryLines(row));
    }
    const runnerHit = runnerCleanupMatch(runnerCleanup, words(path));
    if (policy) {
      if (policy.read_only.some((prefix) => within(path, canonicalPath(prefix)))) out.push('这条命令在产品声明的只读前缀下。');
      else {
        const paired = pairedSibling(policy, knowledge, path), inverse = paired ? null : inverseOf(policy, path);
        const alsoRunner = runnerHit ? `；另受运行器自动清理涵盖（${runnerCleanupRuleNote(runnerCleanup!, runnerHit)}）${paired?'；此处是已声明的互逆取值，仍须先在 cleanup:true 执行同设备逆操作，再交运行器清除':'，非已声明互逆取值时，在清配对象上可省略 cleanup:true，禁止把运行器收尾清理或保存命令写入 cleanup:true'}` : '';
        if (paired) out.push(`逆操作（产品声明的互逆取值 ${paired.pair.join('/')}：同级的另一条命令${alsoRunner}）：`, ...block(paired.node));
        else if (inverse) {
          const carried = inverse.rule.leading_parameters === undefined ? '' : `，逆操作带这条命令的前 ${inverse.rule.leading_parameters} 个参数`;
          const target = knowledge.nodes.get(inverse.path);
          out.push(`逆操作（产品规则 ${inverse.rule.source_prefix} → ${inverse.rule.inverse_prefix}${carried}${alsoRunner}）：`);
          if (target?.entries.length) out.push(...block(target));
          else out.push(`按这条规则算出的 ${decodeURI(inverse.path)} 不在锁定命令树里。`);
        } else if (runnerHit) {
          out.push(`执行器收尾（无需手写 cleanup:true）：${runnerCleanupRuleNote(runnerCleanup!, runnerHit)}；禁止写入 cleanup:true（需在用例过程内执行时只写进 main）。`);
        } else {
          out.push('逆操作：产品没有为这条命令声明唯一的逆操作规则。');
        }
        for (const prefix of policy.read_only) {
          const form = readOnlyForm(knowledge, canonicalPath(prefix), path);
          if (form) out.push(`只读前缀 ${prefix} 下同样的词走到的命令：`, ...block(form));
        }
      }
    } else if (runnerHit) {
      out.push(`执行器收尾（无需手写 cleanup:true）：${runnerCleanupRuleNote(runnerCleanup!, runnerHit)}；禁止写入 cleanup:true（需在用例过程内执行时只写进 main）。`);
    }
    const parent = knowledge.nodes.get(path.slice(0, path.lastIndexOf('/')));
    const siblings = (parent?.children ?? []).filter((child) => canonicalPath(child.path) !== path).map((child) => knowledge.nodes.get(canonicalPath(child.path))).filter((sibling): sibling is BriefNode => sibling !== undefined);
    if (parent && siblings.length) {
      const at = knowledge.lines.get(canonicalPath(parent.path));
      out.push(`同级命令（${parent.path} 下另有 ${siblings.length} 个，完整条目在 knowledge/${at ? `${at.file} 第 ${at.line} 行起` : '里按路径找'}）：`);
      for (const sibling of siblings.slice(0, SIBLINGS)) { const syntax = syntaxLine(sibling); out.push(syntax ? `· ${syntax}` : `· ${words(canonicalPath(sibling.path))} …（下面有 ${sibling.children.length} 个子节点）`); }
      if (siblings.length > SIBLINGS) out.push(`（还有 ${siblings.length - SIBLINGS} 个没有列出）`);
    }
  }
  out.push('', `## 重组记录点到的其它节点（${others.length} 个）`);
  let quoted = 0;
  for (const path of others) {
    const node = knowledge.nodes.get(path)!, at = knowledge.lines.get(path), text = nodeBlock(node);
    const where = at ? `knowledge/${at.file} 第 ${at.line} 行起，共 ${at.count} 行` : 'knowledge/ 里按路径找';
    if (quoted < QUOTED_BLOCKS && Buffer.byteLength(text.join('\n')) <= QUOTED_BYTES) { quoted++; out.push('', `${where}：`, ...block(node)); }
    else out.push('', `# ${node.path}`, `（${where}，没有抄在这里）`);
  }
  if (missing.length) out.push('', '## 记录点到、锁定根里没有的路径', ...missing.map((path) => `- ${decodeURI(path)}`));
  const envelope = planEnvelope(item, bed);
  if (envelope) out.push('', '## 这条用例的计划文件外壳',
    '',
    `一个条目一份 JSON 文件。Hub 收的形状是：plan 槽是只有一条陈述的列表，陈述是 {text, quotes, data}，计划内容都在 data 里（data 的结构以技能目录的 slots.schema.json 为准，完整的样子见技能目录 examples/submit-result.json）。下面已经填好的都抄自本运行的冻结内容：条目号、期望原句及其引用、${bed === null ? '' : 'bucket（本运行配置选定的自动化测试环境）、'}重组回执、用例号和期望的判断依据；空着的由编写模型填写：text 写一句话说明这份计划，steps 和 expects 照技能说明写（adapted 与原始步骤不是步骤白名单；除重组 sources.states 列出的 missing_prerequisite 外，同构建手册正文或示例明确要求的运行前提及配对 cleanup:true 逆清理也必须补齐，在扁平步骤附可选 precondition_source: {reference, text} 或 blocks 模式写入 block_context.preconditions 逐字引用 knowledge/ 供 Hub 核对并列入保真豁免），每个判断依据的 assertions 列出对应的断言（平面计划是 expects 从 1 起的序号，写成字符串）。空着的不填会被拒。写完只是草稿，交 Hub 前由主会话走完保真核对（按 SKILL.md 第 3 节依次跑 fidelity-brief → 新开子代理核对 → fidelity-apply 写入 data.fidelity）。`,
    '',
    '原始用例要求不存在、无残留或删除后查不到时，顺序步骤在对应查询的 expects 写 op:"not_found"，text 使用原始期望的具体原文，或本条配置后按已声明逆操作撤销的名字，after 指向对应查询；不写描述句，不另立判定标准或发起复核。分块写法的常量仍用 OBSERVE_ASSERT/op=not_found，literal 写不应出现的记录；动态值在本条先 CAPTURE，再用 EXPECT_FROM/op=not_found，expected_from 指该捕获，执行器须声明寄存器的字面否定方法，不抄旧设备输出。quote 保留原始期望。要求删除成功时，删除后再查询，指向这次查询的设备输出；这项检查不填 criterion，不为它写 criteria 或发起 criteria_review/criteria_review_run。',
    '',
    '```json', JSON.stringify(envelope, null, 2), '```');
  return { text: out.join('\n') + '\n', commands, others, missing };
}

export const COMPILE_BRIEF_SCHEMA = 'compile-brief@1';
export const COMPILE_BRIEF_MAX_BYTES = 512 * 1024;
export const PRIOR_DEVICE_HISTORY_DISCLAIMER =
  '以下为同一原始用例（同 autoid）此前已上机验证过的历史记录，仅作命令选型与设备交互参考，绝不作为当前构建功能正确或签发期望的依据。';
export const PRIOR_DEVICE_HISTORY_UNAVAILABLE_REASON =
  'Hub 当前尚未提供按 autoid 查询历次上机验证与 apv_cmds 的只读接口。';
export const PREREQ_SCAN_REASON =
  '当前简报未从重组记录与产品目录提取到前置；这不证明没有其他前置。编写前仍须核对 knowledge/manual.txt 同构建功能章、配置示例与前置条件。';
export const PREREQ_PARTIAL_RECOMPOSE_REASON = '已从用例重组记录（record.sources.states）提取如下已知前置；当前简报未提取产品目录前置，这不证明没有其他跨章节前置，仍须核对同构建手册正文、示例与前置条件。';
/** Disclosed when the recompose record is present but `sources.states` is missing or not a list. */
export const PREREQ_STATES_UNREADABLE_REASON =
  '读不到重组记录的 sources.states（预期是数组）；不能据此断定没有前置。请核对重组返回的记录形状后再开编写。';
export const RECOMPOSE_STATES_ORIGIN = 'record.sources.states' as const;

/** Formats an entry from `recompose-record@1` `unknowns[]` without falling back to raw JSON when structured fields exist. */
export function formatRecomposeUnknown(u: unknown): string {
  if (typeof u === 'string') return u;
  if (!isRecord(u)) return '';
  const atom = typeof u.atom === 'string' && u.atom ? u.atom : '';
  const missing = typeof u.missing === 'string' && u.missing ? u.missing : '';
  const reason = typeof u.reason === 'string' && u.reason ? u.reason : '';
  const nextAction = typeof u.next_action === 'string' && u.next_action ? u.next_action : '';
  const audience = typeof u.audience === 'string' && u.audience ? u.audience : '';
  const due = typeof u.due === 'string' && u.due ? u.due : '';
  const body = [missing, reason].filter(Boolean).join('；说明：');
  if (atom || body || nextAction || audience || due) {
    const prefix = atom ? `[原子 ${atom}] ` : '';
    const details: string[] = [];
    if (nextAction) details.push(`下一步：${nextAction}`);
    if (audience) details.push(`对象：${audience}`);
    if (due) details.push(`截止：${due}`);
    if (body && details.length > 0) return `${prefix}${body}（${details.join('；')}）`;
    if (body) return `${prefix}${body}`;
    return `${prefix}${details.join('；')}`;
  }
  return JSON.stringify(u);
}

export type CompileBriefMode = 'initial' | 'rework_gate' | 'rework_device' | 'fidelity_fix';

export interface CompileBriefAtom {
  atom_id: string;
  kind: string;
  text: string;
  quote_ref: string;
}

export interface PlumbBriefCandidateStep {
  step_index: number;
  step_text: string;
  recalled_count: number;
  selected: { command: string; path: string; definition: string } | null;
  none_selected: boolean;
  review_required: boolean;
  rejected: boolean;
  note?: string;
  candidates: Array<{ command: string; path: string; summary: string }>;
}

export interface PlumbBriefCandidates {
  status: '未确认';
  decided_by: '模型';
  model_version: string | null;
  source_file?: string;
  steps: PlumbBriefCandidateStep[];
}

export interface CompileBriefV1 {
  schema: typeof COMPILE_BRIEF_SCHEMA;
  brief_sha256: string;
  identity: {
    autoid: string;
    item_id: string;
    index: string;
    title: string;
    product: string;
    version: string;
    build: string;
    run: string;
    knowledge_root: string;
    round: number;
    attempt_limit: number;
    remaining_attempts: number;
    created_at: string;
  };
  task: {
    mode: CompileBriefMode;
    target_plan_path: string;
    plan_exists: boolean;
    final_attempt: boolean;
    vary_form_required: boolean;
    directives: string[];
    user_rulings: Array<{ source: string; target: string; ruling: string; from_scope?: true }>;
    exclusions: string[];
  };
  materials: {
    original_case: {
      items_file: string;
      atoms: CompileBriefAtom[];
      recomposition: {
        receipt: string;
        case_id: string;
        equivalence_notes: string[];
        unresolved_unknowns: string[];
        expectation_slots: Array<{ slot: string; quote_ref: string; text: string }>;
      };
    };
    commands_and_manual: {
      policy_present: boolean;
      declared_policy: BriefPolicy | null;
      runner_cleanup?: {
        source: string;
        sha256: string;
        objects: string[];
        rule_count: number;
        order?: RunnerCleanup['order'];
      };
      named_commands: Array<{
        path: string;
        words: string;
        node_block: string[];
        parameters: BriefParameter[];
        inverse: {
          kind: 'paired_sibling' | 'prefix_rule' | 'read_only' | 'runner_cleanup' | 'none_declared';
          detail: string;
          node_block: string[];
        };
        read_only_forms: Array<{ prefix: string; node_block: string[] }>;
        sibling_syntaxes: {
          parent_path: string;
          where: string;
          total: number;
          shown: string[];
          truncated: number;
        };
      }>;
      referenced_other_nodes: Array<{
        path: string;
        where: string;
        included: boolean;
        node_block: string[];
      }>;
      missing_paths: string[];
      local_corpus: {
        commands_file: string;
        manual_file: string;
        search_note: string;
      };
      plumb_candidates?: PlumbBriefCandidates;
    };
    prerequisites: {
      status: 'extracted' | 'partial_recompose_only' | 'none_declared_or_found_in_recompose' | 'recompose_states_unreadable';
      from_recompose_states: Array<{
        atom: string;
        reason: string;
        prerequisites: string[];
        state: string;
        origin: typeof RECOMPOSE_STATES_ORIGIN;
      }>;
      from_product_catalog: string[];
      ancestor_command_hints: string[];
      manual_scan_required: boolean;
      scan_reason: string;
    };
    bed_facts: {
      bed_name: string | null;
      facts_status: 'extracted_from_frozen_manifest' | 'manifest_unavailable';
      segments: BedFacts['segments'];
      listeners: BedFacts['listeners'];
      blind: BedFacts['blind'];
      backends: BedFacts['backends'];
      unknowns: BedFacts['unknowns'];
      trigger_types: string[];
      forbidden_combinations: string[];
      execution_failure_markers: string[];
      plan_envelope: Record<string, unknown> | null;
    };
  };
  prior_device_history: {
    status: 'unavailable_from_hub' | 'none_found' | 'available';
    unavailable_reason?: string;
    disclaimer: string;
    match_key: 'autoid';
    max_entries: 6;
    entries: Array<{
      verification_run: string;
      plan_run: string;
      build: string;
      ended_at: string;
      verdict: string;
      apv_cmds: string[];
      attribution?: { layer: string; summary: string };
    }>;
  };
  round_history: {
    status: 'first_round_no_history' | 'has_prior_rounds';
    gate_refusals: PriorRoundRecord['gateRefusals'];
    accepted_notices?: PriorRoundRecord['acceptedNotices'];
    repeated_gate_codes: string[];
    device_evidence: {
      verification_run: string;
      job: string;
      verdict: string;
      runner_verdict?: string;
      pass_review_audit: { where: string; line: string } | null;
      syntax_rejected: Array<{ session?: string; prompt?: string; command: string; token?: string }>;
      execution_refused: Array<{ session?: string; prompt: string; command: string; reply: string[]; echo_cut?: true }>;
      step_excerpts: Array<{
        step_index?: number;
        source: string;
        command: string;
        found: boolean;
        session?: string;
        missing_notice?: string;
        excerpt?: string;
      }>;
      inline_tail: string;
      anomaly_lines: string[];
      log_file: string | null;
      session_files: Record<string, string | null>;
    } | null;
    prior_attribution: {
      round: number | null;
      round_recorded?: boolean;
      source_file: string;
      confidence: 'hypothesis';
      note: string;
      layer?: string;
      disposition?: string;
      judged: string;
      fix_direction: string;
      evidence_quotes: string[];
    } | null;
    unrecorded_attribution?: {
      round: null;
      round_recorded: false;
      source_file: string;
      confidence: 'hypothesis';
      note: string;
      layer?: string;
      disposition?: string;
      judged: string;
      fix_direction: string;
      evidence_quotes: string[];
    } | null;
    rounds: PriorRoundRecord[];
    streak: StreakAnalysis;
  };
}

export interface BuildCompileBriefInput {
  item: unknown;
  index: string;
  knowledge: BriefKnowledge;
  policy: BriefPolicy | null;
  runMeta?: {
    run?: string;
    product?: string;
    version?: string;
    build?: string;
    exclusions?: string[];
  };
  bedFacts?: BedFacts | null;
  triggerTypes?: readonly string[];
  forbiddenCombinations?: readonly string[];
  executionFailureMarkers?: readonly string[];
  runnerCleanup?: RunnerCleanup | null;
  round?: number;
  attemptLimit?: number;
  mode?: CompileBriefMode;
  targetPlanPath?: string;
  planExists?: boolean;
  priorRounds?: readonly PriorRoundRecord[];
  unrecordedAttribution?: PriorAttributionItem | null;
  scopeRulings?: ReadonlyArray<{target: string; ruling: string}>;
  scopeRulingsSource?: string;
  plumbCandidates?: PlumbBriefCandidates;
  createdAt?: string;
}

const KNOWN_TOP_KEYS = new Set([
  'schema',
  'brief_sha256',
  'identity',
  'task',
  'materials',
  'prior_device_history',
  'round_history',
]);

/** Extracts verbatim original atoms from an item JSON in the exact order Hub froze them. */
export function extractOriginalAtoms(item: unknown): CompileBriefAtom[] {
  if (!isRecord(item) || !isRecord(item.fields)) return [];
  const fields = item.fields;
  const rec = isRecord(fields.recomposition) && isRecord(fields.recomposition.record) ? fields.recomposition.record : null;
  if (rec && Array.isArray(rec.atoms)) {
    return rec.atoms.filter(isRecord).map((atom, i) => ({
      atom_id: typeof atom.id === 'string' ? atom.id : typeof atom.atom_id === 'string' ? atom.atom_id : `atom_${i + 1}`,
      kind: typeof atom.kind === 'string' ? atom.kind : 'action',
      text: typeof atom.text === 'string' ? atom.text : typeof atom.content === 'string' ? atom.content : '',
      quote_ref: typeof atom.reference === 'string' ? atom.reference : typeof atom.quote_ref === 'string' ? atom.quote_ref : '',
    }));
  }
  return [];
}

/** Computes SHA-256 over the canonical JSON serialization of a brief excluding `brief_sha256`. */
export function computeCompileBriefSha256(brief: Omit<CompileBriefV1, 'brief_sha256'> & { brief_sha256?: string }): string {
  const { brief_sha256: _ignored, ...rest } = brief;
  return createHash('sha256').update(canonicalJson(rest), 'utf8').digest('hex');
}

/** Builds a structured `compile-brief@1` JSON document with verbatim atoms, bed facts, and bounded round history. */
export function buildCompileBrief(input: BuildCompileBriefInput): CompileBriefV1 | null {
  const fields = isRecord(input.item) && isRecord(input.item.fields) ? input.item.fields : null;
  const recomposition = fields && isRecord(fields.recomposition) ? fields.recomposition : null;
  const record = recomposition && isRecord(recomposition.record) ? recomposition.record : null;
  if (!isRecord(input.item) || !fields || !record) return null;

  const round = input.round ?? 1;
  const attemptLimit = input.attemptLimit ?? MAX_ROUNDS;
  const mode: CompileBriefMode = input.mode ?? (round > 1 ? 'rework_device' : 'initial');
  const priorRounds = [...(input.priorRounds ?? [])].sort((a, b) => a.round - b.round);
  const unrecordedAttr: PriorAttributionItem | null = input.unrecordedAttribution ?? null;
  const streak = analyzeRoundHistory({
    currentRound: round,
    attemptLimit,
    rounds: priorRounds,
    unrecordedAttribution: unrecordedAttr,
  });

  const { commands, others, missing } = collectKnowledgeSets(recomposition!, record, input.knowledge);
  const policy = input.policy;

  const namedCommands = commands.map((path) => {
    const node = input.knowledge.nodes.get(path)!;
    const cmdWords = words(path);
    const parameters = [...(input.knowledge.parameters?.get(cmdWords) ?? [])];
    let inverse: CompileBriefV1['materials']['commands_and_manual']['named_commands'][number]['inverse'] = {
      kind: 'none_declared',
      detail: '产品没有为这条命令声明唯一的逆操作规则。',
      node_block: [],
    };
    const readOnlyForms: Array<{ prefix: string; node_block: string[] }> = [];

    const runnerHit = runnerCleanupMatch(input.runnerCleanup, cmdWords);
    const runnerNote = runnerHit
      ? `；另受运行器自动清理涵盖（${runnerCleanupRuleNote(input.runnerCleanup!, runnerHit)}），非已声明互逆取值时，在清配对象上可省略 cleanup:true，禁止把运行器收尾清理或保存命令写入 cleanup:true`
      : '';
    if (policy) {
      if (policy.read_only.some((prefix) => within(path, canonicalPath(prefix)))) {
        inverse = { kind: 'read_only', detail: '这条命令在产品声明的只读前缀下。', node_block: [] };
      } else {
        const paired = pairedSibling(policy, input.knowledge, path);
        const invRule = paired ? null : inverseOf(policy, path);
        if (paired) {
          inverse = {
            kind: 'paired_sibling',
            detail: `产品声明的互逆取值 ${paired.pair.join('/')}：同级的另一条命令${runnerHit?`；${runnerCleanupRuleNote(input.runnerCleanup!,runnerHit)}；仍须先在 cleanup:true 执行同设备逆操作，再交运行器清除`:''}`,
            node_block: nodeBlock(paired.node),
          };
        } else if (invRule) {
          const carried =
            invRule.rule.leading_parameters === undefined
              ? ''
              : `，逆操作带这条命令的前 ${invRule.rule.leading_parameters} 个参数`;
          const target = input.knowledge.nodes.get(invRule.path);
          inverse = {
            kind: 'prefix_rule',
            detail: `产品规则 ${invRule.rule.source_prefix} → ${invRule.rule.inverse_prefix}${carried}${runnerNote}`,
            node_block: target?.entries.length ? nodeBlock(target) : [],
          };
        } else if (runnerHit) {
          inverse = {
            kind: 'runner_cleanup',
            detail: `${runnerCleanupRuleNote(input.runnerCleanup!, runnerHit)}；不要求手写 cleanup:true，禁止把运行器收尾清理或保存命令放入 cleanup:true（需在用例过程内执行时只写进 main）。`,
            node_block: [],
          };
        }
        for (const prefix of policy.read_only) {
          const form = readOnlyForm(input.knowledge, canonicalPath(prefix), path);
          if (form) readOnlyForms.push({ prefix, node_block: nodeBlock(form) });
        }
      }
    } else if (runnerHit) {
      inverse = {
        kind: 'runner_cleanup',
        detail: `${runnerCleanupRuleNote(input.runnerCleanup!, runnerHit)}；不要求手写 cleanup:true，禁止把运行器收尾清理或保存命令放入 cleanup:true（需在用例过程内执行时只写进 main）。`,
        node_block: [],
      };
    }

    const parent = input.knowledge.nodes.get(path.slice(0, path.lastIndexOf('/')));
    const siblings = (parent?.children ?? [])
      .filter((child) => canonicalPath(child.path) !== path)
      .map((child) => input.knowledge.nodes.get(canonicalPath(child.path)))
      .filter((sibling): sibling is BriefNode => sibling !== undefined);
    const parentAt = parent ? input.knowledge.lines.get(canonicalPath(parent.path)) : undefined;
    const shownSiblings = siblings.slice(0, SIBLINGS).map((sibling) => {
      const syntax = syntaxLine(sibling);
      return syntax ?? `${words(canonicalPath(sibling.path))} …（下面有 ${sibling.children.length} 个子节点）`;
    });

    return {
      path,
      words: cmdWords,
      node_block: nodeBlock(node),
      parameters,
      inverse,
      read_only_forms: readOnlyForms,
      sibling_syntaxes: {
        parent_path: parent?.path ?? '',
        where: parentAt ? `knowledge/${parentAt.file} 第 ${parentAt.line} 行起` : 'knowledge/ 里按路径找',
        total: siblings.length,
        shown: shownSiblings,
        truncated: Math.max(0, siblings.length - SIBLINGS),
      },
    };
  });

  let quotedCount = 0;
  const referencedOtherNodes = others.map((path) => {
    const node = input.knowledge.nodes.get(path)!;
    const at = input.knowledge.lines.get(path);
    const blockLines = nodeBlock(node);
    const where = at ? `knowledge/${at.file} 第 ${at.line} 行起，共 ${at.count} 行` : 'knowledge/ 里按路径找';
    const included = quotedCount < QUOTED_BLOCKS && Buffer.byteLength(blockLines.join('\n')) <= QUOTED_BYTES;
    if (included) quotedCount++;
    return {
      path,
      where,
      included,
      node_block: included ? blockLines : [],
    };
  });

  const ledgers = isRecord(record.ledgers) ? record.ledgers : {};
  const equivalenceNotes: string[] = [];
  for (const row of Array.isArray(ledgers.adapted) ? ledgers.adapted : []) {
    if (isRecord(row) && typeof row.equivalence_reason === 'string' && row.equivalence_reason.trim()) {
      equivalenceNotes.push(row.equivalence_reason.trim());
    }
  }
  const unresolvedUnknowns = Array.isArray(record.unknowns)
    ? record.unknowns
        .map(formatRecomposeUnknown)
        .filter((s) => s.length > 0)
    : [];

  const expectationSlots = (Array.isArray(record.expectation_slots) ? record.expectation_slots : [])
    .filter(isRecord)
    .filter((slot) => typeof slot.slot === 'string')
    .map((slot) => ({
      slot: String(slot.slot),
      quote_ref: typeof slot.reference === 'string' ? slot.reference : '',
      text: typeof slot.text === 'string' ? slot.text : '',
    }));

  // Prerequisites and user rulings live on record.sources.states (recompose-record@1):
  // submit-records writes that array; recompose/SKILL says a settled ruling's reason starts with
  // 「使用者决定：」; recompose-adjudication only validates separate decision review items and sets
  // sources.states[].adjudicated_by to a rec: digest — it never writes record.adjudication.states
  // (that key is absent from recompose-record@1 and from all plan*-run items in work-ops-run29).
  const sources = isRecord(record.sources) ? record.sources : null;
  const statesReadable = sources !== null && Array.isArray(sources.states);
  const statesSource: unknown[] = sources !== null && Array.isArray(sources.states) ? sources.states : [];
  const fromRecomposeStates: Array<{
    atom: string;
    reason: string;
    prerequisites: string[];
    state: string;
    origin: typeof RECOMPOSE_STATES_ORIGIN;
  }> = [];
  let userRulings: Array<{ source: string; target: string; ruling: string }> = [];
  for (const st of statesSource.filter(isRecord)) {
    const atom = typeof st.atom === 'string' ? st.atom : '';
    const reason = typeof st.reason === 'string' ? st.reason : '';
    const state = typeof st.state === 'string' ? st.state : '';
    const prereqs = Array.isArray(st.prerequisites) ? st.prerequisites.filter((p): p is string => typeof p === 'string' && p.length > 0) : [];
    if (state === 'missing_prerequisite' || prereqs.length > 0) {
      fromRecomposeStates.push({ atom, reason, prerequisites: prereqs, state, origin: RECOMPOSE_STATES_ORIGIN });
    }
    if (state === 'settled' && reason.startsWith('使用者决定：')) {
      userRulings.push({ source: RECOMPOSE_STATES_ORIGIN, target: atom, ruling: reason });
    }
  }
  userRulings = mergeScopeRulings(userRulings, input.scopeRulings ?? [], new Set([input.item.id, fields.autoid, isRecord(record?.case) ? record.case.id : undefined]), input.scopeRulingsSource ?? SCOPE_RULINGS_ORIGIN);
  const prerequisitesBlock: CompileBriefV1['materials']['prerequisites'] = !statesReadable
    ? {
        status: 'recompose_states_unreadable',
        from_recompose_states: [],
        from_product_catalog: [],
        ancestor_command_hints: [],
        manual_scan_required: true,
        scan_reason: PREREQ_STATES_UNREADABLE_REASON,
      }
    : {
        status: fromRecomposeStates.length > 0 ? 'partial_recompose_only' : 'none_declared_or_found_in_recompose',
        from_recompose_states: fromRecomposeStates,
        from_product_catalog: [],
        ancestor_command_hints: [],
        manual_scan_required: true,
        scan_reason: fromRecomposeStates.length ? PREREQ_PARTIAL_RECOMPOSE_REASON : PREREQ_SCAN_REASON,
      };

  const allGateRefusals = priorRounds.flatMap((r) => r.gateRefusals);
  const allAcceptedNotices = priorRounds.flatMap((r) => r.acceptedNotices ?? []);
  const repeatedGateCodes = consecutiveRepeatedGateCodes(priorRounds);

  const latestDevice = [...priorRounds].reverse().find((r) => r.deviceEvidence)?.deviceEvidence ?? null;
  const latestAttribution: PriorAttributionItem | null = [...priorRounds].reverse().find((r) => r.attribution)?.attribution ?? null;

  // InfoTest provenance:
  // - `compile_engine/briefs.py:2982-2985`: final-attempt warning rendered in Chinese (no bare English "FINAL attempt").
  // - `compile_engine/remedies.py:39-42`: `vary_form` triggers only when `disposition === 'frozen'`.
  // - `compile_engine/briefs.py:2681-2690` & `compile_engine/rejection_history.py:3-40`: `structural_rejection_disclosure` triggers only on two consecutive unaccepted gate refusals with the same code.
  // - `compile_engine/briefs.py:2792-2820`: recompile device failures report diagnostics without auto-setting `vary_form_required`.
  const directives: string[] = [];
  if (streak.finalAttempt) {
    directives.push(`最后一次机会（第 ${round}/${attemptLimit} 轮）：已达本案重试上限，务必核对全部前置与期望实现。`);
  }
  if (streak.varyFormRequired || repeatedGateCodes.length > 0) {
    directives.push('失败分析已冻结或机械规则连续同码未受理，本轮须核查手册命令形态与前置条件，禁止仅微调字词重复同一失败写法。');
  }
  if (repeatedGateCodes.length > 0) {
    directives.push(`机械规则错码 ${repeatedGateCodes.join('、')} 连续多轮未受理，须对照路径与字段要求逐项消除。`);
  }

  const caseId = record && isRecord(record.case) && typeof record.case.id === 'string' ? record.case.id : '';
  const autoid = typeof fields.autoid === 'string' ? fields.autoid : String(input.item.id ?? '');
  const bedName = input.bedFacts?.bed ?? null;

  const bodyWithoutSha: Omit<CompileBriefV1, 'brief_sha256'> = {
    schema: COMPILE_BRIEF_SCHEMA,
    identity: {
      autoid,
      item_id: String(input.item.id ?? ''),
      index: input.index,
      title: typeof fields.title === 'string' ? fields.title : '',
      product: input.runMeta?.product ?? '',
      version: input.runMeta?.version ?? '',
      build: input.runMeta?.build ?? '',
      run: input.runMeta?.run ?? '',
      knowledge_root: input.knowledge.root,
      round,
      attempt_limit: attemptLimit,
      remaining_attempts: streak.remainingAttempts,
      created_at: input.createdAt ?? new Date().toISOString(),
    },
    task: {
      mode,
      target_plan_path: input.targetPlanPath ?? `plans/${input.index}.json`,
      plan_exists: input.planExists ?? priorRounds.some((r) => Boolean(r.plan)),
      final_attempt: streak.finalAttempt,
      vary_form_required: streak.varyFormRequired,
      directives,
      user_rulings: userRulings,
      exclusions: [...(input.runMeta?.exclusions ?? [])],
    },
    materials: {
      original_case: {
        items_file: `items/${input.index}.json`,
        atoms: extractOriginalAtoms(input.item),
        recomposition: {
          receipt: typeof recomposition!.receipt === 'string' ? recomposition!.receipt : '',
          case_id: caseId,
          equivalence_notes: equivalenceNotes,
          unresolved_unknowns: unresolvedUnknowns,
          expectation_slots: expectationSlots,
        },
      },
      commands_and_manual: {
        policy_present: policy !== null,
        declared_policy: policy,
        ...(input.runnerCleanup
          ? {
              runner_cleanup: {
                source: input.runnerCleanup.source,
                sha256: input.runnerCleanup.sha256,
                objects: [...input.runnerCleanup.objects],
                rule_count: input.runnerCleanup.rules.length,
                ...(input.runnerCleanup.order ? { order: input.runnerCleanup.order } : {}),
              },
            }
          : {}),
        named_commands: namedCommands,
        referenced_other_nodes: referencedOtherNodes,
        missing_paths: missing.map((p) => decodeURI(p)),
        local_corpus: {
          commands_file: 'knowledge/commands.txt',
          manual_file: 'knowledge/manual.txt',
          search_note: '简报只收录重组直接点到的节点；未收录章节须用 grep 检索上述本地文件。',
        },
        ...(input.plumbCandidates ? { plumb_candidates: input.plumbCandidates } : {}),
      },
      prerequisites: prerequisitesBlock,
      bed_facts: {
        bed_name: bedName,
        facts_status: input.bedFacts ? 'extracted_from_frozen_manifest' : 'manifest_unavailable',
        segments: input.bedFacts?.segments ?? [],
        listeners: input.bedFacts?.listeners ?? [],
        blind: input.bedFacts?.blind ?? [],
        backends: input.bedFacts?.backends ?? [],
        unknowns: input.bedFacts?.unknowns ?? [],
        trigger_types: [...(input.triggerTypes ?? [])],
        forbidden_combinations: [...(input.forbiddenCombinations ?? [])],
        execution_failure_markers: [...(input.executionFailureMarkers ?? [])],
        plan_envelope: planEnvelope(input.item, bedName),
      },
    },
    prior_device_history: {
      status: 'unavailable_from_hub',
      unavailable_reason: PRIOR_DEVICE_HISTORY_UNAVAILABLE_REASON,
      disclaimer: PRIOR_DEVICE_HISTORY_DISCLAIMER,
      match_key: 'autoid',
      max_entries: 6,
      entries: [],
    },
    round_history: {
      status: round <= 1 && priorRounds.length === 0 && !unrecordedAttr ? 'first_round_no_history' : 'has_prior_rounds',
      gate_refusals: allGateRefusals,
      ...(allAcceptedNotices.length > 0 ? { accepted_notices: allAcceptedNotices } : {}),
      repeated_gate_codes: repeatedGateCodes,
      device_evidence: latestDevice
        ? {
            verification_run: latestDevice.verificationRun,
            job: latestDevice.job,
            verdict: latestDevice.verdict,
            ...(latestDevice.runnerVerdict ? { runner_verdict: latestDevice.runnerVerdict } : {}),
            pass_review_audit: latestDevice.passReview,
            syntax_rejected: latestDevice.syntaxRejected,
            execution_refused: latestDevice.executionRefused,
            step_excerpts: latestDevice.stepExcerpts.map((s) => ({
              ...(s.stepIndex !== undefined ? { step_index: s.stepIndex } : {}),
              source: s.source,
              command: s.commandText,
              found: s.found,
              ...(s.sessionName ? { session: s.sessionName } : {}),
              ...(s.missingNotice ? { missing_notice: s.missingNotice } : {}),
              ...(s.excerpt ? { excerpt: s.excerpt } : {}),
            })),
            inline_tail: latestDevice.inlineTail,
            anomaly_lines: latestDevice.anomalyLines,
            log_file: latestDevice.logFile,
            session_files: latestDevice.sessionFiles,
          }
        : null,
      prior_attribution: latestAttribution
        ? {
            round: latestAttribution.round,
            round_recorded: latestAttribution.roundRecorded ?? latestAttribution.round !== null,
            source_file: latestAttribution.sourceFile,
            confidence: 'hypothesis',
            note: '以下失败分析仅是失败分析子代理或交接记录提出的未确认假设；编写前须自行核对上述原始设备输出再采纳或推翻。',
            ...(latestAttribution.layer ? { layer: latestAttribution.layer } : {}),
            ...(latestAttribution.disposition ? { disposition: latestAttribution.disposition } : {}),
            judged: latestAttribution.judged,
            fix_direction: latestAttribution.remedy || latestAttribution.fixDirection || '',
            evidence_quotes: latestAttribution.evidenceQuotes,
          }
        : null,
      ...(unrecordedAttr
        ? {
            unrecorded_attribution: {
              round: null as null,
              round_recorded: false as const,
              source_file: unrecordedAttr.sourceFile,
              confidence: 'hypothesis' as const,
              note: '该分析来自未记录轮次的交付备注/失败分析文件，归作未确认假设，不代表第 1 轮结论。',
              ...(unrecordedAttr.layer ? { layer: unrecordedAttr.layer } : {}),
              ...(unrecordedAttr.disposition ? { disposition: unrecordedAttr.disposition } : {}),
              judged: unrecordedAttr.judged,
              fix_direction: unrecordedAttr.remedy || unrecordedAttr.fixDirection || '',
              evidence_quotes: unrecordedAttr.evidenceQuotes,
            },
          }
        : {}),
      rounds: priorRounds,
      streak,
    },
  };

  return {
    ...bodyWithoutSha,
    brief_sha256: computeCompileBriefSha256(bodyWithoutSha),
  };
}

/** Deterministic offline checks for `compile-brief@1` before handing a brief to a writer subagent. */
export function validateCompileBrief(value: unknown, expectedItem?: unknown): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  if (!isRecord(value)) return { ok: false, problems: ['简报不是 JSON 对象'] };
  for (const key of Object.keys(value)) {
    if (!KNOWN_TOP_KEYS.has(key)) problems.push(`发现未声明的顶层字段：${key}`);
  }
  if (value.schema !== COMPILE_BRIEF_SCHEMA) problems.push(`schema 必须为 ${COMPILE_BRIEF_SCHEMA}`);

  const serializedBytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
  if (serializedBytes > COMPILE_BRIEF_MAX_BYTES) {
    problems.push(`简报体积 ${serializedBytes} 字节超过上限 ${COMPILE_BRIEF_MAX_BYTES} 字节`);
  }

  const identity = isRecord(value.identity) ? value.identity : null;
  const task = isRecord(value.task) ? value.task : null;
  const materials = isRecord(value.materials) ? value.materials : null;
  const priorHistory = isRecord(value.prior_device_history) ? value.prior_device_history : null;
  const roundHistory = isRecord(value.round_history) ? value.round_history : null;
  if (!identity || !task || !materials || !priorHistory || !roundHistory) {
    problems.push('缺少核心顶层区块（identity/task/materials/prior_device_history/round_history）');
    return { ok: false, problems };
  }

  const round = typeof identity.round === 'number' ? identity.round : -1;
  const limit = typeof identity.attempt_limit === 'number' ? identity.attempt_limit : -1;
  const remaining = typeof identity.remaining_attempts === 'number' ? identity.remaining_attempts : -1;
  if (!Number.isInteger(round) || round < 1) problems.push('identity.round 必须为正整数');
  if (!Number.isInteger(limit) || limit < 1) problems.push('identity.attempt_limit 必须为正整数');
  if (round >= 1 && limit >= 1 && remaining !== Math.max(0, limit - round)) {
    problems.push('identity.remaining_attempts 必须等于 max(0, attempt_limit - round)');
  }

  if (typeof value.brief_sha256 === 'string') {
    try {
      const expectedSha = computeCompileBriefSha256(value as unknown as CompileBriefV1);
      if (value.brief_sha256 !== expectedSha) problems.push('brief_sha256 与规范序列化摘要不一致（简报可能已陈旧或被手工修改）');
    } catch {
      problems.push('brief_sha256 计算失败：简报包含非法 JSON 值');
    }
  } else {
    problems.push('缺少 brief_sha256');
  }

  const orig = isRecord(materials.original_case) ? materials.original_case : null;
  const atoms = orig && Array.isArray(orig.atoms) ? orig.atoms : null;
  if (!atoms) {
    problems.push('materials.original_case.atoms 必须是数组');
  } else if (expectedItem !== undefined) {
    const expectedAtoms = extractOriginalAtoms(expectedItem);
    if (atoms.length !== expectedAtoms.length) {
      problems.push(`original_case.atoms 条数（${atoms.length}）与原始条目不一致（期望 ${expectedAtoms.length}）`);
    } else {
      for (let i = 0; i < expectedAtoms.length; i++) {
        const a = isRecord(atoms[i]) ? atoms[i] : {};
        if (a.text !== expectedAtoms[i].text || a.quote_ref !== expectedAtoms[i].quote_ref) {
          problems.push(`original_case.atoms[${i}] 与原始条目原文或引用不一致`);
          break;
        }
      }
    }
  }

  const cmdManual = isRecord(materials.commands_and_manual) ? materials.commands_and_manual : null;
  const rootHex = typeof identity.knowledge_root === 'string' && /^[0-9a-f]{64}$/.test(identity.knowledge_root) ? identity.knowledge_root : '';
  if (cmdManual) {
    const namedCmds = Array.isArray(cmdManual.named_commands) ? cmdManual.named_commands : [];
    for (const nc of namedCmds) {
      if (!isRecord(nc)) continue;
      if (isRecord(nc.sibling_syntaxes) && Array.isArray(nc.sibling_syntaxes.shown) && nc.sibling_syntaxes.shown.length > SIBLINGS) {
        problems.push(`sibling_syntaxes.shown 超过 ${SIBLINGS} 条上限`);
      }
      if (rootHex && Array.isArray(nc.node_block)) {
        for (const line of nc.node_block) {
          if (typeof line === 'string' && line.includes('引用 tree:') && !line.includes(`tree:${rootHex}/`)) {
            problems.push(`命令节点引用未锚定当前 knowledge_root ${rootHex}`);
          }
        }
      }
    }
    const otherNodes = Array.isArray(cmdManual.referenced_other_nodes) ? cmdManual.referenced_other_nodes : [];
    const includedOthers = otherNodes.filter((n) => isRecord(n) && n.included === true);
    if (includedOthers.length > QUOTED_BLOCKS) problems.push(`referenced_other_nodes included 条数超过 ${QUOTED_BLOCKS}`);
    for (const n of includedOthers) {
      if (isRecord(n) && Array.isArray(n.node_block) && Buffer.byteLength(n.node_block.join('\n')) > QUOTED_BYTES) {
        problems.push(`referenced_other_nodes 单块字节数超过 ${QUOTED_BYTES}`);
      }
    }
    if (cmdManual.plumb_candidates !== undefined) {
      const pc = isRecord(cmdManual.plumb_candidates) ? cmdManual.plumb_candidates : null;
      if (!pc || pc.status !== '未确认' || pc.decided_by !== '模型' || !Array.isArray(pc.steps)) {
        problems.push('commands_and_manual.plumb_candidates 必须标明 status=未确认、decided_by=模型 且含 steps 数组');
      }
    }
  }

  const prereqs = isRecord(materials.prerequisites) ? materials.prerequisites : null;
  if (!prereqs) {
    problems.push('缺少 materials.prerequisites');
  } else {
    const hasRecomp = Array.isArray(prereqs.from_recompose_states) && prereqs.from_recompose_states.length > 0;
    const hasCatalog = Array.isArray(prereqs.from_product_catalog) && prereqs.from_product_catalog.length > 0;
    if (!hasRecomp && !hasCatalog) {
      if (prereqs.status === 'recompose_states_unreadable') {
        if (prereqs.manual_scan_required !== true || typeof prereqs.scan_reason !== 'string' || !prereqs.scan_reason.includes('sources.states')) {
          problems.push('读不到 sources.states 时 prerequisites.status 必须为 recompose_states_unreadable，且 scan_reason 须写明该路径');
        }
      } else if (prereqs.status !== 'none_declared_or_found_in_recompose' || prereqs.manual_scan_required !== true) {
        problems.push('前置为空时 prerequisites.status 必须为 none_declared_or_found_in_recompose 且 manual_scan_required === true');
      }
    }
    if (hasRecomp && !hasCatalog && (prereqs.status !== 'partial_recompose_only' || prereqs.manual_scan_required !== true)) problems.push('仅重组前置要求 partial_recompose_only 且仍须核对手册');
    if (hasCatalog && prereqs.status !== 'extracted') problems.push('已提取产品目录前置要求 extracted');
  }

  const entries = Array.isArray(priorHistory.entries) ? priorHistory.entries : null;
  if (!entries || entries.length > 6) problems.push('prior_device_history.entries 必须是不超过 6 条的数组');
  if (priorHistory.match_key !== 'autoid') problems.push('prior_device_history.match_key 必须严格为 autoid');
  if (priorHistory.disclaimer !== PRIOR_DEVICE_HISTORY_DISCLAIMER) problems.push('prior_device_history.disclaimer 必须携带标准非权威声明');
  if (entries && entries.length === 0 && priorHistory.status !== 'unavailable_from_hub' && priorHistory.status !== 'none_found') {
    problems.push('prior_device_history.entries 为空时 status 不得为 available');
  }

  if (roundHistory.device_evidence !== null && isRecord(roundHistory.device_evidence)) {
    const tail = typeof roundHistory.device_evidence.inline_tail === 'string' ? roundHistory.device_evidence.inline_tail : '';
    const anomalies = Array.isArray(roundHistory.device_evidence.anomaly_lines) ? roundHistory.device_evidence.anomaly_lines : [];
    if (tail.length > INLINE_TAIL_CHARS) problems.push(`device_evidence.inline_tail 超过 ${INLINE_TAIL_CHARS} 字符上限`);
    if (anomalies.length > MAX_ANOMALY_LINES) problems.push(`device_evidence.anomaly_lines 超过 ${MAX_ANOMALY_LINES} 条上限`);
  }
  if (roundHistory.prior_attribution !== null && isRecord(roundHistory.prior_attribution)) {
    if (roundHistory.prior_attribution.confidence !== 'hypothesis') {
      problems.push('round_history.prior_attribution.confidence 必须严格为 hypothesis');
    }
  }
  if (roundHistory.unrecorded_attribution !== undefined && roundHistory.unrecorded_attribution !== null && isRecord(roundHistory.unrecorded_attribution)) {
    if (roundHistory.unrecorded_attribution.confidence !== 'hypothesis') {
      problems.push('round_history.unrecorded_attribution.confidence 必须严格为 hypothesis');
    }
  }

  if (round > 1 && (task.mode === 'rework_device' || task.mode === 'rework_gate')) {
    if (roundHistory.status !== 'has_prior_rounds') {
      problems.push('第 2 轮及以上返工时 round_history.status 不能为 first_round_no_history');
    }
    const gateCount = Array.isArray(roundHistory.gate_refusals) ? roundHistory.gate_refusals.length : 0;
    const roundsCount = Array.isArray(roundHistory.rounds) ? roundHistory.rounds.length : 0;
    const hasUnrecorded = isRecord(roundHistory.unrecorded_attribution);
    if (gateCount === 0 && roundHistory.device_evidence === null && roundsCount === 0 && !hasUnrecorded) {
      problems.push('第 2 轮及以上返工简报至少应包含上一轮机械规则未受理、设备证据、历轮计划或未记录轮次失败分析之一');
    }
    const streak = isRecord(roundHistory.streak) ? roundHistory.streak : null;
    const repeatedCodes = Array.isArray(roundHistory.repeated_gate_codes) ? roundHistory.repeated_gate_codes.length : 0;
    const roundsList = Array.isArray(roundHistory.rounds) ? roundHistory.rounds : [];
    const hasFrozen =
      roundsList.some((r) => isRecord(r) && isRecord(r.attribution) && r.attribution.disposition === 'frozen') ||
      (isRecord(roundHistory.unrecorded_attribution) && roundHistory.unrecorded_attribution.disposition === 'frozen');
    if ((repeatedCodes > 0 || hasFrozen || streak?.varyFormRequired === true) && task.vary_form_required !== true) {
      problems.push('机械规则连续同码未受理或失败分析已冻结时 task.vary_form_required 必须为 true');
    }
  }

  return { ok: problems.length === 0, problems };
}

function mergeScopeRulings(existing: CompileBriefV1['task']['user_rulings'], rulings: ReadonlyArray<{target:string;ruling:string}>, targets: ReadonlySet<unknown>, source: string): CompileBriefV1['task']['user_rulings'] {
  const result = [...existing];
  for (const row of rulings) {
    if (!targets.has(row.target) || !row.ruling.startsWith('使用者决定：') || !row.ruling.slice('使用者决定：'.length).trim()) throw new CallFailure('invalid_parameters','scope.md 的裁定未绑定本条身份或明确记录标记','按本条完整标识和明确记录标记修正后重试');
    if (!result.some(old => old.target === row.target && old.ruling === row.ruling)) result.push({source,...row,from_scope:true});
  }
  return result;
}

/** Derive current instructions without modifying the sealed brief file or recomposition record. */
export function withScopeUserRulings(brief: CompileBriefV1, rulings: ReadonlyArray<{target:string;ruling:string}>, source = SCOPE_RULINGS_ORIGIN): CompileBriefV1 {
  const result = structuredClone(brief);
  const targets = new Set([brief.identity.item_id, brief.identity.autoid, brief.materials.original_case.recomposition.case_id]);
  result.task.user_rulings = mergeScopeRulings(result.task.user_rulings.filter(row => row.from_scope !== true && row.source !== SCOPE_RULINGS_ORIGIN), rulings, targets, source);
  result.brief_sha256 = computeCompileBriefSha256(result);
  return result;
}

/** Renders prerequisite scan status plus every extracted item from `from_recompose_states`, catalog, and ancestor hints. */
export function renderPrerequisiteLines(prereqs: CompileBriefV1['materials']['prerequisites']): string[] {
  // Presence is established by structured entries, never by an older prose summary.
  const explanation = prereqs.status === 'recompose_states_unreadable' ? PREREQ_STATES_UNREADABLE_REASON
    : prereqs.from_product_catalog.length ? `已从产品目录提取 ${prereqs.from_product_catalog.length} 条前置；仍须核对同构建手册正文与示例。`
    : prereqs.from_recompose_states.length ? PREREQ_PARTIAL_RECOMPOSE_REASON : PREREQ_SCAN_REASON;
  const out: string[] = [...wrapProseLine(`- 前置检查状态（${prereqs.status}）：`, explanation)];
  for (const pre of prereqs.from_recompose_states) {
    const origin = pre.origin ?? RECOMPOSE_STATES_ORIGIN;
    const stateLabel = pre.state ? `，状态 ${pre.state}` : '';
    const header = `  · 出处：用例重组记录（${origin}）${stateLabel}，原子 ${pre.atom}：`;
    out.push(...wrapProseLine(header, pre.reason || '已声明运行前置'));
    for (const line of pre.prerequisites) {
      out.push(...wrapProseLine('    - ', line));
    }
  }
  for (const item of prereqs.from_product_catalog) {
    out.push(...wrapProseLine('  · 出处：产品目录：', item));
  }
  for (const hint of prereqs.ancestor_command_hints) {
    out.push(...wrapProseLine('  · 出处：命令祖先提示：', hint));
  }
  return out;
}

/** Renders prior device verification history honestly across `unavailable_from_hub`, `none_found`, and `available`. */
export function renderPriorDeviceHistoryLines(
  priorHistory: CompileBriefV1['prior_device_history'],
  opts: { prefixKey?: string } = {},
): string[] {
  const statusLabel = opts.prefixKey ? `${opts.prefixKey}=${priorHistory.status}` : priorHistory.status;
  if (priorHistory.status === 'unavailable_from_hub') {
    return wrapProseLine(
      `- 同用例历史上机记录（${statusLabel}）：`,
      priorHistory.unavailable_reason ?? PRIOR_DEVICE_HISTORY_UNAVAILABLE_REASON,
    );
  }
  if (priorHistory.status === 'none_found') {
    return wrapProseLine(
      `- 同用例历史上机记录（${statusLabel}）：`,
      `Hub 已按 ${priorHistory.match_key} 查询，未找到此前已上机验证记录（0 条）。`,
    );
  }
  const out: string[] = [
    ...wrapProseLine(
      `- 同用例历史上机记录（${statusLabel}，共 ${priorHistory.entries.length} 条）：`,
      priorHistory.disclaimer,
    ),
  ];
  if (priorHistory.entries.length === 0) {
    out.push('  · （状态为 available 但条目列表为空，未提供任何历史记录）');
    return out;
  }
  for (const entry of priorHistory.entries) {
    const cmds = entry.apv_cmds.length > 0 ? entry.apv_cmds.join(' ; ') : '无';
    const attr = entry.attribution ? `；归因（${entry.attribution.layer}）：${entry.attribution.summary}` : '';
    out.push(
      ...wrapProseLine(
        `  · [运行 ${entry.verification_run} | 计划 ${entry.plan_run} | 构建 ${entry.build} | 结束 ${entry.ended_at} | 结论 ${entry.verdict}] 命令：`,
        `${cmds}${attr}`,
      ),
    );
  }
  return out;
}

/** Renders test-bed topology, device-scoped roles (`device@address`), unknowns, triggers, forbidden pairs, and failure markers. */
export function renderBedFactsLines(
  bf: CompileBriefV1['materials']['bed_facts'],
  opts: { heading?: boolean } = {},
): string[] {
  const out: string[] = [];
  if (bf.facts_status === 'manifest_unavailable') {
    if (opts.heading) out.push('## 测试环境事实（manifest_unavailable）');
    out.push(
      ...wrapProseLine(
        `- 测试环境事实（${bf.bed_name ?? '未指定'} / manifest_unavailable）：`,
        '当前运行目录未提供冻结环境清单或 profile 未选定可用测试环境，无法列出网段、监听候选与盲区；编写前须核对实际测试环境配置，禁止猜测地址。',
      ),
    );
  } else {
    if (opts.heading) out.push(`## 测试环境事实（${bf.bed_name ?? '未知'}）`);
    const segDesc =
      bf.segments.length > 0
        ? bf.segments
            .map((s) => `${s.subnet}(${s.family})[${s.members.map((m) => `${m.device}(${m.type})@${m.address}`).join(', ')}]`)
            .join('；')
        : '无';
    const prefix = opts.heading ? `- 网段数 ${bf.segments.length}：` : `- 测试环境 ${bf.bed_name ?? '未知'}（网段数 ${bf.segments.length}）：`;
    out.push(...wrapProseLine(prefix, segDesc));
    out.push(
      ...wrapProseLine(
        '  · 监听候选（listeners）：',
        bf.listeners.map((l) => `${l.device}@${l.address}`).join('、') || '无',
      ),
    );
    out.push(
      ...wrapProseLine(
        '  · 盲区禁用（blind，禁用作监听/触发目标）：',
        bf.blind.map((b) => `${b.device}@${b.address}`).join('、') || '无',
      ),
    );
    out.push(
      ...wrapProseLine(
        '  · 后端服务/服务器（backends）：',
        bf.backends.map((b) => `${b.device}@${b.address}${b.service ? `(${b.service})` : ''}`).join('、') || '无',
      ),
    );
    if (bf.unknowns.length > 0) {
      out.push(
        ...wrapProseLine(
          '  · 未知接口设备（unknowns）：',
          bf.unknowns.map((u) => `${u.device}（${u.reason}）`).join('；'),
        ),
      );
    }
  }
  if (bf.trigger_types.length > 0) {
    out.push(...wrapProseLine('  · 可用触发设备类型（trigger_types）：', bf.trigger_types.join('、')));
  }
  if (bf.forbidden_combinations.length > 0) {
    out.push(...wrapProseLine('  · 禁止组合（forbidden_combinations）：', bf.forbidden_combinations.join('；')));
  }
  if (bf.execution_failure_markers.length > 0) {
    out.push(...wrapProseLine('  · 声明的执行失败标志原话：', bf.execution_failure_markers.join(' | ')));
  }
  return out;
}

/** Renders recomposition unresolved unknowns, equivalence notes, run exclusions, and missing knowledge paths. */
export function renderSupplementaryDisclosureLines(brief: CompileBriefV1): string[] {
  const out: string[] = [];
  const { unresolved_unknowns: unknowns, equivalence_notes: eqNotes } = brief.materials.original_case.recomposition;
  if (unknowns.length > 0) {
    out.push(`- 重组未决项（unresolved_unknowns，共 ${unknowns.length} 条）：`);
    for (const u of unknowns) {
      out.push(...wrapProseLine('  · ', u));
    }
  }
  if (eqNotes.length > 0) {
    out.push(`- 重组等价替换说明（equivalence_notes，共 ${eqNotes.length} 条）：`);
    for (const note of eqNotes) {
      out.push(...wrapProseLine('  · ', note));
    }
  }
  if (brief.task.exclusions.length > 0) {
    out.push(...wrapProseLine('- 运行参数排除项（exclusions）：', brief.task.exclusions.join('、')));
  }
  if (brief.materials.commands_and_manual.missing_paths.length > 0) {
    out.push(
      ...wrapProseLine(
        '- 知识树未命中路径（须 grep 本地 knowledge/commands.txt 或 knowledge/manual.txt）：',
        brief.materials.commands_and_manual.missing_paths.join('、'),
      ),
    );
  }
  return out;
}

/** Renders a `compile-brief@1` object into deterministic Markdown (static materials + per-round history). */
export function renderCompileBriefMd(brief: CompileBriefV1): string {
  const { identity, task, materials, prior_device_history: priorHistory, round_history: roundHistory } = brief;
  const out: string[] = [
    `# 编写简报 ${identity.index}（第 ${identity.round}/${identity.attempt_limit} 轮，模式 ${task.mode}）：${identity.title}`,
    '',
    `- 原始条目：${identity.item_id}（autoid: ${identity.autoid}）；锁定知识根：${identity.knowledge_root}；简报摘要：${brief.brief_sha256.slice(0, 12)}`,
    `- 目标计划文件：${task.target_plan_path}；剩余重交机会：${identity.remaining_attempts}${task.final_attempt ? '（最后一次机会）' : ''}`,
    '',
  ];

  if (task.directives.length > 0) {
    out.push('## 本轮程序提示（确定性事实与约束）');
    for (const d of task.directives) out.push(`- ${d}`);
    out.push('');
  }

  if (task.user_rulings.length) out.push('## 使用者决定与记录来源', ...task.user_rulings.map(row => `- [${row.target}]（${row.source}）：${row.ruling}`), '');

  out.push('## 前置条件与历史可用性（诚实披露）');
  out.push(...renderPrerequisiteLines(materials.prerequisites), ...renderPriorDeviceHistoryLines(priorHistory), ...renderBedFactsLines(materials.bed_facts, {heading:true}), ...renderSupplementaryDisclosureLines(brief), '');

  if (roundHistory.status === 'has_prior_rounds' && (roundHistory.rounds.length > 0 || roundHistory.unrecorded_attribution)) {
    const ua = roundHistory.unrecorded_attribution
      ? {
          round: null,
          roundRecorded: false,
          sourceFile: roundHistory.unrecorded_attribution.source_file,
          confidence: 'hypothesis' as const,
          judged: roundHistory.unrecorded_attribution.judged,
          remedy: roundHistory.unrecorded_attribution.fix_direction,
          ...(roundHistory.unrecorded_attribution.layer ? { layer: roundHistory.unrecorded_attribution.layer } : {}),
          ...(roundHistory.unrecorded_attribution.disposition ? { disposition: roundHistory.unrecorded_attribution.disposition } : {}),
          evidenceQuotes: roundHistory.unrecorded_attribution.evidence_quotes,
        }
      : undefined;
    out.push(
      renderPriorRoundsMarkdown({
        caseRef: identity.autoid || identity.item_id,
        currentRound: identity.round,
        rounds: roundHistory.rounds,
        streak: roundHistory.streak,
        ...(ua ? { unrecordedAttribution: ua } : {}),
      }),
      '',
    );
  }

  out.push(`## 重组记录原始动作与期望（共 ${materials.original_case.atoms.length} 条，原样保留）`);
  for (const atom of materials.original_case.atoms) {
    out.push(`- [${atom.atom_id} | ${atom.kind}] ${atom.text}${atom.quote_ref ? ` (${atom.quote_ref})` : ''}`);
  }

  out.push('', `## 重组记录点到的命令（${materials.commands_and_manual.named_commands.length} 条）`);
  const rc = materials.commands_and_manual.runner_cleanup;
  if (rc) {
    const tailText = rc.order?.tail.length ? `；以下动作放收尾末尾：${rc.order.tail.join('、')}` : '';
    const beforeText = rc.order?.before.length ? `；顺序约束：${rc.order.before.map(([a, b]) => `${a} 先于 ${b}`).join('、')}` : '';
    out.push(
      `- 执行器自动清理（${rc.source}@${rc.sha256.slice(0, 12)}）：对清配对象 ${rc.objects.join('、')}，自第 2 条用例开始前及整本关闭连接时按 cmd_config 命令行逐条比前缀、第一条命中即用（共 ${rc.rule_count} 条规则${tailText}${beforeText}）；未命中规则或不在清配对象上的设备改动仍须在 cleanup:true 手写同设备逆序逆操作，运行器自己的收尾清除或保存命令禁止写入 cleanup:true（需在用例中执行时只写进 main）。`,
    );
  }
  for (const cmd of materials.commands_and_manual.named_commands) {
    out.push('', `### ${cmd.words}`, ...cmd.node_block);
    if (cmd.parameters.length > 0) {
      out.push(`手册对这条命令各参数的说明（${cmd.parameters.length} 行，原文）：`);
      for (const row of cmd.parameters) out.push(...entryLines(row));
    }
    out.push(`逆操作（${cmd.inverse.kind}：${cmd.inverse.detail}）：`, ...cmd.inverse.node_block);
  }

  const pc = materials.commands_and_manual.plumb_candidates;
  if (pc && pc.steps.length > 0) {
    out.push(
      '',
      `## Plumb 预筛命令候选（状态：${pc.status}，决定者：${pc.decided_by}${pc.model_version ? `，模型：${pc.model_version}` : ''}）`,
      '以下候选仅供参考与检索起步，编写前仍须按锁定命令树语法与手册参数说明核对。',
    );
    for (const st of pc.steps) {
      const sel = st.selected ? `${st.selected.command} (${st.selected.path})` : (st.none_selected ? '都不是' : '无');
      const warn = st.rejected ? ' [落入 reject 区]' : st.review_required ? ' [需人工复核：Plumb choice 落入 review 区]' : '';
      out.push(`- 步骤 ${st.step_index}（${st.step_text}）：推荐 \`${sel}\`${warn}${st.selected?.definition ? `；语法：${st.selected.definition.split('\n')[0]}` : ''}`);
    }
  }

  if (materials.bed_facts.plan_envelope) {
    out.push('', '## 这条用例的计划文件外壳', '', '```json', JSON.stringify(materials.bed_facts.plan_envelope, null, 2), '```');
  }
  return out.join('\n') + '\n';
}

