// Producer of manual entries, from either form of the CLI manual:
// - a markdown@1 model of the converted manual: a command anchor is a paragraph that is only the bold command head and its
//   emphasized parameters (`**demo pool add** *\<pool_name\> \[weight\]*`), or a heading written the same way. Placement:
//   - a signature hangs at its command node only when the command exists in the build's command tree (`/commands` nodes
//     are built by the command-tree producer alone); without a tree the literal decides, unchecked;
//   - a pipe table whose rows carry signatures is split by row: a one-signature row hangs at its command when it exists;
//     a row with several commands hangs at their nearest common ancestor when that is at least one word deeper than
//     /commands (a common ancestor of /commands itself is not a placement); every other row stays at its section node;
//   - the blocks after an anchor, up to the next anchor or heading, describe that command and follow its placement;
//   - every other block hangs at its section node under the manual namespace `/manual/<手册>/<章节路径>` (the preamble at
//     the namespace root); no manual paragraph is left at the tree root.
//   What an entry's digest covers (kind, statement, data, applicability) never depends on the build's tree: the literals
//   the author marked (bold, backticks, quotes, command lines in code blocks, signatures) are recorded as written in
//   `data.command_literals`, never resolved at production time. Placement still uses the tree (the existence checks),
//   so two builds share the manual subtree exactly when their trees place the manual's signatures the same way (K01
//   R[1]); with a tree, the literals it cannot resolve are listed in the warnings as drift candidates.
// - the manual command catalog JSON (schema ist.manual-command-catalog): signatures, value domains, worked examples.
// Signatures are definitions and the text under a command (descriptions, value domains, examples) behaviours (K02 R[3]);
// `data.form` says signature or text.
import type { EntryKind, FragmentRef, ManualCatalog, ManualOptions, ManualResult, MarkdownModel, ProducedEntry, Unplaced } from './types.ts';
import { type CommandCatalog } from './cases-commands.ts';
import { PAGE_PLATFORMS, PRODUCT_LINE } from './naming.ts';
import { asArray, asString, asStrings, compareText, guarded, internalError, isRecord, pathText, squeeze, stripNul, utf8Offsets } from './util.ts';

const MARKDOWN = 'markdown@1';
const JSON_PARSER = 'json@1';
const CATALOG_SCHEMA = 'ist.manual-command-catalog';
const COMMANDS = 'commands';
/** K02 R[3]: a signature defines a command; the text under it describes its behaviour. */
const SIGNATURE: EntryKind = 'definition';
const TEXT: EntryKind = 'behaviour';
const MAX_VARIANTS = 64;
const MAX_DEPTH = 8;
const WORD = /^[A-Za-z0-9?][A-Za-z0-9_.?:/+-]{0,63}$/;
const NUMBER = /^[0-9]+$/;
const CJK = /[　-〿㐀-䶿一-鿿＀-￯]/;
const NOISE_BLOCKS = new Set(['thematic_break']);

export type ManualParam = { name: string; required: boolean };
export type Anchor = { words: string[]; variants: string[][] | null; signature: string; params: ManualParam[] };

/** Removes emphasis markers and backslash escapes, then collapses white space: the canonical signature text. */
export function canonicalSignature(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\' && i + 1 < text.length) out += text[++i];
    else if (ch !== '*') out += ch;
  }
  return squeeze(out);
}

type Role = 'bold' | 'italic' | 'plain';
type Rich = { ch: string; role: Role };

/**
 * Characters of markdown text with the emphasis they stand in (`**` bold, `*` italic), escapes resolved; null when
 * unbalanced. Italic inside bold counts as italic: `**show baseline *\[regex\]***` has the parameter regex.
 */
function richText(text: string): Rich[] | null {
  const out: Rich[] = [];
  let bold = false;
  let italic = false;
  const role = (): Role => (italic ? 'italic' : bold ? 'bold' : 'plain');
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\' && i + 1 < text.length) {
      out.push({ ch: text[++i], role: role() });
      continue;
    }
    if (ch === '*') {
      let n = 1;
      while (text[i + n] === '*') n++;
      if (n >= 2) bold = !bold;
      if (n % 2 === 1) italic = !italic;
      i += n - 1;
      continue;
    }
    out.push({ ch, role: role() });
  }
  return bold || italic ? null : out;
}

type RichToken = { text: string; role: Role };

/** Splits on white space outside {}, [] and <> groups; a token's role is that of its first letter or digit. Null when unbalanced. */
function groupTokens(chars: readonly Rich[]): RichToken[] | null {
  const tokens: RichToken[] = [];
  let depth = 0;
  let current: Rich[] = [];
  const flush = (): void => {
    if (current.length === 0) return;
    const first = current.find((rich) => /[A-Za-z0-9?]/.test(rich.ch)) ?? current[0];
    tokens.push({ text: current.map((rich) => rich.ch).join(''), role: first.role });
    current = [];
  };
  for (const rich of chars) {
    const ch = rich.ch;
    // Adjacent groups ([a][b]) are separate tokens.
    if (depth === 0 && (ch === '{' || ch === '[' || ch === '<') && /[\]}>]/.test(current[current.length - 1]?.ch ?? '')) flush();
    if (ch === '{' || ch === '[' || ch === '<') depth++;
    if (ch === '}' || ch === ']' || ch === '>') depth--;
    if (depth < 0 || depth > MAX_DEPTH) return null;
    if (/\s/.test(ch) && depth === 0) flush();
    else current.push(rich);
  }
  if (depth !== 0) return null;
  flush();
  return tokens;
}

function plainTokens(text: string): string[] | null {
  const tokens = groupTokens([...text].map((ch) => ({ ch, role: 'plain' as Role })));
  return tokens === null ? null : tokens.map((token) => token.text);
}

/** Alternatives of a head group ({a|b}, [a|icmp echo]): each a list of command words; null when one is empty or not words. */
function alternativesOf(token: string): string[][] | null {
  const parts = token
    .slice(1, -1)
    .split('|')
    .map((part) => part.trim().split(/\s+/).filter((word) => word !== ''));
  return parts.length > 0 && parts.every((words) => words.length > 0 && words.every((word) => WORD.test(word))) ? parts : null;
}

