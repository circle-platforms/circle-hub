// Text the administrator commands print can come from packs (titles, problem messages), resources (names), the build site
// (build names in a sync report) or a remote system (a reason quoting an envelope message). A control sequence in it could
// clear lines, fake output or retitle the terminal, so every printed line is made safe first: each C0 and C1 control
// character except tab, DEL, the line and paragraph separators and the bidirectional controls are shown as visible escapes.

/** Code point ranges shown as escapes (inclusive): C0 but tab, DEL and C1, ALM, LRM and RLM, LS and PS, LRE..RLO, LRI..PDI. */
const UNSAFE: readonly (readonly [number, number])[] = [
  [0x00, 0x08],
  [0x0a, 0x1f],
  [0x7f, 0x9f],
  [0x61c, 0x61c],
  [0x200e, 0x200f],
  [0x2028, 0x202e],
  [0x2066, 0x2069],
];

function unsafe(code: number): boolean {
  return UNSAFE.some(([from, to]) => code >= from && code <= to);
}

function escaped(code: number): string {
  return code <= 0xff ? `\\x${code.toString(16).padStart(2, '0')}` : `\\u${code.toString(16).padStart(4, '0')}`;
}

/** `text` with every character that can steer a terminal replaced by a visible escape (`\x1b`, or `\u` and 4 hex digits); tabs stay. */
export function terminalSafe(text: string): string {
  const value = String(text);
  let out = '';
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    out += unsafe(code) ? escaped(code) : char;
  }
  return out;
}

/**
 * JSON text (JSON.stringify's) with the characters it leaves raw but a terminal may act on (DEL, the C1 controls, ALM, LRM
 * and RLM, the line separators and the bidirectional controls) written as \u escapes. They can only stand inside strings,
 * so the JSON value is the same. C0 is left alone: JSON.stringify escapes it inside strings, and outside them it is the
 * pretty-printer's own line breaks.
 */
export function jsonSafe(json: string): string {
  let out = '';
  for (const char of String(json)) {
    const code = char.codePointAt(0) ?? 0;
    // Every code point of UNSAFE is in the BMP: \u and 4 hex digits is a JSON escape of it.
    out += code >= 0x7f && unsafe(code) ? `\\u${code.toString(16).padStart(4, '0')}` : char;
  }
  return out;
}
