import { PACK_KIND_UI, type PackKind } from '../../contracts/generated/vocabulary.ts';

export function packObjectWord(kind: PackKind | null | undefined): string {
  if (kind === 'workflow') return '工作流';
  if (kind === 'skill') return '技能';
  if (kind === 'product') return PACK_KIND_UI.product;
  if (kind === 'system') return PACK_KIND_UI.system;
  return '工作流或技能';
}

export function unassignedPackFact(name: string, kind?: PackKind | null): string {
  return `当前账户未获授权使用${packObjectWord(kind)}「${name}」`;
}

export function unassignedPackNext(kind?: PackKind | null): string {
  const word = packObjectWord(kind);
  const assign =
    word === '工作流或技能'
      ? '请联系管理员为该账户或所在团队分配此工作流或技能'
      : `请联系管理员为该账户或所在团队分配此${word}`;
  return `${assign}。当前账户可用的工作流和技能用 list_task_packs 查看`;
}

export function unassignedPackRefusal(name: string, kind?: PackKind | null): string {
  return `无权限：${unassignedPackFact(name, kind)}。${unassignedPackNext(kind)}。`;
}

export function absentPackFact(name: string): string {
  return `Hub 里没有名为「${name}」的工作流或技能`;
}

export function absentPackNext(): string {
  return '请核对名称';
}

export function absentPackRefusal(name: string): string {
  return `不存在：${absentPackFact(name)}。${absentPackNext()}。`;
}

const ZERO_USABLE_NEXT = '请联系管理员把该账户加入团队或分配工作流。';

export function packListHead(usable: number, unassigned?: number, assigned: number = usable): string {
  let head = `当前账户可用的工作流和技能共 ${usable} 个。`;
  if (typeof unassigned === 'number' && unassigned > 0) {
    head = `${head}另有 ${unassigned} 个未分配给当前账户，名称不列出。`;
  }
  if (assigned === 0) head = `${head}${ZERO_USABLE_NEXT}`;
  return head;
}

export function packListHeadForMember(usable: number, unassigned: number, assigned: number = usable): string {
  let head = `该成员可用的工作流和技能共 ${usable} 个。`;
  if (unassigned > 0) {
    head = `${head}另有 ${unassigned} 个未分配给该成员，名称不列出。`;
  }
  if (assigned === 0) head = `${head}请联系管理员把该账户加入团队或分配工作流。`;
  return head;
}
