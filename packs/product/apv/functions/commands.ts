// Command phrases in free Chinese or English text. A phrase starts at a word that begins some catalog head, takes the head
// words the catalog knows and then the argument tokens that follow, up to Chinese text, sentence punctuation, a line end,
// a closing quote or bracket. Inside backticks or quotes it runs to the closing mark. Never prose:
// - an English stop word or a placeholder (xxx, ...) after the head cuts the phrase back to its head;
// - after an English word (prose context) only the head is kept;
// - a lone word is a phrase only when quoted, or when it is a complete head standing in Chinese text and is not named as a
//   command (show命令).
import type { CommandsResult, Phrase } from './types.ts';
import { asString, asStrings, guarded, internalError, isRecord, squeeze } from './util.ts';

const MAX_TEXT = 1_000_000;
const MAX_HEADS = 100_000;
const MAX_TOKENS = 64;
/** Longest stretch of text one phrase may cover; bounds every search, so the scan stays linear. */
const MAX_SPAN = 2000;

/** English words that end a phrase after its head (CLI words such as on, off, all, any, no, in, out stay out of the list). */
const STOP_WORDS = new Set(
  (
    'a an the of to is are was were be been being and or but for with that this these those it its as by from into will would can could ' +
    'should shall may might must if then than when which who what how why there their we you they he she i my your our has have had do ' +
    'does did so such also after before about over under between again more most very too just only each every some while where because ' +
    'until during without within please use using used via'
  ).split(' '),
);
const PLACEHOLDER = /^(?:x{2,}|y{2,}|\.{2,}|…+|\*+)$/i;
/** The closing mark of an opening mark right before a phrase; quotes make the phrase delimited. */
const PAIRS: { [open: string]: string } = { '`': '`', '"': '"', "'": "'", '“': '”', '‘': '’', '「': '」', '『': '』', '（': '）', '(': ')', '【': '】', '[': ']' };
const QUOTES = new Set(['`', '"', "'", '“', '‘', '「', '『']);
const NAMED_AS_COMMAND = /^\s*(?:命令|指令|commands?\b)/i;

type Trie = { children: Map<string, Trie>; complete: boolean };

function buildTrie(heads: readonly string[]): Trie {
  const root: Trie = { children: new Map(), complete: false };
  for (const head of heads.slice(0, MAX_HEADS)) {
    const words = squeeze(head).toLowerCase().split(' ').filter((word) => word !== '');
    if (words.length === 0 || words.length > MAX_TOKENS) continue;
    let node = root;
    for (const word of words) {
      let child = node.children.get(word);
      if (child === undefined) {
        child = { children: new Map(), complete: false };
        node.children.set(word, child);
      }
      node = child;
    }
    node.complete = true;
  }
  return root;
}

/** White space, CJK text, full-width punctuation and curly quotes end a token outside quotes. */
function endsToken(ch: string): boolean {
  return /[\s\u2018-\u201f\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/.test(ch);
}

function startsWord(text: string, i: number): boolean {
  return /[A-Za-z]/.test(text[i]) && !/[A-Za-z0-9_\-.]/.test(text[i - 1] ?? ' ');
}

/** Trailing punctuation that cannot end an argument; a closing bracket with its opening inside the token stays. */
function trimTrailing(text: string, start: number, end: number): number {
  let e = end;
  while (e > start && /[.,;:!?)\]}>'"`]/.test(text[e - 1])) {
    const ch = text[e - 1];
    const opening = ch === ')' ? '(' : ch === ']' ? '[' : ch === '}' ? '{' : ch === '>' ? '<' : null;
    if (opening !== null && text.slice(start, e - 1).includes(opening)) break;
    e--;
  }
  return e;
}

type Token = { start: number; end: number; text: string };

/** Tokens from `at` to `limit` on one line. Outside quotes a token stripped of trailing punctuation, or ended by Chinese text, ends the run. */
function tokensFrom(text: string, at: number, limit: number, quoted: boolean): Token[] {
  const tokens: Token[] = [];
  let i = at;
  while (i < limit && tokens.length < MAX_TOKENS) {
    while (i < limit && (text[i] === ' ' || text[i] === '\t')) i++;
    if (i >= limit || text[i] === '\n' || text[i] === '\r') break;
    const start = i;
    if (text[i] === '"' || text[i] === "'") {
      const found = text.slice(i + 1, limit).indexOf(text[i]);
      const close = found < 0 ? -1 : i + 1 + found;
      if (close < 0 || /[\r\n]/.test(text.slice(i, close))) break;
      i = close + 1;
    } else if (quoted) {
      while (i < limit && !/\s/.test(text[i])) i++;
    } else {
      while (i < limit && !endsToken(text[i])) i++;
    }
    const end = quoted ? i : trimTrailing(text, start, i);
    if (end > start) tokens.push({ start, end, text: text.slice(start, end) });
    if (!quoted && (end < i || (i < limit && !/[ \t]/.test(text[i])))) break;
  }
  return tokens;
}

