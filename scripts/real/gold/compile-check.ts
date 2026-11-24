// Independent checks that read only public formats; no Hub or pack imports.
import { isIP } from 'node:net';
import { goldQuoteContains, goldQuoteHasText } from './quote-widths.ts';

type Obj = Record<string, unknown>;
const obj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
export type Verdict = 'pass' | 'fail' | 'unknown';
interface Answer { verdict: Verdict; reason?: string }
const pass = (): Answer => ({ verdict: 'pass' });
const fail = (reason: string): Answer => ({ verdict: 'fail', reason });
const unknown = (reason: string): Answer => ({ verdict: 'unknown', reason });

type XmlNode = { name: string; attributes: Record<string, string>; children: XmlElementChild[] };
type XmlElementChild = { text: string } | { element: XmlNode };

class XmlReader {
  private at = 0;
  private readonly text: string;
  constructor(text: string) {
    this.text = text;
  }
  static read(text: string): XmlNode[] {
    return new XmlReader(text).document();
  }
  private document(): XmlNode[] {
    const roots: XmlNode[] = [];
    for (;;) {
      const open = this.text.indexOf('<', this.at);
      if (open < 0) break;
      this.at = open;
      if (this.text.startsWith('<?', this.at) || this.text.startsWith('<!--', this.at)) {
        const end = this.text.startsWith('<?', this.at) ? this.text.indexOf('?>', this.at) : this.text.indexOf('-->', this.at);
        this.at = end < 0 ? this.text.length : end + (this.text.startsWith('<?', this.at) ? 2 : 3);
        continue;
      }
      roots.push(this.element());
      if (roots.length > 200) throw new Error('XML 根节点过多');
    }
    return roots;
  }
  private element(): XmlNode {
    this.at++; // skip <
    const nameMatch = /^[A-Za-z0-9_.-]+/.exec(this.text.slice(this.at));
    if (!nameMatch) throw new Error('XML 元素名无效');
    const name = nameMatch[0];
    this.at += name.length;
    const attributes: Record<string, string> = {};
    for (;;) {
      this.spaces();
      if (this.at >= this.text.length || this.text[this.at] === '>' || this.text.startsWith('/>', this.at)) break;
      const keyMatch = /^[A-Za-z0-9_.-]+/.exec(this.text.slice(this.at));
      if (!keyMatch) throw new Error('XML 属性无效');
      const key = keyMatch[0];
      this.at += key.length;
      this.spaces();
      if (this.text[this.at] === '=') {
        this.at++;
        this.spaces();
        const quote = this.text[this.at];
        if (quote === '"' || quote === "'") {
          this.at++;
          const endQuote = this.text.indexOf(quote, this.at);
          if (endQuote < 0) throw new Error('XML 属性未闭合');
          const val = this.text.slice(this.at, endQuote);
          attributes[key] = val;
          this.at = endQuote >= 0 ? endQuote + 1 : this.text.length;
        } else throw new Error('XML 属性需要引号');
      } else throw new Error('XML 属性缺少等号');
    }
    this.spaces();
    if (this.text.startsWith('/>', this.at)) {
      this.at += 2;
      return { name, attributes, children: [] };
    }
    if (this.text[this.at] !== '>') throw new Error('XML 开始标签未闭合');
    this.at++;
    const children: XmlElementChild[] = [];
    for (;;) {
      const nextTag = this.text.indexOf('<', this.at);
      if (nextTag < 0) throw new Error('XML 元素未闭合');
      if (nextTag > this.at) {
        children.push({ text: this.text.slice(this.at, nextTag) });
        this.at = nextTag;
      }
      if (this.text.startsWith('</', this.at)) {
        const closeEnd = this.text.indexOf('>', this.at);
        if (closeEnd < 0 || this.text.slice(this.at+2,closeEnd).trim() !== name) throw new Error('XML 结束标签不匹配');
        this.at = closeEnd >= 0 ? closeEnd + 1 : this.text.length;
        break;
      }
      if (this.text.startsWith('<!--',this.at) || this.text.startsWith('<?',this.at)) {
        const endMarker = this.text.startsWith('<!--',this.at) ? '-->' : '?>';
        const end = this.text.indexOf(endMarker,this.at);
        if (end < 0) throw new Error('XML 注释未闭合');
        this.at = end + endMarker.length;
      } else children.push({ element: this.element() });
    }
    return { name, attributes, children };
  }
  private spaces(): void {
    while (this.at < this.text.length && /\s/.test(this.text[this.at])) this.at++;
  }
}