function paramsOf(tokens: string[], required: boolean, depth: number, out: ManualParam[]): boolean {
  if (depth > MAX_DEPTH) return false;
  for (const token of tokens) {
    if (/^<[^<>]+>$/.test(token)) out.push({ name: token.slice(1, -1).trim(), required });
    else if (/^\{.*\}$/s.test(token)) out.push({ name: token.slice(1, -1).replace(/[<>]/g, '').replace(/\s+/g, ''), required });
    else if (/^\[.*\]$/s.test(token)) {
      const inner = plainTokens(token.slice(1, -1));
      if (inner === null) return false;
      if (inner.length === 1 && !/^[<{[]/.test(inner[0])) out.push({ name: inner[0].replace(/\s+/g, ''), required: false });
      else if (!paramsOf(inner, false, depth + 1, out)) return false;
    } else out.push({ name: token, required });
  }
  return true;
}

/**
 * A command anchor from markdown text: the bold command head and the italic parameters, nothing else. Null for text
 * that is not an anchor (prose that starts with bold, Chinese labels, unknown first words when `heads` is given).
 */
export function parseAnchor(text: string, heads: ReadonlySet<string> | null = null): Anchor | null {
  const s = stripNul(text).trim();
  if (!s.startsWith('**') || s.length > 2000 || /[\r\n]/.test(s) || CJK.test(s)) return null;
  const chars = richText(s);
  const tokens = chars === null ? null : groupTokens(chars);
  if (tokens === null || tokens.length === 0 || tokens[0].role !== 'bold') return null;
  // Bold tokens before the first parameter are the head; after it everything is a parameter (bold ones are keywords).
  const head: string[] = [];
  const paramTokens: string[] = [];
  for (const token of tokens) {
    const param = paramTokens.length > 0 || token.role !== 'bold' || /^<.*>$/s.test(token.text);
    // Plain text may only hold parameter syntax, never a bare word: a bare plain word is prose.
    if (token.role === 'plain' && !/^[[{<].*[\]}>]$/s.test(token.text)) return null;
    if (param) paramTokens.push(token.text);
    else head.push(token.text);
  }
  // Head tokens: words and {a|b} / [a|b] groups whose alternatives are one or more words; an optional group may be left out.
  const choices: string[][][] = [];
  const words: string[] = [];
  let leading = true;
  let keyDone = false;
  for (const token of head) {
    if (WORD.test(token)) {
      choices.push([[token]]);
      if (!keyDone) words.push(token);
      leading = false;
      continue;
    }
    const optional = token.startsWith('[') && token.endsWith(']');
    const required = token.startsWith('{') && token.endsWith('}');
    const alternatives = optional || required ? alternativesOf(token) : null;
    if (alternatives === null) return null;
    choices.push(optional ? [[], ...alternatives] : alternatives);
    if (!(leading && optional)) keyDone = true;
  }
  if (words.length === 0) return null;
  const params: ManualParam[] = [];
  if (!paramsOf(paramTokens, true, 0, params)) return null;
  let variants: string[][] | null = null;
  if (choices.some((choice) => choice.length > 1)) {
    let lists: string[][] = [[]];
    for (const choice of choices) {
      const next: string[][] = [];
      for (const list of lists) for (const option of choice) next.push([...list, ...option]);
      lists = next;
      if (lists.length > MAX_VARIANTS) break;
    }
    variants = lists.length > MAX_VARIANTS ? null : lists;
  }
  // With known heads, some spelling of the command (a variant or the key) must start with a known first word.
  const firsts = [words[0], ...(variants ?? []).map((variant) => variant[0] ?? '')];
  if (heads !== null && !firsts.some((word) => heads.has(word.toLowerCase()))) return null;
  return { words, variants, signature: canonicalSignature(s), params };
}

/**
 * A single-line paragraph without CJK text that opens in bold and carries signature syntax (<, >, {, }, [, ], |): it was
 * written as a command anchor. When parseAnchor rejects it (a source defect, or a first word that is not a known head), it
 * still ends the command before it: its blocks describe another command.
 */
export function looksLikeSignature(text: string): boolean {
  const s = stripNul(text).trim();
  return s.startsWith('**') && !/[\r\n]/.test(s) && !CJK.test(s) && /[<>{}[\]|]/.test(s);
}

function commandPath(words: readonly string[]): string | null {
  return pathText([COMMANDS, ...words]);
}

/** Trailing spaces off every line, outer blank lines off: the canonical text of a block. */
function blockText(text: string): string {
  return stripNul(text)
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim();
}

function isNoise(kind: string, text: string): boolean {
  return NOISE_BLOCKS.has(kind) || text === '' || (kind === 'html_block' && /^<!--[\s\S]*?-->$/.test(text.trim()));
}

type Section = { title: string; parent: number | null; selector: string | null };
type Block = { kind: string; section: number; text: string; selector: string };

const MANUAL_NS = 'manual';
const DEFAULT_MANUAL_NAME = 'manual';
/** An entry's author-marked command literals are capped so a padded block cannot bloat a stored entry. */
const MAX_LITERALS = 100;
/** The drift warning's list of names fits one stored warning (the count before it stays exact). */
const MAX_DRIFT_TEXT = 800;

const LITERAL_FIRST = /^[a-z?][a-z0-9_.?-]{0,63}$/;
const MAX_LITERAL = 200;
const MAX_LITERAL_WORDS = 16;
/** The emphasis and quote marks an author puts around a command literal. */
const SPAN_MARKS: Array<[string, string]> = [
  ['**', '**'],
  ['`', '`'],
  ['“', '”'],
  ['‘', '’'],
  ['「', '」'],
  ['『', '』'],
];

/**
 * The literal inside a marked span, as written (white space collapsed); null when it does not look like a command:
 * no CJK text, at most 200 characters and 16 words, the first word a CLI word as written (lower case).
 */
export function commandLiteral(span: string): string | null {
  const text = squeeze(span);
  if (text === '' || text.length > MAX_LITERAL || CJK.test(text)) return null;
  const words = text.split(' ');
  if (words.length > MAX_LITERAL_WORDS || !LITERAL_FIRST.test(words[0])) return null;
  return text;
}

/** The marked spans of a prose block that look like command literals, in first-seen order. */
function proseLiterals(text: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    let matched = false;
    for (const [open, close] of SPAN_MARKS) {
      if (!text.startsWith(open, i)) continue;
      matched = true;
      // The closer is searched only within the span's bound, so unmatched openers cost a bounded window each.
      const window = text.slice(i + open.length, i + open.length + MAX_LITERAL + close.length + 1);
      const found = window.indexOf(close);
      const at = found < 0 ? -1 : i + open.length + found;
      if (at >= 0 && at - i - open.length <= MAX_LITERAL) {
        const literal = commandLiteral(text.slice(i + open.length, at));
        if (literal !== null) {
          out.push(literal);
          i = at + close.length;
          break;
        }
      }
      // A rejected or unterminated span is stepped into, not over: the marks inside it still count.
      i += open.length;
      break;
    }
    if (!matched) i++;
  }
  return out;
}

/** The command lines of a code block: a line with a prompt gives the command as written after it. */
function codeLiterals(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const prompt = PROMPT.exec(line);
    if (prompt === null) continue;
    const literal = commandLiteral(prompt[1]);
    if (literal !== null) out.push(literal);
  }
  return out;
}

