// The text lines of a case and whether a command line a finding cites (a command without `present`) is quoted from them.
// Such a line is judged as part of the target (tables/cited-commands.json judges the subject), so it must be the case's own
// text: compared in the form the catalog check matches (NFKC, white space collapsed, case folded), it occurs in one line of
// the case as whole words, and no argument of the case's line is cut off or added. A line the case does not write is the
// model's statement (case-review.command_not_in_case, sent back for repair), never a fact about the case.
import { isRecord } from './common.ts';
import { fold } from './text.ts';

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []);

/** The text lines of a case (title, steps, expected results, preconditions), trimmed, blank ones left out. */
export function caseLines(fields: Record<string, unknown>): string[] {
  const steps = Array.isArray(fields.steps) ? fields.steps.flatMap((s) => (isRecord(s) && typeof s.text === 'string' ? s.text.split('\n') : [])) : [];
  return [...(typeof fields.title === 'string' ? fields.title.split('\n') : []), ...steps, ...strings(fields.expected), ...strings(fields.preconditions)].map((line) => line.trim()).filter((line) => line !== '');
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
  return [...caseLines(fields), ...fragment.map((line) => line.trim()).filter((line) => line !== '')];
}

/** Characters a command word is made of, and the ones that join two parts of one argument (192.0.2.5, 5-10, a/b, 1:2). */
const WORD = /[a-z0-9_]/;
const JOINER = /[.\-/:]/;
const QUOTE = /["']/;

/** Whether the match of `length` characters at `at` in a folded line cuts a word or an argument at either end. */
function cut(line: string, at: number, length: number): boolean {
  const before = line[at - 1] ?? '';
  if (WORD.test(before)) return true;
  if (before === ' ') {
    const word = line[at - 2] ?? '';
    if (WORD.test(word) || QUOTE.test(word)) return true;
  }
  const after = line[at + length] ?? '';
  if (WORD.test(after)) return true;
  if (JOINER.test(after) && WORD.test(line[at + length + 1] ?? '')) return true;
  if (after === ' ') {
    const next = line[at + length + 1] ?? '';
    if (WORD.test(next) || QUOTE.test(next)) return true;
  }
  return false;
}

/** Whether a command line is quoted from one of the lines: whole words in the matching form, nothing cut off or added. */
export function quotedFromCase(command: string, lines: readonly string[]): boolean {
  const phrase = fold(command);
  if (phrase === '') return false;
  for (const raw of lines) {
    const line = fold(raw);
    for (let at = line.indexOf(phrase); at >= 0; at = line.indexOf(phrase, at + 1)) if (!cut(line, at, phrase.length)) return true;
  }
  return false;
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
