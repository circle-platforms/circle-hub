// Commands of a build named in case texts. The catalog is the build's command tree read by the command-tree producer
// (command-tree.ts: one definition per full command at /commands/<words>); phrases are found with commands.ts
// extractCommands and each one is resolved against the catalog:
// - the longest run of the phrase's leading words that is a command of the catalog (case-insensitive); a word may be a
//   unique prefix of the command word at its place (`sh` for show, `hea` for health), never shorter than two letters, and
//   an abbreviation of two letters only when written in lower case (`AD`, `HA` are acronyms, not abbreviations); a command
//   reached through an abbreviation needs two words at least, so an abbreviation alone is never a command;
// - a phrase starting with `no` whose command the catalog lacks resolves to the command it undoes, when that one exists;
// - the words after a resolved command are its arguments unless another command of two words or more starts there
//   (`widget pool add pool1 50 show pools`): a one-word command among arguments is taken for an argument value;
// - a first word may be abbreviated too: the heads handed to extractCommands include the unique prefixes of the first
//   words (not English short words), so that `sh health` is found at all.
// Before extraction each text is folded, one UTF-16 unit for one (offsets kept): full-width letters and digits to ASCII,
// Unicode spaces and zero-width characters to a space, vertical breaks to a line end, enclosed list numbers (①) to a space;
// then a list number glued to a command (`1.widget ...`, `2）show ...`) is blanked out, since extractCommands never starts a
// phrase right after a digit and a dot. Full NFKC is not applied: it turns full-width punctuation (，：) into ASCII marks
// that no longer end a phrase. A line end ends a phrase. All texts of a call are scanned in one extractCommands call (one
// head trie per call), joined by a separator no phrase crosses.
import { produceCommandEntries } from './command-tree.ts';
import { extractCommands } from './commands.ts';
import type { XmlModel } from './types.ts';
import { isRecord } from './util.ts';

type Word = { children: Map<string, Word>; path: string | null };

export type CommandCatalog = {
  root: Word;
  /** Heads for extractCommands: every command (lower case) and the unique abbreviations of the first words. */
  heads: string[];
  /** Commands in the catalog. */
  size: number;
};

/** Short English words that are never taken for an abbreviated first word (they occur in titles as words). */
const NOT_ABBREVIATIONS = new Set(
  'a an as at be by do go he if in is it me my no of on or so to up us we am are can did for get got had has her him his how its may new nor not now off old one our out own per put say see set she the too two use was way who why yes yet you all any'.split(
    ' ',
  ),
);
const MIN_ABBREVIATION = 2;
/** Shortest abbreviation written in capitals: two capitals are an acronym. */
const MIN_CAPITAL_ABBREVIATION = 3;
/** Words of a command found among the arguments of another, at least. */
const MIN_FOLLOWING_WORDS = 2;
/** Words of a phrase the resolver walks at most. */
const MAX_WORDS = 64;
/** The separator between the texts of one scan: a line no phrase crosses, with no white space before its first mark. */
const SEPARATOR = '\n。\n';
/** extractCommands reads at most 1,000,000 characters; longer scans are split. */
const MAX_SCAN = 900_000;

/** The catalog of a build from its command tree (xml@1 model), with the command-tree producer's warnings. */
export function commandCatalog(model: XmlModel): { catalog: CommandCatalog; warnings: string[] } {
  const produced = produceCommandEntries(model, {});
  const root: Word = { children: new Map(), path: null };
  const heads: string[] = [];
  let size = 0;
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
    // Words that differ only in case are one command of a case-insensitive catalog; the first path stays.
    if (node.path === null) {
      node.path = entry.path;
      size++;
      heads.push(words.join(' ').toLowerCase());
    }
  }
  const firsts = [...root.children.keys()];
  for (const word of firsts) {
    if (!/^[a-z][a-z0-9]*$/.test(word)) continue;
    for (let length = MIN_ABBREVIATION; length < word.length; length++) {
      const prefix = word.slice(0, length);
      if (root.children.has(prefix) || NOT_ABBREVIATIONS.has(prefix)) continue;
      if (firsts.filter((other) => other.startsWith(prefix)).length === 1) heads.push(prefix);
    }
  }
  return { catalog: { root, heads, size }, warnings: produced.warnings };
}

/** A word as written may abbreviate a command word: two letters or more, and at least three when written in capitals. */
function mayAbbreviate(raw: string): boolean {
  if (raw.length < MIN_ABBREVIATION) return false;
  return raw === raw.toLowerCase() || raw.length >= MIN_CAPITAL_ABBREVIATION;
}

/** The child of a catalog node a word names: the word itself, or the one child the word is a prefix of. */
function childOf(node: Word, word: string, raw: string): { next: Word; abbreviated: boolean } | null {
  const exact = node.children.get(word);
  if (exact !== undefined) return { next: exact, abbreviated: false };
  if (!mayAbbreviate(raw) || !/^[a-z][a-z0-9_-]*$/.test(word)) return null;
  let found: Word | null = null;
  for (const [name, child] of node.children) {
    if (!name.startsWith(word)) continue;
    if (found !== null) return null;
    found = child;
  }
  return found === null ? null : { next: found, abbreviated: true };
}

type Walked = { path: string; words: number; abbreviated: boolean };

/** The deepest command the words from `from` on reach. */
function walk(catalog: CommandCatalog, words: readonly string[], raws: readonly string[], from: number): Walked | null {
  let node = catalog.root;
  let abbreviated = false;
  let best: Walked | null = null;
  for (let k = from; k < words.length && k - from < MAX_WORDS; k++) {
    const step = childOf(node, words[k], raws[k]);
    if (step === null) break;
    node = step.next;
    abbreviated ||= step.abbreviated;
    if (node.path !== null) best = { path: node.path, words: k - from + 1, abbreviated };
  }
  return best;
}