/** The catalog path of these exact words, or null when the tree has no such command (no abbreviations). */
function existingPath(catalog: CommandCatalog, words: readonly string[]): string | null {
  let node = catalog.root;
  for (const word of words) {
    const next = node.children.get(word.toLowerCase());
    if (next === undefined) return null;
    node = next;
  }
  return node.path;
}

/** Whether a leading run of the literal's words is a complete command of the catalog (the drift check: exact words). */
function resolves(catalog: CommandCatalog, literal: string): boolean {
  let words = literal.split(' ');
  // A leading optional or required group ([no], {no|clear}) is not a word of the tree.
  if (words.length > 0 && /^(?:\[.*\]|\{.*\})$/.test(words[0])) words = words.slice(1);
  let node = catalog.root;
  for (const word of words) {
    const next = node.children.get(word.toLowerCase());
    if (next === undefined) return false;
    node = next;
    if (node.path !== null) return true;
  }
  return false;
}

/**
 * The tree path of an anchor: the exact key words when the command exists; for a signature with head alternatives, the
 * key node (the nearest common node of the variants, K01 R[3]) when EVERY variant exists in the tree (the tree models
 * the alternatives as items below it), spelled from a variant's path; without a tree the literal decides, unchecked.
 * Null when the tree lacks the command.
 */
function anchorPathOf(anchor: Anchor, catalog: CommandCatalog | null): string | null {
  if (catalog === null) return commandPath(anchor.words);
  const direct = existingPath(catalog, anchor.words);
  if (direct !== null) return direct;
  if (anchor.variants === null) return null;
  const variantPaths = anchor.variants.map((variant) => existingPath(catalog, variant));
  if (variantPaths.some((path) => path === null)) return null;
  const key = anchor.words.map((word) => word.toLowerCase());
  const at = anchor.variants.findIndex((variant) => variant.length > key.length && variant.slice(0, key.length).every((word, k) => word.toLowerCase() === key[k]));
  if (at < 0) return null;
  // The key node exists: it is an ancestor of every variant's node, and the builder stores every ancestor.
  return (variantPaths[at] as string).split('/').slice(0, 2 + key.length).join('/');
}

/** The longest common prefix of the word lists (case-insensitive), spelled as the first list writes it. */
function commonPrefix(lists: readonly string[][]): string[] {
  if (lists.length === 0) return [];
  const out: string[] = [];
  for (let k = 0; k < lists[0].length; k++) {
    const word = lists[0][k].toLowerCase();
    if (lists.every((list) => k < list.length && list[k].toLowerCase() === word)) out.push(lists[0][k]);
    else break;
  }
  return out;
}

// Applicability (K02 F[6]): only what the entry's own text says explicitly, and only the fields the contract holds. A
// table row's condition is read from that row alone; a block's from that block alone; nothing is inherited from a
// heading, a sibling block or another row (a section-wide rule waits on the owner's decision). `builds` is never set
// on a manual entry: which builds use the manual is said by the per-build roots and their compositions. Vague,
// inclusive, exception and negated writings are not conditions and stay unread (they stay in the entry's text).
type Conditions = { platforms?: string[]; models?: string[] };

/** Platform values a manual may name: the pack's platform tokens (hyphen-joined) plus the Han words 虚拟/物理. */
const PLATFORM_WORDS: ReadonlySet<string> = new Set([...PAGE_PLATFORMS.map((sequence) => sequence.join('-')), '虚拟', '物理']);
/** The product's own names are never models (APV and NSAE name one product). */
const PRODUCT_NAMES_LOWER: ReadonlySet<string> = new Set(PRODUCT_LINE.names.map((name) => name.toLowerCase()));

/** Escapes a literal for use inside a RegExp. */
const escapeRe = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** List connectives between items (a coordinated list counts only when every item is readable). */
const CONNECTIVES = ['、', ',', '，', '/', '和', '与', '及', '以及', '或者', '或', '并'];
/** A list followed by 等 never counts (the source says it is partial), and an exception list (以外/之外) inverts. */
const ETC = /等等?|以外|之外|其余|其他/;
/** Any of these in the clause before the trigger makes the whole match unread (a negation over the condition). */
const CLAUSE_NEGATION = /[不未无非没勿]/;
/** These right before the trigger widen instead of restrict (也适用于): unread. */
const ALSO_BEFORE = /(?:也|同样|亦|还)\s*$/;
/** The applicability triggers: what follows one, up to the clause's end, is the candidate series. */
const TRIGGERS = [/适用于/gu, /(?:仅|只)\s*(?=[^。；，：]*?支持)/gu];

