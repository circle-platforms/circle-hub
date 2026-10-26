// Splits command text into words: white space separates; with quotes, '...' is literal and "..." honours \" and \\; a
// backslash outside quotes escapes the next character. Returns null for an unterminated quote or a trailing backslash.
import { isWhiteSpace } from '../text.ts';

export function tokenize(text: string, quotes = true): string[] | null {
  const words: string[] = [];
  let word = '';
  let started = false;
  let quote: string | null = null;
  const chars = Array.from(text);
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (quotes && c === '\\' && quote !== "'") {
      if (i + 1 >= chars.length) return null;
      const next = chars[++i];
      if (quote === '"' && next !== '"' && next !== '\\') word += '\\';
      word += next;
      started = true;
      continue;
    }
    if (quote) {
      if (c === quote) quote = null;
      else word += c;
      continue;
    }
    if (quotes && (c === '"' || c === "'")) {
      quote = c;
      started = true;
      continue;
    }
    if (isWhiteSpace(c.codePointAt(0) ?? 0)) {
      if (started) words.push(word);
      word = '';
      started = false;
      continue;
    }
    word += c;
    started = true;
  }
  if (quote) return null;
  if (started) words.push(word);
  return words;
}

/** Words separated by white space only, quotes and backslashes kept: enough to find the head of a phrase tokenize refuses. */
export function splitWords(text: string): string[] {
  const words: string[] = [];
  let word = '';
  for (const c of text) {
    if (isWhiteSpace(c.codePointAt(0) ?? 0)) {
      if (word !== '') words.push(word);
      word = '';
    } else word += c;
  }
  if (word !== '') words.push(word);
  return words;
}
