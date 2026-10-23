// Text projections over what the pinned engine already produced. The engine decides AsciiDoc semantics (markup,
// attribute references, character references, inline macros, typographic replacements); these functions only fold its
// output into a comparable or readable form. They never decide structure, never locate a line on their own and never
// invent content: a citation is always a source line re-read verbatim (origins.ts), and a statement is always the
// engine's own text.
//
// This module is part of the expansion adapter, which the sandbox test stages on its own (functions/adoc alone), so it
// keeps its own copies of the two small text helpers instead of importing ../util.ts.

/** Named character references the engine emits; the numeric ones are decoded below. */
const NAMED: Readonly<Record<string, string>> = { quot: '"', amp: '&', lt: '<', gt: '>', apos: "'", nbsp: '\u00a0', mdash: '\u2014', ndash: '\u2013', hellip: '\u2026', rsquo: '\u2019', lsquo: '\u2018', ldquo: '\u201c', rdquo: '\u201d', thinsp: '\u2009', zwsp: '\u200b' };

/** Character references decoded (named and numeric); an unknown or malformed one stays as written. */
export function decodeReferences(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(/&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z]{2,8});/g, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return whole;
      return String.fromCodePoint(code);
    }
    return Object.hasOwn(NAMED, body) ? NAMED[body]! : whole;
  });
}

/** Every run of white space becomes one space and both ends are trimmed (NUL, which stored text cannot hold, goes). */
export function squeeze(text: string): string {
  return (text.includes('\u0000') ? text.replaceAll('\u0000', '') : text).replace(/\s+/g, ' ').trim();
}

/**
 * The engine's inline output (HTML-ish tags and character references) in the markdown-shaped inline spelling K1's
 * placement code reads: strong to `**…**`, em to `*…*`, code to backticks, every character reference decoded. Any other
 * tag is dropped and its text kept, because a manual statement carries words, not presentation.
 */
export function inlineMarkdown(text: string): string {
  const marked = text
    .replace(/<strong>([\s\S]*?)<\/strong>/giu, '**$1**')
    .replace(/<code>([\s\S]*?)<\/code>/giu, '`$1`')
    .replace(/<em>([\s\S]*?)<\/em>/giu, '*$1*')
    .replace(/<[^>]*>/gu, '');
  return decodeReferences(marked);
}

/** The replacements the engine makes for author-written punctuation, folded back to what an author types. */
const TYPOGRAPHIC: Readonly<Record<string, string>> = {
  '\u2018': "'",
  '\u2019': "'",
  '\u201c': '"',
  '\u201d': '"',
  '\u2013': '-',
  '\u2014': '--',
  '\u2026': '...',
  '\u00a0': ' ',
  '\u2007': ' ',
  '\u2008': ' ',
  '\u2009': ' ',
  '\u200a': ' ',
  '\u202f': ' ',
  '\u200b': '',
  '\u2060': '',
  '\ufeff': '',
};

/** Inline markup marks of both spellings (AsciiDoc `*bold* _em_ `mono` +pass+ #mark#, markdown `**bold**`). */
const MARKS = '*_`#^~+';

/**
 * The inline macros whose text is all the engine keeps: `link:target[text]`, a bare URL with `[text]`, `xref:id[text]`
 * and `<<id,text>>`. A macro the engine renders with more than its text (a menu path, a key cap, a footnote number) is
 * not folded, so a block that carries one is reported instead of cited (origins.ts).
 */
const MACRO_TEXT = [
  /\b(?:link|xref|image|icon):[^\s[]*\[([^\]]*)\]/gu,
  /\bhttps?:\/\/[^\s[]*\[([^\]]*)\]/gu,
  /<<[^,>]*,([^>]*)>>/gu,
  /<<([^>]*)>>/gu,
];

/** The text an author wrote, as far as the engine keeps it: inline macros reduced to their text. */
function macroText(text: string): string {
  let out = text;
  for (const pattern of MACRO_TEXT) out = out.replace(pattern, '$1');
  return out;
}

/**
 * The words of a text, for comparison only: tags dropped, character references decoded, inline macros reduced to their
 * text, backslash escapes resolved, inline markup marks dropped, the engine's typographic replacements folded back to
 * ASCII and white space collapsed. A source line and the engine's converted text of that line fold to the same words;
 * two different lines that fold the same are not told apart, which is why a fold never decides a citation by itself
 * (origins.ts takes exactly one candidate, and the engine's own cursor decides among lines that hold the same text) and
 * never becomes a statement.
 */
export function plainText(text: string): string {
  const decoded = decodeReferences(macroText(text).replace(/<[^>]*>/gu, ''));
  let out = '';
  for (let i = 0; i < decoded.length; i++) {
    const ch = decoded[i] as string;
    if (ch === '\\' && i + 1 < decoded.length) {
      out += decoded[++i];
      continue;
    }
    if (MARKS.includes(ch)) continue;
    out += TYPOGRAPHIC[ch] ?? ch;
  }
  return squeeze(out);
}

/** AsciiDoc inline markup marks dropped and escapes resolved, attributes left as the caller expanded them. */
export function stripMarks(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (ch === '\\' && i + 1 < text.length) {
      out += text[++i];
      continue;
    }
    if (MARKS.includes(ch)) continue;
    out += ch;
  }
  return out;
}
