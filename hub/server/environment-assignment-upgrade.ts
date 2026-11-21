// A frozen cutover is input, never a live startup query. The eventual writer owns its transaction and completion receipt.
import type { EnvironmentUpgradeSnapshot, EnvironmentUpgradePlan } from '../records/api.ts';
export type { EnvironmentUpgradeSnapshot, EnvironmentUpgradePlan, EnvironmentUpgradeGrant } from '../records/api.ts';

/** Only a trusted completion receipt for this same immutable cutover may suppress the plan. No records are written here. */
export function planEnvironmentAssignmentUpgrade(snapshot: EnvironmentUpgradeSnapshot, completedBoundary?: string): EnvironmentUpgradePlan {
  if (completedBoundary !== undefined && completedBoundary !== snapshot.boundary) throw new Error('保权完成事实与升级切点不一致');
  const plan: EnvironmentUpgradePlan = { boundary: snapshot.boundary, alreadyCompleted: completedBoundary !== undefined, canApply: false, grants: [], missing: [] };
  if (plan.alreadyCompleted) return plan;
  const time = (value: string): number => {
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) throw new Error('保权快照时间无效');
    return parsed;
  };
  const at = time(snapshot.at);
  const executors = snapshot.executors.filter(row => time(row.registeredAt) <= at);
  const existingKeys = new Set(executors.flatMap(row => [...row.keys]));
  const activeHoldings = snapshot.holdings.filter(row => !row.released && (row.expires_at === null || time(row.expires_at) > at));
  for (const row of activeHoldings) if (!snapshot.members.some(member => member.id === row.user && time(member.created_at) <= at)) {
    plan.missing.push({ user: row.user, key: row.key, fact: '有效预订缺少切点账户事实，不能自动生成分配' });
  }
  for (const member of [...snapshot.members].sort((a, b) => a.id.localeCompare(b.id))) {
    if (time(member.created_at) > at) continue;
    const holdings = activeHoldings.filter(row => row.user === member.id);
    if (member.disabled || member.deleted_at) {
      for (const row of holdings) plan.missing.push({ user: member.id, key: row.key, fact: '预订持有人已停用或删除，不能自动恢复使用权' });
      continue;
    }
    const workflows = snapshot.workflows.filter(row => row.kind === 'workflow' && (row.space === undefined || row.space === 'team') && row.available && time(row.publishedAt) <= at
      && member.packs.includes(row.id) && row.declaration.leases !== undefined && row.declaration.context?.includes('leases'));
    const heldByExecutor = new Map<string, typeof holdings>();
    for (const holding of holdings) {
      if (!existingKeys.has(holding.key)) {
        plan.missing.push({ user: member.id, key: holding.key, fact: '持有的预订键没有对应切点前执行器，无法生成明确分配' });
        continue;
      }
      const bound = [...new Set((snapshot.holdingBindings ?? []).filter(binding => binding.user === member.id && binding.run === holding.run
        && executors.some(executor => executor.id === binding.executor && executor.keys.includes(holding.key))).map(binding => binding.executor))];
      if (bound.length !== 1) {
        plan.missing.push({ user: member.id, key: holding.key, fact: '有效预订缺少唯一可核验的执行器归属，不能按资源键或旧分配推断' });
        continue;
      }
      const rows = heldByExecutor.get(bound[0]) ?? [];
      rows.push(holding); heldByExecutor.set(bound[0], rows);
    }
    for (const executor of [...executors].sort((a, b) => a.id.localeCompare(b.id))) {
      const keys = [...new Set(executor.keys)].sort();
      const executorHoldings = heldByExecutor.get(executor.id) ?? [];
      const heldKeys = new Set(executorHoldings.map(row => row.key));
      const covered = keys.filter(key => heldKeys.has(key) || workflows.some(row => key.startsWith(row.declaration.leases!.prefix)));
      if (!covered.length) continue;
      if (snapshot.effectiveAssignments.some(row => row.user === member.id && row.executor === executor.id)) continue;
      if (snapshot.revokedAssignments.some(row => row.user === member.id && row.executor === executor.id)) {
        plan.missing.push({ user: member.id, executor: executor.id, fact: '已有明确撤回决定，自动保权不能覆盖管理员决定' });
        continue;
      }
      if (covered.length !== keys.length) {
        plan.missing.push({ user: member.id, executor: executor.id, fact: '旧权限只覆盖执行器部分资源键，整体分配会扩大范围' });
        continue;
      }
      plan.grants.push({
        user: member.id, executor: executor.id, keys,
        workflows: [...new Set(workflows.filter(row => keys.some(key => key.startsWith(row.declaration.leases!.prefix))).map(row => row.digest))].sort(),
        holdingRuns: [...new Set(executorHoldings.map(row => row.run))].sort(),
        note: '升级自动保权：依据固定切点的工作流分配与有效预订生成，非管理员手工授予',
      });
    }
  }
  plan.canApply = plan.missing.length === 0;
  return plan;
}
