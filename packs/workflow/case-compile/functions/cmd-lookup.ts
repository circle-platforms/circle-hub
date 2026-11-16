// Local command lookup over the locked tree of a run download (knowledge/nodes.jsonl). One call answers what a script writer
// otherwise finds by reading and grepping knowledge/commands.txt and knowledge/manual.txt a window at a time: in round 35 two
// writers made 135 and 94 calls, most of them such reads, to learn the syntax, parameters and manual examples of a few commands.
//
// The reference implementation (InfoTest, lang_query) has two kinds for this. `heads` lists the command heads below a prefix of the
// command tree. `param` returns the tree's contract of a command and, beside it, the manual as it is: from the command's signature
// line to the next line that starts with `**` or 80 lines, with a locator, nothing rewritten. This is the same over the data the Hub
// exports: the definition of the command in the tree, the manual's signature line of it, the manual's own entries from that line to
// the next command's signature line in the order of the manual's lines, the inverse the product declares for the run, and the
// manual's example lines. Every entry is shown the way knowledge/*.txt shows it (functions/knowledge-text.ts entryLines): a heading
// line with the reference to cite and the source lines, then the statement word for word, so a quote copied from an answer is a
// quote of the entry.
//
// Facts by structure only, never by matching words: a command is found by exact words along the tree's edges (the Hub's own walk,
// functions/catalog-selection.ts); a miss names the next words of the node the words reached, by token prefix, and the heads that use
// the same words in another order; a manual window is bounded by the manual's own signature lines; an example is a line that starts
// with the command's words after an optional prompt. Nothing is ranked or guessed, nothing is written, and every answer states its
// bounds and whether it cut anything.
import { alternativeLines, inverseLine, readCommandPolicy, within, type CommandPolicy } from './generated/skills/command-tools/command-check/command-policy.ts';
import { commandTokens } from './generated/skills/command-tools/command-check/grammar.ts';
import type { LockedTree } from './catalog-selection.ts';
import { ENTRY_HEADING, entryLines, nodeLines, sourceLines, type EntryText } from './knowledge-text.ts';
import { CallFailure, clip, isRecord } from './text.ts';

type Row = { [key: string]: any };
type Token = { value: string; quoted: boolean; raw: string };

/** What one answer holds at most. Entries are counted as the text files show them: heading line and statement. */
export const LOOKUP_BOUNDS = {
  /** Command heads of one listing. */
  heads: 60,
  /** Next words of one inventory. */
  nextWords: 60,
  topWords: 200,
  /** Heads shown for a branch that defines nothing itself. */
  branchHeads: 12,
  /** Entries and characters of one manual window (the first entry is always shown). */
  windowEntries: 40,
  windowChars: 8000,
  /** The manual's parameter rows tied to the command that the window does not hold. */
  rowEntries: 12,
  rowChars: 3000,
  examples: 6,
  exampleLines: 8,
  /** Heads that use the words of a missed query in another order. */
  permutations: 8,
  syntaxChars: 400,
  signatures: 8,
} as const;

export interface LookupRun { run: string; root: string; command_policy?: unknown }
export interface BlockPosition { file: string; line: number }
export interface LookupSource {
  tree: LockedTree;
  run: LookupRun;
  /** Where each node's block starts in the download's text files, by the node's path (blockPositions). */
  blocks?: ReadonlyMap<string, BlockPosition>;
}

/** The nodes of one text file of the download and the line each block starts at: `# <path>` opens a block. */
export function blockPositions(file: string, text: string): Map<string, BlockPosition> {
  const found = new Map<string, BlockPosition>();
  const lines = text.split('\n');
  for (let at = 0; at < lines.length; at++) {
    const line = lines[at]!;
    if (line.startsWith('# /') && !found.has(line.slice(2))) found.set(line.slice(2), { file, line: at + 1 });
  }
  return found;
}

const COMMANDS = '/commands';
const isCommandsNode = (path: string): boolean => path === COMMANDS || path.startsWith(`${COMMANDS}/`);
const RETRY = '重新下载本次运行完整的 knowledge/nodes.jsonl，不拼接其他运行的命令树';

/** The tree's own definition of a command: the entry the Hub's checks read (a manual signature carries no overload list). */
const isDefinition = (entry: Row): boolean => entry.kind === 'definition' && isRecord(entry.data) && Array.isArray(entry.data.signatures);
const formOf = (entry: Row): unknown => (isRecord(entry.data) ? entry.data.form : undefined);
const definitionsOf = (node: Row): Row[] => (node.entries as Row[]).filter(isDefinition);
const childNames = (node: Row): string[] => (node.children as Row[]).map((child) => String(child.name));
const childNode = (tree: LockedTree, node: Row, word: string): Row | undefined => {
  const edge = (node.children as Row[]).find((child) => child.name === word);
  return edge === undefined ? undefined : tree.nodes.get(String(edge.path));
};
const syntaxOf = (entry: Row): string => clip(String(entry.statement).split('\n', 1)[0]!, LOOKUP_BOUNDS.syntaxChars);
const list = (words: readonly string[]): string => words.join('、');

