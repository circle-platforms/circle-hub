// Only a validated original contract may establish parameter types and effects. Local roles are not such evidence.
import { runtimeMethod, type RuntimeContract } from './runtime-contract.ts';
import type { RuntimeProfile } from './profile.ts';
import type { PlanSlots } from './slots.ts';
export interface AuthorityGap { document: string; pointer: string; message: string }
export function typedAuthorityGaps(contract: RuntimeContract, profile: RuntimeProfile, slots: PlanSlots): AuthorityGap[] {
  const calls = [...slots.steps.map(step => ({ object: step.object, method: step.method })), ...profile.allowed.filter(call => Object.values(call.parameters).some(role => role === 'literal_assertion'))];
  const seen = new Set<string>();
  const gaps: AuthorityGap[] = [];
  for (const call of calls) {
    const identity = JSON.stringify([call.object, call.method]);
    if (seen.has(identity)) continue;
    seen.add(identity);
    const entry = runtimeMethod(contract, call.object, call.method);
    if (entry && !entry.authority) gaps.push({ document: 'contract', pointer: entry.sourcePointer ?? '/entries', message: `合约组合 ${identity} 缺少经原合约结构核验的参数类型、地址用途与效果授权；kind/required、profile 角色和 reviewed 不提供这些事实` });
  }
  return gaps;
}
export const authorityRecovery = (gaps: readonly AuthorityGap[]): string => `缺少原合约的类型与效果事实：${gaps.map(gap => `${gap.document}${gap.pointer}：${gap.message}`).join('；')}。下一步：由当前运行的具名操作者请求合约发布管理员补全权威原合约并发布，重新绑定原件开新运行；不得编辑冻结 profile 绕过。Hub 按 missing_input 绑定补证请求、具名受众与期限，补齐后重核，当前不生成或派发工作簿。`;
