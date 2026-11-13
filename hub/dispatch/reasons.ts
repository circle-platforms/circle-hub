import { sha256Hex, type RecordsKit } from '../records/api.ts';
import type { JobStatus } from './service.ts';
import type { RunJob } from './read-runs.ts';

export interface DispatchMissingFact { fact: string; next_action: string }
export interface DispatchDiagnostics {
  outcome: JobStatus['outcome'];
  error_code?: JobStatus['error_code'];
  frozen: boolean;
  not_sent?: boolean;
  report_pending?: boolean;
  no_verdict?: boolean;
  missing_facts: DispatchMissingFact[];
  next_action: string;
}
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const clip = (value: string): string => value.slice(0, 800);

/** Read only this job's integrity-checked projected report, never an administrative journal body. */
export async function reportMissingFacts(records: Pick<RecordsKit, 'objects'>, job: RunJob, admin: boolean): Promise<Pick<DispatchDiagnostics, 'no_verdict' | 'missing_facts'>> {
  const reference = job.status.result;
  if (!reference || !/^src:[0-9a-f]{64}$/.test(reference) || job.status.outcome === 'not_dispatched') return { missing_facts: [] };
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

export function releaseMissingFacts(checks: NonNullable<JobStatus['admin_release']>): DispatchMissingFact[] {
  return checks.filter(check=>check.satisfied!==true).map(check=>check.condition==='proof.executor_identity'
    ? {fact:'本次核验的目标或清单摘要与当前执行器声明不一致',next_action:'联系管理员核对当前环境的清单绑定，再使用一致的清单重新核验'}
    : {fact:check.satisfied===null?'本次放行核对缺少前置事实':'本次放行核对仍有未满足的条件',next_action:'核对本次预订和核验结果；联系管理员查看具体放行条件后重新核验'}).slice(0,16);
}

export function statusDiagnostics(job: Pick<RunJob, 'job' | 'status' | 'ended' | 'boundary_refused'>, admin: boolean): DispatchDiagnostics {
  const { status } = job;
  const uncertain = status.frozen || job.ended === 'unknown' || status.outcome === 'unknown';
  const next = uncertain ? admin ? `circle-hub job resume ${job.job}；只读核对原作业，不重新发送` : '目标可能已经执行；不要重交或另开运行重发，联系管理员核对；之后原样重交原提交只读进展'
    : status.report_pending ? admin ? `circle-hub job resume ${job.job}；只读补取原报告，不重新发送` : '原样重交原提交读取报告进展；不要重新发送作业'
    : status.outcome === 'not_dispatched' ? admin ? `circle-hub job status ${job.job}` : job.boundary_refused || status.not_sent ? '按缺失条件核对预订或联系管理员处理，再原样重交原提交' : '联系管理员核对本次未派发原因；不要绕过当前运行的派发保护'
    : admin ? `circle-hub job status ${job.job}` : '读取本次结果引用查看逐条结论；没有结论时不要当作通过';
  const missing_facts: DispatchMissingFact[] = [];
  if (admin) {
    for (const check of status.failed_checks ?? []) missing_facts.push({ fact: clip(check.missing_fact), next_action: clip(check.next_action) });
    if (status.missing_fact || status.reason) missing_facts.push({ fact: clip(status.missing_fact ?? status.reason!), next_action: clip(status.next_action ?? next) });
  } else {
    for (const fact of status.member_missing_facts ?? []) missing_facts.push({ fact: clip(fact.fact), next_action: clip(fact.next_action) });
    if (status.admin_release) missing_facts.push(...releaseMissingFacts(status.admin_release));
    for (const check of status.failed_checks ?? []) missing_facts.push({ fact: check.check === 'version' ? '设备报告的版本尚未与本次核验要求匹配' : check.check === 'interfaces' ? '设备接口集合尚未与本次绑定清单匹配' : '本次环境核对仍有未满足的条件', next_action: next });
    if (!missing_facts.length && (status.missing_fact || status.reason || status.failed_conditions?.length)) missing_facts.push({ fact: uncertain ? '原作业是否执行或执行到哪一步尚未确认' : status.report_pending ? '原作业的完整报告尚未取得' : status.outcome === 'not_dispatched' ? '本次上机前条件尚未满足' : '本次结果仍有缺失事实，尚不能据此确认逐条结论', next_action: next });
  }
  return { outcome: status.outcome, ...(status.error_code?{error_code:status.error_code}:{}), frozen: status.frozen, ...(status.not_sent !== undefined ? { not_sent: status.not_sent } : {}), ...(status.report_pending !== undefined ? { report_pending: status.report_pending } : {}), missing_facts: missing_facts.slice(0, 16), next_action: next };
}