// ----------------------------------------------------------------------------------------------------------------------------
// What the tree and the manual hold, indexed once per tree.

interface Located { entry: Row; node: Row; at: { source: string; from: number; to: number }; nodeOrder: number; order: number }
interface HeadRow { words: string[]; node: Row; def: Row }
interface Index {
  heads: HeadRow[];
  /** The manual's entries by the source file they stand in, in the order of their lines. */
  manual: Map<string, Located[]>;
  /** All the manual's entries that stand on lines, in the order of the tree's nodes and, within a node, of their lines. */
  placed: Located[];
  /** The lines of a source where a command's signature starts: what ends a window. */
  signatures: Map<string, number[]>;
  /** Signature lines of the manual that the tree has no command for, by the words of the missing command. */
  drift: Map<string, Located[]>;
  /** Signature lines the producer did not parse into a signature entry: a manual entry that opens with the command in bold and names it as a literal. */
  written: Map<string, Located[]>;
  /** The manual rows the tree ties to a command, by its words. */
  rows: Map<string, Located[]>;
}
const indexes = new WeakMap<LockedTree, Index>();
const into = <K, V>(map: Map<K, V[]>, key: K): V[] => map.get(key) ?? map.set(key, []).get(key)!;

function indexOf(tree: LockedTree): Index {
  const known = indexes.get(tree);
  if (known !== undefined) return known;
  const index: Index = { heads: [], manual: new Map(), placed: [], signatures: new Map(), drift: new Map(), written: new Map(), rows: new Map() };
  let order = 0, nodeOrder = 0;
  for (const node of tree.nodes.values()) {
    nodeOrder++;
    for (const entry of node.entries as Row[]) {
      const at = sourceLines(entry as EntryText);
      const data = isRecord(entry.data) ? entry.data : {};
      if (isCommandsNode(String(node.path))) {
        if (isDefinition(entry) && Array.isArray(data.words) && data.words.every((word: unknown) => typeof word === 'string')) index.heads.push({ words: data.words as string[], node, def: entry });
        if (data.form === 'signature' && at !== null) into(index.signatures, at.source).push(at.from);
        continue;
      }
      if (at === null) continue;
      const located: Located = { entry, node, at, nodeOrder, order: order++ };
      if (data.form === 'signature_drift') {
        into(index.signatures, at.source).push(at.from);
        const missing = isRecord(data.drift) && Array.isArray(data.drift.missing) ? data.drift.missing : [];
        for (const words of missing) if (typeof words === 'string') into(index.drift, words).push(located);
        continue;
      }
      into(index.manual, at.source).push(located);
      index.placed.push(located);
      const bold = data.form === 'text' && Array.isArray(data.command_literals) ? /^\*\*([^*\n]+)\*\*/.exec(String(entry.statement)) : null;
      const phrase = bold === null ? null : bold[1]!.trim().replace(/\s+/g, ' ');
      if (phrase !== null && (data.command_literals as unknown[]).includes(phrase)) {
        into(index.signatures, at.source).push(at.from);
        into(index.written, phrase).push(located);
      }
      const parameter = isRecord(data.parameter) ? data.parameter : null;
      if (parameter !== null && Array.isArray(parameter.commands)) for (const command of parameter.commands) if (typeof command === 'string') into(index.rows, command).push(located);
    }
  }
  const byLine = (a: Located, b: Located): number => a.at.from - b.at.from || a.at.to - b.at.to || a.order - b.order;
  for (const rows of index.manual.values()) rows.sort(byLine);
  index.placed.sort((a, b) => a.nodeOrder - b.nodeOrder || byLine(a, b));
  for (const [source, lines] of index.signatures) index.signatures.set(source, [...new Set(lines)].sort((a, b) => a - b));
  indexes.set(tree, index);
  return index;
}

// ----------------------------------------------------------------------------------------------------------------------------
// Words, the walk, and what a miss names.

function tokensOf(text: string, label: string, usage: string): Token[] {
  const tokens = commandTokens(text);
  if (tokens === null) throw new CallFailure('invalid_parameters', `${label} 的值不是一行完整的命令写法（引号没有闭合、含换行或超过 2000 字符）`, `改写成单行，带引号的参数用成对的引号。${usage}`);
  if (tokens.length === 0) throw new CallFailure('invalid_parameters', `${label} 的值是空的`, `写出命令词。${usage}`);
  return tokens;
}
/** The words before the first quoted word: only they are looked up, what follows is arguments. */
const leadingWords = (tokens: readonly Token[]): string[] => {
  const words: string[] = [];
  for (const token of tokens) { if (token.quoted) break; words.push(token.value); }
  return words;
};

