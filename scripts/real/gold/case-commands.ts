// Independent case-to-command gold. Only the two independent file-format readers are reused.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { caseNodesOf, parseMindMap } from './cases.ts';
import { parseTree } from './command-diff.ts';

export interface Match { path: string; abbreviated: boolean; via_no: boolean; words: number }
export interface CaseCommands { key: string; document: string; node: string; comparable: boolean; paths: Match[]; steps: Match[] }
export interface CommandsGold { schema: 'case-commands-gold@1'; tree_sha256: string; documents: string[]; cases: CaseCommands[]; totals: { cases: number; comparable: number; excluded: number; unplaced: number; step_placed: number } }
interface Trie { children: Map<string, Trie>; prefixes: Map<string, string | null>; path?: string }
const trie = (): Trie => ({ children: new Map(), prefixes: new Map() });
// English short words cannot introduce an abbreviated command (README rule, independent small list).
const SHORT = new Set('an as at be by do for he if in is it me my of on or so the to up us we'.split(' '));
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

export function commandScanner(xml: string): (text: string) => Match[] {
  validateXml(xml);
  const root = trie();
  for (const { path } of parseTree(xml)) {
    let node = root;
    for (const word of path.slice('/commands/'.length).toLowerCase().split('/')) {
      if (!node.children.has(word)) node.children.set(word, trie());
      node = node.children.get(word)!;
    }
    node.path = path.toLowerCase();
  }
  const index = (node: Trie): void => {
    for (const [word, child] of node.children) {
      for (let n = 2; n < word.length; n++) {
        const key = word.slice(0, n);
        node.prefixes.set(key, node.prefixes.has(key) ? null : word);
      }
      index(child);
    }
  };
  index(root);
  const resolve = (tokens: string[], start: number): Match | null => {
    let node = root;
    let abbreviated = false;
    let best: Match | null = null;
    for (let i = start; i < tokens.length; i++) {
      const raw = tokens[i];
      const word = raw.toLowerCase();
      let next = node.children.get(word);
      if (!next) {
        if (!/^[a-z]+$/i.test(raw) || raw.length < (raw === raw.toUpperCase() ? 3 : 2) || (i === start && SHORT.has(word))) break;
        const full = node.prefixes.get(word);
        if (!full) break;
        next = node.children.get(full)!;
        abbreviated = true;
      }
      node = next;
      const words = i - start + 1;
      if (node.path && (!abbreviated || words >= 2)) best = { path: node.path, abbreviated, via_no: false, words };
    }
    return best;
  };
  return (text) => {
    const folded = text.replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
      .replace(/[\r\n\v\f\u0085\u2028\u2029]/g, '\n').replace(/[\p{White_Space}\u200b-\u200d\u2060\ufeff]/gu, (c) => c === '\n' ? c : ' ')
      .replace(/\d+[.、）)](?=[A-Za-z])/g, ' ');
    const found = new Map<string, Match>();
    for (const segment of folded.split(/[^A-Za-z0-9_\- \t]+/)) {
      const tokens = segment.trim().split(/[ \t]+/).filter(Boolean);
      const at = (i: number): Match | null => {
        const own = resolve(tokens, i);
        if (own) return own;
        const base = tokens[i]?.toLowerCase() === 'no' ? resolve(tokens, i + 1) : null;
        return base ? { ...base, via_no: true } : null;
      };
      for (let i = 0; i < tokens.length;) {
        const match = at(i);
        if (!match) { i++; continue; }
        const old = found.get(match.path);
        found.set(match.path, old ? { ...match, abbreviated: old.abbreviated || match.abbreviated, via_no: old.via_no || match.via_no } : match);
        i += match.words + Number(match.via_no);
        while (i < tokens.length && (at(i)?.words ?? 0) < 2) i++;
      }
    }
    return [...found.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  };
}

export function caseCommandsGold(xml: string, maps: readonly { document: string; map: unknown }[]): CommandsGold {
  const scan = commandScanner(xml);
  const cases: CaseCommands[] = [];
  const documents = new Set<string>();
  const union = (texts: string[]): Match[] => {
    const found = new Map<string, Match>();
    for (const text of texts) for (const match of scan(text)) {
      const old = found.get(match.path);
      found.set(match.path, old ? { ...match, abbreviated: old.abbreviated || match.abbreviated, via_no: old.via_no || match.via_no } : match);
    }
    return [...found.values()].sort((a, b) => a.path.localeCompare(b.path));
  };
  for (const input of maps) {
    const document = documentKey(input.document);
    if (!document || documents.has(document)) throw new Error('文档编号为空或重复');
    documents.add(document);
    const map = parseMindMap(input.map);
    const nodes = caseNodesOf(map);
    const caseIndices = new Set(nodes.map((node) => node.index));
    const counts = new Map<string, number>();
    for (const node of nodes) counts.set(node.id, (counts.get(node.id) ?? 0) + 1);
    for (const node of nodes) {
      const steps: string[] = [];
      const walk = (index: number): void => {
        if (caseIndices.has(index)) return;
        const child = map.nodes[index];
        if (child.children.length) steps.push(child.text);
        for (const sub of child.children) walk(sub);
      };
      for (const child of node.children) walk(child);
      cases.push({ key: `${document}:${node.id}`, document, node: node.id, comparable: comparableNode(node.id) && counts.get(node.id) === 1,
        paths: union([...node.ancestors, node.text]), steps: union(steps) });
    }
  }
  cases.sort((a, b) => a.key.localeCompare(b.key));
  return { schema: 'case-commands-gold@1', tree_sha256: sha256(Buffer.from(xml)), documents: [...documents].sort(), cases,
    totals: { cases: cases.length, comparable: cases.filter((c) => c.comparable).length, excluded: cases.filter((c) => !c.comparable).length,
      unplaced: cases.filter((c) => !c.paths.length).length, step_placed: cases.filter((c) => !c.paths.length && c.steps.length).length } };
}

export function main(argv: string[]): number {
  const value = (name: string) => argv[argv.indexOf(`--${name}`) + 1];
  if (!argv.includes('--tree') || !argv.includes('--out')) { process.stderr.write('需要 --tree、--map 或 --maps、--out\n'); return 2; }
  try {
    const args = argv.flatMap((arg, i) => arg === '--map' ? [argv[i + 1]] : []);
    if (argv.includes('--maps')) args.push(...readFileSync(value('maps'), 'utf8').split(/\r?\n/).filter((line) => line.trim() !== ''));
    if (!args.length) throw new Error('没有脑图清单');
    const maps = args.map((arg) => { const at = arg.lastIndexOf(':'); if (at < 1) throw new Error('清单需要文件和文档编号'); return { document: arg.slice(at + 1), map: JSON.parse(readFileSync(arg.slice(0, at), 'utf8')) as unknown }; });
    const gold = caseCommandsGold(readFileSync(value('tree'), 'utf8'), maps);
    writeFileSync(value('out'), `${JSON.stringify(gold, null, 2)}\n`);
    process.stdout.write(`用例 ${gold.totals.cases}，可比较 ${gold.totals.comparable}，未归位 ${gold.totals.unplaced}\n`);
    return 0;
  } catch { process.stderr.write('抽取失败：检查命令树、脑图和清单文件的格式及可读性\n'); return 1; }
}
if (process.argv[1]?.endsWith('/gold/case-commands.ts')) process.exitCode = main(process.argv.slice(2));
