// Gold script: the command lines of one exported regression document (an existing agile mind map whose root title
// names the defect it regresses), computed independently of the Hub. Imports only from gold/cases.ts (itself
// independent). The case rule follows gold/cases.ts: default 'marked' (tag or mark), and `--case-rule tagged` restricts
// to tagged nodes.
//
// The command lines come from the case title and the labels above the case (the convention the case producer uses:
// commands resolve from titles and group labels). Each command line is split into a head and its parameter values:
// - tokens are split on white space, keeping a double-quoted span one token (quotes of any kind are stripped from
//   the token edges: ", ', `, “ ”, ‘ ’, 「 」);
// - the head is the maximal run of leading lowercase-letter tokens (a hyphen inside a word allowed), so a `no`
//   prefix belongs to the head (`no widget health probe` is not `widget health probe`);
// - parameters are the following value tokens (a quoted span, a token with a digit, a dot, colon, slash or
//   underscore, or a value word like on/off/tcp/debug — a value word ends the head and becomes a parameter), stopping at the first Chinese token or sentence punctuation;
// - every lowercase-letter token position is tried as a command start, so commands after Chinese prose are found
//   (执行 …、先执行 … 再执行 …、numbered lists are not handled: a leading "1." becomes a parameter of a
//   preceding command — do not number command lines in the export; English prose joins the head, so
//   "Then run show health pool1" reads as one long head — keep command lines in the export to the Chinese shapes).
// Without the build's command catalog the head/parameter split is a heuristic: a parameter value written with
// lowercase letters only and no digit (a pool named `cfg` or `poolx`) is read into the head. The same split is
// applied to the drafts by the compare script, so the two sides stay consistent.
//   node scripts/real/gold/regression-doc.ts --map <file>:<documentId> [--map <file>:<documentId> ...] [--commands <xmlFile>] [--case-rule tagged|marked] --out <gold.json>
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { bugIdsOf, caseNodesOf, parseMindMap } from './cases.ts';
import { parseTree } from './command-diff.ts';

export interface SplitCommand {
  head: string;
  parameters: string[];
}

const HEAD_TOKEN = /^[a-z]+(?:-[a-z]+)*$/i;
const VALUE_WORDS = new Set(['on', 'off', 'tcp', 'udp', 'http', 'https', 'debug', 'info', 'warn', 'fast', 'slow', 'rr', 'lc', 'enable', 'disable']);
const PARAM_CHAR = /[0-9.:_/@\\]/;
const CJK = /[㐀-鿿豈-﫿]/;
const EDGE_QUOTES = /^["'`“”‘’「」『』]+|["'`“”‘’「」『』]+$/g;

interface Token {
  text: string;
  quoted: boolean;
  /** Carries Chinese (prose): never a head, and a hard stop for the parameter run. */
  junk: boolean;
}

/** Separates CJK characters from adjacent ASCII letters or digits so commands glued to Chinese text form clean tokens. */
export function insertCjkBoundaries(text: string): string {
  return text
    .replace(/([㐀-鿿豈-﫿])([A-Za-z0-9])/gu, '$1 $2')
    .replace(/([A-Za-z0-9])([㐀-鿿豈-﫿])/gu, '$1 $2');
}

/** Builds a catalog of normalized full command names from the command tree XML. */
export function buildCatalog(xml: string): Set<string> {
  const defs = parseTree(xml);
  const catalog = new Set<string>();
  for (const def of defs) {
    if (def.path.startsWith('/commands/')) {
      const words = def.path.slice('/commands/'.length).split('/').map((w) => w.trim().toLowerCase()).filter((w) => w !== '');
      if (words.length > 0) {
        const full = words.join(' ');
        catalog.add(full);
        catalog.add(`no ${full}`);
      }
    }
  }
  return catalog;
}

/** One line into tokens: white space, the quote marks and Chinese text are boundaries; a double- or single-quoted
 * span stays one token (and keeps being marked quoted); edge quotes are stripped from the token text. */
export function commandTokens(line: string): Token[] {
  const tokens: Token[] = [];
  const separated = insertCjkBoundaries(line.normalize('NFKC'));
  const quoteAware = /"[^"]*"|'[^']*'|[^\s"'“”‘’「」『』]+/gu;
  for (const match of separated.matchAll(quoteAware)) {
    const raw = match[0];
    const quoted = raw.length > 1 && ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")));
    const text = raw.replace(EDGE_QUOTES, '');
    if (text !== '') tokens.push({ text, quoted, junk: CJK.test(text) });
  }
  return tokens;
}