interface Walk { nodes: Row[]; stopped: string | null }
/** The nodes the words reach from the top of the commands, by exact edges; `stopped` is the first word that is no edge. */
function walkWords(tree: LockedTree, words: readonly string[]): Walk {
  const top = tree.nodes.get(COMMANDS);
  if (top === undefined) throw new CallFailure('invalid_parameters', '锁定命令树里没有 /commands 节点', RETRY);
  const nodes: Row[] = [];
  let current = top;
  for (const word of words) {
    const next = childNode(tree, current, word);
    if (next === undefined) return { nodes, stopped: word };
    nodes.push(next);
    current = next;
  }
  return { nodes, stopped: null };
}
const deepestHead = (walk: Walk): { node: Row; depth: number } | null => {
  for (let at = walk.nodes.length - 1; at >= 0; at--) if (definitionsOf(walk.nodes[at]!).length > 0) return { node: walk.nodes[at]!, depth: at + 1 };
  return null;
};
/** The head at exactly these words, when the tree has one. */
function headAt(tree: LockedTree, line: string): { node: Row; def: Row } | null {
  const tokens = commandTokens(line);
  if (tokens === null || tokens.length === 0 || tokens.some((token) => token.quoted)) return null;
  const walk = walkWords(tree, tokens.map((token) => token.value));
  const node = walk.nodes.at(-1);
  const def = node === undefined ? undefined : definitionsOf(node)[0];
  return walk.stopped !== null || node === undefined || def === undefined ? null : { node, def };
}
function subtreeHeads(tree: LockedTree, node: Row, found: Array<{ node: Row; def: Row }> = [], seen = new Set<string>()): Array<{ node: Row; def: Row }> {
  if (seen.has(String(node.path))) return found;
  seen.add(String(node.path));
  const def = definitionsOf(node)[0];
  if (def !== undefined) found.push({ node, def });
  for (const child of node.children as Row[]) { const next = tree.nodes.get(String(child.path)); if (next !== undefined) subtreeHeads(tree, next, found, seen); }
  return found;
}

/** The next words of a node, with the number of heads below each when `counts` is set, and those that start with what was typed. */
function nextWordsLines(tree: LockedTree, node: Row, owner: string, options: { typed?: string; counts: boolean }): string[] {
  const names = childNames(node);
  if (names.length === 0) return [];
  const shown = names.slice(0, LOOKUP_BOUNDS.nextWords).map((name) => (options.counts ? `${name}(${subtreeHeads(tree, childNode(tree, node, name)!).length})` : name));
  const size = names.length > shown.length ? `${names.length} 个，显示前 ${shown.length} 个` : `${names.length} 个`;
  const out = [`# ${owner} 之下的下一词（${size}${options.counts ? '，括号内是它之下的命令头数' : ''}）：${list(shown)}。`];
  if (options.typed !== undefined) {
    const starts = names.filter((name) => name.startsWith(options.typed!));
    out.push(`# 以 ${options.typed} 开头的下一词：${starts.length ? list(starts.slice(0, LOOKUP_BOUNDS.nextWords)) : '无'}。`);
  }
  return out;
}

/** The words of a node that differ from the typed word only in case: the tree does not fold case, and says which word it has. */
function caseLines(names: readonly string[], typed: string): string[] {
  const same = names.filter((name) => name !== typed && name.toLowerCase() === typed.toLowerCase());
  return same.length === 0 ? [] : [`# 命令词区分大小写，命令树不折叠：这里的词是 ${list(same)}，写的是 ${typed}。`];
}

/** Heads that use the words of the query in another order, or with at most one more word: a fact of the tree, not a recommendation. */
function samewordHeads(index: Index, words: readonly string[]): HeadRow[] {
  if (words.length < 2) return [];
  const wanted = new Map<string, number>();
  for (const word of words) wanted.set(word, (wanted.get(word) ?? 0) + 1);
  const found: Array<{ extra: number; head: HeadRow }> = [];
  for (const head of index.heads) {
    const extra = head.words.length - words.length;
    if (extra < 0 || extra > 1 || (extra === 0 && head.words.every((word, at) => word === words[at]))) continue;
    const have = new Map<string, number>();
    for (const word of head.words) have.set(word, (have.get(word) ?? 0) + 1);
    if ([...wanted].every(([word, count]) => (have.get(word) ?? 0) >= count)) found.push({ extra, head });
  }
  const text = (head: HeadRow): string => head.words.join(' ');
  found.sort((a, b) => a.extra - b.extra || (text(a.head) < text(b.head) ? -1 : text(a.head) > text(b.head) ? 1 : 0));
  return found.slice(0, LOOKUP_BOUNDS.permutations).map((row) => row.head);
}

