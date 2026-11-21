// Which plans of the same compilation a writer may look at before writing its own. Each case is written by its own subagent,
// side by side with the others, and none was ever shown what another had written: in two real runs (33 and 44 writer sessions,
// Langfuse) three sessions opened another case's plan at all, and only to see how a field is filled. Yet the seventeen plans of
// one run held 129 device configuration commands of 58 shapes, and for seven cases every shape already stood in another case's
// plan. One case then forgot the feature's switch that the other sixteen had written, and timed out for three device rounds.
// The runner clears the device before each case, so a case cannot rely on what another configured: it can only write the same
// commands itself. What is offered is therefore a plan that already passed this run's own gates (and, after a device round, one
// the device judged right), chosen by the commands it shares with what this case's recomposition record names. It is disclosed,
// nothing more: the note names the plans and states two facts about them, and neither the lead nor a writer is told to use them
// or how (owner, 2026-11-19: disclosure and hints only, no "must" and no "must not"). Nothing here knows a product: commands are
// compared by their leading words.
import { isRecord } from './text.ts';

const WORD = /^[A-Za-z][A-Za-z0-9_-]*$/;

/** The leading command words of a line, up to the first token that is a value. */
export function commandWords(line: string): string[] {
  const words: string[] = [];
  for (const token of line.trim().split(/\s+/)) { if (!WORD.test(token)) break; words.push(token); }
  return words;
}

/** The shape of a command line: its first two or three leading words (one word says too little; a fourth is usually a value's keyword). */
function shapesOf(line: string): string[] {
  const words = commandWords(line);
  return words.length >= 2 ? [words.slice(0, 3).join(' ')] : [];
}

/** The command shapes a case will need, from its authoring brief and its recomposition record (both as the download wrote them). */
export function neededShapes(briefText: string, record: unknown): Set<string> {
  const lines: string[] = [];
  // The brief lists the commands the record names as "### <command words>" under its commands section.
  const section = /^## 重组记录点到的命令[^\n]*\n([\s\S]*?)(?=^## )/m.exec(briefText)?.[1] ?? '';
  for (const heading of section.matchAll(/^### (.+)$/gm)) lines.push(heading[1]);
  // The record's own prerequisites are command lines where the recomposer could write them, prose where it could not.
  const states = isRecord(record) && isRecord(record.record) && isRecord(record.record.sources) && Array.isArray(record.record.sources.states) ? record.record.sources.states : [];
  for (const state of states) if (isRecord(state) && Array.isArray(state.prerequisites)) for (const item of state.prerequisites) if (typeof item === 'string') lines.push(item);
  return new Set(lines.flatMap(shapesOf));
}

/** Every command text of a plan file, flat steps or blocks. */
export function planCommandLines(plan: unknown): string[] {
  const claim = isRecord(plan) && isRecord(plan.slots) ? (Array.isArray(plan.slots.plan) ? plan.slots.plan[0] : plan.slots.plan) : null;
  const data = isRecord(claim) && isRecord(claim.data) ? claim.data : {};
  const calls = [...(Array.isArray(data.steps) ? data.steps : []), ...(Array.isArray(data.blocks) ? data.blocks.map((block) => (isRecord(block) ? block.call : null)) : [])];
  return calls.flatMap((call) => (isRecord(call) && Array.isArray(call.args) ? call.args.filter((value): value is string => typeof value === 'string') : []));
}

export interface SiblingPlan { path: string; lines: readonly string[]; devicePassed: boolean }

/** At most `limit` plans that share at least two command shapes with what the case needs: the device-judged first, then the most shared. */
export function chooseSiblings(needed: ReadonlySet<string>, siblings: readonly SiblingPlan[], limit = 2): Array<{ path: string; shared: number; devicePassed: boolean }> {
  const ranked = siblings.map((sibling) => {
    const shapes = new Set(sibling.lines.flatMap(shapesOf));
    return { path: sibling.path, shared: [...needed].filter((shape) => shapes.has(shape)).length, devicePassed: sibling.devicePassed };
  }).filter((row) => row.shared >= 2);
  ranked.sort((a, b) => Number(b.devicePassed) - Number(a.devicePassed) || b.shared - a.shared || (a.path < b.path ? -1 : 1));
  return ranked.slice(0, limit);
}

/** The sentence the writer's task file carries, or undefined when no plan of the run is worth naming. */
export function siblingNote(chosen: ReadonlyArray<{ path: string; shared: number; devicePassed: boolean }>): string | undefined {
  if (chosen.length === 0) return undefined;
  const listed = chosen.map((row) => `${row.path}（相同命令 ${row.shared} 种${row.devicePassed ? '，已上机通过' : ''}）`).join('、');
  // Disclosure only (owner, 2026-11-19): the note says what exists and what is true of it. It asks for nothing and forbids nothing;
  // whether and how a writer uses these plans is the writer's own judgment.
  return `供参考：同一次编译里已过全部关口、与本条用到相同命令的用例计划有 ${listed}。各条计划都带自己的完整配置，设备在每条用例开始前会被清理`;
}
