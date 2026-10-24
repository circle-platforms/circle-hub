import { APPLICABILITY_FIELD,labelOf } from './generated/vocabulary.ts';
// Producer of manual entries, from either form of the CLI manual:
// - a markdown@1 model of the converted manual: a command anchor is a paragraph that is only the bold command head and its
//   emphasized parameters (`**demo pool add** *\<pool_name\> \[weight\]*`), or a heading written the same way. Placement:
//   - a signature hangs at its command node only when the command exists in the build's command tree (a DIRECT call
//     without a catalog places by the literal, unchecked; a PRODUCTION with no tree slot or a non-xml@1 tree keeps
//     every signature at its section node, warns with the missing fact and the next action, and lists no drift) (`/commands` nodes
//     are built by the command-tree producer alone).
//   - a pipe table whose rows carry signatures is split by row: a one-signature row hangs at its command when it exists
//     and every command of a multi-command row exists (then the row hangs at their nearest common ancestor when that
//     is at least one word deeper than /commands — /commands itself is not a placement); rows without a signature
//     (parameter rows, value rows whose bold word is one bare word) form the table's remainder, which follows the
//     current command or hangs at the section node;
//   - the blocks after an anchor, up to the next anchor or heading, describe that command and follow its placement;
//   - every other block hangs at its section node under the manual namespace `/manual/<手册>/<章节路径>` (the preamble at
//     the namespace root); no manual paragraph is left at the tree root.
//   What an entry's digest covers (kind, statement, data, applicability) never depends on the build's tree: the literals
//   the author marked (bold, backticks, quotes, command lines in code blocks, signatures) are recorded as written in
//   prose/code in `data.command_literals`, signatures in `data.signature_literals` groups, never resolved in entry data.
//   Placement still uses the tree (the existence checks),
//   so two builds share the manual subtree exactly when their trees place the manual's signatures the same way (K01
//   R[1]); the complete literals are checked by the shared relation evaluator using the product declaration.
// - the manual command catalog JSON (schema ist.manual-command-catalog): signatures, value domains, worked examples.
// Signatures are definitions and the text under a command (descriptions, value domains, examples) behaviours (K02 R[3]);
// `data.form` says signature or text.
import type { EntryKind, FragmentRef, ManualCatalog, ManualOptions, ManualResult, MarkdownModel, ProducedEntry, Unplaced } from './types.ts';
import { type CommandCatalog } from './cases-commands.ts';
import { PAGE_PLATFORMS, PRODUCT_LINE } from './naming.ts';
import { canonicalJson, asArray, asString, asStrings, compareText, guarded, internalError, isRecord, pathText, squeeze, stripNul, utf8Offsets } from './util.ts';

const MARKDOWN = 'markdown@1';
// The fragment parser key of this call's input model (K1: a document model with section paths; the adoc producer
// passes its own key so the placement code stays unchanged).
const parserOf = (options: ManualOptions): string => options.fragmentParser ?? MARKDOWN;
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
    if (WORD.test(token) && !/[\/]/.test(token)) {
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
  if (!s.startsWith('**') || /[\r\n]/.test(s) || CJK.test(s)) return false;
  // A bold paragraph with parameter or group syntax, or with a slash inside or between its bold runs (a head the
  // tree cannot name: ip/ipv6, or two glued commands), is written as a signature: it ends the current command and
  // hangs at its section (closure finding 18).
  return /[<>{}[\]|]/.test(s) || /\*\*[^*]+\*\*[/／]+/.test(s) || /\*\*[^*/]*[/／][^*]*\*\*/.test(s);
}

function commandPath(words: readonly string[]): string | null {
  return pathText([COMMANDS, ...words]);
}

/** Trailing spaces off every line, outer blank lines off: the canonical text of a block. */
/** The applicability of a multi-row table statement: only when every data row states the same condition. */
function tableEveryRow(statement: string, vocabulary:ClosedSets): ProducedEntry['applicability'] {
  const lines = statement.split('\n').filter((line) => line.trim() !== '');
  const data = lines.filter((line) => {
    const cells = line.split('|').map((cell) => cell.trim()).filter((cell) => cell !== '');
    return cells.length > 0 && !cells.every((cell) => /^:?-+:?$/.test(cell));
  });
  if (data.length === 0) return null;
  let acc: ProducedEntry['applicability'] = null;
  for (const line of data) {
    const own = toApplicability(conditionsOf(line,vocabulary));
    if (own === null) return null;
    if (acc === null) acc = own;
    else if (JSON.stringify(acc) !== JSON.stringify(own)) return null;
  }
  return acc;
}

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

type Section = { title: string; parent: number | null; selector: string | null; path: string[] | null };
type Block = { kind: string; section: number; text: string; selector: string };

const MANUAL_NS = 'manual';
const DEFAULT_MANUAL_NAME = 'manual';
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

/** A head word never contains a slash: two bold runs glued by a plain character are two commands. */
const HEAD_WORD = /^[A-Za-z][A-Za-z0-9_-]*$/;

/**
 * The tree path of an anchor: the exact key words when the command exists; for a signature with head alternatives, the
 * key node (the nearest common node of the variants, K01 R[3]) when EVERY variant exists in the tree (the tree models
 * the alternatives as items below it), spelled from a variant's path; without a tree the literal decides, unchecked.
 * Null when the tree lacks the command.
 */
