// Gold script: the command lines of one exported regression document (an existing agile mind map whose root title
// names the defect it regresses), computed independently of the Hub. Imports only from gold/cases.ts (itself
// independent). The case rule is the tagged rule of gold/cases.ts exactly (a case is a node whose `resource` is a
// non-empty array); the marked rule is NOT implemented here, as the task page says.
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
//   node scripts/real/gold/regression-doc.ts --map <file>:<documentId> [--map <file>:<documentId> ...] --out <gold.json>
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { bugIdsOf, parseMindMap } from './cases.ts';

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

/** One line into tokens: white space, the quote marks and Chinese text are boundaries; a double- or single-quoted
 * span stays one token (and keeps being marked quoted); edge quotes are stripped from the token text. */
export function commandTokens(line: string): Token[] {
  const tokens: Token[] = [];
  const quoteAware = /"[^"]*"|'[^']*'|[^\s"'“”‘’「」『』]+/gu;
  for (const match of line.normalize('NFKC').matchAll(quoteAware)) {
    const raw = match[0];
    const quoted = raw.length > 1 && ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")));
    const text = raw.replace(EDGE_QUOTES, '');
    if (text !== '') tokens.push({ text, quoted, junk: CJK.test(text) });
  }
  return tokens;
}

const isParamToken = (token: Token): boolean =>
  !token.junk && (token.quoted || PARAM_CHAR.test(token.text) || VALUE_WORDS.has(token.text.toLowerCase()));

/** The commands of one text line: head and parameter values of each, in order of appearance. */
export function splitCommand(line: string): SplitCommand[] {
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
}

export interface RegressionDocGold {
  document: string;
  defects: string[];
  cases: RegressionCase[];
}

/** The gold of one exported regression document: its defect numbers (root title) and its tagged cases' commands. */
export function regressionDocGold(document: string, map: unknown): RegressionDocGold {
  const { nodes } = parseMindMap(map);
  const root = nodes[0];
  const defects = root === undefined ? [] : bugIdsOf(root.text);
  const cases: RegressionCase[] = [];
  for (const node of nodes) {
    if (node.resource.length === 0) continue;
    const commands: SplitCommand[] = [];
    for (const line of [...node.ancestors.slice(1), node.text]) commands.push(...splitCommand(line));
    cases.push({ id: node.id === '' ? `@${node.index}` : node.id, title: node.text, commands });
  }
  if (cases.length === 0) throw new Error(`文档 ${document} 里没有带资源标签的用例节点`);
  return { document, defects, cases };
}

export async function main(argv: string[]): Promise<number> {
  const value = (name: string): string | undefined => {
    const at = argv.indexOf(`--${name}`);
    return at >= 0 ? argv[at + 1] : undefined;
  };
  const outPath = value('out');
  const mapArgs: string[] = [];
  for (let k = 0; k < argv.length; k++) {
    if (argv[k] === '--map' && k + 1 < argv.length) mapArgs.push(argv[k + 1]);
  }
  if (mapArgs.length === 0 || !outPath) {
    process.stderr.write('用法：node scripts/real/gold/regression-doc.ts --map <file>:<documentId> [--map ...] --out <gold.json>\n');
    return 2;
  }
  const golds: RegressionDocGold[] = [];
  for (const arg of mapArgs) {
    const at = arg.lastIndexOf(':');
    const file = at > 0 ? arg.slice(0, at) : arg;
    const documentId = at > 0 ? arg.slice(at + 1) : '';
    try {
      const text = readFileSync(resolve(file), 'utf8');
      golds.push(regressionDocGold(documentId, JSON.parse(text) as unknown));
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
