// Gold script: the command difference of two builds from their command-tree XML files (exported with
// `circle-hub original export`). Independent by design — imports nothing from hub/ or packs/; the path and
// content conventions are re-implemented from packs/product/famx/README.md (entry path `/commands/<words>`,
// one definition per full command, every argument list one overload, argument types STRING/XSTRING → string,
// U16 → int 0..65535, U32 → int 0..4294967295, DOTTEDIP → ipv4, IPADDR → ipv4/ipv6, IPMASK → mask/int; a
// definition differs when its signature content differs — help text alone is not a difference).
//   node scripts/real/gold/command-diff.ts --earlier <a.xml> --later <b.xml> --out <diff.json>
// The output JSON is { added, removed, modified }: path lists, each sorted.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface CommandDef {
  path: string;
  /** The definition content that decides "modified": overload list with argument types and ranges, never help text. */
  content: string;
}

export type XmlNode = { name: string; attributes: Record<string, string>; children: XmlElementChild[] };
export type XmlElementChild = { text: string } | { element: XmlNode };

/** A small XML reader for the command tree's shape: elements, attributes and text, no namespaces, no DTDs. */
export class XmlReader {
  private at = 0;
  private readonly text: string;
  private constructor(text: string) {
    this.text = text;
  }
  static read(text: string): XmlNode[] {
    return new XmlReader(text).document();
  }
  private document(): XmlNode[] {
    const roots: XmlNode[] = [];
    for (;;) {
      const open = this.find('<', this.at);
      if (open === null) break;
      this.at = open;
      if (this.text.startsWith('<?', this.at) || this.text.startsWith('<!--', this.at)) {
        const end = this.text.startsWith('<?', this.at) ? this.text.indexOf('?>', this.at) : this.text.indexOf('-->', this.at);
        this.at = end < 0 ? this.text.length : end + (this.text.startsWith('<?', this.at) ? 2 : 3);
        continue;
      }
      roots.push(this.element());
      if (roots.length > 100) break;
    }
    return roots;
  }
  private find(ch: string, from: number): number | null {
    const at = this.text.indexOf(ch, from);
    return at < 0 ? null : at;
  }
  private element(): XmlNode {
    const end = this.text.indexOf('>', this.at);
    const tag = this.text.slice(this.at + 1, end);
    this.at = end + 1;
    const selfClosing = tag.endsWith('/');
    const body = tag.replace(/\/$/, '').trim();
    const nameMatch = /^[^\s]+/.exec(body);
    const name = nameMatch ? nameMatch[0] : '';
    const attributes: Record<string, string> = {};
    const attributePattern = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s]+))/g;
    for (const m of body.slice(name.length).matchAll(attributePattern)) {
      attributes[m[1]] = m[3] ?? m[4] ?? m[5] ?? '';
    }
    const children: XmlElementChild[] = [];
    if (!selfClosing) {
      for (;;) {
        const next = this.find('<', this.at);
        if (next === null) break;
        if (this.text.startsWith('</', next)) {
          this.at = this.text.indexOf('>', next) + 1;
          break;
        }
        const before = this.text.slice(this.at, next);
        if (before.trim() !== '') children.push({ text: before });
        this.at = next;
        if (this.text.startsWith('<?', this.at) || this.text.startsWith('<!--', this.at)) {
          const close = this.text.startsWith('<?', this.at) ? this.text.indexOf('?>', this.at) : this.text.indexOf('-->', this.at);
          this.at = close < 0 ? this.text.length : close + 2;
          continue;
        }
        children.push({ element: this.element() });
      }
    }
    return { name, attributes, children };
  }
}

const elements = (nodes: readonly XmlElementChild[], name: string): XmlNode[] =>
  nodes.filter((n): n is { element: XmlNode } => 'element' in n && n.element.name === name).map((n) => n.element);

const elementChildren = (nodes: readonly XmlElementChild[]): XmlNode[] =>
  nodes.filter((n): n is { element: XmlNode } => 'element' in n).map((n) => n.element);

const TYPE_TEXT: Readonly<Record<string, string>> = {
  STRING: 'string',
  XSTRING: 'string',
  U16: 'int{0..65535}',
  U32: 'int{0..4294967295}',
  DOTTEDIP: 'ipv4',
  IPADDR: 'ipv4/ipv6',
  IPMASK: 'mask/int{0..128}',
};

const ARG_NAME = /^[A-Za-z0-9_]+$/;