function missLines(source: LookupSource, index: Index, kind: 'param' | 'heads', words: readonly string[], walk: Walk): string[] {
  const tree = source.tree;
  const shown = words.join(' ');
  const noun = kind === 'param' ? '命令' : '命令头';
  const out: string[] = [];
  const same = samewordHeads(index, words);
  if (walk.nodes.length === 0) {
    const names = childNames(tree.nodes.get(COMMANDS)!);
    const typed = walk.stopped ?? '';
    const starts = names.filter((name) => name.startsWith(typed));
    out.push(`# 命令树里没有${noun} ${shown}。`);
    out.push(`# 第 1 个词 ${typed} 不是命令树的顶层命令词。以 ${typed} 开头的顶层词：${starts.length ? list(starts.slice(0, LOOKUP_BOUNDS.topWords)) : '无'}。`, ...caseLines(names, typed));
    // The whole list of top-level words is for a first word that leads nowhere; when the same words stand in another order below, that is the answer.
    if (same.length === 0) out.push(`# 顶层命令词共 ${names.length} 个：${list(names.slice(0, LOOKUP_BOUNDS.topWords))}${names.length > LOOKUP_BOUNDS.topWords ? `（只列前 ${LOOKUP_BOUNDS.topWords} 个）` : ''}。`);
  } else if (walk.stopped === null) {
    const reached = walk.nodes.at(-1)!;
    const heads = subtreeHeads(tree, reached);
    out.push(`# 命令树里没有${noun} ${shown}：它是分支，不是完整命令。它之下有 ${heads.length} 条命令头${heads.length > LOOKUP_BOUNDS.branchHeads ? `，只列前 ${LOOKUP_BOUNDS.branchHeads} 条（--heads '${shown}' 列到上限）` : ''}：`);
    for (const head of heads.slice(0, LOOKUP_BOUNDS.branchHeads)) out.push(syntaxOf(head.def));
    out.push(...nextWordsLines(tree, reached, shown, { counts: true }));
  } else {
    const reached = walk.nodes.at(-1)!;
    const owner = words.slice(0, walk.nodes.length).join(' ');
    out.push(`# 命令树里没有${noun} ${shown}。`, `# 走到 ${owner}，下一个词 ${walk.stopped} 不是它的下一词。`);
    out.push(...nextWordsLines(tree, reached, owner, { typed: walk.stopped, counts: false }), ...caseLines(childNames(reached), walk.stopped));
  }
  const missing = index.drift.get(shown) ?? [];
  if (missing.length > 0) {
    out.push('# 手册有以它为签名行的段落，命令树没有这条命令（Hub 核对命令以命令树为准，手册的签名行不能代替）：');
    for (const located of missing.slice(0, 3)) out.push(...blockLines(source, located.node, [located.entry]));
  }
  if (same.length > 0) {
    out.push('# 词相同、顺序不同或多一个词的命令头（命令树里原样记载，不是推荐）：');
    for (const head of same) out.push(`  ${syntaxOf(head.def)}`);
  }
  out.push("# 下一步：--heads '<命令词前缀>' 列出某个前缀下的命令头；--param '<完整命令词>' 看定义、手册原文窗和逆操作。");
  out.push(`# 上限：下一词最多列 ${LOOKUP_BOUNDS.nextWords} 个，分支下的命令头最多列 ${LOOKUP_BOUNDS.branchHeads} 条；本次没有截断。`);
  return out;
}

// ----------------------------------------------------------------------------------------------------------------------------
// Entries as the text files show them.

/** `# <path>` as the text files open a node's block, with where the block starts in them when the download has the text files. */
function nodeLine(source: LookupSource, node: Row): string {
  const at = source.blocks?.get(String(node.path));
  return `# ${node.path}${at === undefined ? '' : `  （knowledge/${at.file} 第 ${at.line} 行起）`}`;
}
function blockLines(source: LookupSource, node: Row, entries: readonly Row[]): string[] {
  return [nodeLine(source, node), ...entries.flatMap((entry) => entryLines(entry as EntryText))];
}
/**
 * The line of an entry's heading in the text files: the node's block start plus where the renderer puts the entry. An element of the
 * rendered block is one heading or one statement, and a statement is as many lines as it has line breaks plus one.
 */
