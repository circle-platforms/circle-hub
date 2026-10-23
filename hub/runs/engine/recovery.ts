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
const RULES: Record<Reason, Rule> = {
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
  integrity_unproven: { missing: "完整的来源目录及其证据；下一步：重新生产跳过的来源后自动重评", request: 'repair', audience: 'runner' },
};

export function bindRecovery(layer: LayerResult, outcomes: readonly CheckOutcome[], context: RecoveryContext): LayerResult {
  if (layer.reason === undefined) return layer;
  const matching = outcomes.filter(outcome => outcome.verdict === 'unknown');
  const gaps = matching.map(outcome => {
    if (!outcome.reason || !outcome.missing) throw new Error('An unknown producer must name its reason and missing fact');
    return { reason: outcome.reason, missing: outcome.missing, exit: outcome.exit ?? outcomeExit(outcome, context) };
  });
  if (!gaps.some(gap => gap.reason === layer.reason)) {
    gaps.unshift({ reason: layer.reason, missing: RULES[layer.reason].missing, exit: requestExit(RULES[layer.reason], context) });
  }
  const primary = gaps.find(gap => gap.reason === layer.reason)!;
  return { ...layer, missing: primary.missing, exit: primary.exit, ...(gaps.length > 1 ? { gaps } : {}) };
}

function requestExit(rule: Rule, context: RecoveryContext): UnknownExit {
  const user = context[rule.audience];
  // An absent authority is a missing configuration fact, never permission to invent an account.
  return { action: 'request', request_kind: user === null ? 'clarification' : rule.request,
    audience: { user: user ?? context.runner }, due: new Date(context.now.getTime() + 72 * 60 * 60 * 1000).toISOString() };
}

function outcomeExit(outcome: CheckOutcome, context: RecoveryContext): UnknownExit {
  const due = new Date(context.now.getTime() + 72 * 60 * 60 * 1000).toISOString();
  if (outcome.data?.sandbox === 'SANDBOX_UNAVAILABLE') return { action: 'reevaluate', audience: { hub: true }, due };
  if (outcome.reason === 'missing_input' && outcome.data?.why === 'unavailable') return { action: 'reread', audience: { hub: true }, due };
  const withheld = Array.isArray(outcome.data?.unread_sources) && outcome.data.unread_sources.some(
    row => row !== null && typeof row === 'object' && row.reason === 'credential_unreadable');
  if (outcome.reason === 'awaiting_step' && withheld || outcome.reason === 'integrity_unproven' && outcome.data?.why === 'integrity_unproven') {
    return requestExit({ ...RULES[outcome.reason!], request: 'disposition', audience: 'admin' }, context);
  }
  return requestExit(RULES[outcome.reason!], context);
}