const isParamToken = (token: Token): boolean =>
  !token.junk && (token.quoted || PARAM_CHAR.test(token.text) || VALUE_WORDS.has(token.text.toLowerCase()));

/** Matches commands against a catalog using longest prefix match. */
export function matchCatalogCommands(tokens: readonly Token[], catalog: Set<string>): SplitCommand[] {
  const out: SplitCommand[] = [];
  let at = 0;
  while (at < tokens.length) {
    if (tokens[at].junk) {
      at++;
      continue;
    }
    let bestMatch: { head: string; endIdx: number } | null = null;
    const maxLen = Math.min(tokens.length - at, 16);
    for (let len = maxLen; len >= 1; len--) {
      const slice = tokens.slice(at, at + len);
      if (slice.some((t) => t.junk)) continue;
      const candidate = slice.map((t) => t.text.toLowerCase()).join(' ');
      if (catalog.has(candidate)) {
        bestMatch = { head: slice.map((t) => t.text).join(' '), endIdx: at + len };
        break;
      }
    }
    if (bestMatch !== null) {
      const head = bestMatch.head;
      at = bestMatch.endIdx;
      const parameters: string[] = [];
      while (at < tokens.length && !tokens[at].junk) {
        let nextCommand = false;
        for (let len = Math.min(tokens.length - at, 16); len >= 1; len--) {
          const slice = tokens.slice(at, at + len);
          if (slice.some((t) => t.junk)) continue;
          if (catalog.has(slice.map((t) => t.text.toLowerCase()).join(' '))) {
            nextCommand = true;
            break;
          }
        }
        if (nextCommand) break;
        parameters.push(tokens[at].text);
        at++;
      }
      out.push({ head, parameters });
    } else {
      at++;
    }
  }
  return out;
}

export interface TextCommandParse {
  commands: SplitCommand[];
  unrecognized: string[];
}

export function parseCommandsFromText(line: string, catalog?: Set<string>): TextCommandParse {
  if (!catalog) {
    return { commands: splitCommand(line), unrecognized: [] };
  }
  const tokens = commandTokens(line);
  const commands = matchCatalogCommands(tokens, catalog);
  const unrecognized: string[] = [];
  if (commands.length === 0 && tokens.some((t) => !t.junk && HEAD_TOKEN.test(t.text))) {
    unrecognized.push(line.trim());
  }
  return { commands, unrecognized };
}

/** The commands of one text line: head and parameter values of each, in order of appearance. */
export function splitCommand(line: string, catalog?: Set<string>): SplitCommand[] {
  if (catalog) {
    return matchCatalogCommands(commandTokens(line), catalog);
  }
  const tokens = commandTokens(line);
  const out: SplitCommand[] = [];
  let at = 0;
  while (at < tokens.length) {
    if (tokens[at].junk || VALUE_WORDS.has(tokens[at].text.toLowerCase()) || !HEAD_TOKEN.test(tokens[at].text)) {
      at++;
      continue;
    }
    const headStart = at;
    while (at < tokens.length && !tokens[at].junk && HEAD_TOKEN.test(tokens[at].text) && !VALUE_WORDS.has(tokens[at].text.toLowerCase())) at++;
    const head = tokens.slice(headStart, at).map((t) => t.text).join(' ');
    const parameters: string[] = [];
    while (at < tokens.length && isParamToken(tokens[at])) {
      parameters.push(tokens[at].text);
      at++;
    }
    out.push({ head, parameters });
  }
  return out;
}