/** The clause boundaries: a candidate series runs to the next of these, and negations are looked for back to one. */
const CLAUSE_END = /[。；，：\n]/;

/**
 * The conditions one text declares, per field — read linearly, never by a backtracking series regex. For every
 * trigger: the clause before it may not carry a negation or a widening word; the tokens after it, split on the
 * connectives and the field's noun, must all be readable; a trailing 等 (a partial listing) or another connective
 * after the series makes it unread; one unreadable token makes the whole series unread, never a narrowed one.
 */
function conditionsOf(text: string): Conditions {
  const found: { platforms: Set<string>; models: Set<string> } = { platforms: new Set(), models: new Set() };
  for (const trigger of TRIGGERS) {
    trigger.lastIndex = 0;
    let at: RegExpExecArray | null;
    while ((at = trigger.exec(text)) !== null) {
      // The clause before the trigger: back to the previous clause boundary.
      let boundary = 0;
      for (let k = at.index - 1; k >= 0; k -= 1) {
        if (CLAUSE_END.test(text[k] ?? '')) { boundary = k + 1; break; }
      }
      const before = text.slice(boundary, at.index);
      if (CLAUSE_NEGATION.test(before) || ALSO_BEFORE.test(before)) continue;
      const after = text.slice(at.index + at[0].length);
      const seriesEnd = after.search(CLAUSE_END);
      const candidate = (seriesEnd === -1 ? after : after.slice(0, seriesEnd)).trim();
      const itemSplit = new RegExp(`\\s*(?:${CONNECTIVES.map(escapeRe).join('|')})\\s*`, 'u');
      // The series is read as repeated items: `X、Y 平台` or `X 平台与 Y 平台` (each item may repeat the noun). The
      // FIRST noun ends an item group; a connective after it continues the series, another noun extends the field
      // word (系列机型), 等/以外/其他/其余 ends it unread, a negation anywhere after the trigger ends it unread, and
      // any other tail (的功能) is quiet and ends the read.
      const NOUN_RE = /(平台|系列|机型|型号)(?:\s*支持)?/u;
      const fieldOf = (word: string): 'platforms' | 'models' => (word === '平台' ? 'platforms' : 'models');
      let rest = candidate;
      const tokensByField: { platforms: string[]; models: string[] } = { platforms: [], models: [] };
      let field: 'platforms' | 'models' | null = null;
      let ok = true;
      let quiet = false;
      for (;;) {
        const head = NOUN_RE.exec(rest);
        if (head === null) {
          // What is left after the last noun must be quiet (的功能) or a connective followed by the next item.
          const left = rest;
          if (left.trim() === '') break;
          const continued = new RegExp(`^\\s*(?:${CONNECTIVES.map(escapeRe).join('|')})`, 'u').exec(left);
          if (continued !== null) {
            rest = left.slice(continued[0].length);
            const nextNoun = NOUN_RE.exec(rest);
            if (nextNoun === null) { ok = false; break; } // 或其他平台: a connective with no readable item after it
            continue;
          }
          quiet = true;
          break;
        }
        const itemPart = rest.slice(0, head.index);
        const nounWord = head[1]!;
        const nextField = fieldOf(nounWord);
        if (field === null) field = nextField;
        else if (field !== nextField) { ok = false; break; } // mixed fields in one series stay unread
        const pieceTokens = itemPart.split(itemSplit).map((token) => squeeze(token)).filter((token) => token !== '' && token !== nounWord);
        if (itemPart.trim() !== '' && pieceTokens.length === 0) { ok = false; break; }
        tokensByField[field].push(...pieceTokens);
        rest = rest.slice(head.index + head[0].length);
        const after = rest;
        if (after.trim() === '') break;
        if (ETC.test(after) || CLAUSE_NEGATION.test(after)) { ok = false; break; }
        const connective = new RegExp(`^\\s*(?:${CONNECTIVES.map(escapeRe).join('|')})\\s*`, 'u').exec(after);
        if (connective !== null) {
          rest = after.slice(connective[0].length);
          continue;
        }
        quiet = true;
        break;
      }
      if (!ok || field === null || quiet === false && rest.trim() !== '') continue;
      void quiet;
      const tokens = tokensByField[field].filter((token, k, all) => all.indexOf(token) === k);
      if (tokens.length === 0) continue;
      const noun = field === 'platforms' ? '平台' : '系列';
      if (field === 'platforms') {
        const lowered = tokens.map((token) => token.toLowerCase());
        if (lowered.every((token) => PLATFORM_WORDS.has(token))) lowered.forEach((token) => found.platforms.add(token));
      } else if (tokens.every((token) => !PRODUCT_NAMES_LOWER.has(token.toLowerCase()))) {
        tokens.forEach((token) => found.models.add(token));
      }
    }
  }
  const out: Conditions = {};
  if (found.platforms.size > 0) out.platforms = [...found.platforms].sort(compareText);
  if (found.models.size > 0) out.models = [...found.models].sort(compareText);
  return out;
}

/** The applicability of an entry, or null (未声明) when nothing declares a condition. */
function toApplicability(conditions: Conditions): ProducedEntry['applicability'] {
  return conditions.platforms === undefined && conditions.models === undefined ? null : conditions;
}

