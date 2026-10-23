// V03: bind authored missing facts to an exit intent. This module creates no request and performs no action.
import type { Reason, RequestKind } from '../../../contracts/generated/vocabulary.ts';
import type { LayerResult, UnknownExit } from '../../../contracts/src/validation.ts';
import type { CheckOutcome } from '../../../contracts/src/tables.ts';

export interface RecoveryContext {
  now: Date;
  runner: string;
  owner: string | null;
  admin: string | null;
}
type Rule = { missing: string; request: RequestKind; audience: 'owner' | 'runner' | 'admin' };
const RULES: Partial<Record<Reason, Rule>> = {
  no_check: { missing: '本层可执行的检查及其判定结果；下一步：包主人发布补齐检查的版本，运行者以前驱重跑', request: 'repair', audience: 'owner' },
  check_error: { missing: '可用的检查判定结果；下一步：包主人修复声明、函数或解释器后发布，运行者以前驱重跑', request: 'repair', audience: 'owner' },
  timeout: { missing: "检查在上限内完成的判定；下一步：包主人修复或调整单条检查上限并发布后重跑", request: 'repair', audience: 'owner' },
  missing_input: { missing: "运行所需的已绑定输入事实；下一步：运行者澄清并补齐后以新修订重跑", request: 'clarification', audience: 'runner' },
  declared_skip: { missing: "被跳过条目的提交产物；下一步：运行者补交该条目后自动重核", request: 'repair', audience: 'runner' },
  not_covered: { missing: "未覆盖条目的提交产物；下一步：运行者补交该条目后自动重核", request: 'repair', audience: 'runner' },
  awaiting_step: { missing: "所等步骤的完成事实；下一步：运行者完成前置修复或请求后自动重核", request: 'repair', audience: 'runner' },
  output_failed: { missing: "能回读且与重算一致的产物；下一步：运行者修复出件并重新提交后自动重核", request: 'repair', audience: 'runner' },
  repair_exhausted: { missing: "修复后符合要求的产物；下一步：运行者修复并以前驱开新修订重跑", request: 'repair', audience: 'runner' },
  budget_exhausted: { missing: "工作上限内完成的检查结果；下一步：包主人修复检查或调整单条上限并发布后重跑", request: 'repair', audience: 'owner' },
};

export function bindRecovery(layer: LayerResult, outcomes: readonly CheckOutcome[], context: RecoveryContext): LayerResult {
  if (layer.reason === undefined) return layer;
  const rule = RULES[layer.reason];
  if (rule === undefined) throw new Error(`No recovery rule for ${layer.reason}`);
  const matching = outcomes.filter(outcome => outcome.verdict === 'unknown' && outcome.reason === layer.reason);
  const gaps = matching.map(outcome => ({
    reason: layer.reason!,
    missing: outcome.missing!,
    exit: outcome.exit ?? requestExit(rule, context),
  }));
  return { ...layer, missing: gaps[0]?.missing ?? rule.missing, exit: gaps[0]?.exit ?? requestExit(rule, context), ...(gaps.length > 1 ? { gaps } : {}) };
}
function requestExit(rule: Rule, context: RecoveryContext): UnknownExit {
  const user = context[rule.audience];
  // An absent authority is a missing configuration fact, never permission to invent an account.
  return { action: 'request', request_kind: user === null ? 'clarification' : rule.request,
    audience: { user: user ?? context.runner }, due: new Date(context.now.getTime() + 72 * 60 * 60 * 1000).toISOString() };
}
