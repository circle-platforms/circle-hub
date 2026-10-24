// The text lines of a case and whether a command line a finding cites (a command without `present`) is quoted from them.
// Such a line is judged as part of the target (tables/cited-commands.json judges the subject), so it must be the case's own
// text: it equals one complete original source line, without folding or text extraction. A line the case does not write is the
// model's statement (case-review.command_not_in_case, sent back for repair), never a fact about the case.
import { isRecord } from './common.ts';

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []);

/** The text lines of a case (title, steps, expected results, preconditions), trimmed, blank ones left out. */
export function caseLines(fields: Record<string, unknown>): string[] {
  const steps = Array.isArray(fields.steps) ? fields.steps.flatMap((s) => (isRecord(s) && typeof s.text === 'string' ? s.text.split('\n') : [])) : [];
  return [...(typeof fields.title === 'string' ? fields.title.split('\n') : []), ...steps, ...strings(fields.expected), ...strings(fields.preconditions)].filter((line) => line !== '');
}

/**
 * The lines a cited command line may come from: the case's lines (its fields) and the text of its own fragment as the
 * boundary resolved it (the full title, also where the fields clip it).
 */
export function quotableLines(item: Record<string, unknown>, evidence: unknown): string[] {
  const fields = isRecord(item.fields) ? item.fields : {};
  const own = typeof item.location === 'string' ? item.location : null;
  const fragment = Array.isArray(evidence)
    ? evidence.flatMap((e) => (isRecord(e) && own !== null && e.reference === own && typeof e.text === 'string' ? e.text.split('\n') : []))
    : [];
  return [...caseLines(fields), ...fragment.filter((line) => line !== '')];
}

/** R4: a source reference is one complete original line, with exact code points.
 * This verifies quotation only. Typed command validity is separately checked against the bound catalog.
 * No prompt stripping, word-boundary guessing, case/width folding or substring extraction.
 */
export function quotedFromCase(command: string, lines: readonly string[]): boolean {
  return command.length > 0 && lines.some(line => line === command);
}

/** `{ item, evidence?, commands }` to the commands the case writes and the others: `{ quoted, unquoted }`. */
export default function (input: unknown): unknown {
  try {
    const record = isRecord(input) ? input : {};
    const lines = quotableLines(isRecord(record.item) ? record.item : {}, record.evidence);
    const commands = strings(record.commands);
    return { quoted: commands.filter((c) => quotedFromCase(c, lines)), unquoted: commands.filter((c) => !quotedFromCase(c, lines)) };
  } catch {
    return { quoted: [], unquoted: [] };
  }
}
