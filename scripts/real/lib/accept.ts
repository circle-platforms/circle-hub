// The shared parts of the real-client acceptance: what a scenario is, and how the scripted model's request log is read.
// (A separate module because the runner awaits its scenario modules at the top level, so a scenario must not import the runner.)
import type { Respond } from '../scripted-model.ts';
import type { Check, ReportSection } from './report.ts';

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
  /** Extra sections for the report, if any (not counted in pass/fail). */
  sections?: ReportSection[];
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
