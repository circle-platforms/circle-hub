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
