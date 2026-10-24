// The shared parts of the real-client acceptance: what a scenario is, and how the scripted model's request log is read.
// (A separate module because the runner awaits its scenario modules at the top level, so a scenario must not import the runner.)
import type { Respond } from '../scripted-model.ts';
import type { Check, ReportSection } from './report.ts';
import { labelOf, VERDICT } from '../../../contracts/generated/vocabulary.ts';

export interface Scenario {
  name: string;
  area: string;
  /** What the person types into the client. */
  prompt: string;
  respond: Respond;
  /** Decides the checks from what the model was shown. */
  check(turns: LoggedTurn[]): Check[];
  /** Writes scenario files into the Circle work directory before the client starts (after writeHome, before
   * startCircle); the scratch directory is still removed whole at the end. */
  prepare?(workdir: string): void | Promise<void>;
  /** Extra report limits of this scenario, appended after the two fixed ones. */
  limits?: string[];
  /** Extra sections for the report, if any (not counted in pass/fail). */
  sections?: ReportSection[];
  /** Anonymous count lines safe for the terminal; absent keeps existing scenarios unchanged. */
  countLines?: string[];
}

export interface LoggedTurn {
  index: number;
  /** The tool results the client forwarded to the model in this request (text only, as Circle forwards them). */
  toolResults: Array<{ id: string; text: string; isError: boolean }>;
  tools: string[];
}

/** The request log of the scripted model as turns, oldest first. */
export function parseLog(text: string): LoggedTurn[] {
  const turns: LoggedTurn[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const row = JSON.parse(line) as { index: number; toolResults?: LoggedTurn['toolResults']; tools?: Array<{ name: string }> };
    turns.push({ index: row.index, toolResults: row.toolResults ?? [], tools: (row.tools ?? []).map((t) => t.name) });
  }
  return turns;
}

/** The text of every tool result the model was shown, in order. */
export const resultTexts = (turns: readonly LoggedTurn[]): string[] => turns.flatMap((t) => t.toolResults.map((r) => r.text));

/**
 * The verdict of one claim line the answer renders, read from the structured fields only: the line's labeled
 * 陈述 segment carries the verdict label of the generated vocabulary as its own comma-separated part. A part equals
 * a closed verdict label exactly or it is not a verdict — no scanning of the statement prose. Lines without a
 * readable verdict (not claim lines, or a claim without its verdict field) answer null.
 */
const VERDICT_OF_LABEL = new Map<string, string>(VERDICT.map((code) => [labelOf('verdict', code), code]));
export function claimVerdict(line: string): string | null {
  // Works on a full answer line (the 陈述 segment among the labeled fields) and on a statement already extracted
  // from one (ownClaimTexts strips the label): the verdict is a closed-set label standing as its own comma-separated
  // part. Not a claim line or a claim without its verdict field: null.
  const segments = line.split('；');
  const statement = segments.find((segment) => segment.startsWith('陈述：'));
  const text = statement !== undefined ? statement.slice('陈述：'.length) : line;
  for (const part of text.split('，')) {
    const code = VERDICT_OF_LABEL.get(part);
    if (code !== undefined) return code;
  }
  return null;
}