function fromMarkdown(model: MarkdownModel, heads: ReadonlySet<string> | null, options: ManualOptions, warnings: string[]): ManualResult {
  const entries: ProducedEntry[] = [];
  const name = typeof options.name === 'string' && options.name !== '' ? options.name : DEFAULT_MANUAL_NAME;
  const catalog = options.catalog ?? null;
  const sections: Section[] = asArray(model.sections).map((value) => {
    if (!isRecord(value)) return { title: '', parent: null, selector: null };
    const parent = Number.isInteger(value.parent) ? (value.parent as number) : null;
    return { title: asString(value.title) ?? '', parent, selector: asString(value.selector) };
  });
  // The title chain of every section (top first), for the readable `section` of an entry's data.
  const titleChains: string[][] = sections.map((_, index) => {
    const titles: string[] = [];
    const visited = new Set<number>();
    for (let at: number | null = index; at !== null && at > 0 && at < sections.length && !visited.has(at); at = sections[at].parent) {
      visited.add(at);
      titles.push(squeeze(sections[at].title));
    }
    return titles.reverse();
  });
  const sectionText = (index: number): string => (index >= 0 && index < titleChains.length ? titleChains[index] : []).join(' / ');
  let missingSection = 0;
  let unwritable = 0;
  let manualRoot = pathText([MANUAL_NS, name]);
  if (manualRoot === null) {
    manualRoot = `/${MANUAL_NS}/${DEFAULT_MANUAL_NAME}`;
    warnings.push(`手册名写不进树路径，改用 ${DEFAULT_MANUAL_NAME}`);
  }
  /** Decoded segments of a section's heading path (the block.path spelling), null when the section cannot be cited. */
  const sectionSegments = (index: number): string[] | null => {
    if (index === 0) return [];
    const selector = sections[index]?.selector;
    if (typeof selector !== 'string' || !selector.startsWith('h/')) return null;
    try {
      return selector.slice(2).split('/').map((part) => decodeURIComponent(part));
    } catch {
      return null;
    }
  };
  /** The manual-namespace path of a block's section (the namespace root when it cannot be written). */
  const sectionPath = (value: { [key: string]: unknown }, section: number): string => {
    if (section < 0 || section >= sections.length) {
      missingSection++;
      return manualRoot as string;
    }
    const raw = value.path;
    let segments: string[] | null;
    if (Array.isArray(raw)) segments = raw.every((item): item is string => typeof item === 'string') ? (raw as string[]) : null;
    else if (raw === null) segments = null;
    else segments = sectionSegments(section);
    const path = segments === null ? null : pathText([MANUAL_NS, name, ...segments]);
    if (path === null) {
      unwritable++;
      return manualRoot as string;
    }
    return path;
  };
  const sectionEntryPath = (index: number): string => {
    const segments = sectionSegments(index);
    const path = segments === null ? null : pathText([MANUAL_NS, name, ...segments]);
    if (path === null) {
      unwritable++;
      return manualRoot as string;
    }
    return path;
  };
  // Every literal found, past the per-entry cap: the drift total counts them all.
  const allLiterals = new Set<string>();
  // The literals of the signatures placed at /commands resolve by the placement check itself (variants included).
  const placedSignatureLiterals = new Set<string>();
  const noteSignature = (entry: ProducedEntry): void => {
    for (const literal of asStrings(entry.data.command_literals)) {
      allLiterals.add(literal);
      if (entry.path?.startsWith('/commands/')) placedSignatureLiterals.add(literal);
    }
  };
  const putLiterals = (entry: ProducedEntry, kind: string, text: string): void => {
    const found = kind === 'code_block' ? codeLiterals(text) : kind === 'html_block' ? [] : proseLiterals(text);
    const unique = [...new Set(found)].sort(compareText);
    for (const literal of unique) allLiterals.add(literal);
    if (unique.length === 0) return;
    entry.data.command_literals = unique.slice(0, MAX_LITERALS);
    if (unique.length > MAX_LITERALS) entry.data.command_literals_cut = true;
  };
  /**
   * A behaviour entry. `data` has the same shape whatever the tree says (K01 R[1]): `words` whenever the block follows
   * an anchor, `section` always; the tree only chooses the path. Applicability comes from the entry's own text alone
   * (K02 F[6]): no condition is inherited from a heading, a sibling block or another row.
   */
  const textEntry = (init: { path: string; statement: string; block: string; section: number; words?: string[]; fragments: FragmentRef[] }): ProducedEntry => {
    const data: { [key: string]: unknown } = { form: 'text', block: init.block, section: sectionText(init.section) };
    if (init.words !== undefined) data.words = init.words;
    const entry: ProducedEntry = { kind: TEXT, path: init.path, statement: init.statement, data, fragments: init.fragments, applicability: toApplicability(conditionsOf(init.statement)) };
    putLiterals(entry, init.block, init.statement);
    return entry;
  };
  /** Byte ranges of the lines of a block's text (the fragment text the selectors name). */
  const lineRanges = (text: string): Array<[number, number]> => {
    const offsets = utf8Offsets(text);
    const out: Array<[number, number]> = [];
    let start = 0;
    for (let i = 0; i <= text.length; i++) {
      if (i === text.length || text.charCodeAt(i) === 0x0a) {
        out.push([offsets[start], offsets[i]]);
        start = i + 1;
      }
    }
    return out;
  };

  // Heading anchors: a heading whose text (after its numbering) is a bold command signature.
  const headingAnchors = new Map<number, { anchor: Anchor; path: string }>();
  sections.forEach((section, index) => {
    if (index === 0 || section.selector === null) return;
    const title = section.title.replace(/^\s*[0-9]+(?:\.[0-9]+)*[.．、]?\s+/, '');
    if (!title.trimStart().startsWith('**')) return;
    const anchor = parseAnchor(title, heads);
    if (anchor === null) return;
    // Only a node the build's command tree has; without a tree the literal decides, unchecked. A signature whose
    // command is missing stays a definition entry at its section node.
    const placed = anchorPathOf(anchor, catalog) ?? sectionEntryPath(index);
    headingAnchors.set(index, { anchor, path: placed });
    const entry = signatureEntry(anchor, placed, { parser: MARKDOWN, selector: section.selector as string });
    noteSignature(entry);
    entry.applicability = toApplicability(conditionsOf(section.title));
    entries.push(entry);
  });

  /**
   * Whether an anchor parsed from a table cell is a row signature, decided from the manual alone (K02 R[3]): a
   * definition comes only from a signature, and a bare single bold word is a value, a parameter name or a term, not a
   * command. A cell counts when its head has two or more words, or carries parameter or group syntax; a header that
   * names commands (命令/Command) keeps even one-word rows as signatures.
   */
  const isRowSignature = (anchor: Anchor, headerNamesCommands: boolean): boolean =>
    headerNamesCommands || anchor.words.length >= 2 || anchor.params.length > 0 || anchor.variants !== null;

  /**
   * The signatures of one table cell: the whole cell is one signature, or a list of signatures joined by bare
   * connectives (与/和/及/或、顿号、逗号、斜线). A bold span inside prose is not a signature (a mention: it is recorded
   * in command_literals only).
   */
  const cellAnchors = (cell: string, headerNamesCommands: boolean): Anchor[] => {
    if (!cell.includes('**')) return [];
    const parts = cell.split(new RegExp(`(${CJK.source}+)`, 'u'));
    const out: Anchor[] = [];
    for (let k = 0; k < parts.length; k++) {
      if (k % 2 === 1) {
        if (!/^[与和及或、,，/\s]*$/.test(parts[k])) return [];
        continue;
      }
      const piece = parts[k].trim();
      if (piece === '') continue;
      const anchor = parseAnchor(piece, heads);
      if (anchor === null) return [];
      if (!isRowSignature(anchor, headerNamesCommands)) return [];
      out.push(anchor);
    }
    return out;
  };

  /** The rows of a pipe table, or null when the block is not one (grid, multiline and simple tables are not split). */
  const splitRowOf = (line: string): string[] | null => {
    let body = line.trim();
    if (!body.includes('|')) return null;
    if (body.startsWith('|')) body = body.slice(1);
    if (body.endsWith('|')) body = body.slice(0, -1);
    return body.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'));
  };
  const pipeRows = (text: string): { lines: string[]; rows: Array<{ line: number; cells: string[] }> } | null => {
    const splitRow = splitRowOf;
    const lines = text.split('\n');
    if (lines.length < 3 || splitRow(lines[0]) === null) return null;
    const delimiter = splitRow(lines[1]);
    if (delimiter === null || delimiter.length === 0 || !delimiter.every((cell) => /^:?-+:?$/.test(cell))) return null;
    const rows: Array<{ line: number; cells: string[] }> = [];
    for (let k = 2; k < lines.length; k++) {
      const cells = splitRow(lines[k]);
      if (cells === null) return null;
      rows.push({ line: k, cells });
    }
    return { lines, rows };
  };

  let invalid = 0;
  let rejected = 0;
  // The command the blocks describe: set by a heading anchor when its section starts, by a paragraph anchor, and ended by
  // a new section or a paragraph written as a signature that does not parse.
  let section: number | null = null;
  let current: { path: string; words: string[] } | null = null;
  for (const value of asArray(model.blocks)) {
    if (!isRecord(value) || typeof value.kind !== 'string' || !Number.isInteger(value.section) || typeof value.text !== 'string' || typeof value.selector !== 'string') {
      invalid++;
      continue;
    }
    const block: Block = { kind: value.kind, section: value.section as number, text: value.text, selector: value.selector };
    if (block.section !== section) {
      section = block.section;
      const heading = headingAnchors.get(block.section);
      current = heading !== undefined && heading.path !== null ? { path: heading.path, words: heading.anchor.words } : null;
    }
    const text = blockText(block.text);
    if (isNoise(block.kind, text)) continue;
    const fragment: FragmentRef = { parser: MARKDOWN, selector: block.selector };
    const anchor = block.kind === 'paragraph' ? parseAnchor(text, heads) : null;
    if (anchor !== null) {
      // A signature whose command is not in the build's tree is still a signature: it hangs at its section node, and
      // the blocks after it follow it there (same data as at a command node: the tree only chooses the path).
      const placed = anchorPathOf(anchor, catalog) ?? sectionPath(value, block.section);
      const entry = signatureEntry(anchor, placed, fragment);
      noteSignature(entry);
      entry.applicability = toApplicability(conditionsOf(text));
      entries.push(entry);
      current = { path: placed, words: anchor.words };
      continue;
    }
    // A command table is split by row, decided by the manual alone: every row that carries a signature becomes its own
    // entries. The tree only chooses the path: a one-signature row hangs at its command when the command exists; a row
    // with several commands at their nearest common ancestor over ALL of them when every one exists and the ancestor is
    // at least one word deeper than /commands (the namespace root itself is not a placement); otherwise the row hangs at
    // its section node. Rows without a signature (parameter rows) keep the table's remainder at the current command,
    // or at the section node.
    if (block.kind === 'table') {
      const table = pipeRows(block.text);
      if (table !== null) {
        const ranges = lineRanges(block.text);
        const header = splitRowOf(table.lines[0] ?? '');
        const headerNamesCommands = header !== null && header.some((cell) => /^(命令|command)$/i.test(cell.trim()));
        const split: ProducedEntry[] = [];
        const remainder: number[] = [];
        const valueLiterals = new Set<string>();
        let signatureRows = 0;
        for (const row of table.rows) {
          const found = row.cells.flatMap((cell, cellIndex) => cellAnchors(cell, headerNamesCommands).map((cellAnchor) => ({ cell: cellIndex, anchor: cellAnchor })));
          if (found.length === 0) {
            // A bare bold word in a cell is a value, parameter name or term: the row stays in the remainder and the
            // word is a command literal only (a mention, research 2 rule 4), never a signature.
            if (row.cells.some((cell) => cell.includes('**'))) {
              for (const cell of row.cells) {
                for (const word of cell.replaceAll('**', ' ').split(/\s+/u)) {
                  if (word !== '' && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(word)) valueLiterals.add(word.toLowerCase());
                }
              }
            }
            remainder.push(row.line);
            continue;
          }
          signatureRows++;
          const rowFragment: FragmentRef = { parser: MARKDOWN, selector: block.selector, range: ranges[row.line] };
          const rowText = table.lines[row.line].trimEnd();
          if (found.length === 1) {
            const { cell, anchor: one } = found[0];
            const path = anchorPathOf(one, catalog) ?? sectionPath(value, block.section);
            const signature = signatureEntry(one, path, rowFragment);
            noteSignature(signature);
            signature.applicability = toApplicability(conditionsOf(rowText));
            split.push(signature);
            const described = row.cells.filter((cellText, k) => k !== cell && cellText !== '');
            if (described.length > 0) split.push(textEntry({ path, statement: described.join('；'), block: 'table', section: block.section, words: one.words, fragments: [rowFragment] }));
            continue;
          }
          let placed: string | null = null;
          const paths = found.map(({ anchor: some }) => anchorPathOf(some, catalog));
          if (paths.every((path) => path !== null)) {
            const lca = commonPrefix(found.map(({ anchor: some }) => some.words));
            if (lca.length >= 1) placed = (paths[0] as string).split('/').slice(0, 2 + lca.length).join('/');
          }
          split.push(textEntry({ path: placed ?? sectionPath(value, block.section), statement: row.cells.join(' | '), block: 'table', section: block.section, fragments: [rowFragment] }));
        }
        for (const literal of valueLiterals) allLiterals.add(literal);
        if (signatureRows > 0) {
          entries.push(...split);
          if (remainder.length > 0) {
            const lines = [table.lines[0], ...remainder.map((line) => table.lines[line])].map((line) => line.trimEnd());
            entries.push(
              textEntry({
                path: current !== null ? current.path : sectionPath(value, block.section),
                statement: lines.join('\n'),
                block: 'table',
                section: block.section,
                fragments: [0, ...remainder].map((line) => ({ parser: MARKDOWN, selector: block.selector, range: ranges[line] }) as FragmentRef),
              }),
            );
          }
          continue;
        }
      }
    }
    const rejectedSignature = block.kind === 'paragraph' && looksLikeSignature(text);
    if (rejectedSignature) {
      rejected++;
      current = null;
    }
    if (current !== null && !rejectedSignature) {
      entries.push(textEntry({ path: current.path, statement: text, block: block.kind, section: block.section, words: current.words, fragments: [fragment] }));
      continue;
    }
    // Every other block hangs at its section node.
    const entry = textEntry({ path: sectionPath(value, block.section), statement: text, block: block.kind, section: block.section, fragments: [fragment] });
    if (rejectedSignature) entry.data.signature_rejected = true;
    entries.push(entry);
  }

  // The literals the build's tree cannot resolve are drift candidates of the production (never nodes of their own).
  // A signature placed at /commands resolves by the placement check itself (its variants included); every other literal
  // resolves when a leading run of its words is a complete command. The count covers every literal found, past the
  // per-entry cap; the listed names are cut to fit one stored warning (the core keeps 1000 characters per warning).
  if (catalog !== null) {
    const unresolved = new Set<string>();
    for (const literal of allLiterals) {
      if (placedSignatureLiterals.has(literal)) continue;
      if (!resolves(catalog, literal)) unresolved.add(literal);
    }
    if (unresolved.size > 0) {
      const sorted = [...unresolved].sort(compareText);
      let shown = '';
      let counted = 0;
      for (const literal of sorted) {
        const next = shown === '' ? literal : `${shown}、${literal}`;
        if (next.length > MAX_DRIFT_TEXT) break;
        shown = next;
        counted++;
      }
      warnings.push(`有 ${sorted.length} 个命令字面在本构建的命令树里解析不到，是漂移候选：${shown}${counted < sorted.length ? ' 等' : ''}`);
    }
  }

  if (invalid > 0) warnings.push(`有 ${invalid} 个块格式不对，已跳过`);
  if (rejected > 0) {
    warnings.push(`有 ${rejected} 段写成命令签名的文字不能作为命令锚点（括号不配对、转义多余或首词不是已知命令），这些段落及其后的块不归到前一条命令，挂在所在章节节点`);
  }
  if (missingSection > 0) warnings.push(`有 ${missingSection} 个块指向不存在的章节，挂在手册命名空间的根下`);
  if (unwritable > 0) warnings.push(`有 ${unwritable} 个块的章节路径写不出（过长或含写不出的字符），挂在手册命名空间的根下`);
  return { entries, unplaced: [], warnings };
}

