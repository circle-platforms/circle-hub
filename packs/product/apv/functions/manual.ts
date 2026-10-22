// Producer of manual entries at the command nodes (/commands/<words>), from either form of the CLI manual:
// - a markdown@1 model of the converted manual: a command anchor is a paragraph that is only the bold command head and its
//   emphasized parameters (`**demo pool add** *\<pool_name\> \[weight\]*`), or a heading written the same way; the blocks
//   after an anchor, up to the next anchor or heading, describe that command; a paragraph written as a signature that does
//   not parse ends the command; every other block is returned unplaced;
// - the manual command catalog JSON (schema ist.manual-command-catalog): signatures, value domains, worked examples.
// Signatures are definitions and the text under a command (descriptions, value domains, examples) behaviours (K02 R[3]);
// `data.form` says signature or text.
import type { EntryKind, FragmentRef, ManualCatalog, ManualResult, MarkdownModel, ProducedEntry, Unplaced } from './types.ts';
import { asArray, asString, asStrings, guarded, internalError, isRecord, pathText, squeeze, stripNul } from './util.ts';

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

function fromMarkdown(model: MarkdownModel, heads: ReadonlySet<string> | null, warnings: string[]): ManualResult {
  const entries: ProducedEntry[] = [];
  const unplaced: Unplaced[] = [];
  const sections: Section[] = asArray(model.sections).map((value) => {
    if (!isRecord(value)) return { title: '', parent: null, selector: null };
    const parent = Number.isInteger(value.parent) ? (value.parent as number) : null;
    return { title: asString(value.title) ?? '', parent, selector: asString(value.selector) };
  });
  const sectionPath = (index: number): string => {
    const titles: string[] = [];
    const visited = new Set<number>();
    for (let at: number | null = index; at !== null && at > 0 && at < sections.length && !visited.has(at); at = sections[at].parent) {
      visited.add(at);
      titles.push(squeeze(sections[at].title));
    }
    return titles.reverse().join(' / ');
  };
  // Heading anchors: a heading whose text (after its numbering) is a bold command signature.
  const headingAnchors = new Map<number, { anchor: Anchor; path: string }>();
  sections.forEach((section, index) => {
    if (index === 0 || section.selector === null) return;
    const title = section.title.replace(/^\s*[0-9]+(?:\.[0-9]+)*[.．、]?\s+/, '');
    if (!title.trimStart().startsWith('**')) return;
    const anchor = parseAnchor(title, heads);
    const path = anchor === null ? null : commandPath(anchor.words);
    if (anchor === null || path === null) return;
    headingAnchors.set(index, { anchor, path });
    entries.push(signatureEntry(anchor, path, { parser: MARKDOWN, selector: section.selector }));
  });
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
      current = heading ? { path: heading.path, words: heading.anchor.words } : null;
    }
    const text = blockText(block.text);
    if (isNoise(block.kind, text)) continue;
    const fragment: FragmentRef = { parser: MARKDOWN, selector: block.selector };
    const anchor = block.kind === 'paragraph' ? parseAnchor(text, heads) : null;
    const path = anchor === null ? null : commandPath(anchor.words);
    if (anchor !== null && path !== null) {
      entries.push(signatureEntry(anchor, path, fragment));
      current = { path, words: anchor.words };
      continue;
    }
    if (block.kind === 'paragraph' && looksLikeSignature(text)) {
      rejected++;
      current = null;
    } else if (current !== null) {
      entries.push({ kind: TEXT, path: current.path, statement: text, data: { words: current.words, form: 'text', block: block.kind }, fragments: [fragment], applicability: null });
      continue;
    }
    // A paragraph written as a signature stays a definition when unplaced; any other block is text under some command.
    unplaced.push({ fragment, section: sectionPath(block.section), kind: block.kind === 'paragraph' && looksLikeSignature(text) ? SIGNATURE : TEXT, text });
  }
  if (invalid > 0) warnings.push(`有 ${invalid} 个块格式不对，已跳过`);
  if (rejected > 0) {
    warnings.push(`有 ${rejected} 段写成命令签名的文字不能作为命令锚点（括号不配对、转义多余或首词不是已知命令），这些段落及其后的块不归到前一条命令，留给归类`);
  }
  return { entries, unplaced, warnings };
}

function signatureEntry(anchor: Anchor, path: string, fragment: FragmentRef): ProducedEntry {
  const data: { [key: string]: unknown } = { words: anchor.words, form: 'signature', signature: anchor.signature, params: anchor.params };
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
export function produceManualEntries(input: MarkdownModel | ManualCatalog, heads: readonly string[] | null = null): ManualResult {
  const warnings: string[] = [];
  try {
    const known = heads === null ? null : new Set(asStrings(heads).map((head) => squeeze(head).split(' ')[0].toLowerCase()).filter((head) => head !== ''));
    if (isCatalog(input)) return fromCatalog(input, warnings);
    if (isMarkdown(input)) return fromMarkdown(input, known !== null && known.size > 0 ? known : null, warnings);
    return { entries: [], unplaced: [], warnings: ['输入既不是 markdown@1 模型，也不是手册命令目录（ist.manual-command-catalog）'] };
  } catch (error) {
    return { entries: [], unplaced: [], warnings: [...warnings, internalError(error)] };
  }
}

/** Pack function entry: the model or catalog, or `{ model, heads }`. */
export default function manual(input: unknown): ManualResult {
  return guarded(
    () => {
      if (isRecord(input) && 'model' in input && !isMarkdown(input) && !isCatalog(input)) {
        return produceManualEntries(input.model as MarkdownModel, Array.isArray(input.heads) ? asStrings(input.heads) : null);
      }
      return produceManualEntries(input as MarkdownModel);
    },
    (warning) => ({ entries: [], unplaced: [], warnings: [warning] }),
  );
}
