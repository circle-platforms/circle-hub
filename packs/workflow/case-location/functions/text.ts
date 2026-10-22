// Small pure helpers of the case-location functions: input guards, text normalization, clipping and the totality guard.
// No imports at run time.

export const PACK = 'case-location';

export function isRecord(value: unknown): value is { [key: string]: unknown } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Strings of an array; anything else is dropped. */
export function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/** Text of a JSON scalar the way the kityminder@1 parser reads node text. */
export function textOf(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if ((typeof value === 'number' && Number.isFinite(value)) || typeof value === 'boolean') return String(value);
  return null;
}

/** U+0000 removed, every run of white space (Unicode, NBSP included) one space, both ends trimmed. */
export function squeeze(text: string): string {
  return text.replaceAll('\u0000', '').replace(/\s+/gu, ' ').trim();
}

/** Lone surrogates replaced by U+FFFD, so that every text written into an answer is well-formed. */
export function wellFormed(text: string): string {
  return text.toWellFormed();
}

/** The matching form: NFKC (full-width letters, digits and colons folded), white space squeezed. */
export function nfkc(text: string): string {
  return squeeze(wellFormed(text).normalize('NFKC'));
}

/** The comparison form of a name: the matching form, lower case. */
export function fold(text: string): string {
  return nfkc(text).toLowerCase();
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

/** Order-preserving de-duplication. */
export function unique<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}

/** Proleptic Gregorian calendar date. */
export function validDate(year: number, month: number, day: number): boolean {
  if (!Number.isInteger(year) || year < 1900 || year > 2099 || month < 1 || month > 12 || day < 1) return false;
  const days = [31, (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1];
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

/**
 * A text of reference shape (`<scheme>:<sha256>` and an optional tail without white space), as the engine forms item
 * locations. The schemes are the engine's (the generated vocabulary, which a pack function cannot import): which of them may
 * ground a claim is decided there, so no scheme is named here.
 */
export function isReference(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 8192 && /^[a-z][a-z0-9]*:[0-9a-f]{64}(?:[/#@:]\S*)?$/.test(value);
}
