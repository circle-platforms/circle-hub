// Independent case-to-command gold. Only the two independent file-format readers are reused.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { caseNodesOf, parseMindMap } from './cases.ts';
import { parseTree } from './command-diff.ts';

export interface Match { path: string; abbreviated: boolean; via_no: boolean; words: number }
export interface CaseCommands { key: string; document: string; node: string; comparable: boolean; paths: Match[]; steps: Match[] }
export interface CommandsGold { schema: 'case-commands-gold@1'; tree_sha256: string; documents: string[]; document_cases: Record<string, number>; cases: CaseCommands[]; totals: { cases: number; comparable: number; excluded: number; unplaced: number; step_placed: number } }
interface Trie { children: Map<string, Trie>; prefixes: Map<string, string | null>; path?: string }
const trie = (): Trie => ({ children: new Map(), prefixes: new Map() });
// English short words cannot introduce an abbreviated command (README rule, independent small list).
const SHORT = new Set('an as at be by do for he if in is it me my of on or so the to up us we'.split(' '));
const STOP = new Set('a an and are as at be been being but by can could did do does for from had has have he her here him his how i if in into is it its may might my not of on or our please should that the their them then there these they this those to too was we were what when where which who will with would you your xxx'.split(' '));
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
  const pathVariants = new Map<string, Set<string>>();
  for (const { path } of parseTree(xml)) {
    let node = root;
    for (const word of path.slice('/commands/'.length).toLowerCase().split('/')) {
      if (!node.children.has(word)) node.children.set(word, trie());
      node = node.children.get(word)!;
    }
    node.path = path;
    const variants = pathVariants.get(path.toLowerCase()) ?? new Set<string>(); variants.add(path); pathVariants.set(path.toLowerCase(), variants);
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
    // Track complete quote pairs independently of word tokenization. Unclosed marks are not quoted evidence.
    const quoteRanges: Array<[number, number]> = [];
    const pairs: Record<string, string> = { '"': '"', "'": "'", '`': '`', '“': '”', '‘': '’', '「': '」', '『': '』' };
    const stack: Array<{ close: string; start: number }> = [];
    for (let k = 0; k < folded.length; k++) {
      if (folded[k] === "'" && /[A-Za-z]/.test(folded[k - 1] ?? '') && /[A-Za-z]/.test(folded[k + 1] ?? '')) continue;
      if (stack.at(-1)?.close === folded[k]) { const open = stack.pop()!; quoteRanges.push([open.start, k]); }
      else if (pairs[folded[k]]) stack.push({ close: pairs[folded[k]], start: k });
    }
    for (const segment of folded.matchAll(/[A-Za-z0-9_\-]+(?:[ \t]+[A-Za-z0-9_\-]+)*/g)) {
      const words = [...segment[0].matchAll(/[A-Za-z0-9_\-]+/g)];
      const tokens = words.map((word) => word[0]);
      const at = (i: number): Match | null => {
        const own = resolve(tokens, i);
        if (own) return own;
        const base = tokens[i]?.toLowerCase() === 'no' ? resolve(tokens, i + 1) : null;
        return base ? { ...base, via_no: true } : null;
      };
      for (let i = 0; i < tokens.length;) {
        const match = at(i);
        if (!match) { i++; continue; }
        const start = segment.index + words[i].index;
        const headEndIndex = i + match.words + Number(match.via_no);
        const end = segment.index + words[headEndIndex - 1].index + words[headEndIndex - 1][0].length;
        const quoted = quoteRanges.some(([from, to]) => from < start && to >= end);
        const before = folded.slice(0, start).trimEnd();
        const after = folded.slice(end).trimStart();
        const englishBefore = /[A-Za-z_-]$/.test(before);
        // Stop words and placeholders trim a phrase back to its head, never provide arguments to a lone word.
        let next = headEndIndex;
        while (next < tokens.length && (at(next)?.words ?? 0) < 2) next++;
        const args = tokens.slice(headEndIndex, next);
        const hasArgs = !englishBefore && args.length > 0 && !args.some((arg) => STOP.has(arg.toLowerCase()));
        const chineseContext = /\p{Script=Han}$/u.test(before) || /^\p{Script=Han}/u.test(after);
        const lone = match.words + Number(match.via_no) === 1 && !hasArgs;
        if (!lone || quoted || (chineseContext && !after.startsWith('命令'))) {
          for (const path of pathVariants.get(match.path.toLowerCase()) ?? [match.path]) {
            const old = found.get(path);
            found.set(path, old ? { ...match, path, abbreviated: old.abbreviated || match.abbreviated, via_no: old.via_no || match.via_no } : { ...match, path });
          }
        }
        i = next;
      }
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
    for (const text of texts) for (const match of scan(text)) {
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
    for (const node of nodes) {
      const steps = node.children.filter((index) => !caseIndices.has(index) && map.nodes[index].children.length > 0).map((index) => map.nodes[index].text);
      cases.push({ key: `${document}:${node.id}`, document, node: node.id, comparable: comparableNode(node.id) && counts.get(node.id) === 1,
        paths: union([...node.ancestors, node.text]), steps: union(steps) });
    }
  }
  cases.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  return { schema: 'case-commands-gold@1', tree_sha256: sha256(Buffer.from(xml)), documents: [...documents].sort(), document_cases, cases,
    totals: { cases: cases.length, comparable: cases.filter((c) => c.comparable).length, excluded: cases.filter((c) => !c.comparable).length,
      unplaced: cases.filter((c) => !c.paths.length).length, step_placed: cases.filter((c) => !c.paths.length && c.steps.length).length } };
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
