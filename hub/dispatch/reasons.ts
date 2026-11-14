import { sha256Hex, type RecordsKit } from '../records/api.ts';
import type { DispatchAttemptFacts, DispatchJobFacts, ScopedDispatchFacts } from '../../contracts/api.ts';
import type { JobStatus } from './service.ts';
import type { RunJob } from './read-runs.ts';

export interface DispatchMissingFact { fact: string; next_action: string }
export type DispatchDiagnostics = ScopedDispatchFacts;
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const clip = (value: string): string => value.slice(0, 800);

/** Read only this job's integrity-checked projected report, never an administrative journal body. */
export async function reportMissingFacts(records: Pick<RecordsKit, 'objects'>, job: RunJob, admin: boolean): Promise<{ no_verdict?: boolean; missing_facts: DispatchMissingFact[] }> {
  const reference = job.status.job_facts.result;
  if (!reference || !/^src:[0-9a-f]{64}$/.test(reference)) return { missing_facts: [] };
  try {
    const bytes = await records.objects.get(reference.slice(4));
    if (!bytes || sha256Hex(bytes) !== reference.slice(4)) return { missing_facts: [] };
    const report = object(JSON.parse(Buffer.from(bytes).toString('utf8')));
    if (!report || report.job !== job.job || report.sha256 !== job.sha256 || !Array.isArray(report.rows)) return { missing_facts: [] };
    const rows = report.rows.map(object);
    if (rows.length !== job.items.length || new Set(rows.map(row => row?.item)).size !== job.items.length || rows.some(row => !row || !job.items.includes(String(row.item)) || typeof row.dynamic_terminal !== 'string')) return { missing_facts: [] };
    const unresolved = rows.filter(row => row!.dynamic_terminal === 'no_verdict');
    const facts: DispatchMissingFact[] = [];
    for (const row of unresolved) {
      if (admin && typeof row!.missing_fact === 'string' && typeof row!.next_action === 'string') {
        facts.push({ fact: clip(row!.missing_fact), next_action: clip(row!.next_action) });
      } else {
        // These are existing projected completeness facts, not classifications of the diagnostic prose.
        const missing = Array.isArray(row!.missing_facts) ? row!.missing_facts : [];
        const fact = missing.includes('owned') ? '这次设备结果缺少可采用的归属事实' : missing.includes('report') || missing.includes('complete') ? '这次设备结果的完整报告尚未取得' : '这次设备结果的完整性前提尚未齐全';
        facts.push({ fact, next_action: '读取本次答复中的结果引用查看缺失前提；需要管理员处理的，联系管理员核对；不要重新发送作业' });
      }
    }
    return { no_verdict: unresolved.length > 0, missing_facts: facts.slice(0, 16) };
  } catch { return { missing_facts: [] }; }
}

export function releaseMissingFacts(checks: NonNullable<JobStatus['job_facts']['admin_release']>): DispatchMissingFact[] {
  return checks.filter(check=>check.satisfied!==true).map(check=>check.condition==='proof.executor_identity'
    ? {fact:`核对项目“${check.label}”：本次核验的目标或清单摘要与当前执行器声明不一致`,next_action:'联系管理员核对当前环境的清单绑定，再使用一致的清单重新核验'}
    : {fact:check.satisfied===null?`核对项目“${check.label}”缺少前置事实，尚未核对`:`核对项目“${check.label}”尚未满足`,next_action:'核对本次预订和核验结果；联系管理员查看具体放行条件后重新核验'}).slice(0,16);
}

/** A declared JSON field and operator name are public; expected values and raw response bytes are not. */
export function readConditionFact(condition: {pointer:string;operator:string}): DispatchMissingFact {
  const operation = condition.operator==='at_least'?'至少数量':condition.operator==='equals'?'相等':condition.operator==='sha256'?'摘要一致':'声明';
  return {fact:`缺少通过环境只读核对项目 ${condition.pointer}（${operation}）的有效前提`,next_action:'请管理员核对该项目的声明和受限原件，补齐这项条件后重新核验'};
}

