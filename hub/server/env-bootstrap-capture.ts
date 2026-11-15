// Presentation only: the caller supplies its stored role and authorized command context.
import type { ProtocolError } from '../../contracts/src/common.ts';
import { resolveCallErrorReason } from '../../contracts/generated/protocol.ts';
import { labelOf, type PermissionRole } from '../../contracts/generated/vocabulary.ts';
import { buildCommandArgv, commandParameterHelp } from './command-parameters.ts';

/** Quote each concrete argument, including values containing shell syntax. */
function command(argv: readonly string[]): string {
  return ['circle-hub', ...argv.map(value => "'" + value.replaceAll("'", "'\\''") + "'")].join(' ');
}

export function registrationIncompletePresentation(error: ProtocolError, actualRole: PermissionRole, administratorExecutor?: string) {
  if (error.code !== 'SOURCE_NOT_PERMITTED' || error.call_error_reason !== 'environment_registration_incomplete' || error.object_kind !== 'test_environment') return null;
  const rule = resolveCallErrorReason(error.code, error.call_error_reason, actualRole);
  if (!rule || !('category' in rule.classification) || rule.nextAction === null) return null;
  // The protocol carries only an independently authorized display name, never a raw target.
  const fact = error.environment_display_name === undefined
    ? '该测试环境还没有登记完成：尚未声明资源清单'
    : `测试环境「${error.environment_display_name}」还没有登记完成：尚未声明资源清单`;
  let next = rule.nextAction;
  if (actualRole === 'admin' && administratorExecutor !== undefined) {
    const capture = command(buildCommandArgv('job.precheck', { executor: administratorExecutor }));
    // An update needs an administrator-supplied definition; show registered help, not a fabricated executable argv.
    next += `；只读采集：${capture}；填入资源后的定义更新入口：circle-hub ${commandParameterHelp('executor.update')}`;
  }
  return { category: labelOf('call_error_category', rule.classification.category), fact, next };
}

/** Reads existing journal facts only; a saved artifact is not proof of a completed observation. */
export function bootstrapCapturePresentation(
  details: readonly Readonly<Record<string, unknown>>[],
  _executor: string,
  resultReference?: string,
) {
  if (!details.some(detail => detail.bootstrap_capture === true)) return null;
  const complete = details.findLast(detail => detail.phase === 'complete' && detail.bootstrap_capture === true);
  const result = details.findLast(detail => detail.phase === 'result' && detail.bootstrap_capture === true);
  const report = typeof result?.reference === 'string' && /^src:[a-f0-9]{64}$/.test(result.reference) && result.reference === resultReference
    ? result.reference : undefined;
  const collected = complete?.capture_completed === true && result?.capture_completed === true && report !== undefined;
  const lines = [
    '模式：登记未完成时的管理员只读采集；不是正式派发或登记验证通过',
    collected ? '只读采集已完成；资源仍须核实并填入定义' : '没有完整的只读采集观察；不能据此声明资源已核实',
    report === undefined ? '采集报告引用尚未取得' : `只读观察索引 ${report}（不是主机文件路径或设备执行结果）`,
  ];
  if (complete?.registration_ready === false) lines.push('登记尚未完成');
  // Successful collection is a stage transition, not another incomplete-registration refusal.
  if (collected) lines.push(`下一步：核实只读观察，将资源清单填入定义；定义更新入口：circle-hub ${commandParameterHelp('executor.update')}`);
  // On failure the CLI retains the source-selected reason and recovery action unchanged.
  return { lines, exitCode: collected ? 0 : 1 };
}
