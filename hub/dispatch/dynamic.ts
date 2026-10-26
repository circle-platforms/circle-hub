// The owner's decision for D02 R[5] is centralized here; shared-target verdicts remain judgments.
import { QualifierMarkSchema, type DynamicTerminal, type Nature, type QualifierMark, type Reason, type ProvenanceType } from '../../contracts/generated/vocabulary.ts';
export const DISPATCH_QUALIFICATIONS=QualifierMarkSchema.extract(['target_reported','report_for_dispatch','local_ops_not_excluded']).options;
export function dynamicDisposition(reported:DynamicTerminal|null,facts:Readonly<Record<string,boolean>>,inherited:readonly QualifierMark[]=[]) {
  const missing=Object.keys(facts).filter(key=>facts[key]!==true);
  if(reported!=='pass' && reported!=='fail')missing.push('report');
  const terminal:DynamicTerminal=missing.length?'no_verdict':reported!;
  const nature:Nature=missing.length?'unknown':'judgment';
  const provenance:ProvenanceType='projected';
  const marks:QualifierMark[]=[...new Set([...DISPATCH_QUALIFICATIONS,...inherited])];
  return {dynamic_terminal:terminal,qualifier:{nature,provenance,marks},accepted_as_fact:false,missing_facts:missing,
    ...(missing.length?{reason:'integrity_unproven' as Reason,next_action:'管理员核对目标版本认证、原派发收尾日志和同租约设备观察，补齐所列缺事实并在后续核验中采用原件；本结果保留无判定，不重交'}:{})};
}
export interface UnmetPremise { premise: string; missing_fact: string; next_action: string }
/** The contract premise is result_ownership only when the declared value matches and that premise is uncertified. */
export function ownershipUnmet(ownership: { declared: boolean; certified: boolean; matched: boolean; consistent: boolean }, failure: { missing_fact: string; next_action: string }): UnmetPremise {
  const premise = ownership.declared && ownership.matched && ownership.consistent && !ownership.certified ? 'result_ownership' : 'owned';
  return { premise, ...failure };
}
export function unmetPremises(missing: readonly string[], owned: UnmetPremise): UnmetPremise[] {
  return missing.map(key => key === 'owned' ? owned : {
    premise: key,
    missing_fact: `动态完整性前提 ${key} 未满足`,
    next_action: `请管理员补齐前提 ${key}，并在后续核验中采用原件；本结果保留无判定，不重交`,
  });
}
/** Registration is visible without a session. A registered premise is still checked against the live version when the result is read. */
export function missingOwnershipCertification(definition: { premises?: { result_ownership?: unknown } }): UnmetPremise[] {
  if (definition.premises?.result_ownership) return [];
  return [{
    premise: 'result_ownership',
    missing_fact: '执行器未登记结果归属前提 result_ownership',
    next_action: '请管理员为该目标版本登记 result_ownership 认证；登记前结果的 dynamic_terminal 保持无判定。本说明不连接执行器、不派发',
  }];
}
