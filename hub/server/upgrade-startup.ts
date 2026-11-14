// Compatibility and preservation are separate admission facts; neither is inferred from a table or a provider.
import type { RecordsSchemaCompatibility } from '../records/api.ts';

export interface UpgradeStartupObservation {
  compatibility: RecordsSchemaCompatibility;
  environmentAssignmentCompleted: boolean | null;
}
export interface UpgradeStartupDecision {
  canServe: boolean;
  enforceEnvironmentAssignments: boolean;
  problems: string[];
  nextActions: string[];
}
export function environmentUpgradeNextActions(): string[] {
  return [
    '以现有操作令牌对应的启用管理员执行 circle-hub upgrade preview --owner-role <数据库拥有者> --json，保存预检JSON',
    '预检可应用后执行 circle-hub upgrade apply --preview <预检JSON文件> --expected-snapshot <该JSON的sha256> --owner-role <数据库拥有者>，然后重新启动本版本',
  ];
}
export function upgradeStartupDecision(observation: UpgradeStartupObservation): UpgradeStartupDecision {
  const result: UpgradeStartupDecision = { canServe: false, enforceEnvironmentAssignments: false, problems: [], nextActions: [] };
  if (observation.compatibility.status !== 'compatible' || observation.compatibility.compatible !== true) {
    result.problems.push('当前代码与迁移兼容声明尚未核对通过；保留现库');
    result.nextActions.push('检查运行角色读取权限并使用兼容发布；兼容声明不能豁免已知迁移的名称和摘要');
  }
  if (observation.environmentAssignmentCompleted !== true) {
    result.problems.push(observation.environmentAssignmentCompleted === false ? '运行环境保权升级尚未完成；未启用新守卫、未启动业务' : '运行环境保权完成事实不可读取；不能当作已完成');
    result.nextActions.push(...environmentUpgradeNextActions());
  }
  if (!result.problems.length) { result.canServe = true; result.enforceEnvironmentAssignments = true; }
  return result;
}
