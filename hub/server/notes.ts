// Admin notes and operator log text. Records take an admin note only as 1 to 2000 characters of well-formed text without
// NUL; a note cut inside a surrogate pair, or one that quotes a NUL, would make the whole call-log line fail. Every note
// therefore goes through clipNote: NUL removed, lone surrogates replaced, cut between code points.

/** Longest admin note of one call-log line (records: 1 to 2000 UTF-16 code units). */
export const MAX_ADMIN_NOTE = 2000;

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;

/** Text records accept as an admin note: no NUL, no lone surrogate, at most `max` code units, cut between code points. */
export function clipNote(text: unknown, max: number = MAX_ADMIN_NOTE): string {
  const clean = String(text).replaceAll('\0', '').toWellFormed();
  if (clean.length <= max) return clean;
  let end = Math.max(0, max - 1);
  if (end > 0 && isHighSurrogate(clean.charCodeAt(end - 1))) end -= 1;
  return `${clean.slice(0, end)}…`;
}

/** An error for the admin note or the operator's log: name and message, clipped; never the stack. */
export function describeError(error: unknown): string {
  if (error instanceof Error) return clipNote(`${error.name}: ${error.message}`, 1500);
  return clipNote(error, 1500);
}
