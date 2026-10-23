// The owner's decision for D02 R[5] is centralized here; shared-target verdicts remain judgments.
import type { DynamicTerminal, Nature, QualifierMark, Reason } from '../../contracts/generated/vocabulary.ts';
export function dynamicDisposition(reported:DynamicTerminal|null,facts:Readonly<Record<string,boolean>>) {
  const missing=Object.keys(facts).filter(key=>facts[key]!==true);
  if(reported!=='pass' && reported!=='fail')missing.push('report');
  const terminal:DynamicTerminal=missing.length?'no_verdict':reported!;
  const nature:Nature=missing.length?'unknown':'judgment';
  const marks:QualifierMark[]=['report_for_dispatch','local_ops_not_excluded'];
  return {dynamic_terminal:terminal,qualifier:{nature,provenance:'projected',marks},accepted_as_fact:false,missing_facts:missing,
    ...(missing.length?{reason:'integrity_unproven' as Reason,next_action:'管理员补齐目标版本认证、原派发收尾日志和同租约设备观察后重读原作业；不得重交'}:{})};
}