function anchorPathOf(anchor: Anchor, catalog: CommandCatalog | null, options: Pick<ManualOptions, 'noTree'> = {}): string | null {
  // A direct call without a tree places by the literal, unchecked (the README says so); a production with an
  // unusable tree passes noTree, which keeps every signature at its section node (no synthetic /commands path).
  if (catalog === null) return options.noTree === true ? null : commandPath(anchor.words);
  const direct = existingPath(catalog, anchor.words);
  if (direct !== null) return direct;
  if (anchor.variants === null) return null;
  const key = anchor.words.map((word) => word.toLowerCase());
  // Only the variants that EXTEND the key decide existence: the alternatives a leading optional group adds
  // ([no] …) are not words of the tree.
  const extending = anchor.variants.filter((variant) => variant.length >= key.length && variant.slice(0, key.length).every((word, k) => word.toLowerCase() === key[k]));
  if (extending.length === 0) return null;
  const variantPaths = extending.map((variant) => existingPath(catalog, variant));
  if (variantPaths.some((path) => path === null)) return null;
  const at = 0;
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

// Explicit condition extraction is local to each source block. The scope pass below applies verified chapter-opening
// declarations per field, after row and signature placement. Builds still come from roots and compositions.
type Conditions = NonNullable<ProducedEntry['applicability']>;
type ClosedSets = {components:ReadonlySet<string>;licenses:ReadonlySet<string>;deployment_forms:ReadonlySet<string>};
function closedVocabulary(options:ManualOptions):ClosedSets {
  const read=(value:unknown):ReadonlySet<string>=>{
    if(value===undefined)return new Set<string>();
    if(!Array.isArray(value)||value.some(word=>typeof word!=='string'||word.trim()===''))throw new TypeError('适用条件闭集须为非空词的字符串列表；请管理员核对产品变量后重新同步');
    return new Set(value);
  };
  return {components:read(options.components),licenses:read(options.licenses),deployment_forms:read(options.deployment_forms)};
}
const SERIES_SEPARATOR = /\s*(?:以及|或者|、|,|，|\/|和|与|及|或|并)\s*/u;
function closedSeries(text:string,words:ReadonlySet<string>):string[]|null {
  const clean=text.trim();
  if(words.has(clean))return [clean];
  const items=clean.split(SERIES_SEPARATOR).map(item=>item.replace(/^(?:\*\*|__|`)([\s\S]*?)(?:\*\*|__|`)$/u,'$1').trim());
  return items.length&&items.every(item=>item!==''&&words.has(item))?[...new Set(items)].sort(compareText):null;
}
/** Read only closed names and explicit positive restrictions; never keep a recognized prefix of a failed list. */
function closedConditions(text:string,vocabulary:ClosedSets):Conditions {
  if(!vocabulary.components.size&&!vocabulary.licenses.size&&!vocabulary.deployment_forms.size)return {};
  const withWords=new Set<string>(),withoutWords=new Set<string>(),licenses=new Set<string>(),forms=new Set<string>();
  const unread={components:false,licenses:false,deployment_forms:false};
  const out:Conditions={};
  for(const clause of text.split(/[。；：\n]/u)){
    const bad=[...clause.matchAll(/不|未|无|非|没|勿|除|之外|以外|其余|其他|等等?|可能|通常|一般|某些|部分|大概|也|还|亦/gu)].filter(match=>!clause.startsWith('不少于',match.index)&&!clause.startsWith('不超过',match.index)).map(match=>match.index);
    const outside=(start:number,end:number)=>bad.some(at=>at<start||at>=end);
    const explicit=(pattern:RegExp,field:keyof ClosedSets,absent=false)=>{
      for(const match of clause.matchAll(pattern)){
        const start=match.index,end=start+match[0].length;
        const values=closedSeries(match[1]!,vocabulary[field])??(field==='components'?closedSeries(match[1]!.replace(/\s*部件$/u,''),vocabulary[field]):null);
        const tail=clause.slice(end);
        const continued=/^\s*(?:、|以及|或者|和|与|及|或|并|\/)/u.test(tail)||(/^\s*[，,]/u.test(tail)&&/(?:部件|许可|部署形态|部署方式)/u.test(tail));
        if(outside(start,end)||!values||continued){unread[field]=true;continue;}
        const found=field==='components'?(absent?withoutWords:withWords):field==='licenses'?licenses:forms;
        for(const value of values)found.add(value);
      }
    };
    explicit(/装有\s*([^。；：\n]{1,200}?)\s*时/gu,'components');
    explicit(/没有\s*([^。；：\n]{1,200}?)\s*时/gu,'components',true);
    explicit(/需要\s*([^。；：\n]{1,200}?)\s*许可/gu,'licenses');
    for(const pattern of [/适用于\s*([^。；：\n]{1,200})/gu,/(?:仅|只)\s*([^。；：\n]{1,200}?)\s*支持/gu])for(const match of clause.matchAll(pattern)){
      let candidate=match[1]!.trim(),end=match.index+match[0].length;
      const when=candidate.indexOf('时');
      if(when>=0){end=match.index+match[0].indexOf(match[1]!)+match[1]!.indexOf('时')+1;candidate=candidate.slice(0,when).trim();}
      else if(end<clause.length)continue;
      if(outside(match.index,end))continue;
      const candidates=[
        {field:'components' as const,words:vocabulary.components,values:withWords,noun:/\s*部件$/u},
        {field:'licenses' as const,words:vocabulary.licenses,values:licenses,noun:/\s*许可$/u},
        {field:'deployment_forms' as const,words:vocabulary.deployment_forms,values:forms,noun:/\s*(?:部署形态|部署方式|部署)$/u},
      ];
      const reads=candidates.flatMap(row=>{const values=closedSeries(candidate,row.words)??closedSeries(candidate.replace(row.noun,''),row.words);return values?[{...row,read:values}]:[];});
      if(reads.length!==1)continue;
      const row=reads[0]!;for(const value of row.read)row.values.add(value);
    }
  }
  if(!unread.components&&(withWords.size||withoutWords.size))out.components={...(withWords.size?{with:[...withWords].sort(compareText)}:{}),...(withoutWords.size?{without:[...withoutWords].sort(compareText)}:{})};
  if(!unread.licenses&&licenses.size)out.licenses=[...licenses].sort(compareText);
  if(!unread.deployment_forms&&forms.size)out.deployment_forms=[...forms].sort(compareText);
  return out;
}


/** Binary memory units; accept only exact integer byte counts representable by JSON numbers. */
function memoryBytes(number:string,unit:string):number|null {
  const [whole,fraction='']=number.split('.');
  const denominator=10n**BigInt(fraction.length);
  const numerator=BigInt(whole+fraction)*(unit==='GB'||unit==='G'?1024n**3n:1024n**2n);
  if(numerator%denominator!==0n)return null;
  const bytes=numerator/denominator;
  return bytes<=BigInt(Number.MAX_SAFE_INTEGER)?Number(bytes):null;
}
function memoryCondition(text:string,vocabulary:ClosedSets):Conditions['memory'] {
  if(!text.includes('内存'))return undefined;
  const dimension='(?<mark>\\*\\*|__)?(?<number>[0-9]{1,18}(?:\\.[0-9]{1,18})?)\\s*(?<unit>GB|G|MB|M)\\k<mark>(?![A-Za-z0-9_.])';
  const patterns=[
    new RegExp('内存\\s*(?<relation>不少于|至少|大于|小于|不超过)\\s*'+dimension,'gu'),
    new RegExp('(?<relation>不少于|至少|大于|小于|不超过)\\s*'+dimension+'\\s*(?:的)?内存(?:的设备)?','gu'),
    new RegExp('内存\\s*(?:为\\s*)?'+dimension+'\\s*(?<relation>以上|以下)','gu'),
    new RegExp('(?<![A-Za-z0-9_.+\\-])'+dimension+'\\s*(?<relation>以上|以下)\\s*(?:的)?内存(?:的设备)?','gu'),
    new RegExp('(?<![A-Za-z0-9_.+\\-])'+dimension+'\\s*内存的设备','gu'),
  ];
  const results:NonNullable<Conditions['memory']>[]=[];let unread=false;
  for(const clause of text.split(/[。；：]/u)){
    type Found={start:number;end:number;minimum?:{bytes:number;inclusive:boolean};maximum?:{bytes:number;inclusive:boolean}};
    const found:Found[]=[];
    for(const pattern of patterns)for(const match of clause.matchAll(pattern)){
      const start=match.index,end=start+match[0].length;
      if(found.some(previous=>start<previous.end&&end>previous.start))continue;
      const bytes=memoryBytes(match.groups!.number!,match.groups!.unit!);
      if(bytes===null){unread=true;continue;}
      const relation=match.groups?.relation;
      const lower=relation===undefined||relation==='不少于'||relation==='至少'||relation==='大于'||relation==='以上';
      const upper=relation===undefined||relation==='小于'||relation==='不超过'||relation==='以下';
      const inclusive=relation!=='大于'&&relation!=='小于';
      found.push({start,end,...(lower?{minimum:{bytes,inclusive}}:{}),...(upper?{maximum:{bytes,inclusive}}:{})});
    }
    if(!found.length)continue;
    found.sort((a,b)=>a.start-b.start);
    const otherScopes=[...clause.matchAll(/(?:装有|没有)\s*([^。；：\n]{1,200}?)\s*时/gu)].filter(match=>closedSeries(match[1]!,vocabulary.components)!==null||closedSeries(match[1]!.replace(/\s*部件$/u,''),vocabulary.components)!==null).map(match=>({start:match.index,end:match.index+match[0].length}));
    const outside=[...clause.matchAll(/不|未|无|非|没|除|之外|以外|等等?|可能|约|通常|一般|左右|较|或/gu)].some(match=>![...found,...otherScopes].some(span=>match.index>=span.start&&match.index<span.end));
    if(outside){unread=true;continue;}
    let minimum:Found['minimum'],maximum:Found['maximum'];let conflict=false;
    for(const match of found){
      if(match.minimum){if(minimum&&JSON.stringify(minimum)!==JSON.stringify(match.minimum))conflict=true;minimum=match.minimum;}
      if(match.maximum){if(maximum&&JSON.stringify(maximum)!==JSON.stringify(match.maximum))conflict=true;maximum=match.maximum;}
    }
    if(conflict){unread=true;continue;}
    results.push({...(minimum?{minimum}:{}),...(maximum?{maximum}:{}),raw:clause.slice(found[0]!.start,found.at(-1)!.end)});
  }
  if(unread||!results.length)return undefined;
  const bounds=(value:NonNullable<Conditions['memory']>)=>JSON.stringify({minimum:value.minimum,maximum:value.maximum});
  return results.every(value=>bounds(value)===bounds(results[0]!))?results[0]:undefined;
}

/** Platform values a manual may name: the pack's platform tokens (hyphen-joined) plus the Han words 虚拟/物理. */
const PLATFORM_WORDS: ReadonlySet<string> = new Set([...PAGE_PLATFORMS.map((sequence) => sequence.join('-')), '虚拟', '物理']);
/** The product's own names are never models (APV and NSAE name one product). */
const PRODUCT_NAMES_LOWER: ReadonlySet<string> = new Set(PRODUCT_LINE.names.map((name) => name.toLowerCase()));

/** A model value is a listed ASCII model atom (research 3 rec 1; the 7f046dde rewrite lost this shape). */
const MODEL_ATOM = /^[A-Za-z0-9][A-Za-z0-9-]{0,31}$/;

/** Escapes a literal for use inside a RegExp. */
const escapeRe = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** List connectives between items (a coordinated list counts only when every item is readable). */
const CONNECTIVES = ['、', ',', '，', '/', '和', '与', '及', '以及', '或者', '或', '并'];
/** A list followed by 等 never counts (the source says it is partial), and an exception list (以外/之外) inverts. */
const ETC = /等等?|以外|之外|除外|其余|其他/;
/** Any of these in the clause before the trigger makes the whole match unread (a negation over the condition). */
const CLAUSE_NEGATION = /[不未无非没勿]/;
/** A widening word anywhere in the clause before the trigger (也可/亦可/同样可以/还可以/也能…适用于) widens instead of restricting: unread (closure 6). */
const ALSO_BEFORE = /(?:也|亦|同样|还)(?:可以?|能)?|该命令也能/;
/** The applicability triggers: what follows one, up to the clause's end, is the candidate series. */
const TRIGGERS = [/适用于/gu];

/** The clause boundaries: a candidate series runs to the next of these, and negations are looked for back to one. */
const CLAUSE_END = /[。；：\n]/;
/** The end of a sub-clause: a comma starts a new remark, so a series' own checks stop here (c3 item 4). */
const SUB_CLAUSE_END = /[，,]/;

/**
 * The conditions one text declares, per field — read linearly, never by a backtracking series regex. For every
 * trigger: the clause before it may not carry a negation or a widening word; the tokens after it, split on the
 * connectives and the field's noun, must all be readable; a trailing 等 (a partial listing) or another connective
 * after the series makes it unread; one unreadable token makes the whole series unread, never a narrowed one.
 */
function conditionsOf(text: string, vocabulary: ClosedSets): Conditions {
  const found: { platforms: Set<string>; models: Set<string> } = { platforms: new Set(), models: new Set() };
  // One clause split for the whole text (bounded: every clause is scanned once, every candidate's series window is
  // capped, so hostile paragraphs stay linear — closure findings 7 and 15).
  const CLAUSE_BOUND = 200;
  const clauses: Array<{ start: number; end: number }> = [];
  {
    let start = 0;
    for (let k = 0; k < text.length; k += 1) {
      if (CLAUSE_END.test(text[k] ?? '')) {
        clauses.push({ start, end: k });
        start = k + 1;
      }
    }
    clauses.push({ start, end: text.length });
  }
  for (const clause of clauses) {
    const slice = text.slice(clause.start, clause.end);
    // Every trigger position in this clause (适用于, and 仅/只 whose clause holds 支持 right after a noun).
    const positions: number[] = [];
    const tight: number[] = [];
    const loose: number[] = [];
    let from = 0;
    for (;;) {
      const at = slice.indexOf('适用于', from);
      if (at < 0) break;
      positions.push(at + 3);
      from = at + 3;
    }
    from = 0;
    for (;;) {
      const rest = slice.slice(from);
      const at = new RegExp('(?:仅|只)(\\s*)').exec(rest);
      if (at === null) break;
      const tightOnly = from === 0 && at.index === 0;
      const itemsAt = from + at.index + at[0].length;
      (tightOnly ? tight : loose).push(itemsAt);
      from = itemsAt;
      if (from >= slice.length) break;
    }
    positions.push(...loose, ...tight);
    for (const itemsAt of positions) {
      // Negations and widening words count only within the trigger's OWN sub-clause (back to the previous comma
      // or the clause start): a remark like 无需重启， or 不同…， before it does not suppress the condition (c3 item 4).
      let windowStart = Math.max(0, itemsAt - 64);
      for (let k = itemsAt - 1; k >= windowStart; k -= 1) {
        if (SUB_CLAUSE_END.test(slice[k] ?? '')) { windowStart = k + 1; break; }
      }
      const before = slice.slice(windowStart, itemsAt);
      if (CLAUSE_NEGATION.test(before) || ALSO_BEFORE.test(before)) continue;
      // Every 仅/只 candidate is a restriction ONLY in the documented form — the series noun itself followed by
      // 支持 ('仅 hg-k 平台支持', c3 item 2): a mid-clause 仅 about one platform's difference is not one.
      const isOnlyCandidate = tight.includes(itemsAt) || loose.includes(itemsAt);
      if (isOnlyCandidate && !/(?:平台|系列|机型|型号)\s*支持/u.test(slice)) continue;
      // The candidate series: at most CLAUSE_BOUND characters from the trigger.
      const candidate = slice.slice(itemsAt, Math.min(slice.length, itemsAt + CLAUSE_BOUND)).trim();
      const read = readSeries(candidate);
      if (read === null) continue;
      for (const token of read.platforms) found.platforms.add(token);
      for (const token of read.models) found.models.add(token);
    }
  }
  const out: Conditions = {};
  if (found.platforms.size > 0) out.platforms = [...found.platforms].sort(compareText);
  if (found.models.size > 0) out.models = [...found.models].sort(compareText);
  const memory=memoryCondition(text,vocabulary);
  return {...out,...closedConditions(text,vocabulary),...(memory?{memory}:{})};
}

/** One series candidate: the items up to and through the field noun, tokens by field, or null when unread. */

function readSeries(candidate: string): { platforms: string[]; models: string[] } | null {
  const NOUN_RE = /(平台|系列|机型|型号)(\s*支持)?/u;
  let rest = candidate;
  const tokensByField: { platforms: string[]; models: string[] } = { platforms: [], models: [] };
  const tokensOk = (): boolean => tokensByField.platforms.length + tokensByField.models.length > 0;
  let field: 'platforms' | 'models' | null = null;
  let nounAteSupport = false;
  let afterConnective = false;
  const itemSplit = new RegExp(`\\s*(?:${CONNECTIVES.map(escapeRe).join('|')})\\s*`, 'u');
  let guard = 0;
  for (;;) {
    if (guard++ > 64) return null;
    const head = NOUN_RE.exec(rest);
    if (head === null) {
      const left = rest;
      if (left.trim() === '') break;
      const continued = new RegExp(`^\\s*(?:${CONNECTIVES.map(escapeRe).join('|')})`, 'u').exec(left);
      if (continued !== null) {
        const afterConnective = left.slice(continued[0].length);
        if (NOUN_RE.exec(afterConnective) === null) {
          // A connective before a start-build tail (，自 X 起…) ends the series quietly; a connective before any
          // other non-item (或其他平台) makes it unread.
          if (/^自\s*\S+\s*起/.test(afterConnective.trim())) break;
          return null;
        }
        rest = afterConnective;
        continue;
      }
      // The quiet tail: a start-build tail (自 <版本> 起…), a possessive tail (starts with 的, only when the noun
      // ate its own 支持), or plain Han prose with no field noun, connective, ETC word or negation in its own
      // sub-clause (平台环境, 系列设备 — c3 item 4). An unfinished item after a connective is none of these.
      const startTailHere = /^自\s*\S+\s*起/.test(left.trim());
      const tailSub = (() => { const at = SUB_CLAUSE_END.exec(left); return at === null ? left : left.slice(0, at.index); })();
      // Plain Han prose ends the series ONLY when no connective asked for another item (物理设备 after 和 is an
      // unfinished item: the series stays unread — closure 14).
      const quietHan = !afterConnective && tailSub.trim() !== '' && !/(?:平台|系列|机型|型号)/u.test(tailSub) && !CONNECTIVES.some((word) => tailSub.includes(word)) && !ETC.test(tailSub) && !CLAUSE_NEGATION.test(tailSub);
      if (left.trim() !== '' && !startTailHere && !(quietHan && tokensOk()) && !(/^的/u.test(left.trim()) && nounAteSupport)) return null;
      break;
    }
    if (head.index > CLAUSE_WINDOW) return null;
    const itemPart = rest.slice(0, head.index);
    const nounWord = head[1]!;
    const nextField: 'platforms' | 'models' = nounWord === '平台' ? 'platforms' : 'models';
    if (field === null) field = nextField;
    else if (field !== nextField) return null;
    const pieceTokens = itemPart.split(itemSplit).map((token) => squeeze(token)).filter((token) => token !== '' && token !== nounWord);
    if (itemPart.trim() !== '' && pieceTokens.length === 0) return null;
    if (field === 'platforms' && !pieceTokens.every((token) => PLATFORM_WORDS.has(token.toLowerCase()))) return null;
    if (field !== 'platforms' && !pieceTokens.every((token) => MODEL_ATOM.test(token) && !PRODUCT_NAMES_LOWER.has(token.toLowerCase()))) return null;
    tokensByField[field].push(...pieceTokens);
    nounAteSupport = head[2] !== undefined;
    afterConnective = false;
    rest = rest.slice(head.index + head[0].length);
    if (rest.trim() === '') break;
    // Forward checks stop at the sub-clause end: a remark after a comma is not part of the series (c3 item 4).
    const subEnd = (() => { const at = SUB_CLAUSE_END.exec(rest); return at === null ? rest.length : at.index; })();
    const own = rest.slice(0, subEnd);
    if (ETC.test(own) || CLAUSE_NEGATION.test(own) || /^\s*(?:外|除外)/u.test(own)) return null;
    const connective = new RegExp(`^\s*(?:${CONNECTIVES.map(escapeRe).join('|')})\s*`, 'u').exec(rest);
    if (connective !== null) {
      const next = rest.slice(connective[0].length);
      const afterSub = (() => { const at = SUB_CLAUSE_END.exec(next); return at === null ? next : next.slice(0, at.index); })();
      // A comma connective before a remark (，用于配置成员) ends the series quietly: the remark is not a list item.
      if (SUB_CLAUSE_END.test(connective[0]) && !/(?:平台|系列|机型|型号)/u.test(afterSub)) break;
      afterConnective = true;
      rest = next;
      continue;
    }
    if (NOUN_RE.test(rest.trim())) continue;
    // A leftover is quiet when it is a start-build tail (自 <版本> 起…), a possessive tail (starts with 的, only
    // when the noun ate its own 支持 — c3 item 2), or plain Han prose with no field noun, connective, ETC word or
    // negation in its own sub-clause (平台环境, 系列设备 — c3 item 4). Anything else keeps the series unread.
    const startTail = /^自\s*\S+\s*起/.test(rest.trim());
    const restSub = rest.slice(0, (() => { const at = SUB_CLAUSE_END.exec(rest); return at === null ? rest.length : at.index; })());
    const quietHan = restSub.trim() !== '' && !/(?:平台|系列|机型|型号)/u.test(restSub) && !CONNECTIVES.some((word) => restSub.includes(word)) && !ETC.test(restSub) && !CLAUSE_NEGATION.test(restSub);
    if (rest.trim() !== '' && !startTail && !quietHan && !(/^的/u.test(rest.trim()) && nounAteSupport)) return null;
    break;
  }
  if (field === null) return null;
  const tokens = tokensByField[field].filter((token, k, all) => all.indexOf(token) === k);
  if (tokens.length === 0) return null;
  return field === 'platforms' ? { platforms: tokens, models: [] } : { platforms: [], models: tokens };
}

const CLAUSE_WINDOW = 200;

/** The applicability of an entry, or null (未声明) when nothing declares a condition. */
function toApplicability(conditions: Conditions): ProducedEntry['applicability'] {
  return Object.keys(conditions).length===0 ? null : conditions;
}

function fromMarkdown(model: MarkdownModel, heads: ReadonlySet<string> | null, options: ManualOptions, warnings: string[]): ManualResult {
  const entries: ProducedEntry[] = [];
  const vocabulary=closedVocabulary(options);
  const entryContexts=new Map<ProducedEntry,{section:number;text:string;heading?:boolean}>();
  const name = typeof options.name === 'string' && options.name !== '' ? options.name : DEFAULT_MANUAL_NAME;
  const catalog = options.catalog ?? null;
  const sections: Section[] = asArray(model.sections).map((value) => {
    if (!isRecord(value)) return { title: '', parent: null, selector: null, path: null };
    const parent = Number.isInteger(value.parent) ? (value.parent as number) : null;
    // A model whose sections are not cited by h/ selectors (an adoc model with text@1 l/<a>-<b> ranges) can carry
    // its own decoded path array; the h/ decoding stays the markdown@1 fallback (c3 item 7, K4).
    const path = Array.isArray(value.path) && value.path.every((part) => typeof part === 'string') ? (value.path as string[]) : null;
    return { title: asString(value.title) ?? '', parent, selector: asString(value.selector), path };
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
    const own = sections[index]?.path;
    if (own !== null && own !== undefined) return own;
    const selector = sections[index]?.selector;
    if (typeof selector !== 'string' || !selector.startsWith('h/')) return null;
    try {
      return selector.slice(2).split('/').map((part) => decodeURIComponent(part));
    } catch {
      return null;
    }
  };
  // Conditions are source scopes. Provenance is attached to fragments, never to entry content.
  type Field=typeof APPLICABILITY_FIELD[number];
  type OriginMeta=NonNullable<FragmentRef['applicability']>[number];
  type Origin={fragment:FragmentRef;meta:OriginMeta};
  type Scope={declaration:Conditions|null;origins:Origin[];conflict:boolean};
  const report:NonNullable<ManualResult['applicability_report']>={counts:Object.fromEntries(APPLICABILITY_FIELD.map(field=>[field,{direct:0,inherited:0}])) as NonNullable<ManualResult['applicability_report']>['counts'],overrides:[],conflicts:[]};
  const firstBlocks=new Map<number,{raw:Record<string,unknown>;position:number}>();
  asArray(model.blocks).forEach((raw,position)=>{if(isRecord(raw)&&Number.isInteger(raw.section)&&!firstBlocks.has(raw.section as number))firstBlocks.set(raw.section as number,{raw,position});});
  const firstDescendant=new Map<number,number>();
  for(const [owner,first] of firstBlocks){const visited=new Set<number>();for(let parent=sections[owner]?.parent;parent!==null&&parent!==undefined&&!visited.has(parent);parent=sections[parent]?.parent){visited.add(parent);firstDescendant.set(parent,Math.min(firstDescendant.get(parent)??Infinity,first.position));}}
  const openingParagraphs=new Map<number,Record<string,unknown>>();
  for(const [index,first] of firstBlocks){
    if(index<=0||first.raw.kind!=='paragraph'||typeof first.raw.text!=='string'||typeof first.raw.selector!=='string')continue;
    if((firstDescendant.get(index)??Infinity)<first.position)continue;
    const rawSection=asArray(model.sections)[index];
    if(isRecord(rawSection)&&rawSection.cite===undefined&&typeof first.raw.line==='number'){
      const childBefore=asArray(model.sections).some(child=>isRecord(child)&&child.parent===index&&typeof child.line==='number'&&child.line<=(first.raw.line as number));
      if(childBefore)continue;
    }
    openingParagraphs.set(index,first.raw);
  }
  const sectionOrigin=(index:number):string[]=>[...(sectionSegments(index)??titleChains[index]??[])];
  const headingFragment=(index:number):FragmentRef|null=>{
    const raw=asArray(model.sections)[index];
    if(!isRecord(raw))return null;
    if(options.sectionSelector!==undefined)return {parser:parserOf(options),selector:options.sectionSelector(sectionOrigin(index))};
    // Mapped formats own their citation rewrite. Markdown can cite just the physical heading line.
    if(raw.cite===null)return null;
    if(raw.cite===undefined&&Number.isInteger(raw.line)&&Number(raw.line)>=0)return {parser:'text@1',selector:'l/'+(Number(raw.line)+1)};
    return sections[index]?.selector?{parser:parserOf(options),selector:sections[index]!.selector!}:null;
  };
  const declaration=(value:Conditions,field:Field):Conditions=>value[field]===undefined?{}:{[field]:structuredClone(value[field])} as Conditions;
  const equal=(left:Conditions|null,right:Conditions|null,field:Field):boolean=>{
    const value=(app:Conditions|null)=>field==='memory'&&app?.memory?{minimum:app.memory.minimum,maximum:app.memory.maximum}:app?.[field];
    return JSON.stringify(value(left))===JSON.stringify(value(right));
  };
  const topics=(text:string,own:Conditions):Set<Field>=>{
    const found=new Set<Field>(APPLICABILITY_FIELD.filter(field=>own[field]!==undefined));
    const hasMember=(candidate:string,words:ReadonlySet<string>,noun:RegExp)=>candidate.split(SERIES_SEPARATOR).some(part=>words.has(part.trim().replace(/^(?:\*\*|__|`)([\s\S]*?)(?:\*\*|__|`)$/u,'$1').replace(noun,'').trim()));
    if(vocabulary.components.size)for(const match of text.matchAll(/(?:装有|没有)\s*([^。；\n]{1,200}?)\s*时/gu)){
      if(hasMember(match[1]!,vocabulary.components,/\s*(?:部件|单板|模块|卡)$/u)||/(?:部件|单板|模块|卡$)/u.test(match[1]!))found.add('components');
    }
    if(vocabulary.licenses.size&&/需要[^。；\n]{1,200}许可/u.test(text))found.add('licenses');
    if(/(?:适用于|仅|只)[^。；\n]{0,200}平台/u.test(text))found.add('platforms');
    if(/(?:适用于|仅|只)[^。；\n]{0,200}(?:型号|机型|系列)/u.test(text))found.add('models');
    if(vocabulary.deployment_forms.size&&/(?:适用于|仅|只)[^。；\n]{0,200}部署(?:形态|方式)?/u.test(text))found.add('deployment_forms');
    if(/内存\s*(?:不少于|至少|大于|小于|不超过|[0-9]|较大|较小)|[0-9]\s*(?:GB|G|MB|M)\s*内存/u.test(text))found.add('memory');
    // A mixed closed series still identifies its field when at least one member is known; do not inherit a narrower parent.
    for(const match of text.matchAll(/(?:适用于|仅|只)\s*([^。；：\n]{1,200})/gu)){
      const parts=match[1]!.split(SERIES_SEPARATOR).map(value=>value.trim());
      if(parts.some(value=>vocabulary.components.has(value)))found.add('components');
      if(parts.some(value=>vocabulary.licenses.has(value)))found.add('licenses');
      if(parts.some(value=>vocabulary.deployment_forms.has(value)))found.add('deployment_forms');
    }
    return found;
  };
  const locals=new Map<number,Map<Field,Scope>>();
  for(let index=1;index<sections.length;index++){
    const heading=conditionsOf(sections[index]!.title,vocabulary),paragraph=openingParagraphs.get(index);
    const body=paragraph?conditionsOf(paragraph.text as string,vocabulary):{};
    const headerTopics=topics(sections[index]!.title,heading),bodyTopics=paragraph?topics(paragraph.text as string,body):new Set<Field>();
    const local=new Map<Field,Scope>();
    for(const field of APPLICABILITY_FIELD){
      if(!headerTopics.has(field)&&!bodyTopics.has(field))continue;
      const origins:Origin[]=[];
      const h=headerTopics.has(field),b=bodyTopics.has(field);
      const add=(app:Conditions,fragment:FragmentRef|null)=>{
        if(fragment)origins.push({fragment,meta:{field,section:sectionOrigin(index),declaration:declaration(app,field)}});
        else warnings.push('章节开头条件缺可核对片段：'+sectionOrigin(index).join('/')+'；下一步修复源定位后重新生产');
      };
      if(h)add(heading,headingFragment(index));
      if(b)add(body,{parser:parserOf(options),selector:paragraph!.selector as string});
      const conflict=h&&b&&heading[field]!==undefined&&body[field]!==undefined&&!equal(heading,body,field);
      const unread=(h&&heading[field]===undefined)||(b&&body[field]===undefined)||origins.length!==Number(h)+Number(b);
      if(conflict){for(const origin of origins)origin.meta={...origin.meta,conflict:true};report.conflicts.push({field,section:sectionOrigin(index),values:origins.map(origin=>origin.meta.declaration),fragments:origins.map(origin=>origin.fragment)});}
      local.set(field,{declaration:conflict||unread?null:declaration(b?body:heading,field),origins,conflict});
    }
    locals.set(index,local);
  }
  const scopes=new Map<number,Map<Field,Scope>>([[0,new Map()]]);
  const scopeOf=(index:number):Map<Field,Scope>=>{
    const chain:number[]=[],seen=new Set<number>();let at=index;
    while(at>0&&at<sections.length&&!scopes.has(at)){
      if(seen.has(at)){for(const item of chain)scopes.set(item,new Map());warnings.push('章节层级成环，未继承条件；下一步修复源层级后重新生产');return scopes.get(index)??new Map();}
      seen.add(at);chain.push(at);at=sections[at]!.parent??0;
    }
    let parent=scopes.get(at)??new Map<Field,Scope>();
    for(const item of chain.reverse()){
      const current=new Map(parent);
      for(const [field,local] of locals.get(item)??[]){
        const outer=parent.get(field);
        if(outer&&(!equal(outer.declaration,local.declaration,field)||outer.conflict!==local.conflict))report.overrides.push({field,section:sectionOrigin(item),values:[...outer.origins,...local.origins].map(origin=>origin.meta.declaration),fragments:[...outer.origins,...local.origins].map(origin=>origin.fragment)});
        current.set(field,outer?{...local,origins:[...local.origins,...outer.origins.map(origin=>({...origin,meta:{...origin.meta,superseded:true}}))]}:local);
      }
      scopes.set(item,current);parent=current;
    }
    return scopes.get(index)??new Map();
  };
  for(let index=1;index<sections.length;index++)scopeOf(index);
  const sameFragment=(a:FragmentRef,b:FragmentRef)=>a.parser===b.parser&&a.selector===b.selector&&JSON.stringify(a.range)===JSON.stringify(b.range);
  const attach=(entry:ProducedEntry,origin:Origin)=>{
    let fragment=entry.fragments.find(candidate=>sameFragment(candidate,origin.fragment));
    if(!fragment){fragment={...origin.fragment};entry.fragments.push(fragment);}
    fragment.applicability??=[];
    if(!fragment.applicability.some(existing=>canonicalJson(existing)===canonicalJson(origin.meta)))fragment.applicability.push(structuredClone(origin.meta));
  };
  const applyScopes=()=>{
    for(const entry of entries){
      const context=entryContexts.get(entry);if(!context)continue;
      const own=entry.applicability??{},ownTopics=topics(context.text,own),effective:Conditions={...own};
      const inherited:Field[]=[];const opening=context.heading||openingParagraphs.get(context.section)?.selector===entry.fragments[0]?.selector;
      for(const field of APPLICABILITY_FIELD){
        const scope=scopeOf(context.section).get(field);
        if(opening&&locals.get(context.section)?.get(field)?.declaration===null){delete (effective as Record<string,unknown>)[field];for(const origin of scope?.origins??[])attach(entry,origin);continue;}
        if(ownTopics.has(field)){
          if(own[field]===undefined){delete (effective as Record<string,unknown>)[field];}
          if(opening&&scope?.origins.some(origin=>origin.meta.superseded))for(const origin of scope.origins)attach(entry,origin);
          continue;
        }
        if(!scope)continue;
        for(const origin of scope.origins)attach(entry,origin);
        if(scope.declaration?.[field]!==undefined){(effective as Record<string,unknown>)[field]=structuredClone(scope.declaration[field]);inherited.push(field);}
      }
      if(inherited.length)effective.inherited=inherited;
      entry.applicability=toApplicability(effective);
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
  /** Adds a prose mention without silently truncating the literal collection. */
  const putLiteral = (entry: ProducedEntry, literal: string): void => {
    if (literal === '') return;
    const literals = asStrings(entry.data.command_literals);
    if (!literals.includes(literal)) entry.data.command_literals = [...literals, literal].sort(compareText);
  };
  const putLiterals = (entry: ProducedEntry, kind: string, text: string): void => {
    const found = kind === 'code_block' ? codeLiterals(text) : kind === 'html_block' ? [] : proseLiterals(text);
    const unique = [...new Set(found)].sort(compareText);
    if (unique.length === 0) return;
    entry.data.command_literals = unique;
  };
  /**
   * A behaviour entry. `data` is placement-independent and heading-independent (K01 R[1], K02 F[1]): only `form` and
   * `words` (whenever the block follows an anchor); the section chain is provenance and lives in the fragment
   * selectors and the section-node paths, never in the digest. Explicit conditions come from this entry; the scope pass adds chapter-opening conditions per field.
   */
  const textEntry = (init: { path: string; statement: string; block: string; section: number; words?: string[]; fragments: FragmentRef[]; noLiterals?: boolean }): ProducedEntry => {
    // Data stays identical across placements (K01 R[1]) and across heading edits (K02 F[1], R[4]): the section
    // chain is provenance and lives in the fragment selectors and the section-node paths, never in the digest.
    const data: { [key: string]: unknown } = { form: 'text' };
    if (init.words !== undefined) data.words = init.words;
    // A multi-line table statement (an unsplit table block, or the shared remainder rows) declares a condition only
    // when EVERY data row of it states it (closure finding 8): a header condition or one row's condition never
    // declares the others. Non-table statements read their own text as before.
    const isTableText = init.block === 'table' && init.statement.includes('\n');
    const applicability = isTableText
      ? tableEveryRow(init.statement,vocabulary)
      : toApplicability(conditionsOf(init.statement,vocabulary));
    const entry: ProducedEntry = { kind: TEXT, path: init.path, statement: init.statement, data, fragments: init.fragments, applicability };
    // A multi-command row's own anchors are recorded as signature literals by the caller: its prose must not add them
    // back as unresolved spans.
    if (init.noLiterals !== true) putLiterals(entry, init.block, init.statement);
    entryContexts.set(entry,{section:init.section,text:init.statement});
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
    const placed = anchorPathOf(anchor, catalog, options) ?? sectionEntryPath(index);
    headingAnchors.set(index, { anchor, path: placed });
    const sectionCite = options.sectionSelector === undefined ? (section.selector as string) : options.sectionSelector(sectionSegments(index) ?? []);
    const entry = signatureEntry(anchor, placed, { parser: parserOf(options), selector: sectionCite });
    entry.applicability = toApplicability(conditionsOf(section.title,vocabulary));
    entryContexts.set(entry,{section:index,text:section.title,heading:true});
    entries.push(entry);
  });

  /**
   * Whether an anchor parsed from a table cell is a row signature, decided from the manual alone (K02 R[3]): a
   * definition comes only from a signature, and a bare single bold word is a value, a parameter name or a term, not a
   * command. A cell counts when its head has two or more words, or carries parameter or group syntax; a header that
   * names commands (命令/Command) keeps even one-word rows as signatures.
   */
  const isRowSignature = (anchor: Anchor, headerNamesCommands: boolean): boolean =>
    // In a command column every anchor shape counts (closure 19: 命令/command/commands as a word of the header cell).
    // In every other column only a cell with parameter or group syntax is a signature (K02 R[3]): a bare bold run,
    // one word or many, is a value, a parameter name or a term (round robin, enable, rr, VIP).
    headerNamesCommands || anchor.params.length > 0 || anchor.variants !== null;

  /** A bold cell is a value of the CURRENT command (closure finding 2): its words extend the current command's
   * words by exactly the command's parameter names, or the cell is one enumerated alternative of the current
   * signature's variant group. Such rows are value rows, kept in the remainder, never signatures. */
/** The variant-group alternatives of an anchor as tails after its key words (null when it has none). */
  const variantTailsOf = (anchor: Anchor): string[] | null => {
    if (anchor.variants === null) return null;
    const key = anchor.words.length;
    const tails = anchor.variants.map((variant) => variant.slice(key).join(' ').toLowerCase()).filter((tail) => tail !== '');
    return tails.length > 0 ? tails : null;
  };

  const valueOfCurrent = (cellAnchor: Anchor, currentWords: readonly string[] | null, variantTail: readonly string[] | null, currentParams: readonly { name: string }[] = []): boolean => {
    if (currentWords === null) return false;
    const lowered = currentWords.map((word) => word.toLowerCase());
    if (cellAnchor.params.length > 0 && cellAnchor.words.length === lowered.length + cellAnchor.params.length
      && cellAnchor.words.slice(0, lowered.length).every((word, k) => word.toLowerCase() === lowered[k])) {
      const tail = cellAnchor.words.slice(lowered.length).map((word) => word.toLowerCase());
      return tail.every((word) => cellAnchor.params.some((param) => param.name.toLowerCase() === word || param.name.toLowerCase().split(/[\s_-]+/u).includes(word)));
    }
    if (cellAnchor.params.length === 0 && variantTail !== null) {
      const text = cellAnchor.words.join(' ').toLowerCase();
      if (variantTail.some((option) => option === text)) return true;
    }
    // A cell whose HEAD equals one of the current signature's parameter names (with or without its value syntax,
    // weight / weight <1-100>), or one enumerated alternative of its variant group, is a value row (c3 item 5,
    // previous finding 2's asked rule).
    const headText = cellAnchor.words.map((word) => word.toLowerCase()).join(' ');
    if (headText !== '' && !lowered.includes(headText) && currentParams.some((param) => param.name.toLowerCase() === headText)) return true;
    if (variantTail !== null && headText !== '' && !lowered.includes(headText) && variantTail.some((option) => option === headText)) return true;
    return false;
  };

  /**
   * The signatures of one table cell: the whole cell is one signature, or a list of signatures joined by bare
   * connectives (与/和/及/或、顿号、逗号、斜线). A bold span inside prose is not a signature (a mention: it is recorded
   * in command_literals only).
   */
  /**
   * The bold runs of one cell with the PLAIN text between them. A bold run is a maximal `**…**` span; a between-run
   * is read only outside parameter syntax: emphasis `*…*`, group brackets {}, [], <> and their contents are skipped,
   * so a slash or comma inside a parameter never becomes a split point (closure findings 1 and 16).
   */
  const boldRuns = (cell: string): Array<{ bold: string; between: string; start: number; end: number; proseTail?: boolean }> => {
    const out: Array<{ bold: string; between: string; start: number; end: number; proseTail?: boolean }> = [];
    let at = 0;
    let between = '';
    let guard = 0;
    while (at < cell.length && guard++ < 10000) {
      const open = cell.indexOf('**', at);
      if (open < 0) break;
      const close = cell.indexOf('**', open + 2);
      if (close < 0) break;
      const nextOpen = cell.indexOf('**', close + 2);
      if (nextOpen < 0) {
        // The tail after the last bold close rides with the signature ONLY when it is signature syntax (emphasis
        // marks, escaped marks, parameter brackets with their contents, white space): plain words and notes after
        // the head make the whole cell prose (closure c3 item 1) — they are never re-wrapped in bold.
        const tail = cell.slice(close + 2);
        let tailScan = 0;
        let tailOk = true;
        while (tailScan < tail.length) {
          const ch = tail[tailScan]!;
          if (ch === '\\') { tailScan += tail[tailScan + 1] === '*' ? 2 : 1; continue; }
          if (ch === '{' || ch === '[' || ch === '<') {
            const closeCh = ch === '{' ? '}' : ch === '[' ? ']' : '>';
            const end = tail.indexOf(closeCh, tailScan + 1);
            if (end < 0) { tailOk = false; break; }
            tailScan = end + 1;
            continue;
          }
          if (ch === '*' || /\s/u.test(ch)) { tailScan += 1; continue; }
          tailOk = false;
          break;
        }
        if (!tailOk) {
          out.push({ bold: '', between, start: open, end: cell.length, proseTail: true });
        } else {
          out.push({ bold: cell.slice(open + 2, close) + cell.slice(close + 2), between, start: open, end: cell.length });
        }
        between = '';
        at = cell.length;
      } else {
        // Split the mid at its last signature syntax: the parameters ride with their run VERBATIM, the remaining
        // run is the separator (a connective, or prose — the caller decides), never part of this piece.
        const mid = cell.slice(close + 2, nextOpen);
        let midScan = 0;
        let syntaxEnd = 0;
        while (midScan < mid.length) {
          const ch = mid[midScan]!;
          if (ch === '\\') { midScan += mid[midScan + 1] === '*' ? 2 : 1; syntaxEnd = midScan; continue; }
          if (ch === '{' || ch === '[' || ch === '<') {
            const closeCh = ch === '{' ? '}' : ch === '[' ? ']' : '>';
            const end = mid.indexOf(closeCh, midScan + 1);
            if (end < 0) break;
            midScan = end + 1;
            syntaxEnd = midScan;
            continue;
          }
          if (ch === '*') { midScan += 1; syntaxEnd = midScan; continue; }
          if (/\s/u.test(ch)) { midScan += 1; continue; }
          break;
        }
        const syntax = mid.slice(0, syntaxEnd);
        out.push({ bold: cell.slice(open + 2, close) + syntax, between, start: open, end: close + 2 + syntaxEnd });
        between = mid.slice(syntaxEnd).trim();
        at = nextOpen;
      }
    }
    return out;
  };

  const cellAnchors = (cell: string, headerNamesCommands: boolean): Anchor[] => {
    if (!cell.includes('**')) return [];
    // The pieces of one cell: bold runs with the parameter syntax that rides with them, split ONLY at a plain
    // connective run (与/和/及/或、顿号、逗号；斜线只在命令列). A bold span that follows another with NO separator
    // rides with it (a bold keyword or parameter — README 151-153: an anchor may span several runs); a prose run
    // ends the list, the bold runs before it stay signatures and the rest of the cell is the row's prose.
    const runs = boldRuns(cell);
    if (runs.length === 0) return [];
    if (runs.some((run) => run.proseTail === true)) return [];
    // Text before the FIRST bold run (先执行 **demo pool create**) is prose: the whole cell is prose and its bold
    // span is a mention (c3 item 3) — a definition comes only from a signature cell.
    const firstRun = runs[0]!;
    if (cell.slice(0, firstRun.start).trim() !== '') return [];
    const out: Anchor[] = [];
    let acceptedEnd = -1;
    let outStart = -1;
    for (const [k, run] of runs.entries()) {
      if (k > 0) {
        const connective = run.between.trim() !== '' && (/^[与和及或、,，\s]+$/.test(run.between) || (headerNamesCommands && /^[/／\s]+$/.test(run.between)));
        const prose = run.between.trim() !== '' && !connective;
        if (prose) break;
        if (run.between.trim() === '' && acceptedEnd >= 0) {
          // Fold into one signature: re-parse the cell from the first run's bold open through this run's syntax.
          const merged = parseAnchor(cell.slice(outStart, run.end), heads);
          if (merged !== null && isRowSignature(merged, headerNamesCommands)) {
            out.pop();
            out.push(merged);
            acceptedEnd = run.end;
            continue;
          }
          return [];
        }
      }
      // Parse THIS run's own syntax, bold marks intact (re-wrapping run.bold would double the closing stars of a
      // ***-closed run; slicing from the cell start would swallow the connective before it).
      const anchor = parseAnchor(cell.slice(run.start, run.end), heads);
      if (anchor === null || !isRowSignature(anchor, headerNamesCommands)) return [];
      out.push(anchor);
      acceptedEnd = run.end;
      if (outStart < 0) outStart = run.start;
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
  // The current command's own state: words, parameter names and variant-group alternatives. Every assignment sets
  // ALL of it (a heading anchor, a paragraph anchor, a new section or a rejected signature) — a stale variant tail
  // from an earlier command never reaches a later one (c3 item 5).
  let current: { path: string; words: string[]; params: { name: string }[]; variantTails: string[] | null } | null = null;
  for (const value of asArray(model.blocks)) {
    if (!isRecord(value) || typeof value.kind !== 'string' || !Number.isInteger(value.section) || typeof value.text !== 'string' || typeof value.selector !== 'string') {
      invalid++;
      continue;
    }
    const block: Block = { kind: value.kind, section: value.section as number, text: value.text, selector: value.selector };
    if (block.section !== section) {
      section = block.section;
      const heading = headingAnchors.get(block.section);
      current = heading !== undefined && heading.path !== null ? { path: heading.path, words: heading.anchor.words, params: heading.anchor.params.map((param) => ({ name: param.name })), variantTails: variantTailsOf(heading.anchor) } : null;
    }
    const text = blockText(block.text);
    if (isNoise(block.kind, text)) continue;
    const fragment: FragmentRef = { parser: parserOf(options), selector: block.selector };
    const anchor = block.kind === 'paragraph' ? parseAnchor(text, heads) : null;
    if (anchor !== null) {
      // A signature whose command is not in the build's tree is still a signature: it hangs at its section node, and
      // the blocks after it follow it there (same data as at a command node: the tree only chooses the path).
      const placed = anchorPathOf(anchor, catalog, options) ?? sectionPath(value, block.section);
      const entry = signatureEntry(anchor, placed, fragment);

      entry.applicability = toApplicability(conditionsOf(text,vocabulary));
      entryContexts.set(entry,{section:block.section,text});
      entries.push(entry);
      current = { path: placed, words: anchor.words, params: anchor.params.map((param) => ({ name: param.name })), variantTails: variantTailsOf(anchor) };
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
        // The command-naming test is PER COLUMN (closure findings 2 and 19): a cell counts as a signature cell only
        // when its own column header names commands (命令/command/commands as a word of the header cell); bold words
        // in every other column are values, parameters and terms (K02 R[3]).
        const commandColumn = (cellIndex: number): boolean => {
          if (header === null) return false;
          const name = header[cellIndex] ?? '';
          // A closed list only (c3 item 3): 命令说明/命令模式/命令功能 DESCRIBE or qualify the command and are
          // value columns, where a bold span is a value or a mention, never a signature.
          const COMMAND_COLUMN_HEADERS = /^(?:命令|命令格式|命令名称|命令行|CLI 命令|命令行格式|Command|Commands|Command Syntax)$/i;
          return COMMAND_COLUMN_HEADERS.test(name.trim());
        };
        const split: ProducedEntry[] = [];
        const remainder: number[] = [];
        // Rows whose bold cells are ALL values of the current command: their bold spans are values, not mentions,
        // and no command literals are recorded from them (c3 item 5).
        const valueOnlyRows = new Set<number>();
        let signatureRows = 0;
        for (const row of table.rows) {
          // The cell field is the COLUMN index: the value-of-current filter runs inside the per-cell map, so a
          // filtered-out anchor never shifts the column a surviving anchor reports (cursor regression of 916e6222).
          const anchorsOf = row.cells.flatMap((cell, cellIndex) => cellAnchors(cell, commandColumn(cellIndex)));
          const found = row.cells.flatMap((cell, cellIndex) => cellAnchors(cell, commandColumn(cellIndex))
            .filter((cellAnchor) => !valueOfCurrent(cellAnchor, current?.words ?? null, current?.variantTails ?? null, current?.params ?? []))
            .map((cellAnchor) => ({ cell: cellIndex, anchor: cellAnchor })));
          if (found.length === 0) {
            // A bare bold word is a value, parameter name or term: the row stays in the remainder. Its bold spans are
            // recorded as literals by the remainder's own putLiterals, as written — no word-level sweep (closure 5/21).
            if (anchorsOf.length > 0) valueOnlyRows.add(row.line);
            remainder.push(row.line);
            continue;
          }
          signatureRows++;
          const rowFragment: FragmentRef = { parser: parserOf(options), selector: block.selector, range: ranges[row.line] };
          const rowText = table.lines[row.line].trimEnd();
          if (found.length === 1) {
            const { cell, anchor: one } = found[0];
            const path = anchorPathOf(one, catalog, options) ?? sectionPath(value, block.section);
            const signature = signatureEntry(one, path, rowFragment);

            signature.applicability = toApplicability(conditionsOf(rowText,vocabulary));
            entryContexts.set(signature,{section:block.section,text:rowText});
            split.push(signature);
            const described = row.cells.filter((cellText, k) => k !== cell && cellText !== '');
            if (described.length > 0) split.push(textEntry({ path, statement: described.join('；'), block: 'table', section: block.section, words: one.words, fragments: [rowFragment] }));
            continue;
          }
          let placed: string | null = null;
          const paths = found.map(({ anchor: some }) => anchorPathOf(some, catalog, options));
          if (paths.every((path) => path !== null)) {
            const lca = commonPrefix(found.map(({ anchor: some }) => some.words));
            if (lca.length >= 1) placed = (paths[0] as string).split('/').slice(0, 2 + lca.length).join('/');
          }
          // Keep positive signature variants separate from the other cells' prose mentions (closure 17).
          const rowEntry = textEntry({ path: placed ?? sectionPath(value, block.section), statement: row.cells.join(' | '), block: 'table', section: block.section, fragments: [rowFragment], noLiterals: true });
          rowEntry.data.signature_literals=found.map(({anchor:some})=>({primary:some.words.join(' '),alternatives:[...new Set((positiveVariantsOf(some)??[some.words]).map(words=>words.join(' ')))].sort(compareText)}));
          const signatureCells=new Set(found.map(item=>item.cell));
          row.cells.forEach((cell,index)=>{if(!signatureCells.has(index))for(const literal of proseLiterals(cell))putLiteral(rowEntry,literal);});
          split.push(rowEntry);
        }
        const remainderPath = current !== null ? current.path : sectionPath(value, block.section);
        // Rows that state their own condition become their own row entries (a row's condition is read from that row
        // alone, never shared with the other rows of the entry); the unconditioned rows keep the shared entry, whose
        // applicability is null (K02 F[6]: 未声明).
        const emitRows = (rowLines: number[], withHeader: boolean): void => {
          const quiet: number[] = [];
          for (const line of rowLines) {
            const rowText = table.lines[line].trimEnd();
            const own = conditionsOf(rowText,vocabulary);
            if (toApplicability(own) !== null) {
              entries.push(
                textEntry({
                  path: remainderPath,
                  statement: rowText,
                  block: 'table',
                  section: block.section,
                  fragments: [{ parser: parserOf(options), selector: block.selector, range: ranges[line] } as FragmentRef],
                  ...(current !== null ? { words: current.words } : {}),
                }),
              );
            } else {
              quiet.push(line);
            }
          }
          if (quiet.length === 0) return;
          const lines = (withHeader ? [table.lines[0]] : []).concat(quiet.map((line) => table.lines[line])).map((line) => line.trimEnd());
          entries.push(
            textEntry({
              path: remainderPath,
              statement: lines.join('\n'),
              block: 'table',
              section: block.section,
              fragments: (withHeader ? [0] : []).concat(quiet).map((line) => ({ parser: parserOf(options), selector: block.selector, range: ranges[line] }) as FragmentRef),
              ...(current !== null ? { words: current.words } : {}),
              // A remainder made only of value rows records no command literals (their bold spans are values).
              ...(quiet.every((line) => valueOnlyRows.has(line)) ? { noLiterals: true } : {}),
            }),
          );
        };
        if (signatureRows > 0) {
          entries.push(...split);
          if (remainder.length > 0) emitRows(remainder, true);
          continue;
        }
        emitRows(table.rows.map((row) => row.line), true);
        continue;
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

  // Drift is evaluated by the shared relation reader against the complete produced tree and its frozen declarations.
  if (invalid > 0) warnings.push(`有 ${invalid} 个块格式不对，已跳过`);
  if (rejected > 0) {
    warnings.push(`有 ${rejected} 段写成命令签名的文字不能作为命令锚点（括号不配对、转义多余、首词不是已知命令或斜杠头），这些段落及其后的块不归到前一条命令，挂在所在章节节点`);
  }
  if (missingSection > 0) warnings.push(`有 ${missingSection} 个块指向不存在的章节，挂在手册命名空间的根下`);
  if (unwritable > 0) warnings.push(`有 ${unwritable} 个块的章节路径写不出（过长或含写不出的字符），挂在手册命名空间的根下`);
  applyScopes();
  for(const field of APPLICABILITY_FIELD){
    for(const entry of entries)if(entry.applicability?.[field]!==undefined){
      if(entry.applicability.inherited?.includes(field))report.counts[field].inherited++;
      else report.counts[field].direct++;
    }
    const count=report.counts[field];
    warnings.push(`适用条件统计：${labelOf('applicability_field',field)}：直接抽取 ${count.direct} 条，继承 ${count.inherited} 条`);
  }
  for(const difference of report.overrides)warnings.push(`适用条件内外层不同：${labelOf('applicability_field',difference.field)}；章节 ${difference.section.join('/')}；声明与片段 ${canonicalJson({values:difference.values,fragments:difference.fragments})}`);
  for(const difference of report.conflicts)warnings.push(`适用条件同章冲突，未裁决：${labelOf('applicability_field',difference.field)}；章节 ${difference.section.join('/')}；声明与片段 ${canonicalJson({values:difference.values,fragments:difference.fragments})}；缺少一致的来源声明；下一步：来源维护者核对这些片段，在再次同步前修订或明确保留矛盾，再重新生产`);
  return { entries, unplaced: [], warnings, applicability_report:report };
}

/** A signature's literals are its command words and variants (never the parameters): what read time can match. */
function positiveVariantsOf(anchor: Anchor): string[][] | null {
  if (anchor.variants === null) return null;
  const key = anchor.words.map((word) => word.toLowerCase());
  const extending = anchor.variants.filter((variant) => variant.length >= key.length && variant.slice(0, key.length).every((word, k) => word.toLowerCase() === key[k]));
  return extending.length > 0 ? extending : anchor.variants;
}

function signatureEntry(anchor: Anchor, path: string, fragment: FragmentRef): ProducedEntry {
  // The literals are the spellings the author could write: the positive variants when there are any (a bare key of a
  // variant signature is a menu prefix, and a leading [no] group's alternatives are not words of the tree).
  const positive = positiveVariantsOf(anchor);
  const literals = [...new Set((positive ?? [anchor.words]).map((words) => words.join(' ')))].sort(compareText);
  const data: { [key: string]: unknown } = { words: anchor.words, form: 'signature', signature: anchor.signature, params: anchor.params, signature_literals: [{primary:anchor.words.join(' '),alternatives:literals}] };
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
        const params=isRecord(input.params)?input.params:{};
        return produceManualEntries(input.model as MarkdownModel, Array.isArray(input.heads) ? asStrings(input.heads) : null, {components:params.components as string[]|undefined,licenses:params.licenses as string[]|undefined,deployment_forms:params.deployment_forms as string[]|undefined,...(name===undefined?{}:{name})});
      }
      return produceManualEntries(input as MarkdownModel);
    },
    (warning) => ({ entries: [], unplaced: [], warnings: [warning] }),
  );
}
