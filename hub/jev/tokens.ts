// A conservative token estimate for mixed Chinese and English JSON text. The service's tokenizer is not published, so
// every allowance errs on the high side: requests planned with it should stay under the context limits.

function isPlainAscii(code: number): boolean {
  return (code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a) || code === 0x20;
}

/**
 * One token per CJK or other non-ASCII character (two for a character outside the BMP), one per ASCII punctuation or
 * control character, and one per three ASCII letters, digits or spaces.
 */
export function estimateTokens(text: string): number {
  let tokens = 0;
  let plain = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code < 0x80) {
      if (isPlainAscii(code)) plain++;
      else tokens++;
    } else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        tokens += 2;
        index++;
      } else {
        tokens++;
      }
    } else {
      tokens++;
    }
  }
  return tokens + Math.ceil(plain / 3);
}

/** Estimate for the JSON text of a value as it would be sent. */
export function estimateJsonTokens(value: unknown): number {
  return estimateTokens(JSON.stringify(value) ?? '');
}