/** One overload's content: the command words and every argument, numbered by position in its list. */
function argumentListContent(args: readonly XmlElementChild[]): string {
  const parts: string[] = [];
  elements(args, 'arg').forEach((arg, index) => {
    const rawName = (arg.attributes.name ?? '').trim().replace(/\s+/g, '_');
    const name = ARG_NAME.test(rawName) ? rawName : `arg${index + 1}`;
    const type = TYPE_TEXT[(arg.attributes.type ?? '').toUpperCase()] ?? 'string';
    let range = '';
    const limit = (arg.attributes.limit ?? arg.attributes.length ?? '').trim();
    const rangeMatch = /^[\[(]?\s*(-?[0-9]{1,15})\s*(?:-|~|\.\.|to)\s*(-?[0-9]{1,15})\s*[\])]?$/.exec(limit);
    const enumMatch = /^[[{(]?\s*([^\s|,{}()[\]]+(?:\s*[|,]\s*[^\s|,{}()[\]]+)+)\s*[\]})]?$/.exec(limit);
    if (/^[0-9]{1,15}$/.test(limit)) range = `{<=${limit}}`;
    else if (rangeMatch) range = `{${rangeMatch[1]}..${rangeMatch[2]}}`;
    else if (enumMatch) range = `{${enumMatch[1].split(/\s*[|,]\s*/).join('|')}}`;
    const optional = /^(?:yes|y|true|1)$/i.test(arg.attributes.optional ?? '');
    const dflt = arg.attributes.default_value !== undefined ? `=${arg.attributes.default_value}` : '';
    parts.push(`arg${index + 1}=${name}:${type}${range}${optional ? `[optional${dflt}]` : ''}`);
  });
  return parts.join('|');
}

/** Every definition of one command tree: path `/commands/<menu words>/<item words>`, overloads joined by `|`. */
export function parseTree(xml: string): CommandDef[] {
  const roots = XmlReader.read(xml);
  const byPath = new Map<string, { itemWords: string[]; overloads: string[] }>();
  const walk = (node: XmlNode, words: string[]): void => {
    const children = node.children;
    if (node.name === 'item') {
      const itemWords = (node.attributes.name ?? '').trim().split(/\s+/).filter((w) => w !== '');
      if (itemWords.length === 0) return;
      const path = `/commands/${[...words, ...itemWords].join('/')}`;
      const lists = elements(children, 'arguments');
      const entry = byPath.get(path) ?? { itemWords, overloads: [] };
      for (const list of lists) {
        entry.overloads.push(argumentListContent(list.children));
      }
      byPath.set(path, entry);
      return;
    }
    // A scope groups menus without adding words; any other wrapper element is walked through the same way.
    for (const child of elementChildren(children)) {
      if (child.name === 'item') {
        walk(child, words);
      } else if (child.name === 'menu') {
        const name = (child.attributes.name ?? '').trim();
        const menuWords = name.split(/\s+/).filter((w) => w !== '');
        if (menuWords.length === 0) continue;
        walk(child, [...words, ...menuWords]);
      } else if (child.name !== 'arguments' && child.name !== 'arg' && child.name !== 'results') {
        walk(child, words);
      }
    }
  };
  for (const root of roots) walk(root, []);
  const out: CommandDef[] = [];
  for (const [path, entry] of byPath) {
    const sortedOverloads = [...entry.overloads].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const content = [entry.itemWords.join(' '), ...sortedOverloads].join('|');
    out.push({ path, content });
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export interface CommandTreeDiff {
  added: string[];
  removed: string[];
  modified: string[];
}

export function commandDiff(earlierXml: string, laterXml: string): CommandTreeDiff {
  const earlier = new Map(parseTree(earlierXml).map((d) => [d.path, d.content]));
  const later = new Map(parseTree(laterXml).map((d) => [d.path, d.content]));
  const added: string[] = [];
  const removed: string[] = [];
  const modified: string[] = [];
  for (const [path, content] of later) {
    if (!earlier.has(path)) added.push(path);
    else if (earlier.get(path) !== content) modified.push(path);
  }
  for (const path of earlier.keys()) if (!later.has(path)) removed.push(path);
  const sorted = (list: string[]): string[] => list.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { added: sorted(added), removed: sorted(removed), modified: sorted(modified) };
}

export async function main(argv: string[]): Promise<number> {
  const value = (name: string): string | undefined => {
    const at = argv.indexOf(`--${name}`);
    return at >= 0 ? argv[at + 1] : undefined;
  };
  const earlierPath = value('earlier');
  const laterPath = value('later');
  const outPath = value('out');
  if (!earlierPath || !laterPath || !outPath) {
    process.stderr.write('用法：node scripts/real/gold/command-diff.ts --earlier <a.xml> --later <b.xml> --out <diff.json>\n');
    return 2;
  }
  let earlierXml: string;
  let laterXml: string;
  try {
    earlierXml = readFileSync(resolve(earlierPath), 'utf8');
    laterXml = readFileSync(resolve(laterPath), 'utf8');
  } catch (error) {
    process.stderr.write(`读不了输入文件（${(error as NodeJS.ErrnoException).code ?? '错误'}）：${(error as Error).message.split('\n')[0]}\n`);
    return 1;
  }
  writeFileSync(outPath, `${JSON.stringify(commandDiff(earlierXml, laterXml), null, 2)}\n`);
  return 0;
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('command-diff.ts')) {
  void main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