/** A signature's literals are its command words and variants (never the parameters): what read time can match. */
function signatureEntry(anchor: Anchor, path: string, fragment: FragmentRef): ProducedEntry {
  const literals = [...new Set([anchor.words, ...(anchor.variants ?? [])].map((words) => words.join(' ')))].sort(compareText);
  const data: { [key: string]: unknown } = { words: anchor.words, form: 'signature', signature: anchor.signature, params: anchor.params, command_literals: literals };
  if (anchor.variants !== null) data.variants = anchor.variants;
  return { kind: SIGNATURE, path, statement: anchor.signature, data, fragments: [fragment], applicability: null };
}

const PROMPT = /^\s*[^\s>#()]{0,64}(?:\([^)]{0,64}\))?[>#]\s*(\S.*)$/;

/** Index of the first head word that is not a command word, or a number after the first word (an example value); -1 when none. */
function exampleWordAt(words: readonly string[]): number {
  return words.findIndex((word, i) => !WORD.test(word) || (i > 0 && NUMBER.test(word)));
}

function fromCatalog(catalog: ManualCatalog, warnings: string[]): ManualResult {
  const entries: ProducedEntry[] = [];
  const unplaced: Unplaced[] = [];
  const index = new Map<string, { path: string; words: string[] }>();
  let invalid = 0;
  type Signature = { k: number; value: { [key: string]: unknown } & { signature_verbatim: string }; words: string[] };
  const listed: Signature[] = [];
  asArray(catalog.signatures).forEach((value, k) => {
    if (!isRecord(value) || typeof value.signature_verbatim !== 'string') {
      invalid++;
      return;
    }
    const words = asStrings(value.head_tokens).flatMap((token) => squeeze(token).split(' ')).filter((word) => word !== '');
    if (words.length === 0 || words.some((word) => word.length > 64)) {
      invalid++;
      return;
    }
    listed.push({ k, value: value as Signature['value'], words });
  });
  if (invalid > 0) warnings.push(`有 ${invalid} 条签名格式不对或没有命令词，已跳过`);
  // The catalog also lists worked example lines as signatures (quoted values, numbers after a known head). They are
  // never commands (K01 R[3]: no synthetic paths): an example goes to the longest known head before its first value,
  // else it is unplaced. A number with no known head before it stays a command word.
  const known = new Set(listed.filter((item) => exampleWordAt(item.words) < 0).map((item) => item.words.join(' ').toLowerCase()));
  for (const { k, value, words } of listed) {
    const fragments: FragmentRef[] = [{ parser: JSON_PARSER, selector: `p/signatures/${k}/signature_verbatim` }];
    const signature = canonicalSignature(value.signature_verbatim);
    const at = exampleWordAt(words);
    if (at >= 0) {
      let head: string[] | null = null;
      for (let n = at; n > 0 && head === null; n--) if (known.has(words.slice(0, n).join(' ').toLowerCase())) head = words.slice(0, n);
      const path = head === null ? null : commandPath(head);
      if (head !== null && path !== null) {
        entries.push({ kind: TEXT, path, statement: signature, data: { words: head, form: 'text', example: true }, fragments, applicability: null });
        continue;
      }
      if (!words.every((word) => WORD.test(word))) {
        unplaced.push({ fragment: fragments[0], section: words.join(' ').slice(0, 200), kind: TEXT, text: signature });
        continue;
      }
    }
    const path = commandPath(words);
    if (path === null) {
      unplaced.push({ fragment: fragments[0], section: words.join(' ').slice(0, 200), kind: SIGNATURE, text: signature });
      continue;
    }
    const params = asArray(value.params)
      .filter((param): param is { name: string; required: unknown } => isRecord(param) && typeof param.name === 'string' && param.name !== '')
      .map((param) => ({ name: param.name, required: param.required !== false }));
    const data: { [key: string]: unknown } = { words, form: 'signature', signature, params };
    const variants = asArray(value.head_variants)
      .map((variant) => asStrings(variant))
      .filter((variant) => variant.length > 0);
    if (variants.length > 0) data.variants = variants;
    entries.push({ kind: SIGNATURE, path, statement: signature, data, fragments, applicability: null });
    const key = words.join(' ').toLowerCase();
    if (!index.has(key)) index.set(key, { path, words });
  }

  asArray(catalog.value_domains).forEach((value, k) => {
    if (!isRecord(value) || typeof value.desc !== 'string') return;
    const head = squeeze(asString(value.head) ?? '');
    const param = squeeze(asString(value.param) ?? '');
    const found = index.get(head.toLowerCase());
    const desc = squeeze(value.desc);
    if (found === undefined || param === '') {
      unplaced.push({ fragment: { parser: JSON_PARSER, selector: `p/value_domains/${k}` }, section: head, kind: TEXT, text: desc });
      return;
    }
    entries.push({
      kind: TEXT,
      path: found.path,
      statement: `${param}: ${desc}`,
      data: { words: found.words, form: 'text', param, values: asStrings(value.enums) },
      fragments: [{ parser: JSON_PARSER, selector: `p/value_domains/${k}/desc` }],
      applicability: null,
    });
  });

  asArray(catalog.worked_examples).forEach((value, k) => {
    if (!isRecord(value)) return;
    const lines = asStrings(value.lines).map((line) => stripNul(line).trimEnd());
    const text = lines.filter((line) => line.trim() !== '').join('\n');
    if (text === '') return;
    let found: { path: string; words: string[] } | undefined;
    const prompt = lines.map((line) => PROMPT.exec(line)).find((match) => match !== null);
    if (prompt) {
      const words = squeeze(prompt[1]).toLowerCase().split(' ');
      for (let n = Math.min(words.length, 16); n > 0 && found === undefined; n--) found = index.get(words.slice(0, n).join(' '));
    }
    if (found === undefined) {
      unplaced.push({ fragment: { parser: JSON_PARSER, selector: `p/worked_examples/${k}` }, section: '', kind: TEXT, text });
      return;
    }
    entries.push({
      kind: TEXT,
      path: found.path,
      statement: text,
      data: { words: found.words, form: 'text', example: true },
      fragments: [{ parser: JSON_PARSER, selector: `p/worked_examples/${k}/lines` }],
      applicability: null,
    });
  });
  return { entries, unplaced, warnings };
}

function isCatalog(value: unknown): value is ManualCatalog {
  if (!isRecord(value) || !Array.isArray(value.signatures)) return false;
  const identity = isRecord(value.identity) ? value.identity : {};
  return value.schema === CATALOG_SCHEMA || identity.schema === CATALOG_SCHEMA;
}

function isMarkdown(value: unknown): value is MarkdownModel {
  return isRecord(value) && Array.isArray(value.sections) && Array.isArray(value.blocks);
}

/** Entries of a converted manual (markdown@1 model) or of the manual command catalog. `heads`: known first words. */
export function produceManualEntries(input: MarkdownModel | ManualCatalog, heads: readonly string[] | null = null, options: ManualOptions = {}): ManualResult {
  const warnings: string[] = [];
  try {
    const known = heads === null ? null : new Set(asStrings(heads).map((head) => squeeze(head).split(' ')[0].toLowerCase()).filter((head) => head !== ''));
    if (isCatalog(input)) return fromCatalog(input, warnings);
    if (isMarkdown(input)) return fromMarkdown(input, known !== null && known.size > 0 ? known : null, options, warnings);
    return { entries: [], unplaced: [], warnings: ['输入既不是 markdown@1 模型，也不是手册命令目录（ist.manual-command-catalog）'] };
  } catch (error) {
    return { entries: [], unplaced: [], warnings: [...warnings, internalError(error)] };
  }
}

/** Pack function entry: the model or catalog, or `{ model, heads, name }` (`name` is the segment under /manual). */
export default function manual(input: unknown): ManualResult {
  return guarded(
    () => {
      if (isRecord(input) && 'model' in input && !isMarkdown(input) && !isCatalog(input)) {
        const name = typeof input.name === 'string' && input.name !== '' ? input.name : undefined;
        return produceManualEntries(input.model as MarkdownModel, Array.isArray(input.heads) ? asStrings(input.heads) : null, name === undefined ? {} : { name });
      }
      return produceManualEntries(input as MarkdownModel);
    },
    (warning) => ({ entries: [], unplaced: [], warnings: [warning] }),
  );
}