/** The previous character that is not a space or tab, or ''. */
function previousVisible(text: string, i: number): string {
  let k = i - 1;
  while (k >= 0 && (text[k] === ' ' || text[k] === '\t')) k--;
  return k >= 0 ? text[k] : '';
}

export function extractCommands(input: { text: string; heads: string[] }): CommandsResult {
  const warnings: string[] = [];
  const phrases: Phrase[] = [];
  try {
    if (!isRecord(input)) return { phrases, warnings: ['输入不是对象'] };
    let text = asString(input.text) ?? '';
    if (typeof input.text !== 'string') warnings.push('text 不是字符串');
    if (text.length > MAX_TEXT) {
      warnings.push(`文本超过 ${MAX_TEXT} 个字符，只看前 ${MAX_TEXT} 个`);
      text = text.slice(0, MAX_TEXT);
    }
    const heads = asStrings(input.heads);
    if (heads.length > MAX_HEADS) warnings.push(`命令头超过 ${MAX_HEADS} 个，只用前 ${MAX_HEADS} 个`);
    const trie = buildTrie(heads);
    if (trie.children.size === 0) return { phrases, warnings };
    let i = 0;
    while (i < text.length) {
      if (!startsWord(text, i)) {
        i++;
        continue;
      }
      let wordEnd = i;
      while (wordEnd < text.length && /[A-Za-z0-9_\-?]/.test(text[wordEnd])) wordEnd++;
      const skip = Math.max(wordEnd, i + 1);
      if (!trie.children.has(text.slice(i, wordEnd).toLowerCase())) {
        i = skip;
        continue;
      }
      const open = text[i - 1] ?? '';
      const close = Object.hasOwn(PAIRS, open) ? PAIRS[open] : null;
      // The window of this phrase: up to the line end, at most MAX_SPAN characters.
      const window = text.slice(i, i + MAX_SPAN);
      const newline = window.indexOf('\n');
      const lineEnd = i + (newline < 0 ? window.length : newline);
      const found = close === null ? -1 : window.indexOf(close);
      const closeAt = found < 0 ? -1 : i + found;
      const closed = closeAt > i && closeAt <= lineEnd;
      const quoted = closed && QUOTES.has(open);
      const tokens = tokensFrom(text, i, closed ? closeAt : lineEnd, quoted);
      // The head: the longest run of tokens the catalog knows; it must start with the first token.
      let node: Trie = trie;
      let head = 0;
      let complete = 0;
      for (const token of tokens) {
        const next = node.children.get(token.text.toLowerCase());
        if (next === undefined) break;
        node = next;
        head++;
        if (node.complete) complete = head;
      }
      if (head === 0) {
        i = skip;
        continue;
      }
      let length = tokens.length;
      let cut = false;
      for (let k = head; k < tokens.length; k++) {
        if (PLACEHOLDER.test(tokens[k].text) || (!quoted && STOP_WORDS.has(tokens[k].text.toLowerCase()))) {
          length = head;
          cut = true;
          break;
        }
      }
      const prose = !quoted && /[A-Za-z]/.test(previousVisible(text, i));
      if (prose) length = Math.min(length, head);
      const end = tokens[length - 1].end;
      const single = length === 1;
      const standsAlone = complete === 1 && !cut && !prose && !NAMED_AS_COMMAND.test(text.slice(end, end + 12));
      if (single && !quoted && !standsAlone) {
        i = skip;
        continue;
      }
      const start = tokens[0].start;
      phrases.push({ text: text.slice(start, end), start, end });
      i = end;
    }
    return { phrases, warnings };
  } catch (error) {
    return { phrases, warnings: [...warnings, internalError(error)] };
  }
}

/** Pack function entry: `{ text, heads }`. */
export default function commands(input: unknown): CommandsResult {
  return guarded(
    () => extractCommands(input as { text: string; heads: string[] }),
    (warning) => ({ phrases: [], warnings: [warning] }),
  );
}
