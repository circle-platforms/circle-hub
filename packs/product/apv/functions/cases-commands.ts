// Commands of a build named in case texts. A command is one whole newline-delimited statement: the locked command
// tree's exact words, then arguments that satisfy that command's declared XML argument list (type, limit, length,
// optional). One statement that matches two commands matches neither. Nothing is abbreviated, prefixed, case-folded,
// undone by a leading `no`, or lifted out of a sentence. `foldText` and `withoutListNumbers` stay available to callers;
// recognition does not use them.
import { produceCommandEntries } from './command-tree.ts';
import type { XmlModel } from './types.ts';
import { decodeEntities, isRecord, pathText, squeeze } from './util.ts';

type Word = { children: Map<string, Word>; path: string | null };
type Argument = { type: string; limit: string; length: string; optional: boolean; valid: boolean };
type GrammarNode = { words: Map<string, GrammarNode>; rules: Array<{ path: string; arguments: Argument[] }> };
type XmlNode = { name: string; attributes: { [name: string]: string }; children: unknown[] };

const grammarNode = (): GrammarNode => ({ words: new Map(), rules: [] });

export type CommandCatalog = {
  /** Lower-case word trie of definition paths. Manual placement looks words up here; it does not decide case commands. */
  root: Word;
  /** Distinct commands the statement grammar accepted. */
  size: number;
  grammar: GrammarNode;
};

function asNode(value: unknown): XmlNode | null {
  if (!isRecord(value) || typeof value.name !== 'string' || !Array.isArray(value.children)) return null;
  const attributes: { [name: string]: string } = {};
  if (isRecord(value.attributes)) for (const [key, item] of Object.entries(value.attributes)) if (typeof item === 'string') attributes[key] = item;
  return { name: value.name, attributes, children: value.children };
}

function attribute(node: XmlNode, name: string): string {
  return squeeze(decodeEntities(node.attributes[name] ?? ''));
}

function elementsOf(node: XmlNode): XmlNode[] {
  const out: XmlNode[] = [];
  for (const child of node.children) {
    const element = asNode(child);
    if (element !== null) out.push(element);
  }
  return out;
}

/** Address forms of the IPADDR, DOTTEDIP and IPMASK argument types, the same forms `node:net` `isIP` accepts. */
const V4_SEG = '(?:[0-9]|[1-9][0-9]|1[0-9][0-9]|2[0-4][0-9]|25[0-5])';
const V4 = new RegExp(`^(?:${V4_SEG}[.]){3}${V4_SEG}$`);
const V6_SEG = '(?:[0-9a-fA-F]{1,4})';
const V6 = new RegExp(
  '^(?:' +
    `(?:${V6_SEG}:){7}(?:${V6_SEG}|:)|` +
    `(?:${V6_SEG}:){6}(?:${V4.source.slice(1, -1)}|:${V6_SEG}|:)|` +
    `(?:${V6_SEG}:){5}(?::${V4.source.slice(1, -1)}|(:${V6_SEG}){1,2}|:)|` +
    `(?:${V6_SEG}:){4}(?:(:${V6_SEG}){0,1}:${V4.source.slice(1, -1)}|(:${V6_SEG}){1,3}|:)|` +
    `(?:${V6_SEG}:){3}(?:(:${V6_SEG}){0,2}:${V4.source.slice(1, -1)}|(:${V6_SEG}){1,4}|:)|` +
    `(?:${V6_SEG}:){2}(?:(:${V6_SEG}){0,3}:${V4.source.slice(1, -1)}|(:${V6_SEG}){1,5}|:)|` +
    `(?:${V6_SEG}:){1}(?:(:${V6_SEG}){0,4}:${V4.source.slice(1, -1)}|(:${V6_SEG}){1,6}|:)|` +
    `(?::((?::${V6_SEG}){0,5}:${V4.source.slice(1, -1)}|(?::${V6_SEG}){1,7}|:))` +
    ')(?:%[0-9a-zA-Z]{1,})?$',
);

