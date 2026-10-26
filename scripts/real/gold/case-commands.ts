// Independent case-to-command gold; imports only independent format readers, never Hub/pack implementations.
// Rule sources, sentence by sentence (the owner's stricter 2026-10-24 instruction takes precedence):
// - docs/hub-r4-tasks/hub-view-scope.md:18: "用例也从步骤和预期行解析命令（同一个解析器）".
// - packs/product/famx/README.md:889-890: "把标题、上级节点、步骤、预期文本送进同一个命令解析器";
//   "没有任何目录命中时明确计数". Every text below uses the same build-specific grammar.
// - packs/product/famx/README.md:280-285: leaves are expected results, precondition-priority leaves are not;
//   "a case below a case is its own". A body belongs to its nearest case; nested bodies never leak outward.
// - hub/knowledge/README.md:1083: retain paths (title/ancestors), steps (direct operations), and placement_paths
//   (title/ancestors/body union); exclude precondition leaves and nested case bodies. Consumers use the full set.
// - packs/product/famx/README.md:301-302: "ONE entry per resolved command"; no hit is unplaced. Deduplicate paths.
// - hub/knowledge/README.md:1083: the index cites the first canonical placement, not all mounts. Retain the gold's
//   existing code-unit path ordering; input text order cannot change the set or its first canonical reference.
// - Owner instruction 2026-10-24: no keyword, synonym, prefix or prose-regex classification. Parse a whole
//   command statement against exact tree words and declared arguments. Unrecognized/ambiguous statements are not commands.
//   This supersedes the abbreviation/prose rules in README:286-300 and the obsolete title-only note at :723.
// Command statements are newline-delimited; node boundaries never concatenate words into a command.
// Quotes delimit argument literals only. XML/number/range lexing below is grammar parsing, not prose classification.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { caseNodesOf, parseMindMap } from './cases.ts';
import { XmlReader, type XmlNode } from './command-diff.ts';
import { isIP } from 'node:net';

export interface Match { path: string; abbreviated: boolean; via_no: boolean; words: number }
// paths and steps retain the original title/ancestor and direct-operation measurements; placement_paths adds the admitted body scope.
export interface CaseCommands { key: string; document: string; node: string; comparable: boolean; paths: Match[]; steps: Match[]; placement_paths?: Match[] }
export interface CommandsGold { schema: 'case-commands-gold@1'; tree_sha256: string; documents: string[]; document_cases: Record<string, number>; cases: CaseCommands[]; totals: { cases: number; comparable: number; excluded: number; unplaced: number; step_placed: number } }
interface Argument { type: string; limit: string; length: string; optional: boolean; valid: boolean }
interface GrammarNode { words: Map<string, GrammarNode>; rules: Array<{ path: string; arguments: Argument[] }> }
const grammarNode = (): GrammarNode => ({ words: new Map(), rules: [] });
export const sha256 = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');
export const documentKey = (value: string): string => value.replace(/^agile:(?:case|mindmap):/, '');
export const comparableNode = (value: string): boolean => value !== '' && !value.startsWith('@') && !/#\d+$/.test(value);

/** Reject broken element structure before passing XML to the intentionally permissive gold format reader. */
function validateXml(xml: string): void {
  const stack: string[] = [];
  let roots = 0;
  const stripped = xml.replace(/<!--[\s\S]*?-->|<\?[\s\S]*?\?>/g, '');
  let end = 0;
  for (const m of stripped.matchAll(/<[^>]*>/g)) {
    if (stripped.slice(end, m.index).includes('<')) throw new Error('命令树 XML 不完整');
    const tag = m[0];
    const name = /^<\/?([A-Za-z_][\w.-]*)/.exec(tag)?.[1];
    if (!name) throw new Error('命令树 XML 标签无效');
    if (tag.startsWith('</')) { if (stack.pop() !== name) throw new Error('命令树 XML 标签不匹配'); }
    else { if (!stack.length) roots++; if (!tag.endsWith('/>')) stack.push(name); }
    end = m.index + tag.length;
  }
  if (stack.length || roots !== 1 || stripped.slice(end).trim() !== '') throw new Error('命令树 XML 不完整');
}

