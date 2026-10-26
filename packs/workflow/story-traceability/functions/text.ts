// Small pure helpers of the traceability functions: input guards, text clipping and the totality guard.
// No imports at run time.

export const PACK = 'story-traceability';

export function isRecord(value: unknown): value is { [key: string]: unknown } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Strings of an array; anything else is dropped. */
export function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/** UTF-16 code-unit order, the order the knowledge reader sorts keys and rows by. */
export function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** U+0000 removed, every run of white space (Unicode, NBSP included) one space, both ends trimmed. */
export function squeeze(text: string): string {
  return text.replaceAll('\u0000', '').replace(/\s+/gu, ' ').trim();
}

/** Lone surrogates replaced by U+FFFD, so that every text written into an answer is well-formed. */
export function wellFormed(text: string): string {
  return text.toWellFormed();
}

/** At most `max` code points; a clipped text ends with an ellipsis. */
export function clip(text: string, max: number): string {
  const points = [...text];
  return points.length <= max ? text : `${points.slice(0, Math.max(1, max - 1)).join('')}…`;
}

/** The text shown in an answer: well-formed, white space squeezed, clipped. */
export function shown(text: string, max = 200): string {
  return clip(squeeze(wellFormed(text)), max);
}

/** UTF-8 bytes of a text (a lone surrogate counts three bytes, like U+FFFD). */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) {
      bytes += 4;
      i += 1;
    } else bytes += 3;
  }
  return bytes;
}

/** Warning text of an unexpected failure inside a function. */
export function internalError(error: unknown): string {
  let detail = '未知错误';
  try {
    detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  } catch {
    // keep the generic detail
  }
  return `内部错误，结果不完整：${detail.slice(0, 200)}`;
}

/** Runs a function entry so that it never throws: an unexpected failure becomes `fallback(message)`. */
export function guarded<T>(run: () => T, fallback: (message: string) => T): T {
  try {
    return run();
  } catch (error) {
    return fallback(internalError(error));
  }
}