/** The command starting at `at` (a `no` the catalog lacks: the command it undoes), with the words it takes, or null. */
function commandAt(catalog: CommandCatalog, words: readonly string[], raws: readonly string[], at: number): { path: string; end: number; words: number } | null {
  let found = walk(catalog, words, raws, at);
  let from = at;
  if (found === null && words[at] === 'no' && at + 1 < words.length) {
    found = walk(catalog, words, raws, at + 1);
    from = at + 1;
  }
  if (found === null || (found.abbreviated && found.words < 2)) return null;
  return { path: found.path, end: from + found.words, words: found.words };
}

/** The catalog paths one command phrase names, in phrase order: its leading command and the commands among its arguments. */
export function resolvePhrasePaths(catalog: CommandCatalog, phrase: string): string[] {
  const raws = phrase.trim().split(/[ \t]+/);
  const words = raws.map((word) => word.toLowerCase());
  const paths: string[] = [];
  const first = commandAt(catalog, words, raws, 0);
  let at = 1;
  if (first !== null) {
    paths.push(first.path);
    at = first.end;
  }
  while (at < words.length) {
    const next = commandAt(catalog, words, raws, at);
    if (next !== null && next.words >= MIN_FOLLOWING_WORDS) {
      if (!paths.includes(next.path)) paths.push(next.path);
      at = next.end;
    } else at++;
  }
  return paths;
}

/** The catalog path one command phrase names first, or null. */
export function resolvePhrase(catalog: CommandCatalog, phrase: string): string | null {
  return resolvePhrasePaths(catalog, phrase)[0] ?? null;
}

const NUMBER_AT_LINE_START = /^([ \t　]*)(\(?[0-9]{1,3}[.．、)）]|（[0-9]{1,3}）)(?=[ \t]*[A-Za-z])/gm;
const NUMBER_AFTER_SPACE = /(?<=[ \t　，。；：、一-鿿])([0-9]{1,2}[.．、)）])(?=[A-Za-z])/g;
/** The unit a text unit is folded to before extraction: full-width letters and digits to ASCII, Unicode spaces (other than
 * tab and line breaks), zero-width and invisible format characters and NUL to a space, vertical breaks to a line end,
 * circled and parenthesized numbers and letters (list markers such as the circled digit one) to a space. */
function foldUnit(code: number): number {
  if ((code >= 0xff10 && code <= 0xff19) || (code >= 0xff21 && code <= 0xff3a) || (code >= 0xff41 && code <= 0xff5a)) return code - 0xfee0;
  if (code === 0x0b || code === 0x0c || code === 0x85 || code === 0x2028 || code === 0x2029) return 0x0a;
  if (code === 0 || code === 0xa0 || code === 0xad || code === 0x1680 || code === 0x180e || (code >= 0x2000 && code <= 0x200d)) return 0x20;
  if (code === 0x202f || code === 0x205f || code === 0x2060 || code === 0x3000 || code === 0xfeff) return 0x20;
  if ((code >= 0x2460 && code <= 0x24ff) || (code >= 0x2776 && code <= 0x2793) || (code >= 0x3251 && code <= 0x325f) || (code >= 0x32b1 && code <= 0x32bf)) return 0x20;
  return code;
}

/** The text as the extractor reads it: folded unit for unit, so every offset is kept. */
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

/** The text with list numbers before commands blanked out, every offset kept. */
export function withoutListNumbers(text: string): string {
  return text.replace(NUMBER_AT_LINE_START, (_all, space: string, number: string) => `${space}${' '.repeat(number.length)}`).replace(NUMBER_AFTER_SPACE, (number: string) => ' '.repeat(number.length));
}

export type TextCommands = {
  /** Catalog paths the phrases of the text resolve to, sorted, once each. */
  paths: string[];
  /** Phrases found in the text. */
  phrases: number;
  /** Phrases that resolve to no command of the catalog. */
  unresolved: number;
};

/** The commands of each text, in the order given (one extractCommands call per scan of joined texts). */
export function textCommands(catalog: CommandCatalog, texts: readonly string[]): { results: TextCommands[]; warnings: string[] } {
  const results: TextCommands[] = texts.map(() => ({ paths: [], phrases: 0, unresolved: 0 }));
  const warnings: string[] = [];
  if (catalog.size === 0) return { results, warnings };
  let at = 0;
  while (at < texts.length) {
    // One scan: as many whole texts as fit (a single longer text alone; extractCommands reads its first part).
    let joined = '';
    const starts: number[] = [];
    const first = at;
    while (at < texts.length && (joined.length === 0 || joined.length + texts[at].length + SEPARATOR.length <= MAX_SCAN)) {
      starts.push(joined.length);
      joined += withoutListNumbers(foldText(texts[at])) + SEPARATOR;
      at++;
    }
    const scan = extractCommands({ text: joined, heads: catalog.heads });
    for (const warning of scan.warnings) warnings.push(warning);
    let owner = 0;
    for (const phrase of scan.phrases) {
      while (owner + 1 < starts.length && starts[owner + 1] <= phrase.start) owner++;
      const result = results[first + owner];
      result.phrases++;
      const paths = resolvePhrasePaths(catalog, phrase.text);
      if (paths.length === 0) result.unresolved++;
      for (const path of paths) if (!result.paths.includes(path)) result.paths.push(path);
    }
  }
  for (const result of results) result.paths.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { results, warnings };
}
