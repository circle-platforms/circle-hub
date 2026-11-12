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
import { isRecord } from './text.ts';

/** `parameter` is on a manual table row that states one parameter of a command: the command forms the manual spells and the parameter's name (the product's producer records both from the row's place in the manual). */
export interface BriefNode { path: string; children: Array<{ name: string; path: string }>; entries: Array<{ kind?: string; statement: string; reference: string; applicability?: string; parameter?: { commands: string[]; name: string } }> }
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

/** A node as the run download writes it into the text files, line for line. */
export function nodeBlock(node: BriefNode): string[] {
  const out = [`# ${node.path}`];
  if (node.children.length) out.push(`  子节点 ${node.children.length} 个：${node.children.map((child) => child.name).join('、')}`);
  for (const entry of node.entries) {
    out.push(`· ${entry.statement}`);
    if (entry.applicability) out.push(`  适用 ${entry.applicability}`);
    out.push(`  引用 ${entry.reference}`);
  }
  return out;
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
export function authoringBrief(item: unknown, index: string, knowledge: BriefKnowledge, policy: BriefPolicy | null, bed: string | null = null): AuthoringBrief | null {
  const fields = isRecord(item) && isRecord(item.fields) ? item.fields : null;
  const recomposition = fields && isRecord(fields.recomposition) ? fields.recomposition : null;
  const record = recomposition && isRecord(recomposition.record) ? recomposition.record : null;
  if (!isRecord(item) || !fields || !record) return null;
  const named = new Set<string>(referencedPaths(recomposition, knowledge.root));
  const ledgers = isRecord(record.ledgers) ? record.ledgers : {};
  const lines: string[] = [];
  for (const row of Array.isArray(ledgers.adapted) ? ledgers.adapted : []) if (isRecord(row) && Array.isArray(row.commands)) for (const line of row.commands) if (typeof line === 'string') lines.push(line);
  for (const atom of Array.isArray(record.atoms) ? record.atoms : []) if (isRecord(atom) && typeof atom.text === 'string') lines.push(...atom.text.split(/\r?\n/));
  for (const line of lines) { const path = commandPath(knowledge, line); if (path) named.add(path); }
  const commands = [...named].filter((path) => within(path, COMMANDS) && knowledge.nodes.get(path)?.entries.length).sort();
  const others = [...named].filter((path) => knowledge.nodes.has(path) && !commands.includes(path)).sort();
  const missing = [...named].filter((path) => !knowledge.nodes.has(path)).sort();
  const shown = new Set<string>();
  const block = (node: BriefNode): string[] => { const path = canonicalPath(node.path); if (shown.has(path)) return [`（${node.path} 的条目已在上文）`]; shown.add(path); return nodeBlock(node); };
  const out: string[] = [
    `# 编写简报 ${index}：${typeof fields.title === 'string' ? fields.title : ''}`,
    '',
    `下载运行时由程序从 items/${index}.json、run.json 和 knowledge/ 摘出，只有事实，没有判断，也不是计划：这条用例的重组记录点到的命令在锁定命令树里的条目、手册对这些命令各参数的说明、产品声明的逆操作、只读前缀下同样的词走到的命令、同级命令的语法行，记录点到的其它节点在 knowledge/ 里的位置，最后是这条用例的计划文件外壳。写这条用例先读这一份，这里没有的再到 knowledge/ 里搜；引用照抄条目下的“引用”行。`,
    '',
    `条目 ${String(item.id ?? '')}；锁定根 ${knowledge.root}。`,
    '',
    '执行器规则关掉的动作不能作为排除原始用例的理由。按同一构建的手册和命令树，用该设备已开放的命令方法完成原来的效果，保留对象、动作和场景，并说明命令与原始步骤的对应关系；不修改执行器规则或测试环境配置。',
    'expects 使用 basis:"model_judgment" 时，text 必须是设备执行后实际会输出、能在设备输出里逐字找到的一行原文，例如 SDNS Query Statistics Summary，不写“输出含……”或“状态为……”等描述。对应原始用例哪句期望、为什么选择这段原文，写在 rationale 里。',
    '只有上机时才产生的值，在本条自动化用例里先取出再用；手册允许指定名字时，由生成器指定，本条先创建，配置、查询和清理都使用同一个名字。可在这些命令里写相同的 {{name:N|前缀|后缀}}，前后缀取手册允许的字符并区分本条；fidelity-brief.ts 或 submit-plans.ts 展开并写回文件后，Hub 核对具体命令。不写死设备生成的名字，不抄旧设备输出，不沿用设备上已有的东西。CAPTURE 保存原文，EXPECT_FROM 用于检查，整段原文不直接插入普通参数；设备不允许命名时，须有执行器规则已支持的本条取值和引用方式，缺少时说明缺什么，不猜。',
    '设备生成的值，在本条先保存设备输出，按表格列和选行条件取一格；后续命令用 {} 引用它。',
    '数据行按声明的字面分隔符和列数识别；取不到、零行或多行就停止并带设备原话说明，不猜值、不用上一次的输出。',
  ];
  // The order is the cleanup check's own (functions/command-obligations.ts, alternativeInverses then inverse_rules).
  if (policy) out.push(`产品声明的命令规则（run.json 的 command_policy）：只读前缀 ${policy.read_only.join('、') || '无'}；互逆取值 ${policy.inverse_alternatives.map((pair) => pair.join('/')).join('、') || '无'}。`
    + (policy.inverse_alternatives.length ? '核验认逆操作的顺序：命令的枚举参数取了互逆取值之一时，逆操作是同一条命令取另一个值；命令的末词是互逆取值之一、同级又有另一个取值的命令时，逆操作是那条同级命令；都不是时按前缀规则。' : ''));
  else out.push('run.json 里没有产品声明的命令规则（command_policy），下面不列逆操作和只读命令。');
  out.push('', `## 重组记录点到的命令（${commands.length} 条）`);
  if (!commands.length) out.push('', '重组记录没有点到命令树里的命令；要用的命令到 knowledge/ 里搜。');
  for (const path of commands) {
    const node = knowledge.nodes.get(path)!;
    out.push('', `### ${words(path)}`, ...block(node));
    const stated = knowledge.parameters?.get(words(path)) ?? [];
    if (stated.length) {
      out.push(`手册对这条命令各参数的说明（${stated.length} 行，原文）：`);
      for (const row of stated) out.push(`· ${row.statement}`, `  引用 ${row.reference}`);
    }
    if (policy) {
      if (policy.read_only.some((prefix) => within(path, canonicalPath(prefix)))) out.push('这条命令在产品声明的只读前缀下。');
      else {
        const paired = pairedSibling(policy, knowledge, path), inverse = paired ? null : inverseOf(policy, path);
        if (paired) out.push(`逆操作（产品声明的互逆取值 ${paired.pair.join('/')}：同级的另一条命令）：`, ...block(paired.node));
        else if (!inverse) out.push('逆操作：产品没有为这条命令声明唯一的逆操作规则。');
        else {
          const carried = inverse.rule.leading_parameters === undefined ? '' : `，逆操作带这条命令的前 ${inverse.rule.leading_parameters} 个参数`;
          const target = knowledge.nodes.get(inverse.path);
          out.push(`逆操作（产品规则 ${inverse.rule.source_prefix} → ${inverse.rule.inverse_prefix}${carried}）：`);
          if (target?.entries.length) out.push(...block(target));
          else out.push(`按这条规则算出的 ${decodeURI(inverse.path)} 不在锁定命令树里。`);
        }
        for (const prefix of policy.read_only) {
          const form = readOnlyForm(knowledge, canonicalPath(prefix), path);
          if (form) out.push(`只读前缀 ${prefix} 下同样的词走到的命令：`, ...block(form));
        }
      }
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
    `一个条目一份 JSON 文件。Hub 收的形状是：plan 槽是只有一条陈述的列表，陈述是 {text, quotes, data}，计划内容都在 data 里（data 的结构以技能目录的 slots.schema.json 为准，完整的样子见技能目录 examples/submit-result.json）。下面已经填好的都抄自本运行的冻结内容：条目号、期望原句及其引用、${bed === null ? '' : 'bucket（本运行配置选定的自动化测试环境）、'}重组回执、用例号和期望的判断依据；空着的由你写：text 写一句话说明这份计划，steps 和 expects 照技能说明写，每个判断依据的 assertions 列出对应的断言（平面计划是 expects 从 1 起的序号，写成字符串）。空着的不填会被拒。`,
    '',
    '原始用例要求不存在、无残留或不再包含时，常量用分块写法 OBSERVE_ASSERT/op=not_found，literal 写不应出现的记录；动态值在本条先 CAPTURE，再用 EXPECT_FROM/op=not_found，expected_from 指该捕获，执行器须声明寄存器的字面否定方法，不抄旧设备输出。quote 保留原始期望。要求删除成功时，删除后再查询，指向这次查询的设备输出；不另立判定标准，这项检查不填 criterion，不为它写 criteria 或发起 criteria_review/criteria_review_run。',
    '',
    '```json', JSON.stringify(envelope, null, 2), '```');
  return { text: out.join('\n') + '\n', commands, others, missing };
}
