// Match product declarations against parsed command identities, never command prose.
import { planCommands } from './plan-commands.ts';
import { readSlots, type PlanSlots } from './slots.ts';
import { isRecord } from './text.ts';
import { caseProfile, readCommandPolicy, volumeConflicts, volumeOrder as lastCases, type CaseProfile, type CommandPolicy } from './generated/skills/command-tools/command-check/command-policy.ts';
import type { RuntimeContract } from './runtime-contract.ts';
import type { RuntimeProfile } from './profile.ts';

export interface VolumeCase { slots: unknown; fields: { autoid: string; title?: string; command_catalog?: unknown }; contract: RuntimeContract; profile: RuntimeProfile }
export function policyIn(catalog: unknown): CommandPolicy | null { return readCommandPolicy(isRecord(catalog) ? catalog.policy : undefined); }
const declares = (policy: CommandPolicy | null): policy is CommandPolicy => !!policy && ((policy.persistence_channels?.length ?? 0) > 0 || (policy.forbidden_combinations?.length ?? 0) > 0);
const nowhere = (): CaseProfile => ({ channels: [], sides: [] });
export function lineProfile(catalog: unknown, byLine: ReadonlyMap<string, { path: string; parameters: ReadonlyArray<{ position: number }> }>): CaseProfile {
  return caseProfile(policyIn(catalog), [...byLine].map(([line, identity]) => ({ path: identity.path, parameters: identity.parameters, line })));
}
export function planProfile(contract: RuntimeContract, profile: RuntimeProfile, slots: PlanSlots, catalog: unknown): CaseProfile {
  const policy = policyIn(catalog);
  if (!declares(policy)) return nowhere();
  return caseProfile(policy, [...planCommands(contract, profile, slots, catalog).byLine].map(([line, identity]) => ({ ...identity, line })));
}
function profileOf(input: VolumeCase): CaseProfile {
  const read = readSlots(input.slots);
  return read.ok ? planProfile(input.contract, input.profile, read.slots, input.fields.command_catalog) : nowhere();
}

export interface MovedCase { autoid: string; channels: CaseProfile['channels'] }
export function volumeOrder<T extends VolumeCase>(inputs: readonly T[]): { ordered: T[]; moved: MovedCase[] } {
  const { ordered, moved } = lastCases(inputs.map((input) => ({ input, profile: profileOf(input) })));
  return { ordered: ordered.map((row) => row.input), moved: moved.map((row) => ({ autoid: row.input.fields.autoid, channels: row.profile.channels })) };
}
export function movedText(moved: readonly MovedCase[], titles: ReadonlyMap<string, string> = new Map()): string {
  if (!moved.length) return '';
  const named = moved.map((row) => `${row.autoid}${titles.get(row.autoid) ? `（${titles.get(row.autoid)}）` : ''}`);
  const channels = [...new Set(moved.flatMap((row) => row.channels.map((channel) => channel.id)))];
  return `有 ${moved.length} 个用例的命令按产品声明会留下每个用例结束后的清理清不掉的状态（${channels.join('、')}），排在卷尾执行：${named.join('、')}`;
}

export interface ConflictRow { combination: string; source: string; side_a: Array<{ autoid: string; title: string; commands: string[] }>; side_b: Array<{ autoid: string; title: string; commands: string[] }> }
export function volumeProblems(inputs: readonly VolumeCase[]): ConflictRow[] {
  const placed = inputs.map((input) => ({ id: input.fields.autoid, title: input.fields.title ?? '', profile: profileOf(input) }));
  return volumeConflicts(placed).map((conflict) => {
    const side = (ids: string[], which: 'a' | 'b') => ids.map((id) => { const row = placed.find((candidate) => candidate.id === id)!; return { autoid: id, title: row.title, commands: row.profile.sides.find((s) => s.combination === conflict.combination && s.side === which)!.commands }; });
    return { combination: conflict.combination, source: conflict.source, side_a: side(conflict.side_a, 'a'), side_b: side(conflict.side_b, 'b') };
  });
}
const caseNames = (cases: ConflictRow['side_a']): string => `${cases.slice(0, 5).map((row) => `${row.autoid}${row.title ? `（${row.title}）` : ''}的命令 ${row.commands.slice(0, 3).join('；')}`).join('、')}${cases.length > 5 ? ` 等 ${cases.length} 个用例` : ''}`;
export function conflictText(row: ConflictRow): string {
  const same = row.side_a.length === 1 && row.side_b.length === 1 && row.side_a[0].autoid === row.side_b[0].autoid;
  return `${same ? '同一个用例里' : '同一卷里'}有产品声明互斥的两侧命令（组合 ${row.combination}）：一侧是用例 ${caseNames(row.side_a)}，另一侧是用例 ${caseNames(row.side_b)}。产品声明的依据：${row.source}`;
}
export function planProblems(profile: CaseProfile): Array<{ combination: string; source: string; a: string[]; b: string[] }> {
  return volumeConflicts([{ id: '', profile }]).map((conflict) => {
    const side = (which: 'a' | 'b') => profile.sides.find((s) => s.combination === conflict.combination && s.side === which)!.commands;
    return { combination: conflict.combination, source: conflict.source, a: side('a'), b: side('b') };
  });
}
export function planConflictText(row: ReturnType<typeof planProblems>[number]): string {
  return `这个用例的计划里有产品声明互斥的两侧命令（组合 ${row.combination}）：一侧是命令 ${row.a.slice(0, 3).join('；')}，另一侧是命令 ${row.b.slice(0, 3).join('；')}。产品声明的依据：${row.source}`;
}
export const PLAN_CONFLICT_FIX = '去掉计划自己加的那一侧命令；两侧都是作者写的命令时，计划不能删（可以改参数，不可以删命令），这是作者步骤与产品文档冲突，按“问用户”处理，不自己改；要先编其余用例时，把这个用例写进 parameters.exclude 后重新开计划运行';
export const CONFLICT_FIX = '互斥的两侧不放同一卷：把其中一侧的用例写进 parameters.exclude 后重新开计划运行，另开运行用 autoid 单独编；作者要测的正是这个组合时，是作者步骤与产品文档冲突，按“问用户”处理，不自己改';