/** Comparison forms: NFKC, lower case, single spaces, quotes and edge punctuation gone. */
export function normalizeHead(head: string): string {
  return head.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

export function normalizeParameters(parameters: readonly string[]): string[] {
  return parameters.map((p) => p.replace(EDGE_QUOTES, '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim());
}

export interface RegressionCase {
  id: string;
  title: string;
  commands: SplitCommand[];
  unrecognizedCommands?: string[];
}

export interface RegressionDocGold {
  document: string;
  defects: string[];
  cases: RegressionCase[];
  unrecognizedCommands?: string[];
}

export interface RegressionDocOptions {
  caseRule?: 'tagged' | 'marked';
  commandTreeXml?: string;
  catalog?: Set<string>;
}

/** The gold of one exported regression document: its defect numbers (root title) and its cases' commands. */
export function regressionDocGold(
  document: string,
  map: unknown,
  options: RegressionDocOptions = {},
): RegressionDocGold {
  const catalog = options.catalog ?? (options.commandTreeXml ? buildCatalog(options.commandTreeXml) : undefined);
  const parsed = parseMindMap(map);
  const root = parsed.nodes[0];
  const defects = root === undefined ? [] : bugIdsOf(root.text);
  const cases: RegressionCase[] = [];
  const caseNodes = caseNodesOf(parsed, options);
  const allUnrecognized = new Set<string>();

  for (const node of caseNodes) {
    const commands: SplitCommand[] = [];
    const caseUnrecognized: string[] = [];
    for (const line of [...node.ancestors.slice(1), node.text]) {
      const res = parseCommandsFromText(line, catalog);
      commands.push(...res.commands);
      for (const u of res.unrecognized) {
        caseUnrecognized.push(u);
        allUnrecognized.add(u);
      }
    }
    cases.push({
      id: node.id === '' ? `@${node.index}` : node.id,
      title: node.text,
      commands,
      ...(caseUnrecognized.length > 0 ? { unrecognizedCommands: caseUnrecognized } : {}),
    });
  }
  if (cases.length === 0) {
    const what = options.caseRule === 'tagged' ? '带资源标签的' : '';
    throw new Error(`文档 ${document} 里没有${what}用例节点`);
  }
  return {
    document,
    defects,
    cases,
    ...(allUnrecognized.size > 0 ? { unrecognizedCommands: [...allUnrecognized].sort() } : {}),
  };
}

export async function main(argv: string[]): Promise<number> {
  const value = (name: string): string | undefined => {
    const at = argv.indexOf(`--${name}`);
    return at >= 0 ? argv[at + 1] : undefined;
  };
  const caseRuleArg = value('case-rule');
  const caseRule = caseRuleArg === 'tagged' ? 'tagged' : 'marked';
  const commandsPath = value('commands') ?? value('catalog') ?? value('command-tree');
  let commandTreeXml: string | undefined;
  if (commandsPath) {
    try {
      commandTreeXml = readFileSync(resolve(commandsPath), 'utf8');
    } catch (error) {
      process.stderr.write(`读不了命令树文件 ${commandsPath}：${(error as Error).message.split('\n')[0]}\n`);
      return 1;
    }
  }
  const outPath = value('out');
  const mapArgs: string[] = [];
  for (let k = 0; k < argv.length; k++) {
    if (argv[k] === '--map' && k + 1 < argv.length) mapArgs.push(argv[k + 1]);
  }
  if (mapArgs.length === 0 || !outPath) {
    process.stderr.write('用法：node scripts/real/gold/regression-doc.ts --map <file>:<documentId> [--map ...] [--commands <xmlFile>] [--case-rule tagged|marked] --out <gold.json>\n');
    return 2;
  }
  const golds: RegressionDocGold[] = [];
  for (const arg of mapArgs) {
    const at = arg.lastIndexOf(':');
    const file = at > 0 ? arg.slice(0, at) : arg;
    const documentId = at > 0 ? arg.slice(at + 1) : '';
    try {
      const text = readFileSync(resolve(file), 'utf8');
      golds.push(regressionDocGold(documentId, JSON.parse(text) as unknown, { caseRule, commandTreeXml }));
    } catch (error) {
      process.stderr.write(`读不了脑图 ${arg}：${(error as Error).message.split('\n')[0]}\n`);
      return 1;
    }
  }
  try {
    writeFileSync(outPath, `${JSON.stringify(golds.length === 1 ? golds[0] : { documents: golds }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`写不了 ${outPath}：${(error as Error).message.split('\n')[0]}\n`);
    return 1;
  }
  return 0;
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('gold/regression-doc.ts')) {
  void main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