function headingPosition(source: LookupSource, located: Located): BlockPosition | null {
  const at = source.blocks?.get(String(located.node.path));
  if (at === undefined) return null;
  const heading = `${ENTRY_HEADING}${located.entry.reference}`;
  let offset = 0;
  for (const element of nodeLines(String(located.node.path), childNames(located.node), located.node.entries as EntryText[])) {
    if (element.startsWith(heading)) return { file: at.file, line: at.line + offset };
    offset += element.split('\n').length;
  }
  return null;
}
/** Entries in the order given, each node's line whenever the node changes. */
function groupedLines(source: LookupSource, entries: readonly Located[]): string[] {
  const out: string[] = [];
  let node: Row | null = null;
  for (const located of entries) {
    if (located.node !== node) { out.push(nodeLine(source, located.node)); node = located.node; }
    out.push(...entryLines(located.entry as EntryText));
  }
  return out;
}
interface Cut { shown: Located[]; hidden: Located[]; byChars: boolean }
/** The first entries that fit the bounds, counted as the text files show them; the first is always shown, so an answer about something that exists is never empty. */
function bounded(entries: readonly Located[], maxEntries: number, maxChars: number): Cut {
  const shown: Located[] = [];
  let chars = 0, byChars = false;
  for (const located of entries) {
    const size = entryLines(located.entry as EntryText).join('\n').length;
    if (shown.length >= maxEntries) break;
    if (shown.length > 0 && chars + size > maxChars) { byChars = true; break; }
    shown.push(located);
    chars += size;
  }
  return { shown, hidden: entries.slice(shown.length), byChars };
}
const sourceName = (source: string, line: number): string => `源 ${source.slice(0, 12)} 行 ${line}`;
/** Where the entries left out can be read on; the cut is also recorded for the answer's last line. */
function leftOut(source: LookupSource, what: string, all: readonly Located[], cut: Cut, cuts: string[]): string[] {
  if (cut.hidden.length === 0) return [];
  const first = cut.hidden[0]!;
  const last = cut.shown.at(-1)!;
  const position = headingPosition(source, first);
  cuts.push(`${what} ${all.length} 条只显示 ${cut.shown.length} 条${cut.byChars ? '（字数上限）' : ''}`);
  const where = position === null ? `${sourceName(first.at.source, first.at.from)} 起（在 knowledge/ 里该条所在的节点块里找）` : `knowledge/${position.file} 第 ${position.line} 行起（read_file 的 offset 填这个行号，limit 填 200）`;
  return [`# 没有显示的 ${cut.hidden.length} 条从 ${where}，原文行号接着${sourceName(last.at.source, last.at.to)}。`];
}

// ----------------------------------------------------------------------------------------------------------------------------
// The product's declared rules for the command.

function policyLines(source: LookupSource, head: { node: Row; def: Row; words: string[] }): string[] {
  const raw = source.run.command_policy;
  if (raw === undefined || raw === null) return ['# run.json 里没有产品声明的命令规则（command_policy），不列逆操作和只读命令。'];
  const policy: CommandPolicy | null = readCommandPolicy(raw);
  if (policy === null) return ['# run.json 的 command_policy 读不出来（不符合 command-policy@1），不列逆操作和只读命令；命令对不对以 check-plan.ts 的核对为准。'];
  const pairs = policy.inverse_alternatives ?? [];
  const out = [`# 产品声明的命令规则（command_policy）：只读前缀 ${policy.read_only.join('、') || '无'}；互逆取值 ${pairs.map((pair) => pair.join('/')).join('、') || '无'}。`];
  const path = String(head.node.path);
  const line = head.words.join(' ');
  const readOnly = policy.read_only.find((prefix) => within(path, prefix));
  if (readOnly !== undefined) out.push(`# 这条命令在产品声明的只读前缀 ${readOnly} 下。`);
  else {
    const siblings = alternativeLines(policy, [line]);
    for (const sibling of siblings) {
      const swapped = sibling.split(' ').at(-1)!;
      const pair = pairs.find((candidate) => candidate.includes(swapped) && head.words.some((word) => candidate.includes(word)));
      const label = `产品声明的互逆取值 ${pair === undefined ? swapped : pair.join('/')}`;
      const partner = headAt(source.tree, sibling);
      if (partner === null) out.push(`# 逆操作（${label}）：同级的另一条命令 ${sibling} 不在锁定命令树里。`);
      else out.push(`# 逆操作（${label}：同级的另一条命令 ${sibling}）：`, ...blockLines(source, partner.node, [partner.def]));
    }
    if (siblings.length === 0) {
      const inverse = inverseLine(policy, line);
      const target = inverse === null ? null : headAt(source.tree, inverse);
      if (inverse === null) out.push('# 逆操作：产品没有为这条命令声明唯一的逆操作规则。');
      else if (target === null) out.push(`# 逆操作（产品规则：${inverse}）：按这条规则算出的这条命令不在锁定命令树里。`);
      else out.push(`# 逆操作（产品规则：${inverse}）：`, ...blockLines(source, target.node, [target.def]));
    }
    const enumerated = ((Array.isArray(head.def.data.signatures) ? head.def.data.signatures : []) as Row[]).some((signature) => isRecord(signature) && Array.isArray(signature.params) && (signature.params as Row[]).some((param) => isRecord(param) && Array.isArray(param.values) && param.values.some((value: unknown) => pairs.some((pair) => pair.includes(String(value))))));
    if (siblings.length > 0 || enumerated) out.push('# 核验认逆操作的顺序：命令的枚举参数取了互逆取值之一时，逆操作是同一条命令取另一个值；命令的末词是互逆取值之一、同级又有另一个取值的命令时，逆操作是那条同级命令；都不是时按前缀规则。');
  }
  for (const confirmation of policy.confirmations ?? []) if (within(path, confirmation.command_prefix)) out.push(`# 确认提示（产品声明）：提示符 ${confirmation.prompt}，应答 ${confirmation.answer}。`);
  return out;
}