/** Lex one entire statement. No case folding, prefix expansion or prose extraction. */
interface Token { value: string; quoted: boolean }
function tokensOf(line: string): Token[] | null {
  const out: Token[] = [];
  for (let i = 0; i < line.length;) {
    if (line[i] === ' ' || line[i] === '\t' || line[i] === '\r') { i++; continue; }
    let value = '';
    const quoted = line[i] === '"' || line[i] === "'";
    if (line[i] === '"' || line[i] === "'") {
      const quote = line[i++]; let closed = false;
      while (i < line.length) {
        const c = line[i++];
        if (c === quote) { closed = true; break; }
        if (c === '\\') { if (i === line.length || line[i] !== quote && line[i] !== '\\') return null; value += line[i++]; }
        else value += c;
      }
      if (!closed || i < line.length && line[i] !== ' ' && line[i] !== '\t' && line[i] !== '\r') return null;
    } else {
      while (i < line.length && line[i] !== ' ' && line[i] !== '\t' && line[i] !== '\r') value += line[i++];
    }
    out.push({ value, quoted });
  }
  return out;
}
const childrenOf = (node: XmlNode): XmlNode[] => node.children.flatMap(child => 'element' in child ? [child.element] : []);

/** Constraint syntax belongs to the XML grammar, not to natural-language help text. Unknown syntax never matches. */
function constraint(raw: string, value: string, magnitude: number | undefined): boolean {
  if (!raw) return true;
  const range = /^\[\s*(-?\d+)\s*-\s*(-?\d+)\s*\]$/.exec(raw);
  if (range) return magnitude !== undefined && Number.isSafeInteger(Number(range[1])) && Number.isSafeInteger(Number(range[2])) && Number(range[1]) <= magnitude && magnitude <= Number(range[2]);
  if (raw[0] === '{' && raw.at(-1) === '}') { const alternatives = raw.slice(1, -1).split('|'); return alternatives.every(part => part.length > 0) && alternatives.some(part => part === value); }
  return false;
}
function accepts(argument: Argument, value: string): boolean {
  if (!argument.valid) return false;
  let magnitude: number | undefined;
  const unsigned = (s: string) => s.length > 0 && [...s].every(c => c >= '0' && c <= '9');
  switch (argument.type) {
    case 'STRING': case 'XSTRING': magnitude = [...value].length; break;
    case 'U16': case 'U32': {
      if (!unsigned(value)) return false;
      magnitude = Number(value);
      if (!Number.isSafeInteger(magnitude) || magnitude > (argument.type === 'U16' ? 65535 : 4294967295)) return false;
      break;
    }
    case 'DOTTEDIP': if (isIP(value) !== 4) return false; break;
    case 'IPADDR': if (!isIP(value) || value.includes('%')) return false; break;
    case 'IPMASK': {
      if (unsigned(value)) { magnitude = Number(value); if (magnitude > 128) return false; }
      else {
        if (isIP(value) !== 4) return false;
        const bits = value.split('.').map(octet => Number(octet).toString(2).padStart(8, '0')).join('');
        let zero = false; for (const bit of bits) { if (bit === '0') zero = true; else if (zero) return false; }
      }
      break;
    }
    default: return false;
  }
  return constraint(argument.limit, value, magnitude) && constraint(argument.length, value, [...value].length);
}
function argumentsMatch(rule: readonly Argument[], tokens: readonly string[]): boolean {
  const memo = new Map<string, boolean>();
  const match = (at: number, token: number): boolean => {
    const key = at + ':' + token; if (memo.has(key)) return memo.get(key)!;
    const result = at === rule.length ? token === tokens.length
      : rule[at].valid && (rule[at].optional && match(at + 1, token) || token < tokens.length && accepts(rule[at], tokens[token]) && match(at + 1, token + 1));
    memo.set(key, result); return result;
  };
  return match(0, 0);
}
export function commandScanner(xml: string): (text: string) => Match[] {
  validateXml(xml);
  const root = grammarNode();
  const walk = (node: XmlNode, prefix: string[]) => {
    const names = tokensOf(node.attributes.name ?? '');
    if (names === null || names.some(token => token.quoted)) throw new Error('命令树路径不是合法词序列');
    const own = names.map(token => token.value);
    const words = node.name === 'menu' ? [...prefix, ...own] : prefix;
    if (node.name === 'item') {
      if (!own.length) throw new Error('命令树 item 缺少完整路径');
      const pathWords = [...prefix, ...own]; let head = root;
      for (const word of pathWords) { if (!head.words.has(word)) head.words.set(word, grammarNode()); head = head.words.get(word)!; }
      const lists = childrenOf(node).filter(child => child.name === 'arguments');
      for (const list of lists.length ? lists : [{ ...node, children: [] }]) {
        const args = childrenOf(list).filter(child => child.name === 'arg').map(arg => {
          const optional = arg.attributes.optional?.toLowerCase();
          return { type: arg.attributes.type ?? '', limit: arg.attributes.limit ?? '', length: arg.attributes.length ?? '',
            optional: optional === 'yes' || optional === 'true' || optional === '1',
            valid: optional === undefined || ['yes', 'true', '1', 'no', 'false', '0'].includes(optional) };
        });
        head.rules.push({ path: '/commands/' + pathWords.join('/'), arguments: args });
      }
      return;
    }
    for (const child of childrenOf(node)) if (!['arg', 'arguments', 'results'].includes(child.name)) walk(child, words);
  };
  for (const node of XmlReader.read(xml)) walk(node, []);
  return text => {
    const found = new Map<string, Match>();
    for (const line of text.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n')) {
      const tokens = tokensOf(line); if (!tokens?.length) continue;
      const matches = new Map<string, Match>(); let head = root;
      for (let i = 0; i < tokens.length; i++) {
        if (tokens[i].quoted) break;
        const next = head.words.get(tokens[i].value); if (!next) break; head = next;
        for (const rule of head.rules) if (argumentsMatch(rule.arguments, tokens.slice(i + 1).map(token => token.value))) matches.set(rule.path, { path: rule.path, words: i + 1, abbreviated: false, via_no: false });
      }
      if (matches.size === 1) { const match = [...matches.values()][0]; found.set(match.path, match); }
    }
    return [...found.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  };
}

export function caseCommandsGold(xml: string, maps: readonly { document: string; map: unknown }[]): CommandsGold {
  const scan = commandScanner(xml);
  const cases: CaseCommands[] = [];
  const documents = new Set<string>();
  const document_cases = Object.create(null) as Record<string, number>;
  const union = (texts: string[]): Match[] => {
    const found = new Map<string, Match>();
    for (const text of new Set(texts)) for (const match of scan(text)) {
      const old = found.get(match.path);
      found.set(match.path, old ? { ...match, abbreviated: old.abbreviated || match.abbreviated, via_no: old.via_no || match.via_no } : match);
    }
    return [...found.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  };
  for (const input of maps) {
    const document = documentKey(input.document);
    if (!document || documents.has(document)) throw new Error('文档编号为空或重复');
    documents.add(document);
    const map = parseMindMap(input.map);
    const nodes = caseNodesOf(map);
    document_cases[document] = nodes.length;
    const caseIndices = new Set(nodes.map((node) => node.index));
    const counts = new Map<string, number>();
    for (const node of nodes) counts.set(node.id, (counts.get(node.id) ?? 0) + 1);
    // The independent format reader is preorder: a parent's owner is known before its children.
    const owners = new Int32Array(map.nodes.length).fill(-1);
    const body = new Map(nodes.map(node => [node.index, [] as string[]]));
    for (const item of map.nodes) {
      const isCase = caseIndices.has(item.index);
      owners[item.index] = isCase ? item.index : item.parent === null ? -1 : owners[item.parent];
      if (!isCase && owners[item.index] >= 0 && !(item.children.length === 0 && item.priority === 3)) body.get(owners[item.index])!.push(item.text);
    }
    for (const node of nodes) {
      const steps = node.children.filter((index) => !caseIndices.has(index) && map.nodes[index].children.length > 0).map((index) => map.nodes[index].text);
      cases.push({ key: `${document}:${node.id}`, document, node: node.id, comparable: comparableNode(node.id) && counts.get(node.id) === 1,
        paths: union([...node.ancestors, node.text]), steps: union(steps), placement_paths: union([...node.ancestors,node.text,...body.get(node.index)!]) });
    }
  }
  cases.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  return { schema: 'case-commands-gold@1', tree_sha256: sha256(Buffer.from(xml)), documents: [...documents].sort(), document_cases, cases,
    totals: { cases: cases.length, comparable: cases.filter((c) => c.comparable).length, excluded: cases.filter((c) => !c.comparable).length,
      unplaced: cases.filter((c) => !c.placement_paths!.length).length, step_placed: cases.filter((c) => !c.paths.length && c.steps.length).length } };
}

export function main(argv: string[]): number {
  const usage = '用法：node scripts/real/gold/case-commands.ts --tree <tree.xml> (--map <file>:<document> … | --maps <manifest>) --out <gold.json>\n';
  const flags = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i]; const value = argv[i + 1];
    if (!['--tree', '--out', '--maps', '--map'].includes(name) || !value || value.startsWith('--') || name !== '--map' && flags.has(name)) { process.stderr.write(usage); return 2; }
    flags.set(name, [...(flags.get(name) ?? []), value]);
  }
  if (!flags.has('--tree') || !flags.has('--out') || !flags.has('--map') && !flags.has('--maps')) { process.stderr.write(usage); return 2; }
  let phase = '命令树';
  const read = (file: string): Buffer => { try { return readFileSync(file); } catch (error) { const code = (error as { code?: string }).code; throw new Error(`文件不可读${code && /^[A-Z_]+$/.test(code) ? `（${code}）` : ''}`); } };
  try {
    const treeBytes = read(flags.get('--tree')![0]); const xml = treeBytes.toString('utf8'); validateXml(xml);
    const args = [...(flags.get('--map') ?? [])];
    if (flags.has('--maps')) { phase = '清单'; args.push(...read(flags.get('--maps')![0]).toString('utf8').split(/\r?\n/).filter((line) => line.trim() !== '')); }
    if (!args.length) { phase = '清单'; throw new Error('没有脑图条目；每行需要文件和文档编号'); }
    const maps = args.map((arg, i) => {
      phase = `脑图 ${i + 1}`;
      const at = /:agile:(?:case|mindmap):/.exec(arg)?.index ?? arg.lastIndexOf(':'); if (at < 1 || !arg.slice(at + 1)) throw new Error('清单需要文件和文档编号');
      const text = read(arg.slice(0, at)).toString('utf8'); let map: unknown; try { map = JSON.parse(text); } catch { throw new Error('不是有效 JSON'); }
      parseMindMap(map); return { document: arg.slice(at + 1), map };
    });
    phase = '清单与命令抽取'; const gold = caseCommandsGold(xml, maps); gold.tree_sha256 = sha256(treeBytes);
    phase = '输出'; try { writeFileSync(flags.get('--out')![0], `${JSON.stringify(gold, null, 2)}\n`); } catch { throw new Error('报告文件不可写，请换可写的输出位置'); }
    process.stdout.write(`用例 ${gold.totals.cases}，可比较 ${gold.totals.comparable}，未归位 ${gold.totals.unplaced}\n`); return 0;
  } catch (error) { process.stderr.write(`抽取失败：${phase}：${error instanceof Error ? error.message : '输入无效'}；修正该类输入后重新运行\n`); return 1; }
}
if (process.argv[1]?.endsWith('/gold/case-commands.ts')) process.exitCode = main(process.argv.slice(2));
