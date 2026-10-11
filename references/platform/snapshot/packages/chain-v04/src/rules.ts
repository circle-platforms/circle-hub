import type { UseCase } from "./parse.js";

export type Severity = "high" | "medium" | "low";

export interface FindingDraft {
  dimension: string;
  type: string;
  severity: Severity;
  location: string;
  rationale: string;
}

/**
 * The declared review dimensions of the slice. Each rule is a
 * deterministic, inspectable judgement (the scripted review method of
 * ADR 0013 for this chain): it fires only on stated textual conditions,
 * and its limits are part of the disclosure — richer semantic review
 * belongs to a model-backed method behind the same report shape.
 */
export const REVIEW_METHOD_ID = "rule-based-usecase-review";
export const REVIEW_METHOD_VERSION = "1.0.0";

const ACCESS_RE = /(?:查看|查询|获取)[^。；]{0,16}(?:详情|订单|用户信息|账户)/;
const OWNERSHIP_GUARD_RE = /归属|本人|当前(?:登录)?用户|已登录|登录后|权限校验|身份校验/g;

/**
 * A guard counts only when it is actually asserted. Sample texts may
 * *mention* a guard in a negated annotation ("未提登录与归属校验"),
 * which is the absence of a guard, not its presence: an occurrence
 * preceded (within 6 chars) by a negation character does not count.
 */
function hasAssertedGuard(text: string): boolean {
  for (const m of text.matchAll(OWNERSHIP_GUARD_RE)) {
    const start = m.index ?? 0;
    const lookback = text.slice(Math.max(0, start - 6), start);
    if (!/[未无没不]/.test(lookback)) return true;
  }
  return false;
}
const CRITICAL_ACTION_RE = /口令|密码|凭据|提交|修改|重置|保存|删除|支付/;
const EXCEPTION_RE = /异常流程|异常分支/;
const EXCEPTION_NEGATED_RE = /无异常|未定义异常|没有异常|无异常流程/;
const CREDENTIAL_RE = /口令|密码|凭据/;
const PLAINTEXT_RE = /原文|明文/;
const LOG_RE = /日志|记录/;

export function reviewCaseDimensions(kase: UseCase): FindingDraft[] {
  const findings: FindingDraft[] = [];
  const text = kase.text;

  // Dimension: authorization. Returning a specific resource's detail by
  // identifier without any ownership/login guard in the text.
  if (ACCESS_RE.test(text) && !hasAssertedGuard(text)) {
    findings.push({
      dimension: "authorization",
      type: "越权未校验",
      severity: "high",
      location: `${kase.id} 步骤 2`,
      rationale:
        "用例按标识返回资源详情，全文未见登录、归属或权限校验的任何表述。",
    });
  }

  // Dimension: exception coverage for credential / state-changing cases.
  const hasException =
    EXCEPTION_RE.test(text) && !EXCEPTION_NEGATED_RE.test(text);
  if (CRITICAL_ACTION_RE.test(text) && !hasException) {
    findings.push({
      dimension: "exception-coverage",
      type: "异常分支缺失",
      severity: "medium",
      location: `${kase.id} 异常流程`,
      rationale:
        "用例涉及凭据或状态变更操作，但未定义异常/失败分支行为。",
    });
  }

  // Dimension: credential handling. Plaintext credentials into logs.
  if (CREDENTIAL_RE.test(text) && PLAINTEXT_RE.test(text) && LOG_RE.test(text)) {
    findings.push({
      dimension: "credential-handling",
      type: "凭据明文记录",
      severity: "medium",
      location: `${kase.id} 步骤 2`,
      rationale: "用例将凭据原文/明文写入日志或记录。",
    });
  }

  // Dimension: internal consistency. The same session quantity stated
  // with two different values inside one case.
  const sessionValues = new Set(
    [...text.matchAll(/会话[^。；，,、]{0,10}?(\d+)\s*分钟/g)].map((m) => m[1]),
  );
  if (sessionValues.size > 1) {
    findings.push({
      dimension: "internal-consistency",
      type: "内部矛盾",
      severity: "low",
      location: `${kase.id} 前置/后置`,
      rationale: `同一用例内会话时长出现多个数值：${[...sessionValues].join(" / ")} 分钟。`,
    });
  }

  return findings;
}
