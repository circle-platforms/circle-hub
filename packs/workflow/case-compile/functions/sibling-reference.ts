import { isRecord } from './text.ts';

const WORD = /^[A-Za-z][A-Za-z0-9_-]*$/;

export function commandWords(line: string): string[] {
  const words: string[] = [];
  for (const token of line.trim().split(/\s+/)) { if (!WORD.test(token)) break; words.push(token); }
  return words;
}

function shapesOf(line: string): string[] {
  const words = commandWords(line);
  return words.length >= 2 ? [words.slice(0, 3).join(' ')] : [];
}

export function neededShapes(briefText: string, record: unknown): Set<string> {
  const lines: string[] = [];
  const section = /^## 重组记录点到的命令[^\n]*\n([\s\S]*?)(?=^## )/m.exec(briefText)?.[1] ?? '';
  for (const heading of section.matchAll(/^### (.+)$/gm)) lines.push(heading[1]);
  const states = isRecord(record) && isRecord(record.record) && isRecord(record.record.sources) && Array.isArray(record.record.sources.states) ? record.record.sources.states : [];
  for (const state of states) if (isRecord(state) && Array.isArray(state.prerequisites)) for (const item of state.prerequisites) if (typeof item === 'string') lines.push(item);
  return new Set(lines.flatMap(shapesOf));
}

export function planCommandLines(plan: unknown): string[] {
  const claim = isRecord(plan) && isRecord(plan.slots) ? (Array.isArray(plan.slots.plan) ? plan.slots.plan[0] : plan.slots.plan) : null;
  const data = isRecord(claim) && isRecord(claim.data) ? claim.data : {};
  const calls = [...(Array.isArray(data.steps) ? data.steps : []), ...(Array.isArray(data.blocks) ? data.blocks.map((block) => (isRecord(block) ? block.call : null)) : [])];
  return calls.flatMap((call) => (isRecord(call) && Array.isArray(call.args) ? call.args.filter((value): value is string => typeof value === 'string') : []));
}

export interface SiblingPlan { path: string; lines: readonly string[]; devicePassed: boolean }

export function chooseSiblings(needed: ReadonlySet<string>, siblings: readonly SiblingPlan[], limit = 2): Array<{ path: string; shared: number; devicePassed: boolean }> {
  const ranked = siblings.map((sibling) => {
    const shapes = new Set(sibling.lines.flatMap(shapesOf));
    return { path: sibling.path, shared: [...needed].filter((shape) => shapes.has(shape)).length, devicePassed: sibling.devicePassed };
  }).filter((row) => row.shared >= 2);
  ranked.sort((a, b) => Number(b.devicePassed) - Number(a.devicePassed) || b.shared - a.shared || (a.path < b.path ? -1 : 1));
  return ranked.slice(0, limit);
}

export function siblingNote(chosen: ReadonlyArray<{ path: string; shared: number; devicePassed: boolean }>): string | undefined {
  if (chosen.length === 0) return undefined;
  const listed = chosen.map((row) => `${row.path}（相同命令 ${row.shared} 种${row.devicePassed ? '，已上机通过' : ''}）`).join('、');
  return `供参考：同一次编译里已过全部关口、与本条用到相同命令的用例计划有 ${listed}。各条计划都带自己的完整配置，设备在每条用例开始前会被清理`;
}
