// The shared parts of the real-client acceptance: what a scenario is, and how the scripted model's request log is read.
// (A separate module because the runner awaits its scenario modules at the top level, so a scenario must not import the runner.)
import type { Respond } from '../scripted-model.ts';
import type { Check, ReportSection } from './report.ts';
import { VERDICT } from '../../../contracts/generated/vocabulary.ts';

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

/** Only serialized structured fields can establish a verdict; rendered prose is incomplete evidence. */
export function claimOutcome(input:string):{verdict:string;reason?:string;missing?:string;exit?:unknown}|null {
 try {const row=JSON.parse(input);const statement=row?.statement;
  if(!statement||typeof statement!=='object'||!VERDICT.includes(statement.verdict))return null;
  return {verdict:statement.verdict,...(typeof statement.reason==='string'?{reason:statement.reason}:{}),...(typeof statement.missing==='string'?{missing:statement.missing}:{}),...(statement.exit===undefined?{}:{exit:statement.exit})};
 }catch{return null;}
}
export function claimVerdict(input:string):string|null{return claimOutcome(input)?.verdict??null;}
export function unknownDetail(input:string):string {
 const outcome=claimOutcome(input);
 if(!outcome||outcome.verdict!=='unknown')return '缺少结构化未知判定字段，答案不完整；下一步读取运行结果的 verdict、reason、missing、exit 后重跑';
 return outcome.reason&&outcome.missing&&outcome.exit!==undefined ? '原因：'+outcome.reason+'；缺失事实：'+outcome.missing+'；下一步：'+JSON.stringify(outcome.exit) : '未知判定缺少 reason、missing 或 exit，答案不完整；下一步补读结构化运行结果后重跑';
}