function ipFamily(value: string): 0 | 4 | 6 {
  if (V4.test(value)) return 4;
  if (V6.test(value)) return 6;
  return 0;
}

/** Constraint syntax belongs to the XML grammar. Unknown syntax never matches. */
function constraint(raw: string, value: string, magnitude: number | undefined): boolean {
  if (!raw) return true;
  const range = /^\[\s*(-?\d+)\s*-\s*(-?\d+)\s*\]$/.exec(raw);
  if (range) return magnitude !== undefined && Number.isSafeInteger(Number(range[1])) && Number.isSafeInteger(Number(range[2])) && Number(range[1]) <= magnitude && magnitude <= Number(range[2]);
  if (raw[0] === '{' && raw.at(-1) === '}') {
    const alternatives = raw.slice(1, -1).split('|');
    return alternatives.every((part) => part.length > 0) && alternatives.some((part) => part === value);
  }
  return false;
}

function accepts(argument: Argument, value: string): boolean {
  if (!argument.valid) return false;
  let magnitude: number | undefined;
  const unsigned = (text: string): boolean => text.length > 0 && [...text].every((c) => c >= '0' && c <= '9');
  switch (argument.type) {
    case 'STRING':
    case 'XSTRING':
      magnitude = [...value].length;
      break;
    case 'U16':
    case 'U32': {
      if (!unsigned(value)) return false;
      magnitude = Number(value);
      if (!Number.isSafeInteger(magnitude) || magnitude > (argument.type === 'U16' ? 65535 : 4294967295)) return false;
      break;
    }
    case 'DOTTEDIP':
      if (ipFamily(value) !== 4) return false;
      break;
    case 'IPADDR':
      if (ipFamily(value) === 0 || value.includes('%')) return false;
      break;
    case 'IPMASK': {
      if (unsigned(value)) {
        magnitude = Number(value);
        if (magnitude > 128) return false;
      } else {
        if (ipFamily(value) !== 4) return false;
        const bits = value.split('.').map((octet) => Number(octet).toString(2).padStart(8, '0')).join('');
        let zero = false;
        for (const bit of bits) {
          if (bit === '0') zero = true;
          else if (zero) return false;
        }
      }
      break;
    }
    default:
      return false;
  }
  return constraint(argument.limit, value, magnitude) && constraint(argument.length, value, [...value].length);
}

