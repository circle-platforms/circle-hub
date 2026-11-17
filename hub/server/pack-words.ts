// Pack object words for call-error and list prose (Boss 11-14 afternoon).
// workflow→工作流, skill→技能; other kinds use PACK_KIND_UI; unknown→工作流或技能.
import { PACK_KIND_UI, type PackKind } from '../../contracts/generated/vocabulary.ts';

/** Reader-facing object word for a pack kind. */
export function packObjectWord(kind: PackKind | null | undefined): string {
  if (kind === 'workflow') return '工作流';
  if (kind === 'skill') return '技能';
  if (kind === 'product') return PACK_KIND_UI.product;
  if (kind === 'system') return PACK_KIND_UI.system;
  return '工作流或技能';
}

/** Fact: pack exists but is not assigned to the caller. */
export function unassignedPackFact(name: string, kind?: PackKind | null): string {
  return `当前账户未获授权使用${packObjectWord(kind)}「${name}」`;
}

/** Next step when a pack is unassigned (member wording; Boss 14:12 — two sentences). */
export function unassignedPackNext(kind?: PackKind | null): string {
  const word = packObjectWord(kind);
  const assign =
    word === '工作流或技能'
      ? '请联系管理员为该账户或所在团队分配此工作流或技能'
      : `请联系管理员为该账户或所在团队分配此${word}`;
  return `${assign}。当前账户可用的工作流和技能用 list_task_packs 查看`;
}

/** Full unassigned refusal line (MCP content / local-tools body share this). */
export function unassignedPackRefusal(name: string, kind?: PackKind | null): string {
  return `无权限：${unassignedPackFact(name, kind)}。${unassignedPackNext(kind)}。`;
}

/** Fact: Hub has no pack with this name (kind unknown). */
export function absentPackFact(name: string): string {
  return `Hub 里没有名为「${name}」的工作流或技能`;
}

/** Next step when the pack name is absent. */
export function absentPackNext(): string {
  return '请核对名称';
}

/** Full absent refusal line. */
export function absentPackRefusal(name: string): string {
  return `不存在：${absentPackFact(name)}。${absentPackNext()}。`;
}

const ZERO_USABLE_NEXT = '请联系管理员把该账户加入团队或分配工作流。';

/** List header: usable count; optional unassigned remainder (names withheld). */
export function packListHead(usable: number, unassigned?: number): string {
  let head = `当前账户可用的工作流和技能共 ${usable} 个。`;
  if (typeof unassigned === 'number' && unassigned > 0) {
    head = `${head}另有 ${unassigned} 个未分配给当前账户，名称不列出。`;
  }
  if (usable === 0) head = `${head}${ZERO_USABLE_NEXT}`;
  return head;
}

/** Admin list head when disclosing another member's usable set. */
export function packListHeadForMember(usable: number, unassigned: number): string {
  let head = `该成员可用的工作流和技能共 ${usable} 个。`;
  if (unassigned > 0) {
    head = `${head}另有 ${unassigned} 个未分配给该成员，名称不列出。`;
  }
  if (usable === 0) head = `${head}请联系管理员把该账户加入团队或分配工作流。`;
  return head;
}

/**
 * Same fact as the console environment-assignment preview banner (connections / team / me).
 * Shown in list_task_packs prose while enforceEnvironmentAssignments is off.
 */
export const ENVIRONMENT_ASSIGNMENT_PREVIEW =
  '测试环境的分配还没有启用，现在谁能预订仍按工作流的分配和预订规则判断。下面列出的测试环境分配只是预览，不代表现在的许可。';
