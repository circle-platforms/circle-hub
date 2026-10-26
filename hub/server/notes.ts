// Admin notes and operator log text. Records take an admin note only as 1 to 2000 characters of well-formed text without
// NUL; a note cut inside a surrogate pair, or one that quotes a NUL, would make the whole call-log line fail. Every note
// summaries therefore use clipNote. Full reasons are normalized without shortening at the MCP boundary and validated
// by records; their private rows are separate from the bounded summary.

/** Longest admin note summary of one call-log line (records: 1 to 2000 UTF-16 code units). */
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

/**
 * Strips machine absolute paths from a stack line, keeping function names and repo-relative paths only.
 */
export function sanitizeStackLine(line: string): string {
  const trimmed = line.trim();
  if (!trimmed.startsWith('at ')) return trimmed;
  let s = trimmed;
  const cwd = typeof process !== 'undefined' && process.cwd ? process.cwd() : '';
  if (cwd) {
    s = s.replaceAll(`file://${cwd}/`, '').replaceAll(`${cwd}/`, '');
  }
  s = s.replace(/(?:file:\/\/)?(?:\/[^:\s)]+?|\b[A-Za-z]:\\[^:\s)]+?)\/(hub|packs|contracts|scripts|tests|references|foundation|node_modules)\//g, '$1/');
  s = s.replace(/(?:file:\/\/)?\/(?:Users|home|var|tmp|private)[^:\s)]*\/([^/:\s)]+:[0-9]+:[0-9]+)/g, '$1');
  return s;
}

/** Formats an error for an internal failure: error name and clipped message followed by sanitized stack frames. */
export function cleanStack(error: unknown): string {
  if (!(error instanceof Error)) return clipNote(String(error), 1500);
  const raw = error.stack ?? `${error.name}: ${error.message}`;
  const lines = raw.split('\n');
  const out: string[] = [];
  const header = `${error.name}: ${clipNote(error.message, 200)}`;
  out.push(header);
  for (let i = 1; i < lines.length && out.length < 25; i++) {
    const line = lines[i].trim();
    if (!line.startsWith('at ')) continue;
    out.push(sanitizeStackLine(line));
  }
  return clipNote(out.join('\n'), 1800);
}

/** An error for internal error admin notes: error name, message and repo-relative stack trace. */
export function describeInternalError(error: unknown): string {
  return cleanStack(error);
}