function argumentsMatch(rule: readonly Argument[], tokens: readonly string[]): boolean {
  const memo = new Map<string, boolean>();
  const match = (at: number, token: number): boolean => {
    const key = `${at}:${token}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    const result =
      at === rule.length
        ? token === tokens.length
        : rule[at].valid && ((rule[at].optional && match(at + 1, token)) || (token < tokens.length && accepts(rule[at], tokens[token]) && match(at + 1, token + 1)));
    memo.set(key, result);
    return result;
  };
  return match(0, 0);
}

/** One statement. Quotes delimit argument literals. A broken quote is not a statement. */
function tokensOf(line: string): Array<{ value: string; quoted: boolean }> | null {
  const out: Array<{ value: string; quoted: boolean }> = [];
  for (let i = 0; i < line.length; ) {
    if (line[i] === ' ' || line[i] === '\t' || line[i] === '\r') {
      i++;
      continue;
    }
    let value = '';
    const quoted = line[i] === '"' || line[i] === "'";
    if (quoted) {
      const quote = line[i++];
      let closed = false;
      while (i < line.length) {
        const c = line[i++];
        if (c === quote) {
          closed = true;
          break;
        }
        if (c === '\\') {
          if (i === line.length || (line[i] !== quote && line[i] !== '\\')) return null;
          value += line[i++];
        } else value += c;
      }
      if (!closed || (i < line.length && line[i] !== ' ' && line[i] !== '\t' && line[i] !== '\r')) return null;
    } else {
      while (i < line.length && line[i] !== ' ' && line[i] !== '\t' && line[i] !== '\r') value += line[i++];
    }
    out.push({ value, quoted });
  }
  return out;
}

function argumentOf(node: XmlNode): Argument {
  const optional = attribute(node, 'optional').toLowerCase();
  return {
    type: attribute(node, 'type'),
    limit: attribute(node, 'limit'),
    length: attribute(node, 'length'),
    optional: optional === 'yes' || optional === 'true' || optional === '1',
    valid: optional === '' || ['yes', 'true', '1', 'no', 'false', '0'].includes(optional),
  };
}

/** The statement grammar: exact tree words and each declared argument list. */
function commandGrammar(model: XmlModel): { grammar: GrammarNode; size: number } {
  const grammar = grammarNode();
  const paths = new Set<string>();
  const walk = (node: XmlNode, prefix: string[]): void => {
    const name = node.name === 'menu' || node.name === 'item' ? attribute(node, 'name') : '';
    const own = name === '' ? [] : name.split(' ');
    const words = node.name === 'menu' ? [...prefix, ...own] : prefix;
    if (node.name === 'item') {
      if (own.length === 0) return;
      const pathWords = [...prefix, ...own];
      const path = pathText(['commands', ...pathWords]);
      if (path === null) return;
      let head = grammar;
      for (const word of pathWords) {
        let next = head.words.get(word);
        if (next === undefined) {
          next = grammarNode();
          head.words.set(word, next);
        }
        head = next;
      }
      const lists = elementsOf(node).filter((child) => child.name === 'arguments');
      for (const list of lists.length > 0 ? lists : [null]) {
        const args = list === null ? [] : elementsOf(list).filter((child) => child.name === 'arg').map(argumentOf);
        head.rules.push({ path, arguments: args });
        paths.add(path);
      }
      return;
    }
    for (const child of elementsOf(node)) {
      if (child.name === 'arg' || child.name === 'arguments' || child.name === 'results') continue;
      walk(child, words);
    }
  };
  const root = asNode(isRecord(model) ? model.root : null);
  if (root !== null) walk(root, []);
  return { grammar, size: paths.size };
}

/** Paths of the one command this statement is, or none when it is not exactly one command. */
function statementPaths(grammar: GrammarNode, line: string): string[] {
  const tokens = tokensOf(line);
  if (tokens === null || tokens.length === 0) return [];
  const matches = new Map<string, true>();
  let head = grammar;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].quoted) break;
    const next = head.words.get(tokens[i].value);
    if (next === undefined) break;
    head = next;
    const rest = tokens.slice(i + 1).map((token) => token.value);
    for (const rule of head.rules) if (argumentsMatch(rule.arguments, rest)) matches.set(rule.path, true);
  }
  return matches.size === 1 ? [...matches.keys()] : [];
}

/** The catalog of a build from its command tree (xml@1 model), with the command-tree producer's warnings. */
export function commandCatalog(model: XmlModel): { catalog: CommandCatalog; warnings: string[] } {
  const produced = produceCommandEntries(model, {});
  const root: Word = { children: new Map(), path: null };
  for (const entry of produced.entries) {
    const words = isRecord(entry.data) && Array.isArray(entry.data.words) ? (entry.data.words as unknown[]).filter((w): w is string => typeof w === 'string' && w !== '') : [];
    if (words.length === 0 || entry.path === null) continue;
    let node = root;
    for (const word of words) {
      const key = word.toLowerCase();
      let next = node.children.get(key);
      if (next === undefined) {
        next = { children: new Map(), path: null };
        node.children.set(key, next);
      }
      node = next;
    }
    if (node.path === null) node.path = entry.path;
  }
  const built = commandGrammar(isRecord(model) ? model : ({} as XmlModel));
  return { catalog: { root, size: built.size, grammar: built.grammar }, warnings: produced.warnings };
}

function matchedPaths(catalog: CommandCatalog, text: string): string[] {
  const found = new Set<string>();
  for (const line of text.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n')) {
    for (const path of statementPaths(catalog.grammar, line)) found.add(path);
  }
  return [...found].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** The catalog paths one text names, in path order: each line that is exactly one command. */
export function resolvePhrasePaths(catalog: CommandCatalog, phrase: string): string[] {
  if (catalog.size === 0) return [];
  return matchedPaths(catalog, phrase);
}

/** The catalog path one text names, or null when the text is not exactly one command. */
export function resolvePhrase(catalog: CommandCatalog, phrase: string): string | null {
  return resolvePhrasePaths(catalog, phrase)[0] ?? null;
}

const NUMBER_AT_LINE_START = /^([ \t　]*)(\(?[0-9]{1,3}[.．、)）]|（[0-9]{1,3}）)(?=[ \t]*[A-Za-z])/gm;
const NUMBER_AFTER_SPACE = /(?<=[ \t　，。；：、一-鿿])([0-9]{1,2}[.．、)）])(?=[A-Za-z])/g;

/** The unit a text unit is folded to: full-width letters and digits to ASCII, Unicode spaces (other than tab and line
 * breaks), zero-width and invisible format characters and NUL to a space, vertical breaks to a line end, circled and
 * parenthesized numbers and letters to a space. Recognition does not fold. */
function foldUnit(code: number): number {
  if ((code >= 0xff10 && code <= 0xff19) || (code >= 0xff21 && code <= 0xff3a) || (code >= 0xff41 && code <= 0xff5a)) return code - 0xfee0;
  if (code === 0x0b || code === 0x0c || code === 0x85 || code === 0x2028 || code === 0x2029) return 0x0a;
  if (code === 0 || code === 0xa0 || code === 0xad || code === 0x1680 || code === 0x180e || (code >= 0x2000 && code <= 0x200d)) return 0x20;
  if (code === 0x202f || code === 0x205f || code === 0x2060 || code === 0x3000 || code === 0xfeff) return 0x20;
  if ((code >= 0x2460 && code <= 0x24ff) || (code >= 0x2776 && code <= 0x2793) || (code >= 0x3251 && code <= 0x325f) || (code >= 0x32b1 && code <= 0x32bf)) return 0x20;
  return code;
}

/** The text folded unit for unit, so every offset is kept. */
export function foldText(text: string): string {
  let out = '';
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const folded = foldUnit(code);
    if (folded === code) continue;
    out += text.slice(from, i) + String.fromCharCode(folded);
    from = i + 1;
  }
  return from === 0 ? text : out + text.slice(from);
}

/** The text with list numbers before a following letter blanked out, every offset kept. Recognition does not blank them. */
export function withoutListNumbers(text: string): string {
  return text
    .replace(NUMBER_AT_LINE_START, (_all, space: string, number: string) => `${space}${' '.repeat(number.length)}`)
    .replace(NUMBER_AFTER_SPACE, (number: string) => ' '.repeat(number.length));
}

export type TextCommands = {
  /** Catalog paths the text's whole statements resolve to, sorted, once each. */
  paths: string[];
  /** Lines that tokenize as a statement. */
  phrases: number;
  /** Statements that are not exactly one command of the catalog. */
  unresolved: number;
};

/** The commands of each text, in the order given. Each text is one or more whole statements separated by line ends. */
export function textCommands(catalog: CommandCatalog, texts: readonly string[]): { results: TextCommands[]; warnings: string[] } {
  const results: TextCommands[] = texts.map(() => ({ paths: [], phrases: 0, unresolved: 0 }));
  if (catalog.size === 0) return { results, warnings: [] };
  texts.forEach((text, index) => {
    const found = new Set<string>();
    for (const line of String(text).replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n')) {
      const tokens = tokensOf(line);
      if (tokens === null || tokens.length === 0) continue;
      results[index].phrases++;
      const paths = statementPaths(catalog.grammar, line);
      if (paths.length !== 1) {
        results[index].unresolved++;
        continue;
      }
      found.add(paths[0]);
    }
    results[index].paths = [...found].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  });
  return { results, warnings: [] };
}