export function statusDiagnostics(job: Pick<RunJob, 'job' | 'status' | 'ended' | 'boundary_refused'>, admin: boolean): DispatchDiagnostics {
  const facts = job.status.job_facts;
  const uncertain = facts.frozen === true || job.ended === 'unknown';
  const next = uncertain ? admin ? `circle-hub job resume ${job.job}` : '联系管理员只读核对本作业；不要重新发送作业'
    : facts.report_pending ? admin ? `circle-hub job resume ${job.job}` : '原样重交原提交读取本作业报告；不要重新发送作业'
    : admin ? `circle-hub job status ${job.job}` : '读取本作业结果引用及各轮结论；没有结论时不要当作通过';
  const missing_facts: DispatchMissingFact[] = [];
  if (admin) {
    for (const check of facts.failed_checks ?? []) missing_facts.push({ fact: clip(check.missing_fact), next_action: clip(check.next_action) });
    if (facts.missing_fact || facts.reason) missing_facts.push({ fact: clip(facts.missing_fact ?? facts.reason!), next_action: clip(facts.next_action ?? next) });
    missing_facts.push(...facts.missing_facts ?? []);
  } else {
    for (const fact of facts.member_missing_facts ?? []) missing_facts.push({ fact: clip(fact.fact), next_action: clip(fact.next_action) });
    if (facts.admin_release) missing_facts.push(...releaseMissingFacts(facts.admin_release));
    for (const condition of facts.failed_conditions ?? []) missing_facts.push(readConditionFact(condition));
    for (const check of facts.failed_checks ?? []) {
      if (!check.seat && !check.check && missing_facts.length) continue;
      missing_facts.push({ fact: check.seat || check.check ? `核对项目 ${[check.seat, check.check].filter(Boolean).join(' ')}：` + (check.check === 'version' ? '设备报告的版本尚未与本次核验要求匹配' : check.check === 'interfaces' ? '设备接口集合尚未与本次绑定清单匹配' : '本次环境核对仍有未满足的条件') : '环境只读核对缺少可供成员读取的项目说明', next_action: '请管理员核对该项目的声明和受限原件，补齐这项条件后重新核验' });
    }
    if (!missing_facts.length && (facts.missing_fact || facts.reason || facts.failed_conditions?.length)) missing_facts.push({ fact: uncertain ? '本作业的状态仍有未核对的事实' : facts.report_pending ? '本作业的完整报告尚未取得' : '本作业仍缺少可供成员读取的具体核对事实', next_action: next });
  }
  const distinct = [...new Map(missing_facts.map(fact => [fact.fact + '\0' + fact.next_action, fact])).values()].slice(0, 16);
  const job_facts: DispatchJobFacts = {
    scope: facts.scope,
    ...(facts.operation !== undefined ? { operation: facts.operation } : {}),
    ...(admin && facts.phase !== undefined ? { phase: facts.phase } : {}),
    ...(facts.reservation_recorded !== undefined ? { reservation_recorded: facts.reservation_recorded } : {}),
    ...(facts.frozen !== undefined ? { frozen: facts.frozen } : {}),
    ...(facts.readonly_verified !== undefined ? { readonly_verified: facts.readonly_verified } : {}),
    ...(facts.conformance_verified !== undefined ? { conformance_verified: facts.conformance_verified } : {}),
    ...(facts.result ? { result: facts.result } : {}),
    ...(facts.admission_error ? { admission_error: { code: facts.admission_error.code, message: admin ? clip(facts.admission_error.message) : distinct.map(fact => fact.fact).join('；') || '本作业的准入核对未通过，请联系管理员核对', fix: admin ? facts.admission_error.fix : distinct.map(fact => fact.next_action).join('；') || next } } : {}),
    missing_facts: distinct,
    next_action: next,
  };
  const attempt = job.status.dispatch_attempt;
  if (!attempt) return { job_facts };
  const scope: DispatchAttemptFacts['scope'] = admin ? attempt.scope : attempt.scope.operation === 'dispatch'
    ? { operation: attempt.scope.operation, job: attempt.scope.job, round: attempt.scope.round }
    : { operation: attempt.scope.operation, job: attempt.scope.job };
  const dispatch_attempt: DispatchAttemptFacts = {
    scope,
    ...(attempt.outcome !== undefined ? { outcome: attempt.outcome } : {}),
    ...(admin && attempt.phase !== undefined ? { phase: attempt.phase } : {}),
    ...(attempt.not_sent === true ? { not_sent: true } : {}),
    ...(attempt.submit_invoked !== undefined ? { submit_invoked: attempt.submit_invoked } : {}),
    ...(attempt.rejection_stage !== undefined ? { rejection_stage: attempt.rejection_stage } : {}),
    ...(attempt.report_pending !== undefined ? { report_pending: attempt.report_pending } : {}),
    ...(attempt.result ? { result: attempt.result } : {}),
    ...(attempt.device_return ? { device_return: attempt.device_return } : {}),
    ...(attempt.error_code !== undefined ? { error_code: attempt.error_code } : {}),
    ...(attempt.call_error_reason !== undefined ? { call_error_reason: attempt.call_error_reason } : {}),
    ...(admin && attempt.missing_facts ? { missing_facts: attempt.missing_facts.map(fact => ({ fact: clip(fact.fact), next_action: clip(fact.next_action) })) } : {}),
    ...(admin && attempt.next_action ? { next_action: clip(attempt.next_action) } : {}),
  };
  return { job_facts, dispatch_attempt };
}