interface CommandArg { name: string; type: string; limit?: string; length?: string; optional: boolean; default?: string }
export interface CatalogCommand { words: string[]; overloads: CommandArg[][] }
export interface CommandCatalogDeclaration { complete: boolean; case_sensitive: boolean }
/** Read only the public commands@1 declaration, never a product's executable modules. */
export function commandCatalogDeclaration(product: unknown): CommandCatalogDeclaration {
  if (!obj(product) || product.schema !== 'product@1' || !Array.isArray(product.catalogs)) throw new Error('产品声明不是 product@1');
  const declarations = product.catalogs.filter(c => obj(c) && c.id === 'commands@1');
  if (declarations.length !== 1 || !obj(declarations[0]) || typeof declarations[0].complete !== 'boolean' || typeof declarations[0].case_sensitive !== 'boolean') throw new Error('缺少或无效的 commands@1 完备性和大小写声明');
  return {complete:declarations[0].complete,case_sensitive:declarations[0].case_sensitive};
}
export function parseCommandTree(xml: string): CatalogCommand[] {
  // Reject unsupported XML rather than silently invent an empty catalog.
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || !xml.includes('<')) throw new Error('命令树不是受支持的 XML');
  const decode = (v: string) => v.replace(/&(amp|lt|gt|quot|apos);/g, (_, k: string) => ({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"}[k]!)).replace(/&#(x[0-9a-f]+|[0-9]+);/gi, (_, k: string) => String.fromCodePoint(k[0].toLowerCase() === 'x' ? parseInt(k.slice(1),16) : Number(k)));
  const children = (n: XmlNode) => n.children.flatMap(c => 'element' in c ? [c.element] : []);
  const byPath = new Map<string, CatalogCommand>();
  const walk = (n: XmlNode, prefix: string[]): void => {
    const words = decode(n.attributes.name ?? '').trim().split(/\s+/).filter(Boolean);
    if (n.name === 'item') {
      if (!words.length) return;
      const all = [...prefix,...words];
      const key = all.join(' ');
      const entry = byPath.get(key) ?? {words: all, overloads: []};
      const lists = children(n).filter(c => c.name === 'arguments');
      for (const list of lists) entry.overloads.push(children(list).filter(c => c.name === 'arg').map((a, i) => ({
        name: decode(a.attributes.name ?? `arg${i+1}`), type: a.attributes.type ?? 'STRING', limit: a.attributes.limit !== undefined ? decode(a.attributes.limit) : a.attributes.range === undefined ? undefined : decode(a.attributes.range),
        length: a.attributes.length, optional: /^(yes|y|true|1)$/i.test(a.attributes.optional ?? ''),
        default: a.attributes.default_value === undefined ? undefined : decode(decode(a.attributes.default_value)),
      })));
      if (!lists.length) entry.overloads.push([]);
      byPath.set(key, entry); return;
    }
    for (const c of children(n)) if (!['arguments','arg','results'].includes(c.name)) walk(c, n.name === 'menu' ? [...prefix,...words] : prefix);
  };
  for (const root of XmlReader.read(xml)) walk(root, []);
  if (!byPath.size) throw new Error('命令树没有命令定义');
  return [...byPath.values()];
}
function tokens(line: string): string[] | null {
  const matches = line.match(/"[^"\\]*(?:\\.[^"\\]*)*"|'[^']*'|[^\s"']+/g) ?? [];
  let rest = line;
  for (const t of matches) rest = rest.replace(t, '');
  if (rest.trim()) return null;
  return matches.map(t => t.startsWith('"') ? JSON.parse(t) as string : t.startsWith("'") ? t.slice(1,-1) : t);
}
function argProblem(a: CommandArg, v: string): string | null {
  const type = a.type.toUpperCase();
  const int = /^(0|[1-9]\d*)$/.test(v) ? Number(v) : NaN;
  if (type === 'U16' && (!Number.isSafeInteger(int) || int > 65535) || type === 'U32' && (!Number.isSafeInteger(int) || int > 4294967295)) return `参数 ${a.name} 整数类型不匹配`;
  if (type === 'DOTTEDIP' && isIP(v) !== 4 || type === 'IPADDR' && !isIP(v) || type === 'IPMASK' && !(isIP(v) === 4 || Number.isInteger(int) && int <= 128)) return `参数 ${a.name} 地址类型不匹配`;
  for (const [raw, length] of [[a.limit, !['U16','U32'].includes(type)], [a.length,true]] as const) {
    if (!raw) continue;
    const r = /^[\[(]?\s*(-?\d+)\s*(?:-|~|\.\.|to)\s*(-?\d+)\s*[\])]?$/.exec(raw);
    const en = /^[{[(]?\s*([^\s|,{}()[\]]+(?:\s*[|,]\s*[^\s|,{}()[\]]+)+)\s*[}\])]?$/.exec(raw);
    const n = length ? v.length : int;
    if (r ? n < Number(r[1]) || n > Number(r[2]) : /^\d+$/.test(raw) ? n > Number(raw) : en ? !en[1].split(/\s*[|,]\s*/).includes(v) : false) return `参数 ${a.name} 超出范围 ${raw}`;
    if (!r && !en && !/^\d+$/.test(raw)) return `未知参数约束 ${raw}`;
  }
  return null;
}
export function checkCatalogCommand(catalog: CatalogCommand[], line: string, declaration?: CommandCatalogDeclaration): Answer {
  line = line.trim();
  if (!line) return pass();
  if (!declaration) return unknown('缺少 commands@1 的完备性和大小写声明');
  const fold = (word: string) => declaration.case_sensitive ? word : word.toLowerCase();
  let ts: string[] | null;
  try { ts = tokens(line); } catch { return fail('命令行引号格式错误'); }
  if (!ts) return fail('命令行引号格式错误');
  const words = ts;
  const candidates = catalog.filter(c => c.words.every((w,i) => words[i] !== undefined && fold(w) === fold(words[i]))).sort((a,b) => b.words.length-a.words.length);
  const cmd = candidates[0];
  if (!cmd) return declaration.complete ? fail('命令不存在于目标构建的命令树中') : unknown('命令未在不完备的目录中找到');
  const args = words.slice(cmd.words.length);
  const problems: string[] = [];
  for (const overload of candidates.filter(c => c.words.length === cmd.words.length).flatMap(c => c.overloads)) {
    // Optional arguments can appear before required ones; explore both consume and omit.
    const match = (i: number, j: number): boolean => {
      if (i === overload.length) return j === args.length;
      const a = overload[i];
      if ((a.optional || a.default !== undefined) && match(i+1,j)) return true;
      if (j >= args.length) { problems.push(`缺少命令参数 ${a.name}`); return false; }
      const p = argProblem(a,args[j]);
      if (p) { problems.push(p); return false; }
      return match(i+1,j+1);
    };
    if (match(0,0)) return pass();
  }
  return fail(problems.join('；') || '命令参数个数错误');
}
export function checkVerbatimQuote(sources: ReadonlyMap<string,string>, reference: string, quote: string): Answer {
  if (!quote.isWellFormed() || !goldQuoteHasText(quote) || !reference.trim()) return fail('期望结果缺少完整的逐字引文或来源');
  if (!/^(src|rec|tree):/.test(reference)) return fail('期望来源不是 src:/rec:/tree: 引用');
  const fragment = sources.get(reference);
  if (fragment === undefined) return unknown(`来源 ${reference} 无法读取或未绑定`);
  return goldQuoteContains(fragment,quote) ? pass() : fail('引文不是来源的逐字片段');
}
// Serialize directly: JSON.stringify on a sorted object would re-order integer-like keys.
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (obj(v)) return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
  const text = JSON.stringify(v);
  if (text === undefined) throw new Error('非 JSON 值');
  return text;
}
