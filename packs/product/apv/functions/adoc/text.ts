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

/** The presentation tags the engine wraps inline markup in, and what a reader's spelling uses for them. */
const TAGGED: ReadonlyArray<readonly [RegExp, string]> = [
  [/<strong>([\s\S]*?)<\/strong>/giu, '**$1**'],
  [/<b>([\s\S]*?)<\/b>/giu, '**$1**'],
  [/<code>([\s\S]*?)<\/code>/giu, '`$1`'],
  [/<tt>([\s\S]*?)<\/tt>/giu, '`$1`'],
  [/<em>([\s\S]*?)<\/em>/giu, '*$1*'],
  [/<i>([\s\S]*?)<\/i>/giu, '*$1*'],
];

/** Tags that carry no words of their own: the wrapper goes, its text stays. */
const WRAPPERS = /<\/?(?:span|sub|sup|a|abbr|cite|q|mark|small|big|font|u|s|strike|kbd|keycap|menuref|btn)\b[^>]*>/giu;

/**
 * The engine's inline output (its presentation tags and character references) in the markdown-shaped inline spelling
 * K1's placement code reads: strong to `**…**`, em to `*…*`, code to backticks, every character reference decoded. Only
 * the tags the engine produces for markup are touched; anything else stays as the text it is, because a `<name>` an
 * author wrote is a parameter placeholder and not a tag.
 */
export function inlineMarkdown(text: string): string {
  let out = text;
  for (const [pattern, replacement] of TAGGED) out = out.replace(pattern, replacement);
  return decodeReferences(out.replace(WRAPPERS, ''));
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
 * The words of a text, for comparison only: character references decoded, inline macros reduced to their text,
 * backslash escapes resolved, inline markup marks dropped, the engine's typographic replacements folded back to ASCII
 * and white space collapsed. Two different lines that fold the same are not told apart, which is why a fold never
 * decides a citation by itself (origins.ts takes exactly one candidate, and the engine's own cursor decides among lines
 * that hold the same text) and never becomes a statement.
 */
function fold(text: string): string {
  const decoded = decodeReferences(macroText(text));
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

/** The fold of a source line: `<name>` in what an author wrote is text, so no tag is stripped. */
export function plainText(text: string): string {
  return fold(text);
}

/** The fold of the engine's converted text: its markup tags and character references are the source's marks and text. */
export function plainConverted(text: string): string {
  return fold(inlineMarkdown(text));
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