/** What the tree could not read of a parameter, by name: the Hub's check does not hold the value to it. */
function uncheckedLines(def: Row): string[] {
  const found = new Map<string, string[]>();
  for (const signature of (Array.isArray(def.data.signatures) ? def.data.signatures : []) as Row[]) {
    for (const param of (isRecord(signature) && Array.isArray(signature.params) ? signature.params : []) as Row[]) {
      if (!isRecord(param) || !Array.isArray(param.unchecked_constraints) || param.unchecked_constraints.length === 0) continue;
      const values = found.get(String(param.name)) ?? [];
      for (const gap of param.unchecked_constraints) if (isRecord(gap) && typeof gap.source_value === 'string' && !values.includes(gap.source_value)) values.push(gap.source_value);
      found.set(String(param.name), values);
    }
  }
  return [...found].map(([name, values]) => `# 参数 ${name} 带有命令树没有解读的约束${values.length ? `（写法 ${values.join('、')}）` : ''}，这一项不由命令树核对。`);
}

// ----------------------------------------------------------------------------------------------------------------------------
// Examples: lines of the manual that start with the command.

const PROMPT = /^\s*[\w.-]+(?:\([\w.-]*\))?[#>]\s*/u;
/** Whether a line of the manual is the command written out: its words first, after an optional prompt, and no word of a longer command next. */
function startsWithCommand(line: string, words: readonly string[], longer: ReadonlySet<string>): boolean {
  if (!line.includes(words[0]!)) return false;
  const tokens = commandTokens(line.replace(PROMPT, ''));
  if (tokens === null || tokens.length < words.length) return false;
  for (let at = 0; at < words.length; at++) if (tokens[at]!.quoted || tokens[at]!.value !== words[at]) return false;
  const next = tokens[words.length];
  return next === undefined || next.quoted || !longer.has(next.value);
}
/**
 * An example entry as the text files show it when it is short. A long one (a whole listing of configuration) is shown by the
 * lines in it that start with the command, each as the entry has it, and says so: those lines are not next to each other in it.
 */
function exampleLines(source: LookupSource, located: Located, words: readonly string[], longer: ReadonlySet<string>): { lines: string[]; long: boolean } {
  const statement = String(located.entry.statement).split('\n');
  const rendered = entryLines(located.entry as EntryText);
  if (statement.length <= LOOKUP_BOUNDS.exampleLines) return { lines: rendered, long: false };
  const matching = statement.filter((line) => startsWithCommand(line, words, longer));
  const position = headingPosition(source, located);
  const where = position === null ? `见 ${sourceName(located.at.source, located.at.from)} 所在的节点块` : `在 knowledge/${position.file} 第 ${position.line} 行起`;
  const count = `${Math.min(matching.length, LOOKUP_BOUNDS.exampleLines)}${matching.length > LOOKUP_BOUNDS.exampleLines ? `（共 ${matching.length}）` : ''}`;
  return { lines: [rendered[0]!, ...matching.slice(0, LOOKUP_BOUNDS.exampleLines), `# （上一条共 ${statement.length} 行，上面只列其中以这条命令开头的 ${count} 行，它们在原文里不一定相邻；全文${where}。）`], long: true };
}

// ----------------------------------------------------------------------------------------------------------------------------
// The answers.

const usage = (flag: string, shape: string): string => `写法：${flag} '${shape}'`;

/** `--param`: the definition, the manual's window, the inverse and the examples of the command the words name. */
export function lookupParam(source: LookupSource, query: string): string {
  const tokens = tokensOf(query, '--param', usage('--param', '<命令词>'));
  const words = leadingWords(tokens);
  if (words.length === 0) throw new CallFailure('invalid_parameters', '--param 的第一个词是带引号的参数，不是命令词', usage('--param', '<命令词>'));
  const index = indexOf(source.tree);
  const walk = walkWords(source.tree, words);
  const found = deepestHead(walk);
  if (found === null) return `${missLines(source, index, 'param', words, walk).join('\n')}\n`;

  const headWords = words.slice(0, found.depth);
  const head = headWords.join(' ');
  const def = definitionsOf(found.node)[0]!;
  const signatures = (found.node.entries as Row[])
    .filter((entry) => formOf(entry) === 'signature')
    .map((entry) => ({ entry, at: sourceLines(entry as EntryText) }))
    .sort((a, b) => (a.at === null ? 1 : b.at === null ? -1 : a.at.source < b.at.source ? -1 : a.at.source > b.at.source ? 1 : a.at.from - b.at.from));
  const cuts: string[] = [];
  const out: string[] = [
    `# 命令 ${head}：锁定命令树里有这条命令；下面是它的定义、手册原文窗、逆操作和示例。`,
    '# 条目写法同 knowledge/*.txt：标注行下面到下一个标注行或「# 」行之前是原文，引用照抄标注。',
  ];
  const rest = tokens.slice(found.depth);
  if (rest.length > 0) {
    const next = rest[0]!;
    const below = childNames(found.node);
    const given = `其余 ${rest.length} 个词（${rest.map((token) => token.raw).join(' ')}）`;
    if (!next.quoted && below.includes(next.value)) out.push(`# ${given}：${next.value} 是 ${head} 的下一命令词，但 ${head} ${next.value} 在命令树里是分支，没有定义；下面只有 ${head} 本身的定义，--heads '${head} ${next.value}' 列出它之下的命令头。`);
    else if (!next.quoted && below.length > 0) {
      const starts = below.filter((name) => name.startsWith(next.value));
      out.push(`# ${given}按参数处理，不参与查找；其中 ${next.value} 不是 ${head} 的下一命令词（它之下的下一命令词：${list(below.slice(0, LOOKUP_BOUNDS.nextWords))}；以 ${next.value} 开头的：${starts.length ? list(starts) : '无'}），若它是参数请忽略这句。`);
    } else out.push(`# ${given}按参数处理，不参与查找。`);
  }

  out.push(...blockLines(source, found.node, [def, ...signatures.slice(0, LOOKUP_BOUNDS.signatures).map((row) => row.entry)]));
  if (signatures.length > LOOKUP_BOUNDS.signatures) out.push(`# 手册签名条目共 ${signatures.length} 条，只显示前 ${LOOKUP_BOUNDS.signatures} 条。`);
  const forms = (def.data.signatures as unknown[]).length;
  if (forms > 1) out.push(`# 命令树有 ${forms} 种参数形式，合并写在上面的一条签名里（同一位置的不同类型用 / 连接）。`);
  out.push(...uncheckedLines(def));
  const below = subtreeHeads(source.tree, found.node).length - 1;
  if (below > 0) out.push(`# ${head} 之下还有 ${below} 条命令头（下一词 ${list(childNames(found.node).slice(0, 12))}${childNames(found.node).length > 12 ? '…' : ''}）：--heads '${head}' 列出它们的语法行。`);
  out.push(...policyLines(source, { node: found.node, def, words: headWords }));

  // The manual's window: from each signature line of the command to the next command's signature line, in the manual's line order.
  // A signature line is the tree's signature entry of the command or, where the producer did not parse it, the manual's own entry
  // that opens with the command in bold and names it as a literal.
  const used = new Set<string>();
  const anchors = [
    ...signatures.flatMap((row) => (row.at === null ? [] : [{ entry: row.entry, at: row.at }])),
    ...(index.written.get(head) ?? []).map((located) => ({ entry: located.entry, at: located.at })),
  ].sort((a, b) => (a.at.source < b.at.source ? -1 : a.at.source > b.at.source ? 1 : a.at.from - b.at.from)).filter((anchor, at, all) => at === 0 || anchor.at.source !== all[at - 1]!.at.source || anchor.at.from !== all[at - 1]!.at.from);
  if (signatures.length === 0 && anchors.length === 0) out.push('# 手册：锁定树里没有这条命令的手册签名条目（命令树的定义是仅有的一份参数说明）。');
  else if (anchors.length === 0) out.push('# 手册：签名条目没有行号定位，读不出原文窗。');
  for (const anchor of anchors) {
    const next = (index.signatures.get(anchor.at.source) ?? []).find((line) => line > anchor.at.from);
    const window = (index.manual.get(anchor.at.source) ?? []).filter((located) => located.at.from >= anchor.at.from && (next === undefined || located.at.from < next) && !used.has(String(located.entry.reference)));
    const cut = bounded(window, LOOKUP_BOUNDS.windowEntries, LOOKUP_BOUNDS.windowChars);
    for (const located of window) used.add(String(located.entry.reference));
    const data = isRecord(anchor.entry.data) ? anchor.entry.data : {};
    const place = [typeof data.manual_name === 'string' ? data.manual_name : '', ...(Array.isArray(data.section_path) ? data.section_path.map(String) : [])].filter(Boolean).join(' > ');
    out.push(`# 手册原文窗（${place || '手册'}）：按原文行号排列，从${sourceName(anchor.at.source, anchor.at.from)} 的签名行起，到同源下一条命令签名行${next === undefined ? '（没有）即这份源文件末尾' : `（行 ${next}）`}之前；共 ${window.length} 条，${cut.hidden.length === 0 ? '全部显示' : `显示前 ${cut.shown.length} 条`}。`);
    out.push(...groupedLines(source, cut.shown));
    out.push(...leftOut(source, '手册原文窗', window, cut, cuts));
  }

  // The manual's parameter rows the tree ties to this command that the window does not hold.
  const linked = (index.rows.get(head) ?? []).filter((located) => !used.has(String(located.entry.reference)));
  if (linked.length > 0) {
    const cut = bounded(linked, LOOKUP_BOUNDS.rowEntries, LOOKUP_BOUNDS.rowChars);
    for (const located of linked) used.add(String(located.entry.reference));
    out.push(`# 手册对这条命令各参数的说明里不在上面的窗口里的（${linked.length} 行，${cut.hidden.length === 0 ? '全部显示' : `显示前 ${cut.shown.length} 行`}）：`);
    out.push(...groupedLines(source, cut.shown));
    out.push(...leftOut(source, '参数说明行', linked, cut, cuts));
  }

  // Example lines of the manual that start with the command, wherever they stand and not already shown.
  const longer = new Set(childNames(found.node));
  const examples = index.placed.filter((located) => !used.has(String(located.entry.reference)) && String(located.entry.statement).split('\n').some((line) => startsWithCommand(line, headWords, longer)));
  if (examples.length === 0) out.push('# 手册里没有以这条命令开头的示例行（窗口之外）。');
  else {
    const shownExamples = examples.slice(0, LOOKUP_BOUNDS.examples);
    out.push(`# 手册里以这条命令开头的示例行（窗口之外，共 ${examples.length} 条，${examples.length > shownExamples.length ? `显示前 ${shownExamples.length} 条` : '全部显示'}；按节点路径、原文行号排）：`);
    let node: Row | null = null;
    let long = 0;
    const where: BlockPosition[] = [];
    for (const located of shownExamples) {
      if (located.node !== node) { out.push(nodeLine(source, located.node)); node = located.node; }
      const shown = exampleLines(source, located, headWords, longer);
      out.push(...shown.lines);
      if (shown.long) long++;
      const position = headingPosition(source, located);
      if (position !== null) where.push(position);
    }
    if (where.length > 0) out.push(`# 这些示例的标注行在 ${list([...new Set(where.map((at) => `knowledge/${at.file}`))])} 的第 ${list(where.map((at) => String(at.line)))} 行；要上下文就从这些行附近往前后读。`);
    if (long > 0) cuts.push(`示例里 ${long} 条长条目只列命令行`);
    if (examples.length > shownExamples.length) {
      cuts.push(`示例 ${examples.length} 条只显示 ${shownExamples.length} 条`);
      out.push(`# 还有 ${examples.length - shownExamples.length} 条示例没有列出；节点块的位置见上面各节点行，按行读。`);
    }
  }
  out.push(`# 上限：手册原文窗最多 ${LOOKUP_BOUNDS.windowEntries} 条或 ${LOOKUP_BOUNDS.windowChars} 字，参数说明行最多 ${LOOKUP_BOUNDS.rowEntries} 条，示例最多 ${LOOKUP_BOUNDS.examples} 条；${cuts.length === 0 ? '本次没有截断' : `本次截断：${cuts.join('；')}`}。`);
  return `${out.join('\n')}\n`;
}

/** `--heads`: every command head below a prefix, with its syntax line. */
export function lookupHeads(source: LookupSource, prefix: string): string {
  const tokens = tokensOf(prefix, '--heads', usage('--heads', '<命令词前缀>'));
  if (tokens.some((token) => token.quoted)) throw new CallFailure('invalid_parameters', '--heads 的值只能是命令词，带了引号词（参数）', usage('--heads', '<命令词前缀>'));
  const index = indexOf(source.tree);
  const words = tokens.map((token) => token.value);
  const walk = walkWords(source.tree, words);
  if (walk.stopped !== null) return `${missLines(source, index, 'heads', words, walk).join('\n')}\n`;
  const node = walk.nodes.at(-1)!;
  const heads = subtreeHeads(source.tree, node);
  const shown = heads.slice(0, LOOKUP_BOUNDS.heads);
  const owner = words.join(' ');
  const cuts = heads.length > shown.length ? [`命令头 ${heads.length} 条只列 ${shown.length} 条`] : [];
  const out: string[] = [];
  if (heads.length === 0) out.push(`# 命令树里 ${owner} 之下没有命令头（只有分支）。`);
  else out.push(`# 命令头 ${owner}：命令树里共 ${heads.length} 条，${heads.length > shown.length ? `显示前 ${shown.length} 条` : '全部显示'}（含它自己的定义，按命令树顺序）。`);
  for (const head of shown) out.push(syntaxOf(head.def));
  if (heads.length > shown.length) out.push(`# 还有 ${heads.length - shown.length} 条没有列出：用更长的前缀缩小，例如 --heads '${owner} <下一词>'。`);
  out.push(...nextWordsLines(source.tree, node, owner, { counts: true }));
  out.push("# 看某条命令的定义、手册原文窗和逆操作：--param '<完整命令词>'。");
  out.push(`# 上限：最多列 ${LOOKUP_BOUNDS.heads} 条命令头；${cuts.length === 0 ? '本次没有截断' : `本次截断：${cuts.join('；')}`}。`);
  return `${out.join('\n')}\n`;
}
