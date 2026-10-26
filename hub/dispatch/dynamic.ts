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
