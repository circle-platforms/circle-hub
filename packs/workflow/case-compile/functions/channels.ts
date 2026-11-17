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
  const named = moved.map((row) => `${row.autoid}${titles.get(row.autoid) ? ` ${titles.get(row.autoid)}` : ''}`);
  return `原始用例 ${named.join('、')} 的命令会留下用例结束后仍未清除的配置，已在自动化用例 Excel 中排到最后。决定者程序。`;
}

export interface ConflictRow { combination: string; source: string; side_a: Array<{ autoid: string; title: string; commands: string[] }>; side_b: Array<{ autoid: string; title: string; commands: string[] }> }
export function volumeProblems(inputs: readonly VolumeCase[]): ConflictRow[] {
  const placed = inputs.map((input) => ({ id: input.fields.autoid, title: input.fields.title ?? '', profile: profileOf(input) }));
  return volumeConflicts(placed).map((conflict) => {
    const side = (ids: string[], which: 'a' | 'b') => ids.map((id) => { const row = placed.find((candidate) => candidate.id === id)!; return { autoid: id, title: row.title, commands: row.profile.sides.find((s) => s.combination === conflict.combination && s.side === which)!.commands }; });
    return { combination: conflict.combination, source: conflict.source, side_a: side(conflict.side_a, 'a'), side_b: side(conflict.side_b, 'b') };
  });
}
const caseNames = (cases: ConflictRow['side_a']): string => `${cases.slice(0, 5).map((row) => `${row.autoid}${row.title ? ` ${row.title}` : ''} 的命令 ${row.commands.slice(0, 3).join('；')}`).join('、')}${cases.length > 5 ? ` 等 ${cases.length} 个用例` : ''}`;
export function conflictText(row: ConflictRow): string {
  const same = row.side_a.length === 1 && row.side_b.length === 1 && row.side_a[0].autoid === row.side_b[0].autoid;
  return `${same ? '同一条自动化用例中' : '同一份自动化用例 Excel 中'}有产品文档声明不能一起使用的命令，一组来自原始用例 ${caseNames(row.side_a)}，另一组来自原始用例 ${caseNames(row.side_b)}`;
}
export function planProblems(profile: CaseProfile): Array<{ combination: string; source: string; a: string[]; b: string[] }> {
  return volumeConflicts([{ id: '', profile }]).map((conflict) => {
    const side = (which: 'a' | 'b') => profile.sides.find((s) => s.combination === conflict.combination && s.side === which)!.commands;
    return { combination: conflict.combination, source: conflict.source, a: side('a'), b: side('b') };
  });
}
export function planConflictText(row: ReturnType<typeof planProblems>[number]): string {
  return `自动化用例中有产品文档声明不能一起使用的命令，一组是 ${row.a.slice(0, 3).join('；')}，另一组是 ${row.b.slice(0, 3).join('；')}`;
}
export const PLAN_CONFLICT_FIX = '下一步由编写模型去掉自行添加的那组命令；两组命令都是原始用例要求时，请使用者决定是否修改原始用例。其余原始用例可单独继续脚本编写';
export const CONFLICT_FIX = '下一步把不能一起使用的命令分别放在两份自动化用例 Excel 中做上机验证；原始用例要求一起使用时，请使用者决定是否修改原始用例';
